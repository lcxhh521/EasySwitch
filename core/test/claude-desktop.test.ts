import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ClaudeDesktopSession, claudeDesktopEnvironment, findClaudeDesktopExecutable, prepareClaudeDesktopSession, prepareClaudeDesktopFixtureSession } from "../src/claude-desktop.ts";
import { createEasySwitchServer, stopClaudeDesktopSessions } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { sessionToken } from "../src/gateway-chat.ts";
import { GatewayTokenAuthority, gatewayTokens } from "../src/gateway-auth.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Desktop tests permit only the explicit local mock servers");
  return realFetch(input, { ...init, redirect: "error" });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

// ONLY these local fixtures are spawned. No installed agent, vendor app, model,
// credential, or network host is used, even if one is installed on the machine.
function fixture(source: string): { dir: string; executable: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), "es-desktop-fixture-"));
  const script = join(dir, "mock.mjs");
  writeFileSync(script, source);
  const executable = join(dir, "claude-desktop");
  writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o700 });
  return { dir, executable, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

const models = [{ id: "es-claude-mock--echo", label: "Mock echo" }];
const options = { executable: "/test/Claude", port: 18766, models, platform: "linux" as const, parentEnv: {} };
function credential(session: ClaudeDesktopSession): { authorization: string } {
  const profile = JSON.parse(readFileSync(join(String(session.spec.env.CLAUDE_USER_DATA_DIR), "configLibrary", `${session.id}.json`), "utf8"));
  return { authorization: `Bearer ${profile.inferenceGatewayApiKey}` };
}
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), "mock fixture did not become ready");
}

function files(root: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("desktop preparation has private HOME/config/cache/state/runtime/temp/logs and no inherited credentials", () => {
  const parent = {
    HOME: "/native/home", ANTHROPIC_API_KEY: "native-secret", CLAUDE_CODE_OAUTH_TOKEN: "native-oauth",
    CLAUDE_USER_DATA_DIR: "/native/claude", CLAUDE_CONFIG_DIR: "/native/cli", NODE_OPTIONS: "--require /native/hook",
    ELECTRON_RUN_AS_NODE: "1", HTTPS_PROXY: "https://native-proxy", DBUS_SESSION_BUS_ADDRESS: "native-bus",
    CODEX_HOME: "/native/codex", DISPLAY: ":11", WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: "/native/runtime",
  };
  const session = prepareClaudeDesktopSession({ ...options, parentEnv: parent });
  try {
    assert.equal(session.status().verified, false);
    assert.equal(session.status().state, "prepared");
    assert.equal(statSync(session.directory).mode & 0o777, 0o700);
    for (const key of ["HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "TMPDIR", "CLAUDE_CONFIG_DIR", "CLAUDE_USER_DATA_DIR"]) {
      assert.ok(session.spec.env[key]!.startsWith(session.directory + "/"), key);
      assert.equal(statSync(session.spec.env[key]!).mode & 0o777, 0o700);
    }
    for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "HTTPS_PROXY", "DBUS_SESSION_BUS_ADDRESS", "CODEX_HOME", "WAYLAND_DISPLAY"]) assert.equal(session.spec.env[key], undefined, key);
    assert.equal(session.spec.env.DISPLAY, ":11");
    assert.equal(session.spec.env.XDG_SESSION_TYPE, "x11");
    assert.equal(session.spec.command, "/test/Claude");
    assert.ok(!JSON.stringify(session.spec).includes("native-secret"));
    assert.ok(!JSON.stringify(session.status()).includes("es-session-"));
    const privateFiles = files(session.directory);
    assert.equal(privateFiles.length, 6);
    for (const path of privateFiles) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      const text = readFileSync(path, "utf8");
      assert.doesNotThrow(() => JSON.parse(text));
      assert.ok(!text.includes("/native/"));
    }
    const root = String(session.spec.env.CLAUDE_USER_DATA_DIR);
    const meta = JSON.parse(readFileSync(join(root, "configLibrary/_meta.json"), "utf8"));
    const profile = JSON.parse(readFileSync(join(root, "configLibrary", `${meta.appliedId}.json`), "utf8"));
    assert.equal(profile.inferenceProvider, "gateway");
    assert.equal(profile.inferenceCredentialKind, "static");
    assert.equal(profile.inferenceGatewayBaseUrl, "http://127.0.0.1:18766");
    assert.match(profile.inferenceGatewayApiKey, /^es-session-claude-desktop-/);
    assert.equal(profile.inferenceGatewayAuthScheme, "bearer");
    assert.equal(profile.modelDiscoveryEnabled, false);
    assert.deepEqual(profile.inferenceModels, [{ name: models[0]!.id, labelOverride: "Mock echo" }]);
    assert.equal(profile.disableDeepLinkRegistration, true);
    assert.equal(profile.disableEssentialTelemetry, true);
    assert.equal(profile.disableNonessentialTelemetry, true);
    assert.equal(profile.disableNonessentialServices, true);
    assert.equal(profile.disableAutoUpdates, true);
    assert.ok(!JSON.stringify(profile).includes("mcpServers"));
  } finally { session.cleanup(); }
  assert.equal(existsSync(session.directory), false);
  session.cleanup();
});

