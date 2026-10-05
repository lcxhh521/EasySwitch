import { lowerSchema } from "./gemini.ts";
import { ProtocolError, type Conversation, type InboundRequest, type Json, type Part, type Tool, type Turn } from "./protocol.ts";

const text = (value: string): Part => ({ type: "text", text: value });
const args = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value ?? {});
const flat = (namespace: unknown, name: string): string => namespace ? `${namespace}__${name}` : name;

function content(value: unknown, protocol: InboundRequest["protocol"]): Part[] {
  if (typeof value === "string") return value ? [text(value)] : [];
  return (Array.isArray(value) ? value : []).flatMap((p: Json): Part[] => {
    if (["text", "input_text", "output_text"].includes(p.type)) return [text(p.text ?? "")];
    if (p.type === "image_url" || p.type === "input_image") return [{ type: "image", url: typeof p.image_url === "string" ? p.image_url : p.image_url.url }];
    if (p.type === "image" && p.source) return [{ type: "image", url: p.source.type === "base64" ? `data:${p.source.media_type};base64,${p.source.data}` : p.source.url }];
    if (p.type === "tool_use") return [{ type: "call", id: p.id, name: p.name, arguments: args(p.input) }];
    if (p.type === "tool_result") return [{ type: "result", id: p.tool_use_id, content: p.content, error: p.is_error }];
    if (p.type === "thinking") return [{ type: "reasoning", text: p.thinking, signature: p.signature, protocol }];
    if (p.type === "redacted_thinking") return [{ type: "reasoning", encrypted: p.data, protocol }];
    return [{ type: "native", protocol, value: p }];
  });
}

function functionTool(t: Json, name = t.name, namespace?: string): Tool {
  return { name: flat(namespace, name), description: t.description ?? "", parameters: t.parameters ?? t.input_schema ?? { type: "object", properties: {} }, ...(namespace ? { namespace, bareName: name } : {}) };
}

