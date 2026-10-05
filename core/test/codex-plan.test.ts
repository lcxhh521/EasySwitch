import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { accessToken, beginCodexSignIn, planTarget, SiwcError, type SiwcAccount, type SiwcStorage } from "../src/siwc.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startFakeOpenAI, type FakeOpenAI } from "./fake-openai.ts";

process.env.EASYSWITCH_SECRETS = "memory";
process.env.EASYSWITCH_DEVICE_POLL_MS = "20";
type Json = Record<string, any>;

let fake: FakeOpenAI;
before(async () => {
  fake = await startFakeOpenAI();
  process.env.EASYSWITCH_OPENAI_AUTH = fake.base;
  process.env.EASYSWITCH_OPENAI_API = `${fake.base}/v1`;
  process.env.EASYSWITCH_CHATGPT_UPSTREAM = `${fake.base}/backend-api/codex`;
});
after(() => fake.close());

function memoryStorage(): SiwcStorage & { list: SiwcAccount[] } {
  const list: SiwcAccount[] = [];
  return {
    list, hostId: () => "urn:uuid:x",
    accounts: () => structuredClone(list),
    save: a => { const i = list.findIndex(x => x.id === a.id); if (i >= 0) list[i] = structuredClone(a); else list.push(structuredClone(a)); },
    remove: id => { const i = list.findIndex(x => x.id === id); if (i >= 0) list.splice(i, 1); },
  };
}

test("signing in as the Codex client: a code to type, polling until it is done, no registration step", async () => {
  fake.devicePending = 2; fake.deviceCalls.length = 0; fake.tokenCalls.length = 0;
  const storage = memoryStorage();
  const secrets = createSecretStore();
  let opened = "";
  const si = await beginCodexSignIn({ storage, secrets, open: async url => { opened = url; } }, { pollMs: 10 });
  assert.equal(si.userCode, "ABCD-1234");
  assert.equal(si.url, `${fake.base}/codex/device`);
  assert.equal(opened, si.url, "the page for typing the code is opened");
  const account = await si.done;
  assert.equal(account.kind, "codex");
  assert.equal(account.email, "codex@example.com");
  assert.equal(account.planUsage, true);
  assert.equal(fake.deviceCalls.filter(c => c.path.endsWith("/token")).length, 3, "two answers of not yet, then the code");
  const exchange = fake.tokenCalls.find(c => c.grant_type === "authorization_code")!;
  assert.equal(exchange.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(exchange.redirect_uri, `${fake.base}/deviceauth/callback`);
  assert.ok(JSON.parse((await secrets.get(`siwc:${account.id}`))!).refresh_token);
  // Signing in again as the same person updates the account instead of adding another.
  fake.devicePending = 0;
  const again = await (await beginCodexSignIn({ storage, secrets, open: async () => {} }, { pollMs: 10 })).done;
  assert.equal(again.id, account.id);
  assert.equal(storage.list.length, 1);
});

test("a login that cannot be finished in time or is cancelled does not leave an account behind", async () => {
  const storage = memoryStorage();
  const si = await beginCodexSignIn({ storage, secrets: createSecretStore(), open: async () => {} }, { pollMs: 10 });
  si.cancel();
  await assert.rejects(si.done, (e: SiwcError) => e.code === "denied");
  assert.equal(storage.list.length, 0);
});

test("calls on the Codex backend carry the workspace from the token and say plainly who is calling", async () => {
  const storage = memoryStorage();
  const secrets = createSecretStore();
  const account = await (await beginCodexSignIn({ storage, secrets, open: async () => {} }, { pollMs: 10 })).done;
  const token = await accessToken({ storage, secrets }, account.id);
  const target = planTarget("codex", token, "/responses");
  assert.equal(target.url, `${fake.base}/backend-api/codex/responses`);
  assert.equal(target.headers["ChatGPT-Account-ID"], "acct-123");
  assert.equal(target.headers.originator, "easyswitch", "it does not pose as the Codex CLI");
  assert.match(target.headers["user-agent"]!, /^EasySwitch\//);
});

test("the Codex login is renewed with the Codex client, serialised, with the new refresh token kept", async () => {
  const storage = memoryStorage();
  const secrets = createSecretStore();
  const account = await (await beginCodexSignIn({ storage, secrets, open: async () => {} }, { pollMs: 10 })).done;
  storage.save({ ...storage.list[0]!, expiresAt: Date.now() + 10_000 });
  fake.tokenCalls.length = 0;
  const [a, b] = await Promise.all([accessToken({ storage, secrets }, account.id), accessToken({ storage, secrets }, account.id)]);
  assert.equal(a, b);
  const refreshes = fake.tokenCalls.filter(c => c.grant_type === "refresh_token");
  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0]!.client_id, "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(refreshes[0]!.resource, undefined, "the Codex token endpoint is not asked for a resource");
});

test("end to end: the console signs in as Codex, the models are the account's, and any agent can use it", async () => {
  const port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const p = (probe.address() as { port: number }).port; probe.close(() => resolve(p)); });
  });
  const store = new Store(mkdtempSync(join(tmpdir(), "es-codexplan-")));
  const server: Server = createEasySwitchServer({ store, secrets: createSecretStore(), port, openUrl: async () => {} });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  const H = { "content-type": "application/json", "x-easyswitch": "1" };
  const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
  try {
    fake.devicePending = 1;
    const started = (await (await api("POST", "/api/plan/signin", {})).json()) as Json;
    assert.equal(started.userCode, "ABCD-1234", "the default is the Codex sign-in with a code to type");
    let state: Json = {};
    for (let i = 0; i < 100 && state.signIn?.status !== "done"; i++) {
      state = (await (await api("GET", "/api/plan")).json()) as Json;
      if (state.signIn?.status !== "done") await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(state.signIn.status, "done", JSON.stringify(state));
    assert.equal(state.accounts[0].kind, "codex");
    const provider = store.providers().find(p => p.plan)!;
    assert.equal(provider.plan!.kind, "codex");
    assert.deepEqual(provider.models, ["gpt-codex-fake"]);
    assert.deepEqual(provider.modelEfforts, { "gpt-codex-fake": ["low", "medium", "high", "xhigh"] });
    fake.codexRequests.length = 0;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-opencode-x" },
      body: JSON.stringify({ model: `${provider.id}/gpt-codex-fake`, max_tokens: 40, temperature: 0.1, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as Json).choices[0].message.content, "Hello from the plan");
    const sent = fake.codexRequests.find(r => r.path === "/responses")!;
    assert.equal(sent.headers["chatgpt-account-id"], "acct-123");
    assert.ok(sent.body.instructions, "instructions are filled in for the Codex backend");
    assert.equal(sent.body.temperature, undefined);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
