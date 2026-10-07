import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

type RateKey = "input" | "output" | "cacheRead" | "cacheWrite";
type Source = { url: string; title: string; checkedAt: string };
type Fact = {
  id: string; vendor: string; model: string; hosts: string[];
  currency: string; unit: string; mode: string; region: string; modality: string;
  context: { minInputTokensExclusive?: number; maxInputTokensInclusive?: number };
  applicability: string; rates: Record<RateKey, number | null>;
  unknownReasons: Partial<Record<RateKey, string>>;
  conditions: string[]; sources: Source[];
  cacheWriteTreatment: string; cacheWriteTtl?: string;
  period?: { kind: string; timezone: string; description: string };
  additionalCharges?: { kind: string; currency: string; unit: string; rate: number; condition: string }[];
};
type Manifest = {
  schemaVersion: number; checkedAt: string; entries: Fact[];
  coverageGaps: { vendor: string; model: string; reason: string; sources: Source[] }[];
};
const facts = JSON.parse(readFileSync(new URL("../src/pricing/official-facts.json", import.meta.url), "utf8")) as Manifest;
const fields: RateKey[] = ["input", "output", "cacheRead", "cacheWrite"];
const sourceHosts: Record<string, string> = {
  openai: "developers.openai.com", anthropic: "platform.claude.com",
  google: "ai.google.dev", deepseek: "api-docs.deepseek.com",
};
const apiHosts: Record<string, string> = {
  openai: "api.openai.com", anthropic: "api.anthropic.com",
  google: "generativelanguage.googleapis.com", deepseek: "api.deepseek.com",
};
function byId(id: string): Fact {
  const row = facts.entries.find(entry => entry.id === id);
  assert.ok(row, `missing fixture ${id}`);
  return row;
}
function sourceIsOfficial(source: Source, vendor: string): void {
  const url = new URL(source.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, sourceHosts[vendor]);
  assert.equal(url.username, "");
  assert.equal(url.password, "");
  assert.equal(url.search, "", "use canonical documentation URLs");
  assert.ok(source.title.trim());
  assert.equal(source.checkedAt, facts.checkedAt);
}

test("official facts cover exactly the independently selected first ten IDs", () => {
  assert.equal(facts.schemaVersion, 1);
  assert.equal(facts.checkedAt, "2026-10-07");
  assert.equal(facts.entries.length, 17);
  assert.deepEqual([...new Set(facts.entries.map(row => `${row.vendor}/${row.model}`))].sort(), [
    "anthropic/claude-haiku-4-5", "anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6",
    "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro", "google/gemini-2.5-flash",
    "google/gemini-2.5-pro", "openai/gpt-4o", "openai/gpt-4o-mini", "openai/gpt-5.4",
  ]);
  assert.equal(new Set(facts.entries.map(row => row.id)).size, facts.entries.length);
});

test("every tariff records first-party sources, exact hosts, currency, unit and conditions", () => {
  for (const row of facts.entries) {
    assert.equal(row.id.startsWith(`${row.vendor}/${row.model}/`), true);
    assert.deepEqual(row.hosts, [apiHosts[row.vendor]], row.id);
    assert.equal(row.currency, "USD");
    assert.equal(row.unit, "per_1m_tokens");
    assert.equal(row.mode, "standard");
    assert.equal(row.modality, "text");
    assert.ok(row.region.trim());
    assert.ok(row.conditions.length > 0);
    assert.ok(row.conditions.every(condition => condition.trim()));
    assert.ok(row.sources.length > 0);
    for (const source of row.sources) sourceIsOfficial(source, row.vendor);
  }
});