test("macOS bootstrap, app data, logs and caches remain under the private HOME", () => {
  const session = prepareClaudeDesktopSession({ ...options, platform: "darwin" });
  try {
    const home = String(session.spec.env.HOME);
    assert.ok(existsSync(join(home, "Library/Application Support/Claude-3p/configLibrary/_meta.json")));
    assert.ok(existsSync(join(home, "Library/Logs")));
    assert.ok(existsSync(join(home, "Library/Caches")));
    assert.ok(session.spec.args.every(arg => !arg.includes("/Applications")));
  } finally { session.cleanup(); }
});

test("invalid inputs and unsupported platforms fail before creating a session", () => {
  assert.throws(() => prepareClaudeDesktopSession({ ...options, platform: "win32" }), /目前只实现/);
  assert.throws(() => prepareClaudeDesktopSession({ ...options, executable: "claude-desktop" }), /绝对路径/);
  assert.throws(() => prepareClaudeDesktopSession({ ...options, executable: "/Applications/Claude.app" }), /绝对路径/);
  assert.throws(() => prepareClaudeDesktopSession({ ...options, port: 0 }), /端口/);
  assert.throws(() => prepareClaudeDesktopSession({ ...options, models: [] }), /模型/);
  assert.equal(claudeDesktopEnvironment("/private/session", "linux", { WAYLAND_DISPLAY: "wayland-0" }).WAYLAND_DISPLAY, undefined);
});

test("production session startup is blocked before spawn even with an existing executable", async t => {
  const auth = new GatewayTokenAuthority();
  const session = prepareClaudeDesktopSession({ ...options, executable: process.execPath, gatewayAuth: auth });
  const headers = credential(session);
  const kill = t.mock.method(process, "kill", () => { throw new Error("production launch must not create or signal a process"); });
  try {
    await assert.rejects(session.start(), /签名版.*忽略 CLAUDE_USER_DATA_DIR/);
    assert.equal(session.status().state, "failed");
    assert.equal(session.status().pid, undefined);
    assert.equal(session.status().cleaned, true);
    assert.equal(kill.mock.callCount(), 0);
    assert.equal(auth.authenticate(headers), undefined);
    assert.equal(auth.list().length, 0);
  } finally { kill.mock.restore(); session.cleanup(); }
});

test("desktop cleanup revokes only its own capability in injected and default authorities", () => {
  for (const auth of [new GatewayTokenAuthority(), gatewayTokens]) {
    const peer = auth.issue("claude");
    const before = auth.list().map(s => s.id).sort();
    const session = prepareClaudeDesktopSession({ ...options, ...(auth === gatewayTokens ? {} : { gatewayAuth: auth }) });
    const headers = credential(session);
    try {
      const issued = auth.authenticate(headers);
      assert.equal(issued?.agentId, "claude-desktop");
      assert.equal(issued?.allowMcp, false);
      assert.equal(issued?.allowNativeClaude, false);
      session.cleanup();
      assert.equal(auth.authenticate(headers), undefined);
      assert.deepEqual(auth.list().map(s => s.id).sort(), before);
      assert.ok(auth.authenticate({ authorization: `Bearer ${peer.token}` }));
      session.cleanup();
      assert.deepEqual(auth.list().map(s => s.id).sort(), before);
    } finally { session.cleanup(); auth.revoke(peer.token); }
  }
});

