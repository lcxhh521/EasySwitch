import { AGENTS, type AgentInfo } from "./agents.ts";
import { LAUNCHERS, effortsOf, type AgentLauncher, type LaunchInput, type LaunchSpec } from "./agent-launch.ts";

/**
 * What EasySwitch can do with each agent, feature by feature, with nothing left unsaid.
 *
 * A feature is only "done" when it is done for every agent it applies to, so every agent has an
 * explicit state for every feature: finished and tried against the real program, finished from the
 * vendor's documentation but not tried, set up by hand with EasySwitch's help, impossible (with the
 * reason), or not done yet. Whatever can be read off the code is read off the code (does the
 * launcher really carry the MCP server? the thinking level?), so the table cannot drift from what the
 * launchers do; only what code cannot say (reasons, decisions) is written down here.
 */

export type CapState = "verified" | "documented" | "manual" | "impossible" | "todo" | "na";

export interface Cap {
  state: CapState;
  /** Why, in a sentence the user can read. Required for impossible; useful everywhere else. */
  note?: string;
}

export const FEATURES = [
  { id: "launch", label: "在 EasySwitch 上启动", hint: "用你的模型启动它；桌面端 / IDE 指把它接上 EasySwitch" },
  { id: "task", label: "接后台任务", hint: "无界面地接一个任务，把结果交回来" },
  { id: "mcp", label: "能调用其他 agent", hint: "启动时挂上 EasySwitch 的 MCP，它就能把活派给别的 agent" },
  { id: "effort", label: "调想得多深", hint: "按 agent 设置思考档位" },
  { id: "tiers", label: "子 agent / 小任务用别的模型", hint: "同一个 agent 里不同用途用不同模型" },
  { id: "source", label: "它的订阅当模型来源", hint: "把它背后的订阅额度给其他 agent 用" },
] as const;

export type FeatureId = typeof FEATURES[number]["id"];
export type AgentCaps = Record<FeatureId, Cap>;

export const STATE_LABEL: Record<CapState, string> = {
  verified: "已实测",
  documented: "按文档做了，未实测",
  manual: "手动配置（EasySwitch 给出配置）",
  impossible: "做不了",
  todo: "还没做",
  na: "不适用",
};

/** A launch input that is never run: only used to see what a launcher puts on the command line. */
const PROBE_MCP = { url: "http://127.0.0.1:1/mcp-probe", headers: { Authorization: "Bearer probe", "x-easyswitch-depth": "0" } };
function probeInput(extra: Partial<LaunchInput>): LaunchInput {
  return { bin: "/bin/probe", port: 1, model: "p/m", token: "es-session-probe-0", sessionDir: "/tmp/es-probe", stateDir: "/tmp/es-probe-state", task: "probe", ...extra };
}

function specText(spec: LaunchSpec): string {
  return JSON.stringify([spec.args, spec.env, spec.files]);
}

/** Does this launcher really carry the EasySwitch MCP server, in either of its forms? */
export function launcherCarriesMcp(l: AgentLauncher | undefined): boolean {
  if (!l) return false;
  const forms = [l.interactive, l.headless].filter(Boolean) as Array<(i: LaunchInput) => LaunchSpec>;
  return forms.some(form => specText(form(probeInput({ mcp: PROBE_MCP }))).includes("mcp-probe"));
}

/** Does this launcher have a thinking-level setting of its own (a flag), not just the gateway's? */
export function launcherHasOwnEffort(l: AgentLauncher | undefined): boolean {
  if (!l) return false;
  const forms = [l.interactive, l.headless].filter(Boolean) as Array<(i: LaunchInput) => LaunchSpec>;
  return forms.some(form => specText(form(probeInput({ effort: "high" }))) !== specText(form(probeInput({}))));
}

/** Tried against the real program, with a test that stays in the suite. */
const MCP_VERIFIED = new Set(["codex", "claude"]);

const NO_ENDPOINT = "请求走它自己的服务器，没有本地可改的端点，EasySwitch 没法把别的模型接进它";

/**
 * What code cannot say: why something is impossible, what has been decided, who is doing it.
 * Anything an agent has no entry for here is derived from its launcher, or is "todo".
 */
