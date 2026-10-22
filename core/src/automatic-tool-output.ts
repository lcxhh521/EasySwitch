import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import { AUTOMATIC_TOOL_LIMITS, hashToolArguments } from "./automatic-tool-policy.ts";
import type { AutomaticToolCall } from "./automatic-tool-policy.ts";
import { OUTPUT_LIMITS, ProtocolError } from "./protocol.ts";

export interface AutomaticToolOutputOptions {
  stream: boolean;
  toolNames: ReadonlySet<string>;
  requireToolCall?: boolean;
  allowParallelToolCalls?: boolean;
  /** Must synchronously validate/store the entire batch atomically, or throw. */
  commitCalls: (calls: readonly AutomaticToolCall[]) => void;
  onComplete: () => void;
  onError?: (error: Error) => void;
}
type ObjectValue = Record<string, unknown>;
interface PendingCall { id: string; name: string; arguments: string; type: boolean }
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: ObjectValue, key: string): boolean => Object.hasOwn(value, key);
const only = (value: ObjectValue, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const failure = (): ProtocolError => new ProtocolError("固定工具会话的上游输出未通过完整性校验；本会话已停止，请检查已有结果后新开会话。", 502);
function check(valid: unknown): asserts valid { if (!valid) throw failure(); }
function json(raw: string): unknown { try { return JSON.parse(raw); } catch { throw failure(); } }
function usage(value: unknown): void {
  check(object(value) && only(value, ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"]));
  check(count(value.prompt_tokens) && count(value.completion_tokens) && count(value.total_tokens) && value.total_tokens === value.prompt_tokens + value.completion_tokens);
  for (const [key, allowed] of [["prompt_tokens_details", ["cached_tokens", "audio_tokens"]], ["completion_tokens_details", ["reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"]]] as const) {
    if (has(value, key) && value[key] !== null) check(object(value[key]) && only(value[key], allowed) && Object.values(value[key]).every(count));
  }
}

/**
 * No decoder/re-encoder or asynchronous tee: retain exact bytes. Forward checked
 * nonterminal frames, hold finish/usage/DONE until normal EOF, then synchronously
 * commit scope proofs before any successful terminal bytes become visible.
 * Earlier partial bytes can have been seen on failure; the caller must pause its
 * pinned scope and propagate source/destination cancellation with pipeline().
 */
export function createAutomaticToolOutput(options: AutomaticToolOutputOptions): Transform {
  const declaredTools = new Set(options.toolNames);
  let storage = Buffer.alloc(1024); let used = 0; let scanned = 0; let lineStart = 0;
  let total = 0; let frames = 0;
  const tail: Buffer[] = []; const calls = new Map<number, PendingCall>();
  let finished = false; let done = false; let completed = false; let reported = false;
  let identity: string | undefined; let sawUsage = false;
  let proofs: AutomaticToolCall[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  function decode(bytes: Buffer): string { try { return decoder.decode(bytes); } catch { throw failure(); } }
  function report(error: Error): void { if (!reported) { reported = true; try { options.onError?.(error); } catch { /* Preserve the actual stream failure. */ } } }
  function toolCall(value: unknown, isStream: boolean, position: number): void {
    check(declaredTools.size > 0 && object(value) && only(value, isStream ? ["index", "id", "type", "function"] : ["id", "type", "function"]));
    const index = isStream ? value.index : position;
    check(count(index) && index < AUTOMATIC_TOOL_LIMITS.tools);
    let call = calls.get(index);
    if (!call) {
      check(options.allowParallelToolCalls !== false || calls.size === 0);
      call = { id: "", name: "", arguments: "", type: false }; calls.set(index, call);
    }
    if (has(value, "id")) { check(typeof value.id === "string"); call.id += value.id; }
    if (has(value, "type")) { check(value.type === "function"); call.type = true; }
    if (has(value, "function")) {
      check(object(value.function) && only(value.function, ["name", "arguments"]));
      if (has(value.function, "name")) { check(typeof value.function.name === "string"); call.name += value.function.name; }
      if (has(value.function, "arguments")) { check(typeof value.function.arguments === "string"); call.arguments += value.function.arguments; }
    }
    check(call.id.length <= 256 && call.name.length <= 64 && Buffer.byteLength(call.arguments) <= AUTOMATIC_TOOL_LIMITS.argumentsBytes);
    // Names may be fragmented, but an impossible prefix is already invalid.
    check([...declaredTools].some(name => name.startsWith(call.name)));
  }
  function finish(reason: unknown): void {
    check(!finished && (reason === "stop" || reason === "tool_calls"));
    check((reason === "tool_calls") === (calls.size > 0));
    check(!options.requireToolCall || calls.size > 0);
    check(options.allowParallelToolCalls !== false || calls.size <= 1);
    const ids = new Set<string>(); const result: AutomaticToolCall[] = [];
    for (let index = 0; index < calls.size; index++) {
      const call = calls.get(index);
      check(call && call.type && /^[A-Za-z0-9_.:-]{1,256}$/.test(call.id) && !call.id.startsWith("es-state:") && !ids.has(call.id) && /^[A-Za-z0-9_-]{1,64}$/.test(call.name) && declaredTools.has(call.name));
      let argumentsHash: string;
      try { argumentsHash = hashToolArguments(call.arguments); } catch { throw failure(); }
      result.push({ id: call.id, name: call.name, argumentsHash }); ids.add(call.id);
    }
    proofs = result; finished = true;
    calls.clear(); // Raw arguments have no role after verified terminal parsing.
  }
  function envelope(value: unknown, isStream: boolean): void {
    check(object(value) && only(value, ["id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier"]));
    check(typeof value.id === "string" && value.id.length > 0 && value.id.length <= 256 && value.object === (isStream ? "chat.completion.chunk" : "chat.completion") && count(value.created) && typeof value.model === "string" && value.model.length > 0 && value.model.length <= 4096);
    for (const key of ["system_fingerprint", "service_tier"]) check(!has(value, key) || value[key] === null || typeof value[key] === "string");
    const currentIdentity = JSON.stringify([value.id, value.model, value.created]);
    check(identity === undefined || identity === currentIdentity); identity = currentIdentity;
    check(Array.isArray(value.choices) && value.choices.length <= 1);
    if (value.choices.length === 0) {
      check(isStream && finished && !sawUsage && value.usage != null); usage(value.usage); sawUsage = true; return;
    }
    check(!finished);
    const choice = value.choices[0];
    check(object(choice) && only(choice, isStream ? ["index", "delta", "finish_reason", "logprobs"] : ["index", "message", "finish_reason", "logprobs"]) && choice.index === 0 && (!has(choice, "logprobs") || choice.logprobs === null));
    const message = isStream ? choice.delta : choice.message;
    check(object(message) && only(message, ["role", "content", "tool_calls", "refusal"]));
    check((isStream && !has(message, "role")) || message.role === "assistant");
    check(!has(message, "content") || message.content === null || typeof message.content === "string");
    check(!has(message, "refusal") || message.refusal === null);
    if (has(message, "tool_calls")) {
      check(Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && message.tool_calls.length <= AUTOMATIC_TOOL_LIMITS.tools);
      message.tool_calls.forEach((call, index) => toolCall(call, isStream, index));
    }
    if (choice.finish_reason != null) finish(choice.finish_reason);
    else check(isStream);
    if (value.usage != null) { check(finished && !sawUsage); usage(value.usage); sawUsage = true; }
  }
  function frame(raw: Buffer): void {
    check(++frames <= OUTPUT_LIMITS.items && raw.length <= OUTPUT_LIMITS.frameBytes);
    const text = decode(raw);
    // Standard SSE also treats bare CR as a line ending. This narrow contract
    // supports LF/CRLF only: otherwise a comment could hide client-visible data.
    check(!/\r(?!\n)/.test(text));
    const lines = text.split(/\r?\n/); const data: string[] = [];
    for (const line of lines) {
      if (!line || line.startsWith(":")) continue;
      check(line.startsWith("data:"));
      const content = line.slice(5); data.push(content.startsWith(" ") ? content.slice(1) : content);
    }
    if (!data.length) return;
    check(!done);
    const value = data.join("\n");
    if (value === "[DONE]") { check(finished); done = true; return; }
    envelope(json(value), true);
  }
  const transform = new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      try {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.length; check(total <= OUTPUT_LIMITS.responseBytes);
        if (used + bytes.length > storage.length) {
          const grown = Buffer.alloc(Math.min(OUTPUT_LIMITS.responseBytes, Math.max(used + bytes.length, storage.length * 2)));
          storage.copy(grown, 0, 0, used); storage = grown;
        }
        bytes.copy(storage, used); used += bytes.length;
        if (!options.stream) { callback(); return; }
        // A frame boundary is an empty LF or CRLF line, even across chunks.
        // Remember the scan offset so byte-at-a-time input stays linear.
        let start = 0;
        for (let index = scanned; index < used; index++) {
          if (storage[index] !== 10) continue;
          const length = index - lineStart;
          if (length === 0 || (length === 1 && storage[lineStart] === 13)) {
            const raw = Buffer.from(storage.subarray(start, index + 1)); frame(raw);
            if (finished) tail.push(raw); else this.push(raw);
            start = index + 1;
          }
          lineStart = index + 1;
        }
        storage.copy(storage, 0, start, used); used -= start; lineStart -= start; scanned = used;
        check(used <= OUTPUT_LIMITS.frameBytes);
        callback();
      } catch (error) { callback(error instanceof Error ? error : failure()); }
    },
    flush(callback: TransformCallback) {
      try {
        if (options.stream) check(used === 0 && finished && done);
        else { check(used > 0); const raw = Buffer.from(storage.subarray(0, used)); envelope(json(decode(raw)), false); check(finished); tail.push(raw); }
        // A Promise-returning callback is not synchronous proof registration.
        const committed: unknown = options.commitCalls(proofs);
        check(!object(committed) || typeof committed.then !== "function");
        const completion: unknown = options.onComplete();
        check(!object(completion) || typeof completion.then !== "function");
        for (const raw of tail) this.push(raw);
        completed = true; storage = Buffer.alloc(0); used = 0; tail.length = 0; proofs = []; callback();
      } catch (error) { callback(error instanceof Error ? error : failure()); }
    },
    destroy(error: Error | null, callback: (error?: Error | null) => void) {
      calls.clear(); tail.length = 0; proofs = []; storage = Buffer.alloc(0); used = 0;
      if (error || !completed) { const cause = error ?? failure(); report(cause); callback(cause); }
      else callback(error);
    },
  });
  return transform;
}
