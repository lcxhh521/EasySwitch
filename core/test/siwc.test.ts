import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { accessToken, beginSignIn, listModels, signOut, SiwcError, validateIdToken, type SiwcAccount, type SiwcStorage } from "../src/siwc.ts";
import { createSecretStore } from "../src/secrets.ts";
import { startFakeOpenAI, type FakeOpenAI } from "./fake-openai.ts";

process.env.EASYSWITCH_SECRETS = "memory";

let fake: FakeOpenAI;
before(async () => {
  fake = await startFakeOpenAI();
  process.env.EASYSWITCH_OPENAI_AUTH = fake.base;
  process.env.EASYSWITCH_OPENAI_API = `${fake.base}/v1`;
});
after(() => fake.close());

function memoryStorage(): SiwcStorage & { list: SiwcAccount[] } {
  const list: SiwcAccount[] = [];
  return {
    list,
    hostId: () => "urn:uuid:11111111-2222-4333-8444-555555555555",
    accounts: () => structuredClone(list),
    save: a => { const i = list.findIndex(x => x.id === a.id); if (i >= 0) list[i] = structuredClone(a); else list.push(structuredClone(a)); },
    remove: id => { const i = list.findIndex(x => x.id === id); if (i >= 0) list.splice(i, 1); },
  };
}

/** Plays the browser: follows the authorize redirect back to the loopback listener. */
const browser = async (url: string) => {
  const redirect = await fetch(url, { redirect: "manual" });
  const back = redirect.headers.get("location");
  assert.ok(back, "the authorize endpoint sent the browser back");
  await fetch(back!).then(r => r.text());
};

async function signedIn() {
  const storage = memoryStorage();
  const secrets = createSecretStore();
  const si = await beginSignIn({ storage, secrets, open: browser }, { label: "我的订阅" });
  const account = await si.done;
  return { storage, secrets, account };
}

test("Continue with ChatGPT: registers a client, signs in with PKCE on loopback, validates the ID token, keeps the tokens in the secret store", async () => {
  fake.authorizeParams.length = 0; fake.tokenCalls.length = 0;
  const { storage, secrets, account } = await signedIn();
  const p = fake.authorizeParams[0]!;
  assert.equal(p.get("client_id"), "dynamic_agent_client", "first sign-in registers a client");
  assert.equal(p.get("agent_name_hint"), "EasySwitch");
  assert.equal(p.get("ext_agent_host_id"), "urn:uuid:11111111-2222-4333-8444-555555555555");
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("code_challenge_method"), "S256");
  assert.match(p.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/, "loopback on 127.0.0.1, never localhost");
  for (const scope of ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]) assert.ok(p.get("scope")!.split(" ").includes(scope), scope);
  assert.equal(p.get("resource"), `${fake.base}/v1`);
  assert.equal(account.clientId, "oaiapp_fake123", "the issued client is the one kept, not the registration entry point");
  assert.equal(account.planUsage, true);
  assert.equal(account.label, "我的订阅");
  assert.equal(account.email, "person@example.com");
  assert.equal(fake.tokenCalls[0]!.grant_type, "authorization_code");
  assert.ok(fake.tokenCalls[0]!.code_verifier, "PKCE verifier sent");
  assert.equal(fake.tokenCalls[0]!.client_id, "oaiapp_fake123");
  assert.ok(JSON.parse((await secrets.get(`siwc:${account.id}`))!).refresh_token, "the refresh token is in the secret store");
  assert.ok(!JSON.stringify(storage.list).includes("rt-"), "no token in the plain account record");
});

test("signing in again to the same account reuses its client and skips registration", async () => {
  const { storage, secrets, account } = await signedIn();
  fake.authorizeParams.length = 0;
  const again = await (await beginSignIn({ storage, secrets, open: browser }, { existingId: account.id })).done;
  const p = fake.authorizeParams[0]!;
  assert.equal(p.get("client_id"), "oaiapp_fake123");
  assert.equal(p.get("agent_name_hint"), null, "no name hint on reauthorization");
  assert.equal(p.get("login_hint"), "person@example.com");
  assert.equal(again.id, account.id);
  assert.equal(storage.list.length, 1);
});

