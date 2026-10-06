import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import net from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { findCodex } from "../src/launch.ts";
import { Store } from "../src/store.ts";
import { sessionToken } from "../src/gateway-auth.ts";
import { startMockRelay } from "./mock-relay.ts";

/**
 * The ChatGPT desktop path, with nothing real in it: a fake ChatGPT login in a
 * throwaway CODEX_HOME, a local stand-in for chatgpt.com, and the real Codex
 * app-server / CLI pointed at the gateway with `openai_base_url`.
 */

type Json = Record<string, unknown>;
const run = promisify(execFile);
const localFixtureToken = sessionToken("chatgpt");
process.env.EASYSWITCH_SECRETS = "memory";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: Json) => `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.sig`;

function fakeChatgptHome(): string {
  const home = mkdtempSync(join(tmpdir(), "es-chatgpt-home-"));
  const exp = Math.floor(Date.now() / 1000) + 86400 * 30;
  const claims = { "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-fake", chatgpt_user_id: "user-fake" }, email: "fake@example.com", exp, iat: exp - 100 };
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { id_token: jwt(claims), access_token: jwt(claims), refresh_token: "fake-refresh", account_id: "acct-fake" },
    last_refresh: new Date().toISOString(),
  }));
  return home;
}

let codexPath: string | undefined;
let backend: Server;
let backendPort: number;
let gateway: Server;
let gatewayPort: number;
let store: Store;
let relay: Awaited<ReturnType<typeof startMockRelay>>;
let nativeCatalog: Json[] = [];
const backendSeen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
const wsFrames: string[] = [];

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}

