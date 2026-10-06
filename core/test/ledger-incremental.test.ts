import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger } from "../src/ledger.ts";
import { BudgetController, DEFAULT_BUDGET } from "../src/global-budget.ts";
import { ProviderBudgetController } from "../src/budget.ts";
import type { GatewayLogEntry } from "../src/types.ts";

const NOW = new Date("2026-10-06T12:00:00Z"), START = new Date("2026-10-01Z"), END = new Date("2026-11-01Z");
const entry = (over: Partial<GatewayLogEntry> = {}): GatewayLogEntry => ({ at: NOW.toISOString(), providerId: "p", model: "p/m", route: "chat-translate", status: 200, ms: 1, inputTokens: 1, outputTokens: 1, costUsd: 1, ...over });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "es-ledger-incremental-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ledger = new Ledger(dir);
  return { dir, ledger, file: join(dir, "usage.jsonl"), summary: (now = NOW) => ledger.budgetSummary(START, END, now) };
}

test("200k-row accounting warms once; repeated global/source decisions parse and read no historical bytes", t => {
  const { dir, ledger, file } = fixture(t);
  const original = `${JSON.stringify(entry())}\n`.repeat(200_000);
  writeFileSync(file, original);
  const readSummary = (start: Date, end: Date, now: Date) => ledger.budgetSummary(start, end, now);
  const global = new BudgetController(dir, { readSummary, now: () => NOW });
  const source = new ProviderBudgetController({ readSummary, now: () => NOW });
  global.setSettings({ ...DEFAULT_BUDGET, enabled: true, limitUsd: 500_000, action: "stop" });
  const p = { id: "p", budget: { monthlyUsd: 500_000, stop: true } };
  assert.equal(global.status().estimatedCostUsd, 200_000);
  assert.equal(source.budgetStatus(p)!.spent, 200_000);
  const warm = ledger.budgetDiagnostics();
  const started = performance.now();
  for (let i = 0; i < 500; i++) {
    assert.equal(global.assertAllowed().blocked, false);
    assert.equal(source.isBudgetStopped(p), false);
  }
  t.diagnostic(`1000 warm budget decisions: ${Math.round(performance.now() - started)} ms; zero historical bytes/rows reread`);
  assert.deepEqual(ledger.budgetDiagnostics(), warm);
  assert.equal(warm.parsedLines, 200_000);
  ledger.append(entry({ costUsd: 2 }));
  assert.equal(global.status().estimatedCostUsd, 200_002);
  assert.equal(source.budgetStatus(p)!.spent, 200_002);
  assert.equal(ledger.budgetDiagnostics().parsedLines, 200_001);
  assert.ok(ledger.budgetDiagnostics().bytesRead - warm.bytesRead < 1024);
  assert.equal(readFileSync(file, "utf8").slice(0, original.length), original, "legacy rows are preserved byte-for-byte");
});

test("partial UTF-8 tail is held until newline, then counted once without re-reading its prefix", t => {
  const { ledger, file, summary } = fixture(t);
  ledger.append(entry());
  const line = Buffer.from(`${JSON.stringify(entry({ model: "p/模型", costUsd: 2 }))}\n`);
  const split = line.indexOf(Buffer.from("模")) + 1;
  appendFileSync(file, line.subarray(0, split));
  let current = summary();
  assert.equal(current.calls, 1); assert.equal(current.pendingPartialLine, true); assert.equal(current.accountingUnavailable, false);
  const partial = ledger.budgetDiagnostics();
  assert.deepEqual(summary(), current);
  assert.deepEqual(ledger.budgetDiagnostics(), partial);
  appendFileSync(file, line.subarray(split));
  current = summary();
  assert.equal(current.calls, 2); assert.equal(current.estimatedCostUsd, 3); assert.equal(current.pendingPartialLine, false);
  assert.equal(ledger.budgetDiagnostics().bytesRead - partial.bytesRead, line.length - split);
  assert.equal(summary().calls, 2);
});

test("an unrelated partial append is never overwritten or joined with an EasySwitch row", t => {
  const { ledger, file, summary } = fixture(t);
  const line = `${JSON.stringify(entry({ costUsd: 2 }))}\n`;
  appendFileSync(file, line.slice(0, 20));
  ledger.append(entry({ costUsd: 3 }));
  assert.equal(readFileSync(file, "utf8"), line.slice(0, 20));
  assert.equal(summary().accountingUnavailable, true, "our queued row has not become durable yet");
  appendFileSync(file, line.slice(20));
  assert.equal(summary().estimatedCostUsd, 5);
  assert.equal(summary().accountingUnavailable, false);
  assert.equal(summary().calls, 2);
});