test("failed desktop preparation revokes the issued capability even when profile serialization fails", () => {
  const auth = new GatewayTokenAuthority();
  const peer = auth.issue("claude");
  const base = mkdtempSync(join(tmpdir(), "es-desktop-failed-prepare-"));
  const label = { toJSON() { throw new Error("fixture serialization failure"); } } as unknown as string;
  try {
    assert.throws(() => prepareClaudeDesktopSession({ ...options, baseDir: base, gatewayAuth: auth, models: [{ id: "mock/echo", label }] }), /fixture serialization failure/);
    assert.deepEqual(auth.list().map(s => s.id), [peer.id]);
    assert.deepEqual(readdirSync(base), []);
  } finally { auth.revoke(peer.token); rmSync(base, { recursive: true, force: true }); }
});

test("a synchronous fixture spawn failure revokes the token and cleans its prepared directory", async () => {
  const auth = new GatewayTokenAuthority();
  const failSpawn = (() => { throw new Error("fixture synchronous spawn failure"); }) as typeof spawn;
  const session = new ClaudeDesktopSession({ ...options, gatewayAuth: auth }, failSpawn);
  const headers = credential(session);
  await assert.rejects(session.start(), /fixture synchronous spawn failure/);
  assert.equal(session.status().state, "failed");
  assert.equal(session.status().cleaned, true);
  assert.equal(auth.authenticate(headers), undefined);
  assert.equal(auth.list().length, 0);
});

test("read-only executable discovery searches absolute PATH entries without spawning programs", () => {
  const mock = fixture('throw new Error("must never run during discovery");');
  try {
    assert.equal(findClaudeDesktopExecutable({ platform: "linux", path: `.:relative:${mock.dir}` }), mock.executable);
    assert.equal(findClaudeDesktopExecutable({ platform: "win32", path: mock.dir }), undefined);
  } finally { mock.dispose(); }
});

test("mock desktop reaches only the local mock gateway and auto-cleans on normal exit", { timeout: 10_000 }, async () => {
  let request: { url?: string; authorization?: string; body?: unknown } | undefined;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    request = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "mock reply" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const mock = fixture(`
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const root = process.env.CLAUDE_USER_DATA_DIR;
    const meta = JSON.parse(readFileSync(join(root, 'configLibrary/_meta.json')));
    const profile = JSON.parse(readFileSync(join(root, 'configLibrary', meta.appliedId + '.json')));
    if (!profile.inferenceGatewayBaseUrl.startsWith('http://127.0.0.1:')) process.exit(90);
    writeFileSync(join(process.env.HOME, 'mock-started'), 'yes');
    const response = await fetch(profile.inferenceGatewayBaseUrl + '/v1/messages', {
      method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + profile.inferenceGatewayApiKey, 'content-type': 'application/json' },
      body: JSON.stringify({model: profile.inferenceModels[0].name, max_tokens: 8, messages: [{role:'user', content:'test'}]})
    });
    if ((await response.json()).content[0].text !== 'mock reply') process.exit(91);
  `);
  const native = join(mock.dir, "native-home");
  mkdirSync(join(native, ".config", "Claude"), { recursive: true });
  writeFileSync(join(native, ".config", "Claude", "native.json"), "unchanged");
  const auth = new GatewayTokenAuthority();
  const session = prepareClaudeDesktopFixtureSession({ ...options, executable: mock.executable, port, parentEnv: { HOME: native }, gatewayAuth: auth });
  const headers = credential(session);
  try {
    assert.equal((await session.start()).state, "running");
    const done = await session.wait();
    assert.equal(done.exitCode, 0);
    assert.equal(done.state, "exited");
    assert.equal(done.cleaned, true);
    assert.equal(auth.authenticate(headers), undefined);
    assert.equal(readFileSync(join(native, ".config", "Claude", "native.json"), "utf8"), "unchanged");
    assert.equal(existsSync(join(native, ".config", "Claude-3p")), false);
    assert.equal(request?.url, "/v1/messages");
    assert.match(request!.authorization!, /^Bearer es-session-claude-desktop-/);
    assert.equal((request!.body as { model: string }).model, models[0]!.id);
    await assert.rejects(session.start(), /重复启动/);
  } finally {
    await session.stop();
    await new Promise<void>(resolve => server.close(() => resolve()));
    mock.dispose();
  }
});

