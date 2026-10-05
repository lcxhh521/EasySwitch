import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { commandLine, hasLauncher, LAUNCHERS, materialize, newSessionDir, runHeadless } from "../src/agent-launch.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";

const DSH = "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh";

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let providerId: string;

before(async () => {
  relay = await startMockRelay(0, { apiKey: "relay-key" });
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  server = createEasySwitchServer({ store: new Store(mkdtempSync(join(tmpdir(), "es-agent-store-"))), secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  const created = (await fetch(`http://127.0.0.1:${port}/api/providers`, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" },
    body: JSON.stringify({ name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "relay-key" }),
  }).then(r => r.json())) as { id: string };
  providerId = created.id;
});

after(() => {
  server.closeAllConnections(); server.close();
  relay.server.closeAllConnections(); relay.server.close();
});

test("each launcher says what it can do, and which forms were run against the real program", () => {
  assert.deepEqual(hasLauncher("dsh"), { interactive: false, headless: true, verified: true });
  assert.equal(hasLauncher("qwen-code")?.verified, false, "documented but not yet run here");
  assert.equal(hasLauncher("doubao"), undefined);
});

test("launch specs pass the gateway address, token and model per process, and clear nothing global", () => {
  const input = { bin: "/bin/qwen", port: 18765, model: "ds/deepseek-chat", token: "es-session-qwencode-x", sessionDir: "/tmp/s" };
  const spec = LAUNCHERS["qwen-code"]!.interactive!(input);
  assert.deepEqual(spec.env, { OPENAI_BASE_URL: "http://127.0.0.1:18765/v1", OPENAI_API_KEY: "es-session-qwencode-x", OPENAI_MODEL: "ds/deepseek-chat" });
  assert.match(commandLine(spec), /^env OPENAI_BASE_URL='http:\/\/127\.0\.0\.1:18765\/v1' .* '\/bin\/qwen'$/);
  const oc = JSON.parse(LAUNCHERS.opencode!.headless!({ ...input, task: "x" }).env.OPENCODE_CONFIG_CONTENT!) as { provider: { easyswitch: { options: { baseURL: string } } } };
  assert.equal(oc.provider.easyswitch.options.baseURL, "http://127.0.0.1:18765/v1");
  const aider = LAUNCHERS.aider!.headless!({ ...input, task: "fix it" });
  assert.deepEqual(aider.args.slice(-4), ["--message", "fix it", "--yes-always", "--no-auto-commits"]);
});

test("a dsh patch is written under the private session directory, not under ~/.dsh", () => {
  const dir = newSessionDir();
  const spec = LAUNCHERS.dsh!.headless!({ bin: DSH, port: 1, model: "p/m", token: "t", sessionDir: dir, task: "x" });
  materialize(spec, dir);
  assert.ok(existsSync(join(dir, "patch.yml")));
  assert.equal(spec.env.DSH_HOME, join(dir, "dsh-home"), "a private DSH_HOME, so ~/.dsh is untouched");
});

test("the real DeepSeek Harness, handed a task headlessly, answers through the gateway", async t => {
  if (!existsSync(DSH)) { t.skip("DeepSeek Harness not installed"); return; }
  const before = relay.requests.length;
  const result = await runHeadless("dsh", { bin: DSH, port, model: `${providerId}/mock-coder`, task: "Reply with exactly the word: pong" }, { timeoutMs: 90_000 });
  assert.equal(result.timedOut, false);
  assert.match(result.output, /Hello from the mock relay|pong/i);
  assert.ok(relay.requests.length > before, "the request went through the gateway to the provider");
});

test("the task endpoint refuses without a task, and never touches an agent that is not installed", async () => {
  const H = { "content-type": "application/json", "x-easyswitch": "1" };
  const empty = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ agent: "dsh", task: "  " }) });
  assert.equal(empty.status, 400);
  const missing = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ agent: "aider", task: "x", model: `${providerId}/mock-coder` }) });
  assert.equal(missing.status, 409, "aider is not installed here");
  const unknown = await fetch(`http://127.0.0.1:${port}/api/bindings/not-an-agent`, { method: "PUT", headers: H, body: JSON.stringify({ providerId, model: "mock-coder" }) });
  assert.equal(unknown.status, 404);
});

test("a task handed over from the console is recorded, runs in the background and ends with its answer", async t => {
  if (!existsSync(DSH)) { t.skip("DeepSeek Harness not installed"); return; }
  const H = { "content-type": "application/json", "x-easyswitch": "1" };
  const started = await fetch(`http://127.0.0.1:${port}/api/tasks`, { method: "POST", headers: H, body: JSON.stringify({ agent: "dsh", task: "Reply with exactly the word: pong", model: `${providerId}/mock-coder` }) });
  assert.equal(started.status, 202);
  const { task } = (await started.json()) as { task: { id: string; status: string; from: string } };
  assert.equal(task.status, "running");
  assert.equal(task.from, "console");
  let final: { status: string; output?: string } | undefined;
  for (let i = 0; i < 120 && !final; i++) {
    const list = (await (await fetch(`http://127.0.0.1:${port}/api/tasks`)).json()) as { tasks: Array<{ id: string; status: string; output?: string }> };
    const mine = list.tasks.find(x => x.id === task.id);
    if (mine && mine.status !== "running") final = mine;
    else await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(final?.status, "done");
  assert.match(final?.output ?? "", /Hello from the mock relay|pong/i);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/tasks/${task.id}/stop`, { method: "POST", headers: H })).status, 404, "a finished task cannot be stopped");
});