before(async () => {
  codexPath = await findCodex();
  if (codexPath) {
    const { stdout } = await run(codexPath, ["debug", "models"], { env: { ...process.env, CODEX_HOME: mkdtempSync(join(tmpdir(), "es-native-")), OPENAI_API_KEY: "" }, maxBuffer: 1 << 28 });
    nativeCatalog = (JSON.parse(stdout) as { models: Json[] }).models;
  }
  relay = await startMockRelay(0, { apiKey: "relay-key" });

  // A stand-in for chatgpt.com/backend-api/codex.
  backend = createServer((req, res) => {
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", () => {
      backendSeen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/backend-api/codex/models")) {
        res.writeHead(200, { "content-type": "application/json", etag: '"native-1"' });
        res.end(JSON.stringify({ models: nativeCatalog }));
        return;
      }
      if (req.url?.startsWith("/backend-api/codex/responses") && req.method === "POST") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const id = "resp_native";
        const item = { id: "msg_1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "native-reply-from-chatgpt", annotations: [] }] };
        const ev = (type: string, obj: Json) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`);
        ev("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
        ev("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
        ev("response.output_text.delta", { item_id: "msg_1", output_index: 0, content_index: 0, delta: "native-reply-from-chatgpt" });
        ev("response.output_item.done", { output_index: 0, item });
        ev("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" }).end("{}");
    });
  });
  // WebSocket upgrade: accept, then echo whatever arrives, so a raw pipe can be proven.
  backend.on("upgrade", (req, socket) => {
    backendSeen.push({ method: "UPGRADE", url: req.url ?? "", headers: req.headers, body: "" });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: test\r\n\r\n");
    socket.on("data", d => { wsFrames.push(d.toString()); socket.write(`echo:${d.toString()}`); });
  });
  await new Promise<void>(r => backend.listen(0, "127.0.0.1", r));
  backendPort = (backend.address() as { port: number }).port;
  process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES = "1";
  process.env.EASYSWITCH_CHATGPT_UPSTREAM = `http://127.0.0.1:${backendPort}/backend-api/codex`;

  gatewayPort = await freePort();
  store = new Store(mkdtempSync(join(tmpdir(), "es-chatgpt-store-")));
  gateway = createEasySwitchServer({ store, secrets: createSecretStore(), port: gatewayPort });
  await new Promise<void>(r => gateway.listen(gatewayPort, "127.0.0.1", r));
  const H = { "content-type": "application/json", "x-easyswitch": "1" };
  const api = (method: string, path: string, body?: Json) => fetch(`http://127.0.0.1:${gatewayPort}${path}`, { method, headers: H, ...(body ? { body: JSON.stringify(body) } : {}) }).then(r => r.json());
  await api("POST", "/api/providers", { name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "relay-key" });
});

after(() => {
  // A piped WebSocket keeps both ends open; close() alone would wait for it forever.
  for (const server of [gateway, backend, relay.server]) {
    server.closeAllConnections();
    server.close();
  }
  delete process.env.EASYSWITCH_CHATGPT_UPSTREAM;
  delete process.env.EASYSWITCH_TEST_CHATGPT_FIXTURES;
});

test("the merged model list holds ChatGPT's models and EasySwitch's, under an ETag that covers both", async t => {
  if (!codexPath) { t.skip("codex not installed"); return; }
  const base = `http://127.0.0.1:${gatewayPort}/backend-api/codex/models?client_version=0.160.0`;
  const headers = { "x-easyswitch-session": localFixtureToken, authorization: "Bearer fake-access", "chatgpt-account-id": "acct-fake", originator: "codex_cli_rs" };
  const first = await fetch(base, { headers });
  assert.equal(first.status, 200);
  const etag = first.headers.get("etag")!;
  const slugs = ((await first.json()) as { models: Json[] }).models.map(m => String(m.slug));
  for (const native of nativeCatalog) assert.ok(slugs.includes(String(native.slug)), `native ${String(native.slug)} kept`);
  assert.ok(slugs.includes("mock-relay/mock-coder") && slugs.includes("mock-relay/mock-mini"), "ours added");
  const seen = backendSeen.filter(s => s.url.startsWith("/backend-api/codex/models")).at(-1)!;
  assert.equal(seen.headers.authorization, "Bearer fake-access", "the login is forwarded to ChatGPT untouched");
  assert.equal(seen.headers["chatgpt-account-id"], "acct-fake");
  // A conditional request with our ETag is answered by us.
  const again = await fetch(base, { headers: { ...headers, "if-none-match": etag } });
  assert.equal(again.status, 304);
});

test("the real Codex app-server without a local capability receives only ChatGPT native models", async t => {
  if (!codexPath) { t.skip("codex not installed"); return; }
  const home = fakeChatgptHome();
  // detached: the app-server starts helpers of its own; killing the group is the only way to free every pipe.
  const child = spawn(codexPath, ["app-server", "-c", `openai_base_url="http://127.0.0.1:${gatewayPort}/backend-api/codex"`],
    { env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: "" }, stdio: ["pipe", "pipe", "pipe"], detached: true });
  const waiters = new Map<number, (m: Json) => void>();
  let buf = "";
  child.stdout.on("data", d => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line) as Json; if (typeof m.id === "number") waiters.get(m.id)?.(m); } catch { /* not a response */ }
    }
  });
  const rpc = (id: number, method: string, params: Json) => new Promise<Json>(resolve => {
    waiters.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    setTimeout(() => resolve({ timeout: true }), 30_000);
  });
  try {
    await rpc(1, "initialize", { clientInfo: { name: "es-test", version: "0" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    const list = (await rpc(2, "model/list", { includeHidden: true })) as { result?: { data?: Json[] } };
    const ids = (list.result?.data ?? []).map(m => String(m.id ?? m.model));
    assert.ok(ids.includes("gpt-5.5"), `native model present: ${ids.join(",")}`);
    assert.ok(!ids.includes("mock-relay/mock-coder"), "local source catalog requires a separate local capability");
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    child.unref();
  }
});

test("a native model goes to ChatGPT with the app's own login; an EasySwitch model goes to its provider", async () => {
  // Driven by HTTP rather than the Codex CLI: with a fake login the CLI also calls OpenAI's real
  // MCP and token endpoints, which reject it, so a whole turn cannot complete offline.
  const url = `http://127.0.0.1:${gatewayPort}/backend-api/codex/responses`;
  const headers = { "content-type": "application/json", "x-easyswitch-session": localFixtureToken, authorization: "Bearer fake-access", "chatgpt-account-id": "acct-fake", originator: "codex_cli_rs" };

  const native = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "gpt-5.5", stream: true, input: "say hi" }) });
  assert.equal(native.status, 200);
  assert.match(await native.text(), /native-reply-from-chatgpt/);
  const hit = backendSeen.filter(s => s.method === "POST" && s.url.startsWith("/backend-api/codex/responses")).at(-1)!;
  assert.equal(hit.headers.authorization, "Bearer fake-access", "the app's own login reached ChatGPT");
  assert.equal(hit.headers["chatgpt-account-id"], "acct-fake");
  assert.equal(JSON.parse(hit.body).model, "gpt-5.5", "the native request is forwarded as it came");

  const nativeCalls = backendSeen.length;
  const before = relay.requests.length;
  const ours = await fetch(url, { method: "POST", headers, body: JSON.stringify({ model: "mock-relay/mock-coder", stream: true, input: "Reply with exactly the word: pong" }) });
  assert.equal(ours.status, 200);
  const text = await ours.text();
  assert.match(text, /response\.completed/);
  assert.ok(relay.requests.length > before, "the provider was called");
  assert.equal(backendSeen.length, nativeCalls, "an EasySwitch model never reaches ChatGPT");
  assert.equal(String((relay.requests.at(-1) as Json).model), "mock-coder");
});

test("a production native WebSocket is refused until its ongoing lifecycle is supported", async () => {
  const socket = net.connect(gatewayPort, "127.0.0.1");
  await new Promise<void>(r => socket.once("connect", r));
  socket.write(["GET /backend-api/codex/responses HTTP/1.1", `Host: 127.0.0.1:${gatewayPort}`, "Upgrade: websocket", "Connection: Upgrade", "Authorization: Bearer fake-access", "", ""].join("\r\n"));
  let received = ""; socket.on("data", d => received += d);
  await new Promise<void>(r => socket.once("close", () => r()));
  assert.match(received, /409 Conflict/); assert.deepEqual(wsFrames, []);
});

test("paths outside /backend-api/codex never upgrade", async () => {
  const socket = net.connect(gatewayPort, "127.0.0.1");
  await new Promise<void>(r => socket.once("connect", r));
  socket.write(["GET /v1/responses HTTP/1.1", `Host: 127.0.0.1:${gatewayPort}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGVzdA==", "Sec-WebSocket-Version: 13", "", ""].join("\r\n"));
  const closed = await new Promise<boolean>(resolve => { socket.once("close", () => resolve(true)); setTimeout(() => resolve(false), 1000); });
  assert.equal(closed, true);
});
