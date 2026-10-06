import assert from "node:assert/strict";
import fs, { mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { TaskAccounting, TaskAccountingError, TaskAccountingCapacityError, TASK_ACCOUNTING_CAPACITY } from "../src/task-accounting.ts";

const priced = (costUsd = 0.2) => ({ costUsd, inputTokens: 10, outputTokens: 5 });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-task-accounting-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "task-accounting.json"), book: new TaskAccounting(dir) };
}
function complete(book: TaskAccounting, id: string, costUsd = 0.2) {
  const call = book.beginCall(id); call.record(priced(costUsd)); call.end(); book.finishTask(id);
}

test("task accounting is versioned, private and keeps only ids, relationships, counters and estimates", t => {
  const { dir, file, book } = fixture(t);
  writeFileSync(join(dir, "usage.jsonl"), "unchanged usage\n"); writeFileSync(join(dir, "tasks.jsonl"), "unchanged tasks\n");
  book.beginTask("t-1");
  const call = book.beginCall("t-1");
  call.record({ ...priced(), prompt: "secret prompt", token: "private credential", output: "private output" } as never);
  call.end(); book.finishTask("t-1");
  const raw = readFileSync(file, "utf8"), saved = JSON.parse(raw);
  assert.equal(saved.version, 1); assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(raw.includes("secret prompt"), false); assert.equal(raw.includes("private credential"), false); assert.equal(raw.includes("private output"), false);
  assert.deepEqual(Object.keys(saved.tasks[0]).sort(), ["taskId", "finished", "callsStarted", "callsFinished", "holdsStarted", "holdsFinished", "records", "unknownRecords", "emptyCalls", "costUsd", "incomplete"].sort());
  assert.equal(readFileSync(join(dir, "usage.jsonl"), "utf8"), "unchanged usage\n");
  assert.equal(readFileSync(join(dir, "tasks.jsonl"), "utf8"), "unchanged tasks\n");
});

test("one request may record several priced pool attempts, and a task may contain several requests", t => {
  const { book } = fixture(t); book.beginTask("t-1");
  const first = book.beginCall("t-1"); first.record(priced(0.2)); first.record(priced(0.3)); first.end(); first.end();
  const second = book.beginCall("t-1"); second.record(priced(0.5)); second.end();
  assert.equal(book.usage()[0]!.unknownCost, true, "the task itself has not finished");
  book.finishTask("t-1");
  assert.deepEqual(book.usage(), [{ taskId: "t-1", costUsd: 1, unknownCost: false }]);
  assert.throws(() => first.record(priced()), /结束后/);
  assert.equal(book.usage()[0]!.unknownCost, true, "a late record reveals incomplete boundaries rather than preserving a false known total");
  assert.throws(() => book.beginCall("t-1"), /已结束/);
});

test("finishing a task before its outstanding request ends cannot prematurely make its cost known", t => {
  const { book } = fixture(t); book.beginTask("t-1");
  const call = book.beginCall("t-1"); book.finishTask("t-1");
  assert.equal(book.usage()[0]!.unknownCost, true);
  call.record(priced(0)); assert.equal(book.usage()[0]!.unknownCost, true);
  call.end(); assert.deepEqual(book.usage(), [{ taskId: "t-1", costUsd: 0, unknownCost: false }]);
});

test("missing cost, invalid usage, unpriced calls, subscription calls and empty calls remain unknown", t => {
  const { book } = fixture(t);
  const entries = [{}, { inputTokens: 1, outputTokens: 1 }, { costUsd: 0 }, { ...priced(), costNote: "subscription" }, { ...priced(), costNote: "unpriced" }, { ...priced(), inputTokens: -1 }, { ...priced(), outputTokens: 0.5 }, { ...priced(), costUsd: NaN }];
  entries.forEach((entry, i) => { const id = `t-${i}`; book.beginTask(id); const call = book.beginCall(id); call.record(entry as never); call.end(); book.finishTask(id); });
  book.beginTask("t-empty"); book.beginCall("t-empty").end(); book.finishTask("t-empty");
  book.beginTask("t-no-calls"); book.finishTask("t-no-calls");
  assert.ok(book.usage().every(u => u.unknownCost));
  assert.equal(book.usage().find(u => u.taskId === "t-3")!.costUsd, 0, "subscription cost is not silently accepted as a priced per-call fee");
});

