import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { clearRest } from "../src/pools.ts";
import { Store } from "../src/store.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

let good: Awaited<ReturnType<typeof startMockRelay>>;
let alsoGood: Awaited<ReturnType<typeof startMockRelay>>;
let bad: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let ids: { good: string; alsoGood: string; bad: string };
let store: Store;
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });

before(async () => {
  good = await startMockRelay(0, { apiKey: "k1" });
  alsoGood = await startMockRelay(0, { apiKey: "k2" });
  bad = await startMockRelay(0, { apiKey: "the-right-key" }); // the provider below is given a different key: every call is a 401
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const p = (probe.address() as { port: number }).port; probe.close(() => resolve(p)); });
  });
  store = new Store(mkdtempSync(join(tmpdir(), "es-pool-")));
  server = createEasySwitchServer({ store, secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  const add = async (name: string, relay: typeof good, apiKey: string) =>
    ((await (await api("POST", "/api/providers", { name, baseUrl: relay.baseUrl, apiKey })).json()) as { id: string }).id;
  ids = { good: await add("good-relay", good, "k1"), alsoGood: await add("also-good", alsoGood, "k2"), bad: await add("bad-relay", bad, "wrong-key") };
  // The probe of the provider with the wrong key found no models; tell the store what it serves.
  for (const id of Object.values(ids)) { const p = store.provider(id)!; p.models = ["mock-coder", "mock-mini"]; store.upsertProvider(p); }
});

after(() => { server.closeAllConnections(); server.close(); for (const r of [good, alsoGood, bad]) { r.server.closeAllConnections(); r.server.close(); } });

