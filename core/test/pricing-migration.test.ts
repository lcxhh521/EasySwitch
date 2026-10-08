import assert from "node:assert/strict";
import { test, mock } from "node:test";
import fs, { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { parseMigrationFixture, pricingMigrationReport, type MigrationCase } from "../src/pricing/migration-report.ts";
import { compileOfficialPrices, type OfficialPriceFacts } from "../src/pricing/official-table.ts";
import { ratesFor, costOf } from "../src/pricing/cost.ts";
// @ts-expect-error JavaScript CLI intentionally has no declaration file.
import { main } from "../../scripts/compare-pricing.mjs";

const factsRaw = readFileSync(new URL("../src/pricing/official-facts.json", import.meta.url), "utf8");
const tableRaw = readFileSync(new URL("../src/pricing/official-prices.json", import.meta.url), "utf8");
const fixtureRaw = readFileSync(new URL("./fixtures/pricing-migration.synthetic.json", import.meta.url), "utf8");
function row(over: Partial<MigrationCase> = {}): MigrationCase {
  return { id: "test", model: "gpt-4o", baseUrl: "https://api.openai.com/v1", billing: "usage", usage: { input: 10000, output: 1000, cached: 2000 }, scope: { mode: "standard", modality: "text", region: "non-regional" }, ...over };
}
function input(cases: MigrationCase[]): string { return JSON.stringify({ schemaVersion: 1, dataKind: "synthetic", cases }); }
function report(cases: MigrationCase[], change?: (facts: OfficialPriceFacts) => void) {
  if (!change) return pricingMigrationReport(input(cases), factsRaw, tableRaw);
  const facts: OfficialPriceFacts = JSON.parse(factsRaw); change(facts);
  const raw = JSON.stringify(facts);
  return pricingMigrationReport(input(cases), raw, compileOfficialPrices(raw));
}

test("synthetic comparison is deterministic, source-bound and never claims whole-bill coverage", () => {
  const a = pricingMigrationReport(fixtureRaw, factsRaw, tableRaw);
  assert.deepEqual(a, pricingMigrationReport(fixtureRaw, factsRaw, tableRaw));
  assert.equal(a.dataKind, "synthetic"); assert.equal(a.scope, "selected-text-tokens-only");
  assert.equal(a.wholeBillCoverage, "not-established");
  assert.equal(a.provenance.fixtureSha256, createHash("sha256").update(fixtureRaw).digest("hex"));
  assert.equal(a.provenance.official.factsSha256, createHash("sha256").update(factsRaw).digest("hex"));
  assert.equal(a.provenance.legacy.status, "legacy-unverified");
  assert.equal(a.provenance.legacy.officialRuntimeEnabled, false);
  assert.equal(a.provenance.legacy.modelRows, 1233);
  const legacy = JSON.parse(readFileSync(new URL("../src/pricing/prices.json", import.meta.url), "utf8"));
  assert.equal(a.provenance.legacy.parsedTableSha256, createHash("sha256").update(JSON.stringify(legacy)).digest("hex"));
  assert.deepEqual(a.tableCoverage, { factRows: 17, exactVendorModels: 10, standardTextFactRows: 2, deferredFactRows: 15 });
  assert.equal(a.summary.cases, 21);
  assert.deepEqual(a.summary.staged, { selectedTextComplete: 5, partial: 0, unknown: 15, subscription: 1 });
  assert.equal(a.summary.comparableSelectedText.cases, 4);
  assert.equal(a.summary.comparableSelectedText.deltaUsd, 0);
  assert.equal(a.summary.partialSelectedText.knownAmountUsd, null);
});

test("the baseline uses the unchanged runtime lookup and delta is staged minus legacy", () => {
  const request = row();
  const a = report([request]).cases[0]!;
  assert.equal(a.baseline.costUsd, costOf(ratesFor(request, request.model)!.rates, request.usage));
  assert.equal(a.staged.status, "selected-text-complete");
  const b = report([request], facts => { facts.entries.find(fact => fact.model === "gpt-4o")!.rates.input = 5; });
  assert.equal(b.cases[0]!.baseline.costUsd, a.baseline.costUsd);
  assert.equal(b.cases[0]!.comparison.status, "comparable-selected-text");
  assert.ok(Math.abs(b.summary.comparableSelectedText.deltaUsd! - 0.02) < 1e-12);
});

test("conditional models, aliases and resellers keep old reference amounts but never get staged deltas", () => {
  const a = pricingMigrationReport(fixtureRaw, factsRaw, tableRaw);
  const deferred = a.cases.filter(row => row.id.startsWith("conditional-"));
  assert.equal(deferred.length, 8);
  for (const result of [...deferred, ...a.cases.filter(row => ["reseller-host", "model-alias"].includes(row.id))]) {
    assert.equal(result.baseline.status, "legacy-reference", result.id);
    assert.equal(result.staged.status, "unknown", result.id);
    assert.equal(result.staged.costUsd, undefined);
    assert.equal(result.comparison.status, "excluded");
  }
});

test("scope and cache metadata are never manufactured from the model or missing counters", () => {
  for (const request of [row({ scope: undefined }), row({ usage: { input: 10000, output: 1000 } }), row({ scope: { mode: "standard", modality: "text", region: "unknown" } })]) {
    const a = report([request]).cases[0]!;
    assert.equal(a.staged.reason, "unverified_conditions");
    assert.equal(a.staged.costUsd, undefined);
    assert.equal(a.baseline.cachedDefaultedToZero, request.usage.cached === undefined);
    assert.deepEqual(a.comparison, { status: "excluded", reason: "staged_unknown" });
  }
});

test("explicit user overrides remain user estimates and are excluded even when official text is complete", () => {
  for (const userRates of [{ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]) {
    const a = report([row({ userRates })]);
    assert.equal(a.cases[0]!.baseline.status, "user-estimate");
    assert.equal(a.cases[0]!.baseline.costUsd, costOf(userRates, row().usage));
    assert.equal(a.cases[0]!.staged.status, "selected-text-complete");
    assert.deepEqual(a.cases[0]!.comparison, { status: "excluded", reason: "user_override_preserved" });
    assert.equal(a.summary.comparableSelectedText.legacyReferenceUsd, null);
  }
});

test("subscriptions have no per-call estimate, including zero traffic and explicit rates", () => {
  const a = report([row({ billing: "subscription", usage: { input: 0, output: 0 }, userRates: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } })]);
  assert.equal(a.cases[0]!.baseline.status, "subscription");
  assert.equal(a.cases[0]!.baseline.costUsd, undefined);
  assert.deepEqual(a.cases[0]!.staged, { status: "subscription" });
  assert.deepEqual(a.cases[0]!.comparison, { status: "excluded", reason: "subscription" });
});

test("invalid usage never produces either estimate or a comparable delta", () => {
  for (const usage of [{ input: -1, output: 0 }, { input: 1.5, output: 0 }, { input: 5, output: -1 }, { input: 5, output: 1, cached: 6 }, { input: 5, output: 1, cached: 4, cacheWrite: 2 }, { input: Number.MAX_SAFE_INTEGER + 1, output: 0 }]) {
    const a = report([row({ usage })]).cases[0]!;
    assert.equal(a.baseline.costUsd, undefined);
    assert.equal(a.staged.reason, "invalid_usage");
    assert.deepEqual(a.comparison, { status: "excluded", reason: "invalid_usage" });
  }
});

test("partial charges retain known amounts separately and never enter comparable sums", () => {
  const requests = [row(), row({ id: "all-unknown", usage: { input: 0, output: 1000, cached: 0 } }), row({ id: "unused-unknown", usage: { input: 100, output: 0, cached: 0 } })];
  const a = report(requests, facts => {
    const fact = facts.entries.find(fact => fact.model === "gpt-4o")!;
    fact.rates.output = null; fact.unknownReasons.output = "Synthetic missing output tariff.";
  });
  assert.equal(a.cases[0]!.staged.status, "partial");
  assert.equal(a.cases[0]!.staged.costUsd, 0.0225);
  assert.deepEqual(a.cases[0]!.comparison, { status: "excluded", reason: "staged_partial" });
  assert.equal(a.cases[1]!.staged.status, "partial"); assert.equal(a.cases[1]!.staged.costUsd, undefined);
  assert.equal(a.cases[2]!.staged.status, "selected-text-complete");
  assert.equal(a.summary.staged.partial, 2);
  assert.deepEqual(a.summary.partialSelectedText, { casesWithKnownAmount: 1, currency: "USD", knownAmountUsd: 0.0225 });
  assert.equal(a.summary.comparableSelectedText.cases, 1);
  assert.equal(a.summary.comparableSelectedText.stagedSelectedTextUsd, 0.00025);
});

test("known partial zero is distinguishable from a missing partial amount", () => {
  const a = report([row()], facts => {
    const fact = facts.entries.find(fact => fact.model === "gpt-4o")!;
    fact.rates.input = 0; fact.rates.cacheRead = 0;
    fact.rates.output = null; fact.unknownReasons.output = "Synthetic unknown output tariff.";
  });
  assert.equal(a.cases[0]!.staged.status, "partial");
  assert.equal(a.summary.partialSelectedText.knownAmountUsd, 0);
  assert.equal(a.summary.partialSelectedText.casesWithKnownAmount, 1);
  assert.equal(a.summary.comparableSelectedText.deltaUsd, null);
});

test("incompatible currency facts cannot be relabeled USD or mixed into comparison amounts", () => {
  const a = report([row(), row({ id: "usd", model: "gpt-4o-mini" })], facts => {
    const fact = facts.entries.find(fact => fact.model === "gpt-4o")!;
    fact.currency = "CNY"; fact.applicability = "conditional";
  });
  assert.equal(a.cases[0]!.staged.costUsd, undefined);
  assert.deepEqual(a.cases[0]!.comparison, { status: "excluded", reason: "incompatible_currency" });
  assert.equal(a.summary.exclusions.incompatible_currency, 1);
  assert.equal(a.summary.comparableSelectedText.cases, 1);
  assert.equal(a.summary.comparableSelectedText.stagedSelectedTextUsd, a.cases[1]!.staged.costUsd);
});

test("context boundary and included cache writes preserve the staged estimator's exact scope", () => {
  const a = report([row({ usage: { input: 128000, output: 1, cached: 0 } }), row({ id: "over", usage: { input: 128001, output: 1, cached: 0 } }), row({ id: "write", usage: { ...row().usage, cacheWrite: 3000 } }), row({ id: "no-write" })]);
  assert.equal(a.cases[0]!.staged.status, "selected-text-complete");
  assert.equal(a.cases[1]!.staged.status, "unknown");
  assert.equal(a.cases[2]!.staged.costUsd, a.cases[3]!.staged.costUsd);
  assert.equal(a.cases[2]!.baseline.costUsd, a.cases[3]!.baseline.costUsd);
});

test("empty and entirely unknown samples are not free; measured zero remains zero", () => {
  for (const requests of [[], [row({ model: "synthetic-unknown-model" })]]) {
    const a = report(requests);
    assert.equal(a.summary.comparableSelectedText.cases, 0);
    assert.equal(a.summary.comparableSelectedText.deltaUsd, null);
    assert.equal(a.summary.comparableSelectedText.stagedSelectedTextUsd, null);
  }
  const zero = report([row({ usage: { input: 0, output: 0 } })]);
  assert.equal(zero.summary.comparableSelectedText.stagedSelectedTextUsd, 0);
  assert.equal(zero.summary.comparableSelectedText.deltaUsd, 0);
});

test("prototype-shaped legacy model keys remain ordinarily unpriced after the separate lookup fix", () => {
  for (const model of ["constructor", "__proto__", "toString"]) {
    const a = report([row({ model, baseUrl: "https://relay.example.invalid/v1" })]).cases[0]!;
    assert.equal(a.baseline.status, "unknown"); assert.equal(a.baseline.costUsd, undefined);
    assert.equal(a.baseline.reason, undefined);
    assert.deepEqual(a.comparison, { status: "excluded", reason: "legacy_unpriced" });
  }
});

test("strict synthetic schema rejects hidden fields, credentials, defaults and malformed counters", () => {
  const mutations: ((fixture: any) => void)[] = [
    f => f.dataKind = "production", f => delete f.dataKind, f => f.schemaVersion = 2,
    f => f.cases.push(f.cases[0]), f => f.cases[0].authorization = "synthetic-secret",
    f => f.cases[0].baseUrl = "https://synthetic-secret@api.openai.com/v1",
    f => f.cases[0].baseUrl += "?key=synthetic-secret", f => delete f.cases[0].billing,
    f => f.cases[0].usage.input = "100", f => f.cases[0].usage.cached = null,
    f => f.cases[0].usage = {}, f => f.cases[0].scope.mode = "batch",
    f => f.cases[0].userRates = { input: -1, output: 1, cacheRead: 1, cacheWrite: 1 },
    f => f.cases[0].userRates = { input: 1, output: 1, cacheRead: 1 },
  ];
  for (const change of mutations) {
    const value = JSON.parse(input([row()])); change(value);
    assert.throws(() => parseMigrationFixture(JSON.stringify(value)), /explicitly synthetic/);
  }
  assert.throws(() => parseMigrationFixture(" ".repeat(2 * 1024 * 1024 + 1)), /explicitly synthetic/);
  assert.throws(() => parseMigrationFixture("not json"), /explicitly synthetic/);
});

test("stale or independently edited staged artifacts fail before any comparison", () => {
  assert.throws(() => pricingMigrationReport(fixtureRaw, `${factsRaw}\n`, tableRaw), /does not match/);
  assert.throws(() => pricingMigrationReport(fixtureRaw, factsRaw, tableRaw.replace('"USD"', '"CNY"')), /does not match/);
});

test("CLI requires an explicit fixture and returns reproducible JSON without writing state or input", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-migration-test-"));
  try {
    const source = join(dir, "synthetic.json"), ledger = join(dir, "ledger.jsonl"), state = join(dir, "state.json");
    writeFileSync(source, fixtureRaw); writeFileSync(ledger, "synthetic ledger sentinel\n"); writeFileSync(state, "synthetic state sentinel\n");
    const before = readdirSync(dir).map(file => [file, readFileSync(join(dir, file), "utf8")]);
    assert.throws(() => main([]), /Usage/); assert.throws(() => main([source, state]), /Usage/);
    assert.throws(() => main([dir]), /bounded synthetic/);
    assert.equal(main([source]), main([source]));
    assert.deepEqual(JSON.parse(main([source])), pricingMigrationReport(fixtureRaw, factsRaw, tableRaw));
    assert.deepEqual(readdirSync(dir).map(file => [file, readFileSync(join(dir, file), "utf8")]), before);
    assert.equal(readFileSync(new URL("../src/pricing/official-prices.json", import.meta.url), "utf8"), tableRaw);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("importing the CLI does not run it, read an implicit fixture or write files", async () => {
  const target = new URL("../../scripts/compare-pricing.mjs?import-safety", import.meta.url);
  const originalRead = fs.readFileSync;
  // Node itself must read the new module URL; any application-data read fails.
  const read = mock.method(fs, "readFileSync", (path: unknown, ...args: unknown[]) => {
    assert.equal(path instanceof URL ? fileURLToPath(path) : path, fileURLToPath(target));
    return Reflect.apply(originalRead, fs, [path, ...args]);
  });
  const write = mock.method(fs, "writeFileSync", () => { throw new Error("Unexpected import-time write"); });
  syncBuiltinESMExports();
  try {
    const imported = await import(target.href);
    assert.equal(typeof imported.main, "function");
    assert.equal(write.mock.callCount(), 0);
  } finally { read.mock.restore(); write.mock.restore(); syncBuiltinESMExports(); }
});
