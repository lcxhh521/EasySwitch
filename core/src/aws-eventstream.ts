/**
 * Independent AWS EventStream framing from the public Smithy/AWS wire contract.
 * https://smithy.io/2.0/aws/amazon-eventstream.html
 * CRC32/GZIP: RFC 1952. No vendor login or event-payload semantics live here.
 * The replaced implementation's historical provenance and MIT notice remain in
 * PROVENANCE.md and third_party/opencodex/LICENSE; its code was not consulted.
 */
export type EventHeaderValue =
  | { type: "boolean"; value: boolean }
  | { type: "byte" | "short" | "integer"; value: number }
  | { type: "long" | "timestamp"; value: bigint }
  | { type: "binary"; value: Uint8Array }
  | { type: "string" | "uuid"; value: string };
export interface EventStreamMessage {
  /** Backward-compatible projection of string headers used by current callers. */
  headers: Record<string, string>;
  /** All wire values, including lossless signed 64-bit values. */
  headerValues: Record<string, EventHeaderValue>;
  payload: Uint8Array;
}
export interface EventStreamLimits {
  maxFrameBytes?: number;
  /** Maximum size of one supplied transport chunk; not a total JS heap claim. */
  maxChunkBytes?: number;
  maxStreamBytes?: number;
  maxMessages?: number;
  maxHeaders?: number;
  signal?: AbortSignal;
}
export class EventStreamError extends Error {
  readonly status = 502;
  readonly code: "invalid_eventstream" | "eventstream_limit";
  constructor(code: "invalid_eventstream" | "eventstream_limit", message: string) { super(message); this.name = "EventStreamError"; this.code = code; }
}
const MAX_FRAME = 32 * 1024 * 1024;
const MAX_STREAM = 64 * 1024 * 1024;
const MAX_HEADERS = 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]!;
  return (crc ^ 0xffffffff) >>> 0;
}
const invalid = () => new EventStreamError("invalid_eventstream", "上游事件流格式或校验和无效。");
const limit = () => new EventStreamError("eventstream_limit", "上游事件流超过本地资源限制。");
const aborted = () => new DOMException("事件流读取已取消。", "AbortError");
function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("事件流资源限制设置无效。");
  return value;
}
function decodeText(bytes: Uint8Array): string { try { return utf8.decode(bytes); } catch { throw invalid(); } }
function encodeText(value: string): Uint8Array {
  if (typeof value !== "string") throw invalid();
  const bytes = encoder.encode(value);
  // TextEncoder replaces unpaired UTF-16 surrogates; do not silently change names.
  if (decodeText(bytes) !== value) throw invalid();
  return bytes;
}
function parseHeaders(bytes: Uint8Array, maxHeaders: number): Pick<EventStreamMessage, "headers" | "headerValues"> {
  const headers: Record<string, string> = Object.create(null), headerValues: Record<string, EventHeaderValue> = Object.create(null);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0, count = 0;
  const take = (size: number) => {
    if (size > bytes.length - offset) throw invalid();
    const begin = offset; offset += size; return begin;
  };
  while (offset < bytes.length) {
    if (++count > maxHeaders) throw limit();
    const nameSize = bytes[take(1)]!;
    if (!nameSize) throw invalid();
    const name = decodeText(bytes.subarray(take(nameSize), offset));
    if (Object.hasOwn(headerValues, name)) throw invalid();
    const tag = bytes[take(1)]!;
    let value: EventHeaderValue;
    switch (tag) {
      case 0: case 1: value = { type: "boolean", value: tag === 0 }; break;
      case 2: value = { type: "byte", value: view.getInt8(take(1)) }; break;
      case 3: value = { type: "short", value: view.getInt16(take(2), false) }; break;
      case 4: value = { type: "integer", value: view.getInt32(take(4), false) }; break;
      case 5: value = { type: "long", value: view.getBigInt64(take(8), false) }; break;
      case 6: case 7: {
        const size = view.getUint16(take(2), false), start = take(size);
        value = tag === 6 ? { type: "binary", value: bytes.slice(start, offset) } : { type: "string", value: decodeText(bytes.subarray(start, offset)) };
        break;
      }
      // Smithy's type table says unsigned while its wire pseudocode says int64.
      // Follow the signed wire definition and retain precision without Date conversion.
      case 8: value = { type: "timestamp", value: view.getBigInt64(take(8), false) }; break;
      case 9: {
        const start = take(16), hex = [...bytes.subarray(start, offset)].map(b => b.toString(16).padStart(2, "0")).join("");
        value = { type: "uuid", value: `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}` }; break;
      }
      default: throw invalid();
    }
    headerValues[name] = value;
    if (value.type === "string") headers[name] = value.value;
  }
  return { headers, headerValues };
}

