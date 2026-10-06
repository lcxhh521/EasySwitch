import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { sessionToken } from "../src/gateway-chat.ts";
import { Store } from "../src/store.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let store: Store;
let port: number;
let pid: string;

before(async () => {
  relay = await startMockRelay(0, { apiKey: "relay-key" });
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  store = new Store(mkdtempSync(join(tmpdir(), "es-think-")));
  server = createEasySwitchServer({ store, secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  pid = ((await fetch(`http://127.0.0.1:${port}/api/providers`, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" },
    body: JSON.stringify({ name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "relay-key" }),
  }).then(r => r.json())) as { id: string }).id;
});

after(() => { server.closeAllConnections(); server.close(); relay.server.closeAllConnections(); relay.server.close(); });

const H = { "content-type": "application/json", "x-easyswitch": "1" };
const setEffort = (agent: string, effort: string) => fetch(`http://127.0.0.1:${port}/api/bindings/${agent}/effort`, { method: "PUT", headers: H, body: JSON.stringify({ effort }) });
async function ask(agent: string): Promise<Json> {
  const before = relay.requests.length;
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken(agent)}` },
    body: JSON.stringify({ model: `${pid}/mock-coder`, messages: [{ role: "user", content: "Reply with exactly the word: pong" }] }),
  }).then(r => r.text());
  return relay.requests[before] as Json;
}

test("any agent can be given a thinking level, which the gateway applies, live, for an upstream that takes it", async () => {
  const provider = store.provider(pid)!;
  provider.reasoningEffort = true;
  store.upsertProvider(provider);
  await fetch(`http://127.0.0.1:${port}/api/bindings/opencode`, { method: "PUT", headers: H, body: JSON.stringify({ providerId: pid, model: "mock-coder" }) });
  assert.equal((await ask("opencode")).reasoning_effort, undefined, "nothing saved, nothing sent");
  assert.equal((await setEffort("opencode", "high")).status, 200, "an agent with no setting of its own can still be given one");
  assert.equal((await ask("opencode")).reasoning_effort, "high");
  await setEffort("opencode", "low");
  assert.equal((await ask("opencode")).reasoning_effort, "low", "changed while the session is running");
  assert.equal((await ask("aider")).reasoning_effort, undefined, "another agent is not affected");
  await setEffort("opencode", "");
  assert.equal((await ask("opencode")).reasoning_effort, undefined, "back to the model's own default");
});

test("an upstream marked as not taking a level never receives one", async () => {
  const provider = store.provider(pid)!;
  provider.reasoningEffort = false;
  store.upsertProvider(provider);
  await setEffort("opencode", "high");
  assert.equal((await ask("opencode")).reasoning_effort, undefined);
});

test("hyphenated agents use canonical prefs and logs with tokens issued from canonical and legacy agent IDs", async () => {
  const provider = store.provider(pid)!; provider.reasoningEffort = true; store.upsertProvider(provider);
  const cases = [
    { id: "qwen-code", path: "/v1/chat/completions", header: "authorization", body: { messages: [{ role: "user", content: "hi" }] } },
    { id: "gemini-cli", path: `/v1beta/models/${pid}%2Fmock-coder:generateContent`, header: "x-goog-api-key", body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } },
    { id: "minimax-code", path: "/v1/messages", header: "x-api-key", body: { max_tokens: 20, messages: [{ role: "user", content: "hi" }] } },
    { id: "grok-build", path: "/v1/responses", header: "authorization", body: { input: "hi" } },
  ];
  for (const item of cases) {
    store.setPrefs(item.id, { effort: "high" });
    for (const token of [sessionToken(item.id), sessionToken(item.id.replace(/-/g, ""))]) {
      const before = relay.requests.length;
      const response = await fetch(`http://127.0.0.1:${port}${item.path}`, { method: "POST", headers: { "content-type": "application/json", [item.header]: item.header === "authorization" ? `Bearer ${token}` : token }, body: JSON.stringify({ model: `${pid}/mock-coder`, ...item.body }) });
      assert.equal(response.status, 200); await response.text();
      assert.equal((relay.requests[before] as Json).reasoning_effort, "high", item.id);
      const state = await (await fetch(`http://127.0.0.1:${port}/api/state`, { headers: H })).json() as Json;
      assert.equal(state.log[0].harness, item.id, "log uses the same canonical key as preferences");
    }
  }
});
