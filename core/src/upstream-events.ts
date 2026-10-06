import type { ApiProtocol } from "./types.ts";
import { ProtocolError, type Json, type OutputEvent, type Stop, type Usage } from "./protocol.ts";
import { sseData } from "./upstream.ts";

const stopOf = (reason: string): Stop => /tool|function/i.test(reason) ? "tool" : /length|max.*token/i.test(reason) ? "length" : /filter|safety|recitation|block|refusal/i.test(reason) ? "filter" : "stop";
export function usageOf(protocol: ApiProtocol, u: Json): Usage {
  if (protocol === "chat") return { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, cached: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0, reasoning: u.completion_tokens_details?.reasoning_tokens };
  if (protocol === "responses") return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cached: u.input_tokens_details?.cached_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens };
  if (protocol === "messages") return { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0, cached: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
  return { input: u.promptTokenCount ?? 0, output: u.candidatesTokenCount ?? 0, cached: u.cachedContentTokenCount ?? 0, reasoning: u.thoughtsTokenCount };
}

/** Wire decoders feed neutral events; none of them fabricates a Chat response. */
export async function* readOutput(response: Response, protocol: ApiProtocol): AsyncGenerator<OutputEvent> {
  if (!response.body) throw new ProtocolError("上游返回空响应。", 502);
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  if (!streaming) {
    const json = await response.json() as Json;
    if (json.error) throw new ProtocolError("上游返回生成错误。", 502);
    yield* wholeOutput(json, protocol);
    return;
  }
  let stopped = false;
  let reason: Stop = "stop";
  let messageUsage: Json = {};
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  const seenText = new Set<number>();
  const seenThought = new Set<number>();
  const completedItems = new Set<number>();
  let geminiIndex = -1; let geminiKind = "";
  const signedText = new Map<number, { text: string; thoughtSignature?: string }>();
  function* completeItem(i: Json, index: number): Generator<OutputEvent> {
    if (completedItems.has(index)) return;
    if (i.type === "reasoning") {
      yield { type: "reasoning", index, ...(!seenThought.has(index) ? { text: (i.summary ?? []).map((s: Json) => s.text ?? "").join("") } : {}), encrypted: i.encrypted_content };
    } else if (i.type === "message") {
      for (const p of i.content ?? []) {
        if (p.type !== "output_text") throw new ProtocolError("跨协议暂不支持上游消息内容：" + p.type, 502);
        if (!seenText.has(index)) yield { type: "text", index, text: p.text };
      }
    } else if (i.type === "function_call") {
      const c = calls.get(index);
      if (!c) { const call = { id: i.call_id ?? i.id, name: i.name, arguments: i.arguments ?? "{}" }; calls.set(index, call); yield { type: "call", index, ...call }; }
      else if (i.arguments && i.arguments !== c.arguments) {
        if (!i.arguments.startsWith(c.arguments)) throw new ProtocolError("上游工具参数与流内容不一致。", 502);
        yield { type: "arguments", index, text: i.arguments.slice(c.arguments.length) }; c.arguments = i.arguments;
      }
    } else throw new ProtocolError("跨协议暂不支持上游输出：" + i.type, 502);
    completedItems.add(index);
  }
  for await (const data of sseData(response.body)) {
    if (data === "[DONE]") break;
    const j = JSON.parse(data) as Json;
    if (j.error || j.type === "error" || j.type === "response.failed") throw new ProtocolError("上游在生成过程中返回错误。", 502);
    if (protocol === "chat") {
      if (j.usage) yield { type: "usage", usage: usageOf(protocol, j.usage) };
      const c = j.choices?.[0]; if (!c) continue;
      const d = c.delta ?? {};
      if (d.refusal) throw new ProtocolError("上游拒绝生成回复。", 502);
      if (d.content) yield { type: "text", text: d.content };
      if (d.reasoning_content || d.reasoning || d.reasoning_signature || d.provider_state) yield { type: "reasoning", text: d.reasoning_content ?? d.reasoning, signature: d.reasoning_signature, encrypted: d.provider_state };
      for (const t of d.tool_calls ?? []) {
        const index = t.index ?? 0;
        const call = calls.get(index) ?? { id: "", name: "", arguments: "" };
        call.id += t.id ?? ""; call.name += t.function?.name ?? ""; call.arguments += t.function?.arguments ?? "";
        calls.set(index, call);
      }
      if (c.finish_reason && !stopped) {
        // Some Chat sources fragment tool IDs and names as well as arguments.
        for (const [index, call] of calls) {
          if (!call.id || !call.name) throw new ProtocolError("上游工具调用缺少 id 或名称。", 502);
          yield { type: "call", index, ...call };
        }
        reason = stopOf(c.finish_reason); stopped = true;
      }
    } else if (protocol === "messages") {
      if (j.type === "message_start") messageUsage = j.message?.usage ?? {};
      if (j.type === "content_block_start") {
        const b = j.content_block;
        if (b.type === "tool_use") yield { type: "call", index: j.index, id: b.id, name: b.name, arguments: Object.keys(b.input ?? {}).length ? JSON.stringify(b.input) : "" };
        else if (b.type === "text" && b.text) yield { type: "text", index: j.index, text: b.text };
        else if (b.type === "thinking") yield { type: "reasoning", index: j.index, text: b.thinking, signature: b.signature };
        else if (b.type === "redacted_thinking") yield { type: "reasoning", index: j.index, encrypted: b.data };
        else if (!["text", "thinking"].includes(b.type)) throw new ProtocolError("跨协议暂不支持上游内容：" + b.type, 502);
      }
      if (j.type === "content_block_delta") {
        const d = j.delta;
        if (d.type === "text_delta") yield { type: "text", index: j.index, text: d.text };
        else if (d.type === "input_json_delta") yield { type: "arguments", index: j.index, text: d.partial_json };
        else if (d.type === "thinking_delta") yield { type: "reasoning", index: j.index, text: d.thinking };
        else if (d.type === "signature_delta") yield { type: "reasoning", index: j.index, signature: d.signature };
        else throw new ProtocolError("跨协议暂不支持上游内容增量：" + d.type, 502);
      }
      if (j.type === "message_delta") {
        messageUsage = { ...messageUsage, ...j.usage };
        reason = stopOf(j.delta?.stop_reason ?? "end_turn");
      }
      if (j.type === "message_stop") { yield { type: "usage", usage: usageOf(protocol, messageUsage) }; stopped = true; }
    } else if (protocol === "responses") {
      const index = j.output_index ?? 0;
      if (j.type === "response.output_text.delta") { seenText.add(index); yield { type: "text", index, text: j.delta }; }
      else if (j.type === "response.reasoning_summary_text.delta" || j.type === "response.reasoning_text.delta") { seenThought.add(index); yield { type: "reasoning", index, text: j.delta }; }
      else if (j.type === "response.output_item.added" && j.item?.type === "function_call") {
        const c = { id: j.item.call_id ?? j.item.id, name: j.item.name, arguments: j.item.arguments ?? "" };
        calls.set(index, c); yield { type: "call", index, ...c };
      } else if (j.type === "response.function_call_arguments.delta") {
        const c = calls.get(index); if (c) c.arguments += j.delta;
        yield { type: "arguments", index, text: j.delta };
      } else if (j.type === "response.output_item.done") {
        yield* completeItem(j.item, index);
      } else if (j.type === "response.completed" || j.type === "response.incomplete") {
        for (const [slot, item] of (j.response?.output ?? []).entries()) yield* completeItem(item, slot);
        if (j.response?.usage) yield { type: "usage", usage: usageOf(protocol, j.response.usage) };
        reason = j.type === "response.incomplete" ? stopOf(j.response?.incomplete_details?.reason ?? "max_output_tokens") : calls.size ? "tool" : "stop";
        stopped = true;
      } else if (j.type === "response.refusal.delta") throw new ProtocolError("上游拒绝生成回复。", 502);
    } else {
      if (j.usageMetadata) yield { type: "usage", usage: usageOf(protocol, j.usageMetadata) };
      const c = j.candidates?.[0];
      if (!c && j.promptFeedback?.blockReason) { stopped = true; reason = "filter"; }
      for (const p of c?.content?.parts ?? []) {
        const kind = p.functionCall ? "call" : p.thought ? "reasoning" : "text";
        if (kind !== geminiKind || kind === "call") { geminiIndex++; geminiKind = kind; }
        const index = geminiIndex;
        if (p.functionCall) {
          const call = { id: p.functionCall.id ?? "call_" + index, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) };
          calls.set(index, call); yield { type: "call", index, ...call };
          if (p.thoughtSignature) yield { type: "reasoning", index, encrypted: JSON.stringify({ callId: call.id, thoughtSignature: p.thoughtSignature }) };
        } else if (p.thought) yield { type: "reasoning", index, text: p.text, signature: p.thoughtSignature };
        else if (typeof p.text === "string") {
          yield { type: "text", index, text: p.text };
          const saved = signedText.get(index) ?? { text: "" };
          saved.text += p.text;
          if (p.thoughtSignature) saved.thoughtSignature = p.thoughtSignature;
          signedText.set(index, saved);
        }
        else throw new ProtocolError("跨协议暂不支持 Gemini 输出：" + Object.keys(p)[0], 502);
      }
      if (c?.finishReason) { stopped = true; reason = c.finishReason === "STOP" && calls.size ? "tool" : stopOf(c.finishReason); }
    }
  }
  if (!stopped) throw new ProtocolError("上游响应流在结束事件前中断。", 502);
  for (const [index, saved] of signedText) if (saved.thoughtSignature) yield { type: "reasoning", index, encrypted: JSON.stringify(saved) };
  yield { type: "stop", reason };
}

