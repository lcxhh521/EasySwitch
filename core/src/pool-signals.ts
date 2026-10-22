import type { Store } from "./store.ts";
import type { Pool, Provider } from "./types.ts";
import type { SourceHealthSnapshot } from "./source-health.ts";
import { poolMemberStates, poolRestUntil, type PoolMemberState } from "./pools.ts";
import { exhaustedUntil, quotaOf, type QuotaState } from "./quota.ts";

/** Diagnostics only. No selection, turn consumption, checks, credentials or writes. */
interface WaitEvidence {
  state: "none" | "active" | "elapsed" | "unknown";
  until?: number;
}
interface QuotaEvidence {
  scope: "provider_id_record";
  // Legacy quota records cannot identify the current endpoint, account or key.
  identity: "unverified";
  state: "unknown" | "recorded" | "stale";
  // There is no audited TTL for a positive remaining-quota assertion.
  freshness: "unknown" | "stale";
  updatedAt?: number;
  windows: Array<{
    id: "primary" | "secondary";
    usedPercent?: number;
    vendorResetAt?: number;
    state: "unknown" | "recorded" | "stale";
    // recordLimitReached can retain old windows while updating the record time.
    observedAt: null;
  }>;
  wait: WaitEvidence & { basis: "vendor_reset" | "retry_marker" };
}
export interface PoolMemberSignals extends PoolMemberState {
  effect: "excluded" | "later" | "normal";
  generation: "unverified";
  failureWait: WaitEvidence & { scope: "provider_model_marker"; identity: "unverified"; observedAt: null };
  quota: QuotaEvidence;
  metadata: { scope: "models_endpoint"; state: "unknown" | "passed" | "failed" | "stale"; checkedAt?: number };
}
export interface PoolSignalSnapshot {
  capturedAt: number;
  strategy: Pool["strategy"];
  members: PoolMemberSignals[];
}

function timestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
}
function wait(until: number | undefined, now: number): WaitEvidence {
  if (until === undefined) return { state: "none" };
  if (!timestamp(until)) return { state: "unknown" };
  return { state: until > now ? "active" : "elapsed", until };
}
function quotaEvidence(record: QuotaState | undefined, now: number): QuotaEvidence {
  const updatedAt = timestamp(record?.updatedAt) && record.updatedAt <= now ? record.updatedAt : undefined;
  const waiting = { ...wait(record?.exhaustedUntil, now), basis: record?.exhaustionResetKnown === true ? "vendor_reset" as const : "retry_marker" as const };
  const windows: QuotaEvidence["windows"] = (record?.windows ?? []).filter(w => w.id === "primary" || w.id === "secondary").map(w => {
    const usedPercent = typeof w.usedPercent === "number" && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 ? w.usedPercent : undefined;
    const vendorResetAt = timestamp(w.resetAt) ? w.resetAt : undefined;
    return { id: w.id, observedAt: null, ...(usedPercent === undefined ? {} : { usedPercent }), ...(vendorResetAt === undefined ? {} : { vendorResetAt }),
      state: usedPercent === undefined ? "unknown" : vendorResetAt !== undefined && vendorResetAt <= now ? "stale" : "recorded" };
  });
  const stale = windows.length ? windows.every(w => w.state === "stale") && waiting.state !== "active" : waiting.state === "elapsed";
  const meaningful = windows.some(w => w.usedPercent !== undefined) || waiting.state === "active" || waiting.state === "elapsed";
  const state = updatedAt === undefined || !meaningful ? "unknown" : stale ? "stale" : "recorded";
  return { scope: "provider_id_record", identity: "unverified", state, freshness: state === "stale" ? "stale" : "unknown",
    ...(updatedAt === undefined ? {} : { updatedAt }), windows, wait: waiting };
}
function metadataEvidence(providerId: string, health: SourceHealthSnapshot | undefined, now: number): PoolMemberSignals["metadata"] {
  const checkedAt = health?.providerId === providerId && timestamp(health.checkedAt) && health.checkedAt <= now ? health.checkedAt : undefined;
  const state = checkedAt === undefined ? "unknown" : health?.reason === "stale" ? "stale"
    : health?.eligible && health.verified && health.status === "healthy" && health.reason === "verified_models" ? "passed"
    : health?.eligible && health.status === "unavailable" && health.reason === "consecutive_failures" ? "failed" : "unknown";
  return { scope: "models_endpoint", state, ...(checkedAt === undefined ? {} : { checkedAt }) };
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** A detached, frozen view of existing facts, not a forecast of the next request. */
export function poolSignalSnapshot(store: Store, pool: Pool, options: {
  now?: number;
  /** Read-only, current-configuration metadata snapshot. Never a probe callback. */
  healthOf?: (provider: Provider) => SourceHealthSnapshot;
} = {}): Readonly<PoolSignalSnapshot> {
  const now = options.now ?? Date.now();
  if (!timestamp(now)) throw new TypeError("Invalid pool snapshot time");
  const members = poolMemberStates(store, pool).map((configuration): PoolMemberSignals => {
    const { member } = configuration, providerId = member.slice(0, member.indexOf("/"));
    const provider = store.provider(providerId), rest = poolRestUntil(member);
    // Describe the existing rule exactly, including its late (not excluded) members.
    // Normalizing corrupt legacy timestamps here must not silently change routing.
    const later = (rest ?? 0) > now || (exhaustedUntil(providerId, now) ?? 0) > now;
    return { ...configuration, effect: !configuration.selectable ? "excluded" : later ? "later" : "normal", generation: "unverified",
      failureWait: { ...wait(rest, now), scope: "provider_model_marker", identity: "unverified", observedAt: null },
      quota: quotaEvidence(quotaOf(providerId), now), metadata: metadataEvidence(providerId, provider ? options.healthOf?.(provider) : undefined, now) };
  });
  return freeze({ capturedAt: now, strategy: pool.strategy, members });
}