/** One bounded frame at a time, independent of transport chunk boundaries.
 * Limits below are local resource policy, not the service-side Smithy size rules.
 * On validation failure or early return the reader is cancelled; no raw bytes or
 * transport error messages are incorporated into diagnostics.
 */
export async function* decodeEventStream(source: ReadableStream<Uint8Array>, options: EventStreamLimits = {}): AsyncGenerator<EventStreamMessage> {
  const maxFrame = bounded(options.maxFrameBytes, MAX_FRAME, 16, 1024 * 1024 * 1024);
  const maxChunk = bounded(options.maxChunkBytes, MAX_FRAME, 12, 1024 * 1024 * 1024);
  const maxStream = bounded(options.maxStreamBytes, MAX_STREAM, 16, Number.MAX_SAFE_INTEGER);
  const maxMessages = bounded(options.maxMessages, 100_000, 1, 1_000_000);
  const maxHeaders = bounded(options.maxHeaders, MAX_HEADERS, 1, 65_536);
  const reader = source.getReader();
  let chunk: Uint8Array = new Uint8Array(0), cursor = 0, total = 0, messages = 0, emptyReads = 0, ended = false;
  const checkAbort = () => { if (options.signal?.aborted) throw aborted(); };
  const read = async () => {
    checkAbort();
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const cancellation = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const onAbort = () => { void reader.cancel().catch(() => {}); rejectAbort?.(aborted()); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      checkAbort();
      const next = await Promise.race([reader.read(), cancellation]);
      checkAbort();
      return next;
    } catch {
      if (options.signal?.aborted) throw aborted();
      throw new EventStreamError("invalid_eventstream", "上游事件流读取失败。");
    } finally { options.signal?.removeEventListener("abort", onAbort); }
  };
  const fill = async (target: Uint8Array, allowCleanEof = false): Promise<boolean> => {
    let written = 0;
    while (written < target.length) {
      checkAbort();
      if (cursor === chunk.length) {
        const next = await read();
        if (next.done) { if (allowCleanEof && written === 0) { ended = true; return false; } throw invalid(); }
        if (!(next.value instanceof Uint8Array)) throw invalid();
        if (!next.value.length) { if (++emptyReads > 1024) throw limit(); continue; }
        emptyReads = 0;
        if (next.value.byteLength > maxChunk || total > maxStream - next.value.byteLength) throw limit();
        total += next.value.byteLength; chunk = next.value; cursor = 0;
      }
      const size = Math.min(target.length - written, chunk.length - cursor);
      target.set(chunk.subarray(cursor, cursor + size), written); cursor += size; written += size;
    }
    return true;
  };
  try {
    for (;;) {
      const prelude = new Uint8Array(12);
      if (!await fill(prelude, true)) return;
      const meta = new DataView(prelude.buffer);
      if (crc32(prelude.subarray(0,8)) !== meta.getUint32(8, false)) throw invalid();
      const length = meta.getUint32(0, false), headerLength = meta.getUint32(4, false);
      if (length < 16 || headerLength > length - 16) throw invalid();
      if (length > maxFrame || ++messages > maxMessages) throw limit();
      const frame = new Uint8Array(length); frame.set(prelude);
      await fill(frame.subarray(12));
      checkAbort();
      if (crc32(frame.subarray(0,length-4)) !== new DataView(frame.buffer).getUint32(length-4, false)) throw invalid();
      const fields = parseHeaders(frame.subarray(12,12+headerLength), maxHeaders);
      yield { ...fields, payload: frame.slice(12+headerLength,length-4) };
    }
  } finally {
    if (!ended) { try { void reader.cancel().catch(() => {}); } catch { /* Preserve the validation outcome. */ } }
    try { reader.releaseLock(); } catch { /* A cancelled, uncooperative transport must not hold up return. */ }
  }
}

