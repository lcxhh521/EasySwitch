import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { gatewayTokens, type GatewayTokenAuthority } from "./gateway-auth.ts";
import { claudeArgs, claudeEnv, codexArgs, type McpAttach } from "./launch.ts";
import { mcpEndpoint } from "./mcp.ts";
import { knownEfforts } from "./efforts.ts";
import { allModels, EXTRA_LAUNCHERS } from "./launchers-extra.ts";
import { DSH_EFFORTS, DSH_MCP_UNAVAILABLE_NOTICE, DshMcpUnavailableError, dshLaunch, prepareDshMcpPlugin } from "./dsh-launch.ts";
export { findDshMcpPlugin as dshMcpPlugin } from "./dsh-launch.ts";

const run = promisify(execFile);

/**
 * How to start each agent on the EasySwitch gateway, for one launch only:
 * environment variables, command-line flags, or a throwaway config directory
 * that is removed afterwards. Nothing in the agent's own config is written.
 * Every agent has an interactive form (a Terminal window) and, where the agent
 * has one, a headless form that takes a task and returns its answer — the
 * second is what lets EasySwitch hand work to an agent, not just open it.
 *
 * `verified` says whether the form was run against the real program here;
 * the rest follow the vendors' documented overrides and say so in the console.
 */

export interface LaunchInput {
  /** The agent's executable. */
  bin: string;
  /** EasySwitch's own data directory, for agents that keep a private home between runs. */
  stateDir?: string;
  /** Gateway port on 127.0.0.1. */
  port: number;
  /** `<provider>/<model>` as the gateway names it. */
  model: string;
  /** Per-launch gateway token (carries the agent id). */
  token: string;
  /** A fresh directory for this launch; deleted when it ends. */
  sessionDir: string;
  /** Present for the headless form. */
  task?: string;
  /** Claude Code: what it is told about the levels of our models (see claudeCapabilities). */
  claudeCaps?: string;
  /** Claude Code: keep the user's own Claude login so Claude's own models stay available next to ours. */
  keepLogin?: boolean;
  /** Every model the agent may be offered in its own menu (`<provider>/<model>`), so it can switch without coming back to EasySwitch. `model` is only the default. */
  models?: string[];
  /** Extra models for this launch, by the launcher's tier ids (`<provider>/<model>`). */
  tiers?: Record<string, string>;
  /** Codex only: the merged model catalog to hand it (see catalog.ts). */
  catalog?: string;
  /** Reasoning level for this launch, one of the launcher's `efforts`. */
  effort?: string;
  /** Model-owned capabilities for every exposed model, keyed by <provider>/<model>. */
  modelEfforts?: Record<string, string[]>;
  /** The EasySwitch MCP server to attach for this launch, so this agent can call the others. */
  mcp?: McpAttach;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Variables that would override what we pass and must be cleared. */
  unset?: string[];
  /** Files to write under sessionDir before starting (relative path → content). */
  files?: Record<string, string>;
  /** Resolve an already-installed official plugin, then link it only into the private dsh home. */
  dshMcpPlugin?: { bin: string; packageDir?: string; fallbackPatch?: string };
  /** Non-fatal launch limitations shown in the task result. */
  warnings?: string[];
}

export interface AgentLauncher {
  verified: boolean;
  /** Other models this agent can run next to its main one, in the user's words. */
  tiers?: Array<{ id: string; label: string; hint: string }>;
  /** The reasoning levels this agent can be started with, in its own words. Empty or absent: it has no such setting. */
  efforts?: string[];
  interactive?: (i: LaunchInput) => LaunchSpec;
  headless?: (i: LaunchInput) => LaunchSpec;
  /** What in the launch is a guess from memory rather than the vendor's own format, to be checked with `--help`. */
  caveat?: string;
  /** The same, for how the MCP server is attached. */
  mcpCaveat?: string;
  /** What is known about choosing models inside the agent when the launcher only names one (shown in the capability table). */
  pickerNote?: string;
}

