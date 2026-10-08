/** Offline migration research only. Never imported by logging, budgets or task ranking. */
import { createHash } from "node:crypto";
import legacyTable from "./prices.json" with { type: "json" };
import { costOf, ratesFor, PRICE_SOURCES } from "./cost.ts";
import { estimateOfficialPrice, type OfficialPriceRequest } from "./official-estimate.ts";
import { compileOfficialPrices, type OfficialPriceTable } from "./official-table.ts";
import type { Rates } from "../types.ts";

export interface MigrationCase extends OfficialPriceRequest {
  id: string;
  billing: "usage" | "subscription";
  userRates?: Rates;
}
export interface MigrationFixture { schemaVersion: 1; dataKind: "synthetic"; cases: MigrationCase[] }
type Exclusion = "subscription" | "invalid_usage" | "user_override_preserved" | "legacy_unpriced" | "legacy_lookup_failed" | "incompatible_currency" | "staged_partial" | "staged_unknown";
interface CaseResult {
  id: string;
  model: string;
  baseline: {
    status: "legacy-reference" | "user-estimate" | "unknown" | "subscription";
    costUsd?: number;
    reason?: "legacy_lookup_failed";
    /** Existing calculation behavior, not evidence of a complete bill. */
    cachedDefaultedToZero: boolean;
  };
  staged: {
    status: "selected-text-complete" | "partial" | "unknown" | "subscription";
    costUsd?: number;
    factId?: string;
    reason?: string;
  };
  comparison: { status: "comparable-selected-text"; deltaUsd: number } | { status: "excluded"; reason: Exclusion };
}
function invalid(): never { throw new Error("Expected a supported, explicitly synthetic pricing fixture; no report was produced."); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x20\x7f]/.test(value); }
function numeric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }

/** Narrow synthetic schema without request/account fields or implicit source/scope defaults.
 * The synthetic marker is a caller assertion, not a guarantee that strings contain no secrets.
 */
export function parseMigrationFixture(raw: string): MigrationFixture {
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) invalid();
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { invalid(); }
  const fixture = object(parsed, ["schemaVersion", "dataKind", "cases"]);
  if (fixture.schemaVersion !== 1 || fixture.dataKind !== "synthetic" || !Array.isArray(fixture.cases) || fixture.cases.length > 5000) invalid();
  const ids = new Set<string>();
  for (const item of fixture.cases) {
    const row = object(item, ["id", "baseUrl", "model", "billing", "usage", "scope", "userRates"]);
    if (!text(row.id) || !/^[a-zA-Z0-9._-]+$/.test(row.id) || ids.has(row.id) || !text(row.model) || !/^[a-zA-Z0-9._:/[\]-]+$/.test(row.model)) invalid();
    ids.add(row.id);
    if (typeof row.baseUrl !== "string" || row.baseUrl.length > 2048 || /[\x00-\x20\x7f]/.test(row.baseUrl)) invalid();
    let url: URL; try { url = new URL(row.baseUrl); } catch { invalid(); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
    if (row.billing !== "usage" && row.billing !== "subscription") invalid();
    const usage = object(row.usage, ["input", "output", "cached", "cacheWrite"]);
    // Negative/fractional/overflowing counters are intentional invalid-usage test cases.
    if (!numeric(usage.input) || !numeric(usage.output) || Object.values(usage).some(value => !numeric(value))) invalid();
    if (row.scope !== undefined) {
      const scope = object(row.scope, ["mode", "modality", "region"]);
      if (scope.mode !== "standard" || scope.modality !== "text" || !text(scope.region)) invalid();
    }
    if (row.userRates !== undefined) {
      const rates = object(row.userRates, ["input", "output", "cacheRead", "cacheWrite"]);
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) if (!numeric(rates[key]) || rates[key] < 0 || rates[key] > 1e9) invalid();
    }
  }
  return fixture as unknown as MigrationFixture;
}

/** Exact-host candidates explain currency exclusions; they never select a tariff. */
function candidateCurrencies(table: OfficialPriceTable, row: MigrationCase): string[] {
  const url = new URL(row.baseUrl);
  if (url.protocol !== "https:" || url.port) return [];
  return [...new Set(table.entries.filter(fact => fact.model === row.model && fact.hosts.includes(url.hostname)).map(fact => fact.currency))].sort();
}
function compareCase(table: OfficialPriceTable, row: MigrationCase): CaseResult {
  const result: CaseResult = {
    id: row.id, model: row.model,
    baseline: { status: "unknown", cachedDefaultedToZero: false },
    staged: { status: "unknown" },
    comparison: { status: "excluded", reason: "staged_unknown" },
  };
  if (row.billing === "subscription") {
    result.baseline.status = result.staged.status = "subscription";
    result.comparison = { status: "excluded", reason: "subscription" };
    return result;
  }
  const estimate = estimateOfficialPrice(table, row);
  result.staged = {
    status: estimate.complete ? "selected-text-complete" : estimate.reason === "partial_price" ? "partial" : "unknown",
    ...(estimate.costUsd !== undefined ? { costUsd: estimate.costUsd } : {}),
    ...(estimate.factId ? { factId: estimate.factId } : {}),
    ...(estimate.reason ? { reason: estimate.reason } : {}),
  };
  if (estimate.reason === "invalid_usage") {
    result.comparison = { status: "excluded", reason: "invalid_usage" };
    return result;
  }
  try {
    const price = ratesFor({ baseUrl: row.baseUrl, ...(row.userRates ? { prices: { [row.model]: row.userRates } } : {}) }, row.model);
    if (price) {
      const amount = costOf(price.rates, row.usage);
      if (Number.isFinite(amount) && amount >= 0) result.baseline = {
        status: price.source === "user" ? "user-estimate" : "legacy-reference", costUsd: amount,
        cachedDefaultedToZero: row.usage.input > 0 && row.usage.cached === undefined,
      };
      else result.baseline.reason = "legacy_lookup_failed";
    }
  } catch {
    // Keep unexpected baseline failures visible instead of aborting the report
    // or filling a gap with a guessed rate. Normal missing IDs remain unpriced.
    result.baseline.reason = "legacy_lookup_failed";
  }
  const currencies = candidateCurrencies(table, row);
  const reason: Exclusion | undefined = row.userRates ? "user_override_preserved"
    : result.baseline.reason === "legacy_lookup_failed" ? "legacy_lookup_failed"
    : result.baseline.costUsd === undefined ? "legacy_unpriced"
    : currencies.length > 0 && !currencies.includes("USD") ? "incompatible_currency"
    : !estimate.complete ? estimate.reason === "partial_price" ? "staged_partial" : "staged_unknown"
    : undefined;
  result.comparison = reason ? { status: "excluded", reason }
    : { status: "comparable-selected-text", deltaUsd: estimate.costUsd! - result.baseline.costUsd! };
  return result;
}

