import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { TaskBook, TaskCancelledError } from "../src/tasks.ts";
import { TaskRuntime, type TaskRuntimeUsage } from "../src/task-runtime.ts";

const input = { agent: "hermes", model: "fixture/model", from: "console", task: "synthetic task" };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
function fixture(t: TestContext, usage?: () => TaskRuntimeUsage[]) {
  const dir = mkdtempSync(join(tmpdir(), "es-task-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const book = new TaskBook(dir);
  return { dir, book, runtime: new TaskRuntime({ book, usage }) };
}
/** No subprocess: the fake owns a close handle and records termination through AbortSignal. */
function fakeProcess(book: TaskBook, runtime: TaskRuntime, taskId: string, signal: AbortSignal) {
  const close = deferred(); let terms = 0, alive = true;
  signal.addEventListener("abort", () => { terms++; }, { once: true });
  const done = close.promise.then(() => { alive = false; return book.finish(taskId, { exitCode: 0, output: "late successful output", timedOut: false }); })
    .finally(() => runtime.release(taskId));
  runtime.trackRun(taskId, done);
  return { close: close.resolve, done, terms: () => terms, alive: () => alive };
}

test("single cancellation revokes only owned issued tokens, waits for process close, and is idempotent", async t => {
  const { book, runtime, dir } = fixture(t);
  const { task, signal } = book.start(input);
  const process = fakeProcess(book, runtime, task.id, signal);
  const authority = new GatewayTokenAuthority();
  const owned = authority.issue("hermes"), unrelated = authority.issue("aider");
  runtime.ownToken(task.id, owned.token, () => authority.revoke(owned.token));
  assert.equal(runtime.snapshot().tasks[0]!.cleanupPending, false, "a running process is cancellable, not already cleaning up");
  assert.equal(runtime.revokeToken(task.id, unrelated.token), false);
  const cancelled = runtime.cancelTree(task.id);
  assert.equal(runtime.cancelTree(task.id), cancelled);
  assert.equal(task.status, "stopped"); assert.equal(process.terms(), 1);
  assert.equal(process.alive(), true);
  assert.equal(authority.authenticate({ authorization: `Bearer ${owned.token}` }), undefined);
  assert.ok(authority.authenticate({ authorization: `Bearer ${unrelated.token}` }));
  assert.equal(runtime.snapshot().tasks[0]!.cleanupPending, true);
  let settled = false; void cancelled.then(() => { settled = true; });
  await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  process.close();
  assert.deepEqual((await cancelled).cleanup, { pending: 0, failed: 0 });
  assert.equal(process.alive(), false); assert.equal(task.status, "stopped");
  const count = readFileSync(join(dir, "tasks.jsonl"), "utf8").trim().split("\n").length;
  book.finish(task.id, { exitCode: 1, output: "duplicate late failure", timedOut: true });
  assert.equal(task.status, "stopped"); assert.equal(task.output, "late successful output");
  assert.equal(readFileSync(join(dir, "tasks.jsonl"), "utf8").trim().split("\n").length, count);
  assert.equal(runtime.snapshot().tasks[0]!.cleanupPending, false);
});

test("parent cancellation reaches all registered children before abort callbacks can create late children", async t => {
  const { book, runtime } = fixture(t);
  const parent = book.start(input), admission = book.admitChild(parent.task.id);
  const children = ["aider", "claude"].map(agent => book.start({ ...input, agent, from: "hermes", parentTaskId: parent.task.id }));
  const unrelated = book.start({ ...input, task: "independent" });
  const processes = [parent, ...children].map(run => fakeProcess(book, runtime, run.task.id, run.signal));
  let rejected = false;
  parent.signal.addEventListener("abort", () => {
    assert.ok(children.every(child => child.task.status === "stopped"));
    assert.throws(() => book.start({ ...input, parentTaskId: parent.task.id }, { parentAdmission: admission }), TaskCancelledError);
    rejected = true;
  });
  const stop = runtime.cancelTree(parent.task.id);
  assert.equal(rejected, true); assert.ok(processes.every(child => child.terms() === 1));
  assert.equal(unrelated.signal.aborted, false); assert.equal(unrelated.task.status, "running");
  processes.forEach(process => process.close());
  assert.deepEqual(new Set((await stop).taskIds), new Set([parent, ...children].map(run => run.task.id)));
  assert.ok(processes.every(child => !child.alive()));
  admission.release(); book.finish(unrelated.task.id, { exitCode: 0, output: "", timedOut: false });
});

test("trusted admission preserves a child already accepted before natural parent completion, but cannot be forged or reused after cancellation", async t => {
  const { book, runtime } = fixture(t);
  const parent = book.start(input), admission = book.admitChild(parent.task.id);
  book.finish(parent.task.id, { exitCode: 0, output: "done", timedOut: false });
  assert.throws(() => book.start({ ...input, parentTaskId: parent.task.id }));
  assert.throws(() => book.start({ ...input, parentTaskId: parent.task.id }, { parentAdmission: { parentTaskId: parent.task.id, release() {} } }));
  const child = book.start({ ...input, parentTaskId: parent.task.id }, { parentAdmission: admission });
  assert.throws(() => book.start({ ...input, parentTaskId: child.task.id }), /两层/);
  const stop = runtime.cancelTree(parent.task.id);
  assert.equal(child.signal.aborted, true);
  assert.throws(() => book.start({ ...input, parentTaskId: parent.task.id }, { parentAdmission: admission }), TaskCancelledError);
  book.finish(child.task.id, { exitCode: 0, output: "", timedOut: false });
  await stop; admission.release(); admission.release();
  assert.equal(parent.task.status, "done", "cancelling remaining children does not rewrite an already completed parent's outcome");
});

test("token revocation failure cannot prevent sibling token cleanup, process close or late-token reclamation", async t => {
  const { book, runtime } = fixture(t);
  const { task, signal } = book.start(input), process = fakeProcess(book, runtime, task.id, signal);
  const revoked: string[] = [];
  runtime.ownToken(task.id, "fake-broken-token", () => { throw new Error("do not expose fake-broken-token"); });
  runtime.ownToken(task.id, "fake-good-token", () => { revoked.push("good"); });
  const cancel = runtime.cancelTree(task.id);
  assert.throws(() => runtime.ownToken(task.id, "fake-late-token", () => { revoked.push("late"); }), TaskCancelledError);
  process.close();
  const result = await cancel;
  assert.deepEqual(revoked, ["good", "late"]);
  assert.deepEqual(result.cleanup, { pending: 0, failed: 1 });
  const shown = JSON.stringify(runtime.snapshot());
  assert.ok(!shown.includes("fake-broken-token") && !shown.includes("do not expose"));
  assert.equal(runtime.snapshot().tasks[0]!.cleanupFailed, 1);
  assert.equal(runtime.snapshot().tasks[0]!.usage.unknownCost, true);
});

test("live tree retains ancestors and reports partial recorded costs honestly without summing parent and child twice", async t => {
  let rows: TaskRuntimeUsage[] = [];
  const { book } = fixture(t);
  const parent = book.start(input), child = book.start({ ...input, agent: "aider", model: "fixture/second", parentTaskId: parent.task.id });
  let now = Date.parse(parent.task.at) + 1250;
  const runtime = new TaskRuntime({ book, usage: () => rows, now: () => now });
  rows = [{ taskId: parent.task.id, costUsd: 0.4, unknownCost: false }, { taskId: child.task.id, costUsd: 0.1, unknownCost: true }];
  const view = runtime.snapshot(1);
  assert.equal(view.tree.length, 1); assert.equal(view.tree[0]!.children[0]!.id, child.task.id);
  assert.equal(view.tree[0]!.usage.costUsd, 0.4); assert.equal(view.tree[0]!.usage.unknownCost, true);
  assert.equal(view.tree[0]!.elapsedMs, 1250); assert.equal(view.tree[0]!.children[0]!.agent, "aider");
  assert.equal(view.tree[0]!.children[0]!.model, "fixture/second");
  now += 1000; assert.equal(runtime.snapshot().tree[0]!.elapsedMs, 2250);
  book.finish(child.task.id, { exitCode: 0, output: "", timedOut: false }); book.finish(parent.task.id, { exitCode: 0, output: "", timedOut: false });
  assert.equal(runtime.snapshot().tree[0]!.elapsedMs, parent.task.ms);
  assert.equal(runtime.snapshot().tree[0]!.usage.unknownCost, false);
  rows = [{ taskId: parent.task.id, costUsd: Number.NaN, unknownCost: false }];
  assert.deepEqual(runtime.snapshot().tree[0]!.usage, { taskId: parent.task.id, unknownCost: true });
  rows = [{ taskId: parent.task.id, costUsd: 0, unknownCost: false }];
  assert.equal(runtime.snapshot().tree[0]!.usage.unknownCost, false, "explicit measured zero is valid after completion");
});

test("clearing finished history preserves a cancelling task and its ancestor until cleanup settles; restart retains tree", async t => {
  const { book, runtime, dir } = fixture(t);
  const parent = book.start(input), child = book.start({ ...input, parentTaskId: parent.task.id });
  book.finish(parent.task.id, { exitCode: 0, output: "done", timedOut: false });
  const cancel = runtime.cancelTree(child.task.id);
  assert.equal(book.clearFinished(), 0);
  const restarted = new TaskBook(dir);
  assert.equal(restarted.get(child.task.id)?.parentTaskId, parent.task.id);
  assert.equal(restarted.get(child.task.id)?.status, "stopped");
  book.finish(child.task.id, { exitCode: null, output: "cancelled", timedOut: false });
  await cancel;
  assert.equal(book.clearFinished(), 2);
});

test("a restarted in-flight task is stopped; missing usage and a broken usage reader never claim zero cost", t => {
  const { book, dir } = fixture(t);
  const { task } = book.start(input);
  const restored = new TaskBook(dir);
  assert.equal(restored.get(task.id)?.status, "stopped");
  const runtime = new TaskRuntime({ book: restored, usage: () => { throw new Error("unavailable"); } });
  assert.deepEqual(runtime.snapshot().tasks[0]!.usage, { taskId: task.id, unknownCost: true });
  assert.equal(restored.stop("missing"), false);
});

test("history cannot discard token/process ownership while cleanup outlives the recorded task result", async t => {
  const { book, runtime } = fixture(t);
  const { task } = book.start(input), closing = deferred(); let revoked = false;
  runtime.ownToken(task.id, "fake-still-owned", () => { revoked = true; });
  const done = closing.promise.finally(() => runtime.release(task.id));
  runtime.trackRun(task.id, done);
  book.finish(task.id, { exitCode: 0, output: "already recorded", timedOut: false });
  assert.equal(book.clearFinished(), 0);
  assert.equal(runtime.snapshot().tasks[0]!.cleanupPending, true);
  closing.resolve(); await done; await new Promise(r => setImmediate(r));
  assert.equal(revoked, true);
  assert.equal(book.clearFinished(), 1);
});

test("caught process cleanup failure remains visible even when the server resolves a stopped Task", async t => {
  const { book, runtime } = fixture(t);
  const { task } = book.start(input);
  book.stop(task.id);
  runtime.noteCleanupFailure(task.id);
  const done = Promise.resolve(book.finish(task.id, { exitCode: null, output: "任务未完成", timedOut: false }));
  runtime.trackRun(task.id, done);
  await done; await new Promise(r => setImmediate(r));
  const shown = runtime.snapshot().tasks[0]!;
  assert.equal(shown.status, "stopped"); assert.equal(shown.cleanupPending, false);
  assert.equal(shown.cleanupFailed, 1); assert.equal(shown.usage.unknownCost, true);
});

test("cleanup failures retain their ownership record through history clearing and snapshot limits", async t => {
  for (const kind of ["reported", "token", "runner"] as const) {
    const { book, runtime } = fixture(t);
    const { task } = book.start(input);
    if (kind === "reported") { runtime.noteCleanupFailure(task.id); runtime.noteCleanupFailure(task.id); }
    if (kind === "token") { runtime.ownToken(task.id, "fixture-revoke-failure", () => { throw new Error("fixture"); }); await runtime.release(task.id); }
    book.finish(task.id, { exitCode: null, output: "ended", timedOut: false });
    if (kind === "runner") { runtime.trackRun(task.id, Promise.reject(new Error("fixture"))); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(book.clearFinished(), 0, `${kind} cleanup failure must remain visible`);
    assert.ok(book.get(task.id));
    const row = runtime.snapshot(0).tasks.find(row => row.id === task.id);
    assert.ok(row && row.cleanupFailed > 0, `${kind} failure cannot age out of the shutdown snapshot`);
    const result = await runtime.cancelTree(task.id);
    assert.ok(result.cleanup.failed > 0);
    assert.equal(book.clearFinished(), 0);
  }
});
