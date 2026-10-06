import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { accessToken, beginCopilotSignIn, SiwcError, type SiwcAccount, type SiwcStorage } from "../src/siwc.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startFakeGitHub, type FakeGitHub } from "./fake-github.ts";

process.env.EASYSWITCH_SECRETS = "memory";
process.env.EASYSWITCH_DEVICE_POLL_MS = "15";
type Json = Record<string, any>;

let gh: FakeGitHub;
before(async () => {
  // Point OpenAI's address at a closed port: if any GitHub token were ever sent there, the call would fail loudly.
  process.env.EASYSWITCH_OPENAI_AUTH = "http://127.0.0.1:9";
  gh = await startFakeGitHub();
  process.env.EASYSWITCH_GITHUB = gh.base;
  process.env.EASYSWITCH_GITHUB_API = gh.base;
  process.env.EASYSWITCH_COPILOT_API = `${gh.base}/copilot`;
});
after(() => gh.close());

function memoryStorage(): SiwcStorage & { list: SiwcAccount[] } {
  const list: SiwcAccount[] = [];
  return {
    list, hostId: () => "urn:uuid:x", accounts: () => structuredClone(list),
    save: a => { const i = list.findIndex(x => x.id === a.id); if (i >= 0) list[i] = structuredClone(a); else list.push(structuredClone(a)); },
    remove: id => { const i = list.findIndex(x => x.id === id); if (i >= 0) list.splice(i, 1); },
  };
}

test("GitHub device sign-in: a code, polling through 'pending', then a Copilot token is minted before anything is saved", async () => {
  gh.pending = 2; gh.tokensMinted = 0;
  const storage = memoryStorage();
  const secrets = createSecretStore();
  let opened = "";
  const si = await beginCopilotSignIn({ storage, secrets, open: async u => { opened = u; } });
  assert.equal(si.userCode, "WXYZ-9876");
  assert.equal(opened, `${gh.base}/login/device`);
  const account = await si.done;
  assert.equal(account.kind, "copilot");
  assert.equal(account.label, "octo-user");
  assert.equal(account.endpoint, `${gh.base}/copilot`);
  const saved = JSON.parse((await secrets.get(`siwc:${account.id}`))!);
  assert.equal(saved.refresh_token, "gho_fakegithubtoken", "the GitHub token is kept (to mint new Copilot tokens), in the secret store");
  assert.match(saved.access_token, /^copilot-tok-/);
  assert.ok(!JSON.stringify(storage.list).includes("gho_"), "no token in the plain record");
});

test("a GitHub account without Copilot is told so plainly and nothing is saved", async () => {
  gh.subscribed = false;
  const storage = memoryStorage();
  const si = await beginCopilotSignIn({ storage, secrets: createSecretStore(), open: async () => {} });
  await assert.rejects(si.done, (e: SiwcError) => e.code === "not_eligible" && /Copilot/.test(e.message));
  assert.equal(storage.list.length, 0);
  gh.subscribed = true;
});

test("the short-lived Copilot token is minted again from the GitHub token when it is about to end", async () => {
  const storage = memoryStorage();
  const secrets = createSecretStore();
  const account = await (await beginCopilotSignIn({ storage, secrets, open: async () => {} })).done;
  const first = await accessToken({ storage, secrets }, account.id);
  assert.equal(await accessToken({ storage, secrets }, account.id), first, "still fresh");
  storage.save({ ...storage.list[0]!, expiresAt: Date.now() + 30_000 });
  const before = gh.tokensMinted;
  const [a, b] = await Promise.all([accessToken({ storage, secrets }, account.id), accessToken({ storage, secrets }, account.id)]);
  assert.equal(a, b);
  assert.notEqual(a, first);
  assert.equal(gh.tokensMinted, before + 1, "once for two callers");
});

test("end to end: Copilot becomes a model source; an agent's Chat request goes out with the Copilot client headers", async () => {
  const port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const p = (probe.address() as { port: number }).port; probe.close(() => resolve(p)); });
  });
  const store = new Store(mkdtempSync(join(tmpdir(), "es-copilot-")));
  const server: Server = createEasySwitchServer({ store, secrets: createSecretStore(), port, openUrl: async () => {} });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  const H = { "content-type": "application/json", "x-easyswitch": "1" };
  const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
  try {
    const started = (await (await api("POST", "/api/plan/signin", { mode: "copilot" })).json()) as Json;
    assert.equal(started.userCode, "WXYZ-9876");
    let state: Json = {};
    for (let i = 0; i < 100 && state.signIn?.status !== "done"; i++) {
      state = (await (await api("GET", "/api/plan")).json()) as Json;
      if (state.signIn?.status !== "done") await new Promise(r => setTimeout(r, 30));
    }
    assert.equal(state.signIn.status, "done", JSON.stringify(state));
    const provider = store.providers().find(p => p.plan?.kind === "copilot")!;
    assert.deepEqual(provider.models, ["gpt-copilot-fake"], "chat models the picker shows, not embeddings or hidden ones");
    assert.deepEqual(provider.modelEfforts, { "gpt-copilot-fake": ["low", "medium", "high"] });
    assert.equal(provider.route, "chat-translate");
    assert.equal(provider.off, true, "a new subscription starts switched off");
    assert.equal((await api("PUT", `/api/plan/${state.accounts[0].id}/switch`, { on: true })).status, 200);
    gh.chatRequests.length = 0;
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken("opencode")}` },
      body: JSON.stringify({ model: `${provider.id}/gpt-copilot-fake`, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(((await res.json()) as Json).choices[0].message.content, "Hello from Copilot");
    const sent = gh.chatRequests[0]!;
    assert.equal(sent.headers["copilot-integration-id"], "vscode-chat");
    assert.match(String(sent.headers.authorization), /^Bearer copilot-tok-/, "the minted token, never the GitHub token");
    assert.ok(!JSON.stringify(sent.headers).includes("gho_"));
    // Signing out forgets the account and its source.
    const out = await api("DELETE", `/api/plan/${state.accounts[0].id}`);
    assert.equal(out.status, 200);
    assert.equal(((await out.json()) as Json).revoked, false, "nothing was sent to OpenAI for a GitHub token");
    assert.equal(store.providers().some(p => p.plan), false);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
