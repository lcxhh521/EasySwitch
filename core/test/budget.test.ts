import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProviderBudgetController, migrateProviderBudget, monthStart, monthWindow, validateProviderBudget } from "../src/budget.ts";
import { Ledger } from "../src/ledger.ts";
import type { GatewayLogEntry, Provider } from "../src/types.ts";

const NOW = new Date(2026, 9, 6, 12);
const provider = (budget?: Provider["budget"], id = "x"): Pick<Provider, "id" | "budget"> => ({ id, ...(budget ? { budget } : {}) });
const entry = (over: Partial<GatewayLogEntry> = {}): GatewayLogEntry => ({ at: NOW.toISOString(), providerId: "x", model: "x/m", route: "chat-translate", status: 200, ms: 1, inputTokens: 10, outputTokens: 10, costUsd: 1, ...over });
function fixture(t: { after(fn: () => void): void }, now: () => Date = () => NOW) {
  const dir = mkdtempSync(join(tmpdir(), "es-source-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(dir);
  const budget = new ProviderBudgetController({ readSummary: (start, end, now) => ledger.budgetSummary(start, end, now), now });
  return { dir, ledger, budget };
}

test("source budgets accumulate separately, warn from 80%, and stop at 100% only when configured", t => {
  const { ledger, budget } = fixture(t);
  assert.equal(budget.budgetStatus(provider()), undefined);
  assert.equal(budget.isBudgetStopped(provider()), false);
  ledger.append(entry({ costUsd: 3.9 })); ledger.append(entry({ costUsd: 0.2 }));
  ledger.append(entry({ providerId: "other", costUsd: 99 }));
  assert.equal(budget.spentThisMonth("x"), 4.1);
  assert.equal(budget.budgetStatus(provider({ monthlyUsd: 10 }))!.level, "ok");
  ledger.append(entry({ costUsd: 3.9 }));
  assert.equal(budget.budgetStatus(provider({ monthlyUsd: 10 }))!.level, "near");
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 10, stop: true })), false);
  ledger.append(entry({ costUsd: 2 }));
  const over = budget.budgetStatus(provider({ monthlyUsd: 10, stop: true }))!;
  assert.equal(over.level, "over"); assert.equal(over.ratio, 1); assert.equal(over.spent, 10);
  assert.equal(over.blocked, true);
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 10 })), false);
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 10, stop: false })), false);
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 11, stop: true })), false);
  assert.equal(budget.isBudgetStopped(provider()), false, "removing the budget restores the source");
});

test("source accounting is durable across restart, and controllers never share provider totals", t => {
  const a = fixture(t), b = fixture(t);
  a.ledger.append(entry({ costUsd: 12 })); b.ledger.append(entry({ costUsd: 2 }));
  const p = provider({ monthlyUsd: 10, stop: true });
  assert.equal(a.budget.isBudgetStopped(p), true);
  assert.equal(b.budget.isBudgetStopped(p), false);
  const restart = new ProviderBudgetController({ readEntries: since => new Ledger(a.dir).readForBudget(since), now: () => NOW });
  assert.equal(restart.spentThisMonth("x"), 12);
  a.ledger.append(entry({ costUsd: 1 }));
  assert.equal(restart.spentThisMonth("x"), 13, "decisions read current durable entries instead of a startup snapshot");
  assert.equal(b.budget.spentThisMonth("x"), 2);
});

test("source months use local calendar boundaries, reset across years, and ignore stale or future entries", t => {
  let now = new Date(2026, 11, 31, 23, 59, 59);
  const { ledger, budget } = fixture(t, () => now);
  assert.deepEqual(monthWindow(now), { start: new Date(2026, 11, 1), end: new Date(2027, 0, 1) });
  assert.equal(monthStart(now).getDate(), 1);
  ledger.append(entry({ at: new Date(2026, 10, 30, 23, 59, 59).toISOString(), costUsd: 50 }));
  ledger.append(entry({ at: now.toISOString(), costUsd: 2 }));
  ledger.append(entry({ at: new Date(2027, 0, 1).toISOString(), costUsd: 3 }));
  ledger.append(entry({ at: new Date(2027, 0, 2).toISOString(), costUsd: 90 }));
  const p = provider({ monthlyUsd: 2, stop: true });
  const old = budget.budgetStatus(p)!;
  assert.equal(old.spent, 2); assert.equal(old.blocked, true);
  assert.equal(old.startsAt, new Date(2026, 11, 1).toISOString());
  assert.equal(old.resetsAt, new Date(2027, 0, 1).toISOString());
  assert.equal(old.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  now = new Date(2027, 0, 1, 0, 0, 1);
  assert.equal(budget.spentThisMonth("x"), 3, "past month clears and future January entries still do not count");
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 4, stop: true })), false);
});

