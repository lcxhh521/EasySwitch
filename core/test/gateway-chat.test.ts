import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { agentFromAuth, agentOfHeaders, sessionToken } from "../src/gateway-chat.ts";
import { AGENTS } from "../src/agents.ts";
import { Ledger } from "../src/ledger.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, unknown>;

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let ledgerDir: string;

before(async () => {
  relay = await startMockRelay(0, { apiKey: "relay-key" });
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  ledgerDir = mkdtempSync(join(tmpdir(), "es-chat-ledger-"));
  server = createEasySwitchServer({ store: new Store(mkdtempSync(join(tmpdir(), "es-chat-store-"))), secrets: createSecretStore(), port, ledger: new Ledger(ledgerDir) });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  await fetch(`http://127.0.0.1:${port}/api/providers`, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" },
    body: JSON.stringify({ name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "relay-key" }),
  });
});

after(() => {
  server.closeAllConnections();
  server.close();
  relay.server.closeAllConnections();
  relay.server.close();
});

const post = (body: Json, token = `Bearer ${fixtureToken("qwen-code")}`) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: token }, body: JSON.stringify(body) });

test("a non-streaming chat request is answered by the provider the model names", async () => {
  const before = relay.requests.length;
  const response = await post({ model: "mock-relay/mock-coder", messages: [{ role: "user", content: "Reply with exactly the word: pong" }] });
  assert.equal(response.status, 200);
  const json = (await response.json()) as { choices: Array<{ message: { content: string } }>; usage: Json };
  assert.match(json.choices[0]!.message.content, /pong|Hello/i);
  assert.equal((relay.requests[before] as Json).model, "mock-coder", "the upstream sees its own model name");
});

test("a streaming request is passed through chunk for chunk, with usage switched on for the ledger", async () => {
  const before = relay.requests.length;
  const response = await post({ model: "mock-relay/mock-coder", stream: true, messages: [{ role: "user", content: "Reply with exactly the word: pong" }] });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /^data: /);
  assert.match(text, /\[DONE\]/);
  assert.deepEqual((relay.requests[before] as Json).stream_options, { include_usage: true });
  await new Promise(r => setTimeout(r, 100));
  const entries = new Ledger(ledgerDir).read();
  const last = entries.at(-1)!;
  assert.equal(last.harness, "qwen-code", "the agent comes from the per-launch token");
  assert.equal(last.inputTokens, 42);
  assert.equal(last.outputTokens, 7);
});

test("a tool round trip works through the chat entry", async () => {
  const tools = [{ type: "function", function: { name: "exec_command", description: "run", parameters: { type: "object", properties: { cmd: { type: "string" } } } } }];
  const first = await post({ model: "mock-relay/mock-coder", messages: [{ role: "user", content: "Run the shell command you are given and report what it printed." }], tools });
  const message = ((await first.json()) as { choices: Array<{ message: { tool_calls?: Array<{ id: string; function: { name: string } }> } }> }).choices[0]!.message;
  assert.ok(message.tool_calls?.length, "the model asked for a tool");
  const second = await post({
    model: "mock-relay/mock-coder", tools,
    messages: [
      { role: "user", content: "Run the shell command you are given and report what it printed." },
      { role: "assistant", content: null, tool_calls: message.tool_calls },
      { role: "tool", tool_call_id: message.tool_calls![0]!.id, content: "easyswitch-roundtrip-ok" },
    ],
  });
  assert.equal(second.status, 200);
  assert.match(JSON.stringify(await second.json()), /easyswitch-roundtrip-ok/);
});

test("unknown models and upstream errors are reported in OpenAI's error shape", async () => {
  const unknown = await post({ model: "nope/x", messages: [] });
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, "model_not_found");
  const bad = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
  assert.equal(bad.status, 400);
});

test("the agent id travels in the per-launch token", () => {
  assert.equal(agentFromAuth(sessionToken("qwen-code")), "qwen-code");
  assert.equal(agentFromAuth(`Bearer ${sessionToken("opencode")}`), "opencode");
  assert.equal(agentFromAuth("Bearer es-session-4af52f1a-3eb8-4672-86bd-c9d0a69551d9"), "chat", "a bare UUID token has no agent");
  assert.equal(agentFromAuth(undefined), "chat");
});

test("every catalog agent keeps its canonical identity in new and legacy tokens", () => {
  for (const { id } of AGENTS) {
    const token = sessionToken(id);
    assert.ok(token.startsWith(`es-session-${id}-`), id);
    assert.equal(agentFromAuth(token), id);
    assert.equal(agentFromAuth(`Bearer ${token}`), id);
    assert.equal(agentFromAuth(`es-session-${id}-short-suffix`), id);
    const legacy = id.replace(/[^a-z0-9]/g, "");
    assert.equal(agentFromAuth(`es-session-${legacy}-abc`), id);
    assert.equal(agentFromAuth(`es-session-${legacy}-12345678-abcd-4321-abcd-123456789abc`), id);
  }
  assert.equal(agentFromAuth(sessionToken("custom-agent")), "custom-agent");
  assert.equal(agentFromAuth("es-session-claude-desktop-"), "chat", "a missing suffix cannot borrow another agent identity");
  assert.equal(agentFromAuth("es-session-12345678-abcd-4321-abcd-123456789abc"), "chat");
});

test("client headers select the per-launch identity without borrowing unrelated vendor auth", () => {
  assert.equal(agentOfHeaders({ authorization: "Bearer native-login", "x-api-key": sessionToken("claude-desktop") }, "claude"), "claude-desktop");
  assert.equal(agentOfHeaders({ authorization: "Bearer unrelated", "x-goog-api-key": "es-session-geminicli-abc" }, "gemini-cli"), "gemini-cli");
  assert.equal(agentOfHeaders({ authorization: "Bearer native-login", "x-easyswitch-session": "es-session-minimaxcode-abc" }, "claude"), "minimax-code");
  assert.equal(agentOfHeaders({}, "codex"), "codex");
});