const gateway = (i: LaunchInput) => `http://127.0.0.1:${i.port}`;
const openaiEnv = (i: LaunchInput): Record<string, string> => ({ OPENAI_BASE_URL: `${gateway(i)}/v1`, OPENAI_API_KEY: i.token, OPENAI_MODEL: i.model });

/** A YAML-safe quoted string (JSON strings are valid YAML). */
const q = (s: string) => JSON.stringify(s);

export const LAUNCHERS: Record<string, AgentLauncher> = {
  // The two built-in agents. Headless forms run with the harness' own read-only defaults.
  codex: {
    verified: true,
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    tiers: [{ id: "subagent", label: "子 agent", hint: "它派出去的子 agent 用这个模型" }],
    interactive: i => ({ command: i.bin, args: [...codexArgs(i.port, i.model, i.catalog, i.mcp), ...codexExtras(i)], env: { EASYSWITCH_GATEWAY_TOKEN: i.token } }),
    headless: i => ({ command: i.bin, args: ["exec", "--skip-git-repo-check", ...codexArgs(i.port, i.model, i.catalog, i.mcp), ...codexExtras(i), i.task ?? ""], env: { OPENAI_API_KEY: "", EASYSWITCH_GATEWAY_TOKEN: i.token } }),
  },
  claude: {
    verified: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    tiers: [
      { id: "small", label: "后台小任务", hint: "标题、摘要这类轻量请求用这个模型" },
      { id: "subagent", label: "子 agent", hint: "它派出去的子 agent 用这个模型" },
    ],
    interactive: i => {
      const env = claudeEnv(i.port, i.model || undefined, i.token, i.tiers, i.keepLogin, i.claudeCaps);
      return { command: i.bin, args: [...(i.effort ? ["--effort", i.effort] : []), ...claudeArgs(env, i.mcp)], env };
    },
    headless: i => {
      const env = claudeEnv(i.port, i.model, i.token, i.tiers, false, i.claudeCaps);
      return { command: i.bin, args: ["-p", i.task ?? "", ...(i.effort ? ["--effort", i.effort] : []), ...claudeArgs(env, i.mcp)], env, unset: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] };
    },
  },

  // Run here against the real programs.
  dsh: {
    verified: true,
    efforts: DSH_EFFORTS,
    tiers: [
      { id: "subagent", label: "子 agent", hint: "spawn 子 agent 用这个模型；不改变主模型" },
      { id: "small", label: "后台小任务", hint: "标题和对话压缩共用这个模型" },
      { id: "title", label: "起标题", hint: "覆盖后台小任务模型，只用于会话标题" },
      { id: "compaction", label: "压缩对话", hint: "覆盖后台小任务模型，只用于对话压缩" },
    ],
    caveat: "基础启动及此前小模型标题调用有实测记录；子 agent 仅验证过配置。当前逐模型档位、独立标题/压缩设置和隔离组合尚未在真实客户端验收",
    mcpCaveat: "此前真实 dsh 已看见 MCP 工具；当前组合尚未实测。插件不在 dsh 的安装包里，缺失时任务继续但不挂 MCP，并显示原因；只建经过校验的私有链接，不运行 plugin add",
    headless: dshLaunch,
  },

  // Hermes: a private HERMES_HOME holds a one-provider config, so ~/.hermes is never read or written.
  // Its home is kept between runs (it installs its runtime into it, which takes a minute); only the config is rewritten each launch.
  hermes: {
    verified: true,
    tiers: [
      { id: "small", label: "后台小任务", hint: "压缩对话、起标题、网页摘要、审批这类辅助调用用这个模型" },
      { id: "vision", label: "看图", hint: "识别图片用这个模型" },
      { id: "subagent", label: "子 agent", hint: "它派出去的子 agent 用这个模型" },
    ],
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    interactive: i => ({ command: i.bin, args: i.effort ? ["chat", "--reasoning", i.effort] : [], env: { HERMES_HOME: hermesHome(i), ...hermesMcpEnv(i) }, files: hermesFiles(i) }),
    headless: i => ({ command: i.bin, args: ["chat", "-Q", ...(i.effort ? ["--reasoning", i.effort] : []), "-q", i.task ?? ""], env: { HERMES_HOME: hermesHome(i), ...hermesMcpEnv(i) }, files: hermesFiles(i) }),
  },

  // Documented overrides, not yet run against the real programs.
  "gemini-cli": {
    verified: false,
    efforts: ["low", "medium", "high"],
    pickerNote: "私有设置启用官方动态模型目录，/model 的 Manual 中可列出外接模型；需支持该设置的版本，内置模型仍可能显示但不代表网关支持它们，真实菜单未实测",
    caveat: "官方私有 GEMINI_CLI_HOME、动态模型目录和 thinkingConfig；真实 CLI 没有实测。受信项目设置仍可覆盖或迁移，私有用户目录不代表项目隔离；后台任务仍保留程序自己的工具确认",
    mcpCaveat: "MCP 写入私有用户设置的 mcpServers；不再使用会被当前版本信任检查忽略的临时系统设置文件，真实 CLI 未实测",
    interactive: i => ({ command: i.bin, args: [], env: geminiEnv(i), files: geminiSettingsFiles(i) }),
    headless: i => ({ command: i.bin, args: ["-p", i.task ?? ""], env: geminiEnv(i), files: geminiSettingsFiles(i) }),
  },
  "qwen-code": {
    verified: false,
    pickerNote: "官方 modelProviders 将全部外接模型列入 /model；/model --global 把选择存回私有 QWEN_HOME。项目级保存与旧版本兼容性仍需真实程序验收",
    caveat: "官方 modelProviders、QWEN_HOME 和 openai 鉴权配置；真实 CLI 没有实测。项目配置仍会加载，选择 /model --global 可把菜单选择保存在私有目录；不自动批准后台工具",
    mcpCaveat: "MCP 通过官方 QWEN_CODE_SYSTEM_SETTINGS_PATH 下的私有 mcpServers 配置；与 Gemini 的鉴权和目录格式分开，真实 CLI 未实测",
    interactive: i => qwenSpec(i, ["--auth-type", "openai"]),
    headless: i => qwenSpec(i, ["--auth-type", "openai", "-p", i.task ?? ""]),
  },
  opencode: {
    verified: false,
    tiers: [
      { id: "small", label: "小任务", hint: "标题、摘要这类轻量请求用这个模型" },
      { id: "subagent", label: "子 agent", hint: "它的 general / explore 子 agent 用这个模型" },
    ],
    caveat: "环境变量和 `opencode run` 有文档；`--variant` 和子 agent 的写法是凭记忆的；OpenCode 2 可能读另一套 provider 键",
    mcpCaveat: "MCP 条目的写法是凭记忆的",
    interactive: i => ({ command: i.bin, args: ["--model", `easyswitch/${i.model}`, ...(i.effort ? ["--variant", i.effort] : [])], env: { OPENCODE_CONFIG_CONTENT: opencodeConfig(i) } }),
    headless: i => ({ command: i.bin, args: ["run", "--model", `easyswitch/${i.model}`, ...(i.effort ? ["--variant", i.effort] : []), i.task ?? ""], env: { OPENCODE_CONFIG_CONTENT: opencodeConfig(i) } }),
  },
  aider: {
    verified: false,
    pickerNote: "启动时只能指定一个主模型；Aider 有 /model 命令可以输入别的模型名手动换（文档里有），但它的菜单里不会替你列出来",
    efforts: ["low", "medium", "high"],
    tiers: [{ id: "small", label: "小任务", hint: "提交说明、对话摘要这类用 Aider 的「弱模型」" }],
    caveat: "参数来自它的文档；自定义模型名下 `--reasoning-effort` 可能被忽略（它不认识这个模型）",
    interactive: i => ({ command: i.bin, args: [...aiderBase(i)], env: {} }),
    headless: i => ({ command: i.bin, args: [...aiderBase(i), "--message", i.task ?? "", "--yes-always", "--no-auto-commits"], env: {} }),
  },
  "copilot-cli": {
    verified: false,
    efforts: ["low", "medium", "high", "xhigh"],
    pickerNote: "官方已提供 providers.json 多模型注册表与 /model 菜单，但内部条目和凭据引用格式尚未核实；目前只用官方环境变量指定默认模型，不声称已注入全部模型",
    caveat: "BYOK 环境变量、COPILOT_HOME 和 effortLevel 来自官方文档；私有配置目录不代表工具隔离，项目设置仍可能生效；清除环境中的自动批准/自动驾驶开关，真实 CLI 没有实测",
    mcpCaveat: "按官方 --additional-mcp-config @文件 传本次私有配置，令牌不放 argv；真实 CLI 未实测",
    interactive: i => copilotSpec(i, copilotMcp(i)),
    headless: i => copilotSpec(i, ["-p", i.task ?? "", ...copilotMcp(i)]),
  },

  // Each on a private directory for this launch only (see launchers-extra.ts).
  ...EXTRA_LAUNCHERS,
};

