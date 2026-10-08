import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { commandLine, dshMcpPlugin, LAUNCHERS, materialize, runHeadless, type HeadlessProcessRuntime, type LaunchInput } from "../src/agent-launch.ts";
import { dshPatch, findDshMcpPlugin, prepareDshMcpPlugin } from "../src/dsh-launch.ts";
import { GatewayTokenAuthority, gatewayTokens } from "../src/gateway-auth.ts";

// These are config builders and audited in-process stubs. Never spawn an installed agent.
const input = (extra: Partial<LaunchInput> = {}): LaunchInput => ({ bin: "/never-run-agent", port: 18765,
  model: "p/main", token: "test-session-token", sessionDir: "/tmp/es-config-only", task: "fake task", ...extra });
const mcp = { url: "http://127.0.0.1:18765/mcp", headers: { Authorization: "Bearer test-mcp-token", "x-easyswitch-depth": "2" } };

test("dsh exposes only model-owned effort levels and applies the selected main level", () => {
  const yaml = dshPatch(input({ effort: "high", modelEfforts: { "p/main": ["none", "high"] } }));
  assert.match(yaml, /reasoningEfforts: \{"off":"none","high":"high"\}/);
  assert.match(yaml, /reasoningEffort: "high"/);
  assert.doesNotMatch(yaml, /"low"|"medium"|"max"/);
  assert.match(dshPatch(input({ effort: "none", modelEfforts: { "p/main": ["none", "high"] } })), /reasoningEffort: "off"/);
  assert.throws(() => dshPatch(input({ effort: "off" })), /没有所选/, "do not invent a thinking capability to satisfy dsh's nonempty active-level rule");
  assert.match(dshPatch(input({ effort: "max" })), /reasoningEfforts: \{"max":"max"\}/);
  assert.doesNotMatch(dshPatch(input()), /reasoningEffort/);
  assert.match(dshPatch(input({ modelEfforts: { "p/main": [] } })), /reasoningEfforts: false/);
  assert.throws(() => dshPatch(input({ effort: "ultra" })), /不支持/);
  assert.throws(() => dshPatch(input({ effort: "high", modelEfforts: { "p/main": ["low"] } })), /没有所选/);
});

test("dsh declares every tier and preserves required replaced plugin settings", () => {
  const yaml = dshPatch(input({ tiers: { subagent: "p/child", small: "p/small", title: "p/title", compaction: "p/summary" }, effort: "high" }));
  for (const model of ["main", "child", "small", "title", "summary"]) assert.equal(yaml.split(`- id: "p/${model}"`).length - 1, 1);
  assert.match(yaml, /- id: tool-subagent\n  config:\n    provider: spawn\n    toolName: subagent\n    backgroundMode: continuable\n    agentOptions:\n      provider: easyswitch\n      model: "p\/child"/);
  assert.match(yaml, /targetWords: 5\n    targetCjkCharacters: 10\n    maxInputBytes: 4096\n    maxOutputTokens: 64\n    timeoutMs: 60000\n    provider: easyswitch\n    model: "p\/title"/);
  assert.match(yaml, /summarizationProvider: easyswitch\n    summarizationModel: "p\/summary"/);
  assert.doesNotMatch(yaml.split("- id: tool-subagent")[1]!, /reasoningEffort/, "main effort is not imposed on a different child model");
  const fallback = dshPatch(input({ tiers: { small: "p/tiny" } }));
  assert.match(fallback, /model: "p\/tiny"/);
  assert.match(fallback, /summarizationModel: "p\/tiny"/);
});