test("missing executable and mock crash preserve a safe status and remove owned directories", { timeout: 10_000 }, async () => {
  const auth = new GatewayTokenAuthority();
  const missing = prepareClaudeDesktopFixtureSession({ ...options, gatewayAuth: auth });
  const missingHeaders = credential(missing);
  await assert.rejects(missing.start(), /未能启动/);
  assert.equal(missing.status().state, "failed");
  assert.equal(existsSync(missing.directory), false);
  assert.equal(auth.authenticate(missingHeaders), undefined);
  const mock = fixture("process.exit(7)");
  const crashed = prepareClaudeDesktopFixtureSession({ ...options, executable: mock.executable, gatewayAuth: auth });
  const crashHeaders = credential(crashed);
  try {
    await crashed.start();
    const result = await crashed.wait();
    assert.equal(result.state, "failed");
    assert.equal(result.exitCode, 7);
    assert.equal(result.cleaned, true);
    assert.equal(auth.authenticate(crashHeaders), undefined);
    assert.equal(auth.list().length, 0);
  } finally { await crashed.stop(); mock.dispose(); }
});

test("stop kills only the owned mock process and leaves unrelated running processes alone", { timeout: 10_000 }, async () => {
  const mock = fixture("import {writeFileSync} from 'node:fs'; process.on('SIGTERM', () => {}); writeFileSync(process.env.HOME + '/ready', 'yes'); setInterval(() => {}, 100)");
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 100)"], { stdio: "ignore" });
  const session = prepareClaudeDesktopFixtureSession({ ...options, executable: mock.executable });
  try {
    await session.start();
    await waitFor(() => existsSync(join(String(session.spec.env.HOME), "ready")));
    assert.throws(() => session.cleanup(), /仍在运行/);
    await session.stop(30);
    assert.equal(session.status().state, "stopped");
    assert.equal(session.status().cleaned, true);
    assert.doesNotThrow(() => process.kill(other.pid!, 0));
    await session.stop();
  } finally { other.kill(); await session.stop(); mock.dispose(); }
});

test("simultaneous sessions have distinct profiles and stopping one keeps the other alive", { timeout: 10_000 }, async () => {
  const mock = fixture("setInterval(() => {}, 100)");
  const auth = new GatewayTokenAuthority();
  const one = prepareClaudeDesktopFixtureSession({ ...options, executable: mock.executable, gatewayAuth: auth });
  const two = prepareClaudeDesktopFixtureSession({ ...options, executable: mock.executable, gatewayAuth: auth });
  const firstHeaders = credential(one), secondHeaders = credential(two);
  try {
    assert.notEqual(one.directory, two.directory);
    assert.notEqual(one.id, two.id);
    await Promise.all([one.start(), two.start()]);
    await one.stop();
    assert.equal(auth.authenticate(firstHeaders), undefined);
    assert.ok(auth.authenticate(secondHeaders));
    assert.equal(two.status().state, "running");
    assert.ok(existsSync(two.directory));
    assert.doesNotThrow(() => process.kill(two.status().pid!, 0));
  } finally { await one.stop(); await two.stop(); mock.dispose(); }
  assert.equal(auth.list().length, 0);
});

test("a cleaned session never probes or signals a possibly reused numeric process group", { timeout: 10_000 }, async t => {
  const mock = fixture("process.exit(0)");
  const session = prepareClaudeDesktopFixtureSession({ ...options, executable: mock.executable });
  try {
    await session.start();
    await session.wait();
    assert.equal(session.status().cleaned, true);
    const kill = t.mock.method(process, "kill", () => { throw new Error("stale process group access"); });
    await session.stop();
    session.cleanup();
    assert.equal(kill.mock.callCount(), 0);
    kill.mock.restore();
  } finally { mock.dispose(); }
});

