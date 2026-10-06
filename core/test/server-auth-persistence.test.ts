import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

async function http(base: string, path: string, method = "GET", body?: unknown, token?: string) {
  return new Promise<{ status: number; body: any; text: string }>((resolve, reject) => {
    const req = request(base + path, { method, headers: { "x-easyswitch": "1", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      let text = ""; res.on("data", d => text += d); res.on("end", () => { let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, body, text }); });
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function start(dir: string, auth: GatewayTokenAuthority): Promise<{ server: Server; base: string; close(): Promise<void> }> {
  const server = createEasySwitchServer({ store: new Store(dir), gatewayAuth: auth, port: 0, secrets: { async get() { assert.fail("auth tests must not read keys"); }, async set() { assert.fail("no key writes"); }, async delete() { assert.fail("no key deletion"); } } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
function dir(t: { after(fn: () => void): void }) { const path = mkdtempSync(join(realpathSync(tmpdir()), "es-server-auth-")); t.after(() => rmSync(path, { recursive: true, force: true })); return path; }

test("manual API persistence survives server restart with original expiry and durable revocation", async t => {
  const path = dir(t), stateFile = join(path, "sessions.jsonl");
  const first = await start(path, new GatewayTokenAuthority({ stateFile }));
  const issued = await http(first.base, "/api/gateway/sessions", "POST", { agentId: "codex" });
  assert.equal(issued.status, 201); assert.equal(issued.body.kind, "manual");
  assert.equal(Date.parse(issued.body.expiresAt) - Date.parse(issued.body.issuedAt), 86400_000);
  assert.equal((await http(first.base, "/v1/models", "GET", undefined, issued.body.token)).status, 200);
  await first.close();
  const second = await start(path, new GatewayTokenAuthority({ stateFile }));
  try {
    assert.equal((await http(second.base, "/v1/models", "GET", undefined, issued.body.token)).status, 200);
    const list = await http(second.base, "/api/gateway/sessions"); assert.equal(list.body.sessions[0].expiresAt, issued.body.expiresAt);
    assert.ok(!list.text.includes(issued.body.token)); assert.ok(!readFileSync(stateFile, "utf8").includes(issued.body.token));
    assert.equal((await http(second.base, `/api/gateway/sessions/${issued.body.id}`, "DELETE")).status, 200);
    const missing = await http(second.base, `/api/gateway/sessions/${issued.body.id}`, "DELETE");
    assert.equal(missing.status, 404); assert.equal(missing.body.ok, false);
  } finally { await second.close(); }
  const final = new GatewayTokenAuthority({ stateFile }); assert.equal(final.authenticate({ authorization: `Bearer ${issued.body.token}` }), undefined);
});

test("manual API and guides share rate limits while launcher issuance retains reserved capacity", async t => {
  const path = dir(t); const auth = new GatewayTokenAuthority({ maxSessions: 8, maxManualSessions: 2, maxManualPerAgent: 2, manualRateLimit: 1 });
  const app = await start(path, auth);
  try {
    assert.equal((await http(app.base, "/api/agents/workbuddy/setup", "POST", {})).status, 200);
    assert.equal((await http(app.base, "/api/agents/workbuddy/setup", "POST", {})).status, 429);
    assert.equal((await http(app.base, "/api/gateway/sessions", "POST", { agentId: "codex" })).status, 201);
    assert.equal((await http(app.base, "/api/gateway/sessions", "POST", { agentId: "claude" })).status, 429);
    assert.ok(auth.issue("codex"));
  } finally { await app.close(); }
});

test("corrupt persistent token storage returns a recovery error without issuing fresh credentials", async t => {
  const path = dir(t), stateFile = join(path, "sessions.jsonl"); writeFileSync(stateFile, "corrupt fixture\n", { mode: 0o600 });
  const app = await start(path, new GatewayTokenAuthority({ stateFile }));
  try {
    const issued = await http(app.base, "/api/gateway/sessions", "POST", { agentId: "codex" });
    assert.equal(issued.status, 503); assert.equal(issued.body.code, "gateway_session_storage_unavailable"); assert.equal(issued.body.token, undefined);
    assert.equal((await http(app.base, "/api/gateway/sessions")).status, 503);
    assert.equal(readFileSync(stateFile, "utf8"), "corrupt fixture\n");
  } finally { await app.close(); }
});
