import { execFile, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { sessionToken } from "./gateway-chat.ts";
import { claudeArgs, claudeEnv, codexArgs, type McpAttach } from "./launch.ts";
import { mcpEndpoint } from "./mcp.ts";
import { knownEfforts } from "./efforts.ts";

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
  /** Extra models for this launch, by the launcher's tier ids (`<provider>/<model>`). */
  tiers?: Record<string, string>;
  /** Codex only: the merged model catalog to hand it (see catalog.ts). */
  catalog?: string;
  /** Reasoning level for this launch, one of the launcher's `efforts`. */
  effort?: string;
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
}

export interface AgentLauncher {
  verified: boolean;
  /** Other models this agent can run next to its main one, in the user's words. */
  tiers?: Array<{ id: string; label: string; hint: string }>;
  /** The reasoning levels this agent can be started with, in its own words. Empty or absent: it has no such setting. */
  efforts?: string[];
  interactive?: (i: LaunchInput) => LaunchSpec;
  headless?: (i: LaunchInput) => LaunchSpec;
}

const gateway = (i: LaunchInput) => `http://127.0.0.1:${i.port}`;
const openaiEnv = (i: LaunchInput): Record<string, string> => ({ OPENAI_BASE_URL: `${gateway(i)}/v1`, OPENAI_API_KEY: i.token, OPENAI_MODEL: i.model });

/** A YAML-safe quoted string (JSON strings are valid YAML). */
const q = (s: string) => JSON.stringify(s);

/** dsh: a patch overlay adds the gateway as a provider and makes it the default for this launch. */
function dshPatch(i: LaunchInput): string {
  return [
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    "      easyswitch:",
    "        displayName: EasySwitch",
    "        api: openai-responses",
    `        baseURL: ${q(`${gateway(i)}/v1`)}`,
    "        headers:",
    `          Authorization: ${q(`Bearer ${i.token}`)}`,
    "        models:",
    `          - id: ${q(i.model)}`,
    `            name: ${q(i.model.slice(i.model.indexOf("/") + 1))}`,
    "            input: [text]",
    "- id: agent-default-model",
    "  config:",
    "    provider: easyswitch",
    `    model: ${q(i.model)}`,
    "",
  ].join("\n");
}

