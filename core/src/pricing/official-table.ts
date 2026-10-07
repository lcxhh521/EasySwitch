import { createHash } from "node:crypto";

export const RATE_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;
export type RateKey = typeof RATE_KEYS[number];
export type FactRates = Record<RateKey, number | null>;
export interface PriceSourceLink { url: string; title: string; checkedAt: string }
export interface OfficialPriceFact {
  id: string; vendor: string; model: string; hosts: string[];
  currency: "USD" | "CNY"; unit: "per_1m_tokens"; mode: "standard" | "batch" | "flex";
  region: string; modality: "text";
  context: { minInputTokensExclusive?: number; maxInputTokensInclusive?: number };
  applicability: "standard-text" | "conditional" | "reference-only";
  rates: FactRates; unknownReasons: Partial<Record<RateKey, string>>;
  conditions: string[]; sources: PriceSourceLink[];
  cacheWriteTreatment: "included-in-input" | "separate" | "unknown";
  cacheWriteTtl?: "5m" | "30m" | "1h";
  period?: { kind: "peak" | "off-peak"; timezone: "UTC"; description: string };
  validThrough?: string;
  additionalCharges?: { kind: "cache-storage"; currency: "USD"; unit: "per_1m_token_hours"; rate: number; condition: string }[];
}
export interface OfficialPriceFacts {
  schemaVersion: 1; checkedAt: string; entries: OfficialPriceFact[];
  coverageGaps: { vendor: string; model: string; reason: string; sources: PriceSourceLink[] }[];
}
export interface OfficialPriceTable extends OfficialPriceFacts {
  generatedFrom: "official-facts.json";
  /** Exact input-byte digest, never presented as downloaded vendor-page hashes. */
  factsSha256: string;
}
const vendors: Record<string, { hosts: string[]; sources: string[] }> = {
  openai: { hosts: ["api.openai.com"], sources: ["openai.com", "developers.openai.com", "platform.openai.com"] },
  anthropic: { hosts: ["api.anthropic.com"], sources: ["anthropic.com", "www.anthropic.com", "docs.anthropic.com", "platform.claude.com"] },
  google: { hosts: ["generativelanguage.googleapis.com"], sources: ["ai.google.dev", "cloud.google.com", "docs.cloud.google.com"] },
  deepseek: { hosts: ["api.deepseek.com"], sources: ["api-docs.deepseek.com"] },
};
function invalid(): never { throw new Error("Official pricing facts are invalid or unsupported; no table was generated."); }
function object(value: unknown, allowed: readonly string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) invalid();
  return value as Record<string, any>;
}
function str(value: unknown, max = 2048): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value); }
function date(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e9; }
function sourceLinks(value: unknown, vendor: string, checkedAt: string): void {
  if (!Array.isArray(value) || !value.length || value.length > 20) invalid();
  for (const item of value) {
    const link = object(item, ["url", "title", "checkedAt"]);
    if (!str(link.url) || !str(link.title, 300) || !date(link.checkedAt) || link.checkedAt > checkedAt) invalid();
    let url: URL; try { url = new URL(link.url); } catch { invalid(); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || !vendors[vendor]?.sources.includes(url.hostname)) invalid();
  }
}
export function validateOfficialFacts(value: unknown): OfficialPriceFacts {
  const data = object(value, ["schemaVersion", "checkedAt", "entries", "coverageGaps"]);
  if (data.schemaVersion !== 1 || !date(data.checkedAt) || !Array.isArray(data.entries) || data.entries.length > 10000 || !Array.isArray(data.coverageGaps) || data.coverageGaps.length > 10000) invalid();
  const ids = new Set<string>();
  for (const item of data.entries) {
    const row = object(item, ["id", "vendor", "model", "hosts", "currency", "unit", "mode", "region", "modality", "context", "applicability", "rates", "unknownReasons", "conditions", "sources", "cacheWriteTreatment", "cacheWriteTtl", "period", "validThrough", "additionalCharges"]);
    if (!str(row.id, 200) || ids.has(row.id) || typeof row.vendor !== "string" || !Object.hasOwn(vendors, row.vendor) || !str(row.model, 200) || !/^[a-zA-Z0-9._:/-]+$/.test(row.model) || !str(row.region, 200)) invalid();
    ids.add(row.id);
    if (!Array.isArray(row.hosts) || !row.hosts.length || row.hosts.length > 20 || row.hosts.some((h: unknown) => typeof h !== "string" || !vendors[row.vendor]!.hosts.includes(h)) || new Set(row.hosts).size !== row.hosts.length) invalid();
    if (!["USD", "CNY"].includes(row.currency) || row.unit !== "per_1m_tokens" || !["standard", "batch", "flex"].includes(row.mode) || row.modality !== "text" || !["standard-text", "conditional", "reference-only"].includes(row.applicability)) invalid();
    const context = object(row.context, ["minInputTokensExclusive", "maxInputTokensInclusive"]);
    for (const n of Object.values(context)) if (!Number.isSafeInteger(n) || (n as number) < 0) invalid();
    if (context.maxInputTokensInclusive !== undefined && context.maxInputTokensInclusive <= (context.minInputTokensExclusive ?? -1)) invalid();
    const rates = object(row.rates, RATE_KEYS), reasons = object(row.unknownReasons, RATE_KEYS);
    for (const key of RATE_KEYS) {
      if (rates[key] === null) { if (!str(reasons[key])) invalid(); }
      else if (!number(rates[key]) || reasons[key] !== undefined) invalid();
    }
    if (!Array.isArray(row.conditions) || row.conditions.length > 50 || row.conditions.some((s: unknown) => !str(s))) invalid();
    sourceLinks(row.sources, row.vendor, data.checkedAt);
    if (!["included-in-input", "separate", "unknown"].includes(row.cacheWriteTreatment)) invalid();
    if (row.cacheWriteTreatment === "included-in-input" && row.rates.cacheWrite !== null) invalid();
    if (row.cacheWriteTtl !== undefined && !["5m", "30m", "1h"].includes(row.cacheWriteTtl)) invalid();
    if (row.validThrough !== undefined && !date(row.validThrough)) invalid();
    if (row.period !== undefined) { const p = object(row.period, ["kind", "timezone", "description"]); if (!["peak", "off-peak"].includes(p.kind) || p.timezone !== "UTC" || !str(p.description)) invalid(); }
    if (row.additionalCharges !== undefined) {
      if (!Array.isArray(row.additionalCharges) || row.additionalCharges.length > 20) invalid();
      for (const item of row.additionalCharges) { const c = object(item, ["kind", "currency", "unit", "rate", "condition"]); if (c.kind !== "cache-storage" || c.currency !== "USD" || c.unit !== "per_1m_token_hours" || !number(c.rate) || !str(c.condition)) invalid(); }
    }
    // Current metering cannot resolve TTL, regional, calendar or storage conditions.
    if (row.applicability === "standard-text" && (row.currency !== "USD" || row.mode !== "standard" || row.period || row.validThrough || row.additionalCharges?.length || row.cacheWriteTreatment !== "included-in-input" || row.cacheWriteTtl)) invalid();
  }
  for (const item of data.coverageGaps) {
    const row = object(item, ["vendor", "model", "reason", "sources"]);
    if (typeof row.vendor !== "string" || !Object.hasOwn(vendors, row.vendor) || !str(row.model, 200) || !str(row.reason)) invalid();
    sourceLinks(row.sources, row.vendor, data.checkedAt);
  }
  const entries = data.entries as OfficialPriceFact[];
  const usable = entries.filter(e => e.applicability === "standard-text");
  for (let i = 0; i < usable.length; i++) for (const b of usable.slice(i + 1)) {
    const a = usable[i]!;
    if (a.model === b.model && a.hosts.some(h => b.hosts.includes(h)) && Math.max(a.context.minInputTokensExclusive ?? -1, b.context.minInputTokensExclusive ?? -1) < Math.min(a.context.maxInputTokensInclusive ?? Infinity, b.context.maxInputTokensInclusive ?? Infinity)) invalid();
  }
  return structuredClone(data) as OfficialPriceFacts;
}
function canonical(value: any): any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
/** Deterministic compilation. Reads no native files and performs no network requests. */
export function compileOfficialPrices(raw: string): string {
  if (Buffer.byteLength(raw) > 8 * 1024 * 1024) invalid();
  let value: unknown; try { value = JSON.parse(raw); } catch { invalid(); }
  const data = validateOfficialFacts(value);
  data.entries.sort((a, b) => a.id.localeCompare(b.id, "en"));
  for (const row of data.entries) { row.hosts.sort(); row.sources.sort((a, b) => a.url.localeCompare(b.url, "en")); }
  const table: OfficialPriceTable = { ...data, generatedFrom: "official-facts.json", factsSha256: createHash("sha256").update(raw).digest("hex") };
  return `${JSON.stringify(canonical(table), null, 2)}\n`;
}
