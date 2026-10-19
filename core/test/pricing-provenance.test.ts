import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ProviderBudgetController } from "../src/budget.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { BudgetController } from "../src/global-budget.ts";
import { Ledger, rangeStart, summarize, summarizeBudgetEntries } from "../src/ledger.ts";
import { costOf, ratesFor } from "../src/pricing/cost.ts";
import { CURRENT_ESTIMATOR, estimateProvenance, selectedRatesFingerprint } from "../src/pricing/provenance.ts";
import { createEasySwitchServer, priceEntry } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { GatewayLogEntry, Provider, Rates } from "../src/types.ts";

const NOW = new Date("2026-10-08T12:00:00Z");
const rates: Rates = { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 };
const provider = (over: Partial<Provider> = {}): Provider => ({
  id: "p", name: "Synthetic source", baseUrl: "https://relay.example.invalid/v1", models: ["fixture"],
  route: "chat-translate", routePinned: true, protocols: ["chat"], streamUsage: true, createdAt: NOW.toISOString(), ...over,
});
const entry = (over: Partial<GatewayLogEntry> = {}): GatewayLogEntry => ({
  at: NOW.toISOString(), model: "p/fixture", providerId: "p", route: "chat-translate", harness: "fixture",
  status: 200, ms: 1, inputTokens: 1_000_000, outputTokens: 100_000, usageComplete: true, ...over,
});
function directory(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "es-pricing-provenance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function withoutProvenance(row: GatewayLogEntry): GatewayLogEntry {
  const { pricingProvenance: _evidence, ...old } = row;
  return old;
}
/** Frozen pre-metadata priceEntry control flow, used only as the regression oracle. */
function previousPriceEntry(store: Store, row: GatewayLogEntry): void {
  const source = row.providerId ? store.provider(row.providerId) : undefined;
  if (!source) return;
  if (source.billing === "subscription") { row.costNote = "subscription"; return; }
  if (row.inputTokens === undefined || row.outputTokens === undefined) return;
  const priced = ratesFor(source, row.model.slice(row.model.indexOf("/") + 1));
  if (!priced) { row.costNote = "unpriced"; return; }
  row.costUsd = costOf(priced.rates, { input: row.inputTokens, output: row.outputTokens, cached: row.cachedTokens ?? 0 });
}

test("selected-rate fingerprints have a fixed reproducible serialization and ignore unrelated fields", () => {
  const known = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
  assert.equal(selectedRatesFingerprint(known), "adbe500e2fadd655dae13532a7908595d069aa3942cd09c563f0a370da60f910");
  assert.equal(selectedRatesFingerprint({ cacheWrite: 4, cacheRead: 3, output: 2, input: 1 }), selectedRatesFingerprint(known));
  assert.equal(selectedRatesFingerprint({ ...known, secret: "synthetic-not-a-credential", toJSON() { assert.fail("never serialize a config object"); } } as Rates), selectedRatesFingerprint(known));
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) assert.notEqual(selectedRatesFingerprint({ ...known, [key]: 7 }), selectedRatesFingerprint(known));
  assert.equal(selectedRatesFingerprint({ ...known, input: -0 }), selectedRatesFingerprint({ ...known, input: 0 }));
  assert.match(selectedRatesFingerprint({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })!, /^[a-f0-9]{64}$/);
});

test("malformed selected rates do not become a misleading JSON-null fingerprint or throw", () => {
  for (const invalid of [undefined, null, NaN, Infinity, -Infinity, -1, "1", {}, 1n]) {
    const malformed = { ...rates, cacheWrite: invalid } as Rates;
    assert.equal(selectedRatesFingerprint(malformed), null);
    assert.equal(estimateProvenance({ source: "user", rates: malformed }, undefined).source, "user");
  }
});