test("partial usage keeps known amounts but remains unknown after successful attempts and restart", t => {
  const { dir, book } = fixture(t); book.beginTask("partial");
  const first = book.beginCall("partial");
  first.record(priced(2), { complete: false });
  first.record(priced(3), { complete: true });
  first.end();
  const retry = book.beginCall("partial"); retry.record(priced(5)); retry.end(); book.finishTask("partial");
  const expected = [{ taskId: "partial", costUsd: 10, unknownCost: true }];
  assert.deepEqual(book.usage(), expected);
  assert.deepEqual(new TaskAccounting(dir).usage(), expected, "later complete records must never erase partial usage uncertainty");
  book.beginTask("complete"); const completeCall = book.beginCall("complete"); completeCall.record(priced(1), { complete: true }); completeCall.end(); book.finishTask("complete");
  assert.deepEqual(book.usage().find(u => u.taskId === "complete"), { taskId: "complete", costUsd: 1, unknownCost: false });
});

test("a completed parent includes exact descendant costs and stays unknown until every registered child finishes", t => {
  const { dir, book } = fixture(t);
  book.beginTask("parent"); book.beginTask("child", "parent"); book.beginTask("grandchild", "child");
  complete(book, "parent", 1); complete(book, "child", 2);
  let usage = book.usage(); assert.equal(usage.find(u => u.taskId === "parent")!.unknownCost, true);
  complete(book, "grandchild", 3);
  usage = book.usage();
  assert.deepEqual(usage.find(u => u.taskId === "parent"), { taskId: "parent", costUsd: 6, unknownCost: false });
  assert.deepEqual(usage.find(u => u.taskId === "child"), { taskId: "child", costUsd: 5, unknownCost: false });
  assert.deepEqual(usage.find(u => u.taskId === "grandchild"), { taskId: "grandchild", costUsd: 3, unknownCost: false });
  assert.throws(() => book.beginTask("late-child", "parent"), /没有待完成的派活请求/);
  assert.equal(new TaskAccounting(dir).usage().find(u => u.taskId === "parent")!.unknownCost, true, "a rejected late child cannot leave an old known total authoritative");
});

test("one incomplete child taints only its task tree, never unrelated task totals", t => {
  const { book } = fixture(t);
  book.beginTask("root"); book.beginTask("child", "root"); book.beginTask("other");
  complete(book, "root", 1); complete(book, "other", 4);
  book.beginCall("child").end(); book.finishTask("child");
  assert.equal(book.usage().find(u => u.taskId === "root")!.unknownCost, true);
  assert.equal(book.usage().find(u => u.taskId === "other")!.unknownCost, false);
});

test("fully completed attribution survives restart, but interrupted tasks remain unknown even if later marked finished", t => {
  const { dir, book } = fixture(t);
  book.beginTask("done"); complete(book, "done", 3);
  book.beginTask("unfinished"); const endedCall = book.beginCall("unfinished"); endedCall.record(priced(2)); endedCall.end();
  book.beginTask("pending"); const pending = book.beginCall("pending"); pending.record(priced(1)); book.finishTask("pending");
  const restarted = new TaskAccounting(dir);
  assert.equal(restarted.usage().find(u => u.taskId === "done")!.unknownCost, false);
  restarted.finishTask("unfinished");
  assert.equal(restarted.usage().find(u => u.taskId === "unfinished")!.unknownCost, true);
  assert.equal(restarted.usage().find(u => u.taskId === "pending")!.unknownCost, true);
});

test("corrupt, unsupported, cyclic and orphaned books preserve their bytes and never become empty known-cost success", t => {
  const { dir, file } = fixture(t);
  const row = { taskId: "x", finished: true, callsStarted: 1, callsFinished: 1, holdsStarted: 0, holdsFinished: 0, records: 1, unknownRecords: 0, emptyCalls: 0, costUsd: 1, incomplete: false };
  for (const raw of ["broken", JSON.stringify({ version: 9, tasks: [] }), JSON.stringify({ version: 1, tasks: [{ ...row, parentTaskId: "missing" }] }), JSON.stringify({ version: 1, tasks: [{ ...row, parentTaskId: "y" }, { ...row, taskId: "y", parentTaskId: "x" }] }), JSON.stringify({ version: 1, tasks: [{ ...row, costUsd: -1 }] })]) {
    writeFileSync(file, raw, { mode: 0o600 });
    const broken = new TaskAccounting(dir);
    assert.equal(broken.status().available, false);
    assert.deepEqual(broken.usage(["x", "old-task"]), [{ taskId: "x", unknownCost: true }, { taskId: "old-task", unknownCost: true }]);
    assert.throws(() => broken.beginTask("new"), TaskAccountingError);
    assert.equal(readFileSync(file, "utf8"), raw);
  }
});

