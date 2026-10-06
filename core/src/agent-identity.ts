import { AGENTS } from "./agents.ts";

/** Canonical routing identities; this does not authenticate a gateway session. */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const legacyAliases = new Map<string, string>();
for (const agent of AGENTS) {
  const alias = agent.id.replace(/[^a-z0-9]/g, "");
  // Do not guess if a future pair of catalog IDs collapses to the same old spelling.
  legacyAliases.set(alias, legacyAliases.has(alias) ? "chat" : agent.id);
}
const knownTokenIds = [...new Set([...AGENTS.map(a => a.id), ...legacyAliases.keys()])].sort((a, b) => b.length - a.length);
export function canonicalAgentId(id: string): string {
  return AGENTS.some(a => a.id === id) ? id : legacyAliases.get(id) ?? id;
}


export function agentFromAuth(header: string | string[] | undefined): string {
  const token = String(Array.isArray(header) ? header[0] : header ?? "").trim().replace(/^Bearer\s+/i, "");
  if (token.endsWith("-")) return "chat";
  // The oldest Claude token contains only a UUID, with no agent identity.
  if (new RegExp(`^es-session-${UUID}$`, "i").test(token)) return "chat";
  const generated = new RegExp(`^es-session-([a-z0-9]+(?:-[a-z0-9]+)*)-(?:${UUID}|[a-f0-9]{64})$`).exec(token)?.[1];
  if (generated) return canonicalAgentId(generated);
  // Also accept older compact IDs and short fixture/session suffixes. Longest first
  // distinguishes claude-desktop from claude, and qwen-code from an arbitrary qwen token.
  for (const id of knownTokenIds) if (token.startsWith(`es-session-${id}-`) && token.length > `es-session-${id}-`.length) return canonicalAgentId(id);
  const legacy = /^es-session-([a-z0-9]+)-.+$/.exec(token)?.[1];
  return legacy && !/^[0-9a-f]{8}$/.test(legacy) ? canonicalAgentId(legacy) : "chat";
}
