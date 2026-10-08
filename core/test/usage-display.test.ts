import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { rangeStart, summarize, summarizeBudgetEntries, UsageRangeTooLargeError } from "../src/ledger.ts";
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

function withTimezone(zone: string, run: () => void): void {
  const previous = process.env.TZ;
  try { process.env.TZ = zone; run(); }
  finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
}

function assertUsagePartitions(summary: ReturnType<typeof summarize>): void {
  for (const parts of [summary.days, Object.values(summary.byProvider), Object.values(summary.byHarness), Object.values(summary.byKey)]) {
    for (const [field, expected] of Object.entries(summary.totals)) {
      if (field === "pricingSources") {
        for (const source of Object.keys(summary.totals.pricingSources) as Array<keyof typeof summary.totals.pricingSources>) {
          assert.equal(parts.reduce((sum, part) => sum + part.pricingSources[source], 0), summary.totals.pricingSources[source]);
        }
      } else {
        const actual = parts.reduce((sum, part) => sum + (part[field as keyof typeof summary.totals] as number), 0);
        assert.ok(Math.abs(actual - (expected as number)) < 1e-9, `${field}: ${actual} != ${expected}`);
      }
    }
  }
}

for (const zone of ["UTC", "Asia/Shanghai", "America/New_York"]) test(`usage ranges share inclusive local boundaries and every grouping in ${zone}`, () => withTimezone(zone, () => {
  const now = new Date(2026, 0, 2, 0, 0, 0, 5);
  for (const [range, count] of [["today", 1], ["7d", 7], ["30d", 30]] as const) {
    const start = rangeStart(range, now)!;
    const included = [start.getTime(), now.getTime() - 1, now.getTime()].map((at, index) => row({
      at: new Date(at).toISOString(), providerId: `source-${index}`, harness: `agent-${index}`, keyId: `key-${index}`,
      inputTokens: 10 + index, outputTokens: 2 + index, cachedTokens: index, costUsd: [0.1, 0.2, 0.3][index], status: index === 1 ? 502 : 200,
    }));
    const excluded = [new Date(start.getTime() - 1).toISOString(), new Date(now.getTime() + 1).toISOString(), "invalid", "", null, 0]
      .map(at => row({ at: at as string, providerId: "excluded", harness: "excluded", keyId: "excluded", costUsd: 100 }));
    const entries = [excluded[0]!, included[2]!, ...excluded.slice(1), included[0]!, included[1]!], before = JSON.stringify(entries);
    const summary = summarize(entries, range, now);
    assert.deepEqual(summary, summarize([included[2]!, included[0]!, included[1]!], range, now));
    assert.equal(summary.days.length, count); assert.equal(summary.totals.calls, 3);
    assert.equal(summary.days.at(-1)!.day, "2026-01-02"); assert.equal(summary.byProvider.excluded, undefined);
    assertUsagePartitions(summary); assert.equal(JSON.stringify(entries), before);
  }
}));

test("all uses the earliest included local day without sorting records or changing amounts", () => {
  const now = new Date(2026, 9, 8, 12), earliest = new Date(2026, 8, 30, 23);
  const entries = [row({ at: now.toISOString(), costUsd: 1e16 }), row({ at: "invalid" }),
    row({ at: earliest.toISOString(), costUsd: 1 }), row({ at: new Date(2026, 9, 3).toISOString(), costUsd: 1 }),
    row({ at: new Date(now.getTime() + 1).toISOString(), costUsd: 20 })];
  const before = JSON.stringify(entries), summary = summarize(entries, "all", now);
  assert.equal(summary.days[0]!.day, "2026-09-30"); assert.equal(summary.days.at(-1)!.day, "2026-10-08");
  assert.equal(summary.days.length, 9); assert.equal(summary.totals.calls, 3);
  assert.equal(summary.totals.costUsd, 1e16, "retain original iteration order and floating-point addition");
  assert.equal(JSON.stringify(entries), before);
});

test("empty, invalid-only and future-only all ranges keep today's empty slot until rows are due", () => {
  const now = new Date(2026, 9, 8, 0), future = row({ at: new Date(now.getTime() + 1).toISOString(), costUsd: 0.25 });
  const empty = summarize([], "all", now);
  assert.equal(empty.days.length, 1); assert.equal(empty.days[0]!.day, "2026-10-08"); assert.equal(empty.cacheHitRate, null);
  for (const rows of [[row({ at: "invalid" })], [future], [row({ at: "invalid" }), future]]) assert.deepEqual(summarize(rows, "all", now), empty);
  const due = summarize([future], "all", new Date(now.getTime() + 1));
  assert.equal(due.totals.calls, 1); assert.equal(due.totals.costUsd, 0.25); assertUsagePartitions(due);
  assert.throws(() => summarize([], "all", new Date(NaN)), RangeError);
});

for (const [month, day, hours] of [[2, 8, 23], [10, 1, 25]] as const) test(`usage local calendar handles a ${hours}-hour DST day without missing or duplicate slots`, () => withTimezone("America/New_York", () => {
  const midnight = new Date(2026, month, day), nextMidnight = new Date(2026, month, day + 1);
  assert.equal((nextMidnight.getTime() - midnight.getTime()) / 3_600_000, hours);
  const now = new Date(nextMidnight.getTime() - 1);
  const offsetEquivalent = new Date(midnight.getTime()).toISOString();
  const entries = [row({ at: offsetEquivalent }), row({ at: midnight.toString() }), row({ at: now.toISOString() }),
    row({ at: new Date(midnight.getTime() - 1).toISOString() }), row({ at: nextMidnight.toISOString() })];
  const today = summarize(entries, "today", now);
  assert.equal(today.totals.calls, 3); assert.equal(today.days.length, 1); assertUsagePartitions(today);
  for (const [range, count] of [["7d", 7], ["30d", 30]] as const) {
    const summary = summarize(entries, range, new Date(2026, month, day + 1, 12));
    assert.equal(summary.totals.calls, 5); assert.equal(summary.days.length, count);
    assert.equal(new Set(summary.days.map(d => d.day)).size, count); assertUsagePartitions(summary);
    const expected: string[] = [];
    for (let ago = count - 1; ago >= 0; ago--) {
      const d = new Date(2026, month, day + 1 - ago);
      expected.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
    assert.deepEqual(summary.days.map(d => d.day), expected);
  }
}));

test("all limits output to 10,000 local daily slots without truncating totals or retained rows", () => withTimezone("America/New_York", () => {
  const now = new Date(2026, 10, 2, 12), first = new Date(now);
  first.setDate(first.getDate() - 9_999); first.setHours(0, 0, 0, 0);
  const entries = [row({ at: now.toISOString() }), row({ at: first.toISOString() })];
  const allowed = summarize(entries, "all", now);
  assert.equal(allowed.days.length, 10_000); assert.equal(allowed.totals.calls, 2);
  const older = new Date(first); older.setDate(older.getDate() - 1);
  for (const at of [older.toISOString(), "0099-01-01T00:00:00Z", "-271821-04-20T00:00:00Z"]) {
    const rows = [row({ at }), ...entries], before = JSON.stringify(rows);
    assert.throws(() => summarize(rows, "all", now), error => error instanceof UsageRangeTooLargeError && error.code === "usage_range_too_large");
    for (const range of ["today", "7d", "30d"] as const) assert.equal(summarize(rows, range, now).totals.calls, 1);
    assert.equal(JSON.stringify(rows), before);
  }
}));
