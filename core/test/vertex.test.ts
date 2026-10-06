import { fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { clearVertexCache, mintAccessToken, parseServiceAccount, vertexBaseUrl } from "../src/vertex.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const SA = { type: "service_account", project_id: "proj-demo", client_email: "es-test@proj-demo.iam.gserviceaccount.com", private_key: privateKey };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => resolve(b)); });
}

// A fake Google: the token endpoint checks the signed assertion; the Vertex endpoint wants the token it issued.
const tokenCalls: Json[] = [];
let tokenRequests = 0;
const chatCalls: Array<{ path: string; authorization?: string; body: Json }> = [];
let issued = 0;
let acceptKey = true;
let redirectToken = false;
const valid = new Set<string>();
let google: Server;
let base: string;

before(async () => {
  process.env.EASYSWITCH_TEST_VERTEX_FIXTURES = "1";
  google = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/token") {
      tokenRequests++;
      if (redirectToken) { res.writeHead(302, { location: `${base}/redirect-must-not-follow` }).end(); return; }
      const form = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
      if (form.grant_type !== "urn:ietf:params:oauth:grant-type:jwt-bearer" || !acceptKey) return send(400, { error: "invalid_grant" });
      const [head, claims, sig] = String(form.assertion).split(".");
      const ok = createVerify("RSA-SHA256").update(`${head}.${claims}`).verify(publicKey, sig!, "base64url");
      const c = JSON.parse(Buffer.from(claims!, "base64url").toString()) as Json;
      tokenCalls.push({ ok, header: JSON.parse(Buffer.from(head!, "base64url").toString()), claims: c });
      if (!ok) return send(400, { error: "invalid_grant", error_description: "bad signature" });
      const token = `ya29.vertex-${++issued}`;
      valid.add(token);
      return send(200, { access_token: token, expires_in: 3600, token_type: "Bearer" });
    }
    if (url.pathname === "/redirect-must-not-follow") throw new Error("token redirect followed");
    if (url.pathname.endsWith("/chat/completions")) {
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      chatCalls.push({ path: url.pathname, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), body: JSON.parse(raw || "{}") });
      if (!valid.has(token)) return send(401, { error: { message: "bad token" } });
      return send(200, { id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Hello from Vertex" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } });
    }
    res.writeHead(404).end();
  });
  await new Promise<void>(r => google.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(google.address() as { port: number }).port}`;
  process.env.EASYSWITCH_VERTEX_TOKEN_URI = `${base}/token`;
  process.env.EASYSWITCH_VERTEX_API = base;
});

after(() => { google.closeAllConnections(); google.close(); delete process.env.EASYSWITCH_VERTEX_TOKEN_URI; delete process.env.EASYSWITCH_VERTEX_API; delete process.env.EASYSWITCH_TEST_VERTEX_FIXTURES; });

test("a service account file is checked, and its token address must be Google's: the signed assertion goes nowhere else", async () => {
  assert.throws(() => parseServiceAccount("not json"), /不是有效的 JSON/);
  assert.throws(() => parseServiceAccount({ private_key: privateKey }), /client_email/);
  assert.throws(() => parseServiceAccount({ client_email: "a@b.c", private_key: "nope" }), /private_key/);
  const saved = process.env.EASYSWITCH_VERTEX_TOKEN_URI;
  delete process.env.EASYSWITCH_VERTEX_TOKEN_URI;
  try {
    await assert.rejects(mintAccessToken("x", parseServiceAccount({ ...SA, token_uri: "https://evil.example.com/token" })), /Google HTTPS/);
    await assert.rejects(mintAccessToken("x", parseServiceAccount({ ...SA, token_uri: "http://oauth2.googleapis.com/token" })), /HTTPS/);
  } finally { process.env.EASYSWITCH_VERTEX_TOKEN_URI = saved; }
  assert.equal(vertexBaseUrl("proj-demo", "us-central1").endsWith("/v1/projects/proj-demo/locations/us-central1/endpoints/openapi"), true);
  delete process.env.EASYSWITCH_VERTEX_API;
  assert.equal(vertexBaseUrl("proj-demo", "global"), "https://aiplatform.googleapis.com/v1/projects/proj-demo/locations/global/endpoints/openapi");
  assert.equal(vertexBaseUrl("proj-demo", "europe-west4"), "https://europe-west4-aiplatform.googleapis.com/v1/projects/proj-demo/locations/europe-west4/endpoints/openapi");
  process.env.EASYSWITCH_VERTEX_API = base;
});

let server: Server;
let port: number;
let store: Store;
const dir = mkdtempSync(join(tmpdir(), "es-vertex-"));
const secrets = createSecretStore();
let secretWrites = 0;
const saveSecret = secrets.set.bind(secrets);
secrets.set = async (key, value) => { secretWrites++; await saveSecret(key, value); };
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });

test("adding a Vertex project mints a token to prove the key works, keeps the key in the secret store only, and makes an ordinary source", async () => {
  port = await new Promise<number>(resolve => { const p = createServer().listen(0, "127.0.0.1", () => { const n = (p.address() as { port: number }).port; p.close(() => resolve(n)); }); });
  store = new Store(join(dir, "store"));
  server = createEasySwitchServer({ store, secrets, port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));

  const writesBeforeRefusal = secretWrites;
  acceptKey = false;
  try {
    const refused = await api("POST", "/api/vertex", { project: "proj-demo", location: "us-central1", serviceAccount: JSON.stringify(SA) });
    assert.equal(refused.status, 409);
    const refusal = await refused.json() as Json;
    assert.equal(refusal.uiError.code, "source_auth_required");
    assert.equal(refusal.error, refusal.uiError.message, "the legacy error field also uses safe user-facing wording");
    assert.equal(secretWrites, writesBeforeRefusal, "a rejected key is never persisted");
    assert.equal(store.providers().length, 0, "nothing is kept when the key does not work");
    assert.equal((await api("POST", "/api/vertex", { project: "Bad Project", serviceAccount: JSON.stringify(SA) })).status, 400);
    assert.equal((await api("POST", "/api/vertex", { project: "proj-demo", location: "mars", serviceAccount: JSON.stringify(SA) })).status, 400);
    const callsBeforeInvalid = tokenRequests;
    const writesBeforeInvalid = secretWrites;
    for (const invalid of [{ project: "proj-demo-", location: "global" }, { project: "proj-demo", location: "us-central123" }]) {
      assert.equal((await api("POST", "/api/vertex", { ...invalid, serviceAccount: JSON.stringify(SA) })).status, 400);
    }
    assert.equal(tokenRequests, callsBeforeInvalid, "strict routing validation must precede any token exchange");
    assert.equal(secretWrites, writesBeforeInvalid, "invalid routing cannot leave an orphaned service-account secret");
    assert.equal(store.providers().length, 0);
  } finally { acceptKey = true; }

  const made = await api("POST", "/api/vertex", { project: "proj-demo", location: "us-central1", serviceAccount: JSON.stringify(SA) });
  assert.equal(made.status, 200, await made.clone().text());
  const info = (await made.json()) as Json;
  const provider = store.provider(info.id)!;
  const vertex = provider.vertex;
  assert.ok(vertex && "clientEmail" in vertex);
  assert.equal(vertex.project, "proj-demo");
  assert.equal(vertex.clientEmail, SA.client_email);
  assert.deepEqual(provider.models, ["google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.0-flash-001"]);
  // The assertion was signed with the key, for Google's token endpoint, for the cloud-platform scope.
  const call = tokenCalls.at(-1)!;
  assert.equal(call.ok, true);
  assert.deepEqual(call.header, { alg: "RS256", typ: "JWT" });
  assert.equal(call.claims.iss, SA.client_email);
  assert.equal(call.claims.scope, "https://www.googleapis.com/auth/cloud-platform");
  assert.equal(call.claims.aud, `${base}/token`);
  assert.ok(call.claims.exp - call.claims.iat === 3600);
  // The private key is in the secret store and nowhere else.
  assert.match((await secrets.get(`vertex:${info.id}`))!, /BEGIN PRIVATE KEY/);
  const files = readdirSync(join(dir, "store"), { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => readFileSync(join(f.parentPath, f.name), "utf8")).join("\n");
  assert.ok(!files.includes("PRIVATE KEY"), "no key on disk");
  const visibleState = await (await api("GET", "/api/state")).json() as Json;
  const visibleProvider = visibleState.providers.find((p: Json) => p.id === provider.id);
  assert.equal(visibleProvider.hasKey, true, "service-account key presence uses its own secret namespace");
  assert.deepEqual(visibleProvider.supportedProtocols, ["chat"]);
  const shown = JSON.stringify(visibleState) + JSON.stringify(provider);
  assert.ok(!shown.includes("PRIVATE KEY") && !shown.includes("ya29."), "no key and no token in what the console is shown");
});

test("an agent's request goes to Vertex's address with the minted token, the token is reused while it lasts and minted again after it ends", async () => {
  const id = store.providers()[0]!.id;
  const ask = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken("aider")}` },
    body: JSON.stringify({ model: `${id}/google/gemini-2.5-flash`, messages: [{ role: "user", content: "hi" }] }),
  });
  const saved = store.provider(id)!;
  saved.baseUrl = "https://must-not-contact.invalid/v1";
  saved.anthropicBaseUrl = "https://must-not-contact.invalid/messages";
  saved.wire = { authHeader: "x-leak", authScheme: "raw", query: { key: "must-not-appear" }, paths: { chat: "wrong-path" } };
  store.upsertProvider(saved);
  const mintedBefore = tokenCalls.length;
  const res = await ask();
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as Json).choices[0].message.content, "Hello from Vertex");
  const call = chatCalls.at(-1)!;
  assert.equal(call.path, "/v1/projects/proj-demo/locations/us-central1/endpoints/openapi/chat/completions", "persisted base/wire overrides cannot reroute the minted capability");
  assert.match(call.authorization!, /^Bearer ya29\.vertex-\d+$/);
  assert.equal(call.body.model, "google/gemini-2.5-flash", "the model name Vertex knows");
  assert.equal(tokenCalls.length, mintedBefore, "the token minted when the project was added is reused");
  clearVertexCache();
  assert.equal((await ask()).status, 200);
  assert.equal(tokenCalls.length, mintedBefore + 1, "a new token once the old one is gone");
});