/** Codex: reasoning level and the model its sub-agents use, as per-launch -c overrides. */
function codexExtras(i: LaunchInput): string[] {
  return [
    ...(i.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(i.effort)}`] : []),
    ...(i.tiers?.subagent ? ["-c", `agents.default_subagent_model=${JSON.stringify(i.tiers.subagent)}`] : []),
  ];
}

const hermesHome = (i: LaunchInput) => join(i.stateDir ?? i.sessionDir, "hermes-home");

function hermesFiles(i: LaunchInput): Record<string, string> {
  const aux: Array<readonly [string, string]> = [
    ...(i.tiers?.small ? ["compression", "title_generation", "web_extract", "skills_hub", "approval", "mcp"].map(k => [k, i.tiers!.small!] as const) : []),
    ...(i.tiers?.vision ? [["vision", i.tiers.vision] as const] : []),
  ];
  return {
    [join(hermesHome(i), "config.yaml")]: [
      "model:",
      `  default: ${q(i.model)}`,
      "  provider: custom:easyswitch",
      `  base_url: ${q(`${gateway(i)}/v1`)}`,
      "custom_providers:",
      "  - name: easyswitch",
      `    base_url: ${q(`${gateway(i)}/v1`)}`,
      `    api_key: ${q("${EASYSWITCH_GATEWAY_TOKEN}")}`,
      "    api_mode: chat_completions",
      "    discover_models: false",
      "    models:",
      ...allModels(i).map(m => `      ${q(m)}: {}`),
      // Hermes runs these side jobs on models of their own; each is pointed at the same private provider.
      ...(aux.length ? ["auxiliary:"] : []),
      ...aux.flatMap(([k, m]) => [`  ${k}:`, "    provider: custom:easyswitch", `    model: ${q(m)}`]),
      ...(i.tiers?.subagent ? ["delegation:", `  model: ${q(i.tiers.subagent)}`, `  base_url: ${q(`${gateway(i)}/v1`)}`, `  api_key: ${q("${EASYSWITCH_GATEWAY_TOKEN}")}`] : []),
      ...(i.mcp ? ["mcp_servers:", "  easyswitch:", `    url: ${q(i.mcp.url)}`, "    enabled: true", "    headers:", ...Object.entries(i.mcp.headers).map(([k, v]) => `      ${q(k)}: ${k.toLowerCase() === "authorization" ? q("Bearer ${EASYSWITCH_MCP_TOKEN}") : q(v)}`)] : []),
      "",
    ].join("\n"),
  };
}

function geminiEnv(i: LaunchInput): Record<string, string> {
  return { GOOGLE_GEMINI_BASE_URL: gateway(i), GEMINI_API_KEY: i.token, GEMINI_MODEL: i.model, GEMINI_CLI_HOME: join(i.sessionDir, "gemini-home") };
}

function copilotEnv(i: LaunchInput): Record<string, string> {
  return { COPILOT_PROVIDER_BASE_URL: `${gateway(i)}/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: i.token, COPILOT_MODEL: i.model };
}

