import type { ApiProtocol } from "./types.ts";
import { observeUsage } from "./usage-observation.ts";
import { OUTPUT_LIMITS, ProtocolError, type OutputKind, type Json, type OutputEvent, type Stop, type Usage } from "./protocol.ts";

/** Bound both unterminated SSE frames and total retained output before parsing untrusted JSON. */
async function* outputData(body: ReadableStream<Uint8Array>, streaming: boolean): AsyncGenerator<string> {
  const decoder = new TextDecoder(); let buffer = ""; let bytes = 0; let bufferedBytes = 0; let scanFrom = 0;
  const dataOf = (block: string) => block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
  for await (const chunk of body) {
    bytes += chunk.byteLength; bufferedBytes += chunk.byteLength;
    if (bytes > OUTPUT_LIMITS.responseBytes) throw new ProtocolError("上游响应超过安全大小限制。", 502);
    buffer += decoder.decode(chunk, { stream: true });
    if (!streaming) continue;
    const boundary = /\r?\n\r?\n/g; boundary.lastIndex = scanFrom;
    let match: RegExpExecArray | null; let consumed = 0;
    while ((match = boundary.exec(buffer))) {
      const block = buffer.slice(consumed, match.index); const blockBytes = Buffer.byteLength(block);
      if (blockBytes > OUTPUT_LIMITS.frameBytes) throw new ProtocolError("上游事件超过安全大小限制。", 502);
      consumed = boundary.lastIndex; bufferedBytes -= blockBytes + match[0].length;
      const data = dataOf(block); if (data) yield data;
    }
    if (consumed) buffer = buffer.slice(consumed);
    scanFrom = Math.max(0, buffer.length - 3);
    if (bufferedBytes > OUTPUT_LIMITS.frameBytes) throw new ProtocolError("上游事件超过安全大小限制。", 502);
  }
  buffer += decoder.decode();
  if (buffer) { const data = streaming ? dataOf(buffer) : buffer; if (data) yield data; }
}

/** Linear JSON boundary tracking, without repeatedly parsing a growing tool argument string. */
class ArgumentBoundary {
  private depth = 0; private quoted = false; private escaped = false; private started = false;
  complete = false;
  add(value: string): void {
    for (const ch of value) {
      if (this.complete) { if (!/\s/.test(ch)) throw new ProtocolError("工具参数在结束后继续输出。", 502); continue; }
      if (!this.started) { if (/\s/.test(ch)) continue; if (ch !== "{") return; this.started = true; this.depth = 1; continue; }
      if (this.quoted) { if (this.escaped) this.escaped = false; else if (ch === "\\") this.escaped = true; else if (ch === '"') this.quoted = false; }
      else if (ch === '"') this.quoted = true;
      else if (ch === "{" || ch === "[") this.depth++;
      else if (ch === "}" || ch === "]") { if (--this.depth === 0) this.complete = true; }
    }
  }
}


