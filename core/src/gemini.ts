/** Gemini JSON schema normalization shared by the neutral inbound decoder. */
type Json = Record<string, unknown>;

/** Gemini writes schema types in capitals ("OBJECT"); Chat tools want JSON Schema. */
export function lowerSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lowerSchema);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === "type" && typeof v === "string") out[k] = v.toLowerCase();
    // Fields Gemini adds that JSON Schema validators on other providers reject.
    else if (k === "nullable" || k === "propertyOrdering") continue;
    else out[k] = lowerSchema(v);
  }
  return out;
}