test("dsh MCP patch preserves depth and prepares only an already-installed plugin link", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "es-dsh-fixture-"));
  try {
    const source = join(root, "install", "node_modules", "@deepseek-ai", "dsh-mcp-client");
    mkdirSync(source, { recursive: true });
    const manifest = JSON.stringify({ name: "@deepseek-ai/dsh-mcp-client", version: "fixture" });
    writeFileSync(join(source, "package.json"), manifest);
    const bin = join(root, "install", "bin", "dsh");
    assert.equal(findDshMcpPlugin(bin), source, "package resolution reads metadata without executing the binary");
    const session = join(root, "session"); mkdirSync(session);
    const spec = LAUNCHERS.dsh!.headless!(input({ bin, sessionDir: session, mcp }));
    assert.match(spec.files!["patch.yml"]!, /- insert:\n    - id: mcp-easyswitch/);
    assert.match(spec.files!["patch.yml"]!, /"x-easyswitch-depth": "2"/);
    materialize(spec, session);
    const link = join(session, "dsh-home", "profiles", "node_modules", "@deepseek-ai", "dsh-mcp-client");
    assert.ok(lstatSync(link).isSymbolicLink());
    assert.equal(readlinkSync(link), source);
    assert.equal(readFileSync(join(source, "package.json"), "utf8"), manifest);
    assert.equal(lstatSync(join(session, "patch.yml")).mode & 0o777, 0o600);
    rmSync(session, { recursive: true });
    assert.ok(existsSync(join(source, "package.json")), "cleanup does not follow the link into the installed package");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dsh plugin preparation fails closed on missing packages and linked destination ancestors", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "es-dsh-fixture-"));
  try {
    const session = join(root, "session"); mkdirSync(session);
    assert.throws(() => prepareDshMcpPlugin("/never-run", session, join(root, "missing")), /找不到已安装/);
    assert.deepEqual(Object.keys(LAUNCHERS.dsh!.headless!(input()).files!), ["patch.yml"]);
    const source = join(root, "package"); mkdirSync(source);
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-mcp-client" }));
    const original = join(root, "original-home"); mkdirSync(original); writeFileSync(join(original, "sentinel"), "untouched");
    symlinkSync(original, join(session, "dsh-home"), "dir");
    assert.throws(() => prepareDshMcpPlugin("/never-run", session, source), /拒绝通过符号链接/);
    assert.equal(readFileSync(join(original, "sentinel"), "utf8"), "untouched");
    assert.ok(!existsSync(join(original, "profiles")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("dsh's explicit plugin override validates its package and never falls back on an invalid path", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "es-dsh-override-"));
  const previous = process.env.EASYSWITCH_DSH_MCP_PLUGIN;
  try {
    const valid = join(root, "valid"); mkdirSync(valid);
    writeFileSync(join(valid, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-mcp-client" }));
    process.env.EASYSWITCH_DSH_MCP_PLUGIN = valid;
    assert.equal(dshMcpPlugin(), valid, "the compatibility export uses the validated resolver");
    const session = join(root, "session"); mkdirSync(session);
    prepareDshMcpPlugin("/never-run", session);
    assert.equal(readlinkSync(join(session, "dsh-home", "profiles", "node_modules", "@deepseek-ai", "dsh-mcp-client")), valid);
    const sibling = join(root, "install", "node_modules", "@deepseek-ai", "dsh-mcp-client"); mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-mcp-client" }));
    for (const invalid of [root, "relative/plugin", "", join(root, "missing")]) {
      process.env.EASYSWITCH_DSH_MCP_PLUGIN = invalid;
      assert.equal(findDshMcpPlugin(join(root, "install", "bin", "dsh")), undefined, "do not ignore an invalid explicit override and use the sibling installation");
    }
  } finally {
    if (previous === undefined) delete process.env.EASYSWITCH_DSH_MCP_PLUGIN; else process.env.EASYSWITCH_DSH_MCP_PLUGIN = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing dsh MCP plugin degrades only the MCP attachment and explains the task limitation", () => {
  const root = mkdtempSync(join(tmpdir(), "es-dsh-missing-"));
  const home = process.env.DSH_HOME, override = process.env.EASYSWITCH_DSH_MCP_PLUGIN;
  try {
    process.env.DSH_HOME = join(root, "absent-home"); delete process.env.EASYSWITCH_DSH_MCP_PLUGIN;
    const session = join(root, "session"); mkdirSync(session);
    const spec = LAUNCHERS.dsh!.headless!(input({ sessionDir: session, mcp, tiers: { small: "p/tiny" } }));
    materialize(spec, session);
    assert.match(spec.warnings?.[0] ?? "", /任务继续执行但不能调用其他 agent/);
    const patch = readFileSync(join(session, "patch.yml"), "utf8");
    assert.doesNotMatch(patch, /mcp-easyswitch|Bearer test-mcp-token/);
    assert.match(patch, /model: "p\/main"/); assert.match(patch, /summarizationModel: "p\/tiny"/);
    assert.ok(!existsSync(join(root, "absent-home")), "no global/profile directory was created");
  } finally {
    if (home === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = home;
    if (override === undefined) delete process.env.EASYSWITCH_DSH_MCP_PLUGIN; else process.env.EASYSWITCH_DSH_MCP_PLUGIN = override;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Kimi, OMP and AtomCode attach HTTP MCP in their private documented files", () => {
  for (const [agent, home] of [["kimi-cli", "kimi-home"], ["omp", "omp-agent"], ["atomcode", "atomcode"]]) {
    const spec = LAUNCHERS[agent!]!.headless!(input({ mcp }));
    const config = JSON.parse(spec.files![join(input().sessionDir, home!, "mcp.json")]!);
    assert.deepEqual(config.mcpServers.easyswitch, { ...(agent === "omp" ? { type: "http" } : {}), ...mcp });
    const none = LAUNCHERS[agent!]!.headless!(input());
    assert.ok(!Object.keys(none.files!).some(file => file.endsWith("mcp.json")));
    assert.equal(LAUNCHERS[agent!]!.verified, false);
  }
});

test("CodeBuddy uses its documented private root and Messages endpoint without inheriting account or MCP settings", () => {
  const spec = LAUNCHERS.codebuddy!.headless!(input({ mcp, effort: "high", tiers: { small: "p/small", reasoning: "p/deep", subagent: "p/child" } }));
  assert.equal(spec.env.CODEBUDDY_CONFIG_DIR, join(input().sessionDir, "codebuddy"));
  assert.equal(spec.env.CODEBUDDY_BASE_URL, "http://127.0.0.1:18765");
  assert.equal(spec.env.CODEBUDDY_API_KEY, input().token);
  assert.equal(spec.env.CODEBUDDY_SMALL_FAST_MODEL, "p/small");
  assert.equal(spec.env.CODEBUDDY_BIG_SLOW_MODEL, "p/deep");
  assert.equal(spec.env.CODEBUDDY_CODE_SUBAGENT_MODEL, "p/child");
  assert.ok(spec.args.includes("--strict-mcp-config"));
  assert.equal(spec.args[spec.args.indexOf("--setting-sources") + 1], "user");
  assert.equal(spec.args[spec.args.indexOf("-p") + 1], "fake task");
  assert.equal(spec.args[spec.args.indexOf("--effort") + 1], "high");
  assert.ok(spec.unset?.includes("CODEBUDDY_AUTH_TOKEN"));
  assert.ok(spec.unset?.includes("CODEBUDDY_IS_SANDBOX"));
  assert.ok(!spec.args.includes("-y"));
  const mcpFile = spec.args[spec.args.indexOf("--mcp-config") + 1]!;
  assert.deepEqual(JSON.parse(spec.files![mcpFile]!).mcpServers.easyswitch, { type: "http", ...mcp });
  const plain = LAUNCHERS.codebuddy!.headless!(input());
  assert.deepEqual(JSON.parse(plain.files![mcpFile]!).mcpServers, {});
  assert.equal(plain.env.CODEBUDDY_CODE_SUBAGENT_MODEL, "p/main");
  assert.equal(LAUNCHERS.codebuddy!.verified, false);
});

test("Kimi current TS arguments and secondary model are consistent and model-owned", () => {
  const spec = LAUNCHERS["kimi-cli"]!.headless!(input({ tiers: { subagent: "p/child" }, effort: "high", modelEfforts: { "p/main": ["high"] } }));
  assert.deepEqual(spec.args, ["--model", "es/p/main", "-p", "fake task"]);
  assert.ok(spec.unset?.includes("KIMI_MODEL_NAME"));
  assert.ok(spec.unset?.includes("KIMI_CODE_CUSTOM_HEADERS"));
  const config = Object.values(spec.files!)[0]!;
  assert.match(config, /type = "openai"/);
  assert.match(config, /\[secondary_model\]\ndefault_model = "es\/p\/child"/);
  assert.match(config, /\[models\."es\/p\/child"\]/);
  assert.match(config, /support_efforts = \["high"\]/);
  assert.doesNotMatch(config, /"low"|"medium"/);
});

test("OMP uses a one-shot overlay and clears home/profile and model overrides", () => {
  const spec = LAUNCHERS.omp!.headless!(input({ effort: "xhigh", mcp }));
  assert.deepEqual(spec.args.slice(0, 2), ["--config", join(input().sessionDir, "omp-agent", "config.yml")]);
  for (const name of ["OMP_PROFILE", "PI_PROFILE", "CLAUDE_CONFIG_DIR", "PI_CONFIG_FILES", "PI_SMOL_MODEL"]) assert.ok(spec.unset?.includes(name));
  const config = spec.files![join(input().sessionDir, "omp-agent", "config.yml")]!;
  assert.match(config, /enabledProviders: \[\]\nmcp:\n  enableProjectConfig: false/);
  const models = spec.files![join(input().sessionDir, "omp-agent", "models.yml")]!;
  assert.match(models, /"efforts":\["xhigh"\]/);
  assert.doesNotMatch(models, /\[low, medium, high\]/);
});

test("Trae gets a complete private config, Responses provider, explicit MCP stdio bridge and small model", () => {
  const spec = LAUNCHERS["trae-agent"]!.headless!(input({ mcp, tiers: { small: "p/tiny" } }));
  const config = JSON.parse(spec.files!["trae-config.yaml"]!);
  assert.equal(config.model_providers.easyswitch.provider, "openai");
  assert.equal(config.model_providers.easyswitch.base_url, "http://127.0.0.1:18765/v1");
  assert.equal(config.models.small.model, "p/tiny");
  assert.equal(config.lakeview.model, "small");
  assert.equal(config.agents.trae_agent.enable_lakeview, true);
  assert.deepEqual(config.allow_mcp_servers, ["easyswitch"]);
  assert.equal(config.mcp_servers.easyswitch.command, process.execPath);
  assert.match(config.mcp_servers.easyswitch.args[0], /es-mcp-stdio\.ts$/);
  assert.deepEqual(JSON.parse(config.mcp_servers.easyswitch.env.EASYSWITCH_MCP_HEADERS), mcp.headers);
  assert.equal(config.mcp_servers.easyswitch.env.EASYSWITCH_MCP_URL, mcp.url);
  assert.ok(spec.args.includes(join(input().sessionDir, "trae-config.yaml")));
  assert.ok(spec.args.includes(join(input().sessionDir, "trae-trajectory.json")));
  assert.ok(!spec.args.includes("--api-key")); assert.ok(!spec.args.includes(input().token));
  assert.equal(spec.env.OPENAI_API_KEY, input().token);
  const plain = JSON.parse(LAUNCHERS["trae-agent"]!.headless!(input()).files!["trae-config.yaml"]!);
  assert.equal(plain.mcp_servers, undefined);
  assert.equal(plain.agents.trae_agent.enable_lakeview, false);
});

test("Codex and Hermes send the issued gateway token, without persistent token text", () => {
  for (const form of ["interactive", "headless"] as const) {
    const codex = LAUNCHERS.codex![form]!(input());
    assert.equal(codex.env.EASYSWITCH_GATEWAY_TOKEN, input().token);
    assert.match(codex.args.join(" "), /env_key="EASYSWITCH_GATEWAY_TOKEN"/);
    const hermes = LAUNCHERS.hermes![form]!(input({ tiers: { subagent: "p/child" } }));
    assert.equal(hermes.env.EASYSWITCH_GATEWAY_TOKEN, input().token);
    assert.match(Object.values(hermes.files!)[0]!, /\$\{EASYSWITCH_GATEWAY_TOKEN\}/);
    assert.doesNotMatch(Object.values(hermes.files!)[0]!, /test-session-token|es-session-hermes-private/);
  }
});

test("the remote Gemini and Copilot effort settings remain private and retain runtime-unverified caveats", () => {
  const gemini = LAUNCHERS["gemini-cli"]!.headless!(input({ effort: "medium", mcp }));
  const settings = JSON.parse(gemini.files![join(input().sessionDir, "gemini-home", ".gemini", "settings.json")]!);
  assert.deepEqual(settings.modelConfigs.overrides, [{ match: { model: "p/main" }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: "MEDIUM" } } } }]);
  assert.equal(settings.mcpServers.easyswitch.httpUrl, mcp.url);
  const plainGemini = LAUNCHERS["gemini-cli"]!.headless!(input());
  assert.equal(JSON.parse(plainGemini.files![join(input().sessionDir, "gemini-home", ".gemini", "settings.json")]!).modelConfigs.overrides, undefined);
  const copilot = LAUNCHERS["copilot-cli"]!.headless!(input({ effort: "xhigh" }));
  assert.equal(copilot.env.COPILOT_HOME, join(input().sessionDir, "copilot-home"));
  assert.deepEqual(JSON.parse(copilot.files![join(input().sessionDir, "copilot-home", "settings.json")]!), { effortLevel: "xhigh" });
  assert.equal(copilot.env.COPILOT_PROVIDER_API_KEY, input().token);
  for (const id of ["gemini-cli", "copilot-cli"]) {
    assert.equal(LAUNCHERS[id]!.verified, false);
    assert.match(LAUNCHERS[id]!.caveat!, /凭记忆|没有实测/);
  }
});

test("Gemini registers every gateway model in its private dynamic menu without inventing capabilities", () => {
  const models = ["p/main", "p/second", "pool/shared", "quoted/model-\"name"];
  for (const form of ["interactive", "headless"] as const) {
    const spec = LAUNCHERS["gemini-cli"]![form]!(input({ models: [...models, "p/main"], mcp, effort: "low" }));
    assert.equal(spec.env.GEMINI_CLI_HOME, join(input().sessionDir, "gemini-home"));
    assert.equal(spec.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined, "user-owned system overlays are ignored by current Gemini trust checks");
    const path = join(spec.env.GEMINI_CLI_HOME!, ".gemini", "settings.json");
    const settings = JSON.parse(spec.files![path]!);
    assert.equal(settings.experimental.dynamicModelConfiguration, true);
    assert.equal(settings.security.auth.selectedType, "gemini-api-key");
    assert.equal(settings.model.name, "p/main");
    assert.deepEqual(Object.keys(settings.modelConfigs.modelDefinitions), models);
    for (const model of models) assert.deepEqual(settings.modelConfigs.modelDefinitions[model], { displayName: model, tier: "custom", family: "custom", isVisible: true, isPreview: false });
    assert.deepEqual(settings.mcpServers.easyswitch.headers, mcp.headers);
    assert.equal(settings.modelConfigs.overrides[0].match.model, "p/main");
    assert.ok(!JSON.stringify(spec.args).includes(input().token));
    assert.equal(LAUNCHERS["gemini-cli"]!.verified, false);
  }
});

test("Qwen uses its own modelProviders schema and private writable settings, with token references", () => {
  const models = ["p/main", "p/other", "pool/shared"];
  for (const form of ["interactive", "headless"] as const) {
    const spec = LAUNCHERS["qwen-code"]![form]!(input({ models, effort: "high" }));
    assert.equal(spec.env.QWEN_HOME, join(input().sessionDir, "qwen-home"));
    assert.equal(spec.env.QWEN_RUNTIME_DIR, spec.env.QWEN_HOME);
    assert.equal(spec.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined);
    assert.equal(spec.env.EASYSWITCH_GATEWAY_TOKEN, input().token);
    const system = JSON.parse(spec.files![spec.env.QWEN_CODE_SYSTEM_SETTINGS_PATH!]!);
    const user = JSON.parse(spec.files![join(spec.env.QWEN_HOME!, "settings.json")]!);
    assert.deepEqual(system, user);
    assert.equal(system.security.auth.selectedType, "openai");
    assert.equal(system.model.name, "p/main");
    assert.deepEqual(system.modelProviders.openai.map((m: {id:string}) => m.id), models);
    for (const model of system.modelProviders.openai) {
      assert.equal(model.envKey, "EASYSWITCH_GATEWAY_TOKEN");
      assert.equal(model.baseUrl, "http://127.0.0.1:18765/v1");
      if (model.id !== "p/main") assert.equal(model.generationConfig, undefined);
    }
    assert.deepEqual(system.modelProviders.openai[0].generationConfig, { reasoning: { effort: "high" } });
    assert.ok(!JSON.stringify(spec.files).includes(input().token), "provider entries reference an environment variable instead of storing a key");
    assert.equal(system.modelConfigs, undefined, "Qwen must not inherit Gemini thinking or menu settings");
    assert.deepEqual(spec.args.slice(0, 2), ["--auth-type", "openai"]);
  }
});

const copilotInheritedOverrides = [
  "COPILOT_PROVIDERS_CONFIG", "COPILOT_PROVIDER_API_KEY_COMMAND", "COPILOT_PROVIDER_BEARER_TOKEN", "COPILOT_PROVIDER_HEADERS", "COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL",
  "COPILOT_PROVIDER_WIRE_API", "COPILOT_PROVIDER_MAX_PROMPT_TOKENS", "COPILOT_PROVIDER_MAX_OUTPUT_TOKENS", "COPILOT_PROVIDER_AZURE_API_VERSION",
  "COPILOT_ALLOW_ALL", "COPILOT_PLAN_THEN_AUTOPILOT",
];

test("Copilot retains documented single-model BYOK without guessing registry fields or using the original home", () => {
  for (const form of ["interactive", "headless"] as const) {
    const spec = LAUNCHERS["copilot-cli"]![form]!(input({ models: ["p/main", "p/other"], mcp }));
    assert.equal(spec.env.COPILOT_HOME, join(input().sessionDir, "copilot-home"));
    assert.equal(spec.env.COPILOT_CACHE_HOME, join(spec.env.COPILOT_HOME!, "cache"));
    assert.equal(spec.env.COPILOT_MODEL, "p/main");
    assert.equal(spec.env.COPILOT_PROVIDER_BASE_URL, "http://127.0.0.1:18765/v1");
    assert.equal(spec.env.COPILOT_PROVIDER_TYPE, "openai");
    assert.equal(spec.env.COPILOT_PROVIDER_API_KEY, input().token);
    assert.deepEqual(JSON.parse(spec.files![join(spec.env.COPILOT_HOME!, "settings.json")]!), {});
    assert.ok(!Object.keys(spec.files!).some(path => path.endsWith("providers.json")), "registry inner schema is still unverified");
    assert.deepEqual(spec.unset, copilotInheritedOverrides);
    for (const inherited of copilotInheritedOverrides) assert.equal(spec.env[inherited], undefined, "do not replace ambient overrides with guessed values");
    assert.ok(commandLine(spec).startsWith(`env ${copilotInheritedOverrides.map(name => `-u ${name}`).join(" ")} `));
    assert.ok(!spec.args.some(arg => ["--allow-all", "--autopilot", "--plan", "--mode", "--yolo"].includes(arg)));
    const flag = spec.args.indexOf("--additional-mcp-config");
    const path = spec.args[flag + 1]!;
    assert.ok(path.startsWith("@"));
    assert.deepEqual(JSON.parse(spec.files![path.slice(1)]!).mcpServers.easyswitch.headers, mcp.headers);
    assert.ok(!JSON.stringify(spec.args).includes("test-mcp-token"));
    assert.ok(!commandLine(spec).includes("test-mcp-token"));
  }
});

test("Copilot headless removes ambient overrides before the in-process spawn stub without changing parent settings or auth", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "es-copilot-env-"));
  const preserved = { COPILOT_OFFLINE: "false", COPILOT_GITHUB_TOKEN: "fixture-copilot-github", GH_TOKEN: "fixture-gh", GITHUB_TOKEN: "fixture-github" };
  const ambient: Record<string, string> = { ...Object.fromEntries(copilotInheritedOverrides.map(name => [name, "true"])), ...preserved,
    COPILOT_HOME: root, COPILOT_CACHE_HOME: join(root, "native-cache"), COPILOT_MODEL: "fixture/ambient",
    COPILOT_PROVIDER_TYPE: "fixture-provider", COPILOT_PROVIDER_BASE_URL: "http://127.0.0.1:1/unused", COPILOT_PROVIDER_API_KEY: "fixture-ambient-key" };
  const previous = Object.fromEntries(Object.keys(ambient).map(name => [name, process.env[name]]));
  const authority = new GatewayTokenAuthority();
  let capturedEnv: NodeJS.ProcessEnv = {}, capturedArgs: readonly string[] = [], capturedCommand = "", settings = "", mcpConfig = "", privateHome = "", calls = 0, fileMode = 0;
  const runtime: HeadlessProcessRuntime = { spawn: ((command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
    calls++; capturedCommand = command; capturedEnv = { ...options.env }; capturedArgs = [...args];
    privateHome = capturedEnv.COPILOT_HOME!;
    settings = readFileSync(join(privateHome, "settings.json"), "utf8");
    mcpConfig = readFileSync(join(privateHome, "easyswitch-mcp.json"), "utf8");
    fileMode = lstatSync(join(privateHome, "easyswitch-mcp.json")).mode & 0o777;
    // Capture production environment assembly, but never create an OS child or execute an agent.
    throw new Error("fixture stops before process launch");
  }) as unknown as HeadlessProcessRuntime["spawn"] };
  try {
    writeFileSync(join(root, "settings.json"), "untouched native fixture", { mode: 0o600 });
    Object.assign(process.env, ambient);
    const result = await runHeadless("copilot-cli", { bin: "/never-run-agent", port: 18765, model: "p/main", task: "fake task", effort: "high" }, { gatewayAuth: authority }, runtime);
    assert.equal(calls, 1); assert.equal(capturedCommand, "/never-run-agent"); assert.equal(result.exitCode, null);
    for (const name of copilotInheritedOverrides) assert.equal(capturedEnv[name], undefined, name);
    for (const [name, value] of Object.entries(preserved)) assert.equal(capturedEnv[name], value, name);
    assert.equal(capturedEnv.COPILOT_PROVIDER_BASE_URL, "http://127.0.0.1:18765/v1");
    assert.equal(capturedEnv.COPILOT_PROVIDER_TYPE, "openai"); assert.equal(capturedEnv.COPILOT_MODEL, "p/main");
    assert.notEqual(capturedEnv.COPILOT_PROVIDER_API_KEY, ambient.COPILOT_PROVIDER_API_KEY);
    assert.equal(basename(privateHome), "copilot-home"); assert.notEqual(privateHome, root);
    assert.equal(capturedEnv.COPILOT_CACHE_HOME, join(privateHome, "cache"));
    assert.deepEqual(JSON.parse(settings), { effortLevel: "high" });
    assert.equal(JSON.parse(mcpConfig).mcpServers.easyswitch.headers.Authorization, `Bearer ${capturedEnv.COPILOT_PROVIDER_API_KEY}`);
    assert.equal(capturedArgs[capturedArgs.indexOf("--additional-mcp-config") + 1], `@${join(privateHome, "easyswitch-mcp.json")}`);
    assert.ok(!JSON.stringify(capturedArgs).includes(capturedEnv.COPILOT_PROVIDER_API_KEY!));
    if (process.platform !== "win32") assert.equal(fileMode, 0o600);
    assert.deepEqual(authority.list(), []); assert.ok(!existsSync(privateHome));
    assert.equal(readFileSync(join(root, "settings.json"), "utf8"), "untouched native fixture");
    for (const [name, value] of Object.entries(ambient)) assert.equal(process.env[name], value, "the parent environment stays unchanged");
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("menu config materialization writes only the owned session and leaves native fixture settings untouched", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "es-menu-config-"));
  try {
    const original = join(root, "native-settings.json");
    writeFileSync(original, "untouched fixture", { mode: 0o600 });
    for (const id of ["gemini-cli", "qwen-code", "copilot-cli"]) {
      const sessionDir = join(root, id);
      const spec = LAUNCHERS[id]!.interactive!(input({ sessionDir, models: ["p/main", "p/other"] }));
      assert.ok(Object.keys(spec.files!).every(path => path.startsWith(sessionDir + "/")));
      materialize(spec, sessionDir);
      for (const [path, contents] of Object.entries(spec.files!)) {
        assert.equal(readFileSync(path, "utf8"), contents);
        if (process.platform !== "win32") assert.equal(lstatSync(path).mode & 0o777, 0o600);
      }
    }
    assert.equal(readFileSync(original, "utf8"), "untouched fixture");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runHeadless revokes authentication and removes the directory when spec generation fails", async () => {
  let dir = ""; let token = "";
  LAUNCHERS["fixture-config-failure"] = { verified: false, headless: i => {
    dir = i.sessionDir; token = i.token;
    const auth = gatewayTokens.authenticate({ authorization: `Bearer ${token}` }, undefined, "mcp");
    assert.equal(auth?.depth, 2); assert.equal(auth.allowNativeClaude, false);
    throw new Error("fixture config failure");
  } };
  try {
    await assert.rejects(runHeadless("fixture-config-failure", { bin: "/never-run", port: 1, model: "p/m" }, { depth: 2 }), /fixture config failure/);
    assert.ok(!existsSync(dir));
    assert.equal(gatewayTokens.authenticate({ authorization: `Bearer ${token}` }), undefined);
  } finally { delete LAUNCHERS["fixture-config-failure"]; }
});

test("an already cancelled headless run never spawns and still revokes its token", async () => {
  let token = ""; let dir = "";
  LAUNCHERS["fixture-cancelled"] = { verified: false, headless: i => {
    token = i.token; dir = i.sessionDir;
    assert.equal(gatewayTokens.authenticate({ authorization: `Bearer ${token}` }, undefined, "mcp"), undefined);
    return { command: "/never-run", args: [], env: {} };
  } };
  try {
    const result = await runHeadless("fixture-cancelled", { bin: "/never-run", port: 1, model: "p/m" }, { attachMcp: false, signal: AbortSignal.abort() });
    assert.equal(result.exitCode, null);
    assert.ok(!existsSync(dir));
    assert.equal(gatewayTokens.authenticate({ authorization: `Bearer ${token}` }), undefined);
  } finally { delete LAUNCHERS["fixture-cancelled"]; }
});

test("runHeadless issues and revokes through the injected authority without touching the global registry", async () => {
  const authority = new GatewayTokenAuthority();
  const globalBefore = gatewayTokens.list();
  let token = ""; let dir = "";
  LAUNCHERS["fixture-injected-auth"] = { verified: false, headless: i => {
    token = i.token; dir = i.sessionDir;
    assert.equal(authority.authenticate({ authorization: `Bearer ${token}` }, undefined, "mcp")?.depth, 2);
    assert.equal(gatewayTokens.authenticate({ authorization: `Bearer ${token}` }), undefined);
    assert.equal(i.mcp?.headers.Authorization, `Bearer ${token}`);
    throw new Error("injected authority fixture failure");
  } };
  try {
    await assert.rejects(runHeadless("fixture-injected-auth", { bin: "/never-run", port: 1, model: "p/m" },
      { gatewayAuth: authority, depth: 2 }), /injected authority fixture failure/);
    assert.equal(authority.authenticate({ authorization: `Bearer ${token}` }), undefined);
    assert.deepEqual(authority.list(), []);
    assert.deepEqual(gatewayTokens.list(), globalBefore);
    assert.ok(!existsSync(dir));
  } finally { delete LAUNCHERS["fixture-injected-auth"]; }
});
