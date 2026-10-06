import assert from "node:assert/strict";
import { createServer, request, type Server, type IncomingHttpHeaders } from "node:http";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Ledger } from "../src/ledger.ts";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";
import { DEFAULT_BUDGET } from "../src/global-budget.ts";

// Deliberately use raw HTTP, without helpers that auto-insert a test session token.
async function raw(base: string, path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: any; text: string }> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(new URL(path, base), { method, headers: { ...(encoded === undefined ? {} : { "content-type": "application/json" }), ...headers } }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => { let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, body, text }); });
    });
    req.on("error", reject); req.end(encoded);
  });
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server): Promise<void> { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

async function fixture(t: { after(fn: () => void | Promise<void>): void }, mockTerminal = false) {
  const dir = mkdtempSync(join(tmpdir(), "es-security-"));
  let upstreamCalls = 0;
  const seen: Array<{ headers: IncomingHttpHeaders; path: string }> = [];
  const upstream = createServer((req, res) => {
    upstreamCalls++; seen.push({ headers: req.headers, path: req.url! });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET" && req.url === "/v1/models") { res.end(JSON.stringify({ data: [{ id: "m" }] })); return; }
    res.end(JSON.stringify({ id: "chatcmpl-fixture", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "fixture response" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const upstreamUrl = await listen(upstream);
  const store = new Store(dir);
  store.upsertProvider({ id: "p", name: "Local fixture", baseUrl: `${upstreamUrl}/v1`, models: ["m"], route: "chat-translate", routePinned: true, streamUsage: false, protocols: ["chat"], createdAt: new Date().toISOString() });
  store.setSettings({ claudeNative: true });
  const secrets = createSecretStore(); await secrets.set("p", "fake-provider-key");
  const auth = new GatewayTokenAuthority();
  const launchDirs: string[] = [];
  const server = createEasySwitchServer({ store, secrets, port: 0, gatewayAuth: auth, ...(mockTerminal ? { interactiveRuntime: {
    findBinary: async () => "/fixture/never-executed-agent",
    newSessionDir: () => { const path = mkdtempSync(join(dir, "launch-")); launchDirs.push(path); return path; },
    launchInTerminal: async () => { throw new Error("mock terminal unavailable"); },
  } } : {}) });
  const base = await listen(server);
  t.after(async () => { await close(server); await close(upstream); rmSync(dir, { recursive: true, force: true }); });
  return { base, dir, store, auth, upstreamUrl, seen, launchDirs, calls: () => upstreamCalls };
}

const inference = [
  { path: "/v1/chat/completions", body: { model: "p/m", messages: [{ role: "user", content: "hello" }] } },
  { path: "/v1/responses", body: { model: "p/m", input: "hello" } },
  { path: "/v1/messages", body: { model: "p/m", messages: [{ role: "user", content: "hello" }], max_tokens: 10 } },
  { path: "/v1beta/models/p%2Fm:generateContent", body: { contents: [{ role: "user", parts: [{ text: "hello" }] }] } },
];
const protectedRoutes = [
  ...inference.map(r => ({ ...r, method: "POST" })),
  { path: "/responses", method: "POST", body: { model: "p/m", input: "fixture" } },
  { path: "/chat/completions", method: "POST", body: { model: "p/m", messages: [] } },
  { path: "/messages", method: "POST", body: { model: "p/m", messages: [], max_tokens: 1 } },
  { path: "/messages/count_tokens", method: "POST", body: { model: "p/m", messages: [] } },
  { path: "/models", method: "GET", body: undefined },
  { path: "/v1/messages/count_tokens", method: "POST", body: { model: "p/m", messages: [] } },
  { path: "/v1beta/models/p%2Fm:countTokens", method: "POST", body: { contents: [] } },
  { path: "/v1/models", method: "GET", body: undefined },
  { path: "/v1beta/models", method: "GET", body: undefined },
  { path: "/mcp", method: "POST", body: { jsonrpc: "2.0", id: 1, method: "ping" } },
  { path: "/backend-api/codex/responses", method: "POST", body: { model: "p/m", input: "hello" } },
];

test("raw gateway HTTP rejects missing, prefix-forged and revoked tokens on every protected protocol", async t => {
  const f = await fixture(t);
  const issued = f.auth.issue("claude", { allowMcp: true }); f.auth.revoke(issued.token);
  const authCases: Array<Record<string, string>> = [{}, { authorization: "Bearer es-session-claude-fake" }, { authorization: `Bearer ${issued.token}` }];
  for (const headers of authCases) {
    for (const route of protectedRoutes) {
      const response = await raw(f.base, route.path, route.method, headers, route.body);
      assert.equal(response.status, 401, `${route.path}: ${response.text}`);
    }
  }
  assert.equal(f.calls(), 0);
  assert.equal((await raw(f.base, "/health")).status, 200);
});

test("issued credentials authenticate the four protocol wire forms and are never sent upstream", async t => {
  const f = await fixture(t);
  const issued = f.auth.issue("qwen-code");
  const headers: Array<Record<string, string>> = [{ authorization: `Bearer ${issued.token}` }, { authorization: `Bearer ${issued.token}` }, { "x-api-key": issued.token }, { "x-goog-api-key": issued.token }];
  for (const [index, route] of inference.entries()) {
    const response = await raw(f.base, route.path, "POST", headers[index], route.body);
    assert.equal(response.status, 200, `${route.path}: ${response.text}`);
  }
  assert.equal(f.calls(), 4);
  assert.equal(JSON.stringify(f.seen).includes(issued.token), false);
  assert.ok(f.seen.every(req => req.headers.authorization === "Bearer fake-provider-key"));
  assert.equal((await raw(f.base, "/v1/models", "GET", headers[0])).status, 200);
  assert.equal((await raw(f.base, `/v1beta/models?key=${issued.token}`)).status, 200);
});

test("MCP requires its granted scope and ignores attempts to reset the server-issued nesting depth", async t => {
  const f = await fixture(t);
  const ordinary = f.auth.issue("claude");
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  assert.equal((await raw(f.base, "/mcp", "POST", { authorization: `Bearer ${ordinary.token}` }, ping)).status, 401);
  const nested = f.auth.issue("claude", { allowMcp: true, depth: 2 });
  const headers = { authorization: `Bearer ${nested.token}`, "x-easyswitch-depth": "0" };
  assert.equal((await raw(f.base, "/mcp", "POST", headers, ping)).status, 200);
  const response = await raw(f.base, "/mcp", "POST", headers, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_agent", arguments: { agent: "claude", task: "must never start", depth: 0 } } });
  assert.equal(response.status, 200);
  assert.equal(response.body.result.isError, true);
  assert.match(response.body.result.content[0].text, /nest at most 2/);
  assert.equal(f.calls(), 0);
});

test("native Claude preserves vendor credentials only for explicitly allowed sessions", async t => {
  const f = await fixture(t);
  const old = process.env.EASYSWITCH_ANTHROPIC_UPSTREAM;
  process.env.EASYSWITCH_ANTHROPIC_UPSTREAM = f.upstreamUrl;
  t.after(() => { if (old === undefined) delete process.env.EASYSWITCH_ANTHROPIC_UPSTREAM; else process.env.EASYSWITCH_ANTHROPIC_UPSTREAM = old; });
  const body = { model: "claude-sonnet-4", messages: [{ role: "user", content: "hello" }], max_tokens: 1 };
  const ordinary = f.auth.issue("claude");
  assert.equal((await raw(f.base, "/v1/messages", "POST", { authorization: `Bearer ${ordinary.token}` }, body)).status, 403);
  const native = f.auth.issue("claude", { allowNativeClaude: true });
  assert.equal((await raw(f.base, "/v1/messages", "POST", { authorization: `Bearer ${native.token}` }, body)).status, 403, "a local token cannot stand in for a vendor login");
  const desktop = f.auth.issue("claude-desktop");
  assert.equal((await raw(f.base, "/v1/messages", "POST", { authorization: `Bearer ${desktop.token}` }, body)).status, 400);
  assert.equal(f.calls(), 0);
  const response = await raw(f.base, "/v1/messages", "POST", { "x-easyswitch-session": native.token, authorization: "Bearer fake-native-claude-login", "x-api-key": ordinary.token }, body);
  assert.equal(response.status, 200);
  assert.equal(f.calls(), 1);
  assert.equal(f.seen[0]!.headers.authorization, "Bearer fake-native-claude-login");
  assert.equal(f.seen[0]!.headers["x-api-key"], undefined);
  assert.equal(f.seen[0]!.headers["x-easyswitch-session"], undefined);
  assert.equal(JSON.stringify(f.seen).includes(native.token), false);
});

test("manual token issue/list/revoke and budget edits require the console header", async t => {
  const f = await fixture(t);
  assert.equal((await raw(f.base, "/api/gateway/sessions", "POST", {}, { agentId: "claude" })).status, 403);
  const headers = { "x-easyswitch": "1" };
  const issued = await raw(f.base, "/api/gateway/sessions", "POST", headers, { agentId: "claude" });
  assert.equal(issued.status, 201);
  assert.equal(issued.body.allowMcp, false);
  const list = await raw(f.base, "/api/gateway/sessions");
  assert.equal(list.text.includes(issued.body.token), false);
  assert.equal((await raw(f.base, "/v1/models", "GET", { authorization: `Bearer ${issued.body.token}` })).status, 200);
  assert.equal((await raw(f.base, `/api/gateway/sessions/${issued.body.id}`, "DELETE", headers)).status, 200);
  assert.equal((await raw(f.base, "/v1/models", "GET", { authorization: `Bearer ${issued.body.token}` })).status, 401);
  assert.equal((await raw(f.base, "/api/gateway/sessions", "POST", headers, { agentId: "claude-desktop", allowNativeClaude: true })).status, 400);
  assert.equal((await raw(f.base, "/api/budget", "PUT", {}, DEFAULT_BUDGET)).status, 403);
});

test("stop budget rejects every new inference before upstream I/O and keeps recovery routes available", async t => {
  const f = await fixture(t);
  const issued = f.auth.issue("claude", { allowNativeClaude: true });
  const headers = { authorization: `Bearer ${issued.token}` };
  assert.equal((await raw(f.base, "/api/budget", "PUT", { "x-easyswitch": "1" }, { ...DEFAULT_BUDGET, enabled: true, limitUsd: 0, action: "stop" })).status, 200);
  for (const route of [...inference, { path: "/backend-api/codex/responses", body: { model: "p/m", input: "hello" } }, { path: "/v1/messages", body: { model: "claude-sonnet-4", messages: [], max_tokens: 1 } }]) {
    const response = await raw(f.base, route.path, "POST", headers, route.body);
    assert.equal(response.status, 429, `${route.path}: ${response.text}`);
  }
  assert.equal(f.calls(), 0);
  assert.equal((await raw(f.base, "/health")).status, 200);
  assert.equal((await raw(f.base, "/v1/models", "GET", headers)).status, 200);
  assert.equal((await raw(f.base, "/api/budget")).body.blocked, true);
  assert.equal((await raw(f.base, "/api/budget", "PUT", { "x-easyswitch": "1" }, DEFAULT_BUDGET)).status, 200);
  assert.equal((await raw(f.base, inference[0]!.path, "POST", headers, inference[0]!.body)).status, 200);
  assert.equal(f.calls(), 1);
});

test("legacy GET launch cannot mint sessions, and duplicate Authorization fields fail closed", async t => {
  const f = await fixture(t);
  for (const path of ["/api/launch/codex", "/api/launch/claude"]) {
    assert.equal((await raw(f.base, path)).status, 405);
    assert.equal(f.auth.list().length, 0);
  }
  const issued = f.auth.issue("qwen-code");
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(new URL("/v1/models", f.base), { headers: ["Host", new URL(f.base).host, "Authorization", `Bearer ${issued.token}`, "Authorization", "Bearer conflicting-fixture"] }, res => { res.resume(); res.once("end", () => resolve(res.statusCode!)); });
    req.once("error", reject); req.end();
  });
  assert.equal(status, 401);
});


test("manual guides mint scoped revocable tokens only on an explicit console POST", async t => {
  const f = await fixture(t);
  const path = "/api/agents/workbuddy/setup";
  assert.equal((await raw(f.base, path)).status, 405);
  assert.equal((await raw(f.base, path, "POST", {}, {})).status, 403);
  assert.equal(f.auth.list().length, 0);
  assert.equal((await raw(f.base, "/api/agents/windsurf/setup", "POST", { "x-easyswitch": "1" }, {})).status, 404);
  assert.equal(f.auth.list().length, 0);
  const guide = await raw(f.base, path, "POST", { "x-easyswitch": "1" }, {});
  assert.equal(guide.status, 200);
  assert.equal(guide.body.fields[0].value, f.base + "/v1/chat/completions");
  assert.deepEqual(guide.body.models, ["p/m"]);
  const token = guide.body.fields.find((field: any) => field.secret).value;
  assert.equal(f.auth.authenticate({ authorization: `Bearer ${token}` })?.agentId, "workbuddy");
  assert.equal(f.auth.authenticate({ authorization: `Bearer ${token}` }, undefined, "mcp"), undefined);
  assert.equal((await raw(f.base, "/api/gateway/sessions")).text.includes(token), false);
  assert.equal((await raw(f.base, "/v1/models", "GET", { authorization: `Bearer ${token}` })).status, 200);
  assert.equal((await raw(f.base, `/api/gateway/sessions/${guide.body.session.id}`, "DELETE", { "x-easyswitch": "1" })).status, 200);
  assert.equal((await raw(f.base, "/v1/models", "GET", { authorization: `Bearer ${token}` })).status, 401);
  assert.equal(f.calls(), 0);
});

test("token issuance and terminal-open failures clean only their own launch directory and token", async t => {
  const f = await fixture(t, true);
  f.store.setSettings({ claudeNative: false, agentCalls: false });
  const unrelated = f.auth.issue("qwen-code");
  const issue = t.mock.method(f.auth, "issue", () => { throw new Error("mock capacity reached"); });
  const headers = { "x-easyswitch": "1" };
  assert.equal((await raw(f.base, "/api/agents/aider/launch", "POST", headers, {})).status, 500);
  issue.mock.restore();
  assert.equal(f.launchDirs.length, 1);
  assert.ok(f.launchDirs.every(path => !existsSync(path)));
  for (const path of ["/api/agents/aider/launch", "/api/launch/claude"]) {
    assert.equal((await raw(f.base, path, "POST", headers, {})).status, 500);
    assert.equal(f.auth.list().length, 1);
    assert.ok(f.auth.authenticate({ authorization: `Bearer ${unrelated.token}` }));
    assert.ok(f.launchDirs.every(path => !existsSync(path)));
  }
  assert.equal(f.launchDirs.length, 3);
  assert.equal(f.calls(), 0);
});

test("an enabled stop budget blocks unmetered provider probes even below its limit", async t => {
  const f = await fixture(t);
  const headers = { "x-easyswitch": "1" };
  assert.equal((await raw(f.base, "/api/budget", "PUT", headers, { ...DEFAULT_BUDGET, enabled: true, limitUsd: 100, action: "stop" })).status, 200);
  assert.equal((await raw(f.base, "/api/budget")).body.blocked, false);
  const response = await raw(f.base, "/api/providers/p/probe", "POST", headers, { model: "m" });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "probe_budget_unmetered");
  assert.equal(f.calls(), 0);
  const imported = await raw(f.base, "/api/import", "POST", headers, { name: "Imported fixture", text: f.upstreamUrl + "/v1" });
  assert.equal(imported.status, 201, imported.text);
  assert.deepEqual(imported.body.provider.models, ["m"]);
  assert.equal(imported.body.provider.probe.checks[0].status, "skip");
  assert.deepEqual(imported.body.provider.supportedProtocols, ["chat"]);
  assert.match(imported.body.summary, /跳过/);
  assert.deepEqual(f.seen.map(call => call.path), ["/v1/models"], "read-only model discovery is allowed, no inference probes are sent");
  const token = f.auth.issue("chat").token;
  const responseAfterSkip = await raw(f.base, "/v1/chat/completions", "POST", { authorization: `Bearer ${token}` }, { model: imported.body.provider.id + "/m", messages: [{ role: "user", content: "explicit fixture call" }] });
  assert.equal(responseAfterSkip.status, 200, "skipping diagnostics does not disable ordinary explicit inference");
});


test("source monthly budgets use durable accounting, exclude models/pools, and coexist with the global budget", async t => {
  const f = await fixture(t); const consoleHeaders = { 'x-easyswitch': '1' };
  const token = f.auth.issue('chat').token; const auth = { authorization: `Bearer ${token}` };
  assert.equal((await raw(f.base,'/api/providers/p/budget','PUT',consoleHeaders,{monthlyUsd:1,stop:true})).status,200);
  assert.equal((await raw(f.base,'/api/providers/p/probe','POST',consoleHeaders,{model:'m'})).status,409);
  assert.equal(f.calls(),0);
  const ledger = new Ledger(f.dir);
  ledger.append({at:new Date().toISOString(),providerId:'p',model:'p/m',route:'chat-translate',status:200,ms:1,inputTokens:1,outputTokens:1,costUsd:2});
  assert.equal(f.store.catalog().some(m=>m.providerId==='p'),false);
  assert.deepEqual((await raw(f.base,'/v1/models','GET',auth)).body.data,[]);
  for (const route of inference) assert.equal((await raw(f.base,route.path,'POST',auth,route.body)).status,404);
  assert.equal(f.calls(),0);
  for (const body of [{},{monthlyUsd:''},{monthlyUsd:'2',stop:false},{monthlyUsd:2,stop:'false'},{monthlyUsd:null,extra:true}]) {
    assert.equal((await raw(f.base,'/api/providers/p/budget','PUT',consoleHeaders,body)).status,400);
    assert.equal(f.store.provider('p')!.budget!.stop,true);
  }
  assert.equal((await raw(f.base,'/api/budget')).body.settings.enabled,false,'source settings do not overwrite global settings');
  assert.equal((await raw(f.base,'/api/providers/p/budget','PUT',consoleHeaders,{monthlyUsd:null})).status,200);
  assert.ok(f.store.catalog().some(m=>m.providerId==='p'));
});

test("a stopped source budget fails closed on corrupt ledger without disabling recovery APIs", async t => {
  const f = await fixture(t); const headers = { 'x-easyswitch':'1' };
  assert.equal((await raw(f.base,'/api/providers/p/budget','PUT',headers,{monthlyUsd:10,stop:true})).status,200);
  appendFileSync(join(f.dir,'usage.jsonl'),'not-json\n');
  assert.equal(f.store.catalog().some(m=>m.providerId==='p'),false);
  const response = await raw(f.base,inference[0]!.path,'POST',{authorization:`Bearer ${f.auth.issue('chat').token}`},inference[0]!.body);
  assert.equal(response.status,404); assert.equal(f.calls(),0);
  assert.equal((await raw(f.base,'/health')).status,200);
  assert.equal((await raw(f.base,'/api/providers/p/budget','PUT',headers,{monthlyUsd:null})).status,200);
});
