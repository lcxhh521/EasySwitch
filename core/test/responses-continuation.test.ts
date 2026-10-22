import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { clearRest } from "../src/pools.ts";
import { clearQuota, recordLimitReached } from "../src/quota.ts";
import { withKey } from "../src/keypool.ts";
import type { SecretStore } from "../src/secrets.ts";
import type { Json } from "../src/protocol.ts";
import type { ProviderKey } from "../src/types.ts";

const histories: Record<string, Json> = {
  compaction: { input: [{ type: "compaction", encrypted_content: "synthetic-compaction" }] },
  previous_response_id: { input: "continue", previous_response_id: "resp_synthetic" },
  conversation: { input: "continue", conversation: { id: "conv_synthetic" } },
};
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const keys = (enabled = [true, true]): ProviderKey[] => enabled.map((on, i) => ({ id: String(i), label: String(i), enabled: on, addedAt: "" }));

async function fixture(t: TestContext) {
  clearRest(); clearQuota();
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-continuation-"));
  const store = new Store(dir), auth = new GatewayTokenAuthority();
  const seen: Array<{ key: string | undefined; body: Json }> = [], reads: string[] = [];
  const secrets: SecretStore = { get: async id => { reads.push(id); return `fixture-${id}`; }, set: async () => {}, delete: async () => {} };
  let status = 401;
  const failure = '{"error":{"message":"synthetic original failure"}}';
  const success = '{"id":"resp_fixture","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}';
  const reply = () => status === 200 ? success : failure;
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    seen.push({ key: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(status, { "content-type": "application/json", "retry-after": "9" }).end(reply());
  });
  const baseUrl = await listen(upstream);
  for (const id of ["p", "q"]) store.upsertProvider({ id, name: id, baseUrl, models: ["m"], protocols: ["responses"], route: "responses-native", routePinned: true, streamUsage: false, createdAt: "" });
  const gateway = createEasySwitchServer({ store, secrets, port: 0, gatewayAuth: auth });
  t.after(() => {
    for (const server of [gateway, upstream]) { server.closeAllConnections(); server.close(); }
    rmSync(dir, { recursive: true, force: true }); clearRest(); clearQuota();
  });
  const origin = await listen(gateway), session = auth.issue("codex");
  const post = (history: Json, model = "p/m", path = "/v1/responses") => fetch(origin + path, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch-session": session.token }, body: JSON.stringify({ ...history, model }),
  });
  return { store, secrets, seen, reads, post, get reply() { return reply(); }, status: (value: number) => { status = value; } };
}

// The six cases previously kept as TODO in research/opaque-continuation-fallback.repro.ts.
for (const mode of ["key", "pool"] as const) for (const [kind, history] of Object.entries(histories)) {
  test(`${kind}: ambiguous ${mode} routing stops before reading credentials or sending`, async t => {
    const f = await fixture(t);
    if (mode === "key") f.store.upsertProvider({ ...f.store.provider("p")!, keys: keys() });
    else f.store.upsertPool({ id: "proof", name: "Proof", strategy: "order", members: ["p/m", "q/m"], createdAt: "" });
    const response = await f.post(history, mode === "key" ? "p/m" : "pool/proof");
    assert.equal(response.status, 409);
    assert.equal((await response.json() as Json).error.code, "continuation_source_required");
    assert.deepEqual(f.reads, []); assert.deepEqual(f.seen, []);
  });
}

for (const [kind, history] of Object.entries(histories)) test(`${kind}: direct continuation retains its source despite an agent backup`, async t => {
  const f = await fixture(t);
  f.store.setPrefs("codex", { fallbackModel: "q/m" });
  recordLimitReached("p", Date.now() + 60_000);
  const response = await f.post(history);
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("retry-after"), "9");
  assert.equal(await response.text(), f.reply);
  assert.deepEqual(f.reads, ["p"]);
  assert.deepEqual(f.seen, [{ key: "Bearer fixture-p", body: { ...history, model: "m" } }]);
});

test("one active key preserves native continuation and records failure without rereading or switching keys", async t => {
  const f = await fixture(t);
  f.store.upsertProvider({ ...f.store.provider("p")!, keys: keys([true, false]) });
  for (const status of [200, 401, 403, 429, 503]) {
    f.status(status); f.reads.length = 0; f.seen.length = 0;
    const response = await f.post({ ...histories.compaction, metadata: { keep: true } });
    assert.equal(response.status, status); assert.equal(await response.text(), f.reply);
    assert.deepEqual(f.reads, ["p#0"]);
    assert.deepEqual(f.seen, [{ key: "Bearer fixture-p#0", body: { ...histories.compaction, metadata: { keep: true }, model: "m" } }]);
    if ([401, 403, 429].includes(status)) assert.equal(f.store.provider("p")!.keys![0]!.lastError?.status, status);
  }
});