test("local source months remain distinct from UTC month boundaries", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try {
    const now = new Date("2026-10-01T00:30:00Z");
    const budget = new ProviderBudgetController({ now: () => now, readEntries: () => [entry({ at: "2026-09-30T23:00:00Z", costUsd: 7 })] });
    const s = budget.budgetStatus(provider({ monthlyUsd: 10 }))!;
    assert.equal(s.spent, 7);
    assert.equal(s.startsAt, "2026-09-01T07:00:00.000Z");
    assert.equal(s.resetsAt, "2026-10-01T07:00:00.000Z");
    assert.equal(s.timezone, "America/Los_Angeles");
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
});

test("subscription fees are excluded and unknown prices or usage are disclosed rather than counted as zero", t => {
  const { ledger, budget } = fixture(t);
  ledger.append(entry());
  ledger.append(entry({ costUsd: 99, costNote: "subscription" }));
  ledger.append(entry({ costUsd: undefined, costNote: "unpriced" }));
  ledger.append(entry({ costUsd: undefined, inputTokens: undefined, outputTokens: undefined }));
  ledger.append(entry({ costUsd: 2, outputTokens: undefined }));
  const s = budget.budgetStatus(provider({ monthlyUsd: 10, stop: true }))!;
  assert.equal(s.spent, 3); assert.equal(s.unknownCostCalls, 3);
  assert.equal(s.blocked, false); assert.equal(s.accountingUnavailable, false);
  assert.match(s.warning!, /缺少价格或用量/); assert.match(s.limitations, /正在进行/);
});

test("legacy exposed model names identify a source, while explicit provider IDs take precedence", t => {
  const { ledger, budget } = fixture(t);
  ledger.append(entry({ providerId: undefined, model: "x/model/with/slashes", costUsd: 2 }));
  ledger.append(entry({ providerId: "y", model: "x/m", costUsd: 3 }));
  ledger.append(entry({ providerId: undefined, model: "native", costUsd: undefined }));
  assert.equal(budget.spentThisMonth("x"), 2);
  assert.equal(budget.spentThisMonth("y"), 3);
});

test("strict source budgets retain entries older than the console's 50k view", t => {
  const { dir, ledger, budget } = fixture(t);
  const file = join(dir, "usage.jsonl");
  writeFileSync(file, `${JSON.stringify(entry({ costUsd: 10 }))}\n${`${JSON.stringify(entry({ costUsd: 0 }))}\n`.repeat(50_000)}`);
  assert.equal(ledger.read().length, 50_000);
  assert.equal(budget.spentThisMonth("x"), 10);
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 10, stop: true })), true);
});

test("a partial tail waits for completion, while a complete corrupt row or missing ledger stops configured sources", t => {
  const { dir, ledger, budget } = fixture(t);
  ledger.append(entry());
  const file = join(dir, "usage.jsonl");
  appendFileSync(file, '{"at":"torn');
  const partial = budget.budgetStatus(provider({ monthlyUsd: 10, stop: true }))!;
  assert.equal(partial.pendingPartialLine, true); assert.equal(partial.accountingUnavailable, false); assert.equal(partial.blocked, false);
  assert.match(partial.warning!, /尚未写完整/);
  appendFileSync(file, '\n');
  const stopped = budget.budgetStatus(provider({ monthlyUsd: 10, stop: true }))!;
  assert.equal(stopped.accountingUnavailable, true); assert.equal(stopped.blocked, true);
  assert.match(stopped.warning!, /无法完整读取/);
  assert.throws(() => budget.spentThisMonth("x"), /incomplete/);
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 10, stop: false })), false);
  assert.equal(budget.budgetStatus(provider({ monthlyUsd: 10 }))!.accountingUnavailable, true);
  assert.equal(budget.budgetStatus(provider()), undefined);
  rmSync(file);
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 10, stop: true })), true);
  writeFileSync(file, `${JSON.stringify(entry())}\n`);
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 10, stop: true })), false, "repairing a read failure restores accounting");
});

test("failed durable appends stop budgets while unavailable and retry once the file becomes writable", t => {
  const { dir, ledger, budget } = fixture(t);
  const file = join(dir, "usage.jsonl");
  rmSync(file); mkdirSync(file);
  ledger.append(entry());
  assert.equal(budget.budgetStatus(provider({ monthlyUsd: 10, stop: true }))!.accountingUnavailable, true);
  rmSync(file, { recursive: true }); writeFileSync(file, "");
  assert.equal(budget.budgetStatus(provider({ monthlyUsd: 10, stop: true }))!.accountingUnavailable, false);
  assert.equal(budget.isBudgetStopped(provider({ monthlyUsd: 10, stop: true })), false);
  assert.equal(budget.spentThisMonth("x"), 1);
  assert.equal(budget.spentThisMonth("x"), 1, "rechecking does not duplicate the recovered entry");
});

