import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startFakeOpenAI, type FakeOpenAI } from "./fake-openai.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

let fake: FakeOpenAI;
let server: Server;
let store: Store;
let port: number;
let pid: string;
let accountId: string;
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });

before(async () => {
  fake = await startFakeOpenAI();
  process.env.EASYSWITCH_OPENAI_AUTH = fake.base;
  process.env.EASYSWITCH_OPENAI_API = `${fake.base}/v1`;
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  store = new Store(mkdtempSync(join(tmpdir(), "es-plan-")));
  server = createEasySwitchServer({
    store, secrets: createSecretStore(), port,
    openUrl: async url => { const back = (await fetch(url, { redirect: "manual" })).headers.get("location")!; await fetch(back).then(r => r.text()); },
  });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
});

after(() => { server.closeAllConnections(); server.close(); fake.close(); });

test("Continue with ChatGPT turns a signed-in plan into a model source with the account's own models and levels", async () => {
  assert.equal((await api("POST", "/api/plan/signin", { label: "我的订阅", mode: "open" })).status, 200);
  let state: Json = {};
  for (let i = 0; i < 50 && state.signIn?.status !== "done"; i++) {
    state = (await (await api("GET", "/api/plan")).json()) as Json;
    if (state.signIn?.status !== "done") await new Promise(r => setTimeout(r, 40));
  }
  assert.equal(state.signIn.status, "done", JSON.stringify(state));
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].planUsage, true);
  assert.ok(!JSON.stringify(state).includes("at-") && !JSON.stringify(state).includes("rt-"), "no token is ever shown by the API");
  accountId = state.accounts[0].id;
  const provider = store.providers().find(p => p.plan?.accountId === accountId)!;
  assert.ok(provider, "the account is a provider now");
  pid = provider.id;
  assert.deepEqual(provider.models, ["gpt-fake"], "only the models meant for a picker");
  assert.equal(provider.billing, "subscription", "a plan is not priced per token");
  assert.equal(provider.route, "responses-native");
  assert.deepEqual(provider.modelEfforts, { "gpt-fake": ["low", "high", "ultra"] }, "the model's own levels, as OpenAI lists them");
});

test("a Chat Completions agent uses the plan: converted to Responses, bearer is the account's token, refused fields never leave", async () => {
  fake.responsesRequests.length = 0;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-opencode-x" },
    body: JSON.stringify({ model: `${pid}/gpt-fake`, max_tokens: 50, temperature: 0.2, messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Json;
  assert.equal(json.choices[0].message.content, "Hello from the plan");
  assert.equal(json.usage.prompt_tokens, 11);
  const sent = fake.responsesRequests[0]!;
  assert.match(sent.authorization!, /^Bearer at-/);
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.stream, true);
  assert.equal(sent.body.instructions, "be brief");
  assert.equal(sent.body.temperature, undefined);
  assert.equal(sent.body.max_output_tokens, undefined);
});

test("streaming works through the same route", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-opencode-x" },
    body: JSON.stringify({ model: `${pid}/gpt-fake`, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await res.text();
  const chunks = text.split("\n\n").filter(b => b.startsWith("data: ") && !b.includes("[DONE]")).map(b => JSON.parse(b.slice(6)) as Json);
  assert.equal(chunks.map(c => c.choices[0].delta.content ?? "").join(""), "Hello from the plan");
});

test("a Claude Code style Messages request is answered by the plan too (Claude's own subscription is a different matter)", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: `${pid}/gpt-fake`, max_tokens: 50, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.match(JSON.stringify(await res.json()), /Hello from the plan/);
});

test("a Responses agent (Codex) is forwarded with the refused fields and tools removed, and system turned into developer", async () => {
  fake.responsesRequests.length = 0;
  const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-codex-x" },
    body: JSON.stringify({ model: `${pid}/gpt-fake`, stream: true, store: true, temperature: 0.1, metadata: { a: 1 }, input: [{ type: "message", role: "system", content: "s" }, { type: "message", role: "user", content: "hi" }], tools: [{ type: "image_generation" }] }),
  });
  assert.equal(res.status, 200);
  assert.match((await res.text()).replace(/"\},?\s*\n?[^]*?"delta":"/g, ""), /Hello from the plan|Hello from /);
  const sent = fake.responsesRequests[0]!.body;
  assert.equal(sent.store, false);
  assert.equal(sent.temperature, undefined);
  assert.equal(sent.input[0].role, "developer");
  assert.ok(!JSON.stringify(sent.tools ?? []).includes("image_generation"));
});

test("a thinking level saved for any agent reaches the plan in the model's own words, even above high", async () => {
  await api("PUT", "/api/bindings/opencode", { providerId: pid, model: "gpt-fake" });
  assert.equal((await api("PUT", "/api/bindings/opencode/effort", { effort: "ultra" })).status, 200, "the model has ultra, and the agent can say it");
  fake.responsesRequests.length = 0;
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-opencode-x" },
    body: JSON.stringify({ model: `${pid}/gpt-fake`, messages: [{ role: "user", content: "hi" }] }),
  }).then(r => r.text());
  assert.deepEqual(fake.responsesRequests[0]!.body.reasoning, { effort: "ultra" });
});

test("the access token is renewed when it is about to end, and the request goes out with the new one", async () => {
  const before = fake.tokenCalls.length;
  const acc = store.siwcStorage().accounts()[0]!;
  store.siwcStorage().save({ ...acc, expiresAt: Date.now() + 20_000 });
  fake.responsesRequests.length = 0;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-aider-x" },
    body: JSON.stringify({ model: `${pid}/gpt-fake`, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  assert.equal(fake.tokenCalls.length, before + 1);
  assert.equal(fake.tokenCalls.at(-1)!.grant_type, "refresh_token");
});

test("when the plan's usage limit is reached the agent gets a plain 429, and nothing is retried elsewhere", async () => {
  fake.responsesStatus = { status: 429, body: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit reached" } } };
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-aider-x" },
    body: JSON.stringify({ model: `${pid}/gpt-fake`, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 429);
  assert.match(await res.text(), /limit/);
});

test("signing out revokes the login, forgets the account and removes its model source", async () => {
  const r = (await (await api("DELETE", `/api/plan/${accountId}`)).json()) as Json;
  assert.equal(r.revoked, true);
  assert.equal(store.providers().some(p => p.plan), false);
  assert.equal(store.siwcStorage().accounts().length, 0);
  assert.equal(fake.revoked.length, 1);
});
