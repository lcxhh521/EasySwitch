import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BudgetController, BudgetExceededError, DEFAULT_BUDGET, budgetWindow, validateBudgetSettings } from "../src/global-budget.ts";
import type { GatewayLogEntry } from "../src/types.ts";
import { Ledger } from "../src/ledger.ts";

const NOW = new Date("2026-10-06T12:00:00Z");
const entry = (over: Partial<GatewayLogEntry> = {}): GatewayLogEntry => ({ at: NOW.toISOString(), model: "p/m", route: "chat-translate", status: 200, ms: 1, inputTokens: 10, outputTokens: 10, costUsd: 1, ...over });
function fixture(t: { after(fn: () => void): void }, readEntries: () => GatewayLogEntry[] = () => []) {
  const dir = mkdtempSync(join(tmpdir(), "es-budget-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, budget: new BudgetController(dir, { readEntries, now: () => NOW }) };
}

test("budgets default off; validated settings persist separately with restricted permissions", t => {
  const { dir, budget } = fixture(t);
  assert.deepEqual(budget.settings(), DEFAULT_BUDGET);
  assert.equal(budget.assertAllowed().blocked, false);
  const settings = { enabled: true, limitUsd: 20, period: "day", action: "stop", warnAt: 0.75 } as const;
  budget.setSettings(settings);
  assert.deepEqual(new BudgetController(dir, { readEntries: () => [] }).settings(), settings);
  const persisted = JSON.parse(readFileSync(join(dir, "budget.json"), "utf8"));
  assert.equal(persisted.version, 1);
  assert.deepEqual(persisted.settings, settings);
  assert.equal(statSync(join(dir, "budget.json")).mode & 0o777, 0o600);
});

test("budget stop rejects before a mock upstream is called; warn continues", t => {
  let entries = [entry({ costUsd: 7.99 })], upstreamCalls = 0;
  const { budget } = fixture(t, () => entries);
  budget.setSettings({ ...DEFAULT_BUDGET, enabled: true, limitUsd: 10, action: "stop" });
  const request = () => { budget.assertAllowed(); upstreamCalls++; };
  assert.equal(budget.status().warning, undefined);
  entries.push(entry({ costUsd: 0.01 }));
  assert.equal(budget.status().warning, "已接近估算预算");
  request();
  entries.push(entry({ costUsd: 2 }));
  assert.throws(request, BudgetExceededError);
  assert.equal(upstreamCalls, 1);
  assert.equal(budget.status().remainingUsd, 0);
  budget.setSettings({ ...budget.settings(), action: "warn" });
  request();
  assert.equal(upstreamCalls, 2);
  assert.equal(budget.status().exceeded, true);
});

test("unknown cost is not zero and subscription fees are excluded explicitly", t => {
  const { budget } = fixture(t, () => [
    entry(), entry({ costUsd: undefined, costNote: "unpriced" }),
    entry({ costUsd: undefined, inputTokens: undefined, outputTokens: undefined }),
    entry({ costNote: "subscription", costUsd: 99 }),
  ]);
  budget.setSettings({ ...DEFAULT_BUDGET, enabled: true });
  const status = budget.status();
  assert.equal(status.estimatedCostUsd, 1);
  assert.equal(status.calls, 4);
  assert.equal(status.unpricedCalls, 2);
  assert.equal(status.unmeteredCalls, 1);
  assert.equal(status.unknownCostCalls, 2);
  assert.equal(status.subscriptionCalls, 1);
  assert.match(status.warning!, /缺少价格或用量/);
  assert.match(status.limitations, /正在进行/);
});

test("UTC windows survive month/year rollover and do not count stale or future entries", t => {
  assert.deepEqual(budgetWindow("month", new Date("2026-12-31T23:59:59Z")), { start: new Date("2026-12-01Z"), end: new Date("2027-01-01Z") });
  assert.deepEqual(budgetWindow("day", new Date("2026-12-31T23:59:59Z")), { start: new Date("2026-12-31Z"), end: new Date("2027-01-01Z") });
  const { budget } = fixture(t, () => [entry({ at: "2026-09-30T23:59:59Z", costUsd: 99 }), entry(), entry({ at: "2026-10-06T13:00:00Z", costUsd: 99 })]);
  budget.setSettings({ ...DEFAULT_BUDGET, enabled: true, period: "day" });
  assert.equal(budget.status().estimatedCostUsd, 1);
  assert.equal(budget.status().resetsAt, "2026-10-07T00:00:00.000Z");
});

test("corrupt budget configuration and unavailable accounting fail closed until repaired", t => {
  const { dir } = fixture(t);
  rmSync(join(dir, "budget-control.json"));
  writeFileSync(join(dir, "budget.json"), '{"enabled":true');
  const budget = new BudgetController(dir, { readEntries: () => [], now: () => NOW });
  assert.equal(budget.status().configurationInvalid, true);
  assert.throws(() => budget.assertAllowed(), BudgetExceededError);
  budget.setSettings(DEFAULT_BUDGET);
  assert.equal(budget.assertAllowed().blocked, false);
  const broken = new BudgetController(dir, { readEntries: () => { throw new Error("mock ledger failure"); } });
  broken.setSettings({ ...DEFAULT_BUDGET, enabled: true, action: "stop" });
  assert.equal(broken.status().accountingUnavailable, true);
  assert.throws(() => broken.assertAllowed(), BudgetExceededError);
  broken.setSettings({ ...broken.settings(), action: "warn" });
  assert.equal(broken.assertAllowed().blocked, false);
});

test("negative costs cannot lower the total and invalid timestamps make accounting incomplete", t => {
  const { budget } = fixture(t, () => [entry({ costUsd: 8 }), entry({ costUsd: -100 }), entry({ at: "invalid" })]);
  budget.setSettings({ ...DEFAULT_BUDGET, enabled: true, action: "stop" });
  assert.equal(budget.status().estimatedCostUsd, 8);
  assert.equal(budget.status().unpricedCalls, 0, "invalid amounts are corrupt accounting, not legitimate unknown-price calls");
  assert.equal(budget.status().accountingUnavailable, true);
  assert.throws(() => budget.assertAllowed(), BudgetExceededError);
});

test("zero is an immediate stop and invalid settings do not mutate a valid budget", t => {
  const { budget } = fixture(t);
  const settings = { ...DEFAULT_BUDGET, enabled: true, limitUsd: 0, action: "stop" };
  budget.setSettings(settings);
  assert.throws(() => budget.assertAllowed(), BudgetExceededError);
  for (const value of [null, {}, { ...settings, enabled: "false" }, { ...settings, limitUsd: NaN }, { ...settings, limitUsd: -1 }, { ...settings, warnAt: 0 }, { ...settings, warnAt: 2 }, { ...settings, action: "ignore" }, { ...settings, period: "forever" }, { ...settings, typo: 1 }]) {
    assert.throws(() => validateBudgetSettings(value));
    assert.throws(() => budget.setSettings(value));
    assert.deepEqual(budget.settings(), settings);
  }
});

test("strict budget ledger does not truncate at 50k and distinguishes partial from complete corrupt lines", t => {
  const { dir } = fixture(t);
  const ledger = new Ledger(dir);
  assert.deepEqual(ledger.readForBudget(), []);
  const file = join(dir, "usage.jsonl");
  writeFileSync(file, `${JSON.stringify(entry())}\n`.repeat(50_001));
  assert.equal(ledger.read().length, 50_000);
  assert.equal(ledger.readForBudget().length, 50_001);
  appendFileSync(file, '{"at":"torn');
  assert.equal(ledger.readForBudget().length, 50_001);
  appendFileSync(file, '\n');
  assert.throws(() => ledger.readForBudget());
  assert.equal(ledger.read().length, 49_999, "forgiving display view remains unchanged");
  writeFileSync(file, '{"at":"invalid-date"}\n');
  assert.throws(() => ledger.readForBudget(), /invalid entry/);
  writeFileSync(file, `${JSON.stringify(entry({ costUsd: -1 }))}\n`);
  assert.throws(() => ledger.readForBudget(), /invalid entry or amount/);
  writeFileSync(file, `${JSON.stringify({ ...entry(), costUsd: "100" })}\n`);
  assert.throws(() => ledger.readForBudget(), /invalid entry or amount/);
  rmSync(file);
  assert.throws(() => ledger.readForBudget());
});

test("a failed ledger write remains visible until the queued row is durably recovered", t => {
  const { dir } = fixture(t);
  const ledger = new Ledger(dir);
  const file = join(dir, "usage.jsonl");
  rmSync(file); mkdirSync(file);
  ledger.append(entry());
  assert.throws(() => ledger.readForBudget(), /incomplete/);
  rmSync(file, { recursive: true }); writeFileSync(file, "");
  assert.equal(ledger.readForBudget().length, 1);
  const budget = new BudgetController(dir, { readEntries: since => ledger.readForBudget(since), now: () => NOW });
  budget.setSettings({ ...DEFAULT_BUDGET, enabled: true, action: "stop" });
  assert.equal(budget.assertAllowed().estimatedCostUsd, 1);
});

test("legacy global settings migrate with an exact backup and retain an active zero-dollar stop", t => {
  const { dir } = fixture(t);
  const old = { ...DEFAULT_BUDGET, enabled: true, action: "stop", limitUsd: 0 };
  const raw = `${JSON.stringify(old)}\n`;
  writeFileSync(join(dir, "budget.json"), raw);
  const budget = new BudgetController(dir, { readEntries: () => [] });
  assert.deepEqual(budget.settings(), old);
  assert.throws(() => budget.assertAllowed(), BudgetExceededError, "global zero never had the old per-source disabled meaning");
  const backups = readdirSync(dir).filter(name => name.startsWith("budget.v0."));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(dir, backups[0]!), "utf8"), raw);
  const upgraded = JSON.parse(readFileSync(join(dir, "budget.json"), "utf8"));
  assert.equal(upgraded.version, 1); assert.deepEqual(upgraded.settings, old);
});

