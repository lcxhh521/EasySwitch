import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { sourceProtocols } from "../src/outbound.ts";
import { capabilityMatrix } from "../src/capabilities.ts";
import type { SecretStore } from "../src/secrets.ts";
import type { Provider } from "../src/types.ts";

type Json = Record<string, any>;
const clientFetch = fetch; // Retains the preloaded loopback-only network guard.
const dir = mkdtempSync(join(tmpdir(), "es-subscription-routes-"));
const store = new Store(dir);
const values = new Map<string, string>();
const secretCalls: string[] = [];
const opened: string[] = [];
const upstreamRequests: string[] = [];
const secrets: SecretStore = {
  async get(id) { secretCalls.push("get:" + id); return values.get(id); },
  async set(id, value) { secretCalls.push("set:" + id); values.set(id, value); },
  async delete(id) { secretCalls.push("delete:" + id); values.delete(id); },
};
let gateway: Server;
let upstream: Server;
let origin = "";
let upstreamOrigin = "";
const headers = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (method: string, path: string, body?: unknown) => clientFetch(origin + path, {
  method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}
function provider(id: string, extra: Json = {}): Provider {
  return { id, name: id, baseUrl: upstreamOrigin + "/v1", models: ["fixture-model"],
    protocols: ["chat"], route: "chat-translate", routePinned: false, streamUsage: false,
    createdAt: "2026-10-06T00:00:00.000Z", ...extra };
}
function denySideEffects(t: TestContext) {
  const calls: string[] = [];
  const beforeSecrets = secretCalls.length;
  const beforeOpen = opened.length;
  const beforeRequests = upstreamRequests.length;
  t.mock.method(globalThis, "fetch", async () => {
    calls.push("fetch");
    throw new Error("Rejected subscription attempted upstream I/O");
  });
  return () => {
    assert.deepEqual(calls, [], "no upstream fetch attempted, including calls caught by the server");
    assert.equal(secretCalls.length, beforeSecrets, "no secret store access");
    assert.equal(opened.length, beforeOpen, "no login window requested");
    assert.equal(upstreamRequests.length, beforeRequests, "no fixture upstream request");
  };
}

before(async () => {
  upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    upstreamRequests.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/accounts/deviceauth/usercode") {
      res.end(JSON.stringify({ user_code: "TEST-ONLY", device_auth_id: "fixture-device", interval: 3600 }));
    } else if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
    } else if (req.url === "/v1/chat/completions") {
      assert.equal(JSON.parse(raw).model, "fixture-model");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "fixture answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
    } else {
      res.statusCode = 404; res.end(JSON.stringify({ error: "unexpected fixture route" }));
    }
  });
  upstreamOrigin = await listen(upstream);
  gateway = createEasySwitchServer({ store, secrets, port: 0, openUrl: async url => { opened.push(url); } });
  origin = await listen(gateway);
});
after(() => {
  for (const server of [gateway, upstream]) { server?.closeAllConnections(); server?.close(); }
  rmSync(dir, { recursive: true, force: true });
});

test("plan API separates official-support research from preserved mock-validated native adapters", async t => {
  const check = denySideEffects(t);
  const response = await api("GET", "/api/plan");
  assert.equal(response.status, 200);
  const body = await response.json() as Json;
  assert.deepEqual(body.accounts, []);
  assert.equal(body.signIn, null);
  assert.ok(["cursor", "kiro", "antigravity", "gemini-cli", "kimi", "minimax", "droid"].every(v => body.subscriptionSupport.some((s: Json) => s.vendor === v)));
  for (const support of body.subscriptionSupport) {
    if (support.modelSource.available) { assert.equal(support.modelSource.state, "official-api-key"); assert.ok(support.apiRoutes?.length); }
    assert.ok(support.sources.length);
    assert.ok(support.agentRoutes.every((r: Json) => r.implementation === "not-implemented"));
  }
  const matrix = capabilityMatrix();
  assert.equal(matrix.cursor!.source.state, "documented");
  assert.equal(matrix.kiro!.source.state, "documented");
  assert.equal(matrix.antigravity!.source.state, "documented");
  check();
});

test("unsupported and malformed sign-in modes reject before any auth side effect", async t => {
  const check = denySideEffects(t);
  for (const [mode, status] of [["cursor", 501], ["kiro", 501], ["antigravity", 501], ["unknown-secret-mode", 400], [null, 400], [{ token: "fixture-secret" }, 400]] as const) {
    const response = await api("POST", "/api/plan/signin", { mode });
    assert.equal(response.status, status);
    const text = await response.text();
    assert.doesNotMatch(text, /unknown-secret-mode|fixture-secret/);
  }
  assert.equal((await (await api("GET", "/api/plan")).json() as Json).signIn, null);
  check();
});