/** Fixture/interop encoder; the production Kiro path only decodes frames. */
export function encodeTypedMessage(headers: Record<string, EventHeaderValue>, payload: Uint8Array): Uint8Array {
  if (!(payload instanceof Uint8Array) || !headers || typeof headers !== "object" || Array.isArray(headers)) throw invalid();
  const names = Object.keys(headers);
  if (names.length > MAX_HEADERS || payload.length > MAX_FRAME - 16) throw limit();
  const parts: Uint8Array[] = [];
  let size = 0;
  const push = (part: Uint8Array) => { size += part.length; if (size > MAX_FRAME - 16 - payload.length) throw limit(); parts.push(part); };
  for (const name of names) {
    if (name.length === 0 || name.length > 255) throw invalid();
    const encodedName = encodeText(name), header = headers[name];
    if (!encodedName.length || encodedName.length > 255 || !header || typeof header !== "object") throw invalid();
    push(Uint8Array.of(encodedName.length)); push(encodedName);
    const numeric = (tag: number, width: number, minimum: number, maximum: number) => {
      if (typeof header.value !== "number" || !Number.isInteger(header.value) || header.value < minimum || header.value > maximum) throw invalid();
      const data = new Uint8Array(width + 1), view = new DataView(data.buffer); data[0] = tag;
      if (width === 1) view.setInt8(1,header.value); else if (width === 2) view.setInt16(1,header.value,false); else view.setInt32(1,header.value,false);
      push(data);
    };
    switch (header.type) {
      case "boolean": if (typeof header.value !== "boolean") throw invalid(); push(Uint8Array.of(header.value ? 0 : 1)); break;
      case "byte": numeric(2,1,-128,127); break;
      case "short": numeric(3,2,-32768,32767); break;
      case "integer": numeric(4,4,-2147483648,2147483647); break;
      case "long": case "timestamp": {
        if (typeof header.value !== "bigint" || header.value < -(1n << 63n) || header.value >= (1n << 63n)) throw invalid();
        const data = new Uint8Array(9); data[0] = header.type === "long" ? 5 : 8; new DataView(data.buffer).setBigInt64(1,header.value,false); push(data); break;
      }
      case "binary": case "string": {
        if (header.type === "string" && (typeof header.value !== "string" || header.value.length > 65535)) throw invalid();
        const value = header.type === "string" ? encodeText(header.value) : header.value;
        if (!(value instanceof Uint8Array) || value.length > 65535) throw invalid();
        const meta = new Uint8Array(3); meta[0] = header.type === "string" ? 7 : 6; new DataView(meta.buffer).setUint16(1,value.length,false); push(meta); push(value); break;
      }
      case "uuid": {
        if (typeof header.value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(header.value)) throw invalid();
        const hex = header.value.replaceAll("-", ""), data = new Uint8Array(17); data[0] = 9;
        for (let i = 0; i < 16; i++) data[i+1] = Number.parseInt(hex.slice(i*2,i*2+2),16); push(data); break;
      }
      default: throw invalid();
    }
  }
  const frame = new Uint8Array(size + payload.length + 16), view = new DataView(frame.buffer);
  view.setUint32(0,frame.length,false); view.setUint32(4,size,false); view.setUint32(8,crc32(frame.subarray(0,8)),false);
  let offset = 12; for (const part of parts) { frame.set(part,offset); offset += part.length; } frame.set(payload,offset);
  view.setUint32(frame.length-4,crc32(frame.subarray(0,frame.length-4)),false); return frame;
}
export function encodeMessage(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw invalid();
  const typed: Record<string, EventHeaderValue> = Object.create(null);
  for (const [name,value] of Object.entries(headers)) typed[name] = { type: "string", value };
  return encodeTypedMessage(typed,payload);
}