test("legacy provenance uses the parsed bundled-table digest and never claims official or whole-bill coverage", t => {
  const store = new Store(directory(t));
  const raw = readFileSync(new URL("../src/pricing/prices.json", import.meta.url), "utf8");
  const expected = createHash("sha256").update(JSON.stringify(JSON.parse(raw)), "utf8").digest("hex");
  for (const baseUrl of ["https://api.openai.com/v1", "https://relay.example.invalid/v1"]) {
    store.upsertProvider(provider({ baseUrl }));
    const row = entry({ model: "p/gpt-4o", cachedTokens: 0 });
    priceEntry(store, row);
    const metadata = row.pricingProvenance!;
    assert.equal(metadata.source, "legacy");
    assert.equal(metadata.estimator, CURRENT_ESTIMATOR);
    assert.equal(metadata.tariffVerification, "not-established");
    assert.equal(metadata.wholeBillCoverage, "not-established");
    assert.equal(metadata.basis, "log-time-config");
    if (metadata.source !== "legacy") assert.fail("expected legacy");
    assert.equal(metadata.legacyParsedTableSha256, expected);
    assert.equal(metadata.selectedRatesSha256, selectedRatesFingerprint(ratesFor(provider({ baseUrl }), "gpt-4o")!.rates));
    assert.equal(metadata.cacheCounterAtEstimator, "present");
    assert.equal(metadata.currency, "USD");
  }
});

test("user override provenance identifies only the selected rates, never a provider or config snapshot", t => {
  const store = new Store(directory(t));
  const source = provider({
    baseUrl: "https://synthetic-user:synthetic-password@relay.example.invalid/private?key=synthetic-key",
    prices: { "gpt-4o": rates, "unselected-private-model": { input: 17, output: 23, cacheRead: 9, cacheWrite: 8 } },
    plan: undefined,
  });
  store.upsertProvider(source);
  const before = JSON.stringify(source), row = entry({ model: "p/gpt-4o" });
  priceEntry(store, row);
  assert.equal(row.costUsd, 1.2);
  assert.deepEqual(row.pricingProvenance, {
    schemaVersion: 1, basis: "log-time-config", tariffVerification: "not-established", wholeBillCoverage: "not-established",
    estimator: CURRENT_ESTIMATOR, currency: "USD", cacheCounterAtEstimator: "omitted-assumed-zero",
    selectedRatesSha256: selectedRatesFingerprint(rates), source: "user",
  });
  assert.equal(JSON.stringify(source), before);
  assert.equal(/synthetic|private|gpt-4o|https|password|key=/.test(JSON.stringify(row.pricingProvenance)), false);
});

test("every existing priceEntry branch keeps its amount, cost note and usage unchanged", t => {
  const store = new Store(directory(t));
  const cases: Array<{ source?: Provider; row: GatewayLogEntry; kind: string; reason?: string }> = [
    { source: provider({ prices: { fixture: rates } }), row: entry(), kind: "user" },
    { source: provider({ prices: { fixture: rates } }), row: entry({ cachedTokens: 400_000 }), kind: "user" },
    { source: provider({ prices: { fixture: rates } }), row: entry({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 }), kind: "user" },
    { source: provider({ prices: { fixture: rates } }), row: entry({ inputTokens: 100, cachedTokens: 500 }), kind: "user" },
    { source: provider({ prices: { fixture: { ...rates, input: 0, output: 0 } } }), row: entry(), kind: "user" },
    { source: provider(), row: entry({ model: "p/gpt-4o" }), kind: "legacy" },
    { source: provider({ billing: "subscription", prices: { fixture: rates } }), row: entry({ inputTokens: undefined }), kind: "subscription" },
    { source: provider(), row: entry(), kind: "unpriced", reason: "rates-unavailable" },
    { source: provider(), row: entry({ inputTokens: undefined }), kind: "unpriced", reason: "usage-unavailable" },
    { source: provider(), row: entry({ outputTokens: undefined }), kind: "unpriced", reason: "usage-unavailable" },
    { row: entry({ providerId: "missing" }), kind: "unpriced", reason: "provider-unavailable" },
    { row: entry({ providerId: undefined }), kind: "unpriced", reason: "provider-unavailable" },
  ];
  for (const c of cases) {
    if (c.source) store.upsertProvider(c.source);
    const old = structuredClone(c.row), current = structuredClone(c.row);
    previousPriceEntry(store, old); priceEntry(store, current);
    assert.deepEqual(withoutProvenance(current), old);
    assert.equal(current.pricingProvenance?.source, c.kind);
    if (current.pricingProvenance?.source === "unpriced") assert.equal(current.pricingProvenance.reason, c.reason);
  }
});

