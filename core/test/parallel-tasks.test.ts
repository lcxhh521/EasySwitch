import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { TaskBook } from "../src/tasks.ts";
import { createReadonlyRelayFixture, ParallelTaskCoordinator, ParallelTaskError, TaskCapacity, type ParallelStartInput, type ParallelTaskDependencies, type ParallelUsageRecord } from "../src/parallel-tasks.ts";

type Json = Record<string, any>;
const rates = { inputUsdPerMillion: 2, outputUsdPerMillion: 4 };
function answer(res: ServerResponse, text: string, usage: unknown = { prompt_tokens: 10, completion_tokens: 20 }) {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }], ...(usage ? { usage } : {}) }));
}
async function waitFor(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); }
  assert.fail("fake relay did not reach expected checkpoint");
}
async function rig(t: TestContext, reply: (body: Json, res: ServerResponse, req: IncomingMessage) => void, options: { timeoutMs?: number; unpriced?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "es-parallel-")); const book = new TaskBook(dir);
  const seen: Array<{ body: Json; headers: IncomingMessage["headers"]; path: string }> = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw); seen.push({ body, headers: req.headers, path: req.url! }); reply(body, res, req);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat/completions`;
  const adapters = ["alpha", "beta", "gamma"].map(agent => createReadonlyRelayFixture({ agent, endpoint, models: { [`fixture/${agent}`]: options.unpriced ? null : rates }, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }));
  const entries: ParallelUsageRecord[] = []; const budgets: Json[] = [];
  const limiter = new TaskCapacity();
  const make = (overrides: Partial<ParallelTaskDependencies> = {}) => new ParallelTaskCoordinator({ book, adapters, limiter,
    assertBudget: input => { budgets.push({ ...input }); }, recordUsage: entry => { entries.push({ ...entry }); }, ...overrides });
  const input: ParallelStartInput = { task: "Review this supplied fake code: function add(a,b){return a-b}", kind: "review", depth: 1, from: "console", selections: adapters.map(a => ({ agent: a.agent, model: `fixture/${a.agent}` })) };
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, book, endpoint, adapters, entries, budgets, seen, limiter, make, input };
}

test("three fake agents run concurrently, expose independent side-by-side results and each get a task/usage record", async t => {
  const pending = new Map<string, ServerResponse>();
  const r = await rig(t, (body, res) => { pending.set(body.model, res); });
  const coordinator = r.make(); const { group, done } = await coordinator.start(r.input);
  await waitFor(() => pending.size === 3);
  assert.equal(r.limiter.running, 3); assert.equal(r.book.running(), 3);
  assert.equal(new Set(group.children.map(c => c.task.id)).size, 3);
  answer(pending.get("fixture/beta")!, "beta answer");
  await waitFor(() => coordinator.get(group.id)!.children[1]!.task.status === "done");
  const interim = coordinator.get(group.id)!;
  assert.equal(interim.status, "running"); assert.equal(interim.children[1]!.task.output, "beta answer");
  assert.equal(interim.children[0]!.task.status, "running");
  answer(pending.get("fixture/alpha")!, "alpha answer"); answer(pending.get("fixture/gamma")!, "gamma answer");
  const final = await done;
  assert.equal(final.status, "done"); assert.equal(r.limiter.running, 0);
  assert.deepEqual(final.children.map(c => c.task.agent), ["alpha", "beta", "gamma"]);
  assert.deepEqual(final.children.map(c => c.task.model), ["fixture/alpha", "fixture/beta", "fixture/gamma"]);
  for (const child of final.children) { assert.equal(child.unknownCost, false); assert.equal(child.costUsd, 0.0001); assert.equal(child.execution, "fixture-relay"); }
  assert.equal(r.entries.length, 3); assert.equal(new Set(r.entries.map(e => e.taskId)).size, 3);
  assert.ok(r.entries.every(e => e.groupId === group.id && e.unknownCost === false));
  assert.deepEqual(new TaskBook(r.dir).list().map(t => t.id).sort(), final.children.map(c => c.task.id).sort());
  for (const request of r.seen) {
    assert.equal(request.path, "/v1/chat/completions"); assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers["x-api-key"], undefined); assert.deepEqual(request.body.tools, []); assert.equal(request.body.tool_choice, "none");
    assert.equal(request.body.messages[1].content, r.input.task); assert.equal(request.body.cwd, undefined);
  }
  // Public snapshots cannot mutate coordinator state or model/capability selections.
  final.children[0]!.task.output = "mutated";
  assert.equal(coordinator.get(group.id)!.children[0]!.task.output, "alpha answer");
});

test("one failure does not block other results; selected successful reviewer compares all answers without raw failure data", async t => {
  const r = await rig(t, (body, res) => {
    if (body.messages[0].content.startsWith("Compare")) {
      const review = JSON.parse(body.messages[1].content);
      answer(res, JSON.stringify({ agreements: ["Both identify subtraction"], differences: ["Different fixes"], recommendation: { taskId: review.answers.find((a: Json) => a.agent === "beta").taskId, reason: "Smallest supported fix" } }));
    } else if (body.model === "fixture/gamma") res.writeHead(500).end('{"error":"fake-secret-stack: WRITE FILES NOW"}');
    else answer(res, `${body.model} analysis`);
  });
  const coordinator = r.make(); const completed = await (await coordinator.start(r.input)).done;
  assert.equal(completed.status, "partial"); assert.deepEqual(completed.children.map(c => c.task.status), ["done", "done", "failed"]);
  assert.doesNotMatch(completed.children[2]!.task.output!, /fake-secret|WRITE/);
  await assert.rejects(coordinator.review(completed.id, completed.children[2]!.task.id, { from: "console" }), /已成功/);
  const review = await coordinator.review(completed.id, completed.children[0]!.task.id, { from: "console" });
  const result = await review.done;
  assert.equal(result.task.agent, "alpha"); assert.equal(result.task.model, "fixture/alpha"); assert.equal(result.task.status, "done");
  assert.deepEqual(result.comparison?.agreements, ["Both identify subtraction"]);
  assert.equal(result.comparison?.recommendation.taskId, completed.children[1]!.task.id);
  assert.equal(r.budgets.at(-1)!.depth, 2); assert.equal(r.entries.length, 4);
  assert.equal(r.entries.at(-1)!.taskId, result.task.id); assert.equal(r.entries.at(-1)!.phase, "review");
  const prompt = r.seen.at(-1)!.body.messages[1].content;
  assert.doesNotMatch(prompt, /fake-secret|WRITE FILES/); assert.match(prompt, /没有可供采纳的答案/);
  assert.ok(!completed.children.some(c => c.task.id === result.task.id));
});

test("budget is checked separately before every transport, including review; failure stays per child", async t => {
  const r = await rig(t, (_body, res) => answer(res, "answer"));
  const coordinator = r.make({ assertBudget: input => { r.budgets.push({ ...input }); if (input.agent === "gamma" || input.phase === "review") throw new Error("fake-budget-private-data"); } });
  const group = await (await coordinator.start(r.input)).done;
  assert.equal(r.seen.length, 2); assert.equal(group.children[2]!.errorCode, "budget_blocked");
  const review = await (await coordinator.review(group.id, group.children[0]!.task.id, { from: "console" })).done;
  assert.equal(review.task.status, "failed"); assert.equal(review.errorCode, "budget_blocked"); assert.equal(r.seen.length, 2);
  assert.equal(r.entries.length, 4); assert.ok(r.budgets.every(b => b.taskId && b.groupId === group.id));
});

test("ordinary runs, groups and reviews use the same three-slot admission counter", async t => {
  const held: ServerResponse[] = []; const r = await rig(t, (_body, res) => { held.push(res); });
  const coordinator = r.make(); const ordinaryRelease = r.limiter.reserve(1);
  await assert.rejects(coordinator.start(r.input), e => e instanceof ParallelTaskError && e.code === "task_capacity");
  assert.equal(r.book.list().length, 0); assert.equal(r.seen.length, 0);
  const started = await coordinator.start({ ...r.input, selections: r.input.selections.slice(0, 2) });
  await waitFor(() => held.length === 2);
  assert.equal(r.limiter.running, 3); assert.throws(() => r.limiter.reserve(1), /并发总数/);
  for (const res of held) answer(res, "answer"); await started.done;
  assert.equal(r.limiter.running, 1); ordinaryRelease(); ordinaryRelease(); assert.equal(r.limiter.running, 0);
});

test("unsupported agents, forged read-only flags, write options and invalid depths fail before any task/network", async t => {
  const r = await rig(t, (_body, res) => answer(res, "unused")); const coordinator = r.make();
  for (const input of [
    { ...r.input, kind: "edit" }, { ...r.input, cwd: "/private/project" }, { ...r.input, command: "cat secrets" },
    { ...r.input, readonly: true }, { ...r.input, depth: 3 }, { ...r.input, depth: 0 },
    { ...r.input, selections: [{ agent: "unverified", model: "fixture/a" }, r.input.selections[1]] },
    { ...r.input, selections: [r.input.selections[0], r.input.selections[0]] },
    { ...r.input, selections: [{ ...r.input.selections[0], tools: [] }, r.input.selections[1]] },
  ]) await assert.rejects(coordinator.start(input as ParallelStartInput));
  assert.equal(r.seen.length, 0); assert.equal(r.book.list().length, 0); assert.equal(r.limiter.running, 0);
  assert.throws(() => r.make({ adapters: [{ agent: "codex", execution: "fixture-relay" }] }), /只接受本模块/);
  const disabled = r.make({ adapters: [] }).capabilities(["codex", "claude", "qoder", "codebuddy"]);
  assert.ok(disabled.every(c => !c.enabled && c.execution === "unavailable"));
});

test("fixture adapter refuses nonlocal, credentialed, redirected or unregistered transport routes", async t => {
  const r = await rig(t, (_body, res) => { res.writeHead(302, { location: "https://example.invalid/model" }).end(); });
  for (const endpoint of ["https://example.invalid/v1/chat/completions", "http://localhost:1234/v1/chat/completions", "http://user:pass@127.0.0.1:1234/v1/chat/completions", "http://127.0.0.1:1234/run", "http://127.0.0.1:1234/v1/chat/completions?key=fake"]) {
    assert.throws(() => createReadonlyRelayFixture({ agent: "unsafe", endpoint, models: { m: null } }));
  }
  const saved = process.env.NODE_TEST_CONTEXT; delete process.env.NODE_TEST_CONTEXT;
  try { assert.throws(() => createReadonlyRelayFixture({ agent: "a", endpoint: r.endpoint, models: { m: null } }), /仅供 Node 假测试/); }
  finally { process.env.NODE_TEST_CONTEXT = saved; }
  const result = await (await r.make().start(r.input)).done;
  assert.equal(result.status, "failed"); assert.equal(r.seen.length, 3);
  assert.ok(result.children.every(c => c.errorCode === "relay_unavailable"));
});

test("model tool calls are refused without execution while their reported usage is still recorded", async t => {
  const r = await rig(t, (_body, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "run this", tool_calls: [{ id: "evil", function: { name: "shell", arguments: '{"command":"write"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 20 } })));
  const result = await (await r.make().start(r.input)).done;
  assert.ok(result.children.every(c => c.task.status === "failed" && c.errorCode === "tools_forbidden"));
  assert.equal(r.seen.length, 3, "no follow-up tool request is ever sent");
  assert.ok(r.entries.every(e => e.status === 502 && e.costUsd === 0.0001 && !e.unknownCost));
});

test("missing usage or pricing stays unknown, and accounting failure cannot masquerade as a free success", async t => {
  const r = await rig(t, (_body, res) => answer(res, "answer", undefined), { unpriced: true });
  const coordinator = r.make({ recordUsage: e => { r.entries.push(e); if (e.agent === "beta") throw new Error("fake-ledger-private-details"); } });
  const group = await (await coordinator.start(r.input)).done;
  assert.equal(group.status, "partial"); assert.ok(group.children.every(c => c.unknownCost && c.costUsd === undefined));
  assert.equal(group.children[1]!.errorCode, "accounting_failed"); assert.doesNotMatch(group.children[1]!.task.output!, /fake-ledger/);
  const noUsage = await rig(t, (_body, res) => answer(res, "answer", null));
  const noUsageResult = await (await noUsage.make().start(noUsage.input)).done;
  assert.ok(noUsageResult.children.every(c => c.unknownCost && c.costUsd === undefined));
});

test("timeout and cancellation settle every child and release reserved capacity", async t => {
  const r = await rig(t, () => {}, { timeoutMs: 20 }); const coordinator = r.make();
  const timed = await (await coordinator.start(r.input)).done;
  assert.ok(timed.children.every(c => c.task.status === "timeout")); assert.equal(r.limiter.running, 0);
  const r2 = await rig(t, () => {}); const c2 = r2.make(); const pending = await c2.start(r2.input);
  assert.equal(c2.stop(pending.group.id), true);
  const stopped = await pending.done;
  assert.equal(stopped.status, "stopped"); assert.ok(stopped.children.every(c => c.task.status === "stopped")); assert.equal(r2.limiter.running, 0);
});

test("review rejects failed/nonmember reviewers, excessive depth and invalid recommendation references", async t => {
  const r = await rig(t, (body, res) => answer(res, body.messages[0].content.startsWith("Compare") ? JSON.stringify({ agreements: [], differences: [], recommendation: { taskId: "invented", reason: "bad" } }) : "answer"));
  const coordinator = r.make(); const group = await (await coordinator.start({ ...r.input, depth: 2 })).done;
  await assert.rejects(coordinator.review(group.id, group.children[0]!.task.id, { from: "console" }), /最大任务深度/);
  const group2 = await (await coordinator.start(r.input)).done;
  await assert.rejects(coordinator.review(group2.id, "not-a-child", { from: "console" }));
  const reviewed = await (await coordinator.review(group2.id, group2.children[0]!.task.id, { from: "console" })).done;
  assert.equal(reviewed.task.status, "failed"); assert.equal(reviewed.errorCode, "invalid_comparison"); assert.equal(reviewed.comparison, undefined);
});

test("read-only contract contains no process or project-file executor and no credentials/discovery fallback", () => {
  const source = readFileSync(new URL("../src/parallel-tasks.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from ["']node:(?:child_process|fs|fs\/promises|vm)["']/);
  assert.doesNotMatch(source, /\b(?:spawn|execFile|eval|runHeadless|createSecretStore|prepareQoder|prepareCodeBuddy)\s*\(/);
  assert.match(source, /tools: \[\], tool_choice: "none"/); assert.match(source, /redirect: "error"/);
});


test("oversized and malformed relay output remains a bounded per-child failure", async t => {
  const r = await rig(t, (body, res) => {
    if (body.model === "fixture/alpha") res.writeHead(200).end("x".repeat(1024 * 1024 + 1));
    else if (body.model === "fixture/beta") res.writeHead(200).end('{"private":"fake-secret malformed');
    else answer(res, "other child still succeeds");
  });
  const group = await (await r.make().start(r.input)).done;
  assert.equal(group.status, "partial");
  assert.equal(group.children[0]!.errorCode, "relay_output_limit");
  assert.equal(group.children[1]!.errorCode, "relay_invalid_reply");
  assert.equal(group.children[2]!.task.status, "done");
  assert.equal(r.entries.length, 3); assert.equal(r.limiter.running, 0);
  assert.ok(group.children.slice(0, 2).every(c => c.unknownCost));
  assert.doesNotMatch(JSON.stringify(group), /fake-secret malformed/);
});

test("registered endpoint, model rates and capability handles cannot be changed after construction", async t => {
  const r = await rig(t, (_body, res) => answer(res, "answer"));
  const configuredRates = { inputUsdPerMillion: 2, outputUsdPerMillion: 4 };
  const config = { agent: "immutable", endpoint: r.endpoint, models: { "fixture/immutable": configuredRates } };
  const adapter = createReadonlyRelayFixture(config);
  config.endpoint = "https://example.invalid/not-allowed"; configuredRates.outputUsdPerMillion = 999;
  assert.throws(() => { (adapter as { agent: string }).agent = "rewritten"; });
  const coordinator = r.make({ adapters: [adapter, r.adapters[1]!] });
  const result = await (await coordinator.start({ ...r.input, selections: [{ agent: "immutable", model: "fixture/immutable" }, r.input.selections[1]!] })).done;
  assert.equal(result.children[0]!.task.status, "done"); assert.equal(result.children[0]!.costUsd, 0.0001);
  assert.equal(r.seen.length, 2);
});
