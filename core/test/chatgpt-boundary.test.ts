import assert from "node:assert/strict";
import { createServer, request, type Server, type IncomingHttpHeaders } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { chatgptUpstream } from "../src/chatgpt-gateway.ts";
import { Store } from "../src/store.ts";
import { DEFAULT_BUDGET } from "../src/global-budget.ts";

const listen = async (server: Server) => { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); };
async function http(base: string, path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; text: string; body: any }> {
  return new Promise((resolve, reject) => {
    const req = request(base + path, { method, headers }, res => { let text = ""; res.on("data", d => text += d); res.on("end", () => { let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, text, body }); }); });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-chatgpt-boundary-"));
  const native: IncomingHttpHeaders[] = [], external: IncomingHttpHeaders[] = []; let keyReads = 0, upgrades = 0;
  const upstream = createServer((req, res) => {
    req.resume(); res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/backend-api/codex")) {
      native.push(req.headers);
      res.end(JSON.stringify(req.url.includes("/models") ? { models: [{ slug: "gpt-fixture", display_name: "Native" }] } : { native: true }));
    } else {
      external.push(req.headers);
      res.end(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content: "external answer" }, finish_reason: "stop" }] }));
    }
  });
  upstream.on("upgrade", (_req, socket) => { upgrades++; socket.destroy(); });
  const remote = await listen(upstream);
  const old = process.env.EASYSWITCH_CHATGPT_UPSTREAM, flag = process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES;
  process.env.EASYSWITCH_CHATGPT_UPSTREAM = remote + "/backend-api/codex"; process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES = "1";
  const store = new Store(dir); store.upsertProvider({ id: "p", name: "private source", baseUrl: remote + "/v1", models: ["m"], protocols: ["chat"], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "" });
  const auth = new GatewayTokenAuthority();
  const gateway = createEasySwitchServer({ store, port: 0, gatewayAuth: auth, secrets: { async get() { keyReads++; return "fixture-stored-key"; }, async set() {}, async delete() {} } });
  const base = await listen(gateway);
  t.after(async () => { await close(gateway); await close(upstream); if (old === undefined) delete process.env.EASYSWITCH_CHATGPT_UPSTREAM; else process.env.EASYSWITCH_CHATGPT_UPSTREAM = old; if (flag === undefined) delete process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES; else process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES = flag; rmSync(dir, { recursive: true, force: true }); });
  return { base, auth, native, external, keyReads: () => keyReads, upgrades: () => upgrades };
}

test("ChatGPT vendor credentials never authorize stored external source keys or local catalog access", async t => {
  const f = await fixture(t); const revoked = f.auth.issue("chatgpt"); f.auth.revoke(revoked.token);
  const cases: Array<Record<string, string>> = [{}, { authorization: "Bearer fixture-vendor" }, { authorization: "Bearer es-session-codex-fake" }, { authorization: "Bearer fixture-vendor", "x-easyswitch-session": revoked.token }];
  for (const headers of cases) {
    const answer = await http(f.base, "/backend-api/codex/responses", "POST", headers, { model: "p/m", input: "hello" });
    assert.equal(answer.status, 401, answer.text);
  }
  assert.equal(f.keyReads(), 0); assert.equal(f.external.length, 0); assert.equal(f.native.length, 0);
  assert.equal((await http(f.base, "/backend-api/codex/models")).status, 401);
  const models = await http(f.base, "/backend-api/codex/models", "GET", { authorization: "Bearer fixture-vendor" });
  assert.equal(models.status, 200); assert.deepEqual(models.body.models.map((m: any) => m.slug), ["gpt-fixture"]);
  assert.equal(f.keyReads(), 0);
});