test("desktop API requires explicit experimental launch and shuts down only fixture sessions", { timeout: 10_000 }, async () => {
  const mock = fixture("setInterval(() => {}, 100)");
  const auth = new GatewayTokenAuthority();
  const store = new Store(join(mock.dir, "state"));
  store.upsertProvider({ id: "mock", name: "Mock", baseUrl: "http://127.0.0.1:1", models: ["echo"], protocols: ["messages"], route: "chat-translate", routePinned: false, streamUsage: false, createdAt: new Date().toISOString() });
  const server = createEasySwitchServer({
    store, port: 0, gatewayAuth: auth,
    secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    claudeDesktop: { executable: mock.executable, baseDir: mock.dir, parentEnv: { DISPLAY: ":fixture" }, platform: "linux" },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown = {}, headers = { "x-easyswitch": "1" }) => fetch(origin + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const info = await (await fetch(origin + "/api/claude-desktop")).json() as { installed: boolean; verified: boolean; sessions: unknown[] };
    assert.equal(info.installed, true);
    assert.equal(info.verified, false);
    assert.deepEqual(info.sessions, []);
    assert.equal((await post("/api/claude-desktop/sessions", {})).status, 409);
    assert.equal((await post("/api/claude-desktop/sessions", { experimental: true }, {} as { "x-easyswitch": string })).status, 403);
    assert.equal((await post("/api/claude-desktop/sessions", { experimental: true, model: "unknown/model" })).status, 409);
    const started = await post("/api/claude-desktop/sessions", { experimental: true, executable: "/not/accepted", model: "mock/echo" });
    assert.equal(started.status, 201);
    const body = await started.json() as { session: { id: string; state: string; pid: number; verified: boolean }; model: string };
    assert.equal(body.session.state, "running");
    assert.equal(body.session.verified, false);
    assert.equal(body.model, "mock/echo");
    assert.deepEqual(auth.list().map(s => s.agentId), ["claude-desktop"], "the fixture session uses this server's injected authority");
    assert.ok(!JSON.stringify(body).includes("es-session-"));
    assert.ok(!JSON.stringify(body).includes("inferenceGatewayApiKey"));
    assert.equal((await post(`/api/claude-desktop/sessions/${body.session.id}/stop`)).status, 200);
    assert.equal(auth.list().length, 0);
    assert.equal((await post("/api/claude-desktop/sessions/not-a-session/stop")).status, 404);
    // Repeated clicks are bounded independently of model settings.
    for (let i = 0; i < 3; i++) assert.equal((await post("/api/claude-desktop/sessions", { experimental: true })).status, 201);
    assert.equal((await post("/api/claude-desktop/sessions", { experimental: true })).status, 409);
    await stopClaudeDesktopSessions(server);
    assert.equal(auth.list().length, 0);
    assert.equal((await post("/api/claude-desktop/sessions", { experimental: true })).status, 503);
    assert.deepEqual(readdirSync(mock.dir).filter(n => n.startsWith("easyswitch-claude-desktop-")), []);
  } finally {
    await stopClaudeDesktopSessions(server);
    await new Promise<void>(resolve => server.close(() => resolve()));
    mock.dispose();
  }
});

test("desktop discovery never borrows native credentials, and unknown native models cannot fall through", { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-desktop-discovery-"));
  const store = new Store(dir);
  store.upsertProvider({ id: "mock", name: "Mock", baseUrl: "http://127.0.0.1:1", models: ["echo"], protocols: ["messages"], route: "chat-translate", routePinned: false, streamUsage: false, createdAt: new Date().toISOString() });
  assert.equal(store.settings().claudeNative, true, "native support stays enabled for the normal Claude session");
  const server = createEasySwitchServer({ store, port: 0, secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const status = await (await fetch(origin + "/api/claude-desktop")).json() as { launchBlocked: boolean; note: string };
    assert.equal(status.launchBlocked, true);
    assert.match(status.note, /2\.19675\.1/);
    for (const body of [{}, { experimental: true }, { experimental: true, executable: process.execPath, allowUnverifiedIsolationForTests: true, claudeDesktop: { executable: process.execPath } }]) {
      const response = await fetch(origin + "/api/claude-desktop/sessions", { method: "POST", headers: { "x-easyswitch": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 409);
      const result = await response.json() as { code: string };
      assert.equal(result.code, "desktop_isolation_unverified", "HTTP flags must never enable the private fixture path");
    }
    const token = sessionToken("claude-desktop");
    const variants: Array<Record<string, string>> = [{ authorization: `Bearer ${sessionToken("claudedesktop")}` }, { authorization: `Bearer ${token}` }, { "x-api-key": token, "anthropic-version": "2023-06-01" }];
    for (const headers of variants) {
      const response = await fetch(origin + "/v1/models", { headers });
      assert.equal(response.status, 200);
      const body = await response.json() as { data: Array<{ id: string; type: string }>; has_more: boolean };
      assert.equal(body.has_more, false);
      assert.deepEqual(body.data.map(m => m.id), ["es-claude-mock--echo"]);
      assert.equal(body.data[0]!.type, "model");
    }
    for (const path of ["/v1/messages", "/v1/messages/count_tokens"]) {
      for (const model of ["claude-sonnet-4-5", "mock/not-added", "es-claude-mock--not-added"]) {
        const response = await fetch(origin + path, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "must not leave loopback" }] }) });
        assert.equal(response.status, 400);
        assert.match(await response.text(), /不会回退/);
      }
      const mixed = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer unrelated", "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-5", messages: [] }) });
      assert.equal(mixed.status, 401, "conflicting credential headers are rejected before native routing");
    }
    assert.equal(store.settings().claudeNative, true);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});