test("damaged disabled settings warn without stopping inference, but active or unknown controls remain fail-closed", t => {
  const { dir, budget } = fixture(t);
  budget.setSettings(DEFAULT_BUDGET);
  writeFileSync(join(dir, "budget.json"), "broken json");
  let restored = new BudgetController(dir, { readEntries: () => [] });
  assert.equal(restored.status().configurationInvalid, true);
  assert.equal(restored.assertAllowed().blocked, false);
  assert.match(restored.status().warning!, /仍为关闭/);
  writeFileSync(join(dir, "budget.json"), JSON.stringify({ version: 99, settings: DEFAULT_BUDGET }));
  assert.throws(() => new BudgetController(dir, { readEntries: () => [] }).assertAllowed(), BudgetExceededError, "an unsupported schema cannot use the ordinary corrupt-disabled exemption");
  restored.setSettings({ ...DEFAULT_BUDGET, enabled: true, action: "stop" });
  writeFileSync(join(dir, "budget.json"), "broken again");
  restored = new BudgetController(dir, { readEntries: () => [] });
  assert.throws(() => restored.assertAllowed(), BudgetExceededError);
  rmSync(join(dir, "budget.json"));
  assert.throws(() => new BudgetController(dir, { readEntries: () => [] }).assertAllowed(), BudgetExceededError);
  rmSync(join(dir, "budget-control.json"));
  writeFileSync(join(dir, "budget.json"), JSON.stringify({ enabled: false, limitUsd: "broken" }));
  restored = new BudgetController(dir, { readEntries: () => [] });
  assert.equal(restored.assertAllowed().blocked, false);
  assert.equal(restored.status().configurationInvalid, true);
  writeFileSync(join(dir, "budget.json"), JSON.stringify({ version: 99, settings: DEFAULT_BUDGET }));
  assert.throws(() => new BudgetController(dir, { readEntries: () => [] }).assertAllowed(), BudgetExceededError);
});

test("a never-enabled budget preserves its default off state if its saved settings later become unreadable", t => {
  const { dir } = fixture(t);
  writeFileSync(join(dir, "budget.json"), "damaged before the first settings edit");
  const restored = new BudgetController(dir, { readEntries: () => [] });
  assert.equal(restored.status().configurationInvalid, true);
  assert.equal(restored.settings().enabled, false);
  assert.equal(restored.assertAllowed().blocked, false);
});
