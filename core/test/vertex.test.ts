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
const chatCalls: Array<{ path: string; authorization?: string; body: Json }> = [];
let issued = 0;
let acceptKey = true;
const valid = new Set<string>();
let google: Server;
let base: string;

before(async () => {
  google = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", "http://x");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/token") {
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

after(() => { google.closeAllConnections(); google.close(); delete process.env.EASYSWITCH_VERTEX_TOKEN_URI; delete process.env.EASYSWITCH_VERTEX_API; });

test("a service account file is checked, and its token address must be Google's: the signed assertion goes nowhere else", async () => {
  assert.throws(() => parseServiceAccount("not json"), /不是有效的 JSON/);
  assert.throws(() => parseServiceAccount({ private_key: privateKey }), /client_email/);
  assert.throws(() => parseServiceAccount({ client_email: "a@b.c", private_key: "nope" }), /private_key/);
  const saved = process.env.EASYSWITCH_VERTEX_TOKEN_URI;
  delete process.env.EASYSWITCH_VERTEX_TOKEN_URI;
  try {
    await assert.rejects(mintAccessToken("x", parseServiceAccount({ ...SA, token_uri: "https://evil.example.com/token" })), /不是 Google 的地址/);
    await assert.rejects(mintAccessToken("x", parseServiceAccount({ ...SA, token_uri: "http://oauth2.googleapis.com/token" })), /https/);
  } finally { process.env.EASYSWITCH_VERTEX_TOKEN_URI = saved; }
  assert.equal(vertexBaseUrl("p", "us-central1").endsWith("/v1/projects/p/locations/us-central1/endpoints/openapi"), true);
  delete process.env.EASYSWITCH_VERTEX_API;
  assert.equal(vertexBaseUrl("p", "global"), "https://aiplatform.googleapis.com/v1/projects/p/locations/global/endpoints/openapi");
  assert.equal(vertexBaseUrl("p", "europe-west4"), "https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/endpoints/openapi");
  process.env.EASYSWITCH_VERTEX_API = base;
});

let server: Server;
let port: number;
let store: Store;
const dir = mkdtempSync(join(tmpdir(), "es-vertex-"));
const secrets = createSecretStore();
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });

test("adding a Vertex project mints a token to prove the key works, keeps the key in the secret store only, and makes an ordinary source", async () => {
  port = await new Promise<number>(resolve => { const p = createServer().listen(0, "127.0.0.1", () => { const n = (p.address() as { port: number }).port; p.close(() => resolve(n)); }); });
  store = new Store(join(dir, "store"));
  server = createEasySwitchServer({ store, secrets, port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));

  acceptKey = false;
  const refused = await api("POST", "/api/vertex", { project: "proj-demo", location: "us-central1", serviceAccount: JSON.stringify(SA) });
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as Json).error, /没有接受这个服务账号/);
  assert.equal(store.providers().length, 0, "nothing is kept when the key does not work");
  assert.equal((await api("POST", "/api/vertex", { project: "Bad Project", serviceAccount: JSON.stringify(SA) })).status, 400);
  assert.equal((await api("POST", "/api/vertex", { project: "proj-demo", location: "mars", serviceAccount: JSON.stringify(SA) })).status, 400);

  acceptKey = true;
  const made = await api("POST", "/api/vertex", { project: "proj-demo", location: "us-central1", serviceAccount: JSON.stringify(SA) });
  assert.equal(made.status, 200, await made.clone().text());
  const info = (await made.json()) as Json;
  const provider = store.provider(info.id)!;
  assert.equal(provider.vertex!.project, "proj-demo");
  assert.equal(provider.vertex!.clientEmail, SA.client_email);
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
  const files = readdirSync(join(dir, "store")).map(f => readFileSync(join(dir, "store", f), "utf8")).join("\n");
  assert.ok(!files.includes("PRIVATE KEY"), "no key on disk");
  const shown = (await (await api("GET", "/api/state")).text()) + JSON.stringify(provider);
  assert.ok(!shown.includes("PRIVATE KEY") && !shown.includes("ya29."), "no key and no token in what the console is shown");
});

test("an agent's request goes to Vertex's address with the minted token, the token is reused while it lasts and minted again after it ends", async () => {
  const id = store.providers()[0]!.id;
  const ask = () => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer es-session-aider-x" },
    body: JSON.stringify({ model: `${id}/google/gemini-2.5-flash`, messages: [{ role: "user", content: "hi" }] }),
  });
  const mintedBefore = tokenCalls.length;
  const res = await ask();
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as Json).choices[0].message.content, "Hello from Vertex");
  const call = chatCalls.at(-1)!;
  assert.equal(call.path, "/v1/projects/proj-demo/locations/us-central1/endpoints/openapi/chat/completions");
  assert.match(call.authorization!, /^Bearer ya29\.vertex-\d+$/);
  assert.equal(call.body.model, "google/gemini-2.5-flash", "the model name Vertex knows");
  assert.equal(tokenCalls.length, mintedBefore, "the token minted when the project was added is reused");
  clearVertexCache();
  assert.equal((await ask()).status, 200);
  assert.equal(tokenCalls.length, mintedBefore + 1, "a new token once the old one is gone");
});

test("removing the source forgets the key", async () => {
  const id = store.providers()[0]!.id;
  assert.equal((await api("DELETE", `/api/providers/${id}`)).status, 200);
  assert.equal(await secrets.get(`vertex:${id}`), undefined);
  server.closeAllConnections(); server.close(); rmSync(dir, { recursive: true, force: true });
});