function opencodeConfig(i: LaunchInput): string {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      easyswitch: {
        npm: "@ai-sdk/openai-compatible",
        name: "EasySwitch",
        options: { baseURL: `${gateway(i)}/v1`, apiKey: i.token },
        models: Object.fromEntries(allModels(i).map(m => [m, { name: m.slice(m.indexOf("/") + 1), variants: Object.fromEntries([...new Set(["low", "medium", "high", ...(i.effort ? [i.effort] : [])])].map(l => [l, { reasoningEffort: l }])) }])),
      },
    },
    ...(i.tiers?.small ? { small_model: `easyswitch/${i.tiers.small}` } : {}),
    ...(i.tiers?.subagent ? { agent: { general: { model: `easyswitch/${i.tiers.subagent}` }, explore: { model: `easyswitch/${i.tiers.subagent}` } } } : {}),
    ...(i.mcp ? { mcp: { easyswitch: { type: "remote", url: i.mcp.url, headers: i.mcp.headers, enabled: true } } } : {}),
  });
}

/** Hermes expands ${VAR} in its config, so the MCP token travels in the environment and not in the file. */
function hermesMcpEnv(i: LaunchInput): Record<string, string> {
  const auth = i.mcp?.headers.Authorization ?? i.mcp?.headers.authorization;
  return { EASYSWITCH_GATEWAY_TOKEN: i.token, ...(auth ? { EASYSWITCH_MCP_TOKEN: auth.replace(/^Bearer /i, "") } : {}) };
}