const members = () => [`${ids.bad}/mock-coder`, `${ids.good}/mock-coder`];
const chat = (model: string, extra: Json = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken("aider")}` },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with exactly the word: pong" }], ...extra }),
});

test("a pool needs a name and at least two sources; members that do not exist are dropped", async () => {
  assert.equal((await api("POST", "/api/pools", { name: "", members: members() })).status, 400);
  assert.equal((await api("POST", "/api/pools", { name: "x", members: [members()[0]] })).status, 400);
  assert.equal((await api("POST", "/api/pools", { name: "x", members: [members()[0], "nobody/nothing"] })).status, 400, "only one real member is left");
});

test("when the first member refuses (bad key), the next answers and the agent never sees the failure", async () => {
  const made = (await (await api("POST", "/api/pools", { name: "Failover", strategy: "order", members: members() })).json()) as Json;
  assert.equal(made.id, "failover");
  const before = { bad: bad.requests.length, good: good.requests.length };
  const res = await chat("pool/failover");
  assert.equal(res.status, 200, await res.clone().text());
  assert.match(((await res.json()) as Json).choices[0].message.content, /pong|Hello/i);
  assert.equal(bad.requests.length, before.bad, "the bad provider rejected the key before it was served (401 at the door)");
  assert.equal(good.requests.length, before.good + 1);
});

test("a member that just failed rests: the next request goes straight to the one that works", async () => {
  const before = good.requests.length;
  const res = await chat("pool/failover");
  assert.equal(res.status, 200);
  assert.equal(good.requests.length, before + 1);
});

test("streaming goes through the pool, and so do Claude Code's and Codex's protocols", async () => {
  const stream = await chat("pool/failover", { stream: true });
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /\[DONE\]/);
  const msg = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "pool/failover", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(msg.status, 200, await msg.clone().text());
  const resp = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "pool/failover", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }], stream: false }),
  });
  assert.equal(resp.status, 200, await resp.clone().text());
});

test("when every member fails, the agent gets the last member's error, not a hang", async () => {
  await api("POST", "/api/pools", { name: "Doomed", members: [`${ids.bad}/mock-coder`, `${ids.bad}/mock-mini`] });
  const res = await chat("pool/doomed");
  assert.equal(res.status, 401);
});

test("an error the next member would share (a malformed request) is not retried elsewhere", async () => {
  const before = alsoGood.requests.length + good.requests.length;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "pool/failover", messages: [{ role: "nonsense", content: "x" }] }),
  });
  assert.ok(res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403 && res.status !== 429);
  assert.ok(alsoGood.requests.length + good.requests.length <= before + 1, "one attempt, no scatter");
});

test("rotate spreads requests over the members", async () => {
  await api("POST", "/api/pools", { name: "Spread", strategy: "rotate", members: [`${ids.good}/mock-coder`, `${ids.alsoGood}/mock-coder`] });
  const a = good.requests.length, b = alsoGood.requests.length;
  for (let i = 0; i < 4; i++) assert.equal((await chat("pool/spread")).status, 200);
  assert.equal(good.requests.length - a, 2);
  assert.equal(alsoGood.requests.length - b, 2);
});

test("pools show up as models for every agent, and a pool offers only the thinking levels all its members have", async () => {
  const list = (await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json()) as { data: Array<{ id: string }> };
  assert.ok(list.data.some(m => m.id === "pool/failover"));
  const claude = (await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { "anthropic-version": "2023-06-01" } })).json()) as { data: Array<{ id: string }> };
  assert.ok(claude.data.some(m => m.id === "es-claude-pool--failover"), "Claude Code's menu gets the pool too");
  for (const id of [ids.good, ids.alsoGood]) await api("PUT", `/api/providers/${id}/model-efforts`, { model: "mock-coder", levels: ["low", "high", "max"] });
  await api("PUT", `/api/providers/${ids.alsoGood}/model-efforts`, { model: "mock-coder", levels: ["low", "high"] });
  const pools = (await (await api("GET", "/api/pools")).json()) as { pools: Array<{ id: string; efforts: string[] }> };
  assert.deepEqual(pools.pools.find(p => p.id === "spread")!.efforts, ["low", "high"]);
});

test("a pool can be edited and deleted, and an agent bound to it falls back to native", async () => {
  await api("PUT", "/api/bindings/aider", { providerId: "pool", model: "spread" });
  assert.equal((await api("PUT", "/api/pools/spread", { name: "Spread", strategy: "order", members: members() })).status, 200);
  assert.equal(store.pool("spread")!.strategy, "order");
  assert.equal((await api("DELETE", "/api/pools/spread")).status, 200);
  assert.equal(store.pool("spread"), undefined);
  assert.equal(store.binding("aider"), undefined, "no binding points at a pool that is gone");
});

test("the log says which pool and which try each request was, so a failover can be read afterwards", async () => {
  clearRest(); // earlier tests left some members resting
  await api("POST", "/api/pools", { name: "Logged", members: [`${ids.bad}/mock-mini`, `${ids.good}/mock-mini`] });
  assert.equal((await chat("pool/logged")).status, 200);
  const state = (await (await api("GET", "/api/state")).json()) as { log: Array<{ pool?: string; attempt?: number; attempts?: number; status: number; providerId?: string }> };
  const tries = state.log.filter(e => e.pool === "pool/logged").sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
  assert.deepEqual(tries.map(e => [e.attempt, e.attempts, e.status]), [[1, 2, 401], [2, 2, 200]]);
  assert.equal(tries[0]!.providerId, ids.bad);
  assert.equal(tries[1]!.providerId, ids.good);
  assert.equal((tries[0] as Json).retryFrom, undefined, "a failed entry cannot promise a future attempt");
  assert.deepEqual((tries[1] as Json).retryFrom, { member: `${ids.bad}/mock-mini`, attempt: 1, status: 401 }, "only the subsequent attempt carries evidence; no extra billable log entry is added");
});

test("profiles over the API: save, list, apply, delete", async () => {
  await api("PUT", "/api/bindings/aider", { providerId: ids.good, model: "mock-coder" });
  const saved = (await (await api("POST", "/api/profiles", { name: "一号" })).json()) as { id: string };
  await api("DELETE", "/api/bindings/aider");
  assert.equal(store.binding("aider"), undefined);
  assert.equal((await api("POST", `/api/profiles/${saved.id}/apply`)).status, 200);
  assert.equal(store.binding("aider")!.providerId, ids.good);
  const list = (await (await api("GET", "/api/profiles")).json()) as { profiles: Array<{ name: string; agents: number }> };
  assert.equal(list.profiles[0]!.name, "一号");
  assert.equal((await api("POST", "/api/profiles", { name: " " })).status, 400);
  assert.equal((await api("DELETE", `/api/profiles/${saved.id}`)).status, 200);
  assert.equal((await api("POST", `/api/profiles/${saved.id}/apply`)).status, 404);
});
