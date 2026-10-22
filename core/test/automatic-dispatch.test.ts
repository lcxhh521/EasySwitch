import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { currentAutomaticAttempt, withAutomaticAttempt, type AutomaticAttempt, type AutomaticDispatchBudget } from "../src/automatic-dispatch.ts";
import { withKey, pick } from "../src/keypool.ts";
import { prepareOutbound } from "../src/outbound.ts";
import { routeRequest } from "../src/gateway-route.ts";
import { ProtocolError, type InboundRequest } from "../src/protocol.ts";
import { createSecretStore } from "../src/secrets.ts";
import { Store } from "../src/store.ts";
import type { GatewayLogEntry, Provider } from "../src/types.ts";

const provider = (id = "automatic-fixture"): Provider => ({
  id, name: "Automatic fixture", baseUrl: "http://127.0.0.1:1/v1", models: ["m"], protocols: ["chat"],
  route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "",
  keys: ["a", "b"].map(id => ({ id, label: id, enabled: true, addedAt: "" })),
});
const input = (repair = false): InboundRequest => ({ protocol: repair ? "messages" : "chat", model: "m", stream: false,
  body: { messages: [{ role: "user", content: "hello" }], ...(repair ? { max_tokens: 32_000 } : {}) } });
const budget = (): AutomaticDispatchBudget => ({ used: 0, limit: 2 });
const attempt = (p: Provider, extra: Partial<AutomaticAttempt> = {}): AutomaticAttempt => ({
  providerId: p.id, keyId: "a", readKey: async () => "fixture-pinned-key", beforeDispatch: async () => {}, observe: () => {}, ...extra,
});
const signal = () => new AbortController().signal;
function fixture(t: TestContext, p = provider()) {
  const dir = mkdtempSync(join(tmpdir(), "es-automatic-dispatch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir); store.upsertProvider(p);
  return { p, store, secrets: createSecretStore() };
}
function fakeFetch(t: TestContext, fn: typeof globalThis.fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => { globalThis.fetch = original; });
}

test("automatic attempts are async-local, restore outer scope, and pin a copied identity", async () => {
  const p = provider(), a = attempt(p), b = budget();
  assert.equal(currentAutomaticAttempt(), undefined);
  await withAutomaticAttempt(a, b, async () => {
    a.providerId = "changed-after-entry";
    await Promise.resolve();
    assert.equal(currentAutomaticAttempt()?.providerId, p.id);
    await withAutomaticAttempt(attempt(provider("inner")), b, async () => assert.equal(currentAutomaticAttempt()?.providerId, "inner"));
    assert.equal(currentAutomaticAttempt()?.providerId, p.id);
    await assert.rejects(async () => withAutomaticAttempt(attempt(p), budget(), async () => {}), ProtocolError);
  });
  assert.equal(currentAutomaticAttempt(), undefined);
  const seen = await Promise.all(["one", "two"].map(id => withAutomaticAttempt(attempt(provider(id)), budget(), async () => {
    await new Promise(resolve => setTimeout(resolve, 1)); return currentAutomaticAttempt()?.providerId;
  })));
  assert.deepEqual(seen, ["one", "two"]);
});

test("automatic withKey only reads the pinned key and never rotates or rests it after auth failure", async t => {
  const { p, store, secrets } = fixture(t, provider("pinned-key"));
  let reads = 0, runs = 0;
  secrets.get = async () => { throw new Error("ordinary key lookup is forbidden"); };
  const before = JSON.stringify(store.provider(p.id));
  const abort = new AbortController();
  const sent = await withAutomaticAttempt(attempt(p, { keyId: "b", readKey: async s => {
    assert.equal(s, abort.signal); reads++; return "fixed-b";
  } }), budget(), () => withKey(store, secrets, p, async key => {
    assert.equal(key, "fixed-b"); runs++; return new Response("denied", { status: 401 });
  }, abort.signal));
  assert.equal(sent.keyId, "b"); assert.equal(sent.hadRetry, undefined);
  assert.equal(reads, 1); assert.equal(runs, 1);
  assert.equal(JSON.stringify(store.provider(p.id)), before);
  assert.equal(pick(p)?.id, "a", "automatic handling did not advance the ordinary cursor");
});

test("provider mismatch is rejected before pinned or ordinary credential reads", async t => {
  const { p, store, secrets } = fixture(t);
  let reads = 0, runs = 0;
  await assert.rejects(() => withAutomaticAttempt(attempt(provider("other"), { readKey: async () => { reads++; return "fake"; } }), budget(),
    () => withKey(store, secrets, p, async () => { runs++; return Response.json({}); }, signal())), ProtocolError);
  assert.equal(reads, 0); assert.equal(runs, 0);
});

test("nested max_tokens repair consumes the second dispatch and a later pool member cannot send a third", async t => {
  const p = provider(), b = budget(), observed: number[] = [], bodies: Record<string, unknown>[] = [];
  let guarded = 0;
  fakeFetch(t, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? new Response("max_tokens exceeds maximum limit", { status: 400 }) : new Response("upstream unavailable", { status: 503 });
  });
  const result = await withAutomaticAttempt(attempt(p, { beforeDispatch: async () => { guarded++; }, observe: status => observed.push(status) }), b,
    () => prepareOutbound(p, input(true)).send("fixture-pinned-key", signal()));
  assert.ok(result instanceof Response); assert.equal(result.status, 503);
  const other = provider("backup");
  const blocked = await withAutomaticAttempt(attempt(other), b, () => prepareOutbound(other, input()).send("fixture-other-key", signal()));
  assert.ok(blocked instanceof ProtocolError); assert.equal(blocked.status, 409);
  assert.equal(b.used, 2); assert.equal(guarded, 2); assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.max_tokens, 32_000); assert.equal(bodies[1]?.max_tokens, undefined);
  assert.deepEqual(observed, [400, 503]);
});