function aiderBase(i: LaunchInput): string[] {
  return ["--openai-api-base", `${gateway(i)}/v1`, "--openai-api-key", i.token, "--model", `openai/${i.model}`,
    ...(i.tiers?.small ? ["--weak-model", `openai/${i.tiers.small}`] : []), ...(i.effort ? ["--reasoning-effort", i.effort] : [])];
}

/** Official modelDefinitions drive /model only when dynamic model configuration is enabled.
 * A user-owned system override is rejected by current Gemini CLI; use its private user directory.
 * See research/model-menu-facts.md for version and project-setting limits.
 */
function geminiSettingsFiles(i: LaunchInput): Record<string, string> {
  const level = i.effort && ["low", "medium", "high"].includes(i.effort) ? i.effort.toUpperCase() : undefined;
  return { [join(i.sessionDir, "gemini-home", ".gemini", "settings.json")]: JSON.stringify({
    security: { auth: { selectedType: "gemini-api-key" } },
    model: { name: i.model },
    experimental: { dynamicModelConfiguration: true },
    modelConfigs: {
      modelDefinitions: Object.fromEntries(allModels(i).map(model => [model, { displayName: model, tier: "custom", family: "custom", isVisible: true, isPreview: false }])),
      ...(level ? { overrides: [{ match: { model: i.model }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: level } } } }] } : {}),
    },
    ...(i.mcp ? { mcpServers: { easyswitch: { httpUrl: i.mcp.url, headers: i.mcp.headers, trust: true } } } : {}),
  }) };
}

function qwenSpec(i: LaunchInput, args: string[]): LaunchSpec {
  const home = join(i.sessionDir, "qwen-home");
  const settingsPath = join(i.sessionDir, "qwen-system-settings.json");
  const settings = JSON.stringify({
    security: { auth: { selectedType: "openai" } },
    model: { name: i.model },
    modelProviders: { openai: allModels(i).map(model => ({ id: model, name: model, envKey: "EASYSWITCH_GATEWAY_TOKEN", baseUrl: `${gateway(i)}/v1`,
      ...(model === i.model && i.effort ? { generationConfig: { reasoning: { effort: i.effort } } } : {}),
    })) },
    ...(i.mcp ? { mcpServers: { easyswitch: { httpUrl: i.mcp.url, headers: i.mcp.headers, trust: true } } } : {}),
  });
  return { command: i.bin, args, env: { ...openaiEnv(i), EASYSWITCH_GATEWAY_TOKEN: i.token, QWEN_HOME: home, QWEN_RUNTIME_DIR: home, QWEN_CODE_SYSTEM_SETTINGS_PATH: settingsPath },
    files: { [settingsPath]: settings, [join(home, "settings.json")]: settings } };
}

