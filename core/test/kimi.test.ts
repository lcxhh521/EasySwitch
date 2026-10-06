import { existingSubscriptionKind } from "../src/subscription-compat.ts";
import { pickKey, setKimiToken } from "../src/keypool.ts";
import type { Provider } from "../src/types.ts";
import { fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { clearKimiCache, KIMI_CLIENT_ID } from "../src/kimi.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startFakeKimi, type FakeKimi } from "./fake-kimi.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

let fake: FakeKimi; let server: Server; let store: Store; let port = 0; let accountId = ""; let providerId = "";
const secrets = createSecretStore();
const dir = mkdtempSync(join(tmpdir(), "es-kimi-"));
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
const ask = (extra: Json = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken("aider")}` },
  body: JSON.stringify({ model: `${providerId}/kimi-for-coding`, messages: [{ role: "user", content: "hi" }], ...extra }),
});

before(async () => {
  process.env.EASYSWITCH_TEST_SUBSCRIPTION_FIXTURES = "1";
  fake = await startFakeKimi();
  process.env.EASYSWITCH_KIMI_AUTH = fake.auth; process.env.EASYSWITCH_KIMI_API = fake.api; process.env.EASYSWITCH_KIMI_POLL_MS = "5";
  port = await new Promise<number>(resolve => { const p = createServer().listen(0, "127.0.0.1", () => { const n = (p.address() as { port: number }).port; p.close(() => resolve(n)); }); });
  store = new Store(join(dir, "store"));
  server = createEasySwitchServer({ store, secrets, port, openUrl: async () => undefined });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
});
after(() => {
  delete process.env.EASYSWITCH_TEST_SUBSCRIPTION_FIXTURES;
  server.closeAllConnections(); server.close(); fake.close(); rmSync(dir, { recursive: true, force: true });
  for (const k of ["AUTH", "API", "POLL_MS"]) delete process.env[`EASYSWITCH_KIMI_${k}`];
});

test("signing in with the device code makes a source that starts switched off, keeps the refresh token in the secret store only, and lists the account's models", async () => {
  const start = await api("POST", "/api/kimi/signin", {});
  assert.equal(start.status, 200, await start.clone().text());
  assert.equal(((await start.json()) as Json).userCode, "ABCD-1234", "the code to confirm is shown");
  let state: Json = {};
  for (let i = 0; i < 200 && !["done", "error"].includes(state.signIn?.status); i++) {
    state = (await (await api("GET", "/api/plan")).json()) as Json;
    if (!["done", "error"].includes(state.signIn?.status)) await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(state.signIn.status, "done", JSON.stringify(state.signIn));
  const account = state.accounts.find((a: Json) => a.kind === "kimi");
  assert.ok(account);
  assert.equal(account.email, "member@example.com");
  assert.equal(account.on, false);
  accountId = account.id;
  const provider = store.providers().find(p => p.kimi)!;
  providerId = provider.id;
  assert.deepEqual(provider.models, ["kimi-for-coding", "k3"]);
  assert.equal(provider.off, true);
  assert.equal(fake.calls.find(c => c.path === "/api/oauth/device_authorization")!.form.client_id, KIMI_CLIENT_ID);
  const poll = fake.calls.filter(c => c.path === "/api/oauth/token");
  assert.ok(poll.length >= 2, "pending answers are waited out");
  assert.equal(poll[0]!.form.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
  assert.equal(poll[0]!.headers["x-msh-platform"], "kimi_code_cli");
  assert.match(String(poll[0]!.headers["x-msh-device-id"]), /^[0-9a-f]{32}$/);
  assert.equal(await secrets.get(`kimi:${accountId}`), "kimi-refresh-1");
  const files = readdirSync(join(dir, "store")).map(f => readFileSync(join(dir, "store", f), "utf8")).join("\n");
  assert.ok(!files.includes("kimi-refresh-1") && !files.includes(".sig"), "no token on disk");
  const shown = (await (await api("GET", "/api/plan")).text()) + (await (await api("GET", "/api/state")).text());
  assert.ok(!shown.includes("kimi-refresh-1") && !shown.includes(".sig"), "no token in anything the console is shown");
});

test("while it is off Kimi is asked for nothing; on, the request goes out with the signed-in token and Kimi's client headers", async () => {
  const before = fake.calls.length;
  assert.equal((await ask()).status, 404);
  assert.equal(fake.calls.length, before);
  assert.equal((await api("PUT", `/api/plan/${accountId}/switch`, { on: true })).status, 200);
  const answer = (await (await ask()).json()) as Json;
  assert.equal(answer.choices[0].message.content, "Kimi says hi");
  const call = fake.calls.filter(c => c.path === "/coding/v1/chat/completions").at(-1)!;
  assert.match(String(call.headers.authorization), /^Bearer .+\.sig$/);
  assert.equal(call.headers["x-msh-platform"], "kimi_code_cli");
  assert.equal(call.json.model, "kimi-for-coding");
});

test("Kimi account tokens stay on the configured coding API despite persisted URL and wire overrides", async () => {
  const provider = store.provider(providerId)!;
  provider.baseUrl = "https://must-not-contact.invalid/v1";
  provider.anthropicBaseUrl = "https://must-not-contact.invalid/messages";
  provider.wire = { authHeader: "x-leak", paths: { chat: "wrong-path" }, query: { token: "must-not-appear" }, headers: { ...provider.wire?.headers, "x-leak": "must-not-forward", authorization: "wrong-credential" } };
  store.upsertProvider(provider);
  assert.equal((await ask()).status, 200);
  const call = fake.calls.at(-1)!;
  assert.equal(call.path, "/coding/v1/chat/completions");
  assert.match(String(call.headers.authorization), /^Bearer .+\.sig$/);
  assert.equal(call.headers["x-leak"], undefined);
  assert.equal(call.headers["x-msh-platform"], "kimi_code_cli");
});

test("an access token that has ended is renewed from the refresh token; a refresh token Kimi no longer accepts means sign in again", async () => {
  clearKimiCache();
  const before = fake.calls.filter(c => c.form.grant_type === "refresh_token").length;
  assert.equal((await ask()).status, 200);
  assert.equal(fake.calls.filter(c => c.form.grant_type === "refresh_token").length, before + 1);
  assert.equal((await ask()).status, 200);
  assert.equal(fake.calls.filter(c => c.form.grant_type === "refresh_token").length, before + 1, "kept while it is good");
  fake.refreshToken = "rotated"; clearKimiCache();
  const gone = await ask();
  assert.equal(gone.status, 401);
  fake.refreshToken = "kimi-refresh-1";
});

test("removing the account forgets the login and the source", async () => {
  assert.equal((await api("DELETE", `/api/kimi/${accountId}`)).status, 200);
  assert.equal(store.providers().find(p => p.kimi), undefined);
  assert.equal(await secrets.get(`kimi:${accountId}`), undefined);
  assert.equal((await api("DELETE", `/api/kimi/${accountId}`)).status, 404);
});


test("Kimi compatibility validates metadata and refuses credential fallback or mixed modes", async () => {
  const base = { id: "fixture", baseUrl: fake.api, kimi: { accountId: "fixture-user" } } as Provider;
  for (const metadata of [null, {}, [], { accountId: "" }, { accountId: "x", token: "do-not-leak" }, { accountId: "x", email: 1 }]) {
    assert.throws(() => existingSubscriptionKind({ ...base, kimi: metadata } as Provider));
  }
  assert.equal(existingSubscriptionKind(base), "kimi");
  assert.throws(() => existingSubscriptionKind({ ...base, cursor: { accountId: "other" } }));
  assert.throws(() => existingSubscriptionKind({ ...base, plan: { kind: "codex", accountId: "other" } }));
  let reads = 0;
  const empty = createSecretStore(); empty.get = async () => { reads++; return "must-not-fallback"; };
  setKimiToken(async () => "fixture-kimi-token");
  try { assert.equal((await pickKey(empty, base)).apiKey, "fixture-kimi-token"); assert.equal(reads, 0); }
  finally { setKimiToken(undefined); }
  await assert.rejects(pickKey(empty, base), /不会改用普通 API Key/);
  await assert.rejects(pickKey(empty, { ...base, kimi: {} } as Provider));
  assert.equal(reads, 0);
});