test("an answer that does not carry this attempt's state is refused and nothing is saved", async () => {
  const storage = memoryStorage();
  const secrets = createSecretStore();
  const si = await beginSignIn({ storage, secrets, open: async url => {
    const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    back.searchParams.set("state", "forged");
    await fetch(back).then(r => r.text());
  } });
  await assert.rejects(si.done, (e: SiwcError) => e.code === "invalid");
  assert.equal(storage.list.length, 0);
});

test("declining shows as denied", async () => {
  const storage = memoryStorage();
  const si = await beginSignIn({ storage, secrets: createSecretStore(), open: async url => {
    const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location")!);
    back.searchParams.delete("code"); back.searchParams.set("error", "access_denied");
    await fetch(back).then(r => r.text());
  } });
  await assert.rejects(si.done, (e: SiwcError) => e.code === "denied");
});

test("the ID token is checked: signature, audience, nonce", async () => {
  const { account } = await signedIn();
  // Take a real token from the fake, then change what must not be changeable.
  const secrets = createSecretStore();
  const si = await beginSignIn({ storage: memoryStorage(), secrets, open: browser });
  const acc = await si.done;
  const idToken = JSON.parse((await secrets.get(`siwc:${acc.id}`))!).id_token as string;
  const [h, p, s] = idToken.split(".");
  await assert.rejects(validateIdToken(idToken, "someone-else", "x"), (e: SiwcError) => /client|nonce/.test(e.message));
  const forged = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), sub: "attacker" })).toString("base64url")}.${s}`;
  await assert.rejects(validateIdToken(forged, acc.clientId, "x"), (e: SiwcError) => /signature/.test(e.message));
  assert.ok(account.planUsage);
});

test("the access token is renewed shortly before it ends, once for concurrent callers, and the new refresh token replaces the old", async () => {
  const { storage, secrets, account } = await signedIn();
  const deps = { storage, secrets };
  const first = await accessToken(deps, account.id);
  assert.match(first, /^at-/);
  assert.equal(await accessToken(deps, account.id), first, "still fresh: no renewal");
  storage.save({ ...storage.list[0]!, expiresAt: Date.now() + 30_000 });
  fake.tokenCalls.length = 0;
  const [a, b] = await Promise.all([accessToken(deps, account.id), accessToken(deps, account.id)]);
  assert.equal(a, b);
  assert.notEqual(a, first);
  assert.equal(fake.tokenCalls.filter(c => c.grant_type === "refresh_token").length, 1, "one renewal for two callers");
  assert.equal(fake.tokenCalls.find(c => c.grant_type === "refresh_token")!.resource, `${fake.base}/v1`);
  assert.ok(storage.list[0]!.expiresAt > Date.now() + 3000_000);
});

test("when OpenAI refuses a renewal for good, the account says it needs signing in again", async () => {
  const { storage, secrets, account } = await signedIn();
  storage.save({ ...storage.list[0]!, expiresAt: Date.now() + 10_000 });
  fake.failRefresh = true;
  await assert.rejects(accessToken({ storage, secrets }, account.id), (e: SiwcError) => e.code === "signin_required");
  fake.failRefresh = false;
  assert.equal(storage.list[0]!.needsSignIn, true);
});

test("an account without the plan permission cannot be used for inference", async () => {
  const { storage, secrets, account } = await signedIn();
  storage.save({ ...storage.list[0]!, planUsage: false });
  await assert.rejects(accessToken({ storage, secrets }, account.id), (e: SiwcError) => e.code === "not_eligible");
});

test("the model list keeps what is meant for a picker", async () => {
  const { storage, secrets, account } = await signedIn();
  const models = await listModels(await accessToken({ storage, secrets }, account.id));
  assert.deepEqual(models, [{ slug: "gpt-fake", name: "GPT Fake", efforts: ["low", "high", "ultra"] }]);
});

test("signing out revokes the refresh token at OpenAI and forgets the account", async () => {
  const { storage, secrets, account } = await signedIn();
  const refresh = JSON.parse((await secrets.get(`siwc:${account.id}`))!).refresh_token;
  const r = await signOut({ storage, secrets }, account.id);
  assert.equal(r.revoked, true);
  assert.ok(fake.revoked.includes(refresh));
  assert.equal(await secrets.get(`siwc:${account.id}`), undefined);
  assert.equal(storage.list.length, 0);
});