test("resting keys and temporarily unavailable pool members do not establish continuation identity", async t => {
  const f = await fixture(t);
  const configured = keys(); configured[1] = { ...configured[1]!, restUntil: new Date(Date.now() + 60_000).toISOString() };
  f.store.upsertProvider({ ...f.store.provider("p")!, keys: configured });
  assert.equal((await f.post(histories.compaction!)).status, 409);
  f.store.upsertProvider({ ...f.store.provider("p")!, keys: [] });
  f.store.upsertProvider({ ...f.store.provider("q")!, off: true });
  for (const strategy of ["order", "rotate", "automatic"] as const) {
    f.store.upsertPool({ id: "proof", name: "Proof", strategy, members: ["p/m", "q/m"], createdAt: "" });
    const response = await f.post(histories.compaction!, "pool/proof");
    assert.equal(response.status, strategy === "automatic" ? 400 : 409);
    assert.equal((await response.json()).error.code, strategy === "automatic" ? "automatic_selection_paused" : "continuation_source_required");
  }
  assert.deepEqual(f.reads, []); assert.deepEqual(f.seen, []);
});

test("a disabled sole key cannot turn into a legacy credential for continuation", async t => {
  const f = await fixture(t);
  f.store.upsertProvider({ ...f.store.provider("p")!, keys: keys([false]) });
  assert.equal((await f.post(histories.compaction!)).status, 409);
  assert.deepEqual(f.reads, []); assert.deepEqual(f.seen, []);
});

test("the desktop external-model route enforces the same pool and key boundaries", async t => {
  const f = await fixture(t), path = "/backend-api/codex/responses";
  f.store.upsertPool({ id: "proof", name: "Proof", strategy: "rotate", members: ["p/m", "q/m"], createdAt: "" });
  assert.equal((await f.post(histories.previous_response_id!, "pool/proof", path)).status, 409);
  f.store.upsertProvider({ ...f.store.provider("p")!, keys: keys() });
  assert.equal((await f.post(histories.previous_response_id!, "p/m", path)).status, 409);
  assert.equal(f.reads.length, 0); assert.equal(f.seen.length, 0);
  f.store.upsertProvider({ ...f.store.provider("p")!, keys: [] });
  f.store.setPrefs("codex", { fallbackModel: "q/m" }); recordLimitReached("p", Date.now() + 60_000);
  const response = await f.post(histories.previous_response_id!, "p/m", path);
  assert.equal(response.status, 401); assert.equal(await response.text(), f.reply);
  assert.deepEqual(f.reads, ["p"]); assert.equal(f.seen[0]!.key, "Bearer fixture-p");
});

test("the /responses alias rejects a rotating pool without consuming its next selection", async t => {
  const f = await fixture(t);
  f.store.upsertPool({ id: "rotation-proof", name: "Proof", strategy: "rotate", members: ["p/m", "q/m"], createdAt: "" });
  const rejected = await f.post({ conversation: "conv_synthetic", input: "continue" }, "pool/rotation-proof", "/responses");
  assert.equal(rejected.status, 409); await rejected.text(); assert.deepEqual(f.reads, []);
  f.status(200);
  const fresh = await f.post({ input: "new request" }, "pool/rotation-proof");
  assert.equal(fresh.status, 200); await fresh.text();
  assert.deepEqual(f.seen.map(s => s.key), ["Bearer fixture-p"]);
});

test("cross-protocol opaque history still fails before credentials or upstream I/O", async t => {
  const f = await fixture(t);
  f.store.upsertProvider({ ...f.store.provider("p")!, protocols: ["chat"] });
  for (const history of Object.values(histories)) {
    const response = await f.post(history); assert.equal(response.status, 400); await response.text();
  }
  assert.deepEqual(f.reads, []); assert.deepEqual(f.seen, []);
});

test("stateless requests including null references retain pool and key retries", async t => {
  const f = await fixture(t), history = { input: "new request", previous_response_id: null, conversation: null };
  f.store.upsertProvider({ ...f.store.provider("p")!, keys: keys() });
  const keyed = await f.post(history); assert.equal(keyed.status, 401); await keyed.text();
  assert.equal(f.seen.length, 2); assert.notEqual(f.seen[0]!.key, f.seen[1]!.key);
  f.seen.length = 0; f.store.upsertProvider({ ...f.store.provider("p")!, keys: [] });
  f.store.upsertPool({ id: "proof", name: "Proof", strategy: "order", members: ["p/m", "q/m"], createdAt: "" });
  const pooled = await f.post(history, "pool/proof"); assert.equal(pooled.status, 401); await pooled.text();
  assert.deepEqual(f.seen.map(s => s.key), ["Bearer fixture-p", "Bearer fixture-q"]);
});

test("per-request no-retry policy preserves the first error without reading a second key", async t => {
  const f = await fixture(t), provider = { ...f.store.provider("p")!, keys: keys() };
  f.store.upsertProvider(provider);
  const original = new Response("original", { status: 401 }); let calls = 0;
  const sent = await withKey(f.store, f.secrets, provider, async () => { calls++; return original; }, new AbortController().signal, { retry: false });
  assert.equal(sent.response, original); assert.equal(sent.hadRetry, undefined);
  assert.equal(calls, 1); assert.equal(f.reads.length, 1); assert.equal(await original.text(), "original");
});