test("cleanup refuses a replaced session root, including a symlink to native data", () => {
  const auth = new GatewayTokenAuthority();
  const session = prepareClaudeDesktopSession({ ...options, gatewayAuth: auth });
  const headers = credential(session);
  const moved = session.directory + "-owned";
  const native = mkdtempSync(join(tmpdir(), "es-native-sentinel-"));
  writeFileSync(join(native, "keep"), "native");
  renameSync(session.directory, moved);
  symlinkSync(native, session.directory, "dir");
  try {
    assert.throws(() => session.cleanup(), /已被替换/);
    assert.equal(auth.authenticate(headers), undefined, "retained config files must not retain a live capability");
    assert.equal(readFileSync(join(native, "keep"), "utf8"), "native");
  } finally {
    rmSync(session.directory);
    renameSync(moved, session.directory);
    session.cleanup();
    rmSync(native, { recursive: true, force: true });
  }
});

test("cleanup preserves an unrelated directory raced into the pathname after its first check", () => {
  const base = mkdtempSync(join(tmpdir(), "es-cleanup-race-"));
  const session = prepareClaudeDesktopSession({ ...options, baseDir: base });
  const replacement = join(base, "unrelated");
  const moved = join(base, "original-owned");
  mkdirSync(replacement);
  writeFileSync(join(replacement, "sentinel"), "must survive");
  const original = fs.realpathSync;
  let injected = false;
  fs.realpathSync = Object.assign(((path: fs.PathLike, opts?: unknown) => {
    const result = (original as Function)(path, opts);
    if (String(path) === session.directory && !injected) {
      injected = true;
      renameSync(session.directory, moved);
      renameSync(replacement, session.directory);
    }
    return result;
  }) as typeof fs.realpathSync, { native: original.native });
  syncBuiltinESMExports();
  try {
    assert.throws(() => session.cleanup(), /被替换/);
    assert.equal(injected, true);
    const sentinel = files(base).find(path => path.endsWith("/sentinel"));
    assert.ok(sentinel);
    assert.equal(readFileSync(sentinel, "utf8"), "must survive");
    assert.ok(existsSync(moved));
    assert.equal(session.status().cleaned, false);
    assert.equal(session.status().state, "cleanup-blocked");
    assert.throws(() => session.cleanup(), /被替换/);
  } finally {
    fs.realpathSync = original;
    syncBuiltinESMExports();
    rmSync(base, { recursive: true, force: true });
  }
});