test("a local capability authorizes external inference and catalog merging without leaking either credential", async t => {
  const f = await fixture(t); const token = f.auth.issue("chatgpt").token;
  const headers = { authorization: "Bearer fixture-vendor", "x-easyswitch-session": token };
  const answer = await http(f.base, "/backend-api/codex/responses", "POST", headers, { model: "p/m", input: "hello" });
  assert.equal(answer.status, 200, answer.text); assert.match(answer.text, /external answer/);
  assert.equal(f.keyReads(), 1); assert.equal(f.external[0]?.authorization, "Bearer fixture-stored-key");
  assert.equal(f.native.length, 0); assert.ok(!JSON.stringify(f.external).includes(token)); assert.ok(!JSON.stringify(f.external).includes("fixture-vendor"));
  const models = await http(f.base, "/backend-api/codex/models", "GET", headers);
  assert.equal(models.status, 200); assert.ok(models.body.models.some((m: any) => m.slug === "p/m"));
  assert.equal(f.native[0]?.authorization, "Bearer fixture-vendor"); assert.equal(f.native[0]?.["x-easyswitch-session"], undefined);
  f.auth.revoke(token);
  assert.equal((await http(f.base, "/backend-api/codex/responses", "POST", headers, { model: "p/m", input: "hello" })).status, 401);
  assert.equal(f.keyReads(), 1);
});

test("native HTTP uses only caller-supplied vendor credentials and never borrows local secrets", async t => {
  const f = await fixture(t);
  const body = { model: "gpt-fixture", input: "hello" };
  assert.equal((await http(f.base, "/backend-api/codex/responses", "POST", {}, body)).status, 401);
  const onlyLocal = f.auth.issue("codex").token;
  assert.equal((await http(f.base, "/backend-api/codex/responses", "POST", { authorization: `Bearer ${onlyLocal}` }, body)).status, 401);
  const answer = await http(f.base, "/backend-api/codex/responses", "POST", { authorization: "Bearer fixture-vendor" }, body);
  assert.equal(answer.status, 200); assert.equal(answer.body.native, true);
  assert.equal(f.keyReads(), 0); assert.equal(f.external.length, 0); assert.equal(f.native[0]?.authorization, "Bearer fixture-vendor");
  assert.equal((await http(f.base, "/api/chatgpt/enhance", "POST", { "x-easyswitch": "1" }, {})).status, 409);
  assert.equal((await http(f.base, "/api/budget", "PUT", { "x-easyswitch": "1" }, { ...DEFAULT_BUDGET, enabled: true, action: "stop", limitUsd: 0 })).status, 200);
  assert.equal((await http(f.base, "/backend-api/codex/responses", "POST", { authorization: "Bearer fixture-vendor" }, body)).status, 429);
  assert.equal(f.native.length, 1); assert.equal(f.keyReads(), 0);
});

test("production native WebSocket remains closed for vendor and valid local credentials", async t => {
  const f = await fixture(t); const token = f.auth.issue("codex").token;
  for (const headers of [{}, { authorization: "Bearer fixture-vendor" }, { authorization: "Bearer fixture-vendor", "x-easyswitch-session": token }]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(f.base + "/backend-api/codex/responses", { headers: { ...headers, connection: "Upgrade", upgrade: "websocket" } });
      req.on("response", res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("upgrade", (_res, socket) => { socket.destroy(); reject(new Error("must not open native tunnel")); }); req.on("error", reject); req.end();
    });
    assert.equal(status, 409);
  }
  assert.equal(f.upgrades(), 0); assert.equal(f.keyReads(), 0); assert.equal(f.native.length, 0);
});

test("native destination overrides cannot send vendor credentials outside the official host or explicit loopback fixtures", () => {
  const old = process.env.EASYSWITCH_CHATGPT_UPSTREAM, flag = process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES;
  try {
    delete process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES;
    for (const value of ["http://chatgpt.com/backend-api/codex", "https://example.invalid/backend-api/codex", "https://chatgpt.com:444/backend-api/codex", "https://user@chatgpt.com/backend-api/codex", "https://chatgpt.com/backend-api/codex?x=1", "https://chatgpt.com/not-codex", "http://127.0.0.1:1/backend-api/codex"]) { process.env.EASYSWITCH_CHATGPT_UPSTREAM = value; assert.throws(chatgptUpstream); }
    process.env.EASYSWITCH_CHATGPT_UPSTREAM = "https://chatgpt.com/backend-api/codex"; assert.equal(chatgptUpstream(), process.env.EASYSWITCH_CHATGPT_UPSTREAM);
  } finally { if (old === undefined) delete process.env.EASYSWITCH_CHATGPT_UPSTREAM; else process.env.EASYSWITCH_CHATGPT_UPSTREAM = old; if (flag === undefined) delete process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES; else process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES = flag; }
});