test("pending journal recovers an interrupted main row after restart without duplicate billing", t => {
  const { dir, file } = fixture(t);
  const id = randomUUID(), row = entry({ costUsd: 4 });
  const line = `${JSON.stringify({ ledgerVersion: 1, ledgerId: id, ...row })}\n`;
  const journal = join(dir, "usage-pending", `${id}.json`);
  const stat = statSync(file);
  writeFileSync(journal, JSON.stringify({ version: 1, id, entry: row, attempt: { identity: `${stat.dev}/${stat.ino}`, offset: 0 } }));
  writeFileSync(file, line.slice(0, 57));
  const restarted = new Ledger(dir);
  assert.equal(restarted.budgetSummary(START, END, NOW).estimatedCostUsd, 4);
  assert.equal(readFileSync(file, "utf8"), line);
  assert.deepEqual(readdirSync(join(dir, "usage-pending")), []);
  // Simulate a crash after main append but before journal cleanup.
  writeFileSync(journal, JSON.stringify({ version: 1, id, entry: row }));
  const again = new Ledger(dir);
  assert.equal(again.budgetSummary(START, END, NOW).calls, 1);
  assert.equal(readFileSync(file, "utf8"), line);
  assert.deepEqual(again.readForBudget(), [row]);
});

test("transient writes replay from the pending journal and self-heal across restart", t => {
  const { dir, ledger, file, summary } = fixture(t);
  rmSync(file); mkdirSync(file);
  ledger.append(entry({ costUsd: 7 }));
  assert.equal(summary().accountingUnavailable, true);
  assert.equal(readdirSync(join(dir, "usage-pending")).length, 1);
  rmSync(file, { recursive: true }); writeFileSync(file, "");
  const restarted = new Ledger(dir);
  const recovered = restarted.budgetSummary(START, END, NOW);
  assert.equal(recovered.accountingUnavailable, false); assert.equal(recovered.estimatedCostUsd, 7);
  assert.equal(summary().estimatedCostUsd, 7, "the older instance also recognizes the committed retry id");
  assert.equal(summary().calls, 1);
});

test("complete malformed rows, unknown versions, conflicting ids and corrupted journals never fail open", t => {
  const { dir, ledger, file, summary } = fixture(t);
  const valid = `${JSON.stringify(entry())}\n`;
  writeFileSync(file, valid + "not-json\n");
  assert.equal(summary().accountingUnavailable, true);
  assert.throws(() => ledger.readForBudget());
  writeFileSync(file, valid);
  assert.equal(summary().accountingUnavailable, false);
  appendFileSync(file, `${JSON.stringify({ ...entry(), ledgerVersion: 99, ledgerId: randomUUID() })}\n`);
  assert.equal(summary().accountingUnavailable, true);
  const id = randomUUID();
  const row = (costUsd: number) => `${JSON.stringify({ ...entry({ costUsd }), ledgerVersion: 1, ledgerId: id })}\n`;
  writeFileSync(file, row(1) + row(2));
  assert.equal(summary().accountingUnavailable, true);
  writeFileSync(file, valid);
  const journal = join(dir, "usage-pending", `${randomUUID()}.json`);
  writeFileSync(journal, "broken journal");
  assert.equal(summary().accountingUnavailable, true);
  rmSync(journal);
  assert.equal(summary().accountingUnavailable, false);
});

test("replacement, missing files and clock rollback invalidate cached results safely", t => {
  const { dir, ledger, file, summary } = fixture(t);
  ledger.append(entry({ costUsd: 2 }));
  assert.equal(summary().estimatedCostUsd, 2);
  const replacement = join(dir, "replacement");
  writeFileSync(replacement, `${JSON.stringify(entry({ costUsd: 3 }))}\n`); renameSync(replacement, file);
  assert.equal(summary().estimatedCostUsd, 3);
  const before = readFileSync(file);
  rmSync(file);
  assert.equal(summary().accountingUnavailable, true);
  writeFileSync(file, before);
  assert.equal(summary().estimatedCostUsd, 3); assert.equal(summary().accountingUnavailable, false);
  assert.equal(summary(new Date(NOW.getTime() - 1)).estimatedCostUsd, 0);
  assert.equal(summary().estimatedCostUsd, 3);
});

