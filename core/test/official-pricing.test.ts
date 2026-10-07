import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compileOfficialPrices, validateOfficialFacts, type OfficialPriceFacts, type OfficialPriceTable } from "../src/pricing/official-table.ts";
import { estimateOfficialPrice, type OfficialPriceRequest } from "../src/pricing/official-estimate.ts";
// Importing the script must be safe: no default HOME lookup and no writes.
// @ts-expect-error JavaScript build entrypoint intentionally has no declaration file.
import { buildPrices, main } from "../../scripts/build-prices.mjs";

function fixture(): OfficialPriceFacts {
  return { schemaVersion: 1, checkedAt: "2026-10-07", coverageGaps: [], entries: [{
    id: "fixture/standard", vendor: "openai", model: "fixture-model", hosts: ["api.openai.com"],
    currency: "USD", unit: "per_1m_tokens", mode: "standard", region: "non-regional", modality: "text",
    context: { maxInputTokensInclusive: 2000000 }, applicability: "standard-text",
    rates: { input: 2, output: 10, cacheRead: 0.5, cacheWrite: null },
    unknownReasons: { cacheWrite: "Included in ordinary input, not a separate write tariff." },
    cacheWriteTreatment: "included-in-input", conditions: ["Synthetic tariff, never a vendor-price assertion."],
    sources: [{ url: "https://developers.openai.com/api/docs/pricing", title: "Synthetic source identifier", checkedAt: "2026-10-07" }],
  }] };
}
function table(facts = fixture()): OfficialPriceTable { return JSON.parse(compileOfficialPrices(JSON.stringify(facts))); }
function request(over: Partial<OfficialPriceRequest> = {}): OfficialPriceRequest {
  return { baseUrl: "https://api.openai.com/v1", model: "fixture-model", usage: { input: 1000000, output: 100000, cached: 400000 }, scope: { mode: "standard", modality: "text", region: "non-regional" }, ...over };
}

test("official table is reproducible from exact facts bytes and preserves null tariffs", () => {
  const raw = readFileSync(new URL("../src/pricing/official-facts.json", import.meta.url), "utf8");
  const generated = compileOfficialPrices(raw);
  assert.equal(generated, compileOfficialPrices(raw));
  assert.equal(generated, readFileSync(new URL("../src/pricing/official-prices.json", import.meta.url), "utf8"));
  const parsed = JSON.parse(generated);
  assert.equal(parsed.factsSha256, createHash("sha256").update(raw).digest("hex"));
  assert.equal(parsed.entries.length, 17);
  assert.equal(parsed.entries.find((r: any) => r.model === "gpt-4o").rates.cacheWrite, null);
});

test("generator rejects unknown schema, semantic fields, absent rates, invalid dates and foreign sources", () => {
  const mutations: ((value: any) => void)[] = [
    x => x.schemaVersion = 2, x => x.entries[0].unknownPriceMode = "free",
    x => x.entries[0].vendor = ["openai"], x => x.entries[0].region = "   ",
    x => x.entries[0].conditions = [" "],
    x => { x.entries[0].rates.cacheWrite = 100; delete x.entries[0].unknownReasons.cacheWrite; },
    x => x.coverageGaps = [{vendor:["openai"],model:"test",reason:"reason",sources:x.entries[0].sources}],
    x => delete x.entries[0].rates.cacheRead, x => x.entries[0].rates.cacheRead = -1,
    x => x.entries[0].rates.cacheRead = Infinity, x => delete x.entries[0].unknownReasons.cacheWrite,
    x => x.entries[0].sources[0].url = "https://prices.example.net/rates",
    x => x.entries[0].sources[0].url = "https://token@developers.openai.com/pricing",
    x => x.entries[0].hosts = ["relay.example.net"], x => x.checkedAt = "2026-02-30",
    x => x.entries[0].sources[0].checkedAt = "2026-10-08", x => x.entries[0].vendor = "constructor",
    x => x.entries[0].currency = "CNY", x => x.entries[0].cacheWriteTreatment = "separate",
    x => x.entries[0].period = { kind: "peak", timezone: "UTC", description: "Unresolved calendar" },
  ];
  for (const change of mutations) { const facts = fixture(); change(facts); assert.throws(() => validateOfficialFacts(facts), /invalid or unsupported/); }
  assert.throws(() => compileOfficialPrices("not json"), /invalid or unsupported/);
});

test("same model context tiers must not overlap, and input boundaries select exactly one row", () => {
  const facts = fixture(), first = facts.entries[0]!;
  first.context = { maxInputTokensInclusive: 100 };
  const second = structuredClone(first); second.id = "fixture/long"; second.context = { minInputTokensExclusive: 100 }; second.rates.input = 4;
  facts.entries.push(second);
  const compiled = table(facts);
  assert.equal(estimateOfficialPrice(compiled, request({ usage: { input: 100, output: 0, cached: 0 } })).factId, first.id);
  assert.equal(estimateOfficialPrice(compiled, request({ usage: { input: 101, output: 0, cached: 0 } })).factId, second.id);
  second.context.minInputTokensExclusive = 99;
  assert.throws(() => table(facts), /invalid or unsupported/);
});