const stopOf = (reason: string): Stop => /tool|function/i.test(reason) ? "tool" : /length|max.*token/i.test(reason) ? "length" : /filter|safety|recitation|block|refusal/i.test(reason) ? "filter" : "stop";
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): number => count(value) ? value : 0;
const optionalCount = (value: unknown): boolean => value === undefined || count(value);
export function usageOf(protocol: ApiProtocol, u: Json): Usage {
  if (!u || typeof u !== "object" || Array.isArray(u)) return { input: 0, output: 0, complete: false };
  if (protocol === "chat") {
    const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
    return { input: amount(u.prompt_tokens), output: amount(u.completion_tokens), cached: amount(cached), reasoning: count(u.completion_tokens_details?.reasoning_tokens) ? u.completion_tokens_details.reasoning_tokens : undefined, complete: count(u.prompt_tokens) && count(u.completion_tokens) && optionalCount(cached) && amount(cached) <= amount(u.prompt_tokens) };
  }
  if (protocol === "responses") {
    const cached = u.input_tokens_details?.cached_tokens;
    return { input: amount(u.input_tokens), output: amount(u.output_tokens), cached: amount(cached), reasoning: count(u.output_tokens_details?.reasoning_tokens) ? u.output_tokens_details.reasoning_tokens : undefined, complete: count(u.input_tokens) && count(u.output_tokens) && optionalCount(cached) && amount(cached) <= amount(u.input_tokens) };
  }
  if (protocol === "messages") {
    const input = amount(u.input_tokens) + amount(u.cache_read_input_tokens) + amount(u.cache_creation_input_tokens);
    return { input: amount(input), output: amount(u.output_tokens), cached: amount(u.cache_read_input_tokens), cacheWrite: amount(u.cache_creation_input_tokens),
      // The current price path does not distinguish cache-write billing; keep that estimate unknown.
      complete: count(input) && count(u.input_tokens) && count(u.output_tokens) && optionalCount(u.cache_read_input_tokens) && optionalCount(u.cache_creation_input_tokens) && amount(u.cache_creation_input_tokens) === 0 };
  }
  return { input: amount(u.promptTokenCount), output: amount(u.candidatesTokenCount), cached: amount(u.cachedContentTokenCount), reasoning: count(u.thoughtsTokenCount) ? u.thoughtsTokenCount : undefined,
    // Do not call an estimate complete while the price path lacks a separate thought-token mapping.
    complete: count(u.promptTokenCount) && count(u.candidatesTokenCount) && optionalCount(u.cachedContentTokenCount) && amount(u.cachedContentTokenCount) <= amount(u.promptTokenCount) && optionalCount(u.thoughtsTokenCount) && amount(u.thoughtsTokenCount) === 0 };
}

