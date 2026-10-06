import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { gatewayTokens, type GatewayTokenAuthority } from "./gateway-auth.ts";
import { claudeArgs, claudeEnv, codexArgs, type McpAttach } from "./launch.ts";
import { mcpEndpoint } from "./mcp.ts";
import { knownEfforts } from "./efforts.ts";
import { allModels, EXTRA_LAUNCHERS } from "./launchers-extra.ts";
import { DSH_EFFORTS, dshLaunch, prepareDshMcpPlugin } from "./dsh-launch.ts";
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
  dshMcpPlugin?: { bin: string; packageDir?: string };
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
    mcpCaveat: "此前真实 dsh 已看见 MCP 工具；当前组合尚未实测。插件不在 dsh 的安装包里，须预先安装；只在私有 DSH_HOME 建经过校验的链接，缺失即拒绝，不运行 plugin add",
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
    pickerNote: "它靠环境变量一次只能指定一个模型；还没查它的 /model 在自定义地址下能不能列出别的模型",
    caveat: "环境变量来自它的文档；思考档位写成系统设置里的 thinkingConfig（写法凭记忆，把握不大）；无界面的 `-p` 默认拿不到工具权限（要 --yolo，我们没开）",
    mcpCaveat: "MCP 通过「系统设置文件」环境变量挂上，变量名和格式是凭记忆写的，要核实",
    interactive: i => ({ command: i.bin, args: [], env: { ...geminiEnv(i), ...geminiSystemSettings(i) }, files: geminiSettingsFiles(i) }),
    headless: i => ({ command: i.bin, args: ["-p", i.task ?? ""], env: { ...geminiEnv(i), ...geminiSystemSettings(i) }, files: geminiSettingsFiles(i) }),
  },
  "qwen-code": {
    verified: false,
    pickerNote: "它靠环境变量一次只能指定一个模型；还没查它的 /model 在自定义地址下能不能列出别的模型",
    caveat: "没有任何本地资料可对，命令行参数全凭记忆；无界面的 `-p` 默认拿不到工具权限",
    mcpCaveat: "MCP 的系统设置文件环境变量名是猜的（从 Gemini CLI 改名而来），要核实",
    interactive: i => ({ command: i.bin, args: ["--auth-type", "openai"], env: { ...openaiEnv(i), ...geminiSystemSettings(i, true) }, files: geminiSettingsFiles(i) }),
    headless: i => ({ command: i.bin, args: ["--auth-type", "openai", "-p", i.task ?? ""], env: { ...openaiEnv(i), ...geminiSystemSettings(i, true) }, files: geminiSettingsFiles(i) }),
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
    pickerNote: "它靠环境变量一次只能指定一个模型；还没查它的 /model 在自带模型（BYOK）下能不能列出别的模型",
    caveat: "BYOK 环境变量凭记忆；思考档位写在私有目录的 settings.json 里（effortLevel，文件位置和键名来自资料、没有实测）；无界面的 `-p` 默认拿不到工具权限（要 --allow-all-tools，我们没开）",
    mcpCaveat: "`--additional-mcp-config` 是凭记忆写的，要核实",
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
  return { GOOGLE_GEMINI_BASE_URL: gateway(i), GEMINI_API_KEY: i.token, GEMINI_MODEL: i.model };
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

/** The system settings file that Gemini CLI and its forks read as their highest layer; written only for this launch. */
const GEMINI_SETTINGS = "gemini-system-settings.json";
function geminiSystemSettings(i: LaunchInput, qwen = false): Record<string, string> {
  const path = join(i.sessionDir, GEMINI_SETTINGS);
  return { GEMINI_CLI_SYSTEM_SETTINGS_PATH: path, ...(qwen ? { QWEN_CODE_SYSTEM_SETTINGS_PATH: path } : {}) };
}
function geminiSettingsFiles(i: LaunchInput): Record<string, string> {
  const level = i.effort && ["low", "medium", "high"].includes(i.effort) ? i.effort.toUpperCase() : undefined;
  return { [GEMINI_SETTINGS]: JSON.stringify({
    security: { auth: { selectedType: "gemini-api-key" } },
    ...(level ? { modelConfigs: { overrides: [{ match: { model: i.model }, modelConfig: { generateContentConfig: { thinkingConfig: { thinkingLevel: level } } } }] } } : {}),
    ...(i.mcp ? { mcpServers: { easyswitch: { httpUrl: i.mcp.url, headers: i.mcp.headers, trust: true } } } : {}),
  }) };
}

/**
 * Copilot takes its thinking level as a setting (`effortLevel`), not a flag: it goes into a settings file of a private
 * home that is used only when a level is asked for (BYOK needs no login there). Without a level the person's own home stays in use.
 */
function copilotSpec(i: LaunchInput, args: string[]): LaunchSpec {
  const env = copilotEnv(i);
  if (!i.effort) return { command: i.bin, args, env };
  const home = join(i.sessionDir, "copilot-home");
  return { command: i.bin, args, env: { ...env, COPILOT_HOME: home }, files: { [join(home, "settings.json")]: JSON.stringify({ effortLevel: i.effort }) } };
}

function copilotMcp(i: LaunchInput): string[] {
  return i.mcp ? ["--additional-mcp-config", JSON.stringify({ mcpServers: { easyswitch: { type: "http", url: i.mcp.url, headers: i.mcp.headers, tools: ["*"] } } })] : [];
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
  if (spec.dshMcpPlugin) prepareDshMcpPlugin(spec.dshMcpPlugin.bin, sessionDir, spec.dshMcpPlugin.packageDir);
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
): Promise<RunResult> {
  const launcher = LAUNCHERS[agentId];
  if (!launcher?.headless) throw new Error("这个 agent 还没有无界面的调用方式");
  const authority = opts.gatewayAuth ?? gatewayTokens;
  const sessionDir = newSessionDir();
  let token: string | undefined;
  try {
    token = authority.issue(agentId, { depth: opts.depth ?? 1, allowMcp: opts.attachMcp !== false, allowNativeClaude: false }).token;
    const mcp = opts.attachMcp === false ? undefined : mcpEndpoint(input.port, token, opts.depth ?? 1);
    const spec = launcher.headless({ ...input, token, sessionDir, ...(mcp ? { mcp } : {}) });
    materialize(spec, sessionDir);
    const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
    for (const name of spec.unset ?? []) delete env[name];
    const max = opts.maxBytes ?? 2_000_000;
    if (opts.signal?.aborted) return { exitCode: null, output: "任务已取消", timedOut: false };
    return await new Promise<RunResult>(resolve => {
      const child = spawn(spec.command, spec.args, { cwd: opts.cwd ?? sessionDir, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let timedOut = false;
      let bytes = 0;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const add = (d: Buffer) => { const take = Math.min(d.length, Math.max(0, max - bytes)); output += d.subarray(0, take).toString("utf8"); bytes += take; };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const stop = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      };
      const timer = setTimeout(() => { timedOut = true; stop(); }, opts.timeoutMs ?? 300_000);
      opts.signal?.addEventListener("abort", stop, { once: true });
      const cleanup = () => { clearTimeout(timer); clearTimeout(killTimer); opts.signal?.removeEventListener("abort", stop); };
      child.on("close", code => { cleanup(); resolve({ exitCode: code, output: output.trim(), timedOut }); });
      child.on("error", error => { cleanup(); resolve({ exitCode: null, output: String(error.message), timedOut }); });
    });
  } finally {
    if (token) authority.revoke(token);
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

export { run as _run };