test("every nested repair revalidates and rejected guards preserve status without dispatch or observation", async t => {
  const p = provider(), b = budget(); let calls = 0, guarded = 0; const observed: number[] = [];
  fakeFetch(t, async () => { calls++; return new Response("max_tokens exceeds maximum limit", { status: 400 }); });
  const rejected = new ProtocolError("local source budget changed", 429);
  const result = await withAutomaticAttempt(attempt(p, { beforeDispatch: async () => { if (++guarded === 2) throw rejected; }, observe: status => observed.push(status) }), b,
    () => prepareOutbound(p, input(true)).send("fake", signal()));
  assert.equal(result, rejected); assert.equal(calls, 1); assert.equal(b.used, 1); assert.equal(guarded, 2);
  assert.deepEqual(observed, [400]);
});

for (const status of [401, 403, 409, 429, 503]) test(`pre-dispatch local HTTP ${status} refusal consumes no dispatch and is not observed`, async t => {
  const p = provider(), b = budget(); let calls = 0, observations = 0;
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  const refused = new ProtocolError("local guard refusal", status);
  const result = await withAutomaticAttempt(attempt(p, { beforeDispatch: async () => { throw refused; }, observe: () => { observations++; } }), b,
    () => prepareOutbound(p, input()).send("fake", signal()));
  assert.equal(result, refused); assert.equal(calls, 0); assert.equal(b.used, 0); assert.equal(observations, 0);
});

for (const change of ["session revoked", "configuration changed", "credential revision changed", "budget blocked"]) test(`final synchronous dispatch guard catches queued ${change} after async validation`, async t => {
  const p = provider(), b = budget(), events: string[] = [];
  let changed = false, calls = 0, observations = 0;
  const refused = new ProtocolError(change, change === "session revoked" ? 403 : change === "budget blocked" ? 429 : 409);
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  const result = await withAutomaticAttempt(attempt(p, {
    beforeDispatch: async () => {
      assert.equal(changed, false); events.push("async validation passed");
      queueMicrotask(() => { changed = true; events.push("queued change"); });
    },
    assertDispatch: () => { events.push("final assertion"); if (changed) throw refused; },
    observe: () => { observations++; },
  }), b, () => prepareOutbound(p, input()).send("fake", signal()));
  assert.equal(calls, 0); assert.equal(b.used, 0); assert.equal(observations, 0); assert.equal(result, refused);
  assert.deepEqual(events, ["async validation passed", "queued change", "final assertion"]);
});

test("final synchronous assertion runs again for max_tokens repair and refusal consumes no second dispatch", async t => {
  const p = provider(), b = budget(); let guarded = 0, asserted = 0, changed = false, calls = 0;
  const observed: number[] = [], refused = new ProtocolError("fixed credential revision changed", 409);
  fakeFetch(t, async () => { calls++; return new Response("max_tokens exceeds maximum limit", { status: 400 }); });
  const result = await withAutomaticAttempt(attempt(p, {
    beforeDispatch: async () => { if (++guarded === 2) queueMicrotask(() => { changed = true; }); },
    assertDispatch: () => { asserted++; if (changed) throw refused; },
    observe: status => observed.push(status),
  }), b, () => prepareOutbound(p, input(true)).send("fake", signal()));
  assert.equal(calls, 1); assert.equal(b.used, 1); assert.equal(guarded, 2); assert.equal(asserted, 2);
  assert.equal(result, refused); assert.deepEqual(observed, [400]);
});

