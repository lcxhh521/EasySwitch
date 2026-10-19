import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { commandLine, hasLauncher, LAUNCHERS, materialize, newSessionDir } from "../src/agent-launch.ts";
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
  assert.deepEqual(hasLauncher("dsh"), { interactive: false, verified: true,
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], anyEffort: false, tiers: LAUNCHERS.dsh!.tiers });
  assert.deepEqual(hasLauncher("claude")?.efforts, ["low", "medium", "high", "xhigh", "max"], "agents with their own setting use their own words");
  assert.equal(hasLauncher("qwen-code")?.verified, false, "documented but not yet run here");
  assert.equal(hasLauncher("doubao"), undefined);
});

test("launch specs pass the gateway address, token and model per process, and clear nothing global", () => {
  const input = { bin: "/bin/qwen", port: 18765, model: "ds/deepseek-chat", token: "es-session-qwencode-x", sessionDir: "/tmp/s" };
  const spec = LAUNCHERS["qwen-code"]!.interactive!(input);
  // The system-settings file (model list + auth type) lives in the session directory, not in the user's own settings.
  assert.deepEqual(spec.env, { OPENAI_BASE_URL: "http://127.0.0.1:18765/v1", OPENAI_API_KEY: "es-session-qwencode-x", OPENAI_MODEL: "ds/deepseek-chat", EASYSWITCH_GATEWAY_TOKEN: "es-session-qwencode-x", QWEN_HOME: "/tmp/s/qwen-home", QWEN_RUNTIME_DIR: "/tmp/s/qwen-home", QWEN_CODE_SYSTEM_SETTINGS_PATH: "/tmp/s/qwen-system-settings.json" });
  assert.match(commandLine(spec), /^env OPENAI_BASE_URL='http:\/\/127\.0\.0\.1:18765\/v1' .* '\/bin\/qwen' '--auth-type' 'openai'$/);
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

test("a reasoning level becomes each agent's own flag, and nothing when none is asked for", () => {
  const input = { bin: "/bin/x", port: 1, model: "p/m", token: "t", sessionDir: "/tmp/s", task: "do" };
  const args = (id: string, effort?: string) => LAUNCHERS[id]!.headless!({ ...input, ...(effort ? { effort } : {}) }).args;
  assert.ok(args("claude", "xhigh").join(" ").includes("--effort xhigh"));
  assert.ok(args("codex", "high").join(" ").includes('model_reasoning_effort="high"'));
  assert.ok(args("hermes", "low").join(" ").includes("--reasoning low"));
  for (const id of ["claude", "codex", "hermes"]) assert.ok(!args(id).join(" ").match(/effort|--reasoning/), `${id}: no flag unless asked`);
});

test("an agent's extra models become its own per-launch settings: sub-agents, small tasks", () => {
  const input = { bin: "/bin/x", port: 7, model: "a/main", token: "es-session-t", sessionDir: "/tmp/s", task: "do", tiers: { small: "b/tiny", subagent: "c/helper" } };
  const claude = LAUNCHERS.claude!.headless!(input);
  assert.match(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL!, /b--tiny/, "titles and summaries run on the small model");
  assert.match(claude.env.ANTHROPIC_SMALL_FAST_MODEL!, /b--tiny/);
  assert.match(claude.env.CLAUDE_CODE_SUBAGENT_MODEL!, /c--helper/);
  assert.match(claude.env.ANTHROPIC_MODEL!, /a--main/, "the main model is untouched");
  const plain = LAUNCHERS.claude!.headless!({ ...input, tiers: {} });
  assert.equal(plain.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined, "no tier, no variable: it follows the main model");
  assert.ok(LAUNCHERS.codex!.headless!(input).args.join(" ").includes('agents.default_subagent_model="c/helper"'));
  const oc = JSON.parse(LAUNCHERS.opencode!.headless!(input).env.OPENCODE_CONFIG_CONTENT!) as { small_model: string; provider: { easyswitch: { models: Record<string, unknown> } } };
  assert.equal(oc.small_model, "easyswitch/b/tiny");
  assert.ok(oc.provider.easyswitch.models["b/tiny"], "the small model is also declared as a provider model");
});

test("effort and extra models are saved on the agent, survive a model change, and are checked", async () => {
  const H = { "content-type": "application/json", "x-easyswitch": "1" };
  const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
  await api("PUT", "/api/bindings/claude", { providerId, model: "mock-coder" });
  assert.equal((await api("PUT", "/api/bindings/claude/effort", { effort: "high" })).status, 400, "a model with no levels has nothing to set");
  assert.equal((await api("PUT", `/api/providers/${providerId}/model-efforts`, { model: "mock-coder", levels: ["low", "medium", "high"] })).status, 200, "the user says which levels it has");
  assert.equal((await api("PUT", "/api/bindings/claude/effort", { effort: "turbo" })).status, 400, "only levels the model and the agent both have");
  assert.equal((await api("PUT", "/api/bindings/claude/effort", { effort: "max" })).status, 400, "the agent has max, this model does not");
  assert.equal((await api("PUT", "/api/bindings/claude/effort", { effort: "high" })).status, 200);
  assert.equal((await api("PUT", "/api/bindings/claude/tiers/subagent", { providerId, model: "mock-coder" })).status, 200);
  assert.equal((await api("PUT", "/api/bindings/claude/tiers/nonsense", { providerId, model: "mock-coder" })).status, 404);
  assert.equal((await api("PUT", "/api/bindings/claude/tiers/small", { providerId, model: "no-such-model" })).status, 400);
  await api("PUT", "/api/bindings/claude", { providerId, model: "mock-coder" });
  const b = (await (await api("GET", "/api/state")).json()) as { prefs: Record<string, { effort?: string; tiers?: Record<string, string> }> };
  assert.equal(b.prefs.claude?.effort, "high", "changing the main model keeps the level");
  assert.equal(b.prefs.claude?.tiers?.subagent, `${providerId}/mock-coder`);
  const cmd = (await (await api("POST", "/api/agents/claude/command", {})).json()) as { args: string[]; env: Record<string, string> };
  assert.ok(cmd.args.join(" ").includes("--effort high"), "the saved level is used when launching");
  assert.ok(cmd.env.CLAUDE_CODE_SUBAGENT_MODEL, "and so is the saved sub-agent model");
  assert.equal((await api("DELETE", "/api/bindings/claude/tiers/subagent")).status, 200);
});

test("an agent's other models do not need a main model: only a sub-agent model can be set while the main one stays native", async () => {
  const H = { "content-type": "application/json", "x-easyswitch": "1" };
  const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
  await api("DELETE", "/api/bindings/codex");
  assert.equal((await api("PUT", "/api/bindings/codex/tiers/subagent", { providerId, model: "mock-coder" })).status, 200, "no main model chosen, still allowed");
  const state = (await (await api("GET", "/api/state")).json()) as { prefs: Record<string, { tiers?: Record<string, string> }>; bindings: Record<string, unknown> };
  assert.ok(!state.bindings.codex, "the main model stays native");
  assert.equal(state.prefs.codex?.tiers?.subagent, `${providerId}/mock-coder`);
  await api("DELETE", "/api/bindings/codex/tiers/subagent");
});

test("Hermes and Aider take a small-task model of their own", () => {
  const input = { bin: "/bin/x", port: 7, model: "a/main", token: "t", sessionDir: "/tmp/hs", stateDir: "/tmp/hs-state", task: "do", tiers: { small: "b/tiny", vision: "c/eyes" } };
  const files = LAUNCHERS.hermes!.headless!(input).files!;
  const yaml = Object.values(files)[0]!;
  assert.match(yaml, /auxiliary:\n  compression:\n    provider: custom:easyswitch\n    model: "b\/tiny"/);
  assert.match(yaml, /  vision:\n    provider: custom:easyswitch\n    model: "c\/eyes"/);
  assert.match(yaml, /"b\/tiny": \{\}/, "the small model is declared on the private provider too");
  assert.ok(LAUNCHERS.aider!.headless!(input).args.join(" ").includes("--weak-model openai/b/tiny"));
  assert.ok(!LAUNCHERS.aider!.headless!({ ...input, tiers: {} }).args.join(" ").includes("--weak-model"));
});
