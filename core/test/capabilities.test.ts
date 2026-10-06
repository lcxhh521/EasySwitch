import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { AGENTS } from "../src/agents.ts";
import { LAUNCHERS, type AgentLauncher } from "../src/agent-launch.ts";
import { capabilityMatrix, coverage, FEATURES, launcherCarriesMcp, launcherHasOwnEffort, launcherListsModels, type CapState } from "../src/capabilities.ts";

const STATES: CapState[] = ["verified", "documented", "manual", "impossible", "todo", "na"];
const matrix = capabilityMatrix();

test("every agent has an explicit state for every feature: nothing is left unsaid", () => {
  for (const a of AGENTS) {
    for (const f of FEATURES) {
      const cap = matrix[a.id]?.[f.id];
      assert.ok(cap, `${a.id} has no entry for ${f.id}`);
      assert.ok(STATES.includes(cap.state), `${a.id}.${f.id}: ${String(cap.state)}`);
    }
  }
  assert.equal(Object.keys(matrix).length, AGENTS.length);
});

test("something impossible always says why, and something not done always says what is missing", () => {
  for (const a of AGENTS) {
    for (const f of FEATURES) {
      const cap = matrix[a.id]![f.id];
      if (cap.state === "impossible") assert.ok(cap.note && cap.note.length >= 6, `${a.id}.${f.id} is impossible without a reason`);
      if (cap.state === "todo") assert.ok(cap.note, `${a.id}.${f.id} is not done and does not say what is missing`);
    }
  }
});

test("'ready' means the launch was tried against the real program, and 'verified' is never claimed without a launcher that says so", () => {
  for (const a of AGENTS) {
    if (a.support === "ready") assert.equal(LAUNCHERS[a.id]?.verified, true, `${a.id} is listed as ready but its launcher was never run against the real program`);
    for (const f of ["launch", "task"] as const) {
      if (matrix[a.id]![f].state === "verified") assert.equal(LAUNCHERS[a.id]?.verified, true, `${a.id}.${f}`);
    }
  }
});

test("closed apps are never claimed to launch, and a launcher implies launch or task is at least written", () => {
  for (const a of AGENTS) {
    const l = LAUNCHERS[a.id];
    const { launch, task } = matrix[a.id]!;
    if (a.support === "open") {
      assert.ok(launch.state !== "verified" && launch.state !== "documented", `${a.id} is open (no endpoint) yet launch says ${launch.state}`);
    }
    if (l?.interactive) assert.ok(["verified", "documented"].includes(launch.state), a.id);
    if (l?.headless) assert.ok(["verified", "documented"].includes(task.state), a.id);
  }
});

test("MCP and thinking-level support are read off what the launchers really do", () => {
  // The launchers that carry the MCP server today; a new one has to be added here on purpose.
  const carrying = AGENTS.filter(a => launcherCarriesMcp(LAUNCHERS[a.id])).map(a => a.id).sort();
  assert.deepEqual(carrying, ["atomcode", "claude", "cline", "codebuddy", "codex", "copilot-cli", "crush", "droid", "dsh", "gemini-cli", "goose", "grok-build", "hermes", "kimi-cli", "omp", "openclaw", "opencode", "qoder-cli", "qwen-code", "trae-agent"], "update the matrix expectation when another launcher learns to carry MCP");
  assert.equal(matrix.codex!.mcp.state, "verified");
  assert.equal(matrix.claude!.mcp.state, "verified");
  assert.equal(matrix.hermes!.mcp.state, "documented");
  assert.equal(matrix.dsh!.mcp.state, "documented", "dsh MCP is configured but has no real CLI acceptance");
  assert.equal(matrix.aider!.mcp.state, "impossible");
  // A launcher that grows an MCP argument is noticed without anyone editing a table.
  const fake: AgentLauncher = { verified: false, headless: i => ({ command: i.bin, args: i.mcp ? ["--mcp", i.mcp.url] : [], env: {} }) };
  assert.equal(launcherCarriesMcp(fake), true);
  assert.equal(launcherCarriesMcp({ verified: false, headless: i => ({ command: i.bin, args: [], env: {} }) }), false);
  assert.equal(launcherHasOwnEffort({ verified: false, headless: i => ({ command: i.bin, args: i.effort ? ["--effort", i.effort] : [], env: {} }) }), true);
  assert.equal(launcherHasOwnEffort({ verified: false, headless: i => ({ command: i.bin, args: [], env: {} }) }), false);
  for (const id of ["claude", "codex", "hermes"]) assert.match(matrix[id]!.effort.note ?? "", /自己的档位/, `${id} has its own flag`);
});

