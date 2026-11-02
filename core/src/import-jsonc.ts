/** Bounded data-only JSON/JSONC parser. No evaluation, interpolation or duplicate-key guessing. */
export function parseImportJson(text: string, comments = false): Record<string, unknown> {
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("Unsupported import configuration");
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0, nodes = 0;
  const fail = (): never => { throw new Error("Unsupported import configuration"); };
  const space = () => {
    for (;;) {
      while (/[\x20\t\r\n]/.test(text[at] ?? "!") && at < text.length) at++;
      if (!comments || text[at] !== "/") return;
      if (text[at + 1] === "/") { at += 2; while (at < text.length && text[at] !== "\n" && text[at] !== "\r") at++; }
      else if (text[at + 1] === "*") { const end = text.indexOf("*/", at + 2); if (end < 0) fail(); at = end + 2; }
      else return;
    }
  };
  const string = (): string => {
    const start = at++;
    while (at < text.length) {
      const c = text[at++];
      if (c === "\\") { at++; continue; }
      if (c === '"') { try { return JSON.parse(text.slice(start, at)) as string; } catch { return fail(); } }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 64 || ++nodes > 100_000) fail();
    space();
    const c = text[at];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      at++; space();
      const object = c === "{", end = object ? "}" : "]";
      const result: Record<string, unknown> | unknown[] = object ? Object.create(null) : [];
      const keys = new Set<string>();
      if (text[at] === end) { at++; return result; }
      for (;;) {
        space();
        if (object) {
          if (text[at] !== '"') fail();
          const key = string();
          if (keys.has(key) || ["__proto__", "constructor", "prototype"].includes(key)) fail();
          keys.add(key); space(); if (text[at++] !== ":") fail();
          (result as Record<string, unknown>)[key] = value(depth + 1);
        } else (result as unknown[]).push(value(depth + 1));
        space();
        if (text[at] === end) { at++; return result; }
        if (text[at++] !== ",") fail();
        space();
        if (text[at] === end) { if (!comments) fail(); at++; return result; }
      }
    }
    for (const [word, literal] of [["true", true], ["false", false], ["null", null]] as const) if (text.startsWith(word, at)) { at += word.length; return literal; }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(text.slice(at));
    if (!number) return fail();
    at += number[0].length;
    const parsed = Number(number[0]); if (!Number.isFinite(parsed)) fail(); return parsed;
  };
  const result = value(0); space();
  if (at !== text.length || !result || typeof result !== "object" || Array.isArray(result)) fail();
  return result as Record<string, unknown>;
}
