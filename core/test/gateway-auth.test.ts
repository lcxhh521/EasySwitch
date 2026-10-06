import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { isGatewayPath, isValidToken, loadGatewayKey, requestHasValidToken, setGatewayKey, signToken, stableToken, tokensOf } from "../src/gateway-auth.ts";
import { sessionToken } from "../src/gateway-chat.ts";
import { codexArgs } from "../src/launch.ts";
import { manualToken } from "../src/setup-guides.ts";
import { LAUNCHERS } from "../src/agent-launch.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

// The server under test and the tests of the pure functions share the one key in the process: whoever changes it puts the server's back.
const serverSecrets = createSecretStore();
const restoreServerKey = () => loadGatewayKey(serverSecrets);

test("a token is signed with this install's key: it names the agent, cannot be forged or altered, and a stable one is the same every time", async () => {
  setGatewayKey("11".repeat(32));
  const token = signToken("aider");
  assert.match(token, /^es-session-aider-.+-[0-9a-f]{20}$/);
  assert.equal(isValidToken(token), true);
  assert.equal(isValidToken(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0")), false, "one changed character is refused");
  assert.equal(isValidToken(token.replace("aider", "claude")), false, "the agent name is part of what is signed");
  assert.equal(isValidToken("es-session-aider-x"), false, "an unsigned token is refused");
  assert.equal(isValidToken("Bearer nonsense"), false);
  assert.equal(stableToken("hermes"), stableToken("hermes"));
  assert.notEqual(stableToken("hermes"), stableToken("trae"));
  assert.equal(isValidToken(stableToken("hermes")), true);
  assert.equal(manualToken("trae"), stableToken("trae"), "the setup helper hands out a stable token");
  setGatewayKey("22".repeat(32));
  assert.equal(isValidToken(token), false, "a token signed with another key (another install, or a guess) is refused");
  setGatewayKey(undefined);
  assert.match(signToken("aider"), /^es-session-aider-[0-9a-f-]{36}$/, "without a key nothing is signed and nothing is enforced");
  await restoreServerKey();
});

test("a request's token is found wherever the client puts it, and only the gateway's own routes ask for one", async () => {
  setGatewayKey("11".repeat(32));
  const t = signToken("claude");
  assert.equal(requestHasValidToken({ authorization: `Bearer ${t}` }), true);
  assert.equal(requestHasValidToken({ "x-api-key": t }), true);
  assert.equal(requestHasValidToken({ "x-easyswitch-session": t }), true, "Claude Code that keeps its own login sends ours in a header of its own");
  assert.equal(requestHasValidToken({ "x-goog-api-key": t }), true);
  assert.equal(requestHasValidToken({}, `?key=${t}`), true, "Gemini clients may put the key in the address");
  assert.equal(requestHasValidToken({ authorization: "Bearer sk-someone-elses-key" }), false);
  assert.deepEqual(tokensOf({ authorization: "Bearer sk-x", "x-api-key": t }), [t], "only our kind of token counts");
  for (const p of ["/v1/chat/completions", "/v1/messages", "/v1/models", "/v1beta/models", "/responses", "/chat/completions", "/mcp"]) assert.equal(isGatewayPath(p), true, p);
  for (const p of ["/health", "/api/state", "/", "/app.js", "/backend-api/codex/models"]) assert.equal(isGatewayPath(p), false, p);
});

test("Codex is given its launch token in a header of its own, so the gateway can tell it from a stranger", async () => {
  setGatewayKey("11".repeat(32));
  const token = signToken("codex");
  const args = codexArgs(18765, "p/m", undefined, undefined, token).join(" ");
  assert.ok(args.includes(`http_headers={"x-easyswitch-session"="${token}"}`));
  assert.ok(!codexArgs(18765, "p/m").join(" ").includes("http_headers"), "no token, no header");
  const spec = LAUNCHERS.codex!.headless!({ bin: "/bin/codex", port: 18765, model: "p/m", token, sessionDir: "/tmp/s", task: "x" });
  assert.ok(spec.args.join(" ").includes(token));
  await restoreServerKey();
});

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let store: Store;
const dir = mkdtempSync(join(tmpdir(), "es-auth-"));
const H = { "content-type": "application/json", "x-easyswitch": "1" };

before(async () => {
  relay = await startMockRelay(0, { apiKey: "k1" });
  port = await new Promise<number>(resolve => { const p = createServer().listen(0, "127.0.0.1", () => { const n = (p.address() as { port: number }).port; p.close(() => resolve(n)); }); });
  store = new Store(join(dir, "store"));
  server = createEasySwitchServer({ store, secrets: serverSecrets, port, gatewayAuth: true });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  const made = await fetch(`http://127.0.0.1:${port}/api/providers`, { method: "POST", headers: H, body: JSON.stringify({ name: "relay", baseUrl: relay.baseUrl, apiKey: "k1" }) });
  const id = ((await made.json()) as { id: string }).id;
  const p = store.provider(id)!; p.models = ["mock-coder"]; store.upsertProvider(p);
});

after(() => { server.closeAllConnections(); server.close(); relay.server.closeAllConnections(); relay.server.close(); rmSync(dir, { recursive: true, force: true }); setGatewayKey(undefined); });

const ask = (headers: Record<string, string>, path = "/v1/chat/completions") => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify({ model: `${store.providers()[0]!.id}/mock-coder`, messages: [{ role: "user", content: "hi" }] }),
});