test("concurrent same-name service-account additions reserve separate source IDs", async () => {
  const replies = await Promise.all([1, 2].map(() => api("POST", "/api/vertex", { name: "Concurrent Vertex", project: "proj-demo", location: "global", serviceAccount: JSON.stringify(SA) })));
  for (const reply of replies) assert.equal(reply.status, 200, await reply.clone().text());
  const ids = await Promise.all(replies.map(async reply => (await reply.json() as Json).id as string));
  assert.equal(new Set(ids).size, 2, "an in-flight addition reserves its provider id before token I/O");
  for (const id of ids) {
    assert.ok(store.provider(id)); assert.ok(await secrets.get(`vertex:${id}`));
    assert.equal((await api("DELETE", `/api/providers/${id}`)).status, 200);
    assert.equal(await secrets.get(`vertex:${id}`), undefined);
  }
});

test("service-account setup failures remove partially stored keys, sources and cached tokens", async () => {
  for (const failure of ["secret", "source"] as const) {
    const savedSet = secrets.set.bind(secrets);
    const savedUpsert = store.upsertProvider.bind(store);
    let writtenKey = "";
    secrets.set = async (key, value) => {
      writtenKey = key;
      await savedSet(key, value);
      if (failure === "secret") throw new Error("fixture secret-store failure after write");
    };
    store.upsertProvider = provider => {
      savedUpsert(provider);
      if (failure === "source") throw new Error("fixture state-store failure after write");
    };
    try {
      const reply = await api("POST", "/api/vertex", { name: `fixture-rollback-${failure}`, project: "proj-demo", location: "global", serviceAccount: JSON.stringify(SA) });
      assert.ok(reply.status >= 400);
    } finally { secrets.set = savedSet; store.upsertProvider = savedUpsert; }
    assert.match(writtenKey, /^vertex:/);
    const id = writtenKey.slice("vertex:".length);
    assert.equal(await secrets.get(writtenKey), undefined, "a write that failed after storage must be rolled back");
    assert.equal(store.provider(id), undefined);
    acceptKey = false;
    const count = tokenRequests;
    try { await assert.rejects(mintAccessToken(id, SA), /没有接受这个服务账号/); }
    finally { acceptKey = true; }
    assert.equal(tokenRequests, count + 1, "cleanup removes the token minted before setup failed");
  }
});

