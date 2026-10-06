/**
 * Connect protocol framing: every message is a 5-byte header (one flags byte, a 4-byte big-endian length) and then
 * the payload. Flag 0x01 means compressed, 0x02 means the end-of-stream frame, whose payload is JSON ({} on success,
 * {"error": {...}} on failure).
 */

export const FLAG_COMPRESSED = 0x01;
export const FLAG_END_STREAM = 0x02;
const MAX_FRAME = 16 * 1024 * 1024;

export function encodeFrame(payload: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

export interface Frame { flags: number; payload: Buffer }

/** Collects the chunks of a response and hands out whole frames. */
export class FrameParser {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): Frame[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    const frames: Frame[] = [];
    while (this.pending.length >= 5) {
      const length = this.pending.readUInt32BE(1);
      if (length > MAX_FRAME) throw new Error("Cursor 返回了过大的数据帧");
      if (this.pending.length < 5 + length) break;
      frames.push({ flags: this.pending[0]!, payload: this.pending.subarray(5, 5 + length) });
      this.pending = this.pending.subarray(5 + length);
    }
    return frames;
  }

  /** Bytes of an unfinished frame left over when the stream ended. */
  get leftover(): number { return this.pending.length; }
}

export interface ConnectError { code: string; message: string; details?: Array<{ type?: string; value?: string }> }

/** The error in an end-of-stream frame, or undefined for a clean end. */
export function endStreamError(payload: Uint8Array): ConnectError | undefined {
  if (!payload.length) return undefined;
  try {
    const body = JSON.parse(Buffer.from(payload).toString("utf8")) as { error?: { code?: string; message?: string; details?: ConnectError["details"] } };
    if (!body.error) return undefined;
    return { code: String(body.error.code ?? "unknown"), message: String(body.error.message ?? ""), ...(body.error.details ? { details: body.error.details } : {}) };
  } catch { return { code: "unknown", message: "无法读懂 Cursor 的结束帧" }; }
}