const DECLARED: Record<string, Partial<Record<FeatureId, Cap>>> = {
  codex: {
    source: { state: "documented", note: "「Continue with ChatGPT」：用 Codex 的登录身份，额度和 ChatGPT 订阅共用（用本地假服务验证过，没用真账号测）" },
  },
  claude: {
    source: { state: "impossible", note: "按你的决定：Claude 订阅不借给别的 harness（风险太大）；Claude Code 里原生模型和外接模型并排显示" },
  },
  "copilot-cli": {
    source: { state: "documented", note: "用 GitHub 设备码登录，换短期令牌（用本地假服务验证过，没用真账号测）" },
  },
  cursor: {
    launch: { state: "impossible", note: NO_ENDPOINT },
    task: { state: "impossible", note: NO_ENDPOINT },
    source: { state: "todo", note: "订阅适配由 GPT 在做" },
  },
  kiro: {
    launch: { state: "impossible", note: "绑定 AWS 登录，没有本地可改的端点" },
    task: { state: "impossible", note: "绑定 AWS 登录，没有本地可改的端点" },
    source: { state: "todo", note: "订阅适配由 GPT 在做" },
  },
  antigravity: {
    launch: { state: "impossible", note: "绑定 Google 登录，没有自定义端点" },
    task: { state: "impossible", note: "绑定 Google 登录，没有自定义端点" },
    source: { state: "todo", note: "订阅适配由 GPT 在做" },
  },
  windsurf: {
    launch: { state: "impossible", note: "闭源，没有自定义端点" },
    task: { state: "impossible", note: "闭源，没有自定义端点" },
    source: { state: "todo", note: "还没调研它的订阅怎么接" },
  },
  "claude-desktop": {
    launch: { state: "impossible", note: "它的模型菜单由 claude.ai 账号决定，没有官方的扩展口；让外接模型出现在里面只能拦截它的流量，我们不做。需要外接模型时用 Claude Code 或 EasySwitch 自己的界面" },
    task: { state: "impossible", note: "桌面应用，没有无界面的调用方式" },
    mcp: { state: "impossible", note: "不能启动它，也就没法给它挂 MCP" },
    effort: { state: "impossible", note: "不经过 EasySwitch" },
    tiers: { state: "impossible", note: "不经过 EasySwitch" },
    source: { state: "impossible", note: "按你的决定：Claude 订阅不借给别的 harness" },
  },
};

/** Closed apps that need EasySwitch to hand the user the settings to type in by hand: see the setup helper. */
const BY_HAND = new Set(["trae", "zcode", "windsurf"]);

/** The agents whose own subscription is worth turning into a model source (everyone else: not applicable). */
const HAS_SUBSCRIPTION = new Set(["gemini-cli", "qoder-cli", "codebuddy", "trae", "amp", "doubao", "grok-build", "minimax-code", "kimi-cli", "droid"]);

function derive(agent: AgentInfo): AgentCaps {
  const l = LAUNCHERS[agent.id];
  const d = DECLARED[agent.id] ?? {};
  const closed = agent.support === "open";
  const withForm = (form: unknown, what: string): Cap =>
    form ? { state: l!.verified ? "verified" : "documented", note: l!.verified ? undefined : `${what}按官方文档写的，还没在真实程序上跑过` } : { state: "todo" };

  const launch: Cap = d.launch ?? (l?.interactive ? withForm(l.interactive, "启动方式")
    : BY_HAND.has(agent.id) ? { state: "todo", note: "要做「手动配置向导」：地址、令牌、模型一键复制，再附它的操作步骤" }
    : closed ? { state: "todo", note: "还没定方案" }
    : { state: "todo", note: l ? "只做了无界面形态" : "还没写启动方式" });
  const task: Cap = d.task ?? (l?.headless ? withForm(l.headless, "无界面形态")
    : closed ? { state: "impossible", note: "桌面应用 / IDE，没有无界面的调用方式" }
    : { state: "todo", note: l ? "还没有无界面形态" : "还没写启动方式" });

  const hasLauncher = Boolean(l);
  const mcp: Cap = d.mcp ?? (launcherCarriesMcp(l)
    ? { state: MCP_VERIFIED.has(agent.id) ? "verified" : "documented" }
    : { state: "todo", note: hasLauncher ? "还没查它每次启动怎么指定 MCP" : "要先有启动方式" });
  const effort: Cap = d.effort ?? (!hasLauncher ? { state: "todo", note: "要先有启动方式" }
    : launcherHasOwnEffort(l) ? { state: l!.verified ? "verified" : "documented", note: `用它自己的档位：${(effortsOf(agent.id) ?? []).join(" / ") || "读自程序"}` }
    : { state: "documented", note: "没有自己的档位参数，由网关改写它发出的请求（上游认才有效）" });
  const tiers: Cap = d.tiers ?? ((l?.tiers?.length ?? 0) > 0 ? { state: "documented", note: l!.tiers!.map(t => t.label).join("、") }
    : { state: "todo", note: hasLauncher ? "还没调研它有没有对应设置" : "要先有启动方式" });
  const source: Cap = d.source ?? (HAS_SUBSCRIPTION.has(agent.id) ? { state: "todo", note: "还没调研它的订阅怎么接" } : { state: "na", note: "没有可借用的订阅" });

  return { launch, task, mcp, effort, tiers, source };
}

export function capabilityMatrix(agents: readonly AgentInfo[] = AGENTS): Record<string, AgentCaps> {
  return Object.fromEntries(agents.map(a => [a.id, derive(a)]));
}

export interface CoverageRow {
  feature: FeatureId;
  label: string;
  counts: Record<CapState, number>;
  /** Agents the feature applies to (everything but "not applicable"). */
  applies: number;
  /** Of those, how many are finished or settled (verified, documented, manual, impossible with a reason). */
  settled: number;
}

export function coverage(matrix: Record<string, AgentCaps>): CoverageRow[] {
  return FEATURES.map(f => {
    const counts: Record<CapState, number> = { verified: 0, documented: 0, manual: 0, impossible: 0, todo: 0, na: 0 };
    for (const caps of Object.values(matrix)) counts[caps[f.id].state] += 1;
    const applies = Object.keys(matrix).length - counts.na;
    return { feature: f.id, label: f.label, counts, applies, settled: applies - counts.todo };
  });
}
