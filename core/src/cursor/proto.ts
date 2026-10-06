/**
 * The few protobuf pieces the Cursor adapter needs, written by hand (the project has no runtime dependencies):
 * a writer for varints, strings, bytes and nested messages, and a reader that walks the fields of one message.
 * Field numbers belong to Cursor's agent.v1 protocol; they are listed where each message is built (messages.ts).
 */

export class Writer {
  private parts: Buffer[] = [];

  private varint(value: number): Buffer {
    const out: number[] = [];
    let v = value;
    while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(v);
    return Buffer.from(out);
  }

  private tag(field: number, wire: number): void { this.parts.push(this.varint(field * 8 + wire)); }

  uint(field: number, value: number): this { this.tag(field, 0); this.parts.push(this.varint(value)); return this; }

  bytes(field: number, value: Uint8Array): this {
    this.tag(field, 2); this.parts.push(this.varint(value.length), Buffer.from(value)); return this;
  }

  string(field: number, value: string): this { return this.bytes(field, Buffer.from(value, "utf8")); }

  /** A nested message; an empty one is still written (its presence can matter). */
  message(field: number, inner: Writer | Uint8Array): this { return this.bytes(field, inner instanceof Writer ? inner.finish() : inner); }

  finish(): Buffer { return Buffer.concat(this.parts); }
}

export interface Field { field: number; wire: number; value: number | Buffer }

const MAX_FIELDS = 4096;

/** Every field of one message, in order. A malformed message throws rather than guessing. */
export function readFields(buf: Uint8Array): Field[] {
  const data = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Field[] = [];
  let at = 0;
  const varint = (): number => {
    let result = 0; let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= data.length) throw new Error("protobuf: truncated varint");
      const byte = data[at++]!;
      result += (byte & 0x7f) * scale;
      if (!(byte & 0x80)) return result;
      scale *= 128;
    }
    throw new Error("protobuf: varint too long");
  };
  while (at < data.length) {
    if (out.length >= MAX_FIELDS) throw new Error("protobuf: too many fields");
    const key = varint();
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) out.push({ field, wire, value: varint() });
    else if (wire === 2) {
      const length = varint();
      if (at + length > data.length) throw new Error("protobuf: truncated field");
      out.push({ field, wire, value: data.subarray(at, at + length) }); at += length;
    } else if (wire === 1) { if (at + 8 > data.length) throw new Error("protobuf: truncated field"); out.push({ field, wire, value: data.subarray(at, at + 8) }); at += 8; }
    else if (wire === 5) { if (at + 4 > data.length) throw new Error("protobuf: truncated field"); out.push({ field, wire, value: data.subarray(at, at + 4) }); at += 4; }
    else throw new Error(`protobuf: unsupported wire type ${wire}`);
  }
  return out;
}

/** The first length-delimited value of a field, or undefined. */
export function bytesOf(fields: Field[], field: number): Buffer | undefined {
  const f = fields.find(x => x.field === field && x.wire === 2);
  return f ? (f.value as Buffer) : undefined;
}

export const stringOf = (fields: Field[], field: number): string | undefined => bytesOf(fields, field)?.toString("utf8");

export function uintOf(fields: Field[], field: number): number | undefined {
  const f = fields.find(x => x.field === field && x.wire === 0);
  return f ? (f.value as number) : undefined;
}
