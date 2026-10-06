import { nativeFixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { claudeEnv, findClaude } from "../src/launch.ts";
import { claudeArgs } from "../src/launch.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
const run = promisify(execFile);
const sessionToken = (agentId: string) => fixtureToken(agentId, { allowNativeClaude: true });
type Json = Record<string, any>;

interface Seen { method: string; url: string; headers: IncomingMessage["headers"]; body: string }

let anthropic: Server;
let seen: Seen[];
let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let pid: string;
const LOGIN = "Bearer sk-ant-oat-the-users-own-login";

const freePort = () => new Promise<number>(resolve => {
  const probe = createServer().listen(0, "127.0.0.1", () => {
    const p = (probe.address() as { port: number }).port;
    probe.close(() => resolve(p));
  });
});

before(async () => {
  seen = [];
  const aport = await freePort();
  anthropic = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ type: "model", id: "claude-sonnet-fake", display_name: "Sonnet fake" }], has_more: false }));
      } else if (req.url?.startsWith("/v1/messages/count_tokens")) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 123 }));
      } else {
        res.writeHead(200, { "content-type": "application/json", "request-id": "req_fake" }).end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-fake", content: [{ type: "text", text: "from anthropic" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
      }
    });
  });
  await new Promise<void>(r => anthropic.listen(aport, "127.0.0.1", r));
  process.env.EASYSWITCH_ANTHROPIC_UPSTREAM = `http://127.0.0.1:${aport}`;

  relay = await startMockRelay(0, { apiKey: "relay-key" });
  port = await freePort();
  server = createEasySwitchServer({ store: new Store(mkdtempSync(join(tmpdir(), "es-native-"))), secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  pid = ((await fetch(`http://127.0.0.1:${port}/api/providers`, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" },
    body: JSON.stringify({ name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "relay-key" }),
  }).then(r => r.json())) as { id: string }).id;
});

after(() => { server.closeAllConnections(); server.close(); anthropic.closeAllConnections(); anthropic.close(); relay.server.closeAllConnections(); relay.server.close(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: LOGIN, "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "x-easyswitch-session": fixtureToken("claude", { allowNativeClaude: true }), ...headers }, body: JSON.stringify(body) });

test("a request for a Claude model goes to Anthropic unchanged, with the caller's own headers", async () => {
  seen.length = 0;
  const res = await post("/v1/messages?beta=true", { model: "claude-sonnet-fake", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
  assert.match(JSON.stringify(await res.json()), /from anthropic/);
  const got = seen[0]!;
  assert.equal(got.url, "/v1/messages?beta=true", "path and query as sent");
  assert.equal(got.headers.authorization, LOGIN, "the same login the client used");
  assert.equal(got.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.equal(got.headers["x-easyswitch-session"], undefined, "EasySwitch's own header stays here");
  assert.deepEqual(JSON.parse(got.body).messages, [{ role: "user", content: "hi" }]);
});

test("a context marker on the model id is dropped before Anthropic sees it", async () => {
  seen.length = 0;
  await post("/v1/messages", { model: "claude-opus-fake[1m]", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
  assert.equal(JSON.parse(seen[0]!.body).model, "claude-opus-fake");
});

test("a request for a third-party model is answered by its provider and the Claude login never reaches it", async () => {
  seen.length = 0;
  const before = relay.requests.length;
  const res = await post("/v1/messages", { model: `${pid}/mock-coder`, max_tokens: 20, messages: [{ role: "user", content: "Reply with exactly the word: pong" }] });
  assert.equal(res.status, 200);
  assert.equal(seen.length, 0, "Anthropic was not called for a model that is not Claude's");
  assert.ok(relay.requests.length > before, "the provider answered");
  assert.ok(!JSON.stringify(relay.headers.at(-1) ?? {}).includes("sk-ant-oat"), "the login is not among what the provider received");
});

test("the model menu shows Claude's own models first and EasySwitch's after them", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: LOGIN, "x-easyswitch-session": sessionToken("claude"), "anthropic-version": "2023-06-01" } });
  const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map(m => m.id);
  assert.equal(ids[0], "claude-sonnet-fake");
  assert.ok(ids.some(id => id.startsWith("es-claude-")), "ours are there too");
  assert.ok(ids.indexOf("claude-sonnet-fake") < ids.findIndex(id => id.startsWith("es-claude-")));
});

test("with the setting off, or without a login, the menu is only EasySwitch's", async () => {
  const none = (await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { "x-easyswitch-session": sessionToken("claude"), "anthropic-version": "2023-06-01" } })).json()) as { data: Array<{ id: string }> };
  assert.ok(none.data.every(m => m.id.startsWith("es-claude-")), "no login, nothing to ask Anthropic with");
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", "x-easyswitch": "1" }, body: JSON.stringify({ claudeNative: false }) });
  const off = (await (await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: "Bearer sk-ant-oat-other", "x-easyswitch-session": sessionToken("claude"), "anthropic-version": "2023-06-01" } })).json()) as { data: Array<{ id: string }> };
  assert.ok(off.data.every(m => m.id.startsWith("es-claude-")));
  await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", "x-easyswitch": "1" }, body: JSON.stringify({ claudeNative: true }) });
});

test("a session on EasySwitch's own placeholder token never asks Anthropic anything", async () => {
  seen.length = 0;
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${fixtureToken("claude")}`, "anthropic-version": "2023-06-01" } });
  const ids = ((await res.json()) as { data: Array<{ id: string }> }).data.map(m => m.id);
  assert.ok(ids.every(id => id.startsWith("es-claude-")));
  assert.equal(seen.length, 0, "no request reached Anthropic's side");
});

test("token counting for a Claude model is answered by Anthropic", async () => {
  const res = await post("/v1/messages/count_tokens", { model: "claude-sonnet-fake", messages: [{ role: "user", content: "hi" }] });
  assert.equal(((await res.json()) as Json).input_tokens, 123);
});

test("keeping the login: no placeholder token, stale keys and models blanked, session token in a header", () => {
  const env = claudeEnv(1234, undefined, "es-session-claude-abc", {}, true);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, "");
  assert.equal(env.ANTHROPIC_API_KEY, "");
  assert.equal(env.ANTHROPIC_MODEL, "");
  assert.equal(env.ANTHROPIC_CUSTOM_HEADERS, "x-easyswitch-session: es-session-claude-abc");
  const withModel = claudeEnv(1234, "p/m", "es-session-claude-abc", {}, true);
  assert.match(withModel.ANTHROPIC_MODEL!, /p--m/, "a chosen main model still applies");
  assert.equal(claudeEnv(1234, "p/m", "es-session-claude-abc").ANTHROPIC_AUTH_TOKEN, "es-session-claude-abc", "the old mode is unchanged");
});

test("a REAL Claude Code with its own login kept sends that login to the gateway, which sends Claude requests on", async t => {
  const claude = await findClaude();
  if (!claude) { t.skip("claude not installed"); return; }
  seen.length = 0;
  const env = claudeEnv(port, undefined, sessionToken("claude"), {}, true);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  const p = run(claude, ["-p", "hi", ...claudeArgs(env)], { cwd: mkdtempSync(join(tmpdir(), "es-native-work-")), env: childEnv, timeout: 90_000 });
  p.child.stdin?.end();
  const out = await p.catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? "" }));
  const call = seen.find(s => s.url.startsWith("/v1/messages"));
  assert.ok(call, "Claude Code's request reached Anthropic's side through the gateway");
  assert.match(String(call!.headers.authorization), /^Bearer sk-ant-/, "with the user's own login, not a placeholder");
  assert.match(String(out.stdout), /from anthropic/);
});
