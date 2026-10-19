import { join } from "node:path";
import type { AgentLauncher, LaunchInput, LaunchSpec } from "./agent-launch.ts";

/**
 * Launchers for the command-line agents beyond the first few. Each one gives the agent a private
 * directory (or environment) for this one launch that points it at the gateway, so the agent's own
 * config is never read or written, and the directory is deleted afterwards.
 *
 * None of these has been run against the real program here, so `verified` is false everywhere and
 * `caveat` say exactly which parts were written from the vendors' own file formats
 * (reliable) and which were guessed from memory (check with `--help` before relying on them).
 * A private directory also means none of the user's own logins or settings are visible to the agent.
 */

const gateway = (i: LaunchInput) => `http://127.0.0.1:${i.port}`;
/** A quoted string that is valid in JSON, YAML and TOML. */
const q = (s: string) => JSON.stringify(s);
const bare = (model: string) => model.slice(model.indexOf("/") + 1);
const levels = (all: string[]) => all;

const dir = (i: LaunchInput, name: string) => join(i.sessionDir, name);

/** The models to write into an agent's own list: the default first, then everything it may be offered, then the tier models. */
export const allModels = (i: LaunchInput): string[] => [...new Set([i.model, ...(i.models ?? []), ...Object.values(i.tiers ?? {})])].filter(Boolean);

/** Both forms share everything but the task. */
function forms(build: (i: LaunchInput, headless: boolean) => LaunchSpec, opts: { interactive?: boolean; headless?: boolean } = {}): Pick<AgentLauncher, "interactive" | "headless"> {
  return {
    ...(opts.interactive === false ? {} : { interactive: (i: LaunchInput) => build(i, false) }),
    ...(opts.headless === false ? {} : { headless: (i: LaunchInput) => build(i, true) }),
  };
}

/** Task text only when headless. */
const task = (i: LaunchInput, headless: boolean, ...before: string[]) => (headless ? [...before, i.task ?? ""] : []);

// ---------------------------------------------------------------- kimi-cli