test("future entries mature in timestamp order and unrelated legacy costs remain global-only", t => {
  const { ledger, summary } = fixture(t);
  ledger.append(entry({ at: new Date(NOW.getTime() + 3000).toISOString(), costUsd: 3 }));
  ledger.append(entry({ at: new Date(NOW.getTime() + 1000).toISOString(), costUsd: 1 }));
  ledger.append(entry({ at: new Date(NOW.getTime() + 2000).toISOString(), costUsd: 2 }));
  ledger.append(entry({ providerId: undefined, model: "unattributed", costUsd: 4 }));
  const start = summary();
  assert.equal(start.estimatedCostUsd, 4); assert.equal(start.unattributedCostUsd, 4); assert.equal(start.unattributedCalls, 1);
  assert.equal(start.byProvider.p, undefined); assert.equal(start.accountingUnavailable, false);
  const warm = ledger.budgetDiagnostics();
  assert.equal(summary(new Date(NOW.getTime() + 1000)).estimatedCostUsd, 5);
  assert.equal(summary(new Date(NOW.getTime() + 2000)).estimatedCostUsd, 7);
  assert.equal(summary(new Date(NOW.getTime() + 3000)).estimatedCostUsd, 10);
  assert.equal(summary(new Date(NOW.getTime() + 3000)).byProvider.p!.estimatedCostUsd, 6);
  assert.deepEqual(ledger.budgetDiagnostics(), warm);
});

test("complete orphan journal temps recover, while an unrecoverable partial journal remains explicit", t => {
  const { dir, summary } = fixture(t);
  const id = randomUUID(), row = entry({ costUsd: 2 });
  const temp = join(dir, "usage-pending", `${id}.json.tmp`);
  writeFileSync(temp, JSON.stringify({ version: 1, id, entry: row }));
  assert.equal(summary().estimatedCostUsd, 2);
  assert.equal(summary().accountingUnavailable, false);
  assert.deepEqual(readdirSync(join(dir, "usage-pending")), []);
  writeFileSync(temp, "half-written");
  assert.equal(summary().accountingUnavailable, true);
  assert.equal(summary().accountingUnavailable, true);
  rmSync(temp);
  assert.equal(summary().accountingUnavailable, false);
});

test("oversized partial corruption stays fail-closed on unchanged subsequent reads", t => {
  const { file, summary } = fixture(t);
  appendFileSync(file, "x".repeat(1_048_577));
  assert.equal(summary().accountingUnavailable, true);
  assert.equal(summary().accountingUnavailable, true);
  writeFileSync(file, `${JSON.stringify(entry())}\n`);
  assert.equal(summary().accountingUnavailable, false);
  assert.equal(summary().calls, 1);
});

test("a pre-journal crash-torn legacy tail preserves its bytes and permits new durable calls after restart", t => {
  const { dir, file } = fixture(t);
  const original = `${JSON.stringify(entry({ costUsd: 1 }))}\n{"at":"torn`;
  writeFileSync(file, original);
  const restarted = new Ledger(dir);
  assert.equal(restarted.budgetSummary(START, END, NOW).pendingPartialLine, true);
  restarted.append(entry({ costUsd: 2 }));
  const now = new Date(Math.max(Date.now() + 1000, NOW.getTime()));
  let summary = restarted.budgetSummary(new Date(0), new Date("2100-01-01Z"), now);
  assert.equal(summary.accountingUnavailable, false);
  assert.equal(summary.estimatedCostUsd, 3);
  assert.equal(summary.unknownCostCalls, 1);
  assert.equal(summary.calls, 3);
  assert.ok(readFileSync(file, "utf8").startsWith(`${original}\n`), "not one byte of the legacy file was replaced");
  const recoveryFiles = readdirSync(join(dir, "usage-recovered"));
  assert.equal(recoveryFiles.length, 1);
  const recovery = JSON.parse(readFileSync(join(dir, "usage-recovered", recoveryFiles[0]!), "utf8"));
  assert.equal(Buffer.from(recovery.tailBase64, "base64").toString(), '{"at":"torn');
  const again = new Ledger(dir);
  again.append(entry({ costUsd: 4 }));
  summary = again.budgetSummary(new Date(0), new Date("2100-01-01Z"), now);
  assert.equal(summary.accountingUnavailable, false); assert.equal(summary.estimatedCostUsd, 7); assert.equal(summary.unknownCostCalls, 1);
});