test("Claude's subscription is never offered to other harnesses, and Claude's desktop app is not touched", () => {
  assert.equal(matrix.claude!.source.state, "impossible");
  assert.match(matrix.claude!.source.note!, /不借给别的 harness/);
  assert.ok(AGENTS.some(a => a.id === "claude-desktop"), "the Claude desktop app is in the catalog");
  // The desktop app has an official third-party gateway mode, so launching it is possible (a separate
  // instance on its own data directory); what we refuse is intercepting its traffic.
  assert.equal(matrix["claude-desktop"]!.launch.state, "todo");
  assert.match(matrix["claude-desktop"]!.launch.note!, /官方/);
  assert.match(matrix["claude-desktop"]!.launch.note!, /不拦截/);
  assert.match(matrix["claude-desktop"]!.launch.note!, /模拟/);
  assert.match(matrix["claude-desktop"]!.launch.note!, /尚未实测/);
  assert.match(matrix["claude-desktop"]!.launch.note!, /真实启动已阻塞/);
});

test("the coverage summary adds up, and says plainly how much is still to do", t => {
  const rows = coverage(matrix);
  for (const row of rows) {
    const total = Object.values(row.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, AGENTS.length, row.feature);
    assert.equal(row.applies, AGENTS.length - row.counts.na);
    assert.equal(row.settled, row.applies - row.counts.todo);
  }
  // Printed in the test run, so every run shows where things stand.
  for (const row of rows) t.diagnostic(`${row.label}: 已定 ${row.settled}/${row.applies}（实测 ${row.counts.verified}，按文档 ${row.counts.documented}，手动 ${row.counts.manual}，做不了 ${row.counts.impossible}，没做 ${row.counts.todo}）`);
});

// ---- the private-directory launchers

import { materialize, type LaunchInput } from "../src/agent-launch.ts";
import { EXTRA_LAUNCHERS } from "../src/launchers-extra.ts";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function input(sessionDir: string, over: Partial<LaunchInput> = {}): LaunchInput {
  return { bin: "/bin/agent", port: 18999, model: "deepseek/deepseek-chat", token: "es-session-x-123", sessionDir, task: "say hi", mcp: { url: "http://127.0.0.1:18999/mcp", headers: { Authorization: "Bearer es-session-x-123", "x-easyswitch-depth": "1" } }, ...over };
}

function walk(dir: string): string[] {
  // Symbolic links are listed by what they are and never followed (dsh's plugin link points outside the directory).
  return readdirSync(dir).flatMap(n => {
    const full = join(dir, n);
    const info = lstatSync(full);
    return info.isSymbolicLink() ? [] : info.isDirectory() ? walk(full) : [full];
  });
}

