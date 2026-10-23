import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { commandLine, LAUNCHERS, materialize, type LaunchInput } from "../src/agent-launch.ts";
import { dshPatch } from "../src/dsh-launch.ts";

// These are pure config builders. Never spawn an installed agent.
const input = (extra: Partial<LaunchInput> = {}): LaunchInput => ({ bin: "/never-run-agent", port: 18765,
  model: "p/main", token: "test-session-token", sessionDir: "/tmp/es-config-only", task: "fake task", ...extra });

test("OpenCode does not invent variants for unknown or explicitly empty model capabilities", () => {
  for (const form of ["interactive", "headless"] as const) {
    const spec = LAUNCHERS.opencode![form]!(input({ effort: "xhigh", models: ["p/empty", "p/unknown"], modelEfforts: { "p/empty": [] } }));
    const config = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!);
    for (const model of ["p/main", "p/empty", "p/unknown"]) {
      assert.deepEqual(Object.keys(config.provider.easyswitch.models[model].variants ?? {}), [], model);
    }
  }
});

test("OpenCode variants preserve each exact model's vocabulary and order without leaking the main effort", () => {
  const modelEfforts = { "p/main": ["xhigh", "none", "high"], "q/main": ["off", "medium"], "p/small": ["max", "low"], "p/child": ["ultra"] };
  for (const form of ["interactive", "headless"] as const) {
    const original = input({ effort: "xhigh", models: ["p/main", "q/main", "p/small", "q/main"], tiers: { small: "p/small", subagent: "p/child" }, modelEfforts });
    const before = structuredClone(original), spec = LAUNCHERS.opencode![form]!(original);
    const config = JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!), models = config.provider.easyswitch.models;
    assert.deepEqual(Object.keys(models), Object.keys(modelEfforts), "main/menu/tier duplicates are registered once, not merged by upstream name");
    for (const [model, levels] of Object.entries(modelEfforts)) {
      assert.deepEqual(Object.keys(models[model].variants), levels);
      assert.deepEqual(models[model].variants, Object.fromEntries(levels.map(level => [level, { reasoningEffort: level }])));
    }
    assert.equal(spec.args[spec.args.indexOf("--model") + 1], "easyswitch/p/main");
    assert.equal(spec.args[spec.args.indexOf("--variant") + 1], "xhigh");
    assert.equal(config.small_model, "easyswitch/p/small");
    assert.deepEqual(config.agent, { general: { model: "easyswitch/p/child" }, explore: { model: "easyswitch/p/child" } });
    assert.deepEqual(config.provider.easyswitch.options, { baseURL: "http://127.0.0.1:18765/v1", apiKey: original.token });
    assert.deepEqual(original, before, "config generation never mutates the supplied model menu or capabilities");
  }
});

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

test("CodeBuddy uses its documented private root and Messages endpoint without inheriting account or MCP settings", () => {
  const spec = LAUNCHERS.codebuddy!.headless!(input({ effort: "high", tiers: { small: "p/small", reasoning: "p/deep", subagent: "p/child" } }));
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
  assert.deepEqual(JSON.parse(spec.files![mcpFile]!).mcpServers, {});
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
  const spec = LAUNCHERS.omp!.headless!(input({ effort: "xhigh" }));
  assert.deepEqual(spec.args.slice(0, 2), ["--config", join(input().sessionDir, "omp-agent", "config.yml")]);
  for (const name of ["OMP_PROFILE", "PI_PROFILE", "CLAUDE_CONFIG_DIR", "PI_CONFIG_FILES", "PI_SMOL_MODEL"]) assert.ok(spec.unset?.includes(name));
  const config = spec.files![join(input().sessionDir, "omp-agent", "config.yml")]!;
  assert.match(config, /enabledProviders: \[\]\nmcp:\n  enableProjectConfig: false/);
  const models = spec.files![join(input().sessionDir, "omp-agent", "models.yml")]!;
  assert.match(models, /"efforts":\["xhigh"\]/);
  assert.doesNotMatch(models, /\[low, medium, high\]/);
});

test("Trae gets a complete private config, Responses provider and small model without a dispatch bridge", () => {
  const spec = LAUNCHERS["trae-agent"]!.headless!(input({ tiers: { small: "p/tiny" } }));
  const config = JSON.parse(spec.files!["trae-config.yaml"]!);
  assert.equal(config.model_providers.easyswitch.provider, "openai");
  assert.equal(config.model_providers.easyswitch.base_url, "http://127.0.0.1:18765/v1");
  assert.equal(config.models.small.model, "p/tiny");
  assert.equal(config.lakeview.model, "small");
  assert.equal(config.agents.trae_agent.enable_lakeview, true);
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
  const gemini = LAUNCHERS["gemini-cli"]!.headless!(input({ effort: "medium" }));
  const settings = JSON.parse(gemini.files![join(input().sessionDir, "gemini-home", ".gemini", "settings.json")]!);
  assert.deepEqual(settings.modelConfigs.overrides, [{ match: { model: "p/main" }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: "MEDIUM" } } } }]);
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
    const spec = LAUNCHERS["gemini-cli"]![form]!(input({ models: [...models, "p/main"], effort: "low" }));
    assert.equal(spec.env.GEMINI_CLI_HOME, join(input().sessionDir, "gemini-home"));
    assert.equal(spec.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, undefined, "user-owned system overlays are ignored by current Gemini trust checks");
    const path = join(spec.env.GEMINI_CLI_HOME!, ".gemini", "settings.json");
    const settings = JSON.parse(spec.files![path]!);
    assert.equal(settings.experimental.dynamicModelConfiguration, true);
    assert.equal(settings.security.auth.selectedType, "gemini-api-key");
    assert.equal(settings.model.name, "p/main");
    assert.deepEqual(Object.keys(settings.modelConfigs.modelDefinitions), models);
    for (const model of models) assert.deepEqual(settings.modelConfigs.modelDefinitions[model], { displayName: model, tier: "custom", family: "custom", isVisible: true, isPreview: false });
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
    const spec = LAUNCHERS["copilot-cli"]![form]!(input({ models: ["p/main", "p/other"] }));
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
    assert.ok(!spec.args.includes("--additional-mcp-config"));
    assert.ok(!Object.keys(spec.files!).some(path => path.endsWith("mcp.json")));
    assert.ok(!JSON.stringify(spec.args).includes("test-mcp-token"));
    assert.ok(!commandLine(spec).includes("test-mcp-token"));
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
