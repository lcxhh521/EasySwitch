import type { OfficialPriceTable, OfficialPriceFact } from "./official-table.ts";

export interface OfficialPriceRequest {
  baseUrl: string;
  /** Exact vendor model ID; aliases and reseller names are never guessed. */
  model: string;
  usage: { input: number; output: number; cached?: number; cacheWrite?: number };
  /** Caller must establish these from trusted request/response metadata, not just the model ID. */
  scope?: { mode: "standard"; modality: "text"; region: string };
}
export interface OfficialEstimate {
  /** Complete for the selected text-token categories only, not tools/media/tax or the whole bill.
   * A future caller must separately establish whole-request cost coverage before using task comparisons. */
  complete: boolean;
  costUsd?: number;
  factId?: string;
  reason?: "unpriced" | "unverified_conditions" | "invalid_usage" | "partial_price";
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function host(url: string): string | undefined {
  try { const u = new URL(url); if (u.protocol === "https:" && !u.username && !u.password && !u.port && !u.search && !u.hash) return u.hostname; } catch { /* no address guessing */ }
  return undefined;
}
function inContext(row: OfficialPriceFact, input: number): boolean {
  return input > (row.context.minInputTokensExclusive ?? -1) && input <= (row.context.maxInputTokensInclusive ?? Infinity);
}
/** Staged pure estimator. Production logging still uses the explicitly legacy table. */
export function estimateOfficialPrice(table: OfficialPriceTable, request: OfficialPriceRequest): OfficialEstimate {
  const u = request.usage;
  if (!count(u.input) || !count(u.output) || (u.cached !== undefined && (!count(u.cached) || u.cached > u.input)) || (u.cacheWrite !== undefined && (!count(u.cacheWrite) || u.cacheWrite > u.input - (u.cached ?? 0)))) return { complete: false, reason: "invalid_usage" };
  const targetHost = host(request.baseUrl);
  const matches = table.entries.filter(r => r.model === request.model && r.hosts.includes(targetHost ?? ""));
  if (!matches.length) return { complete: false, reason: "unpriced" };
  // Conditions with missing observable evidence are retained in the facts, not flattened.
  const eligible = matches.filter(r => r.applicability === "standard-text" && r.currency === "USD" && r.unit === "per_1m_tokens" && r.mode === "standard" && r.modality === "text" && !r.period && !r.validThrough && !r.additionalCharges?.length && r.cacheWriteTreatment === "included-in-input" && !r.cacheWriteTtl && request.scope?.mode === r.mode && request.scope.modality === r.modality && request.scope.region === r.region && inContext(r, u.input));
  if (eligible.length !== 1) return { complete: false, reason: "unverified_conditions" };
  const row = eligible[0]!;
  // An omitted cache counter cannot prove which input category was billed.
  if (u.cached === undefined && u.input > 0 && row.rates.input !== row.rates.cacheRead) return { complete: false, factId: row.id, reason: "unverified_conditions" };
  const cached = u.cached ?? 0;
  const amounts = [[u.input - cached, row.rates.input], [cached, row.rates.cacheRead], [u.output, row.rates.output]] as const;
  let sum = 0, complete = true, knownTokens = 0;
  for (const [tokens, rate] of amounts) {
    if (!tokens) continue;
    if (rate === null) complete = false;
    else { sum += tokens * rate / 1_000_000; knownTokens += tokens; }
  }
  if (!Number.isFinite(sum)) return { complete: false, factId: row.id, reason: "invalid_usage" };
  return { complete, factId: row.id, ...(complete || knownTokens ? { costUsd: sum } : {}), ...(!complete ? { reason: "partial_price" as const } : {}) };
}