/** A side-effect-free meter shared by native observation and translated response decoders. */
export class OutputUsageTracker {
  #protocol: ApiProtocol;
  #streaming: boolean;
  #usage?: Usage;
  #messageUsage: Json = {};
  #terminal = false;
  #finalUsage = false;
  #invalid = false;
  #decoderFailure = false;
  failed = false;
  constructor(protocol: ApiProtocol, streaming: boolean) { this.#protocol = protocol; this.#streaming = streaming; }
  done(): void { if (this.#protocol === "chat") this.#terminal = true; this.#syncObservation(); }
  invalidate(): void { this.#invalid = true; this.#syncObservation(); }
  decoderFailed(): void { this.#decoderFailure = true; this.#syncObservation(); }
  #syncObservation(finished = false): void {
    // Snapshots share only this metadata object so a later error/terminal can
    // update evidence even when no further numeric usage event is emitted.
    const observation = this.#usage?.observation;
    if (!observation) return;
    observation.terminalObserved = this.#terminal;
    observation.finalUsageObserved = finished && this.#terminal && this.#finalUsage;
    observation.decoderFailed = this.failed || this.#decoderFailure;
    observation.decoderInvalid = this.#invalid;
  }
  take(j: Json): Usage | undefined {
    if (!j || typeof j !== "object" || Array.isArray(j)) { this.invalidate(); return undefined; }
    if (j.error || j.response?.error || j.type === "error" || j.type === "response.failed" || j.status === "failed") this.failed = true;
    let raw: Json | undefined; let terminal = false; let final = false;
    if (this.#protocol === "messages") {
      if (!this.#streaming) { raw = j.usage; terminal = typeof j.stop_reason === "string" && !!j.stop_reason; final = terminal; }
      else {
        if (j.type === "message_start") { this.#messageUsage = j.message?.usage ?? {}; raw = this.#messageUsage; }
        if (j.usage) { this.#messageUsage = { ...this.#messageUsage, ...j.usage }; raw = this.#messageUsage; final = j.type === "message_delta" && count(j.usage.output_tokens); }
        terminal = j.type === "message_stop";
      }
    } else if (this.#protocol === "responses") {
      terminal = this.#streaming ? j.type === "response.completed" || j.type === "response.incomplete" : j.status === "completed" || j.status === "incomplete";
      raw = j.usage ?? j.response?.usage; final = terminal || this.#terminal;
    } else if (this.#protocol === "gemini") {
      terminal = !!j.candidates?.some((c: Json) => typeof c.finishReason === "string" && c.finishReason) || !!j.promptFeedback?.blockReason;
      raw = j.usageMetadata; final = terminal || this.#terminal;
    } else {
      terminal = !!j.choices?.some((c: Json) => typeof c.finish_reason === "string" && c.finish_reason);
      raw = j.usage;
      final = terminal || this.#terminal || this.#streaming && Array.isArray(j.choices) && j.choices.length === 0;
    }
    this.#terminal ||= terminal;
    const moreContent = j.type === "content_block_delta" || typeof j.type === "string" && j.type.startsWith("response.") && j.type.endsWith(".delta") || j.choices?.some((c: Json) => c.delta?.content || c.delta?.reasoning_content || c.delta?.tool_calls?.length) || j.candidates?.some((c: Json) => c.content?.parts?.length);
    if (this.#streaming && !raw && moreContent) this.#finalUsage = false;
    if (raw) {
      this.#usage = { ...usageOf(this.#protocol, raw), observation: observeUsage(this.#protocol, raw, this.#streaming) };
      this.#finalUsage = final; this.#syncObservation(); return { ...this.#usage, complete: false };
    }
    this.#syncObservation();
    return undefined;
  }
  finish(): Usage | undefined { this.#syncObservation(true); return this.#usage && { ...this.#usage, complete: this.#usage.complete === true && this.#terminal && this.#finalUsage && !this.failed && !this.#invalid }; }
}

/** Wire decoders feed neutral events; none of them fabricates a Chat response. */
export async function* readOutput(response: Response, protocol: ApiProtocol): AsyncGenerator<OutputEvent> {
  if (!response.body) throw new ProtocolError("上游返回空响应。", 502);
  const streaming = response.headers.get("content-type")?.includes("text/event-stream");
  if (!streaming) {
    let raw = ""; for await (const data of outputData(response.body, false)) raw += data;
    const json = JSON.parse(raw) as Json;
    if (json.error) throw new ProtocolError("上游返回生成错误。", 502);
    yield* endedOutput(wholeOutput(json, protocol));
    return;
  }
  let stopped = false;
  let reason: Stop = "stop";
  const meter = new OutputUsageTracker(protocol, true);
  const calls = new Map<number, { id: string; name: string; arguments: string; emitted?: boolean; ended?: boolean; outputIndex?: number; boundary?: ArgumentBoundary }>();
  const messageKinds = new Map<number, OutputKind>();
  let chatNext = 0; let chatContent: { kind: "text" | "reasoning"; index: number } | undefined;
  function* chatPart(kind: "text" | "reasoning", part: Json): Generator<OutputEvent> {
    if (chatContent?.kind !== kind) {
      if (chatContent) yield { type: "block_end", ...chatContent };
      chatContent = { kind, index: chatNext++ };
    }
    yield { type: kind, index: chatContent.index, ...part } as OutputEvent;
  }
  const seenText = new Set<number>();
  const seenThought = new Set<number>();
  const completedItems = new Set<number>();
  let geminiIndex = -1; let geminiKind = "";
  const signedText = new Map<number, { text: string; thoughtSignature?: string }>();
  function* endGemini(): Generator<OutputEvent> {
    if (geminiIndex < 0) return;
    const index = geminiIndex;
    yield { type: "block_end", kind: geminiKind as OutputKind, index };
    const saved = signedText.get(index);
    if (saved?.thoughtSignature) {
      yield { type: "reasoning", index, encrypted: JSON.stringify(saved), redacted: true };
      yield { type: "block_end", kind: "reasoning", index };
    }
    signedText.delete(index);
  }
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
    yield { type: "block_end", kind: i.type === "function_call" ? "call" : i.type === "reasoning" ? "reasoning" : "text", index };
  }
  try {
  for await (const data of outputData(response.body, true)) {
    if (data === "[DONE]") { meter.done(); break; }
    const j = JSON.parse(data) as Json;
    const measured = meter.take(j); if (measured) yield { type: "usage", usage: measured };
    if (j.error || j.type === "error" || j.type === "response.failed") throw new ProtocolError("上游在生成过程中返回错误。", 502);
    if (protocol === "chat") {
      const c = j.choices?.[0]; if (!c) continue;
      const d = c.delta ?? {};
      if (d.refusal) throw new ProtocolError("上游拒绝生成回复。", 502);
      if (d.reasoning_content || d.reasoning || d.reasoning_signature || d.provider_state) yield* chatPart("reasoning", { text: d.reasoning_content ?? d.reasoning, signature: d.reasoning_signature, encrypted: d.provider_state });
      if (d.content) yield* chatPart("text", { text: d.content });
      for (const t of d.tool_calls ?? []) {
        if (chatContent) { yield { type: "block_end", ...chatContent }; chatContent = undefined; }
        const index = t.index ?? 0;
        let call = calls.get(index);
        if (!call) {
          if (calls.size >= OUTPUT_LIMITS.items) throw new ProtocolError("上游工具调用过多。", 502);
          call = { id: "", name: "", arguments: "", outputIndex: chatNext++, boundary: new ArgumentBoundary() }; calls.set(index, call);
        }
        if (call.emitted && (t.id || t.function?.name)) throw new ProtocolError("上游在参数开始后修改工具名称或 id。", 502);
        call.id += t.id ?? ""; call.name += t.function?.name ?? "";
        if (Buffer.byteLength(call.id) + Buffer.byteLength(call.name) > OUTPUT_LIMITS.toolHeaderBytes) throw new ProtocolError("上游工具标识超过安全大小限制。", 502);
        const fragment = t.function?.arguments ?? "";
        call.arguments += fragment; call.boundary!.add(fragment);
        if (call.emitted && fragment && !call.ended) yield { type: "arguments", index: call.outputIndex!, text: fragment };
        if (call.emitted && call.boundary!.complete && !call.ended) { call.ended = true; yield { type: "block_end", kind: "call", index: call.outputIndex! }; }
      }
      // Chat has no tool-header terminator: the first argument byte commits the header.
      // If parallel headers are fragmented, release them in source order once unambiguous.
      for (const call of calls.values()) {
        if (call.emitted) continue;
        if (!call.arguments || !call.id || !call.name) break;
        call.emitted = true; yield { type: "call", index: call.outputIndex!, id: call.id, name: call.name, arguments: call.arguments };
        if (call.boundary!.complete) { call.ended = true; yield { type: "block_end", kind: "call", index: call.outputIndex! }; }
      }
      if (c.finish_reason && !stopped) {
        if (chatContent) { yield { type: "block_end", ...chatContent }; chatContent = undefined; }
        for (const call of calls.values()) {
          if (!call.id || !call.name) throw new ProtocolError("上游工具调用缺少 id 或名称。", 502);
          if (!call.emitted) yield { type: "call", index: call.outputIndex!, id: call.id, name: call.name, arguments: call.arguments };
          if (!call.ended) yield { type: "block_end", kind: "call", index: call.outputIndex! };
        }
        reason = stopOf(c.finish_reason); stopped = true;
      }
    } else if (protocol === "messages") {
      if (j.type === "content_block_start") {
        const b = j.content_block;
        messageKinds.set(j.index, b.type === "tool_use" ? "call" : b.type === "text" ? "text" : "reasoning");
        if (b.type === "tool_use") yield { type: "call", index: j.index, id: b.id, name: b.name, arguments: Object.keys(b.input ?? {}).length ? JSON.stringify(b.input) : "" };
        else if (b.type === "text") yield { type: "text", index: j.index, text: b.text };
        else if (b.type === "thinking") yield { type: "reasoning", index: j.index, text: b.thinking, signature: b.signature };
        else if (b.type === "redacted_thinking") yield { type: "reasoning", index: j.index, encrypted: b.data, redacted: true };
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
      if (j.type === "content_block_stop") { const kind = messageKinds.get(j.index); if (kind) yield { type: "block_end", kind, index: j.index }; }
      if (j.type === "message_delta") {
        reason = stopOf(j.delta?.stop_reason ?? "end_turn");
      }
      if (j.type === "message_stop") stopped = true;
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
        reason = j.type === "response.incomplete" ? stopOf(j.response?.incomplete_details?.reason ?? "max_output_tokens") : calls.size ? "tool" : "stop";
        stopped = true;
      } else if (j.type === "response.refusal.delta") throw new ProtocolError("上游拒绝生成回复。", 502);
    } else {
      const c = j.candidates?.[0];
      if (!c && j.promptFeedback?.blockReason) { stopped = true; reason = "filter"; }
      for (const p of c?.content?.parts ?? []) {
        const kind = p.functionCall ? "call" : p.thought ? "reasoning" : "text";
        if (kind !== geminiKind || kind === "call") { yield* endGemini(); geminiIndex++; geminiKind = kind; }
        const index = geminiIndex;
        if (p.functionCall) {
          const call = { id: p.functionCall.id ?? "call_" + index, name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) };
          calls.set(index, call); yield { type: "call", index, ...call };
          yield { type: "block_end", kind: "call", index };
          if (p.thoughtSignature) { yield { type: "reasoning", index, encrypted: JSON.stringify({ callId: call.id, thoughtSignature: p.thoughtSignature }), redacted: true }; yield { type: "block_end", kind: "reasoning", index }; }
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
      if (c?.finishReason) { yield* endGemini(); geminiIndex = -1; geminiKind = ""; stopped = true; reason = c.finishReason === "STOP" && calls.size ? "tool" : stopOf(c.finishReason); }
    }
  }
  if (!stopped) throw new ProtocolError("上游响应流在结束事件前中断。", 502);
  if (protocol === "gemini") yield* endGemini();
  const finalUsage = meter.finish(); if (finalUsage) yield { type: "usage", usage: finalUsage };
  yield { type: "stop", reason };
  } catch (error) { meter.decoderFailed(); throw error; }
}

function* wholeOutput(j: Json, protocol: ApiProtocol): Generator<OutputEvent> {
  let reason: Stop = "stop";
  let usage: Json | undefined;
  if (protocol === "chat") {
    const c = j.choices?.[0]; if (!c) throw new ProtocolError("上游缺少回复。", 502);
    const m = c.message;
    if (m.refusal) throw new ProtocolError("上游拒绝生成回复。", 502);
    if (m.reasoning_content || m.reasoning || m.reasoning_signature || m.provider_state) yield { type: "reasoning", text: m.reasoning_content ?? m.reasoning, signature: m.reasoning_signature, encrypted: m.provider_state };
    if (m.content) yield { type: "text", text: m.content };
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
  if (usage) { const meter = new OutputUsageTracker(protocol, false); meter.take(j); const measured = meter.finish(); if (measured) yield { type: "usage", usage: measured }; }
  yield { type: "stop", reason };
}

/** Whole replies use the same per-block lifecycle as streamed replies. */
function* endedOutput(events: Iterable<OutputEvent>): Generator<OutputEvent> {
  let previous: { kind: OutputKind; index: number } | undefined;
  for (const e of events) {
    if (e.type === "usage" || e.type === "stop") {
      if (previous) { yield { type: "block_end", ...previous }; previous = undefined; }
      yield e; continue;
    }
    if (e.type === "block_end") { yield e; continue; }
    const kind = e.type === "arguments" ? "call" : e.type;
    const index = e.index ?? 0;
    if (previous && (previous.kind !== kind || previous.index !== index)) yield { type: "block_end", ...previous };
    previous = { kind, index }; yield e;
  }
  if (previous) yield { type: "block_end", ...previous };
}
