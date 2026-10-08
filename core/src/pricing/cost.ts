import prices from "./prices.json" with { type: "json" };
import type { Provider, Rates } from "../types.ts";

/**
 * Cost estimation. Every figure is an ESTIMATE of what the same traffic would
 * cost at the vendor's published pay-as-you-go price, never a bill: cache
 * detail is what the provider reported, and an unknown model is "unpriced",
 * not zero. Order: the user's own price for that model, then the built-in
 * table, otherwise null. Design after opencodex's usage/cost.ts (MIT): same
 * order of precedence, same four-rate shape. The legacy table was generated
 * from that metadata source; its values are not reverified official prices. scripts/build-prices.mjs now builds a separate
 * staged official table; it does not replace these runtime rates. See PROVENANCE.md.
 */

export type { Rates };

type Row = [number, number, number, number];
const TABLE = prices as unknown as { hostVendor: Record<string, string>; prices: Record<string, Record<string, Row>> };

/** Preset-level vendor keys for hosts the generated index leaves out. */
const HOST_ALIASES: Record<string, string> = {
  "api.openai.com": "openai",
  "api.moonshot.cn": "moonshot",
  "api.moonshot.ai": "moonshot",
  "open.bigmodel.cn": "zai",
  "api.minimaxi.com": "minimax-cn",
  "api.minimax.io": "minimax",
  "api.xiaomimimo.com": "xiaomi",
};

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** External ids must never resolve to properties inherited from Object.prototype. */
function ownValue<T>(values: Record<string, T> | undefined, key: string): T | undefined {
  return values && Object.hasOwn(values, key) ? values[key] : undefined;
}

/** The vendor key in the price table for a provider, from its address. */
export function vendorFor(baseUrl: string): string | undefined {
  const host = hostOf(baseUrl);
  return ownValue(HOST_ALIASES, host) ?? ownValue(TABLE.hostVendor, host);
}

function fromRow(row: Row): Rates {
  return { input: row[0], output: row[1], cacheRead: row[2], cacheWrite: row[3] };
}

/** Model ids as vendors and relays write them: `vendor/model`, `model[1m]`, `model:free`. */
function candidates(model: string): string[] {
  const out = new Set<string>([model]);
  const bare = model.replace(/\[[^\]]*\]$/, "").replace(/:(free|beta|thinking)$/i, "");
  out.add(bare);
  out.add(bare.toLowerCase());
  const slash = bare.indexOf("/");
  if (slash > 0) out.add(bare.slice(slash + 1));
  return [...out];
}

/** Which vendor makes a model, from the way its id starts. */
function originVendor(model: string): string | undefined {
  const m = model.replace(/^[^/]+\//, "").toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/^deepseek/, "deepseek"], [/^(gpt-|o\d|chatgpt|codex)/, "openai"], [/^claude/, "anthropic"], [/^gemini/, "google"],
    [/^grok/, "xai"], [/^(glm|zai)/, "zai"], [/^(kimi|moonshot)/, "moonshot"], [/^minimax/, "minimax"],
    [/^(mistral|codestral|devstral|magistral)/, "mistral"], [/^mimo/, "xiaomi"],
  ];
  return rules.find(([re]) => re.test(m))?.[1];
}

export type PriceSource = "user" | "legacy";
export interface Priced { rates: Rates; source: PriceSource }

/** The rates for one model on one provider, or undefined when nothing is known. */
export function ratesFor(provider: Pick<Provider, "baseUrl" | "prices">, model: string): Priced | undefined {
  for (const id of candidates(model)) {
    const own = ownValue(provider.prices, id);
    if (own) return { rates: own, source: "user" };
  }
  const vendor = vendorFor(provider.baseUrl);
  const table = vendor ? ownValue(TABLE.prices, vendor) : undefined;
  if (table) for (const id of candidates(model)) {
    const row = ownValue(table, id);
    if (row) return { rates: fromRow(row), source: "legacy" };
  }
  // A relay re-sells another vendor's model under its own id: price it as the vendor that makes it.
  const origin = originVendor(model);
  const originTable = origin ? ownValue(TABLE.prices, origin) : undefined;
  if (originTable) for (const id of candidates(model)) {
    const row = ownValue(originTable, id);
    if (row) return { rates: fromRow(row), source: "legacy" };
  }
  // Otherwise look across vendors for an exact id.
  const matches = new Set<string>();
  const found: Row[] = [];
  for (const [v, models] of Object.entries(TABLE.prices)) {
    if (v === "openrouter" || v === "vercel-ai-gateway" || v === "zenmux" || v === "kilo" || v === "nanogpt" || v === "huggingface") continue;
    for (const id of candidates(model)) {
      const row = ownValue(models, id);
      if (row) { found.push(row); matches.add(v); }
    }
  }
  // Only trust an unambiguous match (the same model priced the same by every vendor that has it).
  if (found.length && found.every(r => r.join() === found[0]!.join())) return { rates: fromRow(found[0]!), source: "legacy" };
  return undefined;
}

export interface TokenUsage {
  /** Prompt tokens, cached ones included (how providers report them). */
  input: number;
  output: number;
  /** Of the prompt, how many were served from cache. */
  cached?: number;
}

/** USD for one call. Cache reads are billed at the cache rate, the rest of the prompt at the input rate. */
export function costOf(rates: Rates, usage: TokenUsage): number {
  const cached = Math.min(usage.cached ?? 0, usage.input);
  const fresh = usage.input - cached;
  return (fresh * rates.input + cached * rates.cacheRead + usage.output * rates.output) / 1_000_000;
}

export const PRICE_SOURCES = { generatedFrom: "opencodex model-metadata.source.json", status: "legacy-unverified", officialTable: "official-prices.json", officialRuntimeEnabled: false } as const;
