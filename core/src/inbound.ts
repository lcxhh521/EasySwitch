import { lowerSchema } from "./gemini.ts";
import { packState, unpackState, ProtocolError, type Conversation, type InboundRequest, type Json, type Part, type Tool, type Turn } from "./protocol.ts";

const text = (value: string): Part => ({ type: "text", text: value });
const args = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value ?? {});
const flat = (namespace: unknown, name: string): string => namespace ? `${namespace}__${name}` : name;

function chatReplay(message: Json, request: InboundRequest): Part[] | undefined {
  if (message.role !== "assistant" || typeof message.provider_state !== "string") return undefined;
  const values = message.provider_state.startsWith('["es-state:') ? JSON.parse(message.provider_state) : [message.provider_state];
  for (const value of values) {
    const saved = unpackState(value, request.source ?? "", request.model);
    if (!Array.isArray(saved?.replay)) continue;
    const items = saved.replay as Json[];
    const text = items.filter(i => i.kind === "text").map(i => i.text).join("");
    const calls = items.filter(i => i.kind === "call").map(i => ({ id: i.callId, name: i.name, arguments: i.text || "{}" }));
    const actualCalls = (message.tool_calls ?? []).map((i: Json) => ({ id: i.id, name: i.function?.name, arguments: i.function?.arguments || "{}" }));
    if (text !== (message.content ?? "") || JSON.stringify(calls) !== JSON.stringify(actualCalls)) throw new ProtocolError("已签名的历史内容或工具调用已更改，无法安全还原原始顺序。");
    return items.map((i): Part => {
      if (i.kind === "text") return { type: "text", text: i.text };
      if (i.kind === "call") return { type: "call", id: i.callId, name: i.name, arguments: i.text || "{}" };
      if (i.kind !== "reasoning") throw new ProtocolError("续传历史包含未知内容。");
      return { type: "reasoning", text: i.text, encrypted: packState(request.source ?? "", request.model, { protocol: saved.protocol, text: i.text, ...(i.signature ? { signature: i.signature } : {}), ...(i.encrypted ? { encrypted: i.encrypted } : {}) }), protocol: request.protocol };
    });
  }
  return undefined;
}

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
  const carried: Record<InboundRequest["protocol"], string[]> = {
    chat: ["model", "stream", "messages", "tools", "tool_choice", "max_completion_tokens", "max_tokens", "reasoning_effort", "stop", "response_format", "temperature", "top_p", "parallel_tool_calls"],
    responses: ["model", "stream", "input", "instructions", "tools", "tool_choice", "max_output_tokens", "reasoning", "text", "temperature", "top_p", "parallel_tool_calls", "previous_response_id", "conversation"],
    messages: ["model", "stream", "messages", "system", "tools", "tool_choice", "max_tokens", "output_config", "stop_sequences", "thinking", "temperature", "top_p"],
    gemini: ["model", "stream", "contents", "systemInstruction", "system_instruction", "tools", "toolConfig", "generationConfig"],
  };
  for (const key of Object.keys(b)) if (!carried[p].includes(key)) out.dropped.push("field:" + key);
  const push = (role: Turn["role"], parts: Part[]) => out.turns.push({ role, parts });
  const call = (part: Part) => {
    const previous = out.turns.at(-1);
    if (previous?.role === "assistant") previous.parts.push(part); else push("assistant", [part]);
  };
  if (p === "chat") {
    for (const m of b.messages ?? []) {
      if (m.role === "tool") { push("user", [{ type: "result", id: m.tool_call_id, content: m.content }]); continue; }
      const replay = chatReplay(m, request);
      if (replay) { push("assistant", replay); continue; }
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
      if (t.type !== "function") { out.dropped.push(`tool:${t.type}`); continue; }
      out.tools.push(functionTool(t.function));
    }
    if (b.tool_choice && typeof b.tool_choice === "object") {
      if (b.tool_choice.type !== "function" || typeof b.tool_choice.function?.name !== "string" || !out.tools.some(t => t.name === b.tool_choice.function.name)) throw new ProtocolError("跨协议无法执行指定的工具选择。");
      out.choice = { name: b.tool_choice.function.name };
    } else out.choice = b.tool_choice;
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
          if (inner.type !== "function") { out.dropped.push(`tool:${inner.type}`); continue; }
          out.tools.push(functionTool(inner, inner.name, t.name));
        }
      } else if (t.type === "function") out.tools.push(functionTool(t));
      else if (t.type === "custom") {
        const grammar = t.format?.definition ? `\nInput grammar (${t.format.syntax ?? ""}):\n${t.format.definition}` : "";
        out.tools.push({ name: t.name, description: (t.description ?? "") + grammar, custom: true, parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"] } });
      } else out.dropped.push(`tool:${t.type}`); // a tool the vendor runs itself (web_search...): nothing to translate it to; it is dropped and recorded
    }
    if (b.tool_choice && typeof b.tool_choice === "object") {
      const choice = b.tool_choice;
      if (!["function", "custom"].includes(choice.type) || typeof choice.name !== "string" || !out.tools.some(t => t.name === flat(choice.namespace, choice.name))) throw new ProtocolError("跨协议无法执行指定的服务端或未知工具。");
      out.choice = { name: flat(choice.namespace, choice.name) };
    } else out.choice = b.tool_choice;
    out.maxTokens = b.max_output_tokens;
    out.effort ??= b.reasoning?.effort;
    out.format = b.text?.format;
  } else if (p === "messages") {
    if (b.system) push("system", content(b.system, p));
    for (const m of b.messages ?? []) push(m.role, content(m.content, p));
    for (const t of b.tools ?? []) {
      if (!t.input_schema) { out.dropped.push(`tool:${t.type ?? t.name}`); continue; }
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
        if (v.thoughtSignature && !v.thought) {
          const association = v.functionCall ? { callId: (parts.at(-1) as { id: string }).id } : { text: v.text };
          parts.push({ type: "reasoning", encrypted: JSON.stringify({ ...association, thoughtSignature: v.thoughtSignature }), protocol: p });
        }
      }
      push(m.role === "model" ? "assistant" : "user", parts);
    }
    for (const t of b.tools ?? []) {
      if (!t.functionDeclarations) { out.dropped.push(`tool:${Object.keys(t)[0]}`); continue; }
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
  if (new Set(out.tools.map(t => t.name)).size !== out.tools.length) throw new ProtocolError("跨协议工具名称重复或 namespace 压平后冲突。");
  if (out.choice && typeof out.choice === "object") {
    const name = out.choice.name;
    if (typeof name !== "string" || !out.tools.some(tool => tool.name === name)) throw new ProtocolError("跨协议无法执行指定的服务端或未知工具。");
  }
  if (out.choice === "required" && !out.tools.length) throw new ProtocolError("跨协议没有可执行的指定工具。");
  return out;
}