test("removing the source forgets the key", async () => {
  const id = store.providers()[0]!.id;
  assert.equal((await api("DELETE", `/api/providers/${id}`)).status, 200);
  assert.equal(await secrets.get(`vertex:${id}`), undefined);
  server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true });
});


test("service-account parsing rejects malformed shapes without disclosing credential text", () => {
  for (const value of [null, [], 1, true, { ...SA, type: "authorized_user" }, { ...SA, token_uri: 123 }]) assert.throws(() => parseServiceAccount(value as never));
  for (const [project, location] of [["p/../x", "global"], ["proj-demo", "global.evil.test"], ["proj-demo", "us-central1/evil"]]) assert.throws(() => vertexBaseUrl(project!, location!));
});

test("Vertex fixture overrides cannot redirect credentials to real or arbitrary destinations", async () => {
  const token = process.env.EASYSWITCH_VERTEX_TOKEN_URI;
  const api = process.env.EASYSWITCH_VERTEX_API;
  try {
    process.env.EASYSWITCH_VERTEX_TOKEN_URI = "https://evil.example/token";
    await assert.rejects(mintAccessToken("override", SA), /环回/);
    process.env.EASYSWITCH_VERTEX_TOKEN_URI = token;
    delete process.env.EASYSWITCH_TEST_VERTEX_FIXTURES;
    await assert.rejects(mintAccessToken("override", SA), /环回/);
    process.env.EASYSWITCH_TEST_VERTEX_FIXTURES = "1";
    process.env.EASYSWITCH_VERTEX_API = "https://evil.example";
    assert.throws(() => vertexBaseUrl("proj-demo", "global"), /环回/);
    process.env.EASYSWITCH_VERTEX_API = `${base}/wrong/path`;
    assert.throws(() => vertexBaseUrl("proj-demo", "global"), /环回/);
  } finally { process.env.EASYSWITCH_VERTEX_TOKEN_URI = token; process.env.EASYSWITCH_VERTEX_API = api; process.env.EASYSWITCH_TEST_VERTEX_FIXTURES = "1"; }
});

