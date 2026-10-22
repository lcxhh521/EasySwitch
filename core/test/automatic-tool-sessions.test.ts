import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AsyncResource } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import { test, type TestContext } from "node:test";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";
import { mintAutomaticApproval } from "../src/automatic-approval.ts";
import { AutomaticFailureLedger } from "../src/automatic-policy.ts";
import { currentAutomaticAttempt, dispatchInference } from "../src/automatic-dispatch.ts";
import type { GatewaySession } from "../src/gateway-auth.ts";
import { ProtocolError } from "../src/protocol.ts";
import type { Pool } from "../src/types.ts";

// Audited in-memory transport only. No client launch, real account, Keychain or upstream.
const path = "../src/automatic-tool-sessions.ts";
const runner = await import(path).catch(error => { if (error.code === "ERR_MODULE_NOT_FOUND") return {}; throw error; });
const tool = { type: "function", function: { name: "read_file", parameters: { type: "object", properties: { path: { type: "string" } } } } };
const call = (id = "call_1", args = '{"path":"fixture.txt"}') => ({ id, type: "function", function: { name: "read_file", arguments: args } });
const request = (messages: unknown[] = [{ role: "user", content: "Read fixture" }], extra: Record<string, unknown> = {}) => JSON.stringify({ model: "pool/tools", messages, tools: [tool], ...extra });
const history = (id = "call_1") => [{ role: "user", content: "Read fixture" }, { role: "assistant", content: null, tool_calls: [call(id)] }, { role: "tool", tool_call_id: id, content: "fixture contents" }];
const answer = (id?: string) => Response.json({ id: "fixture", object: "chat.completion", created: 1, model: "mock-coder", choices: [{ index: 0, message: { role: "assistant", content: id ? null : "ok", ...(id ? { tool_calls: [call(id)] } : {}) }, finish_reason: id ? "tool_calls" : "stop" }] });
class ResponseSink extends Writable {
  statusCode = 200;
  headersSent = false;
  chunks: Buffer[] = [];
  onChunk?: (chunk: Buffer) => void;
  writeHead(status: number): this { this.statusCode = status; this.headersSent = true; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void { this.chunks.push(Buffer.from(chunk)); this.onChunk?.(chunk); done(); }
  get body(): string { return Buffer.concat(this.chunks).toString(); }
  asServer(): ServerResponse { return this as unknown as ServerResponse; }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t: TestContext, options: Record<string, unknown> = {}) {
  assert.equal(typeof runner.AutomaticToolSessions, "function", "the process-local launch registry must exist");
  assert.equal(typeof runner.runAutomaticToolPool, "function");
  const dir = mkdtempSync(join(tmpdir(), "es-tool-sessions-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir), secrets = createSecretStore(), failures = new AutomaticFailureLedger();
  for (const id of ["a", "b"]) {
    store.upsertProvider({ id, name: id, baseUrl: `http://127.0.0.1:1/${id}/v1`, models: ["mock-coder"], route: "chat-translate", routePinned: true, protocols: ["chat"], streamUsage: false, createdAt: "", keys: [{ id: "key1", label: "first", enabled: true, addedAt: "" }, { id: "key2", label: "second", enabled: true, addedAt: "" }] });
    await secrets.set(`${id}#key1`, `synthetic-${id}-first`); await secrets.set(`${id}#key2`, `synthetic-${id}-second`);
  }
  const members = ["a/mock-coder", "b/mock-coder"];
  const pool: Pool = { id: "tools", name: "Tools", strategy: "automatic", members, createdAt: "", automaticApproval: await mintAutomaticApproval(store, secrets, members) }; store.upsertPool(pool);
  const registry = new runner.AutomaticToolSessions(options);
  const session: GatewaySession = { id: randomUUID(), agentId: "opencode", kind: "launch", depth: 0, allowMcp: false, allowNativeClaude: false, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), automaticTools: { version: 1, poolId: pool.id, approvalId: runner.automaticToolApprovalId(pool) } };
  registry.register(session);
  const sends: Array<{ member: string; key: string; keyId?: string }> = [];
  const f = { store, secrets, failures, pool, registry, session, sends, allowed: true, response: () => answer() as Promise<Response> | Response, afterGuard: undefined as undefined | (() => void), afterResponse: undefined as undefined | (() => Promise<void>), assertHook: undefined as undefined | (() => void), skipGuard: false,
    run: async (raw = request(), overrides: Record<string, unknown> = {}, sink = new ResponseSink()) => {
      const runtime = { secrets, protocol: "chat", raw, failures, session, registry, assertAllowed() { f.assertHook?.(); if (!f.allowed) throw new ProtocolError("synthetic revoked", 403); }, ...overrides };
      await runner.runAutomaticToolPool(store, pool, sink.asServer(), async (res: ServerResponse, member: string) => {
        const a = currentAutomaticAttempt()!; assert.equal(a.requireNativeChat, true);
        const controller = new AbortController(); res.once("close", () => controller.abort());
        const key = await a.readKey(controller.signal);
        const upstream = await dispatchInference(store.provider(member.split("/")[0]!)!, controller.signal, async () => { sends.push({ member, key, keyId: a.keyId }); return f.response(); });
        const guarded = f.skipGuard ? upstream : a.guardResponse!(upstream); f.afterGuard?.();
        res.writeHead(guarded.status);
        if (guarded.body) await pipeline(Readable.fromWeb(guarded.body as import("node:stream/web").ReadableStream), res); else res.end();
        await f.afterResponse?.();
      }, runtime);
      return sink;
    },
  };
  return f;
}

test("only an explicit registered launch can enter the runner, and a restarted registry rejects its marker", async t => {
  const f = await fixture(t);
  for (const registry of [new runner.AutomaticToolSessions(), undefined]) {
    const result = await f.run(request(), { registry }); assert.equal(result.statusCode, 409);
  }
  f.registry.remove(f.session.id);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 0);
});

test("register validates launch identity, finite expiry, marker and rejects duplicate resets", async t => {
  const f = await fixture(t);
  for (const change of [{ kind: "manual" }, { agentId: "codex" }, { depth: 1 }, { allowMcp: true }, { allowNativeClaude: true }, { automaticTools: undefined }, { expiresAt: new Date(Date.now() - 1).toISOString() }]) {
    assert.throws(() => f.registry.register({ ...f.session, id: randomUUID(), ...change }));
  }
  assert.throws(() => f.registry.register(f.session));
  const changed = { ...f.session, automaticTools: { ...f.session.automaticTools!, approvalId: "f".repeat(64) } };
  assert.equal((await f.run(request(), { session: changed })).statusCode, 409); assert.equal(f.sends.length, 0);
});

test("registry is bounded, expires entries and never evicts an unexpired pin to make room", async t => {
  let now = Date.now(); const f = await fixture(t, { maxSessions: 1, now: () => now });
  assert.throws(() => f.registry.register({ ...f.session, id: randomUUID() }));
  now = Date.parse(f.session.expiresAt) + 1;
  assert.equal((await f.run()).statusCode, 409);
  const next = { ...f.session, id: randomUUID(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 10_000).toISOString() };
  assert.doesNotThrow(() => f.registry.register(next));
});

test("successful tool history, repeated full history and same-token conversations stay on the first source and key", async t => {
  const f = await fixture(t); f.response = () => answer("call_1");
  assert.equal((await f.run()).statusCode, 200); f.response = () => answer();
  for (const raw of [request(history()), request(history()), request()]) assert.equal((await f.run(raw)).statusCode, 200);
  assert.deepEqual(f.sends.map(s => [s.member, s.keyId, s.key]), Array.from({ length: 4 }, () => ["a/mock-coder", "key1", "synthetic-a-first"]));
});

test("unknown first tool history, opaque state and foreign IDs consume no sends", async t => {
  const f = await fixture(t);
  for (const raw of [request(history()), request(undefined, { previous_response_id: null }), request(undefined, { provider_state: "opaque" })]) assert.equal((await f.run(raw)).statusCode, 400);
  assert.equal(f.sends.length, 0); f.response = () => answer("own"); await f.run();
  assert.equal((await f.run(request(history("foreign")))).statusCode, 400); assert.equal(f.sends.length, 1);
});

test("all approved sources waiting means zero calls; a fresh launch may select B but never rotate the pinned session", async t => {
  const f = await fixture(t); const identity = (index: number) => `${f.pool.id}:${f.pool.automaticApproval!.salt}:${f.pool.automaticApproval!.members[index]!.seal}`;
  f.failures.record(identity(0), "chat", 429); f.failures.record(identity(1), "chat", 503);
  assert.equal((await f.run()).statusCode, 503); assert.equal(f.sends.length, 0);
  const freshFailures = new AutomaticFailureLedger(); freshFailures.record(identity(0), "chat", 429);
  assert.equal((await f.run(request(), { failures: freshFailures })).statusCode, 200);
  assert.equal(f.sends[0]?.member, "b/mock-coder");
  assert.equal((await f.run(request(), { failures: new AutomaticFailureLedger() })).statusCode, 200);
  assert.deepEqual(f.sends.map(s => s.member), ["b/mock-coder", "b/mock-coder"]);
});

for (const status of [401, 403, 429, 500, 503]) test(`HTTP ${status} permanently pauses after one dispatch without key, repair or source retry`, async t => {
  const f = await fixture(t); f.response = () => new Response("synthetic refusal", { status });
  assert.equal((await f.run()).statusCode, status); f.response = () => answer();
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

test("transport uncertainty and missing output guard never roll an already sent scope back to new", async t => {
  for (const mode of ["transport", "unguarded"] as const) {
    const f = await fixture(t); f.skipGuard = mode === "unguarded"; f.response = () => { if (mode === "transport") throw new Error("synthetic reset"); return answer(); };
    await f.run(); f.skipGuard = false; f.response = () => answer();
    assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
  }
});

test("malformed or partial output pauses and cannot authorize tool IDs", async t => {
  const f = await fixture(t); f.response = () => new Response('{"choices":[', { headers: { "content-type": "application/json" } });
  const first = await f.run(); assert.equal(first.destroyed, true);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

for (const change of ["endpoint", "nonselected endpoint", "key revision", "secret", "approval", "session", "budget"] as const) test(`pinned session rejects ${change} changes without sending or choosing another member`, async t => {
  const f = await fixture(t); await f.run();
  if (change === "endpoint" || change === "nonselected endpoint") { const id = change === "endpoint" ? "a" : "b"; f.store.upsertProvider({ ...f.store.provider(id)!, baseUrl: "http://127.0.0.1:2/v1" }); }
  else if (change === "key revision") f.store.touchCredentialRevision("a#key1");
  else if (change === "secret") await f.secrets.set("a#key1", "synthetic-replacement");
  else if (change === "approval") { const pool = f.store.pool("tools")!; pool.automaticApproval = await mintAutomaticApproval(f.store, f.secrets, pool.members); f.store.upsertPool(pool); }
  else f.allowed = false;
  const result = await f.run(); assert.ok(result.statusCode >= 400); f.allowed = true;
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

test("concurrent bootstrap sees busy and zero alternate dispatch while first validation is awaiting", async t => {
  const f = await fixture(t), entered = deferred(), release = deferred(); const read = f.secrets.get.bind(f.secrets); let hold = true;
  f.secrets.get = async account => { if (hold) { hold = false; entered.resolve(); await release.promise; } return read(account); };
  const first = f.run(); await entered.promise;
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 0);
  release.resolve(); assert.equal((await first).statusCode, 200); assert.equal(f.sends.length, 1);
});

test("HTTP finish unlocks before handler tail, and old response tail cannot clear a newer lease", async t => {
  const f = await fixture(t), firstTail = deferred(), releaseFirst = deferred(), secondSend = deferred(), releaseSecond = deferred();
  let count = 0;
  f.response = async () => { count++; if (count === 1) return answer("call_1"); secondSend.resolve(); await releaseSecond.promise; return answer(); };
  let tailCount = 0; f.afterResponse = async () => { if (++tailCount === 1) { firstTail.resolve(); await releaseFirst.promise; } };
  const first = f.run(); await firstTail.promise;
  const second = f.run(request(history())); await secondSend.promise;
  releaseFirst.resolve(); assert.equal((await first).statusCode, 200);
  assert.equal((await f.run()).statusCode, 409, "finishing old request did not unlock active new request");
  releaseSecond.resolve(); assert.equal((await second).statusCode, 200);
  assert.equal((await f.run()).statusCode, 200); assert.equal(f.sends.length, 3);
});

for (const kind of ["global", "source", "configuration", "credential"] as const) test(`queued ${kind} invalidation after final async validation is checked again before physical send`, async t => {
  const f = await fixture(t); let checks = 0; let sourceBlocked = false;
  f.store.setProviderBudgetChecker(provider => provider.id === "a" && sourceBlocked);
  f.assertHook = () => { if (++checks === 6) queueMicrotask(() => {
    if (kind === "global") f.allowed = false;
    else if (kind === "source") sourceBlocked = true;
    else if (kind === "configuration") f.store.upsertProvider({ ...f.store.provider("b")!, baseUrl: "http://127.0.0.1:2/v1" });
    else f.store.touchCredentialRevision("b#key1");
  }); };
  const first = await f.run(); assert.ok(first.statusCode >= 400); assert.equal(f.sends.length, 0);
  f.allowed = true; sourceBlocked = false; f.assertHook = undefined;
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 0);
});

test("response consumer cancellation pauses the scope and cancels upstream body", async t => {
  const f = await fixture(t), started = deferred(); let cancelled = 0;
  f.response = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"fixture"')); started.resolve(); }, cancel() { cancelled++; } }), { headers: { "content-type": "application/json" } });
  const sink = new ResponseSink(); const first = f.run(request(), {}, sink); await started.promise;
  await new Promise(r => setTimeout(r, 5)); sink.destroy(); await first;
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1); assert.equal(cancelled, 1);
});

test("cancelling a held SSE tool call leaks no arguments, cancels upstream and pauses without retry", async t => {
  const f = await fixture(t), readAll = deferred(); let cancelled = 0;
  const chunk = (delta: unknown) => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock-coder", choices: [{ index: 0, delta, finish_reason: null }] });
  const frame = (value: unknown) => `data: ${JSON.stringify(value)}\r\n\r\n`;
  const prefix = frame(chunk({ role: "assistant", content: "visible text" }));
  const pending = [prefix, frame(chunk({ tool_calls: [{ index: 0, ...call() }] })), ": held comment\r\n\r\n"];
  f.response = () => new Response(new ReadableStream({
    pull(controller) { const raw = pending.shift(); if (raw === undefined) readAll.resolve(); else controller.enqueue(new TextEncoder().encode(raw)); },
    cancel() { cancelled++; },
  }), { headers: { "content-type": "text/event-stream" } });
  const sink = new ResponseSink(); const first = f.run(request(undefined, { stream: true }), {}, sink);
  t.after(() => sink.destroy());
  await readAll.promise; await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sink.body, prefix); assert.equal(sink.writableFinished, false);
  sink.destroy(); await first;
  assert.equal(sink.body, prefix); assert.equal(cancelled, 1); assert.equal(f.sends.length, 1);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

test("explicit server pause never registers missing identities or resets an existing session", async t => {
  const f = await fixture(t); f.registry.pause("missing");
  await f.run(); f.registry.pause(f.session.id);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

test("a tool proof cannot cross launch identities even when both launches pin the same source", async t => {
  const f = await fixture(t); f.response = () => answer("call_1"); await f.run();
  const second = { ...f.session, id: randomUUID() }; f.registry.register(second);
  f.response = () => answer(); await f.run(request(), { session: second });
  assert.equal((await f.run(request(history()), { session: second })).statusCode, 400);
  assert.equal(f.sends.length, 2);
});

test("bounded call proofs fail closed before releasing a terminal or forgetting old identity", async t => {
  const f = await fixture(t, { maxCalls: 1 }); f.response = () => answer("one"); await f.run();
  f.response = () => answer("two"); const second = await f.run();
  assert.equal(second.destroyed, true); assert.equal(second.body, "");
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 2);
});

test("success followed by repeated upstream call ID pauses rather than overwriting the proof", async t => {
  const f = await fixture(t); f.response = () => answer("call_1"); await f.run();
  const duplicate = await f.run(); assert.equal(duplicate.destroyed, true);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 2);
});

test("scope stores no API key, arguments, tool results or dialogue body in its enumerable state", async t => {
  const f = await fixture(t); f.response = () => answer("call_1"); await f.run();
  assert.equal(JSON.stringify(f.registry), "{}");
  assert.doesNotMatch(JSON.stringify(f.session), /synthetic-a-first|fixture.txt|fixture contents/);
});

test("source changes after HTTP success but before output proof commit suppress terminal and pause", async t => {
  const f = await fixture(t); f.response = () => answer("call_1");
  f.afterGuard = () => f.store.touchCredentialRevision("a#key1");
  const first = await f.run(); assert.equal(first.destroyed, true); assert.equal(first.body, "");
  f.afterGuard = undefined; assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

test("streamed tool terminal is byte exact and an immediate tool result succeeds before first handler tail settles", async t => {
  const f = await fixture(t), holdTail = deferred(), enteredTail = deferred();
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock-coder", choices: [{ index: 0, delta, finish_reason }] });
  const frame = (value: unknown) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
  const wire = [frame(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_", arguments: '{"path":' } }] })), frame(chunk({ tool_calls: [{ index: 0, function: { name: "file", arguments: '"fixture.txt"}' } }] })), frame(chunk({}, "tool_calls")), frame("[DONE]")].join("");
  f.response = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const incoming = new AsyncResource("independent incoming HTTP request");
  t.after(() => incoming.emitDestroy());
  const sink = new ResponseSink(); let next: Promise<ResponseSink> | undefined; let tails = 0;
  f.afterResponse = async () => { if (++tails === 1) { enteredTail.resolve(); await holdTail.promise; } };
  sink.once("finish", () => { queueMicrotask(() => { f.response = () => answer(); next = incoming.runInAsyncScope(() => f.run(request(history()))); }); });
  const first = f.run(request(undefined, { stream: true }), {}, sink); await enteredTail.promise;
  assert.ok(next); assert.equal((await next).statusCode, 200);
  holdTail.resolve(); await first;
  assert.equal(sink.body, wire); assert.equal(f.sends.length, 2); assert.ok(f.sends.every(s => s.member === "a/mock-coder" && s.keyId === "key1"));
});

test("an already pinned source cannot recover implicitly after a temporary source budget stop", async t => {
  const f = await fixture(t); await f.run(); let blocked = true;
  f.store.setProviderBudgetChecker(provider => provider.id === "a" && blocked);
  assert.equal((await f.run()).statusCode, 429); blocked = false;
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

test("second dispatch inside a single handler cannot consume a new tool request budget", async t => {
  const f = await fixture(t); let sends = 0;
  const sink = new ResponseSink();
  await runner.runAutomaticToolPool(f.store, f.pool, sink.asServer(), async (_res: ServerResponse, member: string) => {
    const a = currentAutomaticAttempt()!, signal = new AbortController().signal;
    await a.readKey(signal);
    const send = () => dispatchInference(f.store.provider(member.split("/")[0]!)!, signal, async () => { sends++; return answer(); });
    await send(); await assert.rejects(send, ProtocolError);
  }, { secrets: f.secrets, protocol: "chat", raw: request(), failures: f.failures, session: f.session, registry: f.registry, assertAllowed() {} });
  assert.equal(sends, 1); assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 0);
});

test("validated but backpressured terminal keeps the lease busy until HTTP finish, and cancellation pauses it", async t => {
  const f = await fixture(t), blocked = deferred(); f.response = () => answer("call_1");
  const sink = new ResponseSink();
  sink._write = (chunk, _encoding, _done) => { sink.chunks.push(Buffer.from(chunk)); blocked.resolve(); /* Simulate a socket that cannot flush terminal bytes. */ };
  const first = f.run(request(), {}, sink); await blocked.promise;
  assert.equal(sink.writableFinished, false);
  const second = await f.run(request(history())); assert.equal(second.statusCode, 409); assert.equal(f.sends.length, 1);
  sink.destroy(); await first;
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

for (const cancel of [false, true]) test(`held SSE tool release keeps the scope busy under HTTP backpressure until ${cancel ? "cancellation pauses it" : "successful finish"}`, async t => {
  const f = await fixture(t), blocked = deferred();
  const chunk = (delta: unknown, finish_reason: string | null = null) => ({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "mock-coder", choices: [{ index: 0, delta, finish_reason }] });
  const frame = (value: unknown) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
  const wire = [frame(chunk({ role: "assistant", tool_calls: [{ index: 0, ...call() }] })), ": held comment\n\n", frame(chunk({ content: "after the tool" })), frame(chunk({}, "tool_calls")), frame("[DONE]")].join("");
  f.response = () => new Response(wire, { headers: { "content-type": "text/event-stream" } });
  const sink = new ResponseSink(); let flush!: () => void; let writes = 0;
  sink._write = (raw, _encoding, done) => { sink.chunks.push(Buffer.from(raw)); if (++writes === 1) { flush = () => done(); blocked.resolve(); } else done(); };
  t.after(() => sink.destroy());
  const first = f.run(request(undefined, { stream: true }), {}, sink); await blocked.promise;
  assert.match(sink.body, /fixture\.txt/); assert.equal(sink.writableFinished, false);
  assert.equal((await f.run(request(history()))).statusCode, 409); assert.equal(f.sends.length, 1);
  if (cancel) sink.destroy(); else flush();
  await first;
  f.response = () => answer();
  assert.equal((await f.run(request(history()))).statusCode, cancel ? 409 : 200); assert.equal(f.sends.length, cancel ? 1 : 2);
  if (!cancel) { assert.equal(sink.writableFinished, true); assert.equal(sink.body, wire); }
});

test("successful HTTP finish unlocks a backpressured response without waiting for handler logging tail", async t => {
  const f = await fixture(t), blocked = deferred(), tail = deferred(), releaseTail = deferred();
  let flush!: () => void; let count = 0;
  f.response = () => ++count === 1 ? answer("call_1") : answer();
  f.afterResponse = async () => { if (count === 1) { tail.resolve(); await releaseTail.promise; } };
  const sink = new ResponseSink();
  sink._write = (chunk, _encoding, done) => { sink.chunks.push(Buffer.from(chunk)); flush = () => done(); blocked.resolve(); };
  const first = f.run(request(), {}, sink); await blocked.promise;
  assert.equal((await f.run(request(history()))).statusCode, 409); assert.equal(f.sends.length, 1);
  flush(); await tail.promise;
  assert.equal((await f.run(request(history()))).statusCode, 200); assert.equal(f.sends.length, 2);
  releaseTail.resolve(); await first;
});

for (const modelOverride of [false, true]) test(`bootstrap excludes explicitly non-Chat source ${modelOverride ? "model" : "source"} capabilities without probing`, async t => {
  const f = await fixture(t);
  f.store.upsertProvider({ ...f.store.provider("a")!, ...(modelOverride ? { protocols: ["chat"], modelProtocols: { "mock-coder": ["messages"] } } : { protocols: ["messages"] }) });
  f.pool.automaticApproval = await mintAutomaticApproval(f.store, f.secrets, f.pool.members); f.store.upsertPool(f.pool);
  f.session.automaticTools!.approvalId = runner.automaticToolApprovalId(f.pool); f.registry.remove(f.session.id); f.registry.register(f.session);
  assert.equal((await f.run()).statusCode, 200); assert.equal(f.sends[0]?.member, "b/mock-coder");
});

test("an approval with no configured Chat source refuses without a dispatch or a probe", async t => {
  const f = await fixture(t);
  for (const id of ["a", "b"]) f.store.upsertProvider({ ...f.store.provider(id)!, protocols: ["messages"] });
  f.pool.automaticApproval = await mintAutomaticApproval(f.store, f.secrets, f.pool.members); f.store.upsertPool(f.pool);
  f.session.automaticTools!.approvalId = runner.automaticToolApprovalId(f.pool); f.registry.remove(f.session.id); f.registry.register(f.session);
  const result = await f.run(); assert.equal(result.statusCode, 400); assert.match(result.body, /Chat/); assert.equal(f.sends.length, 0);
});

test("a global proof cap pauses only the overflowing scope without evicting another launch's proofs", async t => {
  const f = await fixture(t, { maxCalls: 2, maxTotalCalls: 2 });
  f.response = () => answer("one"); await f.run();
  const second = { ...f.session, id: randomUUID() }; f.registry.register(second);
  f.response = () => answer("two"); await f.run(request(), { session: second });
  f.response = () => answer("overflow"); assert.equal((await f.run()).destroyed, true);
  f.response = () => answer();
  assert.equal((await f.run(request(history("two")), { session: second })).statusCode, 200);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 4);
});

test("removal frees the bounded global proof allocation without restoring a removed session", async t => {
  const f = await fixture(t, { maxTotalCalls: 1 }); f.response = () => answer("one"); await f.run();
  f.registry.remove(f.session.id); assert.equal((await f.run()).statusCode, 409);
  const second = { ...f.session, id: randomUUID() }; f.registry.register(second);
  f.response = () => answer("two"); assert.equal((await f.run(request(), { session: second })).statusCode, 200);
});

test("global capacity rejects a complete batch atomically instead of storing its first calls", async t => {
  const f = await fixture(t, { maxTotalCalls: 3 }); f.response = () => answer("old"); await f.run();
  const batch = (ids: string[]) => Response.json({ id: "fixture", object: "chat.completion", created: 1, model: "mock-coder", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: ids.map(id => call(id)) }, finish_reason: "tool_calls" }] });
  f.response = () => batch(["one", "two", "three"]); assert.equal((await f.run()).destroyed, true);
  const second = { ...f.session, id: randomUUID() }; f.registry.register(second);
  f.response = () => batch(["new_one", "new_two"]); assert.equal((await f.run(request(), { session: second })).statusCode, 200);
});

test("expiry pruning releases global proof allocation without resurrecting expired history", async t => {
  let now = Date.now(); const f = await fixture(t, { maxTotalCalls: 1, now: () => now });
  f.response = () => answer("old"); await f.run(); now = Date.parse(f.session.expiresAt) + 1;
  const second = { ...f.session, id: randomUUID(), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString() }; f.registry.register(second);
  f.response = () => answer("new"); assert.equal((await f.run(request(), { session: second })).statusCode, 200);
  assert.equal((await f.run()).statusCode, 409);
});

test("logging-tail failure after completed delivery does not invalidate the successful pinned scope", async t => {
  const f = await fixture(t); f.afterResponse = async () => { throw new Error("synthetic logging failure"); };
  assert.equal((await f.run()).statusCode, 200); f.afterResponse = undefined;
  assert.equal((await f.run()).statusCode, 200); assert.equal(f.sends.length, 2);
});

test("finish-time guard failure pauses without throwing from the HTTP event listener", async t => {
  const f = await fixture(t), blocked = deferred(); f.response = () => answer("call_1"); let flush!: () => void;
  const sink = new ResponseSink(); sink._write = (chunk, _encoding, done) => { sink.chunks.push(Buffer.from(chunk)); flush = () => done(); blocked.resolve(); };
  const first = f.run(request(), {}, sink); await blocked.promise;
  f.allowed = false; flush(); await first; f.allowed = true;
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

for (const choice of ["none", "required"]) test(`runner enforces requested tool_choice=${choice} at the inline output gate`, async t => {
  const f = await fixture(t); f.response = () => answer(choice === "none" ? "forbidden" : undefined);
  assert.equal((await f.run(request(undefined, { tool_choice: choice }))).destroyed, true);
  assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 1);
});

test("credential-read failures are safe ProtocolErrors before entering gateway transport mapping", async t => {
  const f = await fixture(t); const get = f.secrets.get.bind(f.secrets); let reads = 0;
  f.secrets.get = async account => { if (++reads === 3) throw new Error("private synthetic backend detail"); return get(account); };
  const first = await f.run(); assert.equal(first.statusCode, 409); assert.match(first.body, /新开会话/); assert.doesNotMatch(first.body, /private synthetic backend detail/);
  f.secrets.get = get; assert.equal((await f.run()).statusCode, 409); assert.equal(f.sends.length, 0);
});