test("malformed persisted source budgets fail closed instead of being treated as unset", t => {
  const { budget } = fixture(t);
  for (const value of [null, {}, [], { monthlyUsd: -1 }, { monthlyUsd: NaN }, { monthlyUsd: Infinity }, { monthlyUsd: 1_000_001 }, { monthlyUsd: "10" }, { monthlyUsd: 10, stop: "false" }, { monthlyUsd: 10, typo: true }, { monthlyUsd: 0, stop: "false" }]) {
    assert.throws(() => validateProviderBudget(value));
    const invalid = { id: "x", budget: value } as unknown as Pick<Provider, "id" | "budget">;
    const s = budget.budgetStatus(invalid)!;
    assert.equal(s.configurationInvalid, true); assert.equal(s.blocked, true);
    assert.equal(budget.isBudgetStopped(invalid), true);
    assert.match(s.warning!, /重新保存或移除/);
  }
  assert.deepEqual(validateProviderBudget({ monthlyUsd: 5 }), { monthlyUsd: 5 });
  assert.deepEqual(validateProviderBudget({ monthlyUsd: 5, stop: false }), { monthlyUsd: 5, stop: false });
  assert.deepEqual(validateProviderBudget({ monthlyUsd: 1_000_000, stop: true }), { monthlyUsd: 1_000_000, stop: true });
});

test("legacy source budget zero migrates to unset without weakening malformed or positive budgets", t => {
  const { budget } = fixture(t);
  for (const value of [{ monthlyUsd: 0 }, { monthlyUsd: 0, stop: true }, { monthlyUsd: 0, stop: false }]) {
    assert.deepEqual(migrateProviderBudget(value), { version: 1 });
    assert.equal(budget.budgetStatus(provider(value)), undefined);
    assert.equal(budget.isBudgetStopped(provider(value)), false);
  }
  assert.deepEqual(migrateProviderBudget({ monthlyUsd: 5, stop: true }), { version: 1, budget: { monthlyUsd: 5, stop: true } });
  assert.throws(() => migrateProviderBudget({ monthlyUsd: 0, unexpected: true }));
  assert.throws(() => validateProviderBudget({ monthlyUsd: 0 }), "new controls still require removal rather than a hidden zero setting");
});

test("invalid injected accounting cannot lower source spend or silently permit a stop budget", () => {
  for (const bad of [entry({ at: "invalid" }), entry({ costUsd: -100 }), entry({ costUsd: Infinity }), entry({ costUsd: NaN }), { ...entry(), providerId: 7 }, { ...entry(), costUsd: "2" }, { ...entry(), costNote: "unknown" }, null, []]) {
    const budget = new ProviderBudgetController({ now: () => NOW, readEntries: () => [entry({ costUsd: 8 }), bad] as GatewayLogEntry[] });
    const s = budget.budgetStatus(provider({ monthlyUsd: 10, stop: true }))!;
    assert.equal(s.spent, 8); assert.equal(s.accountingUnavailable, true); assert.equal(s.blocked, true);
  }
  const missing = new ProviderBudgetController({ now: () => NOW, readEntries: () => undefined as unknown as GatewayLogEntry[] });
  assert.equal(missing.isBudgetStopped(provider({ monthlyUsd: 10, stop: true })), true);
});

test("unattributable legacy costs are disclosed without stopping unrelated sources; overflow still fails closed", () => {
  const unattributable = new ProviderBudgetController({ now: () => NOW, readEntries: () => [entry({ providerId: undefined, model: "unattributable", costUsd: 1 })] });
  const legacy = unattributable.budgetStatus(provider({ monthlyUsd: 10, stop: true }))!;
  assert.equal(legacy.blocked, false); assert.equal(legacy.unattributedCalls, 1); assert.equal(legacy.unattributedCostUsd, 1);
  assert.match(legacy.warning!, /无法确定来源/);
  const overflow = new ProviderBudgetController({ now: () => NOW, readEntries: () => [entry({ costUsd: Number.MAX_VALUE }), entry({ costUsd: Number.MAX_VALUE })] });
  const s = overflow.budgetStatus(provider({ monthlyUsd: Number.MIN_VALUE, stop: true }))!;
  assert.equal(s.accountingUnavailable, true); assert.equal(s.blocked, true);
  assert.ok(Number.isFinite(s.spent)); assert.ok(Number.isFinite(s.ratio));
  assert.equal(JSON.parse(JSON.stringify(s)).spent, Number.MAX_VALUE);
});
