/**
 * End to end with the real Claude Code binary: Claude Code -> EasySwitch
 * gateway (Anthropic Messages) -> strict chat-only mock relay, through a full
 * Bash tool round trip. Runs in a throwaway HOME and CLAUDE_CONFIG_DIR.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { claudeModelId, fromClaudeModelId } from "../src/catalog.ts";
import { sessionToken } from "../src/gateway-chat.ts";
import { claudeArgs, claudeEnv, findClaude } from "../src/launch.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { SHELL_MARKER, startMockRelay } from "./mock-relay.ts";

type Json = Record<string, unknown>;
const run = promisify(execFile);
process.env.EASYSWITCH_SECRETS = "memory";

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let base: string;

async function api(method: string, path: string, body?: Json): Promise<Json> {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-easyswitch": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return (await response.json()) as Json;
}

before(async () => {
  relay = await startMockRelay(0);
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = createEasySwitchServer({ store: new Store(mkdtempSync(join(tmpdir(), "es-home-"))), secrets: createSecretStore(), port, gatewayAuth: true });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
  await api("POST", "/api/providers", { name: "Mock Relay", baseUrl: relay.baseUrl });
});

after(() => {
  server.close();
  relay.server.close();
});

test("a chat-only relay is routed through Messages translation", async () => {
  const provider = await api("POST", "/api/providers/mock-relay/probe", { model: "mock-coder" });
  const messages = ((provider.probe as Json).checks as Json[]).find(c => c.id === "messages");
  assert.equal(messages?.status, "fail");
  assert.equal(provider.messagesRoute, "chat-translate");
});

test("the launch command passes everything per process: env plus a --settings layer", async () => {
  await api("PUT", "/api/bindings/claude", { providerId: "mock-relay", model: "mock-coder" });
  const { command, model } = await api("GET", "/api/launch/claude");
  assert.equal(model, "mock-relay/mock-coder");
  assert.match(String(command), /--settings/);
  assert.match(String(command), /ANTHROPIC_BASE_URL=/);
  assert.match(String(command), /EASYSWITCH_SESSION/);
});

test("count_tokens answers locally", async () => {
  const response = await fetch(`${base}/v1/messages/count_tokens`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-easyswitch-session": sessionToken("claude") },
    body: JSON.stringify({ model: "mock-relay/mock-coder", messages: [{ role: "user", content: "hello there" }] }),
  });
  const json = (await response.json()) as Json;
  assert.ok(Number(json.input_tokens) > 0);
});

test("the real Claude Code binary completes a Bash round trip through the gateway", async t => {
  const claude = await findClaude();
  if (!claude) {
    t.skip("claude not installed");
    return;
  }
  const home = mkdtempSync(join(tmpdir(), "es-claude-home-"));
  const work = mkdtempSync(join(tmpdir(), "es-claude-work-"));
  const launchToken = sessionToken("claude");
  const env = claudeEnv(port, "mock-relay/mock-coder", launchToken);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
  for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete childEnv[key];
  const before = relay.requests.length;
  const pending = run(claude, [
    "-p", "Run the shell command you are given and report what it printed.",
    "--permission-mode", "default",
    "--allowedTools", "Bash(echo:*)",
    ...claudeArgs(env),
  ], { cwd: work, env: childEnv, timeout: 150_000 });
  pending.child.stdin?.end();
  const { stdout } = await pending.catch((error: { stdout?: string; stderr?: string; message: string }) => {
    throw new Error(`claude failed: ${error.message}\n--- stdout\n${error.stdout ?? ""}\n--- stderr\n${(error.stderr ?? "").slice(-3000)}`);
  });

  assert.match(stdout, new RegExp(SHELL_MARKER));
  const turns = relay.requests.slice(before) as Json[];
  const toolTurn = turns.find(r => (r.messages as Json[]).some(m => m.role === "tool" && String(m.content).includes(SHELL_MARKER)));
  assert.ok(toolTurn, "the Bash output came back to the relay as a tool message");

  // Gateway model discovery: Claude Code fetched EasySwitch's list for its own
  // /model menu and cached it under its config dir, keyed by the gateway address.
  const cache = JSON.parse(readFileSync(join(home, ".claude", "cache", "gateway-models.json"), "utf8")) as { baseUrl: string; models: Json[] };
  assert.equal(cache.baseUrl, `http://127.0.0.1:${port}`);
  assert.deepEqual(cache.models.map(m => m.id), [claudeModelId("mock-relay", "mock-coder"), claudeModelId("mock-relay", "mock-mini")]);
});

test("picker ids survive any model name and route back to their provider", async () => {
  for (const model of ["mock-mini", "org/weird~model", "a--b"]) {
    assert.equal(fromClaudeModelId(claudeModelId("mock-relay", model)), `mock-relay/${model}`);
  }
  assert.equal(fromClaudeModelId("claude-sonnet-4-5"), undefined);
  // Picking another model in /model mid-session: the request names it by its picker id.
  const before = relay.requests.length;
  const response = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", authorization: `Bearer ${sessionToken("claude")}` },
    body: JSON.stringify({ model: claudeModelId("mock-relay", "mock-mini"), max_tokens: 100, messages: [{ role: "user", content: "Reply with exactly the word: pong" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal((relay.requests[before] as Json).model, "mock-mini");
});

test("EasySwitch leaves no trace in the user's real Claude Code settings", () => {
  let text = "";
  try { text = readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"); } catch { /* none is clean too */ }
  assert.equal(/easyswitch/i.test(text), false);
});