/** Keep /model --global writes and inherited BYOK registries out of the person's original configuration. */
function copilotSpec(i: LaunchInput, args: string[]): LaunchSpec {
  const env = copilotEnv(i);
  const home = join(i.sessionDir, "copilot-home");
  return { command: i.bin, args, env: { ...env, COPILOT_HOME: home, COPILOT_CACHE_HOME: join(home, "cache") },
    // Official BYOK overrides must not replace this launch's provider, model or request shape.
    unset: ["COPILOT_PROVIDERS_CONFIG", "COPILOT_PROVIDER_API_KEY_COMMAND", "COPILOT_PROVIDER_BEARER_TOKEN", "COPILOT_PROVIDER_HEADERS", "COPILOT_PROVIDER_MODEL_ID", "COPILOT_PROVIDER_WIRE_MODEL",
      "COPILOT_PROVIDER_WIRE_API", "COPILOT_PROVIDER_MAX_PROMPT_TOKENS", "COPILOT_PROVIDER_MAX_OUTPUT_TOKENS", "COPILOT_PROVIDER_AZURE_API_VERSION",
      // Ambient flags must not silently grant approvals or change the execution mode.
      // This is per-child cleanup, not isolation from every native/project permission source.
      "COPILOT_ALLOW_ALL", "COPILOT_PLAN_THEN_AUTOPILOT"],
    files: {
      [join(home, "settings.json")]: JSON.stringify(i.effort ? { effortLevel: i.effort } : {}),
      ...(i.mcp ? { [join(home, "easyswitch-mcp.json")]: JSON.stringify({ mcpServers: { easyswitch: { type: "http", url: i.mcp.url, headers: i.mcp.headers, tools: ["*"] } } }) } : {}),
    } };
}

function copilotMcp(i: LaunchInput): string[] {
  return i.mcp ? ["--additional-mcp-config", `@${join(i.sessionDir, "copilot-home", "easyswitch-mcp.json")}`] : [];
}

/**
 * The levels an agent has in its own words, or undefined when it has none of its own. Then any
 * level its model has can be set, and the gateway applies it to the agent's requests, so it can
 * even be changed while a session is running.
 */
export function effortsOf(agentId: string): string[] | undefined {
  const l = LAUNCHERS[agentId];
  return l ? (knownEfforts(agentId)?.levels ?? l.efforts) : [];
}

export function hasLauncher(agentId: string): { interactive: boolean; headless: boolean; verified: boolean; efforts: string[]; anyEffort: boolean; tiers: Array<{ id: string; label: string; hint: string }> } | undefined {
  const l = LAUNCHERS[agentId];
  const own = effortsOf(agentId);
  // `anyEffort`: the agent has no levels of its own, so the model decides which levels there are.
  return l ? { interactive: Boolean(l.interactive), headless: Boolean(l.headless), verified: l.verified, efforts: own ?? [], anyEffort: own === undefined, tiers: l.tiers ?? [] } : undefined;
}

export function newSessionDir(): string {
  return mkdtempSync(join(tmpdir(), "easyswitch-session-"));
}