test("cache evidence describes only estimator input presence, independent of normalized completeness", t => {
  const store = new Store(directory(t)); store.upsertProvider(provider({ prices: { fixture: rates } }));
  for (const usageComplete of [true, false, undefined]) {
    const absent = entry({ usageComplete }), present = entry({ cachedTokens: 0, usageComplete });
    priceEntry(store, absent); priceEntry(store, present);
    assert.equal(absent.costUsd, present.costUsd);
    for (const row of [absent, present]) {
      const metadata = row.pricingProvenance!;
      if (metadata.source !== "user") assert.fail("expected user");
      assert.equal(metadata.cacheCounterAtEstimator, row.cachedTokens === undefined ? "omitted-assumed-zero" : "present");
      assert.equal(metadata.wholeBillCoverage, "not-established");
      assert.equal(row.usageComplete, usageComplete);
      assert.equal(JSON.stringify(metadata).includes("reported"), false);
    }
  }
});

test("new metadata survives persistence and restart, while history and changed config never backfill it", t => {
  const dir = directory(t), store = new Store(dir), file = join(dir, "usage.jsonl");
  const old = entry({ costUsd: 7 }), historicalBytes = `${JSON.stringify(old)}\n`;
  writeFileSync(file, historicalBytes);
  store.upsertProvider(provider({ prices: { fixture: rates } }));
  const ledger = new Ledger(dir), first = entry(); priceEntry(store, first); ledger.append(first);
  const firstSnapshot = structuredClone(first);
  store.upsertProvider(provider({ prices: { fixture: { ...rates, input: 3 } } }));
  const second = entry(); priceEntry(store, second); ledger.append(second);
  assert.equal(first.costUsd, 1.2); assert.equal(second.costUsd, 3.2);
  assert.notDeepEqual(first.pricingProvenance, second.pricingProvenance);
  assert.deepEqual(first, firstSnapshot);
  const persisted = new Ledger(dir).read();
  assert.deepEqual(persisted, [old, firstSnapshot, second]);
  assert.equal(Object.hasOwn(persisted[0]!, "pricingProvenance"), false, "absent historical provenance is unknown, not current config");
  assert.ok(readFileSync(file, "utf8").startsWith(historicalBytes), "original historical bytes were not rewritten");
  assert.deepEqual(new Ledger(dir).readForBudget(), persisted);
});