test("cached tokens stay bound to the service-account identity and audience is validated before reuse", async () => {
  clearVertexCache();
  const count = tokenCalls.length;
  const first = await mintAccessToken("identity-test", SA);
  assert.equal(await mintAccessToken("identity-test", SA), first);
  assert.equal(tokenCalls.length, count + 1);
  const second = await mintAccessToken("identity-test", { ...SA, client_email: "another@proj-demo.iam.gserviceaccount.com" });
  assert.notEqual(first, second);
  assert.equal(tokenCalls.length, count + 2);
  await assert.rejects(mintAccessToken("identity-test", { ...SA, token_uri: "https://not-token.googleapis.com/token" }), /Google HTTPS/);
  assert.equal(tokenCalls.length, count + 2, "a cached key cannot skip destination checks");
});

test("concurrent token requests share one exchange and token redirects fail", async () => {
  clearVertexCache();
  const count = tokenCalls.length;
  const tokens = await Promise.all(Array.from({ length: 5 }, () => mintAccessToken("concurrent-test", SA)));
  assert.equal(new Set(tokens).size, 1);
  assert.equal(tokenCalls.length, count + 1);
  clearVertexCache(); redirectToken = true;
  try { await assert.rejects(mintAccessToken("redirect-test", SA), /重定向/); }
  finally { redirectToken = false; }
});