test("unknown rates stay null with reasons, and cache writes are not filled with fake zeros", () => {
  for (const row of facts.entries) {
    assert.deepEqual(Object.keys(row.rates).sort(), [...fields].sort());
    for (const field of fields) {
      const value = row.rates[field];
      if (value === null) assert.ok(row.unknownReasons[field]?.trim(), `${row.id} ${field}`);
      else {
        assert.equal(typeof value, "number");
        assert.ok(Number.isFinite(value) && value > 0, `${row.id} ${field}`);
        assert.equal(row.unknownReasons[field], undefined);
      }
    }
    assert.notEqual(row.rates.cacheWrite, 0);
    if (row.cacheWriteTreatment === "included-in-input") {
      assert.equal(row.vendor, "openai");
      assert.equal(row.rates.cacheWrite, null);
      assert.match(row.unknownReasons.cacheWrite!, /ordinary uncached input/);
      assert.ok(row.sources.some(source => source.url.endsWith("/guides/prompt-caching")));
    } else if (row.cacheWriteTreatment === "separate") {
      assert.equal(row.vendor, "anthropic");
      assert.ok(row.rates.cacheWrite! > row.rates.input!);
      assert.ok(["5m", "1h"].includes(row.cacheWriteTtl!));
    } else {
      assert.equal(row.cacheWriteTreatment, "unknown");
      assert.equal(row.rates.cacheWrite, null);
      assert.equal(row.applicability, "conditional");
    }
  }
});

test("only the two flat OpenAI standard text rows can be promoted to auto-estimation", () => {
  const eligible = facts.entries.filter(row => row.applicability === "standard-text");
  assert.deepEqual(eligible.map(row => row.id).sort(), [
    "openai/gpt-4o-mini/standard-text", "openai/gpt-4o/standard-text",
  ]);
  for (const row of eligible) {
    assert.equal(row.region, "non-regional");
    assert.equal(row.cacheWriteTreatment, "included-in-input");
    assert.equal(row.cacheWriteTtl, undefined);
    assert.equal(row.period, undefined);
    assert.equal(row.additionalCharges, undefined);
  }
  assert.deepEqual(byId("openai/gpt-4o/standard-text").rates, { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: null });
  assert.deepEqual(byId("openai/gpt-4o-mini/standard-text").rates, { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: null });
});

test("GPT-5.4 retains the full-session 272k condition and unresolved long cache price", () => {
  const short = byId("openai/gpt-5.4/standard-short");
  const long = byId("openai/gpt-5.4/standard-long");
  assert.equal(short.context.maxInputTokensInclusive, 272000);
  assert.equal(long.context.minInputTokensExclusive, 272000);
  assert.deepEqual(short.rates, { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: null });
  assert.deepEqual(long.rates, { input: 5, output: 22.5, cacheRead: null, cacheWrite: null });
  for (const row of [short, long]) {
    assert.equal(row.applicability, "conditional");
    assert.match(row.conditions.join(" "), /full session/);
    assert.match(row.conditions.join(" "), /10% uplift/);
  }
});

test("Anthropic cache TTLs stay distinct and unknown workspace geography is not global", () => {
  const expected: [string, number, number, number, number, number][] = [
    ["claude-sonnet-4-6", 3, 15, 0.3, 3.75, 6],
    ["claude-opus-4-6", 5, 25, 0.5, 6.25, 10],
    ["claude-haiku-4-5", 1, 5, 0.1, 1.25, 2],
  ];
  for (const [model, input, output, cacheRead, five, hour] of expected) {
    for (const [ttl, cacheWrite] of [["5m", five], ["1h", hour]] as const) {
      const row = byId(`anthropic/${model}/global-${ttl}`);
      assert.deepEqual(row.rates, { input, output, cacheRead, cacheWrite });
      assert.equal(row.cacheWriteTtl, ttl);
      assert.equal(row.applicability, "conditional");
      assert.match(row.conditions.join(" "), /creation tokens|creation quantities/);
      if (model !== "claude-haiku-4-5") {
        assert.match(row.conditions.join(" "), /workspace default/);
        assert.match(row.conditions.join(" "), /1\.1x/);
      }
    }
  }
});