test("build CLI requires explicit paths and validates before replacing output", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-price-build-"));
  try {
    const source = join(dir, "facts.json"), out = join(dir, "out.json");
    writeFileSync(source, JSON.stringify(fixture())); writeFileSync(out, "sentinel");
    assert.throws(() => main([]), /Usage/);
    assert.throws(() => buildPrices(source, source), /distinct/);
    const legacy = fileURLToPath(new URL("../src/pricing/prices.json", import.meta.url));
    const before = readFileSync(legacy, "utf8");
    assert.throws(() => buildPrices(source, legacy), /cannot overwrite the legacy/);
    assert.equal(readFileSync(legacy, "utf8"), before);
    writeFileSync(source, "broken"); assert.throws(() => buildPrices(source, out)); assert.equal(readFileSync(out, "utf8"), "sentinel");
    writeFileSync(source, JSON.stringify(fixture())); buildPrices(source, out);
    assert.equal(readFileSync(out, "utf8"), compileOfficialPrices(readFileSync(source, "utf8")));
    writeFileSync(`${out}.${process.pid}.tmp`, "someone else's temporary file");
    assert.throws(() => buildPrices(source, out)); assert.equal(readFileSync(`${out}.${process.pid}.tmp`, "utf8"), "someone else's temporary file");
    assert.ok(existsSync(source));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pure official estimate handles cached input without billing included cache writes twice", () => {
  const a = estimateOfficialPrice(table(), request());
  assert.equal(a.complete, true); assert.equal(a.costUsd, 2.4);
  const b = estimateOfficialPrice(table(), request({ usage: { input: 1000000, output: 100000, cached: 400000, cacheWrite: 200000 } }));
  assert.deepEqual(b, a);
});

test("an unknown used tariff is partial, never free, while unused null rates do not poison zero usage", () => {
  const f = fixture(); f.entries[0]!.rates.cacheRead = null; f.entries[0]!.unknownReasons.cacheRead = "Not independently confirmed.";
  const p = estimateOfficialPrice(table(f), request());
  assert.equal(p.complete, false); assert.equal(p.reason, "partial_price"); assert.equal(p.costUsd, 2.2);
  const allUnknown = estimateOfficialPrice(table(f), request({ usage: { input: 100, output: 0, cached: 100 } }));
  assert.equal(allUnknown.costUsd, undefined); assert.equal(allUnknown.complete, false);
  const zero = estimateOfficialPrice(table(f), request({ usage: { input: 0, output: 0 } }));
  assert.equal(zero.costUsd, 0); assert.equal(zero.complete, true);
});

test("missing scope, cache detail, region, context or exact origin/model cannot claim a known price", () => {
  const compiled = table();
  for (const over of [
    { scope: undefined }, { scope: { mode: "standard", modality: "text", region: "unknown" } },
    { usage: { input: 100, output: 0 } }, { usage: { input: 2000001, output: 0, cached: 0 } },
    { baseUrl: "https://relay.example.net/v1" }, { baseUrl: "http://api.openai.com/v1" },
    { baseUrl: "https://api.openai.com:8443/v1" }, { baseUrl: "https://api.openai.com/v1?api-key=fixture" },
    { model: "fixture-model[1m]" }, { model: "openai/fixture-model" },
  ] as Partial<OfficialPriceRequest>[]) {
    const result = estimateOfficialPrice(compiled, request(over)); assert.equal(result.complete, false); assert.equal(result.costUsd, undefined);
  }
});

test("invalid usage rejects negative, fractional, excessive-cache and nonfinite counts", () => {
  for (const usage of [{ input: -1, output: 0 }, { input: 1.5, output: 1 }, { input: Infinity, output: 1 }, { input: 5, output: 1, cached: 6 }, { input: 5, output: 1, cached: 4, cacheWrite: 2 }]) {
    assert.deepEqual(estimateOfficialPrice(table(), request({ usage })), { complete: false, reason: "invalid_usage" });
  }
});

test("retained conditional facts are not silently activated by host or wall-clock inference", () => {
  const actual = JSON.parse(readFileSync(new URL("../src/pricing/official-prices.json", import.meta.url), "utf8")) as OfficialPriceTable;
  for (const row of actual.entries.filter(r => r.applicability !== "standard-text")) {
    const result = estimateOfficialPrice(actual, request({ baseUrl: `https://${row.hosts[0]}/v1`, model: row.model, scope: { mode: "standard", modality: "text", region: row.region } }));
    assert.equal(result.complete, false, row.id); assert.equal(result.costUsd, undefined, row.id);
  }
});
