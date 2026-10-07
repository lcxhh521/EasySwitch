import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { findClaude, findCodex } from "../src/launch.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
const run = promisify(execFile);
const ES = join(import.meta.dirname, "..", "..", "bin", "es.ts");

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let pid: string;
const gatewayAuth = new GatewayTokenAuthority();

before(async () => {
  relay = await startMockRelay(0, { apiKey: "relay-key" });
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  server = createEasySwitchServer({ store: new Store(mkdtempSync(join(realpathSync(tmpdir()), "es-cli-"))), secrets: createSecretStore(), gatewayAuth, port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  pid = ((await fetch(`http://127.0.0.1:${port}/api/providers`, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" },
    body: JSON.stringify({ name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "relay-key" }),
  }).then(r => r.json())) as { id: string }).id;
  await noLogin();
});

after(() => { server.closeAllConnections(); server.close(); relay.server.closeAllConnections(); relay.server.close(); });

// These runs use an empty HOME with no Claude login, so the keep-the-login mode (for a signed-in user) is off.
function noLogin() { return fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json", "x-easyswitch": "1" }, body: JSON.stringify({ claudeNative: false }) }); }

const es = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), "es-cli-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, EASYSWITCH_PORT: String(port), HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), ...extra };
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete env[k];
  const p = run(ES, args, { env, timeout: 120_000 });
  p.child.stdin?.end();
  return p.catch((e: { stdout?: string; stderr?: string; code?: number }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "", failed: e.code }));
};

test("`es` lists the agents it can start, and `es shell-init` prints opt-in shell functions", async () => {
  const listed = await es([]);
  assert.match(listed.stdout, /es (claude|codex)/);
  const init = await es(["shell-init"]);
  assert.match(init.stdout, /EASYSWITCH_OFF/);
  assert.match(init.stdout, /command (claude|hermes)/, "falls back to the plain command when EasySwitch is off or down");
});

test("`es models` returns the local model catalog without allocating a gateway session", async () => {
  const sessions = gatewayAuth.list().map(s => s.id).sort();
  const result = await es(["models"]) as { stdout: string; stderr: string; failed?: number };
  assert.equal(result.failed, undefined, result.stderr);
  assert.ok(result.stdout.split("\n").includes(`${pid}/mock-coder`));
  assert.deepEqual(gatewayAuth.list().map(s => s.id).sort(), sessions);
});

test("`es <agent>` with an unknown agent or no model fails with a plain message and leaves nothing behind", async () => {
  const r = await es(["no-such-agent"]) as { stderr: string; failed?: number };
  assert.ok(r.failed, "non-zero exit");
  assert.match(r.stderr, /还没有接入交互启动|没有检测到/);
  assert.doesNotMatch(r.stderr, /HTTP|\b[45]\d\d\b/);
  assert.match(r.stderr, /es list/);
});

test("`es claude` starts the real Claude Code here, on the gateway, with the model chosen on the command line", async t => {
  if (!(await findClaude())) { t.skip("claude not installed"); return; }
  const before = relay.requests.length;
  const r = await es(["claude", "-m", `${pid}/mock-coder`, "-e", "low", "--", "-p", "Reply with exactly the word: pong"]) as { stdout: string; stderr: string; failed?: number };
  assert.equal(r.failed, undefined, r.stderr);
  assert.match(r.stderr, /EasySwitch · Claude Code · /);
  assert.ok(relay.requests.length > before, `the request reached the provider through the gateway: ${r.stdout.slice(0, 200)} ${r.stderr.slice(0, 200)}`);
  assert.equal((relay.requests[before] as { model: string }).model, "mock-coder");
  assert.match(r.stdout, /Hello from the mock relay|pong|easyswitch-roundtrip-ok/i, "the relay's answer came back to the terminal");
});

test("`es codex` starts the real Codex here, on the gateway", async t => {
  if (!(await findCodex())) { t.skip("codex not installed"); return; }
  const before = relay.requests.length;
  const r = await es(["codex", "-m", `${pid}/mock-coder`, "--", "exec", "--skip-git-repo-check", "Reply with exactly the word: pong"]) as { stdout: string; stderr: string; failed?: number };
  assert.equal(r.failed, undefined, r.stderr);
  assert.ok(relay.requests.length > before, `the request reached the provider: ${r.stdout.slice(0, 200)} ${r.stderr.slice(-300)}`);
  assert.equal((relay.requests[before] as { model: string }).model, "mock-coder");
  assert.match(r.stdout, /Hello from the mock relay|pong|easyswitch-roundtrip-ok/i, "the fake provider's answer reached the terminal");
});

test("the private session directory and issued capability are removed when the run ends", async t => {
  if (!(await findClaude())) { t.skip("claude not installed"); return; }
  // The server in this process makes its session directories under TMPDIR: give it a directory of its own, so tests running at the same time cannot be counted.
  const mine = mkdtempSync(join(realpathSync(tmpdir()), "es-cli-tmp-"));
  const sessions = gatewayAuth.list().map(s => s.id).sort();
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = mine;
  try {
    const result = await es(["claude", "-m", `${pid}/mock-coder`, "--", "-p", "Reply with exactly the word: pong"]) as { stderr: string; failed?: number };
    assert.equal(result.failed, undefined, result.stderr);
    assert.deepEqual(readdirSync(mine).filter(n => n.startsWith("easyswitch-session-")), [], "no session directory is left");
    assert.deepEqual(gatewayAuth.list().map(s => s.id).sort(), sessions, "no gateway capability from the completed run is left");
  } finally {
    if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
  }
});