test("Gemini paid text tiers retain storage token-hours outside per-token cache writes", () => {
  const rows: [string, number, number, number, number][] = [
    ["gemini-2.5-flash/paid-standard-all", 0.3, 2.5, 0.03, 1],
    ["gemini-2.5-pro/paid-standard-short", 1.25, 10, 0.125, 4.5],
    ["gemini-2.5-pro/paid-standard-long", 2.5, 15, 0.25, 4.5],
  ];
  for (const [id, input, output, cacheRead, storage] of rows) {
    const row = byId(`google/${id}`);
    assert.deepEqual(row.rates, { input, output, cacheRead, cacheWrite: null });
    assert.equal(row.applicability, "conditional");
    assert.equal(row.additionalCharges?.length, 1);
    const charge = row.additionalCharges![0]!;
    assert.equal(charge.kind, "cache-storage");
    assert.equal(charge.unit, "per_1m_token_hours");
    assert.equal(charge.currency, "USD");
    assert.equal(charge.rate, storage);
    assert.ok(charge.condition);
  }
  assert.equal(byId("google/gemini-2.5-pro/paid-standard-short").context.maxInputTokensInclusive, 200000);
  assert.equal(byId("google/gemini-2.5-pro/paid-standard-long").context.minInputTokensExclusive, 200000);
});

test("DeepSeek period fixtures retain the holiday exception and explicit legacy alias", () => {
  const rows: [string, string, number, number, number][] = [
    ["deepseek-v4-flash", "off-peak", 0.15, 0.6, 0.003],
    ["deepseek-v4-flash", "peak", 0.3, 1.2, 0.006],
    ["deepseek-v4-pro", "off-peak", 0.66, 1.98, 0.022],
    ["deepseek-v4-pro", "peak", 1.32, 3.96, 0.044],
  ];
  for (const [model, period, input, output, cacheRead] of rows) {
    const row = byId(`deepseek/${model}/usd-${period}`);
    assert.deepEqual(row.rates, { input, output, cacheRead, cacheWrite: null });
    assert.equal(row.applicability, "conditional");
    assert.equal(row.period?.kind, period);
    assert.equal(row.period?.timezone, "UTC");
    assert.match(row.conditions.join(" "), /01:00-04:00 and 06:00-10:00 UTC/);
    assert.match(row.conditions.join(" "), /excluding Chinese public holidays/);
    if (model === "deepseek-v4-flash") assert.match(row.conditions.join(" "), /DeepSeek-V4\.1-Flash/);
  }
});

test("tariff identity dimensions are unique and context ranges cannot ambiguously overlap", () => {
  const groups = new Map<string, Fact[]>();
  for (const row of facts.entries) {
    const min = row.context.minInputTokensExclusive ?? -1;
    const max = row.context.maxInputTokensInclusive ?? Infinity;
    assert.ok(min === -1 || (Number.isSafeInteger(min) && min >= 0));
    assert.ok(max === Infinity || (Number.isSafeInteger(max) && max > 0));
    assert.ok(min < max);
    const key = [row.vendor, row.model, row.mode, row.region, row.modality, row.cacheWriteTtl ?? "", row.period?.kind ?? ""].join("|");
    const previous = groups.get(key) ?? [];
    for (const other of previous) {
      const otherMin = other.context.minInputTokensExclusive ?? -1;
      const otherMax = other.context.maxInputTokensInclusive ?? Infinity;
      assert.ok(max <= otherMin || otherMax <= min, `${row.id} overlaps ${other.id}`);
    }
    previous.push(row);
    groups.set(key, previous);
  }
});

test("coverage gaps account for each conditional model with fresh first-party evidence", () => {
  const conditional = [...new Set(facts.entries.filter(row => row.applicability === "conditional").map(row => `${row.vendor}/${row.model}`))].sort();
  assert.equal(facts.coverageGaps.length, 8);
  assert.deepEqual(facts.coverageGaps.map(gap => `${gap.vendor}/${gap.model}`).sort(), conditional);
  for (const gap of facts.coverageGaps) {
    assert.ok(gap.reason.trim());
    assert.ok(gap.sources.length > 0);
    for (const source of gap.sources) sourceIsOfficial(source, gap.vendor);
  }
});