test("a recorded tail-recovery intent survives a crash before sealing and does not mask unrelated corruption", t => {
  const { dir, file } = fixture(t);
  const tail = Buffer.from('{"at":"torn');
  writeFileSync(file, tail);
  const sha256 = createHash("sha256").update(tail).digest("hex");
  const record = { version: 1, offset: 0, sha256, tailBase64: tail.toString("base64"), entry: entry({ providerId: undefined, model: "unattributed", costUsd: undefined, costNote: "unpriced" }) };
  const path = join(dir, "usage-recovered", `0-${sha256}.json`);
  writeFileSync(path, JSON.stringify(record));
  const restarted = new Ledger(dir);
  restarted.append(entry({ costUsd: 2 }));
  assert.equal(restarted.budgetSummary(START, END, NOW).accountingUnavailable, false);
  assert.equal(restarted.budgetSummary(START, END, NOW).estimatedCostUsd, 2);
  assert.equal(restarted.budgetSummary(START, END, NOW).unknownCostCalls, 1);
  appendFileSync(file, "different complete corrupt row\n");
  assert.equal(restarted.budgetSummary(START, END, NOW).accountingUnavailable, true);
});

test("corrupt recovery intent and complete invalid JSON schema cannot be silently converted to unknown cost", t => {
  const { dir, file } = fixture(t);
  const tail = Buffer.from('{"at":"torn');
  const sha256 = createHash("sha256").update(tail).digest("hex");
  const path = join(dir, "usage-recovered", `0-${sha256}.json.tmp`);
  writeFileSync(file, tail); writeFileSync(path, "partial recovery intent");
  const restarted = new Ledger(dir);
  restarted.append(entry());
  assert.equal(restarted.budgetSummary(START, END, NOW).accountingUnavailable, true);
  assert.equal(restarted.budgetSummary(START, END, NOW).accountingUnavailable, true);
  assert.deepEqual(readFileSync(file), tail);
  rmSync(path);
  writeFileSync(file, JSON.stringify(entry({ costUsd: -1 })));
  const bad = new Ledger(dir); bad.append(entry());
  assert.equal(bad.budgetSummary(START, END, NOW).accountingUnavailable, true);
  assert.deepEqual(readdirSync(join(dir, "usage-recovered")), []);
});

test("a transient partial recovery-intent write retries from its owned in-memory intent", t => {
  const { dir, file } = fixture(t);
  const originalTail = '{"at":"torn';
  writeFileSync(file, originalTail);
  const restarted = new Ledger(dir);
  const originalWrite = fs.writeFileSync;
  let injected = false;
  t.mock.method(fs, "writeFileSync", ((path, data, options) => {
    if (!injected && typeof path === "string" && path.includes("usage-recovered") && path.endsWith(".tmp")) {
      injected = true;
      originalWrite(path, '{"version":', options);
      throw Object.assign(new Error("fixture disk full"), { code: "ENOSPC" });
    }
    return originalWrite(path, data, options);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    restarted.append(entry({ costUsd: 2 }));
    assert.equal(injected, true);
    assert.equal(readFileSync(file, "utf8"), originalTail);
    assert.equal(restarted.budgetDiagnostics().pendingWrites, 1);
    const recovered = restarted.budgetSummary(new Date(0), new Date("2100-01-01Z"), new Date(Date.now() + 1000));
    assert.equal(recovered.accountingUnavailable, false);
    assert.equal(recovered.estimatedCostUsd, 2);
    assert.equal(recovered.unknownCostCalls, 1);
    assert.equal(restarted.budgetDiagnostics().pendingWrites, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("matching inode and EOF cannot authorize sealing a different tail written after construction", t => {
  const { dir, file } = fixture(t);
  const original = "          \n", later = '{"at":"torn';
  assert.equal(original.length, later.length);
  writeFileSync(file, original);
  const ledger = new Ledger(dir);
  writeFileSync(file, later);
  ledger.append(entry());
  assert.equal(readFileSync(file, "utf8"), later);
  assert.equal(ledger.budgetSummary(START, END, NOW).accountingUnavailable, true);
  assert.deepEqual(readdirSync(join(dir, "usage-recovered")), []);
});