test("the gateway answers only a launch EasySwitch made: no token, a made-up token and an altered one are refused, a real one in any of its places is served", async () => {
  const none = await ask({});
  assert.equal(none.status, 401);
  const body = (await none.json()) as Json;
  assert.equal(body.error.type, "authentication_error");
  assert.match(body.error.message, /只接受它自己启动的 agent/);
  assert.equal((await ask({ authorization: "Bearer es-session-aider-made-up" })).status, 401);
  assert.equal((await ask({ authorization: "Bearer sk-some-other-key" })).status, 401);
  const token = sessionToken("aider");
  assert.equal((await ask({ authorization: `Bearer ${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}` })).status, 401, "an altered token");
  assert.equal(relay.requests.length, 0, "nothing reached the provider");

  assert.equal((await ask({ authorization: `Bearer ${token}` })).status, 200, "Bearer token");
  assert.equal((await ask({ "x-easyswitch-session": sessionToken("claude") })).status, 200, "the header Claude Code uses when it keeps its own login");
  assert.equal((await ask({ "x-api-key": sessionToken("qwen") })).status, 200, "x-api-key");
  assert.ok(relay.requests.length >= 3);
  // The model list, the Gemini routes and MCP are the gateway's too.
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${token}` } })).status, 200, "/v1/models with a token");
  assert.equal((await fetch(`${base}/v1beta/models`)).status, 401);
  assert.equal((await fetch(`${base}/v1beta/models`, { headers: { "x-goog-api-key": token } })).status, 200, "/v1beta/models with x-goog-api-key");
  assert.equal((await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
});

test("what is not the gateway stays open or keeps its own guard: the health check, the console and its API", async () => {
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/api/state`, { headers: H })).status, 200);
  assert.equal((await fetch(`${base}/api/providers`, { method: "POST", body: "{}" })).status, 403, "the console API still wants its own header for anything that changes something");
});

test("the key is made once, kept in the secret store, and the same one is used after a restart", async () => {
  await loadGatewayKey(serverSecrets);
  const a = signToken("hermes", "n");
  await loadGatewayKey(serverSecrets);
  assert.equal(signToken("hermes", "n"), a, "a token signed before a restart is still good after it");
  assert.match((await serverSecrets.get("gateway-secret"))!, /^[0-9a-f]{64}$/);
});