test("rejected sign-in leaves an existing loopback-only pending login untouched", async t => {
  const oldAuth = process.env.EASYSWITCH_OPENAI_AUTH;
  const oldPoll = process.env.EASYSWITCH_DEVICE_POLL_MS;
  process.env.EASYSWITCH_OPENAI_AUTH = upstreamOrigin;
  process.env.EASYSWITCH_DEVICE_POLL_MS = "3600000";
  try {
    const started = await api("POST", "/api/plan/signin", { mode: "codex" });
    assert.equal(started.status, 200);
    await started.text();
    const before = (await (await api("GET", "/api/plan")).json() as Json).signIn;
    assert.equal(before.status, "waiting");
    assert.equal(before.userCode, "TEST-ONLY");
    assert.ok(before.url.startsWith(upstreamOrigin + "/"));
    const check = denySideEffects(t);
    assert.equal((await api("POST", "/api/plan/signin", { mode: "kiro", cancelOnly: true })).status, 501);
    await new Promise(resolve => setImmediate(resolve));
    const afterState = (await (await api("GET", "/api/plan")).json() as Json).signIn;
    assert.deepEqual(afterState, before);
    check();
  } finally {
    // Cancel only the fake pending flow; no real account, key, browser or CLI was used.
    await (await api("POST", "/api/plan/signin", { cancelOnly: true })).text();
    if (oldAuth === undefined) delete process.env.EASYSWITCH_OPENAI_AUTH; else process.env.EASYSWITCH_OPENAI_AUTH = oldAuth;
    if (oldPoll === undefined) delete process.env.EASYSWITCH_DEVICE_POLL_MS; else process.env.EASYSWITCH_DEVICE_POLL_MS = oldPoll;
  }
});

test("unsupported source creation rejects before key persistence or model probing", async t => {
  const check = denySideEffects(t);
  const beforeProviders = store.providers().length;
  for (const metadata of [
    { cursor: {} }, { kiro: { loginPath: "/fixture/native-login.sqlite3" } }, { antigravity: {} },
    { plan: { kind: "cursor", accountId: "fixture-account" } }, { plan: { kind: "unknown-secret-kind" } },
  ]) {
    const response = await api("POST", "/api/providers", { name: "Rejected source", baseUrl: upstreamOrigin + "/v1", apiKey: "fixture-secret", ...metadata });
    assert.equal(response.status, "plan" in metadata && metadata.plan?.kind === "unknown-secret-kind" ? 400 : 501);
    assert.doesNotMatch(await response.text(), /fixture-secret|native-login\.sqlite3|unknown-secret-kind/);
  }
  assert.equal(store.providers().length, beforeProviders);
  check();
});

test("unsupported and malformed persisted sources fail all four gateway protocols before key lookup", async t => {
  const check = denySideEffects(t);
  const cases = [
    { cursor: {} }, { kiro: { loginPath: "relative-invalid.sqlite3" } }, { antigravity: {} },
    { plan: { kind: "kiro", accountId: "fixture-account" } },
  ];
  for (const [index, metadata] of cases.entries()) {
    const p = provider("unsupported-" + index, metadata); store.upsertProvider(p);
    assert.deepEqual(sourceProtocols(p, "fixture-model"), []);
    for (const [path, body] of [
      ["/v1/chat/completions", { model: p.id + "/fixture-model", messages: [{ role: "user", content: "fixture" }] }],
      ["/v1/responses", { model: p.id + "/fixture-model", input: "fixture" }],
      ["/v1/messages", { model: p.id + "/fixture-model", max_tokens: 20, messages: [{ role: "user", content: "fixture" }] }],
      ["/v1beta/models/" + p.id + "%2Ffixture-model:generateContent", { contents: [{ role: "user", parts: [{ text: "fixture" }] }] }],
    ] as const) {
      const response = await api("POST", path, body);
      assert.equal(response.status, index <= 2 ? 400 : 501, path);
      assert.doesNotMatch(await response.text(), /native-login\.sqlite3|fixture-account/);
    }
  }
  check();
});

test("unsupported stored sources cannot be probed or changed into a working protocol", async t => {
  const check = denySideEffects(t);
  const p = provider("blocked-settings", { kiro: {} }); store.upsertProvider(p);
  const snapshot = JSON.stringify(store.provider(p.id));
  for (const [method, action, body] of [
    ["POST", "probe", { model: "fixture-model" }],
    ["POST", "route", { route: "responses-native" }],
    ["PUT", "protocols", { protocols: ["chat"] }],
  ] as const) {
    const response = await api(method, "/api/providers/" + p.id + "/" + action, body);
    assert.equal(response.status, 501); await response.text();
  }
  assert.equal(JSON.stringify(store.provider(p.id)), snapshot);
  check();
});

test("ordinary flat-rate API sources and vendor-looking names still work through the gateway", async () => {
  const p = provider("ordinary-flat-rate", { name: "Cursor Kiro Antigravity", billing: "subscription" });
  store.upsertProvider(p); values.set(p.id, "fixture-api-key");
  const before = upstreamRequests.length;
  const response = await api("POST", "/v1/chat/completions", { model: p.id + "/fixture-model", messages: [{ role: "user", content: "fixture" }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as Json).choices[0].message.content, "fixture answer");
  assert.deepEqual(upstreamRequests.slice(before), ["/v1/chat/completions"]);
  assert.deepEqual(sourceProtocols(p, "fixture-model"), ["chat"]);
});

test("ordinary provider creation keeps its normal local key and model discovery path", async () => {
  const before = upstreamRequests.length;
  const response = await api("POST", "/api/providers", {
    name: "Cursor ordinary API", baseUrl: upstreamOrigin + "/v1", apiKey: "fixture-api-key", billing: "subscription", protocols: ["chat"],
  });
  assert.equal(response.status, 201);
  const body = await response.json() as Json;
  assert.deepEqual(body.models, ["fixture-model"]);
  assert.deepEqual(body.supportedProtocols, ["chat"]);
  assert.ok(secretCalls.includes("set:" + body.id));
  assert.deepEqual(upstreamRequests.slice(before), ["/v1/models"]);
});