export const LAUNCHERS: Record<string, AgentLauncher> = {
  // The two built-in agents. Headless forms run with the harness' own read-only defaults.
  codex: {
    verified: true,
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    tiers: [{ id: "subagent", label: "子 agent", hint: "它派出去的子 agent 用这个模型" }],
    interactive: i => ({ command: i.bin, args: [...codexArgs(i.port, i.model, i.catalog, i.mcp), ...codexExtras(i)], env: {} }),
    headless: i => ({ command: i.bin, args: ["exec", "--skip-git-repo-check", ...codexArgs(i.port, i.model, i.catalog, i.mcp), ...codexExtras(i), i.task ?? ""], env: { OPENAI_API_KEY: "" } }),
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
    headless: i => ({ command: i.bin, args: ["headless", "--patch", join(i.sessionDir, "patch.yml"), i.task ?? ""], env: { DSH_HOME: join(i.sessionDir, "dsh-home") }, files: { "patch.yml": dshPatch(i) } }),
  },

  // Hermes: a private HERMES_HOME holds a one-provider config, so ~/.hermes is never read or written.
  // Its home is kept between runs (it installs its runtime into it, which takes a minute); only the config is rewritten each launch.
  hermes: {
    verified: true,
    tiers: [
      { id: "small", label: "后台小任务", hint: "压缩对话、起标题、网页摘要、审批这类辅助调用用这个模型" },
      { id: "vision", label: "看图", hint: "识别图片用这个模型" },
    ],
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    interactive: i => ({ command: i.bin, args: i.effort ? ["chat", "--reasoning", i.effort] : [], env: { HERMES_HOME: hermesHome(i) }, files: hermesFiles(i) }),
    headless: i => ({ command: i.bin, args: ["chat", "-Q", ...(i.effort ? ["--reasoning", i.effort] : []), "-q", i.task ?? ""], env: { HERMES_HOME: hermesHome(i) }, files: hermesFiles(i) }),
  },

  // Documented overrides, not yet run against the real programs.
  "gemini-cli": {
    verified: false,
    interactive: i => ({ command: i.bin, args: [], env: geminiEnv(i) }),
    headless: i => ({ command: i.bin, args: ["-p", i.task ?? ""], env: geminiEnv(i) }),
  },
  "qwen-code": {
    verified: false,
    interactive: i => ({ command: i.bin, args: [], env: openaiEnv(i) }),
    headless: i => ({ command: i.bin, args: ["-p", i.task ?? ""], env: openaiEnv(i) }),
  },
  opencode: {
    verified: false,
    tiers: [{ id: "small", label: "小任务", hint: "标题、摘要这类轻量请求用这个模型" }],
    interactive: i => ({ command: i.bin, args: ["--model", `easyswitch/${i.model}`], env: { OPENCODE_CONFIG_CONTENT: opencodeConfig(i) } }),
    headless: i => ({ command: i.bin, args: ["run", "--model", `easyswitch/${i.model}`, i.task ?? ""], env: { OPENCODE_CONFIG_CONTENT: opencodeConfig(i) } }),
  },
  aider: {
    verified: false,
    tiers: [{ id: "small", label: "小任务", hint: "提交说明、对话摘要这类用 Aider 的「弱模型」" }],
    interactive: i => ({ command: i.bin, args: ["--openai-api-base", `${gateway(i)}/v1`, "--openai-api-key", i.token, "--model", `openai/${i.model}`, ...(i.tiers?.small ? ["--weak-model", `openai/${i.tiers.small}`] : [])], env: {} }),
    headless: i => ({ command: i.bin, args: ["--openai-api-base", `${gateway(i)}/v1`, "--openai-api-key", i.token, "--model", `openai/${i.model}`, ...(i.tiers?.small ? ["--weak-model", `openai/${i.tiers.small}`] : []), "--message", i.task ?? "", "--yes-always", "--no-auto-commits"], env: {} }),
  },
  "copilot-cli": {
    verified: false,
    interactive: i => ({ command: i.bin, args: [], env: copilotEnv(i) }),
    headless: i => ({ command: i.bin, args: ["-p", i.task ?? ""], env: copilotEnv(i) }),
  },
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
  return {
    [join(hermesHome(i), "config.yaml")]: [
      "model:",
      `  default: ${q(i.model)}`,
      "  provider: custom:easyswitch",
      `  base_url: ${q(`${gateway(i)}/v1`)}`,
      "custom_providers:",
      "  - name: easyswitch",
      `    base_url: ${q(`${gateway(i)}/v1`)}`,
      // The gateway reads only the agent id from this, so one fixed value keeps the file stable between runs.
      `    api_key: ${q("es-session-hermes-private")}`,
      "    api_mode: chat_completions",
      "    discover_models: false",
      "    models:",
      ...[...new Set([i.model, ...Object.values(i.tiers ?? {})])].map(m => `      ${q(m)}: {}`),
      // Hermes runs these side jobs on models of their own; each is pointed at the same private provider.
      ...(i.tiers && Object.keys(i.tiers).length ? ["auxiliary:"] : []),
      ...[
        ...(i.tiers?.small ? ["compression", "title_generation", "web_extract", "skills_hub", "approval", "mcp"].map(k => [k, i.tiers!.small!] as const) : []),
        ...(i.tiers?.vision ? [["vision", i.tiers.vision] as const] : []),
      ].flatMap(([k, m]) => [`  ${k}:`, "    provider: custom:easyswitch", `    model: ${q(m)}`]),
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
        models: Object.fromEntries([i.model, ...(i.tiers?.small ? [i.tiers.small] : [])].map(m => [m, { name: m.slice(m.indexOf("/") + 1) }])),
      },
    },
    ...(i.tiers?.small ? { small_model: `easyswitch/${i.tiers.small}` } : {}),
  });
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
  opts: { cwd?: string; timeoutMs?: number; maxBytes?: number; depth?: number; attachMcp?: boolean; signal?: AbortSignal } = {},
): Promise<RunResult> {
  const launcher = LAUNCHERS[agentId];
  if (!launcher?.headless) throw new Error("这个 agent 还没有无界面的调用方式");
  const sessionDir = newSessionDir();
  const token = sessionToken(agentId);
  // The called agent can call one level further down (the depth rides in the MCP headers).
  const mcp = opts.attachMcp === false ? undefined : mcpEndpoint(input.port, token, opts.depth ?? 1);
  const spec = launcher.headless({ ...input, token, sessionDir, ...(mcp ? { mcp } : {}) });
  materialize(spec, sessionDir);
  const env: NodeJS.ProcessEnv = { ...process.env, ...spec.env };
  for (const name of spec.unset ?? []) delete env[name];
  const max = opts.maxBytes ?? 2_000_000;
  try {
    return await new Promise<RunResult>(resolve => {
      const child = spawn(spec.command, spec.args, { cwd: opts.cwd ?? sessionDir, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let timedOut = false;
      const add = (d: Buffer) => { if (output.length < max) output += d.toString("utf8"); };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, opts.timeoutMs ?? 300_000);
      // A stop request ends the run: politely first, then for good.
      opts.signal?.addEventListener("abort", () => {
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 3000).unref();
      }, { once: true });
      child.on("close", code => { clearTimeout(timer); resolve({ exitCode: code, output: output.trim(), timedOut }); });
      child.on("error", error => { clearTimeout(timer); resolve({ exitCode: null, output: String(error.message), timedOut }); });
    });
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
}

export { run as _run };
