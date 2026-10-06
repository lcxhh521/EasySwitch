/** Neutral input repairs for proprietary sources. Never encodes through another model API. */
import { createHash } from "node:crypto";
import { ProtocolError, type Conversation, type InboundRequest, type Part, type Turn } from "./protocol.ts";

export function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every(p => p && typeof p === "object" && typeof p.type === "string")) return value.map(p => ["text", "input_text", "output_text"].includes(p.type) ? String(p.text ?? "") : `[${p.type}]`).join("\n");
  return JSON.stringify(value ?? "");
}

/** Missing results are explicitly labelled; orphan/duplicate results remain visible as user text. */
export function repairConversation(c: Conversation): Conversation {
  const copy = structuredClone(c);
  const results = new Map<string, Extract<Part, { type: "result" }>>();
  for (const t of copy.turns) for (const p of t.parts) if (p.type === "result" && !results.has(p.id)) results.set(p.id, p);
  const calls = new Set(copy.turns.flatMap(t => t.parts.filter(p => p.type === "call").map(p => p.id)));
  const used = new Set<Part>(); const turns: Turn[] = [];
  for (const t of copy.turns) {
    const parts: Part[] = [];
    for (const p of t.parts) {
      if (p.type === "native") throw new ProtocolError("这个订阅来源不支持请求中的原生内容。", 400);
      if (p.type !== "result") { parts.push(p); continue; }
      if (calls.has(p.id) && results.get(p.id) === p) continue;
      parts.push({ type: "text", text: `[earlier tool output without a call]\n${resultText(p.content)}` });
      copy.dropped.push("tool_history:orphan_result_as_text");
    }
    if (parts.length) turns.push({ role: t.role, parts });
    const answers: Part[] = [];
    for (const p of parts) if (p.type === "call") {
      if (t.role !== "assistant") throw new ProtocolError("工具调用必须属于 assistant 历史。", 400);
      const found = results.get(p.id);
      if (found && !used.has(found)) { answers.push(found); used.add(found); }
      else { answers.push({ type: "result", id: p.id, name: p.name, content: "[no result]" }); copy.dropped.push("tool_history:missing_result_placeholder"); }
    }
    if (answers.length) turns.push({ role: "user", parts: answers });
  }
  copy.turns = turns;
  return copy;
}

export function subscriptionCacheKey(input: InboundRequest): string | undefined {
  if (typeof input.body.prompt_cache_key === "string") return input.body.prompt_cache_key;
  const user = input.protocol === "messages" ? input.body.metadata?.user_id : undefined;
  return typeof user === "string" && user ? createHash("sha256").update(user).digest("hex").slice(0, 32) : undefined;
}