test("no asynchronous gap separates the final assertion, counter update and physical fetch invocation", async t => {
  const p = provider(), b = budget(), events: string[] = []; let queuedChange = false;
  fakeFetch(t, async () => {
    assert.equal(queuedChange, false); assert.equal(b.used, 1); events.push("fetch invoked"); return Response.json({});
  });
  const result = await withAutomaticAttempt(attempt(p, {
    beforeDispatch: async () => { events.push("async validation passed"); },
    assertDispatch: () => { events.push("final assertion"); queueMicrotask(() => { queuedChange = true; events.push("later microtask"); }); },
  }), b, () => prepareOutbound(p, input()).send("fake", signal()));
  assert.ok(result instanceof Response);
  assert.deepEqual(events, ["async validation passed", "final assertion", "fetch invoked", "later microtask"]);
});

test("abort raised by the final synchronous guard still prevents dispatch", async t => {
  const p = provider(), b = budget(), controller = new AbortController(); let calls = 0, observations = 0;
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  const result = await withAutomaticAttempt(attempt(p, {
    assertDispatch: () => controller.abort(), observe: () => { observations++; },
  }), b, () => prepareOutbound(p, input()).send("fake", controller.signal));
  assert.ok(result instanceof Error); assert.equal(result.name, "AbortError");
  assert.equal(calls, 0); assert.equal(b.used, 0); assert.equal(observations, 0);
});

test("cancellation before or during dispatch validation consumes no dispatch", async t => {
  const p = provider(); let calls = 0, guarded = 0, observed = 0;
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  for (const abortedAtEntry of [true, false]) {
    const controller = new AbortController(), b = budget();
    if (abortedAtEntry) controller.abort();
    const result = await withAutomaticAttempt(attempt(p, { beforeDispatch: async () => { guarded++; controller.abort(); }, observe: () => { observed++; } }), b,
      () => prepareOutbound(p, input()).send("fake", controller.signal));
    assert.ok(result instanceof Error); assert.equal(result.name, "AbortError"); assert.equal(b.used, 0);
  }
  assert.equal(calls, 0); assert.equal(guarded, 1); assert.equal(observed, 0);
});

test("cancellation during pinned-key read never enters the send callback", async t => {
  const { p, store, secrets } = fixture(t), controller = new AbortController(); let calls = 0;
  await assert.rejects(() => withAutomaticAttempt(attempt(p, { readKey: async () => { controller.abort(); return "fake"; } }), budget(),
    () => withKey(store, secrets, p, async () => { calls++; return Response.json({}); }, controller.signal)), { name: "AbortError" });
  assert.equal(calls, 0);
});

test("already-cancelled automatic withKey does not read any credential", async t => {
  const { p, store, secrets } = fixture(t), controller = new AbortController(); let reads = 0;
  controller.abort();
  await assert.rejects(() => withAutomaticAttempt(attempt(p, { readKey: async () => { reads++; return "fake"; } }), budget(),
    () => withKey(store, secrets, p, async () => Response.json({}), controller.signal)), { name: "AbortError" });
  assert.equal(reads, 0);
});

test("concurrent guard completion cannot overrun the shared physical dispatch cap", async t => {
  const p = provider(), b = budget(); let calls = 0, observed = 0;
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  const results = await withAutomaticAttempt(attempt(p, { beforeDispatch: async () => { await Promise.resolve(); }, observe: () => { observed++; } }), b,
    () => Promise.all(Array.from({ length: 4 }, () => prepareOutbound(p, input()).send("fake", signal()))));
  assert.equal(calls, 2); assert.equal(b.used, 2); assert.equal(observed, 2);
  assert.equal(results.filter(r => r instanceof ProtocolError && r.status === 409).length, 2);
});

test("network rejection is counted as dispatched but creates no HTTP health observation", async t => {
  const p = provider(), b = budget(); let observed = 0;
  const failure = new TypeError("fixture network failure");
  fakeFetch(t, async () => { throw failure; });
  const result = await withAutomaticAttempt(attempt(p, { observe: () => { observed++; } }), b,
    () => prepareOutbound(p, input()).send("fake", signal()));
  assert.equal(result, failure); assert.equal(b.used, 1); assert.equal(observed, 0);
});

