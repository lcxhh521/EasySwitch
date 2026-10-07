/** Conservative, local-only name matching. A suggestion never changes routing until explicitly accepted. */
import { createHash } from "node:crypto";
import type { Pool } from "./types.ts";

export interface PoolCandidateModel { providerId: string; providerName: string; model: string }
export interface PoolSuggestion {
  id: string;
  dismissKey: string;
  model: string;
  members: Array<PoolCandidateModel & { modelId: string }>;
}
/** Remove only a known publisher prefix when the remaining family agrees with it. */
export const POOL_MODEL_PREFIXES = Object.freeze([
  { publisher: "deepseek", family: /^deepseek-/ },
  { publisher: "openai", family: /^(?:gpt-|chatgpt-|o[1-9](?:-|$))/ },
  { publisher: "anthropic", family: /^claude-/ },
  { publisher: "google", family: /^gemini-/ },
  { publisher: "qwen", family: /^qwen/ },
  { publisher: "mistralai", family: /^(?:mistral|mixtral|codestral|devstral|ministral)/ },
  { publisher: "meta-llama", family: /^llama/ },
].map(rule => Object.freeze(rule)));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function normalizePoolModel(model: unknown): string | undefined {
  if (typeof model !== "string") return undefined;
  const name = model.trim().toLowerCase();
  if (!name || name.length > 256 || /[^\x21-\x7e]/.test(name)) return undefined;
  const at = name.indexOf("/");
  if (at < 0) return name;
  const publisher = name.slice(0, at), rest = name.slice(at + 1);
  const rule = POOL_MODEL_PREFIXES.find(r => r.publisher === publisher);
  return rule && !rest.includes("/") && rule.family.test(rest) ? rest : name;
}

/** Dismissal is per normalized model, so adding another supplier does not nag after “不用”. */
export function poolSuggestionDismissKey(model: string): string {
  return hash(`pool-model-v1:${model}`);
}

export function buildPoolSuggestions(input: { models: readonly PoolCandidateModel[]; pools: readonly Pick<Pool, "members">[]; dismissed?: readonly string[] }): PoolSuggestion[] {
  const dismissed = new Set(input.dismissed ?? []);
  const taken = new Set(input.pools.flatMap(pool => pool.members));
  const pooledModels = new Set(input.pools.flatMap(pool => pool.members).map(member => normalizePoolModel(member.slice(member.indexOf("/") + 1))));
  const groups = new Map<string, Map<string, PoolCandidateModel>>();
  // Prefer the simple canonical spelling if a provider lists aliases for the same model.
  const candidates = [...input.models].sort((a, b) => a.model.length - b.model.length || a.model.localeCompare(b.model) || a.providerId.localeCompare(b.providerId));
  for (const row of candidates) {
    if (row.providerId === "pool" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.providerId)) continue;
    const model = normalizePoolModel(row.model);
    if (!model || pooledModels.has(model) || taken.has(`${row.providerId}/${row.model}`) || dismissed.has(poolSuggestionDismissKey(model))) continue;
    const members = groups.get(model) ?? new Map<string, PoolCandidateModel>();
    if (!members.has(row.providerId)) members.set(row.providerId, { providerId: row.providerId, providerName: row.providerName, model: row.model });
    groups.set(model, members);
  }
  return [...groups].filter(([, members]) => members.size >= 2).map(([model, providers]) => {
    const members = [...providers.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)).map(row => ({ ...row, modelId: `${row.providerId}/${row.model}` }));
    return { id: `pool-suggestion-${hash(JSON.stringify([1, model, members.map(m => m.modelId)])).slice(0, 24)}`, dismissKey: poolSuggestionDismissKey(model), model, members };
  }).sort((a, b) => a.model.localeCompare(b.model));
}
