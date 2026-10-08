import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { rangeStart, summarize, summarizeBudgetEntries } from "../src/ledger.ts";
import { estimateProvenance } from "../src/pricing/provenance.ts";
import type { GatewayLogEntry } from "../src/types.ts";

const NOW = new Date(2026, 9, 8, 12);
const rates = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
const provenance = (source: "user" | "legacy") => estimateProvenance({ source, rates }, 0);
const row = (overrides: Partial<GatewayLogEntry> = {}): GatewayLogEntry => ({
  at: NOW.toISOString(), model: "fixture/m", providerId: "fixture", harness: "codex", keyId: "fixture-key",
  route: "chat-translate", status: 200, ms: 1, inputTokens: 0, outputTokens: 0, usageComplete: true, ...overrides,
});
const summarizeRows = (rows: GatewayLogEntry[]) => summarize(rows, "today", NOW);
const source = readFileSync(new URL("../../web/usage-display.js", import.meta.url), "utf8");
function helper() {
  const context = vm.createContext({}); vm.runInContext(source, context);
  const run = (code: string): any => vm.runInContext(code, context);
  return {
    cost: (rows: GatewayLogEntry[], display: unknown = { currency: "USD" }) => {
      context.totals = summarizeRows(rows).totals; context.display = display;
      return run("usageCostPresentation(totals, display)");
    },
    coverage: (rows: GatewayLogEntry[]): string => { context.totals = summarizeRows(rows).totals; return run("usageCoverage(totals)"); },
    run,
  };
}

test("display summary distinguishes exact zero, missing amounts and incomplete recorded costs without losing sums", () => {
  const rows = [row({ costUsd: 0 }), row({ costUsd: 1.25, usageComplete: false }), row({ inputTokens: undefined }),
    row({ outputTokens: undefined }), row({ inputTokens: undefined, outputTokens: undefined }), row({ costNote: "unpriced" }),
    row({ costNote: "subscription", inputTokens: undefined, outputTokens: undefined }), row({ costUsd: 0.5, usageComplete: undefined })];
  const { totals: t, byProvider, byHarness, byKey, days } = summarizeRows(rows);
  assert.equal(t.costUsd, 1.75); assert.equal(t.recordedCostCalls, 3);
  assert.equal(t.missingCostCalls, 4); assert.equal(t.partialCostCalls, 1);
  assert.equal(t.subscription, 1); assert.equal(t.usageIncompleteCalls, 5); assert.equal(t.usageCompletenessUnknownCalls, 1);
  assert.equal(t.recordedCostCalls + t.missingCostCalls + t.subscription, t.calls);
  assert.deepEqual(t.pricingSources, { user: 0, legacy: 0, unpriced: 0, subscription: 0, unknown: 3 });
  assert.deepEqual(byProvider.fixture, t); assert.deepEqual(byHarness.codex, t); assert.deepEqual(byKey["fixture#fixture-key"], t);
  const { day: _, ...daily } = days[0]!; assert.deepEqual(daily, t);
});

test("recorded provenance forms a partition and is not inferred for unpriced, subscription or older rows", () => {
  const rows = [row({ costUsd: 0, pricingProvenance: provenance("user") }), row({ costUsd: 0.1, pricingProvenance: provenance("legacy") }),
    row({ costUsd: 0.2 }), row({ pricingProvenance: provenance("user") }), row({ costNote: "subscription" })];
  const { totals: t } = summarizeRows(rows);
  assert.deepEqual(t.pricingSources, { user: 1, legacy: 1, unpriced: 0, subscription: 0, unknown: 1 });
  assert.equal(Object.values(t.pricingSources).reduce((sum, value) => sum + value, 0), t.recordedCostCalls);
  assert.equal(t.missingCostCalls, 1); assert.equal(t.subscription, 1);
  const mixed = helper().cost(rows);
  assert.match(mixed.provenance, /用户自填价 1 次/); assert.match(mixed.provenance, /旧参考表 1 次（未按官方现价复核）/);
  assert.match(mixed.provenance, /历史出处未记录 1 次/);
  assert.doesNotMatch(mixed.text, /官方价|套餐内/);
});

test("undefined completeness remains unknown even with both counters and true never promises a complete bill", () => {
  const app = helper();
  assert.match(app.coverage([row({ usageComplete: undefined })]), /1 次完整性未记录/);
  assert.match(app.coverage([row({ usageComplete: false })]), /1 次用量缺失或不完整/);
  assert.match(app.coverage([row({ inputTokens: undefined })]), /1 次用量缺失或不完整/);
  assert.equal(app.coverage([row()]), "已记录上游用量，不代表完整账单");
  assert.equal(app.coverage([]), "还没有调用记录");
  assert.doesNotMatch(app.coverage([row(), row({ usageComplete: undefined })]), /全部已计量/);
});