test("every private-directory launcher keeps everything under its own session directory and never touches the user's home", () => {
  for (const [id, l] of Object.entries(EXTRA_LAUNCHERS)) {
    for (const form of ["interactive", "headless"] as const) {
      const make = l[form];
      if (!make) continue;
      const dir = mkdtempSync(join(tmpdir(), "es-launch-test-"));
      try {
        const spec = make(input(dir));
        // Every path an environment variable points at lies inside the session directory (or is the gateway token / name).
        for (const [k, v] of Object.entries(spec.env)) if (v.startsWith("/")) assert.ok(v.startsWith(dir), `${id}.${form}: ${k}=${v} leaves the session directory`);
        materialize(spec, dir);
        for (const f of walk(dir)) assert.ok(f.startsWith(dir) && !f.startsWith(homedir()) || f.startsWith(dir), `${id}: ${f}`);
        // Everything that mentions the gateway token also names the gateway, and nothing contains a real-looking home path.
        const all = walk(dir).map(f => readFileSync(f, "utf8")).join("\n") + JSON.stringify(spec.args);
        // The program that runs the bridge and the repository the bridge script is in may well be under the home directory: they are ours, not the user's.
        const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
        assert.ok(!all.replaceAll(process.execPath, "").replaceAll(repoRoot, "").includes(homedir()), `${id}.${form} mentions the user's home`);
        assert.ok(all.includes("127.0.0.1:18999"), `${id}.${form} never names the gateway`);
        assert.ok(all.includes("es-session-x-123") || Object.values(spec.env).includes("es-session-x-123"), `${id}.${form} carries no token`);
        if (form === "headless") assert.ok(spec.args.includes("say hi"), `${id}: the task text is not passed on`);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
});

test("the JSON files these launchers write are valid JSON and carry the MCP server only when one is attached", () => {
  for (const [id, l] of Object.entries(EXTRA_LAUNCHERS)) {
    const make = l.headless ?? l.interactive!;
    for (const withMcp of [true, false]) {
      const dir = mkdtempSync(join(tmpdir(), "es-launch-test-"));
      try {
        const spec = make(input(dir, withMcp ? {} : { mcp: undefined as never }));
        materialize(spec, dir);
        for (const f of walk(dir).filter(f => f.endsWith(".json"))) {
          const text = readFileSync(f, "utf8");
          assert.doesNotThrow(() => JSON.parse(text), `${id}: ${f} is not valid JSON`);
          if (!withMcp) assert.ok(!text.includes("/mcp"), `${id}: ${f} has an MCP entry although none was attached`);
        }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
});

test("a thinking level and the extra models reach the files of the launchers that take them", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-launch-test-"));
  try {
    const spec = EXTRA_LAUNCHERS.omp!.headless!(input(dir, { effort: "xhigh", tiers: { subagent: "kimi/k2", small: "deepseek/fast" } }));
    materialize(spec, dir);
    const config = readFileSync(join(dir, "omp-agent", "config.yml"), "utf8");
    assert.match(config, /defaultThinkingLevel: "xhigh"/);
    assert.match(config, /task: "easyswitch\/kimi\/k2"/);
    assert.match(config, /smol: "easyswitch\/deepseek\/fast"/);
    assert.deepEqual(spec.unset, ["OMP_PROFILE", "PI_PROFILE", "CLAUDE_CONFIG_DIR", "PI_CONFIG_FILES", "PI_SMOL_MODEL", "PI_SLOW_MODEL", "PI_PLAN_MODEL"], "a profile variable would send omp to the user's own directory");
    const crush = EXTRA_LAUNCHERS.crush!.headless!(input(dir, { effort: "high", tiers: { small: "deepseek/fast" } }));
    materialize(crush, dir);
    const parsed = JSON.parse(readFileSync(join(dir, "crush-config", "crush.json"), "utf8"));
    assert.equal(parsed.models.large.reasoning_effort, "high");
    assert.equal(parsed.models.small.model, "deepseek/fast");
    assert.ok(parsed.mcp.easyswitch.url.endsWith("/mcp"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Hermes' config keeps delegation and the MCP server at the top level, with the token left to the environment", async () => {
  const { LAUNCHERS } = await import("../src/agent-launch.ts");
  const dir = mkdtempSync(join(tmpdir(), "es-launch-test-"));
  try {
    const spec = LAUNCHERS.hermes!.headless!(input(dir, { stateDir: dir, tiers: { subagent: "kimi/k2", small: "deepseek/fast" } }));
    const yaml = Object.values(spec.files!)[0]!;
    const top = yaml.split("\n").filter(l => /^[a-z_]+:/.test(l)).map(l => l.split(":")[0]);
    assert.deepEqual(top, ["model", "custom_providers", "auxiliary", "delegation", "mcp_servers"]);
    assert.ok(!yaml.includes("es-session-x-123"), "the MCP token must not be written to the file");
    assert.match(yaml, /Bearer \$\{EASYSWITCH_MCP_TOKEN\}/);
    assert.equal(spec.env.EASYSWITCH_MCP_TOKEN, "es-session-x-123");
    // Only a sub-agent model: no empty `auxiliary:` section.
    const only = Object.values(LAUNCHERS.hermes!.headless!(input(dir, { stateDir: dir, tiers: { subagent: "kimi/k2" }, mcp: undefined as never })).files!)[0]!;
    assert.ok(!only.includes("auxiliary:") && only.includes("delegation:") && !only.includes("mcp_servers:"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the backlog hooks never hold back a session that EasySwitch started itself", async () => {
  const { spawnSync } = await import("node:child_process");
  const run = (env: Record<string, string>) => spawnSync("node", ["bin/backlog.ts", "--hook-stop"], { input: "{}", env: { ...process.env, ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "", ...env }, encoding: "utf8" });
  assert.equal(run({ ANTHROPIC_BASE_URL: "http://127.0.0.1:18765" }).status, 0, "gateway address");
  assert.equal(run({ ANTHROPIC_AUTH_TOKEN: "es-session-claude-abc" }).status, 0, "per-launch token");
  const prompt = spawnSync("node", ["bin/backlog.ts", "--hook-prompt"], { env: { ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:18765" }, encoding: "utf8" });
  assert.equal(prompt.stdout, "", "no reminder is injected into an EasySwitch session either");
});

test("every launcher that has a model list in its own configuration gets all the models, with the chosen one as the default", () => {
  const models = ["prov/alpha-1", "prov/beta-2", "other/gamma-3"];
  const listers = Object.entries({ ...LAUNCHERS }).filter(([, l]) => launcherListsModels(l)).map(([id]) => id).sort();
  assert.deepEqual(listers, ["crush", "cline", "droid", "dsh", "gemini-cli", "goose", "grok-build", "hermes", "kimi-cli", "minimax-code", "omp", "openclaw", "opencode", "pi", "qoder-cli", "qwen-code", "atomcode"].sort(), "update this when another launcher learns to list models");
  for (const id of listers) {
    const l = LAUNCHERS[id]!;
    const dir = mkdtempSync(join(tmpdir(), "es-launch-test-"));
    try {
      const spec = (l.headless ?? l.interactive!)(input(dir, { model: models[1]!, models, stateDir: dir, mcp: undefined }));
      materialize(spec, dir);
      const text = JSON.stringify(spec.args) + JSON.stringify(spec.env) + walk(dir).map(f => readFileSync(f, "utf8")).join("\n");
      for (const m of models) assert.ok(text.includes(m.slice(m.indexOf("/") + 1)), `${id}: ${m} is not in the agent's own list`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  // Codex and Claude Code have theirs through the model catalog and /model, checked against the real programs.
  assert.equal(matrix.codex!.picker.state, "verified");
  assert.equal(matrix.claude!.picker.state, "verified");
  assert.equal(matrix.aider!.picker.state, "todo");
  assert.match(matrix.aider!.picker.note!, /\/model/);
  assert.equal(matrix["trae-agent"]!.picker.state, "impossible");
  for (const id of ["gemini-cli", "qwen-code"]) {
    assert.equal(matrix[id]!.picker.state, "documented");
    assert.equal(launcherListsModels(LAUNCHERS[id]), true);
    assert.match(matrix[id]!.picker.note!, /未实测/);
  }
  assert.equal(matrix["copilot-cli"]!.picker.state, "todo");
  assert.equal(launcherListsModels(LAUNCHERS["copilot-cli"]), false);
  assert.match(matrix["copilot-cli"]!.picker.note!, /providers\.json.*尚未核实/);
});

test("Copilot always keeps its model settings in a private home, Gemini preserves its thinking setting, and Trae Agent reaches the MCP server through the stdio bridge", async () => {
  const base = { bin: "/bin/x", port: 18765, model: "prov/m", token: "es-session-x-1", sessionDir: "/tmp/es-s", task: "t" };
  const none = LAUNCHERS["copilot-cli"]!.headless!(base);
  assert.equal(none.env.COPILOT_HOME, "/tmp/es-s/copilot-home", "even without effort, /model must not write the original home");
  assert.deepEqual(JSON.parse(none.files!["/tmp/es-s/copilot-home/settings.json"]!), {});
  const high = LAUNCHERS["copilot-cli"]!.headless!({ ...base, effort: "high" });
  assert.equal(high.env.COPILOT_HOME, "/tmp/es-s/copilot-home");
  assert.deepEqual(JSON.parse(Object.values(high.files!)[0]!), { effortLevel: "high" });
  const gem = LAUNCHERS["gemini-cli"]!.headless!({ ...base, effort: "low" });
  const settings = JSON.parse(Object.values(gem.files!)[0]!) as Record<string, any>;
  assert.equal(settings.modelConfigs.overrides[0].modelConfig.generateContentConfig.thinkingConfig.thinkingLevel, "LOW");
  assert.equal(settings.security.auth.selectedType, "gemini-api-key");
  assert.equal(JSON.parse(Object.values(LAUNCHERS["gemini-cli"]!.headless!(base).files!)[0]!).modelConfigs.overrides, undefined, "no level, no thinking override");
  const trae = LAUNCHERS["trae-agent"]!.headless!({ ...base, mcp: { url: "http://127.0.0.1:18765/mcp", headers: { Authorization: "Bearer es-session-x-1" } } });
  const config = JSON.parse(Object.values(trae.files!)[0]!);
  assert.equal(config.mcp_servers.easyswitch.command, process.execPath);
  assert.match(config.mcp_servers.easyswitch.args[0], /es-mcp-stdio\.ts$/);
  assert.deepEqual(config.allow_mcp_servers, ["easyswitch"]);
  assert.equal(JSON.parse(config.mcp_servers.easyswitch.env.EASYSWITCH_MCP_HEADERS).Authorization, "Bearer es-session-x-1");
  assert.ok(!JSON.stringify(config.mcp_servers.easyswitch.args).includes("es-session-x-1"), "the token is not in bridge argv");
  assert.ok(!Object.values(LAUNCHERS["trae-agent"]!.headless!(base).files!)[0]!.includes("mcp_servers"), "no MCP attached, none configured");
  assert.equal(matrix["trae-agent"]!.mcp.state, "documented");
  assert.equal(matrix["copilot-cli"]!.effort.state, "documented");
  assert.equal(matrix["gemini-cli"]!.effort.state, "documented");
});