/** Pure comparison of supplied bytes; verifies the staged artifact before calculating anything.
 * The baseline uses exactly the bundled runtime lookup/calculator, never a reconstructed lookup.
 */
export function pricingMigrationReport(fixtureRaw: string, factsRaw: string, tableRaw: string) {
  const fixture = parseMigrationFixture(fixtureRaw);
  if (compileOfficialPrices(factsRaw) !== tableRaw) throw new Error("The staged pricing table does not match the supplied facts bytes.");
  const table = JSON.parse(tableRaw) as OfficialPriceTable;
  const cases = fixture.cases.map(row => compareCase(table, row));
  const comparable = cases.filter(row => row.comparison.status === "comparable-selected-text");
  const partialAmounts = cases.filter(row => row.staged.status === "partial" && row.staged.costUsd !== undefined);
  const baselineCounts = { legacyReference: 0, userOverride: 0, unknown: 0, subscription: 0 };
  const stagedCounts = { selectedTextComplete: 0, partial: 0, unknown: 0, subscription: 0 };
  const exclusions: Record<Exclusion, number> = { subscription: 0, invalid_usage: 0, user_override_preserved: 0, legacy_unpriced: 0, legacy_lookup_failed: 0, incompatible_currency: 0, staged_partial: 0, staged_unknown: 0 };
  for (const row of cases) {
    baselineCounts[row.baseline.status === "legacy-reference" ? "legacyReference" : row.baseline.status === "user-estimate" ? "userOverride" : row.baseline.status]++;
    stagedCounts[row.staged.status === "selected-text-complete" ? "selectedTextComplete" : row.staged.status]++;
    if (row.comparison.status === "excluded") exclusions[row.comparison.reason]++;
  }
  const legacyReferenceUsd = comparable.length ? comparable.reduce((sum, row) => sum + row.baseline.costUsd!, 0) : null;
  const stagedSelectedTextUsd = comparable.length ? comparable.reduce((sum, row) => sum + row.staged.costUsd!, 0) : null;
  return {
    schemaVersion: 1,
    dataKind: "synthetic",
    scope: "selected-text-tokens-only",
    wholeBillCoverage: "not-established",
    notes: [
      "Synthetic cases demonstrate migration behavior, not real traffic coverage or supplier bills.",
      "Official conditions are assertions in these fixtures, not observed production metadata.",
      "Legacy USD amounts retain the runtime's unverified reference-price assumptions; they are not billing truth.",
      "User overrides remain separate and are excluded from official-versus-legacy deltas.",
      "Partial amounts are only known selected text-token charges; unknown amounts are never filled with zero.",
      "No whole-request, tools, media, tax, contract, budget or task-ranking completeness is established.",
    ],
    provenance: {
      fixtureSha256: createHash("sha256").update(fixtureRaw).digest("hex"),
      official: { generatedFrom: table.generatedFrom, factsSha256: table.factsSha256, checkedAt: table.checkedAt },
      legacy: {
        ...PRICE_SOURCES, declaredCurrency: "USD",
        parsedTableSha256: createHash("sha256").update(JSON.stringify(legacyTable)).digest("hex"),
        digestEncoding: "UTF-8 JSON.stringify of bundled parsed prices.json",
        modelRows: Object.values(legacyTable.prices).reduce((sum, models) => sum + Object.keys(models).length, 0),
      },
    },
    tableCoverage: {
      factRows: table.entries.length,
      exactVendorModels: new Set(table.entries.map(row => `${row.vendor}/${row.model}`)).size,
      standardTextFactRows: table.entries.filter(row => row.applicability === "standard-text").length,
      deferredFactRows: table.entries.filter(row => row.applicability !== "standard-text").length,
    },
    summary: {
      cases: cases.length, baseline: baselineCounts, staged: stagedCounts, exclusions,
      comparableSelectedText: { cases: comparable.length, currency: "USD", legacyReferenceUsd, stagedSelectedTextUsd, deltaUsd: legacyReferenceUsd !== null && stagedSelectedTextUsd !== null ? stagedSelectedTextUsd - legacyReferenceUsd : null },
      partialSelectedText: { casesWithKnownAmount: partialAmounts.length, currency: "USD", knownAmountUsd: partialAmounts.length ? partialAmounts.reduce((sum, row) => sum + row.staged.costUsd!, 0) : null },
    },
    cases,
  };
}
