import type { ApiProtocol } from "./types.ts";
import { ProtocolError, unpackState, type Conversation, type InboundRequest, type Json, type Part } from "./protocol.ts";

const stringify = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value ?? "");
function toolArgs(value: string): Json {
  try { return JSON.parse(value || "{}"); }
  catch { throw new ProtocolError("工具调用参数不是合法 JSON。"); }
}

/** Unwrap only our continuation fields; all other native fields stay intact. */
export function restoreNativeState(body: Json, request: InboundRequest, dropped: string[]): void {
  const wrapped = (v: unknown): v is string => typeof v === "string" && v.startsWith("es-state:");
  const read = (v: string): Json | undefined => {
    const saved = unpackState(v, request.source ?? "", request.model);
    if (saved?.protocol === request.protocol) return saved;
    dropped.push("reasoning:foreign_state");
    return undefined;
  };
  if (request.protocol === "responses" && Array.isArray(body.input)) {
    body.input = body.input.flatMap((i: Json) => {
      if (i.type !== "reasoning" || !wrapped(i.encrypted_content)) return [i];
      const saved = read(i.encrypted_content);
      return saved?.encrypted ? [{ ...i, encrypted_content: saved.encrypted }] : [];
    });
  } else if (request.protocol === "messages") {
    for (const m of body.messages ?? []) if (Array.isArray(m.content)) m.content = m.content.flatMap((p: Json) => {
      const value = p.type === "thinking" ? p.signature : p.type === "redacted_thinking" ? p.data : undefined;
      if (!wrapped(value)) return [p];
      const saved = read(value);
      if (saved?.signature) return [{ type: "thinking", thinking: saved.text ?? "", signature: saved.signature }];
      return saved?.encrypted ? [{ type: "redacted_thinking", data: saved.encrypted }] : [];
    });
  } else if (request.protocol === "chat") {
    for (const m of body.messages ?? []) {
      if (wrapped(m.reasoning_signature)) {
        const saved = read(m.reasoning_signature); delete m.reasoning_signature;
        if (saved?.signature) m.reasoning_signature = saved.signature;
      }
      const value = m.provider_state;
      const states: string[] = wrapped(value) ? [value] : typeof value === "string" && value.startsWith('["es-state:') ? JSON.parse(value) : [];
      if (!states.length) continue;
      delete m.provider_state;
      for (const value of states) {
        const saved = read(value);
        if (saved?.signature) m.reasoning_signature = saved.signature;
        if (saved?.encrypted) m.provider_state = saved.encrypted;
      }
    }
  } else if (request.protocol === "gemini") {
    for (const m of body.contents ?? []) m.parts = (m.parts ?? []).flatMap((p: Json) => {
      if (!wrapped(p.thoughtSignature)) return [p];
      const saved = read(p.thoughtSignature);
      if (saved?.signature) return [{ ...p, thoughtSignature: saved.signature }];
      if (saved?.encrypted) {
        const data = JSON.parse(saved.encrypted);
        const part = data.callId ? m.parts.find((v: Json) => v.functionCall?.id === data.callId)
          : m.parts.find((v: Json) => !v.thought && v.text === data.text && !v.thoughtSignature);
        if (part) part.thoughtSignature = data.thoughtSignature;
        else dropped.push("reasoning:unmatched_signature");
      }
      if (p.thought) return [];
      delete p.thoughtSignature; return [p];
    });
  }
}
function image(url: string): Json {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
  if (!match) return { type: "url", url };
  return { type: "base64", media_type: match[1], data: match[2] };
}