test("mixed known, missing, partial and subscription costs coexist with disjoint cost caveats", () => {
  const app = helper();
  assert.equal(app.cost([row({ costUsd: 0 })]).text, "已记录估算 $0.00");
  assert.equal(app.cost([row()]).text, "费用未知 · 1 次费用缺失");
  assert.equal(app.cost([]).text, "无调用");
  assert.equal(app.cost([row({ costNote: "subscription" })]).text, "订阅 · 1 次订阅调用，不计单次费用");
  for (const costUsd of [0, 1.25]) {
    const mixed = app.cost([row({ costUsd, usageComplete: false }), row(), row({ costNote: "subscription" })]);
    assert.match(mixed.text, /已记录估算/); assert.match(mixed.text, /另有 1 次费用缺失/);
    assert.match(mixed.text, /已记录金额中 1 次费用或用量信息不完整/); assert.match(mixed.text, /1 次订阅调用，不计单次费用/);
    assert.doesNotMatch(mixed.text, /2 次费用缺失|套餐内|包月/);
  }
  assert.match(app.cost([row(), row({ costNote: "subscription" })]).text, /^费用未知 · 1 次费用缺失 · 1 次订阅调用/);
  assert.match(app.cost([row({ costUsd: 0 }), row({ costNote: "subscription" })]).text, /^已记录估算 \$0\.00 · 1 次订阅调用/);
});

test("tiny positive costs cannot round to zero in USD, CNY or chart precision; conversion is display only", () => {
  const app = helper(), rows = [row({ costUsd: 0.00000001 })], before = JSON.stringify(rows);
  assert.equal(app.cost(rows).value, "小于 $0.001");
  assert.equal(app.cost(rows, { currency: "CNY", usdToCny: 8 }).value, "小于 ¥0.001");
  assert.equal(app.run('usageMoney(0.001, {currency:"USD"}, 2)'), "小于 $0.01");
  assert.equal(app.run('usageMoney(0, {currency:"USD"})'), "$0.00");
  assert.equal(app.run('usageMoney(1, {currency:"CNY",usdToCny:8})'), "¥8.00");
  assert.match(app.run('usageDisplayLimits({currency:"CNY",usdToCny:8})'), /按设置汇率 1 USD = 8 CNY 换算，非实时汇率/);
  assert.match(app.run('usageDisplayLimits({currency:"USD"})'), /金额以 USD 记录/);
  assert.match(app.run('usageDisplayLimits({})'), /50,000 行；无法解析的行会跳过，不代表完整历史/);
  assert.equal(JSON.stringify(rows), before);
});

test("display summary cannot change budget counters, historical inputs, or local-calendar range semantics", () => {
  const rows = [row({ costUsd: 1, usageComplete: false }), row({ costUsd: 0, usageComplete: undefined }), row(), row({ costNote: "subscription" })];
  const before = JSON.stringify(rows), start = new Date(NOW), end = new Date(NOW);
  start.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1); end.setHours(0, 0, 0, 0);
  const budget = summarizeBudgetEntries(rows, start, end, NOW);
  summarizeRows(rows);
  assert.deepEqual(summarizeBudgetEntries(rows, start, end, NOW), budget);
  assert.equal(budget.estimatedCostUsd, 1); assert.equal(budget.unknownCostCalls, 2);
  assert.equal(JSON.stringify(rows), before);
  for (const [range, days] of [["today", 1], ["7d", 7], ["30d", 30]] as const) {
    const result = summarize([], range, NOW);
    assert.equal(result.days.length, days); assert.equal(rangeStart(range, NOW)!.getHours(), 0);
    assert.ok(result.days.every(day => day.recordedCostCalls === 0 && day.calls === 0));
    assert.equal(result.days.at(-1)!.day, "2026-10-08");
  }
});

test("explicit unpriced history remains uncertain even when it carries a recorded subtotal", () => {
  const app = helper();
  for (const usageComplete of [true, false, undefined]) {
    const rows = [row({ costUsd: 0.5, costNote: "unpriced", usageComplete })];
    const t = summarizeRows(rows).totals;
    assert.equal(t.costUsd, 0.5); assert.equal(t.recordedCostCalls, 1);
    assert.equal(t.partialCostCalls, 1); assert.equal(t.missingCostCalls, 0);
    assert.match(app.cost(rows).text, /已记录估算 \$0\.500 · 已记录金额中 1 次费用或用量信息不完整/);
  }
  const metadata = { schemaVersion: 1, basis: "log-time-config", tariffVerification: "not-established", wholeBillCoverage: "not-established", estimator: "none" } as const;
  const unpriced = row({ costUsd: 0.5, pricingProvenance: { ...metadata, source: "unpriced", reason: "rates-unavailable" } });
  assert.equal(summarizeRows([unpriced]).totals.partialCostCalls, 1);
  assert.match(app.cost([unpriced]).provenance, /记录为未定价 1 次/); assert.doesNotMatch(app.cost([unpriced]).provenance, /历史出处未记录/);
  const subscription = row({ costUsd: 0.5, costNote: "subscription", pricingProvenance: { ...metadata, source: "subscription" } });
  assert.match(app.cost([subscription]).text, /已记录估算 \$0\.500/);
  assert.match(app.cost([subscription]).provenance, /记录为订阅 1 次/); assert.doesNotMatch(app.cost([subscription]).provenance, /历史出处未记录/);
});
