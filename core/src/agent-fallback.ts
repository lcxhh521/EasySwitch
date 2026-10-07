export type AgentFallbackReason = "source_unavailable" | "quota_exhausted";
export interface AgentFallbackChange { fromModel: string; toModel: string; reason: AgentFallbackReason; at: string }
export interface AgentFallbackDecision { model: string | undefined; change?: AgentFallbackChange }

/**
 * Select once before sending a request. This function never retries or replays
 * requests, changes a binding, or changes a pool's own member selection.
 * The caller resolves aliases/defaults first and records change with its own
 * authenticated session/task identity. An absent health fact is not a failure.
 */
export function resolveAgentFallback(input: {
  requestedModel: string | undefined;
  fallbackModel?: string;
  /** Must reject disabled, missing, budget-blocked or otherwise unusable models. */
  resolveModel: (model: string) => { providerId: string } | undefined;
  healthOf: (providerId: string) => { status: "healthy" | "unavailable" | "unknown" } | undefined;
  exhaustedUntil?: (providerId: string) => number | undefined;
  responseStarted?: boolean;
  now?: number;
}): AgentFallbackDecision {
  const model = input.requestedModel, backup = input.fallbackModel;
  const unchanged: AgentFallbackDecision = { model };
  if (input.responseStarted || !model || !backup || model === backup || model.startsWith("pool/") || backup.startsWith("pool/")) return unchanged;
  const now = input.now ?? Date.now();
  if (!Number.isFinite(new Date(now).getTime())) return unchanged;
  const primary = input.resolveModel(model), fallback = input.resolveModel(backup);
  if (!primary || !fallback) return unchanged;
  const exhausted = (id: string) => { const until = input.exhaustedUntil?.(id); return typeof until === "number" && Number.isFinite(until) && until > now; };
  const reason = exhausted(primary.providerId) ? "quota_exhausted" : input.healthOf(primary.providerId)?.status === "unavailable" ? "source_unavailable" : undefined;
  if (!reason || exhausted(fallback.providerId) || input.healthOf(fallback.providerId)?.status === "unavailable") return unchanged;
  return { model: backup, change: { fromModel: model, toModel: backup, reason, at: new Date(now).toISOString() } };
}