test("unsupported dedicated adapters fail closed before credential, login, refresh or process paths", async t => {
  const { store, secrets } = fixture(t); let calls = 0, reads = 0;
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  const special: Partial<Provider>[] = [
    { plan: { kind: "codex", accountId: "fixture" } }, { plan: { kind: "copilot", accountId: "fixture" } },
    { kiro: {} }, { mimoFree: true }, { antigravity: { accountId: "fixture", email: "fixture@example.invalid", projectId: "fixture" } },
    { kimi: { accountId: "fixture" } }, { cursor: { accountId: "fixture" } },
    { vertex: { mode: "service-account", project: "fixture", location: "global" } } as Partial<Provider>,
    { cliTextBridge: { kind: "qoder" } } as Partial<Provider>,
  ];
  for (const config of special) {
    const p = { ...provider(), ...config };
    await withAutomaticAttempt(attempt(p, { readKey: async () => { reads++; return "fake"; } }), budget(), async () => {
      assert.throws(() => prepareOutbound(p, input()), ProtocolError);
      await assert.rejects(() => withKey(store, secrets, p, async () => { calls++; return Response.json({}); }, signal()), ProtocolError);
    });
  }
  assert.equal(reads, 0); assert.equal(calls, 0);
});

test("an outbound prepared outside context cannot bypass the bound provider inside context", async t => {
  const p = provider(), prepared = prepareOutbound(p, input()), b = budget(); let calls = 0;
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  const result = await withAutomaticAttempt(attempt(provider("different")), b, () => prepared.send("fake", signal()));
  assert.ok(result instanceof ProtocolError); assert.equal(calls, 0); assert.equal(b.used, 0);
});

test("dedicated adapters prepared outside context still fail closed before their send paths", async t => {
  let calls = 0;
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  for (const config of [{ plan: { kind: "codex", accountId: "fixture" } }, { kiro: {} }] as Partial<Provider>[]) {
    const p = { ...provider(), ...config }, b = budget();
    const prepared = prepareOutbound(p, input());
    const result = await withAutomaticAttempt(attempt(p), b, () => prepared.send("fake", signal()));
    assert.ok(result instanceof ProtocolError); assert.equal(result.status, 400); assert.equal(b.used, 0);
  }
  assert.equal(calls, 0);
});

test("a locally unserializable payload consumes no physical dispatch or observation", async t => {
  const p = provider(), b = budget(); let calls = 0, guarded = 0, observed = 0;
  fakeFetch(t, async () => { calls++; return Response.json({}); });
  const malformed = input(); malformed.body.local_invalid_extension = 1n;
  const result = await withAutomaticAttempt(attempt(p, { beforeDispatch: async () => { guarded++; }, observe: () => { observed++; } }), b,
    () => prepareOutbound(p, malformed).send("fake", signal()));
  assert.ok(result instanceof TypeError); assert.equal(calls, 0); assert.equal(b.used, 0); assert.equal(observed, 0); assert.equal(guarded, 0);
});

test("ordinary withKey and outbound repair keep their prior behavior without automatic context", async t => {
  const { p, store, secrets } = fixture(t, provider("ordinary-key")); const keys: string[] = [];
  await secrets.set(`${p.id}#a`, "ordinary-a"); await secrets.set(`${p.id}#b`, "ordinary-b");
  const sent = await withKey(store, secrets, p, async key => { keys.push(key!); return new Response("", { status: keys.length === 1 ? 401 : 200 }); });
  assert.deepEqual(keys, ["ordinary-a", "ordinary-b"]); assert.equal(sent.hadRetry, true); assert.equal(sent.keyId, "b");
  let calls = 0;
  fakeFetch(t, async () => { calls++; return calls === 1 ? new Response("max_tokens exceeds maximum limit", { status: 400 }) : Response.json({}); });
  const result = await prepareOutbound(p, input(true)).send("fake", signal());
  assert.ok(result instanceof Response); assert.equal(result.status, 200); assert.equal(calls, 2);
});

test("gateway preserves automatic local guard status and pinned key log instead of mapping it to retriable 502", async t => {
  const { p, store, secrets } = fixture(t), logs: GatewayLogEntry[] = [];
  let physical = 0, observed = 0; const realFetch = globalThis.fetch;
  const server = createServer((req, res) => {
    req.resume();
    void withAutomaticAttempt(attempt(p, { keyId: "b", beforeDispatch: async () => { throw new ProtocolError("local authorization expired", 403); }, observe: () => { observed++; } }), budget(),
      () => routeRequest(req, res, { ...input(), model: `${p.id}/m` }, "fixture", { store, secrets, log: entry => logs.push(entry) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/fixture`;
  fakeFetch(t, async (target, init) => {
    if (String(target) === url) return realFetch(target, init);
    physical++; return Response.json({});
  });
  const response = await fetch(url); assert.equal(response.status, 403);
  assert.match(await response.text(), /local authorization expired/);
  assert.equal(physical, 0); assert.equal(observed, 0);
  assert.equal(logs.length, 1); assert.equal(logs[0]?.status, 403); assert.equal(logs[0]?.keyId, "b");
});