/** Protocol decoders preserve richer parts; only the selected target decides what it can carry. */
export function decodeRequest(request: InboundRequest): Conversation {
  const { body: b, protocol: p } = request;
  const out: Conversation = { turns: [], tools: [], dropped: [], effort: request.effort };
  const push = (role: Turn["role"], parts: Part[]) => out.turns.push({ role, parts });
  const call = (part: Part) => {
    const previous = out.turns.at(-1);
    if (previous?.role === "assistant") previous.parts.push(part); else push("assistant", [part]);
  };
  if (p === "chat") {
    for (const m of b.messages ?? []) {
      if (m.role === "tool") { push("user", [{ type: "result", id: m.tool_call_id, content: m.content }]); continue; }
      const parts = content(m.content, p);
      if (m.reasoning_content || m.reasoning_signature) parts.push({ type: "reasoning", text: m.reasoning_content, signature: m.reasoning_signature, protocol: p });
      if (m.provider_state) {
        let states = [m.provider_state];
        if (typeof m.provider_state === "string" && m.provider_state.startsWith('["es-state:')) states = JSON.parse(m.provider_state);
        for (const state of states) parts.push({ type: "reasoning", encrypted: state, protocol: p });
      }
      for (const c of m.tool_calls ?? []) parts.push({ type: "call", id: c.id, name: c.function.name, arguments: args(c.function.arguments) });
      push(m.role, parts);
    }
    for (const t of b.tools ?? []) {
      if (t.type !== "function") throw new ProtocolError(`跨协议暂不支持 Chat 工具：${t.type}`);
      out.tools.push(functionTool(t.function));
    }
    out.choice = typeof b.tool_choice === "object" ? { name: b.tool_choice.function.name } : b.tool_choice;
    out.maxTokens = b.max_completion_tokens ?? b.max_tokens;
    out.effort ??= b.reasoning_effort;
    out.stop = typeof b.stop === "string" ? [b.stop] : b.stop;
    out.format = b.response_format?.type === "json_schema" ? { type: "json_schema", ...b.response_format.json_schema } : b.response_format;
  } else if (p === "responses") {
    if (b.previous_response_id || b.conversation) throw new ProtocolError("跨协议需要完整会话历史，无法使用 Responses 的服务端会话引用。");
    if (b.instructions) push("system", [text(b.instructions)]);
    const input = typeof b.input === "string" ? [{ role: "user", content: b.input }] : b.input ?? [];
    for (const i of input) {
      if (i.type === "message" || (!i.type && i.role)) push(i.role, content(i.content, p));
      else if (i.type === "function_call" || i.type === "custom_tool_call") call({ type: "call", id: i.call_id ?? i.id, name: flat(i.namespace, i.name), arguments: i.type === "custom_tool_call" ? JSON.stringify({ input: i.input }) : args(i.arguments) });
      else if (i.type === "function_call_output" || i.type === "custom_tool_call_output") push("user", [{ type: "result", id: i.call_id, content: i.output }]);
      else if (i.type === "reasoning") call({ type: "reasoning", text: (i.summary ?? []).map((s: Json) => s.text ?? "").join(""), encrypted: i.encrypted_content, protocol: p });
      else push("user", [{ type: "native", protocol: p, value: i }]);
    }
    for (const t of b.tools ?? []) {
      if (t.type === "namespace") {
        for (const inner of t.tools ?? []) {
          if (inner.type !== "function") throw new ProtocolError(`跨协议暂不支持 namespace 工具：${inner.type}`);
          out.tools.push(functionTool(inner, inner.name, t.name));
        }
      } else if (t.type === "function") out.tools.push(functionTool(t));
      else if (t.type === "custom") {
        const grammar = t.format?.definition ? `\nInput grammar (${t.format.syntax ?? ""}):\n${t.format.definition}` : "";
        out.tools.push({ name: t.name, description: (t.description ?? "") + grammar, custom: true, parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } });
      } else throw new ProtocolError(`跨协议暂不支持 Responses 工具：${t.type}`);
    }
    out.choice = typeof b.tool_choice === "object" ? { name: flat(b.tool_choice.namespace, b.tool_choice.name) } : b.tool_choice;
    out.maxTokens = b.max_output_tokens;
    out.effort ??= b.reasoning?.effort;
    out.format = b.text?.format;
  } else if (p === "messages") {
    if (b.system) push("system", content(b.system, p));
    for (const m of b.messages ?? []) push(m.role, content(m.content, p));
    for (const t of b.tools ?? []) {
      if (!t.input_schema) throw new ProtocolError(`跨协议暂不支持 Messages 工具：${t.type ?? t.name}`);
      out.tools.push(functionTool(t));
    }
    const c = b.tool_choice;
    out.choice = c?.type === "tool" ? { name: c.name } : c?.type === "any" ? "required" : c?.type;
    out.parallelTools = c?.disable_parallel_tool_use === true ? false : undefined;
    out.maxTokens = b.max_tokens;
    out.effort ??= b.output_config?.effort;
    out.stop = b.stop_sequences;
    out.format = b.output_config?.format;
    if (b.thinking) out.dropped.push("thinking_config");
  } else {
    const sys = b.systemInstruction ?? b.system_instruction;
    if (sys) push("system", (sys.parts ?? []).map((part: Json) => text(part.text ?? "")));
    const pending: Array<{ id: string; name: string }> = [];
    let next = 0;
    for (const m of b.contents ?? []) {
      const parts: Part[] = [];
      for (const v of m.parts ?? []) {
        if (v.functionCall) {
          const c = v.functionCall; const id = c.id ?? `call_${next++}`;
          pending.push({ id, name: c.name });
          parts.push({ type: "call", id, name: c.name, arguments: args(c.args) });
        } else if (v.functionResponse) {
          const r = v.functionResponse; const at = pending.findIndex(c => r.id ? c.id === r.id : c.name === r.name);
          const previous = at >= 0 ? pending.splice(at, 1)[0] : undefined;
          parts.push({ type: "result", id: r.id ?? previous?.id ?? `call_${next++}`, name: r.name, content: r.response });
        } else if (v.inlineData?.mimeType?.startsWith("image/")) parts.push({ type: "image", url: `data:${v.inlineData.mimeType};base64,${v.inlineData.data}` });
        else if (v.thought) parts.push({ type: "reasoning", text: v.text, signature: v.thoughtSignature, protocol: p });
        else if (typeof v.text === "string") parts.push(text(v.text));
        else parts.push({ type: "native", protocol: p, value: v });
        if (v.thoughtSignature && !v.thought) parts.push({ type: "reasoning", signature: v.thoughtSignature, protocol: p });
      }
      push(m.role === "model" ? "assistant" : "user", parts);
    }
    for (const t of b.tools ?? []) {
      if (!t.functionDeclarations) throw new ProtocolError(`跨协议暂不支持 Gemini 工具：${Object.keys(t)[0]}`);
      for (const f of t.functionDeclarations) out.tools.push(functionTool({ ...f, parameters: lowerSchema(f.parametersJsonSchema ?? f.parameters) }));
    }
    const config = b.toolConfig?.functionCallingConfig;
    out.choice = config?.mode === "NONE" ? "none" : config?.mode === "ANY" ? (config.allowedFunctionNames?.length === 1 ? { name: config.allowedFunctionNames[0] } : "required") : "auto";
    const g = b.generationConfig ?? {};
    out.maxTokens = g.maxOutputTokens; out.temperature = g.temperature; out.topP = g.topP; out.stop = g.stopSequences;
    out.effort ??= g.thinkingConfig?.thinkingLevel?.toLowerCase();
    if (g.responseMimeType === "application/json") out.format = g.responseJsonSchema || g.responseSchema ? { type: "json_schema", name: "output", schema: g.responseJsonSchema ?? g.responseSchema } : { type: "json_object" };
  }
  out.temperature ??= b.temperature; out.topP ??= b.top_p; out.parallelTools ??= b.parallel_tool_calls;
  return out;
}
