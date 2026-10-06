import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { antigravityClientCredentials, antigravityEndpoints, AntigravityClientError } from "../src/antigravity-client.ts";
import { antigravityAccessToken, beginAntigravitySignIn, clearAntigravityCache, discoverProject, listAntigravityModels, forgetAntigravityAccount } from "../src/antigravity.ts";

const fake = { version: 1, clientId: "fixture-client-id", clientSecret: "fixture-private-client-value" };
const envFor = (path: string) => ({ EASYSWITCH_ANTIGRAVITY_CLIENT_CONFIG: path });

test("client credentials are explicit, lazy, bounded and never reflected in errors", () => {
  let reads = 0;
  const read = () => { reads++; return JSON.stringify(fake); };
  assert.throws(() => antigravityClientCredentials({ env: {}, read }), AntigravityClientError);
  assert.throws(() => antigravityClientCredentials({ env: envFor("relative.json"), read }), AntigravityClientError);
  assert.equal(reads, 0);
  const client = antigravityClientCredentials({ env: envFor("/fixture/client.json"), read });
  assert.deepEqual(client, { clientId: fake.clientId, clientSecret: fake.clientSecret });
  assert.equal(Object.isFrozen(client), true);
  for (const value of [null, [], { ...fake, endpoint: "https://attacker.invalid" }, { ...fake, clientSecret: "" }, { ...fake, clientId: "bad\nidentity" }, { ...fake, version: 2 }]) {
    assert.throws(() => antigravityClientCredentials({ env: envFor("/fixture/sensitive-path"), read: () => JSON.stringify(value) }), error => {
      assert.ok(error instanceof AntigravityClientError);
      assert.ok(!error.message.includes("sensitive-path") && !error.message.includes(fake.clientSecret));
      return true;
    });
  }
  assert.throws(() => antigravityClientCredentials({ env: envFor("/fixture/client.json"), read: () => "x".repeat(17000) }), AntigravityClientError);
});

test("runtime file must be a small private regular file, never a symlink or a directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-ag-client-"));
  try {
    const file = join(dir, "client.json");
    writeFileSync(file, JSON.stringify(fake), { mode: 0o600 });
    assert.equal(antigravityClientCredentials({ env: envFor(file) }).clientId, fake.clientId);
    const link = join(dir, "link.json"); symlinkSync(file, link);
    for (const path of [link, dir, join(dir, "missing")]) assert.throws(() => antigravityClientCredentials({ env: envFor(path) }), AntigravityClientError);
    chmodSync(file, 0o644);
    assert.throws(() => antigravityClientCredentials({ env: envFor(file) }), AntigravityClientError);
    chmodSync(file, 0o600); writeFileSync(file, "x".repeat(17000));
    assert.throws(() => antigravityClientCredentials({ env: envFor(file) }), AntigravityClientError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("destinations stay fixed Google HTTPS; only explicit test-loopback overrides are accepted", () => {
  const urls = antigravityEndpoints({});
  assert.equal(urls.token, "https://oauth2.googleapis.com/token");
  assert.equal(urls.auth, "https://accounts.google.com/o/oauth2/v2/auth");
  for (const url of Object.values(urls)) assert.equal(new URL(url).protocol, "https:");
  assert.throws(() => antigravityEndpoints({ EASYSWITCH_ANTIGRAVITY_TOKEN: "http://127.0.0.1:123/token" }), AntigravityClientError);
  for (const bad of ["https://attacker.invalid/token", "http://localhost:123/token", "http://127.0.0.1.evil.invalid/token", "http://name:secret@127.0.0.1:123/token", "http://127.0.0.1:123/token?key=x"]) {
    assert.throws(() => antigravityEndpoints({ EASYSWITCH_TEST_ANTIGRAVITY_FIXTURES: "1", EASYSWITCH_ANTIGRAVITY_TOKEN: bad }), AntigravityClientError);
  }
  assert.equal(antigravityEndpoints({ EASYSWITCH_TEST_ANTIGRAVITY_FIXTURES: "1", EASYSWITCH_ANTIGRAVITY_API: "http://127.0.0.1:123" }).onboardApi, "http://127.0.0.1:123");
});

test("missing configuration rejects before browser, token lookup, network or callback listener creation", async () => {
  const old = process.env.EASYSWITCH_ANTIGRAVITY_CLIENT_CONFIG;
  delete process.env.EASYSWITCH_ANTIGRAVITY_CLIENT_CONFIG;
  let secretReads = 0, opens = 0;
  const secrets = { get: async () => { secretReads++; return "fixture-refresh"; }, set: async () => {}, delete: async () => {} };
  try {
    await assert.rejects(beginAntigravitySignIn({ secrets, open: async () => { opens++; } }), AntigravityClientError);
    await assert.rejects(antigravityAccessToken(secrets, "fixture-account"), AntigravityClientError);
    assert.equal(secretReads, 0); assert.equal(opens, 0);
  } finally { if (old !== undefined) process.env.EASYSWITCH_ANTIGRAVITY_CLIENT_CONFIG = old; }
});

test("client changes invalidate token cache; removed config cannot use an existing cached token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-ag-rotation-"));
  let calls = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    assert.ok(body.includes("grant_type=refresh_token")); calls++;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `fixture-access-${calls}`, expires_in: 3600 }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  const file = join(dir, "client.json");
  try {
    writeFileSync(file, JSON.stringify(fake), { mode: 0o600 });
    Object.assign(process.env, envFor(file), { EASYSWITCH_TEST_ANTIGRAVITY_FIXTURES: "1", EASYSWITCH_ANTIGRAVITY_TOKEN: `http://127.0.0.1:${(server.address() as { port: number }).port}/token` });
    const secrets = { get: async () => "fixture-refresh", set: async () => {}, delete: async () => {} };
    assert.equal(await antigravityAccessToken(secrets, "rotation"), "fixture-access-1");
    assert.equal(await antigravityAccessToken(secrets, "rotation"), "fixture-access-1");
    writeFileSync(file, JSON.stringify({ ...fake, clientSecret: "fixture-replaced" }));
    assert.equal(await antigravityAccessToken(secrets, "rotation"), "fixture-access-2");
    delete process.env.EASYSWITCH_ANTIGRAVITY_CLIENT_CONFIG;
    await assert.rejects(antigravityAccessToken(secrets, "rotation"), AntigravityClientError);
    assert.equal(calls, 2);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); clearAntigravityCache(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true });
  }
});