test("metadata leaves usage amounts, budget decisions, provider totals identical", t => {
  const dir = directory(t), store = new Store(join(dir, "store"));
  store.upsertProvider(provider({ prices: { expensive: rates, cheap: { ...rates, input: 0.4, output: 0.8 } } }));
  const rows: GatewayLogEntry[] = [];
  for (const [model, agent] of [["expensive", "claude"], ["cheap", "codex"]]) for (let i = 0; i < 5; i++) {
    const id = `${model}-${i}`, row = entry({ model: `p/${model}`, taskId: id }); priceEntry(store, row); rows.push(row);
  }
  const oldRows = rows.map(withoutProvenance);
  const currentSummary = summarize(rows, "all", NOW), oldSummary = summarize(oldRows, "all", NOW);
  const withoutDisplaySources = (summary: unknown) => JSON.parse(JSON.stringify(summary, (key, value) => key === "pricingSources" ? undefined : value));
  assert.deepEqual(withoutDisplaySources(currentSummary), withoutDisplaySources(oldSummary));
  assert.deepEqual(currentSummary.totals.pricingSources, { user: 10, legacy: 0, unpriced: 0, subscription: 0, unknown: 0 });
  assert.deepEqual(oldSummary.totals.pricingSources, { user: 0, legacy: 0, unpriced: 0, subscription: 0, unknown: 10 });
  const start = new Date("2026-10-01T00:00:00Z"), end = new Date("2026-11-01T00:00:00Z");
  assert.deepEqual(summarizeBudgetEntries(rows, start, end, NOW), summarizeBudgetEntries(oldRows, start, end, NOW));
  const source = provider({ budget: { monthlyUsd: 8, stop: true } });
  const providerStatus = (input: GatewayLogEntry[]) => new ProviderBudgetController({ readEntries: () => input, now: () => NOW }).budgetStatus(source);
  assert.deepEqual(providerStatus(rows), providerStatus(oldRows)); assert.equal(providerStatus(rows)!.blocked, true);
  const globalStatus = (input: GatewayLogEntry[], name: string) => {
    const controller = new BudgetController(join(dir, name), { readEntries: () => input, now: () => NOW });
    controller.setSettings({ enabled: true, limitUsd: 8, period: "month", action: "stop", warnAt: 0.8 });
    return controller.status();
  };
  assert.deepEqual(globalStatus(rows, "new-budget"), globalStatus(oldRows, "old-budget"));

});

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function until(check: () => boolean): Promise<void> {
  const expires = Date.now() + 2_000;
  while (!check()) { if (Date.now() >= expires) assert.fail("synthetic local request did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

async function usageFixture(t: TestContext, rows: GatewayLogEntry[]) {
  t.after(() => assert.equal(readFileSync(file, "utf8"), saved, "Usage summaries never rewrite retained history"));
  const dir = directory(t), ledger = new Ledger(dir), store = new Store(dir), auth = new GatewayTokenAuthority();
  const saved = `${rows.map(row => JSON.stringify(row)).join("\n")}\n`, file = join(dir, "usage.jsonl");
  writeFileSync(file, saved);
  const forbidden = (): never => assert.fail("Usage reads must not use credentials, probes, clients or issue sessions");
  auth.issue = forbidden;
  const base = await listen(t, createEasySwitchServer({ store, ledger, gatewayAuth: auth, port: 0,
    secrets: { async get() { return forbidden(); }, async set() { forbidden(); }, async delete() { forbidden(); } },
    sourceHealth: { fetch: async () => forbidden() },
    interactiveRuntime: { findBinary: async () => forbidden(), newSessionDir: forbidden, launchInTerminal: async () => forbidden() },
  }));
  return { ledger, get: (range: string) => fetch(`${base}/api/usage?range=${range}`, { headers: { "x-easyswitch": "1" } }) };
}

test("usage API filters unordered, invalid and future rows consistently for every range", async t => {
  const now = new Date(2026, 0, 2, 12);
  t.mock.timers.enable({ apis: ["Date"], now });
  const rows = [entry({ at: now.toISOString(), costUsd: 0.2 }), entry({ at: "invalid", costUsd: 100 }),
    entry({ at: new Date(2025, 11, 1, 12).toISOString(), costUsd: 0.1 }),
    entry({ at: new Date(now.getTime() + 1).toISOString(), costUsd: 200 }),
    entry({ at: new Date(2026, 0, 2).toISOString(), costUsd: 0 }), entry({ at: new Date(2025, 11, 30, 23).toISOString(), costUsd: 0.3 })];
  const fixture = await usageFixture(t, rows);
  for (const range of ["today", "7d", "30d", "all"] as const) {
    const response = await fixture.get(range); assert.equal(response.status, 200);
    const body = await response.json(); assert.deepEqual(body, summarize(rows, range, now));
    assert.equal(body.totals.calls, body.days.reduce((sum: number, day: { calls: number }) => sum + day.calls, 0));
  }
  const invalid = await fixture.get("invalid"); assert.equal(invalid.status, 400);
});

test("usage API captures one now across ledger reads at local midnight", async t => {
  const now = new Date(2026, 0, 2, 23, 59, 59, 999), afterMidnight = new Date(now.getTime() + 1);
  t.mock.timers.enable({ apis: ["Date"], now });
  const rows = [entry({ at: now.toISOString() }), entry({ at: afterMidnight.toISOString() }),
    entry({ at: new Date(2026, 0, 2).toISOString() }), entry({ at: new Date(2025, 11, 27).toISOString() }), entry({ at: new Date(2025, 11, 4).toISOString() })];
  const fixture = await usageFixture(t, rows), read = fixture.ledger.read;
  let observedSince: number | undefined;
  t.mock.method(fixture.ledger, "read", (since?: Date) => {
    observedSince = since?.getTime();
    const entries = read.call(fixture.ledger, since);
    t.mock.timers.setTime(afterMidnight.getTime());
    return entries;
  });
  for (const range of ["today", "7d", "30d", "all"] as const) {
    t.mock.timers.setTime(now.getTime());
    const response = await fixture.get(range); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), summarize(rows, range, now));
    assert.equal(observedSince, rangeStart(range, now)?.getTime());
  }
});

test("usage API rejects oversized all output explicitly and limited ranges still read the same history", async t => {
  const now = new Date(2026, 9, 8, 12);
  t.mock.timers.enable({ apis: ["Date"], now });
  const rows = [entry({ at: now.toISOString(), costUsd: 0.25 }), entry({ at: "0099-01-01T00:00:00Z", costUsd: 5 })];
  const fixture = await usageFixture(t, rows), response = await fixture.get("all");
  assert.equal(response.status, 422);
  const body = await response.json(); assert.equal(body.code, "usage_range_too_large");
  assert.match(body.error, /10,000.*今天.*7 天.*30 天/); assert.equal(body.totals, undefined); assert.equal(body.days, undefined);
  for (const range of ["today", "7d", "30d"] as const) {
    const response = await fixture.get(range); assert.equal(response.status, 200);
    const summary = await response.json(); assert.equal(summary.totals.calls, 1); assert.equal(summary.totals.costUsd, 0.25);
    assert.deepEqual(summary, summarize(rows, range, now));
  }
});

test("synthetic gateway logs persisted provenance and existing usage/budget APIs keep their amounts", async t => {
  const dir = directory(t), store = new Store(dir), ledger = new Ledger(dir), auth = new GatewayTokenAuthority();
  let requests = 0;
  const upstream = await listen(t, createServer(async (req, res) => {
    for await (const _chunk of req) { /* Only a synthetic fixture body, never retained. */ }
    requests++; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "fixture", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }));
  }));
  store.upsertProvider(provider({ baseUrl: `${upstream}/v1`, prices: { fixture: rates } }));
  const base = await listen(t, createEasySwitchServer({ store, ledger, gatewayAuth: auth, port: 0,
    secrets: { async get() { return undefined; }, async set() { assert.fail("no credential writes"); }, async delete() { assert.fail("no credential deletes"); } },
  }));
  const token = auth.issue("fixture").token;
  const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "p/fixture", messages: [{ role: "user", content: "synthetic" }], pricingProvenance: { source: "forged-official", selectedRatesSha256: "forged" } }),
  });
  assert.equal(response.status, 200); await response.text(); await until(() => ledger.read().length === 1);
  const [row] = ledger.read(); assert.ok(row); assert.equal(row.costUsd, 0.00014); assert.equal(requests, 1);
  assert.equal(row.pricingProvenance?.source, "user");
  if (row.pricingProvenance?.source !== "user") assert.fail("expected user evidence");
  assert.equal(row.pricingProvenance.cacheCounterAtEstimator, "present", "parser default 0 proves only estimator input presence");
  assert.equal(row.pricingProvenance.wholeBillCoverage, "not-established");
  assert.equal(JSON.stringify(row.pricingProvenance).includes("forged"), false);
  const usageResponse = await fetch(`${base}/api/usage?range=all`, { headers: { "x-easyswitch": "1" } });
  assert.equal(usageResponse.status, 200); assert.deepEqual(await usageResponse.json(), summarize([row], "all"));
  const budgetResponse = await fetch(`${base}/api/budget`, { headers: { "x-easyswitch": "1" } });
  assert.equal(budgetResponse.status, 200); const budget = await budgetResponse.json() as { estimatedCostUsd: number; unknownCostCalls: number };
  assert.equal(budget.estimatedCostUsd, 0.00014); assert.equal(budget.unknownCostCalls, 0);
  const saved = readFileSync(join(dir, "usage.jsonl"), "utf8");
  assert.equal(saved.includes(token), false); assert.equal(saved.includes(upstream), false); assert.equal(saved.includes("forged-official"), false);
  assert.deepEqual(new Ledger(dir).read()[0]!.pricingProvenance, row.pricingProvenance);
});