test("write failure during accounting keeps the affected task unknown after later save and restart", t => {
  const { dir, file, book } = fixture(t); book.beginTask("t-1"); const call = book.beginCall("t-1");
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((path, data, options) => {
    if (typeof path === "string" && path.startsWith(`${file}.`)) { originalWrite(path, "partial", options); throw new Error("secret low-level error"); }
    return originalWrite(path, data, options);
  }) as typeof fs.writeFileSync); syncBuiltinESMExports();
  try {
    assert.throws(() => call.record(priced(2)), error => error instanceof TaskAccountingError && !error.message.includes("secret"));
    assert.equal(book.status().available, false); assert.equal(book.usage()[0]!.unknownCost, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  call.end(); book.finishTask("t-1");
  assert.equal(book.usage()[0]!.unknownCost, true);
  assert.equal(new TaskAccounting(dir).usage()[0]!.unknownCost, true);
  assert.equal(readdirSync(dir).some(name => name.endsWith(".tmp")), false);
});

test("unregistered calls, missing parents and duplicate task ids fail instead of guessing or resetting attribution", t => {
  const { book } = fixture(t);
  assert.throws(() => book.beginCall("missing")); assert.throws(() => book.finishTask("missing"));
  assert.throws(() => book.beginTask("child", "missing"));
  book.beginTask("t-1"); complete(book, "t-1", 3);
  assert.throws(() => book.beginTask("t-1"));
  assert.equal(book.usage()[0]!.costUsd, 3);
  assert.deepEqual(book.usage(["legacy-missing"]).find(u => u.taskId === "legacy-missing"), { taskId: "legacy-missing", unknownCost: true });
});

test("external modification or deletion is treated as unavailable under the single-daemon contract", t => {
  const { file, book } = fixture(t); book.beginTask("t-1"); complete(book, "t-1");
  writeFileSync(file, "corrupt external replacement");
  assert.equal(book.status().available, false); assert.equal(book.usage()[0]!.unknownCost, true);
  assert.throws(() => book.beginTask("t-2"), TaskAccountingError);
  rmSync(file); assert.equal(book.usage()[0]!.unknownCost, true);
});

test("accounting refuses symlinks and keeps overflow JSON-safe and unknown", t => {
  const { dir, file, book } = fixture(t);
  book.beginTask("t-1"); const call = book.beginCall("t-1"); call.record(priced(Number.MAX_VALUE)); call.record(priced(Number.MAX_VALUE)); call.end(); book.finishTask("t-1");
  assert.equal(book.usage()[0]!.unknownCost, true); assert.equal(book.usage()[0]!.costUsd, Number.MAX_VALUE);
  rmSync(file); const target = join(dir, "unrelated"); writeFileSync(target, "untouched", { mode: 0o600 }); symlinkSync(target, file);
  const unsafe = new TaskAccounting(dir); assert.equal(unsafe.status().available, false);
  assert.throws(() => unsafe.beginTask("t-2"), TaskAccountingError);
  assert.equal(readFileSync(target, "utf8"), "untouched");
});

test("MCP holds cover delayed child registration without inventing a model call or zero-cost record", t => {
  const { book, file } = fixture(t);
  book.beginTask("parent");
  const hold = book.beginHold("parent");
  complete(book, "parent", 1);
  assert.equal(book.usage()[0]!.unknownCost, true);
  book.beginTask("late-child", "parent"); complete(book, "late-child", 2);
  assert.equal(book.usage().find(u => u.taskId === "parent")!.unknownCost, true, "discovery/request boundary remains active");
  hold.end(); hold.end();
  assert.deepEqual(book.usage().find(u => u.taskId === "parent"), { taskId: "parent", costUsd: 3, unknownCost: false });
  const saved = JSON.parse(readFileSync(file, "utf8")).tasks.find((task: { taskId: string }) => task.taskId === "parent");
  assert.equal(saved.callsStarted, 1); assert.equal(saved.records, 1); assert.equal(saved.emptyCalls, 0);
  assert.equal(saved.holdsStarted, 1); assert.equal(saved.holdsFinished, 1);
  assert.throws(() => book.beginHold("parent"), /已结束/);
});

test("an interrupted MCP hold stays unknown after restart even when the parent was marked finished", t => {
  const { dir, book } = fixture(t);
  book.beginTask("parent"); book.beginHold("parent"); complete(book, "parent", 1);
  const restarted = new TaskAccounting(dir);
  restarted.finishTask("parent");
  assert.equal(restarted.usage()[0]!.unknownCost, true);
});

test("failed late-record invalidation survives immediate restart instead of restoring the previous known snapshot", t => {
  const { dir, file, book } = fixture(t); book.beginTask("t-1"); const call = book.beginCall("t-1"); call.record(priced(2)); call.end(); book.finishTask("t-1");
  assert.equal(book.usage()[0]!.unknownCost, false);
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((path, data, options) => {
    if (typeof path === "string" && path.startsWith(`${file}.`)) throw Object.assign(new Error("fixture no snapshot space"), { code: "ENOSPC" });
    return originalWrite(path, data, options);
  }) as typeof fs.writeFileSync); syncBuiltinESMExports();
  try { assert.throws(() => call.record(priced(3)), TaskAccountingError); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(book.usage()[0]!.unknownCost, true);
  assert.equal(new TaskAccounting(dir).usage()[0]!.unknownCost, true);
});

test("failed child registration leaves its parent uncertain across restart and reserves the failed id", t => {
  const { dir, file, book } = fixture(t); book.beginTask("parent"); book.beginHold("parent"); complete(book, "parent", 2);
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((path, data, options) => {
    if (typeof path === "string" && path.startsWith(`${file}.`)) throw new Error("fixture snapshot failure");
    return originalWrite(path, data, options);
  }) as typeof fs.writeFileSync); syncBuiltinESMExports();
  try { assert.throws(() => book.beginTask("child", "parent"), TaskAccountingError); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const restarted = new TaskAccounting(dir);
  assert.equal(restarted.usage().find(u => u.taskId === "parent")!.unknownCost, true);
  assert.equal(restarted.usage().find(u => u.taskId === "child")!.unknownCost, true);
  assert.throws(() => restarted.beginTask("child"), /已有费用记录/);
});

test("an external write racing temporary snapshot creation is preserved rather than overwritten", t => {
  const { file, book } = fixture(t); book.beginTask("t-1");
  const originalWrite = fs.writeFileSync; let raced = false;
  t.mock.method(fs, "writeFileSync", ((path, data, options) => {
    const result = originalWrite(path, data, options);
    if (!raced && typeof path === "string" && path.startsWith(`${file}.`)) { raced = true; originalWrite(file, "external replacement must survive"); }
    return result;
  }) as typeof fs.writeFileSync); syncBuiltinESMExports();
  try { assert.throws(() => book.beginCall("t-1"), TaskAccountingError); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(raced, true); assert.equal(readFileSync(file, "utf8"), "external replacement must survive");
  assert.equal(book.status().available, false); assert.equal(book.usage()[0]!.unknownCost, true);
});

test("a corrupt uncertainty marker cannot make an older completed snapshot appear authoritative", t => {
  const { dir, book } = fixture(t); book.beginTask("t-1"); complete(book, "t-1", 2);
  const file = join(dir, "task-accounting.pending.json");
  for (const contents of ["broken", JSON.stringify({ version: 1, taskIds: [] }), JSON.stringify({ version: 1, taskIds: ["t-1", "t-1"] }), JSON.stringify({ version: 2, taskIds: ["t-1"] })]) {
    writeFileSync(file, contents, { mode: 0o600 });
    const restarted = new TaskAccounting(dir);
    assert.equal(restarted.status().available, false);
    assert.deepEqual(restarted.usage(["t-1"]), [{ taskId: "t-1", unknownCost: true }]);
  }
});

test("when snapshot and intent writes both fail, quarantine preserves bytes and prevents known totals after restart", t => {
  const { dir, file, book } = fixture(t); book.beginTask("t-1");
  const call = book.beginCall("t-1"); call.record(priced(2)); call.end(); book.finishTask("t-1");
  const before = readFileSync(file, "utf8");
  t.mock.method(fs, "writeFileSync", () => { throw Object.assign(new Error("fixture full disk"), { code: "ENOSPC" }); }); syncBuiltinESMExports();
  try { assert.throws(() => call.record(priced(3)), TaskAccountingError); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(book.usage()[0]!.unknownCost, true);
  assert.equal(readFileSync(join(dir, "task-accounting.failed.json"), "utf8"), before);
  const restarted = new TaskAccounting(dir);
  assert.equal(restarted.status().available, false);
  assert.deepEqual(restarted.usage(["t-1"]), [{ taskId: "t-1", unknownCost: true }]);
});

test("denial of every durable mutation is surfaced as a fatal persistence limit, never a promise of saved uncertainty", t => {
  const { book } = fixture(t); book.beginTask("t-1"); const call = book.beginCall("t-1"); call.record(priced()); call.end(); book.finishTask("t-1");
  t.mock.method(fs, "writeFileSync", () => { throw new Error("fixture read only"); });
  t.mock.method(fs, "renameSync", () => { throw new Error("fixture read only"); }); syncBuiltinESMExports();
  try {
    assert.throws(() => call.record(priced()), error => error instanceof TaskAccountingError && /失败状态都无法保存/.test(error.message));
    assert.equal(book.status().available, false); assert.equal(book.usage()[0]!.unknownCost, true);
    assert.equal(book.status().failureUnrecorded, true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("new model or MCP requests after task completion durably invalidate old known totals", t => {
  const { dir, book } = fixture(t);
  for (const [id, start] of [["model", () => book.beginCall("model")], ["mcp", () => book.beginHold("mcp")]] as const) {
    book.beginTask(id); complete(book, id);
    assert.equal(book.usage().find(u => u.taskId === id)!.unknownCost, false);
    assert.throws(start, /已结束/);
    assert.equal(book.usage().find(u => u.taskId === id)!.unknownCost, true);
  }
  assert.ok(new TaskAccounting(dir).usage().every(u => u.unknownCost));
});

function fullSnapshot(count = TASK_ACCOUNTING_CAPACITY) {
  return { version: 1, tasks: Array.from({ length: count }, (_, i) => ({ taskId: `t-${i}`, finished: true, callsStarted: 1, callsFinished: 1, holdsStarted: 0, holdsFinished: 0, records: 1, unknownRecords: 0, emptyCalls: 0, costUsd: 1, incomplete: false })) };
}

test("the bounded book preserves existing tasks and makes a capacity-rejected child's parent unknown", t => {
  const { dir, file } = fixture(t); const snapshot = fullSnapshot();
  writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 }); const book = new TaskAccounting(dir);
  assert.equal(book.status().capacity, 5000); assert.equal(book.status().capacityReached, true); assert.equal(book.status().available, true);
  const before = readFileSync(file, "utf8");
  assert.throws(() => book.beginTask("new-root"), TaskAccountingCapacityError);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(book.usage(["new-root"]).find(u => u.taskId === "new-root"), { taskId: "new-root", unknownCost: true });
  assert.throws(() => book.beginTask("new-child", "t-0"), TaskAccountingCapacityError);
  assert.equal(book.usage().find(u => u.taskId === "t-0")!.unknownCost, true);
  assert.equal(book.usage().find(u => u.taskId === "t-1")!.unknownCost, false);
  const restarted = new TaskAccounting(dir);
  assert.equal(restarted.status().tasks, 5000); assert.equal(restarted.usage().find(u => u.taskId === "t-0")!.unknownCost, true);
});

test("over-capacity imported snapshots remain untouched and unavailable instead of being truncated", t => {
  const { dir, file } = fixture(t); const before = JSON.stringify(fullSnapshot(TASK_ACCOUNTING_CAPACITY + 1));
  writeFileSync(file, before, { mode: 0o600 }); const book = new TaskAccounting(dir);
  assert.equal(book.status().capacityReached, true); assert.equal(book.status().available, false);
  assert.throws(() => book.beginTask("new"), TaskAccountingError);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(book.usage(["t-0"]), [{ taskId: "t-0", unknownCost: true }]);
});

test("at 5000 tasks, a new request uses bounded snapshots without reparsing history", t => {
  const { dir, file } = fixture(t); const snapshot = fullSnapshot();
  snapshot.tasks[0]!.finished = false;
  writeFileSync(file, JSON.stringify(snapshot), { mode: 0o600 }); const book = new TaskAccounting(dir);
  let parses = 0, snapshots = 0, maxSnapshotBytes = 0;
  const originalParse = JSON.parse, originalWrite = fs.writeFileSync;
  t.mock.method(JSON, "parse", (...args: Parameters<typeof JSON.parse>) => { parses++; return originalParse(...args); });
  t.mock.method(fs, "writeFileSync", ((path, data, options) => {
    if (typeof path === "string" && path.startsWith(`${file}.`)) { snapshots++; maxSnapshotBytes = Math.max(maxSnapshotBytes, Buffer.byteLength(String(data))); }
    return originalWrite(path, data, options);
  }) as typeof fs.writeFileSync); syncBuiltinESMExports();
  const start = performance.now();
  try { const call = book.beginCall("t-0"); call.record(priced()); call.end(); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  const elapsed = performance.now() - start;
  assert.equal(parses, 0); assert.equal(snapshots, 3); assert.ok(maxSnapshotBytes < 2 * 1024 * 1024);
  t.diagnostic(`5000-task begin/record/end: ${elapsed.toFixed(1)} ms, ${snapshots} snapshots, ${maxSnapshotBytes} bytes maximum, ${parses} historical parses; this is a bounded snapshot design, not a high-throughput benchmark`);
});