function* wholeOutput(j: Json, protocol: ApiProtocol): Generator<OutputEvent> {
  let reason: Stop = "stop";
  let usage: Json | undefined;
  if (protocol === "chat") {
    const c = j.choices?.[0]; if (!c) throw new ProtocolError("上游缺少回复。", 502);
    const m = c.message;
    if (m.refusal) throw new ProtocolError("上游拒绝生成回复。", 502);
    if (m.content) yield { type: "text", text: m.content };
    if (m.reasoning_content || m.reasoning || m.reasoning_signature || m.provider_state) yield { type: "reasoning", text: m.reasoning_content ?? m.reasoning, signature: m.reasoning_signature, encrypted: m.provider_state };
    for (const [index, t] of (m.tool_calls ?? []).entries()) yield { type: "call", index, id: t.id, name: t.function.name, arguments: t.function.arguments };
    reason = stopOf(c.finish_reason ?? "stop"); usage = j.usage;
  } else if (protocol === "messages") {
    for (const [index, b] of (j.content ?? []).entries()) {
      if (b.type === "text") yield { type: "text", index, text: b.text };
      else if (b.type === "tool_use") yield { type: "call", index, id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) };
      else if (b.type === "thinking" || b.type === "redacted_thinking") yield { type: "reasoning", index, text: b.thinking, signature: b.signature, encrypted: b.data };
      else throw new ProtocolError("跨协议暂不支持上游内容：" + b.type, 502);
    }
    reason = stopOf(j.stop_reason ?? "end_turn"); usage = j.usage;
  } else if (protocol === "responses") {
    if (j.status !== "completed" && j.status !== "incomplete") throw new ProtocolError("上游尚未完成生成。", 502);
    for (const [index, i] of (j.output ?? []).entries()) {
      if (i.type === "message") for (const p of i.content ?? []) { if (p.type === "output_text") yield { type: "text", index, text: p.text }; else throw new ProtocolError("跨协议暂不支持上游消息内容。", 502); }
      else if (i.type === "function_call") { reason = "tool"; yield { type: "call", index, id: i.call_id ?? i.id, name: i.name, arguments: i.arguments }; }
      else if (i.type === "reasoning") yield { type: "reasoning", index, text: (i.summary ?? []).map((s: Json) => s.text ?? "").join(""), encrypted: i.encrypted_content };
      else throw new ProtocolError("跨协议暂不支持上游输出：" + i.type, 502);
    }
    if (j.status === "incomplete") reason = stopOf(j.incomplete_details?.reason ?? "max_output_tokens"); usage = j.usage;
  } else {
    const c = j.candidates?.[0];
    if (!c && !j.promptFeedback?.blockReason) throw new ProtocolError("上游缺少回复。", 502);
    for (const [index, p] of (c?.content?.parts ?? []).entries()) {
      if (p.functionCall) {
        const id = p.functionCall.id ?? "call_" + index;
        yield { type: "call", index, id, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) };
        if (p.thoughtSignature) yield { type: "reasoning", index, encrypted: JSON.stringify({ callId: id, thoughtSignature: p.thoughtSignature }) };
      } else if (p.thought) yield { type: "reasoning", index, text: p.text, signature: p.thoughtSignature };
      else if (typeof p.text === "string") {
        yield { type: "text", index, text: p.text };
        if (p.thoughtSignature) yield { type: "reasoning", index, encrypted: JSON.stringify({ text: p.text, thoughtSignature: p.thoughtSignature }) };
      }
      else throw new ProtocolError("跨协议暂不支持 Gemini 输出。", 502);
    }
    reason = c ? c.finishReason === "STOP" && c.content?.parts?.some((p: Json) => p.functionCall) ? "tool" : stopOf(c.finishReason ?? "STOP") : "filter"; usage = j.usageMetadata;
  }
  if (usage) yield { type: "usage", usage: usageOf(protocol, usage) };
  yield { type: "stop", reason };
}