/** Direct builders from the shared content model. No target is built through another API. */
export function encodeRequest(c: Conversation, request: InboundRequest, protocol: ApiProtocol): Json {
  const body: Json = { model: request.model, stream: request.stream };
  for (const t of c.turns) for (const p of t.parts) {
    if (p.type === "native") throw new ProtocolError(`目标 ${protocol} 暂不支持 ${p.protocol} 内容：${p.value.type ?? Object.keys(p.value)[0]}`);
  }
  const state = (p: Part): Json | undefined => {
    if (p.type !== "reasoning") return undefined;
    const saved = unpackState(p.signature ?? p.encrypted, request.source ?? "", request.model);
    if (saved?.protocol === protocol) return saved;
    if (p.signature || p.encrypted) c.dropped.push("reasoning:foreign_state");
    if (p.text && protocol !== "chat") c.dropped.push("reasoning:text");
    return undefined;
  };
  if (protocol === "chat") {
    const messages: Json[] = [];
    for (const t of c.turns) {
      const parts: Json[] = []; const calls: Json[] = []; let thought = ""; const continuation: Json = {};
      for (const p of t.parts) {
        if (p.type === "text") parts.push({ type: "text", text: p.text });
        else if (p.type === "image") parts.push({ type: "image_url", image_url: { url: p.url } });
        else if (p.type === "call") calls.push({ id: p.id, type: "function", function: { name: p.name, arguments: p.arguments } });
        else if (p.type === "result") messages.push({ role: "tool", tool_call_id: p.id, content: `${p.error ? "Error: " : ""}${stringify(p.content)}` });
        else if (p.type === "reasoning") {
          const saved = state(p); thought += p.text ?? saved?.text ?? "";
          if (saved?.signature) continuation.reasoning_signature = saved.signature;
          if (saved?.encrypted) continuation.provider_state = saved.encrypted;
        }
      }
      if (parts.length || calls.length || thought || Object.keys(continuation).length) messages.push({ role: t.role, content: parts.every(p => p.type === "text") ? parts.map(p => p.text).join("\n\n") || null : parts, ...(calls.length ? { tool_calls: calls } : {}), ...(thought ? { reasoning_content: thought } : {}), ...continuation });
    }
    body.messages = messages;
    if (c.tools.length) body.tools = c.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (c.choice) body.tool_choice = typeof c.choice === "object" ? { type: "function", function: { name: c.choice.name } } : c.choice;
    if (c.maxTokens !== undefined) body.max_tokens = c.maxTokens;
    if (c.effort) body.reasoning_effort = c.effort;
    if (c.stop) body.stop = c.stop;
    if (c.format) { const { type, ...format } = c.format; body.response_format = type === "json_schema" ? { type, json_schema: { name: "output", ...format } } : c.format; }
  } else if (protocol === "responses") {
    const input: Json[] = [];
    for (const t of c.turns) {
      let content: Json[] = [];
      const flush = () => { if (content.length) { input.push({ type: "message", role: t.role, content }); content = []; } };
      for (const p of t.parts) {
        if (p.type === "text") content.push({ type: t.role === "assistant" ? "output_text" : "input_text", text: p.text });
        else if (p.type === "image") content.push({ type: "input_image", image_url: p.url });
        else if (p.type === "call") { flush(); input.push({ type: "function_call", call_id: p.id, name: p.name, arguments: p.arguments }); }
        else if (p.type === "result") { flush(); input.push({ type: "function_call_output", call_id: p.id, output: stringify(p.content) }); }
        else if (p.type === "reasoning") {
          const saved = state(p);
          if (saved?.encrypted) { flush(); input.push({ type: "reasoning", summary: saved.text ? [{ type: "summary_text", text: saved.text }] : [], encrypted_content: saved.encrypted }); }
        }
      }
      flush();
    }
    body.input = input;
    if (c.tools.length) body.tools = c.tools.map(t => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    if (c.choice) body.tool_choice = typeof c.choice === "object" ? { type: "function", name: c.choice.name } : c.choice;
    if (c.maxTokens !== undefined) body.max_output_tokens = c.maxTokens;
    if (c.effort) body.reasoning = { effort: c.effort };
    if (c.format) body.text = { format: c.format.type === "json_schema" ? { name: "output", ...c.format } : c.format };
    if (c.stop?.length) c.dropped.push("stop_sequences");
  } else if (protocol === "messages") {
    const messages: Json[] = []; const system: Json[] = [];
    for (const t of c.turns) {
      const parts: Json[] = [];
      for (const p of t.parts) {
        if (p.type === "text") parts.push({ type: "text", text: p.text });
        else if (p.type === "image") parts.push({ type: "image", source: image(p.url) });
        else if (p.type === "call") parts.push({ type: "tool_use", id: p.id, name: p.name, input: toolArgs(p.arguments) });
        else if (p.type === "result") parts.push({ type: "tool_result", tool_use_id: p.id, content: stringify(p.content), ...(p.error ? { is_error: true } : {}) });
        else if (p.type === "reasoning") {
          const saved = state(p);
          if (saved?.signature) parts.push({ type: "thinking", thinking: saved.text ?? "", signature: saved.signature });
          else if (saved?.encrypted) parts.push({ type: "redacted_thinking", data: saved.encrypted });
        }
      }
      if (t.role === "system" || t.role === "developer") system.push(...parts);
      else if (parts.length) {
        const last = messages.at(-1);
        if (last?.role === t.role) last.content.push(...parts); else messages.push({ role: t.role, content: parts });
      }
    }
    body.messages = messages; if (system.length) body.system = system;
    body.max_tokens = c.maxTokens ?? 4096;
    if (c.tools.length) body.tools = c.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (c.choice) body.tool_choice = typeof c.choice === "object" ? { type: "tool", name: c.choice.name } : { type: c.choice === "required" ? "any" : c.choice };
    if (c.parallelTools === false && c.tools.length) body.tool_choice = { ...(body.tool_choice ?? { type: "auto" }), disable_parallel_tool_use: true };
    if (c.effort) body.output_config = { effort: c.effort };
    if (c.stop) body.stop_sequences = c.stop;
    if (c.format?.type === "json_schema") body.output_config = { ...body.output_config, format: { type: "json_schema", schema: c.format.schema } };
    else if (c.format && c.format.type !== "text") throw new ProtocolError("Messages 结构化输出需要 JSON schema。");
  } else {
    delete body.model; delete body.stream;
    const contents: Json[] = []; const system: Json[] = []; const names = new Map<string, string>();
    for (const t of c.turns) {
      const parts: Json[] = [];
      const signatures: Json[] = [];
      for (const p of t.parts) {
        if (p.type === "text") parts.push({ text: p.text });
        else if (p.type === "image") {
          const src = image(p.url);
          if (src.type !== "base64") throw new ProtocolError("跨协议转 Gemini 的图片需要 base64 内容。");
          parts.push({ inlineData: { mimeType: src.media_type, data: src.data } });
        } else if (p.type === "call") { names.set(p.id, p.name); parts.push({ functionCall: { id: p.id, name: p.name, args: toolArgs(p.arguments) } }); }
        else if (p.type === "result") parts.push({ functionResponse: { id: p.id, name: p.name ?? names.get(p.id), response: typeof p.content === "object" && p.content !== null && !Array.isArray(p.content) ? p.content : { [p.error ? "error" : "output"]: p.content } } });
        else if (p.type === "reasoning") {
          const saved = state(p);
          if (saved?.signature) parts.push({ thought: true, text: saved.text ?? "", thoughtSignature: saved.signature });
          else if (saved?.encrypted) signatures.push(JSON.parse(saved.encrypted));
        }
      }
      for (const data of signatures) {
        const part = data.callId ? parts.find(p => p.functionCall?.id === data.callId)
          : parts.find(p => !p.thought && p.text === data.text && !p.thoughtSignature);
        if (part) part.thoughtSignature = data.thoughtSignature;
        else c.dropped.push("reasoning:unmatched_signature");
      }
      if (t.role === "system" || t.role === "developer") system.push(...parts);
      else if (parts.length) contents.push({ role: t.role === "assistant" ? "model" : "user", parts });
    }
    body.contents = contents; if (system.length) body.systemInstruction = { parts: system };
    if (c.tools.length) body.tools = [{ functionDeclarations: c.tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
    if (c.choice) body.toolConfig = { functionCallingConfig: typeof c.choice === "object" ? { mode: "ANY", allowedFunctionNames: [c.choice.name] } : { mode: c.choice === "none" ? "NONE" : c.choice === "required" ? "ANY" : "AUTO" } };
    body.generationConfig = { ...(c.maxTokens !== undefined ? { maxOutputTokens: c.maxTokens } : {}), ...(c.temperature !== undefined ? { temperature: c.temperature } : {}), ...(c.topP !== undefined ? { topP: c.topP } : {}), ...(c.stop ? { stopSequences: c.stop } : {}), ...(c.effort ? { thinkingConfig: { thinkingLevel: c.effort.toUpperCase() } } : {}) };
    if (c.format && c.format.type !== "text") Object.assign(body.generationConfig, { responseMimeType: "application/json", responseJsonSchema: c.format.schema ?? c.format.json_schema?.schema });
  }
  if (protocol !== "gemini") {
    if (c.temperature !== undefined) body.temperature = c.temperature;
    if (c.topP !== undefined) body.top_p = c.topP;
    if ((protocol === "chat" || protocol === "responses") && c.parallelTools !== undefined) body.parallel_tool_calls = c.parallelTools;
  }
  return body;
}
