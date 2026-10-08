import { createHash } from "node:crypto";
import legacyTable from "./prices.json" with { type: "json" };
import type { Priced } from "./cost.ts";
import type { Rates } from "../types.ts";

/**
 * Evidence of the existing log-time calculation only. This does not select a
 * tariff, establish upstream usage facts, or enable the staged official table.
 * Bump the estimator id if ratesFor/costOf semantics change, not for a table edit.
 */
export const CURRENT_ESTIMATOR = "ratesFor-costOf-v1" as const;

// Same contract as the offline migration report: UTF-8 JSON.stringify of the
// parsed bundled table, preserving JSON property order; no newline. This is
// neither the source file's byte hash nor a vendor webpage/invoice hash.
const legacyParsedTableSha256 = createHash("sha256").update(JSON.stringify(legacyTable), "utf8").digest("hex");

interface EvidenceLimits {
  schemaVersion: 1;
  basis: "log-time-config";
  tariffVerification: "not-established";
  wholeBillCoverage: "not-established";
}
interface EstimateEvidence {
  estimator: typeof CURRENT_ESTIMATOR;
  currency: "USD";
  /** Only estimator input presence; upstream parsers may already have filled 0. */
  cacheCounterAtEstimator: "present" | "omitted-assumed-zero";
  /** Null if the selected rate tuple is malformed; never hash invalid values as JSON null. */
  selectedRatesSha256: string | null;
}
export type UnpricedReason = "provider-unavailable" | "usage-unavailable" | "rates-unavailable";
export type PricingProvenance = EvidenceLimits & (
  | (EstimateEvidence & { source: "user" })
  | (EstimateEvidence & { source: "legacy"; legacyParsedTableSha256: string })
  | { estimator: "none"; source: "subscription" }
  | { estimator: "none"; source: "unpriced"; reason: UnpricedReason }
);

const limits = (): EvidenceLimits => ({
  schemaVersion: 1, basis: "log-time-config", tariffVerification: "not-established", wholeBillCoverage: "not-established",
});

/**
 * SHA-256 of UTF-8 JSON.stringify(["easyswitch-selected-rates-v1",
 * "USD-per-million-tokens", input, output, cacheRead, cacheWrite]), no newline.
 * Fixed tuple order ignores object insertion order and unrelated config. JSON
 * number serialization deliberately equates -0 and 0. cacheWrite identifies the
 * chosen four-rate definition; costOf v1 does not charge cache writes separately.
 * A digest is a change identifier, not encryption or a recoverable price snapshot.
 */
export function selectedRatesFingerprint(rates: Rates): string | null {
  const values = [rates.input, rates.output, rates.cacheRead, rates.cacheWrite];
  if (!values.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) return null;
  return createHash("sha256").update(JSON.stringify(["easyswitch-selected-rates-v1", "USD-per-million-tokens", ...values]), "utf8").digest("hex");
}

/** Use the exact ratesFor result used by costOf; never look up rates a second time. */
export function estimateProvenance(priced: Priced, cachedTokens: number | undefined): PricingProvenance {
  const evidence = {
    ...limits(), estimator: CURRENT_ESTIMATOR, currency: "USD" as const,
    cacheCounterAtEstimator: cachedTokens === undefined ? "omitted-assumed-zero" as const : "present" as const,
    selectedRatesSha256: selectedRatesFingerprint(priced.rates),
  };
  return priced.source === "user" ? { ...evidence, source: "user" } : { ...evidence, source: "legacy", legacyParsedTableSha256 };
}

export function subscriptionProvenance(): PricingProvenance {
  return { ...limits(), estimator: "none", source: "subscription" };
}

export function unpricedProvenance(reason: UnpricedReason): PricingProvenance {
  return { ...limits(), estimator: "none", source: "unpriced", reason };
}