/** Writes the spec's files under the session dir. */
export function materialize(spec: LaunchSpec, sessionDir: string): void {
  if (spec.dshMcpPlugin) {
    try { prepareDshMcpPlugin(spec.dshMcpPlugin.bin, sessionDir, spec.dshMcpPlugin.packageDir); }
    catch (error) {
      if (!(error instanceof DshMcpUnavailableError) || spec.dshMcpPlugin.fallbackPatch === undefined) throw error;
      spec.files = { ...spec.files, "patch.yml": spec.dshMcpPlugin.fallbackPatch };
      spec.warnings = [...spec.warnings ?? [], DSH_MCP_UNAVAILABLE_NOTICE];
    }
  }
  for (const [rel, content] of Object.entries(spec.files ?? {})) {
    const path = isAbsolute(rel) ? rel : join(sessionDir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, { mode: 0o600 });
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The spec as one shell line: `env -u … VAR=… command args`. For a Terminal window. */
export function commandLine(spec: LaunchSpec): string {
  const sets = Object.entries(spec.env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  const unsets = (spec.unset ?? []).flatMap(v => ["-u", v]);
  return ["env", ...unsets, ...sets, shellQuote(spec.command), ...spec.args.map(shellQuote)].join(" ");
}

export interface RunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  warnings?: string[];
  cancelled?: boolean;
}

export class HeadlessCleanupError extends Error {
  readonly code = "process_cleanup_failed";
  tokenCleanupFailed = false;
  constructor() { super("任务进程的清理未能确认，请先检查本机进程后再重试。"); this.name = "HeadlessCleanupError"; }
}

/** Process-local injection only: fake tests supply their own group operations and clock. */
export interface HeadlessProcessRuntime {
  spawn: typeof spawn;
  processGroup?: { signal(group: number, signal: NodeJS.Signals): void; exists(group: number): boolean };
  schedule?: (callback: () => void, delay: number) => unknown;
  cancel?: (timer: unknown) => void;
}
const headlessRuntime: HeadlessProcessRuntime = {
  spawn,
  ...(process.platform === "win32" ? {} : { processGroup: {
    signal(group: number, signal: NodeJS.Signals) { process.kill(-group, signal); },
    exists(group: number) {
      try { process.kill(-group, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    },
  } }),
};

function runOwnedHeadless(spec: LaunchSpec, cwd: string, env: NodeJS.ProcessEnv,
  opts: { timeoutMs?: number; maxBytes?: number; signal?: AbortSignal }, runtime: HeadlessProcessRuntime): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const schedule = runtime.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    const cancel = runtime.cancel ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
    let child: ChildProcess;
    try { child = runtime.spawn(spec.command, spec.args, { cwd, env, shell: false, detached: Boolean(runtime.processGroup), stdio: ["ignore", "pipe", "pipe"] }); }
    catch { resolve({ exitCode: null, output: "无法启动所选 agent。", timedOut: false }); return; }
    let output = spec.warnings?.map(warning => `[EasySwitch] ${warning}\n`).join("") ?? "";
    let bytes = Buffer.byteLength(output), timedOut = false, cancelled = false, failed = false;
    let exited = false, closed = false, settled = false, stopping = false, exitCode: number | null = null;
    // Capture only the group created by this detached spawn, never discover a PID by scanning.
    const group = runtime.processGroup && Number.isSafeInteger(child.pid) && child.pid! > 0 ? child.pid : undefined;
    let groupGone = group === undefined;
    let poll: unknown, escalation: unknown, deadline: unknown, pipes: unknown, timeout: unknown;
    const clear = (timer: unknown) => { if (timer !== undefined) cancel(timer); };
    const add = (chunk: Buffer | string) => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const take = Math.min(data.length, Math.max(0, (opts.maxBytes ?? 2_000_000) - bytes));
      output += data.subarray(0, take).toString("utf8"); bytes += take;
    };
    const groupState = (): "gone" | "alive" | "unknown" => {
      // Retire a vanished group permanently: its numeric id might later be reused.
      if (groupGone) return "gone";
      try { if (runtime.processGroup!.exists(group!)) return "alive"; groupGone = true; return "gone"; }
      catch { return "unknown"; }
    };
    const destroyPipes = () => { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); };
    const finish = (cleanupFailed = false) => {
      if (settled) return; settled = true;
      for (const timer of [poll, escalation, deadline, pipes, timeout]) clear(timer);
      opts.signal?.removeEventListener("abort", abort);
      child.stdout?.removeListener("data", add); child.stderr?.removeListener("data", add);
      destroyPipes();
      if (cleanupFailed) { child.unref(); reject(new HeadlessCleanupError()); return; }
      resolve({ exitCode: failed || cancelled || timedOut ? null : exitCode,
        output: [output.trim(), failed ? "agent 进程运行失败。" : cancelled ? "任务已取消" : timedOut ? "任务已超时" : ""].filter(Boolean).join("\n"),
        timedOut, ...(cancelled ? { cancelled: true } : {}), ...(spec.warnings?.length ? { warnings: spec.warnings } : {}) });
    };
    const signalOwned = (signal: NodeJS.Signals) => {
      const state = groupState();
      if (state === "alive") {
        try { runtime.processGroup!.signal(group!, signal); return; } catch { /* Still wait for confirmed exit. */ }
      }
      // ChildProcess.kill is used only while this exact child has not exited.
      if (!exited && (group === undefined || state !== "gone")) { try { child.kill(signal); } catch { /* The bounded deadline reports failure. */ } }
    };
    const check = () => {
      if (settled) return;
      const state = groupState();
      if (exited && state === "gone") {
        if (closed) finish();
        // A pipe may have been passed outside the group. Do not wait forever or kill its holder.
        else if (pipes === undefined) pipes = schedule(() => finish(), 250);
        return;
      }
      if (exited && !stopping) stop();
      if (stopping && poll === undefined) poll = schedule(() => { poll = undefined; check(); }, 25);
    };
    const stop = () => {
      if (settled || stopping) return; stopping = true;
      signalOwned("SIGTERM");
      if (settled) return;
      escalation = schedule(() => {
        signalOwned("SIGKILL");
        if (!settled) deadline = schedule(() => {
          if (exited && groupState() === "gone") finish(); else finish(true);
        }, 1000);
      }, 3000);
      check();
    };
    const abort = () => { cancelled = true; stop(); };
    child.stdout?.on("data", add); child.stderr?.on("data", add);
    const pipeError = () => { if (!settled) { failed = true; stop(); } };
    child.stdout?.on("error", pipeError); child.stderr?.on("error", pipeError);
    child.on("error", () => {
      failed = true;
      // An error with a live pid is not proof of exit (e.g. a failed kill).
      if (!child.pid) { exited = true; closed = true; check(); } else stop();
    });
    child.once("exit", code => { exited = true; exitCode = code; clear(timeout); check(); });
    child.once("close", code => { exited = true; closed = true; exitCode = code; clear(timeout); check(); });
    timeout = schedule(() => { timedOut = true; stop(); }, opts.timeoutMs ?? 300_000);
    opts.signal?.addEventListener("abort", abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}

/**
 * Hands one task to an agent and waits for its answer (headless form). The
 * agent runs in `cwd` (the user's project) with a private session directory
 * that is removed afterwards; output is capped so a runaway agent cannot fill memory.
 */
export async function runHeadless(
  agentId: string, input: Omit<LaunchInput, "token" | "sessionDir" | "mcp">,
  opts: { cwd?: string; timeoutMs?: number; maxBytes?: number; depth?: number; attachMcp?: boolean; signal?: AbortSignal;
    gatewayAuth?: Pick<GatewayTokenAuthority, "issue" | "revoke"> } = {},
  runtime: HeadlessProcessRuntime = headlessRuntime,
): Promise<RunResult> {
  const launcher = LAUNCHERS[agentId];
  if (!launcher?.headless) throw new Error("这个 agent 还没有无界面的调用方式");
  const authority = opts.gatewayAuth ?? gatewayTokens;
  const sessionDir = newSessionDir();
  let token: string | undefined;
  let runError: unknown;
  try {
    token = authority.issue(agentId, { depth: opts.depth ?? 1, allowMcp: opts.attachMcp !== false, allowNativeClaude: false }).token;
    const mcp = opts.attachMcp === false ? undefined : mcpEndpoint(input.port, token, opts.depth ?? 1);
    const spec = launcher.headless({ ...input, token, sessionDir, ...(mcp ? { mcp } : {}) });
    materialize(spec, sessionDir);
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    for (const name of spec.unset ?? []) delete env[name];
    if (opts.signal?.aborted) return { exitCode: null, output: "任务已取消", timedOut: false, cancelled: true };
    return await runOwnedHeadless(spec, opts.cwd ?? sessionDir, env, opts, runtime);
  } catch (error) { runError = error; throw error; }
  finally {
    try {
      if (token) {
        try { authority.revoke(token); }
        catch (error) {
          // Keep the process-cleanup failure class visible even if token persistence also failed.
          if (runError instanceof HeadlessCleanupError) runError.tokenCleanupFailed = true;
          else throw error;
        }
      }
    }
    finally { rmSync(sessionDir, { recursive: true, force: true }); }
  }
}

export { run as _run };
