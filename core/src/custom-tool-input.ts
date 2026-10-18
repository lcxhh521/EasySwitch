import { ProtocolError } from "./protocol.ts";

/** Incremental decoding of the canonical {"input":"…"} custom-tool wrapper.
 * Noncanonical property order stays buffered. This is only a progress decoder:
 * the complete JSON object and the emitted prefix must still validate at finish.
 */
export class CustomToolInput {
  private token = 0;
  private offset = 0;
  private disabled = false;
  private closed = false;
  private escape = "";
  private high = "";
  private readonly prefix = ["{", '"input"', ":", '"'];

  validate(raw: string): void { validateCustomToolObject(raw); }

  add(fragment: string): string {
    let output = "";
    const append = (char: string) => {
      const code = char.charCodeAt(0);
      if (this.high) { output += this.high; this.high = ""; }
      if (code >= 0xd800 && code <= 0xdbff) this.high = char;
      else output += char;
    };
    for (let at = 0; at < fragment.length; at++) {
      const char = fragment[at]!;
      if (this.disabled || this.closed) break;
      if (this.token < this.prefix.length) {
        if (!this.offset && /\s/.test(char)) continue;
        const expected = this.prefix[this.token]!;
        if (char !== expected[this.offset]) { this.disabled = true; break; }
        if (++this.offset === expected.length) { this.token++; this.offset = 0; }
        continue;
      }
      if (this.escape) {
        this.escape += char;
        if (this.escape === "\\u") continue;
        if (this.escape.startsWith("\\u") && this.escape.length < 6) {
          if (!/^[0-9a-f]$/i.test(char)) throw new ProtocolError("自定义工具 input 包含无效 Unicode 转义。", 502);
          continue;
        }
        try { append(JSON.parse('"' + this.escape + '"')); }
        catch { throw new ProtocolError("自定义工具 input 包含无效转义。", 502); }
        this.escape = "";
      } else if (char === "\\") this.escape = char;
      else if (char === '"') { this.closed = true; output += this.high; this.high = ""; }
      else {
        if (char.charCodeAt(0) < 0x20) throw new ProtocolError("自定义工具 input 包含无效控制字符。", 502);
        append(char);
      }
    }
    // A high surrogate remains pending across argument fragments, so UTF-16 pairs
    // are not serialized as independent malformed Unicode progress events.
    return output;
  }
}

/** Called only after full JSON parsing. JSON.parse discards duplicate keys, so
 * inspect top-level property spellings independently, including escaped names.
 * Nested values are skipped, and validation remains linear in wrapper length.
 */
export function validateCustomToolObject(raw: string): void {
  const keys = new Set<string>();
  let depth = 0;
  for (let at = 0; at < raw.length; at++) {
    const char = raw[at];
    if (char === '"') {
      const start = at++;
      for (; at < raw.length; at++) {
        if (raw[at] === "\\") at++;
        else if (raw[at] === '"') break;
      }
      if (depth !== 1) continue;
      let next = at + 1; while (next < raw.length && /\s/.test(raw[next]!)) next++;
      if (raw[next] !== ":") continue;
      const key = JSON.parse(raw.slice(start, at + 1)) as string;
      if (keys.has(key)) throw new ProtocolError("自定义工具包装字段重复，无法安全输出。", 502);
      keys.add(key);
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
}