test("token, userinfo and API redirects never receive credentials on their second hop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-ag-redirect-"));
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; redirect?: RequestRedirect }> = [];
  globalThis.fetch = (input, init) => { requests.push({ url: String(input), redirect: init?.redirect }); return originalFetch(input, init); };
  let escaped = 0, mode = "token";
  const sink = createServer((_req, res) => { escaped++; res.end("unexpected"); });
  await new Promise<void>(r => sink.listen(0, "127.0.0.1", r));
  const destination = `http://127.0.0.1:${(sink.address() as { port: number }).port}/escaped`;
  const source = createServer((req, res) => {
    if (mode === "userinfo" && req.url === "/token") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 }));
    res.writeHead(302, { location: destination }).end();
  });
  await new Promise<void>(r => source.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
  const saved = { ...process.env };
  const file = join(dir, "client.json");
  try {
    writeFileSync(file, JSON.stringify(fake), { mode: 0o600 });
    Object.assign(process.env, envFor(file), { EASYSWITCH_TEST_ANTIGRAVITY_FIXTURES: "1", EASYSWITCH_ANTIGRAVITY_TOKEN: `${base}/token`, EASYSWITCH_ANTIGRAVITY_AUTH: `${base}/auth`, EASYSWITCH_ANTIGRAVITY_USERINFO: `${base}/userinfo`, EASYSWITCH_ANTIGRAVITY_API: base, EASYSWITCH_ANTIGRAVITY_POLL_MS: "1" });
    const secrets = { get: async () => "fixture-refresh", set: async () => {}, delete: async () => {} };
    await assert.rejects(antigravityAccessToken(secrets, "redirect"));
    await assert.rejects(listAntigravityModels("fixture-access"));
    assert.equal(await discoverProject("fixture-access"), undefined);
    mode = "userinfo";
    const login = await beginAntigravitySignIn({ secrets, open: async url => {
      const args = new URL(url).searchParams;
      await fetch(`${args.get("redirect_uri")}?state=${args.get("state")}&code=fixture-code`, { redirect: "error" });
    } });
    await assert.rejects(login.done);
    assert.equal(escaped, 0);
    assert.ok(requests.filter(r => r.url.startsWith(base)).length >= 5);
    assert.ok(requests.filter(r => r.url.startsWith(base)).every(r => r.redirect === "error"), "source sets redirect:error before the test guard sees RequestInit");
    assert.ok(!readFileSync(file, "utf8").includes("fixture-access"));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); clearAntigravityCache();
    globalThis.fetch = originalFetch;
    source.closeAllConnections(); sink.closeAllConnections(); await Promise.all([new Promise<void>(r => source.close(() => r())), new Promise<void>(r => sink.close(() => r()))]); rmSync(dir, { recursive: true, force: true });
  }
});