function kimiToml(i: LaunchInput): string {
  return [
    `default_model = ${q(`es/${i.model}`)}`,
    "",
    "[providers.es]",
    'type = "openai"',
    `base_url = ${q(`${gateway(i)}/v1`)}`,
    `api_key = ${q(i.token)}`,
    "",
    ...allModels(i).flatMap(model => {
      const efforts = (i.modelEfforts?.[model] ?? (model === i.model && i.effort ? [i.effort] : []))
        .filter(effort => ["low", "medium", "high"].includes(effort));
      return [`[models.${q(`es/${model}`)}]`, 'provider = "es"', `model = ${q(model)}`, "max_context_size = 128000",
        `capabilities = ${JSON.stringify(efforts.length ? ["thinking", "tool_use"] : ["tool_use"])}`,
        ...(efforts.length ? [`support_efforts = ${JSON.stringify(efforts)}`] : []),
        ...(model === i.model && i.effort && efforts.includes(i.effort) ? [`default_effort = ${q(i.effort)}`] : []), ""];
    }),
    ...(i.tiers?.subagent ? ["[secondary_model]", `default_model = ${q(`es/${i.tiers.subagent}`)}`] : []),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- pi and omp (same family, different files)

function piFiles(i: LaunchInput): Record<string, string> {
  return {
    [join(dir(i, "pi-agent"), "models.json")]: JSON.stringify({
      providers: { easyswitch: { name: "EasySwitch", baseUrl: `${gateway(i)}/v1`, api: "openai-completions", apiKey: i.token, models: allModels(i).map(m => ({ id: m, name: bare(m), reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 32000 })) } },
    }),
    [join(dir(i, "pi-agent"), "settings.json")]: JSON.stringify({ defaultProvider: "easyswitch", defaultModel: i.model, ...(i.effort ? { defaultThinkingLevel: i.effort } : {}) }),
  };
}

function ompFiles(i: LaunchInput): Record<string, string> {
  const roles = [`    default: ${q(`easyswitch/${i.model}`)}`, ...(i.tiers?.subagent ? [`    task: ${q(`easyswitch/${i.tiers.subagent}`)}`] : []), ...(i.tiers?.small ? [`    smol: ${q(`easyswitch/${i.tiers.small}`)}`] : [])];
  const models = allModels(i);
  return {
    [join(dir(i, "omp-agent"), "models.yml")]: [
      "providers:",
      "  easyswitch:",
      `    baseUrl: ${q(`${gateway(i)}/v1`)}`,
      "    api: openai-completions",
      `    apiKey: ${q(i.token)}`,
      "    models:",
      ...models.flatMap(m => {
        const efforts = (i.modelEfforts?.[m] ?? (m === i.model && i.effort ? [i.effort] : []))
          .filter(level => ["minimal", "low", "medium", "high", "xhigh", "max"].includes(level));
        return [`      - id: ${q(m)}`, `        name: ${q(bare(m))}`, `        reasoning: ${efforts.length > 0}`,
          "        contextWindow: 200000", "        maxTokens: 32000", "        input: [text]",
          ...(efforts.length ? [`        thinking: ${JSON.stringify({ mode: "effort", efforts })}`] : [])];
      }),
      "",
    ].join("\n"),
    [join(dir(i, "omp-agent"), "config.yml")]: ["modelRoles:", ...roles, ...(i.effort ? [`defaultThinkingLevel: ${q(i.effort)}`] : []),
      "enabledProviders: []", "mcp:", "  enableProjectConfig: false", ""].join("\n"),
  };
}

// ---------------------------------------------------------------- droid

function droidFiles(i: LaunchInput): Record<string, string> {
  const id = `custom:easyswitch/${i.model}`;
  const files: Record<string, string> = {
    [join(dir(i, "factory-home"), ".factory", "settings.json")]: JSON.stringify({
      customModels: allModels(i).map(m => ({ model: m, id: `custom:easyswitch/${m}`, displayName: bare(m), baseUrl: `${gateway(i)}/v1`, apiKey: i.token, provider: "generic-chat-completion-api", maxContextLimit: 200000, maxOutputTokens: 32000, noImageSupport: false })),
      sessionDefaultSettings: { model: id, ...(i.effort ? { reasoningEffort: i.effort } : {}) },
    }),
  };
  return files;
}

// ---------------------------------------------------------------- cline

function clineFiles(i: LaunchInput): Record<string, string> {
  const data = dir(i, "cline-data");
  const files: Record<string, string> = {
    [join(data, "settings", "providers.json")]: JSON.stringify({
      version: 1, lastUsedProvider: "openai-compatible", modes: {},
      providers: { "openai-compatible": { settings: { provider: "openai-compatible", apiKey: i.token, model: i.model, baseUrl: `${gateway(i)}/v1`, headers: { "User-Agent": "cline" }, reasoning: i.effort ? { enabled: true, effort: i.effort } : { enabled: false } }, updatedAt: "2026-01-01T00:00:00.000Z", tokenSource: "manual" } },
    }),
    [join(data, "settings", "models.json")]: JSON.stringify({
      version: 1,
      providers: { "openai-compatible": { provider: { name: "EasySwitch", baseUrl: `${gateway(i)}/v1`, defaultModelId: i.model }, models: Object.fromEntries(allModels(i).map(m => [m, { id: m, name: bare(m), capabilities: ["streaming", "tools", "reasoning"], contextWindow: 200000, maxTokens: 32000 }])) } },
    }),
  };
  return files;
}

// ---------------------------------------------------------------- goose

function gooseFiles(i: LaunchInput): Record<string, string> {
  const config = join(dir(i, "goose"), "config");
  const files: Record<string, string> = {
    [join(config, "custom_providers", "easyswitch.json")]: JSON.stringify({
      name: "easyswitch", engine: "openai", display_name: "EasySwitch", api_key_env: "", base_url: `${gateway(i)}/v1`,
      headers: { Authorization: `Bearer ${i.token}` }, requires_auth: false, skip_canonical_filtering: true, dynamic_models: false,
      models: allModels(i).map(m => ({ name: m, reasoning: true, context_limit: 200000 })),
    }),
  };
  return files;
}

// ---------------------------------------------------------------- crush

function crushFiles(i: LaunchInput): Record<string, string> {
  const models = allModels(i);
  return {
    [join(dir(i, "crush-config"), "crush.json")]: JSON.stringify({
      providers: { easyswitch: { type: "openai", name: "EasySwitch", base_url: `${gateway(i)}/v1`, api_key: i.token, models: models.map(m => ({ id: m, name: bare(m), context_window: 200000, default_max_tokens: 16384, can_reason: true })) } },
      models: { large: { provider: "easyswitch", model: i.model, ...(i.effort ? { reasoning_effort: i.effort } : {}) }, small: { provider: "easyswitch", model: i.tiers?.small ?? i.model } },
    }),
  };
}

// ---------------------------------------------------------------- grok

function grokToml(i: LaunchInput): string {
  return [
    "[models]",
    `default = ${q(`easyswitch/${i.model}`)}`,
    ...(i.effort ? [`default_reasoning_effort = ${q(i.effort)}`] : []),
    "",
    ...allModels(i).flatMap(m => [
      `[model.${q(`easyswitch/${m}`)}]`, `model = ${q(m)}`, `name = ${q(bare(m))}`, `base_url = ${q(`${gateway(i)}/v1`)}`, `api_key = ${q(i.token)}`,
      'api_backend = "chat_completions"', "context_window = 200000", 'reasoning_efforts = ["low", "medium", "high"]', "",
    ]),
    "[features]",
    "campaigns = false",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- minimax code (Anthropic wire, base URL without /v1)

function mcodeYaml(i: LaunchInput): string {
  return [
    `defaultModel: ${q(`custom_provider:easyswitch/${i.model}`)}`,
    "custom_provider:",
    "  easyswitch:",
    "    name: easyswitch",
    "    kind: custom",
    "    enabled: true",
    "    api: anthropic-messages",
    "    options:",
    `      apiKey: ${q(i.token)}`,
    `      baseURL: ${q(gateway(i))}`,
    "      authMode: api-key",
    "    models:",
    ...allModels(i).flatMap(m => [
      `      ${q(m)}:`, `        name: ${q(bare(m))}`, "        limit: { context: 200000, output: 16384 }", "        reasoning: true",
      `        thinking: { effortOptions: [low, medium, high], defaultEffort: ${i.effort ?? "high"} }`,
    ]),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- qoder

function qoderSettings(i: LaunchInput): string {
  const alias = `easyswitch/${i.model}`;
  return JSON.stringify({
    providers: { easyswitch: { displayName: "EasySwitch", protocol: "openai", baseUrl: `${gateway(i)}/v1`, apiKey: i.token, model: i.model,
      models: allModels(i).map(m => ({ model: m, displayName: bare(m), contextWindow: 200000, maxOutputTokens: 16384, capabilities: { tools: true, vision: false, thinking: { modes: ["enabled"], supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"], requiresBudgetForEnabled: false } } })) } },
    model: { name: alias, ...(i.effort ? { preferences: { [alias]: { reasoning: { effort: i.effort } } } } : {}) },
  });
}

// ---------------------------------------------------------------- openclaw

function openclawConfig(i: LaunchInput): string {
  return JSON.stringify({
    models: { mode: "merge", providers: { easyswitch: { baseUrl: `${gateway(i)}/v1`, apiKey: "${EASYSWITCH_OPENCLAW_KEY}", api: "openai-completions", models: allModels(i).map(m => ({ id: m, name: bare(m), contextWindow: 200000, input: ["text", "image"] })) } } },
    agents: { defaults: { model: { primary: `easyswitch/${i.model}` }, ...(i.tiers?.subagent ? { subagents: { model: `easyswitch/${i.tiers.subagent}` } } : {}) } },
  });
}

// ---------------------------------------------------------------- atomcode

function atomcodeToml(i: LaunchInput): string {
  return [
    `default_provider = ${q(`es/${i.model}`)}`,
    `default_model = ${q(`es/${i.model}`)}`,
    "",
    '[provider_accounts."es"]',
    'provider = "openai-compatible"',
    `base_url = ${q(`${gateway(i)}/v1`)}`,
    `api_key = ${q(i.token)}`,
    "",
    ...allModels(i).flatMap(model => {
      const efforts = (i.modelEfforts?.[model] ?? (model === i.model && i.effort ? [i.effort] : []))
        .filter(level => ["low", "medium", "high", "xhigh", "max"].includes(level));
      return [`[models.${q(`es/${model}`)}]`, 'account = "es"', `model = ${q(model)}`,
        "context_window = 128000", "max_tokens = 8192", "supports_vision = false",
        `reasoning_effort_levels = ${JSON.stringify(efforts)}`,
        ...(model === i.model && i.effort && efforts.includes(i.effort) ? [`reasoning_effort = ${q(i.effort)}`] : []), ""];
    }),
  ].join("\n");
}

// ---------------------------------------------------------------- trae-agent

/** Trae reads JSON-compatible YAML; its HTTP config fields currently throw at runtime. */
function traeFiles(i: LaunchInput): Record<string, string> {
  const model = (id: string) => ({ model_provider: "easyswitch", model: id, max_tokens: 8192,
    temperature: 0.5, top_p: 1, top_k: 0, max_retries: 2, parallel_tool_calls: true });
  return { "trae-config.yaml": JSON.stringify({
    agents: { trae_agent: { model: "main", max_steps: 20, enable_lakeview: Boolean(i.tiers?.small),
      tools: ["bash", "str_replace_based_edit_tool", "sequentialthinking", "task_done"] } },
    model_providers: { easyswitch: { provider: "openai", api_key: i.token, base_url: `${gateway(i)}/v1` } },
    models: { main: model(i.model), ...(i.tiers?.small ? { small: model(i.tiers.small) } : {}) },
    ...(i.tiers?.small ? { lakeview: { model: "small" } } : {}),
  }) };
}

// ---------------------------------------------------------------- codebuddy
// Current official docs support a third-party Anthropic-compatible endpoint and a private root.
// https://www.codebuddy.ai/docs/cli/env-vars
// https://www.codebuddy.ai/docs/cli/cli-reference
function codebuddyLaunch(i: LaunchInput, headless: boolean): LaunchSpec {
  const home = dir(i, "codebuddy");
  const settings = join(home, "settings.json");
  // An explicit empty file preserves isolation from native/project MCP settings.
  const mcpFile = join(home, "empty-mcp.json");
  const env = {
    CODEBUDDY_CONFIG_DIR: home, CODEBUDDY_CODE_DEBUG_LOGS_DIR: join(home, "logs"),
    CODEBUDDY_BASE_URL: gateway(i), CODEBUDDY_API_KEY: i.token, CODEBUDDY_MODEL: i.model,
    CODEBUDDY_SMALL_FAST_MODEL: i.tiers?.small ?? i.model,
    CODEBUDDY_BIG_SLOW_MODEL: i.tiers?.reasoning ?? i.model,
    CODEBUDDY_CODE_SUBAGENT_MODEL: i.tiers?.subagent ?? i.model,
    DISABLE_AUTOUPDATER: "1",
  };
  return { command: i.bin, env,
    args: ["--model", i.model, "--setting-sources", "user", "--settings", settings,
      "--strict-mcp-config", "--mcp-config", mcpFile, ...(i.effort ? ["--effort", i.effort] : []),
      ...(headless ? ["-p", i.task ?? "", "--output-format", "text"] : [])],
    unset: ["CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_CUSTOM_HEADERS", "CODEBUDDY_ENV_FILE", "CODEBUDDY_IS_SANDBOX",
      "CODEBUDDY_RECORD_DIR", "CODEBUDDY_REPLAY_DIR", "CODEBUDDY_INTERNET_ENVIRONMENT"],
    files: { [settings]: JSON.stringify({ env }), [mcpFile]: JSON.stringify({ mcpServers: {} }) },
  };
}

export const EXTRA_LAUNCHERS: Record<string, AgentLauncher> = {
  codebuddy: {
    verified: false,
    efforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
    tiers: [
      { id: "small", label: "后台小任务", hint: "lite 场景用这个模型" },
      { id: "reasoning", label: "复杂推理", hint: "reasoning 场景用这个模型" },
      { id: "subagent", label: "子 agent", hint: "覆盖所有子 agent 的模型" },
    ],
    caveat: "当前官方文档支持 CODEBUDDY_BASE_URL 的 Anthropic 兼容端点；使用私有 CODEBUDDY_CONFIG_DIR 和一次性参数，未实测；没有开启自动审批",
    ...forms(codebuddyLaunch),
  },
  "kimi-cli": {
    verified: false,
    efforts: levels(["low", "medium", "high"]),
    tiers: [{ id: "subagent", label: "子 agent", hint: "secondary_model 用这个模型" }],
    caveat: "面向当前 TypeScript 版 @moonshot-ai/kimi-code；配置和 -p 来自官方文档，尚未实测。旧 Python 版 Kimi CLI 使用不同配置，不能混用",
    ...forms((i, h) => ({ command: i.bin, args: ["--model", `es/${i.model}`, ...task(i, h, "-p")],
      env: { KIMI_CODE_HOME: dir(i, "kimi-home") }, unset: ["KIMI_MODEL_NAME", "KIMI_CODE_CUSTOM_HEADERS"],
      files: { [join(dir(i, "kimi-home"), "config.toml")]: kimiToml(i),
      } })),
  },
  pi: {
    verified: false,
    efforts: levels(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
    caveat: "配置文件格式来自 pi 的文档；`-p` 这个无界面参数是推测的",
    ...forms((i, h) => ({ command: i.bin, args: task(i, h, "-p"), env: { PI_CODING_AGENT_DIR: dir(i, "pi-agent") }, files: piFiles(i) })),
  },
  omp: {
    verified: false,
    efforts: levels(["minimal", "low", "medium", "high", "xhigh", "max"]),
    tiers: [
      { id: "subagent", label: "子 agent", hint: "它派出去的子 agent 用这个模型" },
      { id: "small", label: "后台小任务", hint: "侦察、小任务用这个模型" },
    ],
    caveat: "配置文件、-p 和 --config 覆盖层来自官方文档，尚未实测；max 档要 omp 16.4 以上。关闭外部用户配置与项目 MCP 发现",
    ...forms((i, h) => ({ command: i.bin, args: ["--config", join(dir(i, "omp-agent"), "config.yml"), ...task(i, h, "-p")], env: { PI_CODING_AGENT_DIR: dir(i, "omp-agent") },
      unset: ["OMP_PROFILE", "PI_PROFILE", "CLAUDE_CONFIG_DIR", "PI_CONFIG_FILES", "PI_SMOL_MODEL", "PI_SLOW_MODEL", "PI_PLAN_MODEL"], files: ompFiles(i) })),
  },
  droid: {
    verified: false,
    efforts: levels(["low", "medium", "high"]),
    caveat: "配置格式和 `droid exec --model` 来自 Factory 的文档；它可能仍要求先登录 Factory 才能启动，要实测",
    ...forms((i, h) => ({ command: i.bin, args: h ? ["exec", "--model", `custom:easyswitch/${i.model}`, i.task ?? ""] : ["--model", `custom:easyswitch/${i.model}`], env: { FACTORY_HOME_OVERRIDE: dir(i, "factory-home") }, files: droidFiles(i) })),
  },
  cline: {
    verified: false,
    efforts: levels(["low", "medium", "high", "xhigh"]),
    caveat: "设置文件格式来自 Cline 的文件格式；无界面参数 `-y` 是推测的",
    ...forms((i, h) => ({ command: i.bin, args: h ? ["-y", i.task ?? ""] : [], env: { CLINE_DATA_DIR: dir(i, "cline-data") }, files: clineFiles(i) })),
  },
  goose: {
    verified: false,
    efforts: levels(["off", "low", "medium", "high", "max"]),
    caveat: "自定义来源文件的格式有来源；用 GOOSE_PATH_ROOT 挪私有目录和 `goose run -t` 是推测的",
    ...forms((i, h) => ({
      command: i.bin, args: h ? ["run", "--no-session", "-t", i.task ?? ""] : ["session"],
      env: { GOOSE_PATH_ROOT: dir(i, "goose"), GOOSE_PROVIDER: "easyswitch", GOOSE_MODEL: i.model, GOOSE_DISABLE_KEYRING: "1", ...(i.effort ? { GOOSE_THINKING_EFFORT: i.effort } : {}) },
      files: gooseFiles(i),
    })),
  },
  crush: {
    verified: false,
    efforts: levels(["low", "medium", "high"]),
    tiers: [{ id: "small", label: "小任务", hint: "起标题、摘要这类轻量请求用这个模型" }],
    caveat: "配置内容来自 Crush 的文件格式；用两个环境变量挪私有目录和 `crush run` 是推测的",
    ...forms((i, h) => ({ command: i.bin, args: h ? ["run", i.task ?? ""] : [], env: { CRUSH_GLOBAL_CONFIG: dir(i, "crush-config"), CRUSH_GLOBAL_DATA: dir(i, "crush-data") }, files: crushFiles(i) })),
  },
  "grok-build": {
    verified: false,
    efforts: levels(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
    caveat: "私有目录、配置文件和 `grok -m … -p` 都有文档；空目录首次启动可能要求登录，要实测",
    ...forms((i, h) => ({ command: i.bin, args: [...(h ? ["-m", `easyswitch/${i.model}`] : []), ...(i.effort ? ["--effort", i.effort] : []), ...(h ? ["-p", i.task ?? ""] : [])], env: { GROK_HOME: dir(i, "grok-home") }, files: { [join(dir(i, "grok-home"), "config.toml")]: grokToml(i) } })),
  },
  "minimax-code": {
    verified: false,
    efforts: levels(["low", "medium", "high"]),
    caveat: "配置内容来自它的文件格式；没查到无界面的命令行参数，所以只做了交互形态；空目录首次启动的登录情况不明",
    ...forms((i) => ({ command: i.bin, args: [], env: { MINIMAX_DATA_DIR: dir(i, "mcode") }, files: { [join(dir(i, "mcode"), "config.yaml")]: mcodeYaml(i) } }), { headless: false }),
  },
  "qoder-cli": {
    verified: false,
    efforts: levels(["low", "medium", "high", "xhigh", "max"]),
    caveat: "配置内容和无界面参数有文档；自定义模型只对「已登录且套餐含自带模型」的账号开放，空的私有目录里没有登录态，要先确认能不能免登录用",
    ...forms((i, h) => ({ command: i.bin, args: [...(h ? ["-p", i.task ?? ""] : []), ...(i.effort ? ["--reasoning-effort", i.effort] : [])], env: { QODER_CONFIG_DIR: dir(i, "qoder") }, files: { [join(dir(i, "qoder"), "settings.json")]: qoderSettings(i) } })),
  },
  openclaw: {
    verified: false,
    efforts: levels(["off", "minimal", "low", "medium", "high", "xhigh"]),
    tiers: [{ id: "subagent", label: "子 agent", hint: "它派出去的子 agent 用这个模型" }],
    caveat: "私有配置文件和环境变量来自它的文档；`openclaw agent --message` 这类命令是推测的",
    ...forms((i, h) => ({
      command: i.bin, args: h ? ["agent", "--local", ...(i.effort ? ["--thinking", i.effort] : []), "--message", i.task ?? ""] : ["tui", ...(i.effort ? ["--thinking", i.effort] : [])],
      env: { OPENCLAW_CONFIG_PATH: join(i.sessionDir, "openclaw.json"), EASYSWITCH_OPENCLAW_KEY: i.token },
      files: { "openclaw.json": openclawConfig(i) },
    })),
  },
  "trae-agent": {
    verified: false,
    tiers: [{ id: "small", label: "后台摘要", hint: "Lakeview 的摘要请求用这个模型" }],
    caveat: "按官方 CLI 和 YAML 模式实现；OpenAI 通道实际使用 Responses。基础工具允许文件和 shell 操作，未声明只读；尚未实测",
    ...forms((i, h) => ({
      command: i.bin,
      args: [...(h ? ["run", i.task ?? ""] : ["interactive"]), "--config-file", join(i.sessionDir, "trae-config.yaml"),
        "--trajectory-file", join(i.sessionDir, "trae-trajectory.json"), "--provider", "easyswitch", "--model", i.model,
        "--model-base-url", `${gateway(i)}/v1`],
      // Explicit env beats a project's .env without exposing the session token on argv.
      env: { OPENAI_API_KEY: i.token }, unset: ["OPENAI_BASE_URL"], files: traeFiles(i),
    })),
  },
  atomcode: {
    verified: false,
    efforts: levels(["low", "medium", "high", "xhigh", "max"]),
    caveat: "私有 ATOMCODE_HOME、config.toml 和 -p 来自官方文档/源码；尚未实测",
    ...forms((i, h) => ({ command: i.bin, args: task(i, h, "-p"), env: { ATOMCODE_HOME: dir(i, "atomcode") },
      files: { [join(dir(i, "atomcode"), "config.toml")]: atomcodeToml(i),
      } })),
  },
};