import { startFakeGoogle, authorizeUrl } from "./fake-google.ts";
import type { SecretStore } from "../src/secrets.ts";
async function loginFixture(run: (google: Awaited<ReturnType<typeof startFakeGoogle>>, secrets: SecretStore) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "es-ag-cancel-"));
  const google = await startFakeGoogle();
  const saved = { ...process.env };
  const values = new Map<string, string>();
  const secrets: SecretStore = { get: async key => values.get(key), set: async (key, value) => { values.set(key, value); }, delete: async key => { values.delete(key); } };
  try {
    const file = join(dir, "client.json"); writeFileSync(file, JSON.stringify(fake), { mode: 0o600 });
    Object.assign(process.env, envFor(file), { EASYSWITCH_TEST_ANTIGRAVITY_FIXTURES: "1", EASYSWITCH_ANTIGRAVITY_TOKEN: `${google.base}/token`, EASYSWITCH_ANTIGRAVITY_AUTH: `${google.base}/auth`, EASYSWITCH_ANTIGRAVITY_USERINFO: `${google.base}/userinfo`, EASYSWITCH_ANTIGRAVITY_API: google.base });
    await run(google, secrets);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); clearAntigravityCache(); google.close(); rmSync(dir, { recursive: true, force: true });
  }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

test("cancel and timeout abort pending discovery before any credential write", async () => {
  for (const cancel of [true, false]) await loginFixture(async (google, secrets) => {
    const gate = deferred(), entered = deferred(); let writes = 0;
    const original = google.server.listeners("request")[0] as (...args: any[]) => unknown;
    google.server.removeAllListeners("request");
    google.server.on("request", async (req, res) => { if (req.url?.includes(":loadCodeAssist")) { entered.resolve(); await gate.promise; } original(req, res); });
    const signin = await beginAntigravitySignIn({ secrets: { ...secrets, set: async (key, value) => { writes++; await secrets.set(key, value); } }, open: async () => {}, timeoutMs: cancel ? 1000 : 100 });
    const response = fetch(authorizeUrl(google, signin.url), { redirect: "error" }).catch(() => undefined);
    await entered.promise;
    if (cancel) signin.cancel();
    await assert.rejects(signin.done);
    gate.resolve(); await response; await new Promise(r => setTimeout(r, 20));
    assert.equal(writes, 0);
  });
});

test("one login accepts only one callback while its token request is in progress", async () => loginFixture(async (google, secrets) => {
  const gate = deferred(), entered = deferred(); let writes = 0;
  const original = google.server.listeners("request")[0] as (...args: any[]) => unknown;
  google.server.removeAllListeners("request");
  google.server.on("request", async (req, res) => { if (req.url === "/token") { entered.resolve(); await gate.promise; } original(req, res); });
  const signin = await beginAntigravitySignIn({ secrets: { ...secrets, set: async (key, value) => { writes++; await secrets.set(key, value); } }, open: async () => {} });
  const callback = authorizeUrl(google, signin.url);
  const first = fetch(callback, { redirect: "error" });
  await entered.promise;
  assert.equal((await fetch(callback, { redirect: "error" })).status, 409);
  gate.resolve(); await first; await signin.done;
  assert.equal(writes, 1); assert.equal(google.tokenCalls.length, 1);
}));

test("cancellation during a credential write waits for rollback and cannot erase a later login", async () => loginFixture(async (google, secrets) => {
  const gate = deferred(), entered = deferred(); let firstWrite = true;
  const key = "antigravity:person-example-com";
  await secrets.set(key, "fixture-previous-refresh");
  const held: SecretStore = { ...secrets, set: async (id, value) => { if (firstWrite) { firstWrite = false; entered.resolve(); await gate.promise; } await secrets.set(id, value); } };
  const first = await beginAntigravitySignIn({ secrets: held, open: async () => {} });
  const response = fetch(authorizeUrl(google, first.url), { redirect: "error" }).catch(() => undefined);
  await entered.promise; first.cancel();
  let settled = false; first.done.catch(() => { settled = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(settled, false, "do not report cancellation before restoring a started write");
  const second = await beginAntigravitySignIn({ secrets, open: async () => {} });
  const next = fetch(authorizeUrl(google, second.url), { redirect: "error" });
  gate.resolve(); await assert.rejects(first.done); await response;
  await next; await second.done;
  assert.equal(await secrets.get(key), "1//fake-refresh", "the later login wins after serialized rollback");
}));


test("deleting an account prevents a pending refresh from repopulating its access-token cache", async () => loginFixture(async (google, secrets) => {
  const gate = deferred(), entered = deferred();
  const original = google.server.listeners("request")[0] as (...args: any[]) => unknown;
  google.server.removeAllListeners("request");
  google.server.on("request", async (req, res) => { if (req.url === "/token") { entered.resolve(); await gate.promise; } original(req, res); });
  await secrets.set("antigravity:removed", "1//fake-refresh");
  const refreshing = antigravityAccessToken(secrets, "removed");
  await entered.promise; await forgetAntigravityAccount(secrets, "removed"); gate.resolve();
  await assert.rejects(refreshing, /登录已变更/);
  await assert.rejects(antigravityAccessToken(secrets, "removed"), /登录信息不见了/);
  assert.equal(google.tokenCalls.length, 1);
}));
