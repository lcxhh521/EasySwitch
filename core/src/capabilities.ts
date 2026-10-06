import { subscriptionSourceCapability, type SubscriptionVendor } from "./subscription-support.ts";
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
  { id: "picker", label: "在它自己的界面里选模型", hint: "启动后在 agent 自己的模型菜单里换到别的来源的模型，不用回到 EasySwitch" },
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

/** Does this launcher put every model it is given into the agent's own list (and not only the default)? */
export function launcherListsModels(l: AgentLauncher | undefined): boolean {
  if (!l) return false;
  const forms = [l.interactive, l.headless].filter(Boolean) as Array<(i: LaunchInput) => LaunchSpec>;
  const models = ["probe/alpha-1", "probe/beta-2", "probe/gamma-3"];
  return forms.some(form => {
    const text = specText(form(probeInput({ model: models[0]!, models })));
    return text.includes("beta-2") && text.includes("gamma-3");
  });
}

/** Tried against the real program, with a test that stays in the suite. */
const MCP_VERIFIED = new Set(["codex", "claude"]);

const NO_ENDPOINT = "请求走它自己的服务器，没有本地可改的端点，EasySwitch 没法把别的模型接进它";

/**
 * What code cannot say: why something is impossible, what has been decided, who is doing it.
 * Anything an agent has no entry for here is derived from its launcher, or is "todo".
 */
const DECLARED: Record<string, Partial<Record<FeatureId, Cap>>> = {
  "grok-build": {
    source: { state: "todo", note: "做得了：读 Grok CLI 本机的登录文件（~/.grok/auth.json），转发到它的 cli-chat-proxy 代理（Responses 风格，要带一组仿 CLI 的头）；令牌每次刷新会轮换，过期了要让 Grok 自己刷新，不能我们刷。风险：仿客户端标识。见 research/subscription-sources-3.md" },
  },
  "qoder-cli": {
    source: { state: "documented", note: "实验性CLI纯文字来源已接入：显式PAT、私有HOME/cwd、默认关闭；不支持工具/图片，角色只作文字transcript，结果缓冲；仅假程序验证，真实CLI未验收" },
  },
  "gemini-cli": {
    source: { state: "impossible", note: "个人账号的 Google 登录已不再提供给 Gemini CLI 的 Code Assist（只有标准版/企业版账号，且要自备 Cloud 项目）；想用自己的 Gemini 额度，走 API Key（已有 Google 预设）。企业账号走 Code Assist 的路是可做的，但我们没有这类账号可测" },
  },
  "kimi-cli": {
    source: { state: "documented", note: "两种办法：Kimi 编程套餐的 Key（预设）；或用 Kimi 会员设备码登录（令牌存钥匙串、额度能显示）。官方允许会员在第三方工具里用；都只用假服务验证过，没有用真账号测" },
  },
  codex: {
    picker: { state: "verified", note: "模型目录里原生模型和外接模型放在一起（用真实 Codex 验证过）" },
    source: { state: "documented", note: "「Continue with ChatGPT」：用 Codex 的登录身份，额度和 ChatGPT 订阅共用（用本地假服务验证过，没用真账号测）" },
  },
  claude: {
    picker: { state: "verified", note: "/model 里原生 Claude 模型和外接模型并排（保留你自己的登录）" },
    source: { state: "impossible", note: "按你的决定：Claude 订阅不借给别的 harness（风险太大）；Claude Code 里原生模型和外接模型并排显示" },
  },
  "copilot-cli": {
    source: { state: "documented", note: "用 GitHub 设备码登录，换短期令牌（用本地假服务验证过，没用真账号测）" },
  },
  cursor: {
    launch: { state: "impossible", note: NO_ENDPOINT },
    task: { state: "impossible", note: NO_ENDPOINT },
    source: { state: "documented", note: "在浏览器里登录 Cursor 就能当模型来源（纯文字对话：它不能替 agent 执行工具）；用假的 Cursor 服务验证过，没有用真账号测；有被限制账号的风险，默认关" },
  },
  kiro: {
    launch: { state: "impossible", note: "绑定 AWS 登录，没有本地可改的端点" },
    task: { state: "impossible", note: "绑定 AWS 登录，没有本地可改的端点" },
    source: { state: "documented", note: "Claude 已实现专用适配器并做假服务测试；新来源默认关闭，未做真实账号验收，条款及账号风险需单独核对" },
  },
  antigravity: {
    launch: { state: "impossible", note: "绑定 Google 登录，没有自定义端点" },
    task: { state: "impossible", note: "绑定 Google 登录，没有自定义端点" },
    source: { state: "documented", note: "Claude 已实现专用适配器并做假服务测试；新来源默认关闭，未做真实账号验收，条款及账号风险需单独核对" },
  },
  trae: {
    source: { state: "impossible", note: "国际版没有文档化的接口；国内版只有靠逆向 IDE 登录的社区做法，风险自担，我们暂不做" },
    launch: { state: "manual", note: "配置向导：给出接口地址、令牌和模型，你在 Trae 的设置里添加一次；Trae 没有每次启动单独指定的办法，我们不改它的文件" },
    task: { state: "impossible", note: "桌面 IDE，没有无界面的调用方式" },
    picker: { state: "manual", note: "你把想用的模型逐个添加到 Trae 里，之后在它自己的模型选择里换" },
  },
  zcode: {
    launch: { state: "manual", note: "配置向导：给出接口地址、令牌和模型，你在 Z Code 的设置里添加一次；它的供应商在全局配置里，没有每次启动单独指定的办法，我们不改 ~/.zcode" },
    task: { state: "impossible", note: "桌面应用，没有无界面的调用方式" },
    picker: { state: "manual", note: "你把想用的模型逐个添加到 Z Code 里，之后在它自己的选择器里换" },
  },
  doubao: {
    source: { state: "documented", note: "火山方舟编程套餐已经是现成的预设：填它的 key 就能当模型来源（地址 .../api/coding/v3）。条款写明：套餐额度只给指定的编程工具用，用在别处可能被停用订阅" },
    launch: { state: "impossible", note: "聊天客户端，没有自定义模型或自定义地址的入口（豆包的模型可以通过火山方舟当模型来源接进别的 agent）" },
    task: { state: "impossible", note: "桌面聊天客户端，没有无界面的调用方式" },
  },
  windsurf: {
    launch: { state: "impossible", note: "闭源，没有自定义端点" },
    task: { state: "impossible", note: "闭源，没有自定义端点" },
    source: { state: "todo", note: "还没调研它的订阅怎么接" },
  },

  amp: {
    source: { state: "impossible", note: "没有公开的兼容接口，额度是 Amp 内部的，转不成通用来源" },
    launch: { state: "impossible", note: "请求走它自己的 ampcode.com 并要求账号登录，没有 OpenAI 兼容的自定义端点；只能检测并打开" },
    task: { state: "impossible", note: "它只认自己的账号服务，没法把别的模型接进它" },
    mcp: { state: "impossible", note: "它只认自己的账号服务，没法给它挂我们的 MCP" },
    effort: { state: "impossible", note: "它自己挑模型，不开放档位" },
    tiers: { state: "impossible", note: "它自己挑模型，不开放" },
  },
  // CodeBuddy Code (the command line) and WorkBuddy (the desktop app) are two products: they are never described as one.

  workbuddy: {
    source: { state: "todo", note: "远端 B68 记录了私有客户端方案的研究方向；不是已获官方支持的接口，本轮未实现或启用" },
    launch: { state: "manual", note: "配置向导：按官方 Settings → Model 的 Custom 设置给出完整地址、临时令牌和模型列表；用户自己填写，不改 WorkBuddy 文件。真实应用尚未实测，和 CodeBuddy Code 命令行分开" },
    picker: { state: "manual", note: "向导给出所有可用模型 ID，你在官方自定义模型设置中逐个添加，之后在应用窗口切换" },
    task: { state: "impossible", note: "桌面应用，没有无界面的调用方式" },
    mcp: { state: "todo", note: "还没查它的 MCP 配置怎么给" },
    effort: { state: "todo", note: "还没核实当前桌面设置是否能传自定义模型档位，不编造能力字段" },
    tiers: { state: "todo", note: "还没查它有没有子 agent / 小任务的模型设置" },
  },
  "minimax-code": {
    source: { state: "documented", note: "MiniMax 编程套餐（Token Plan）的 Key 已经是现成的预设；用 MiniMax Code 账号登录的那种没有可查的资料，暂不做" },
    mcp: { state: "impossible", note: "它没有用户级的 MCP 配置文件，只有插件自带的；每次启动挂不上" },
  },
  pi: {
    mcp: { state: "impossible", note: "核心没有内置 MCP（靠扩展包）" },
  },
  dsh: {
    mcp: { state: "documented", note: "私有 DSH_HOME 只链接已安装的 dsh-mcp-client；缺失时继续任务但不挂MCP并说明原因，错误路径或不安全链接仍拒绝；配置和假调用已测试；Claude 历史版本实测过 MCP 工具可见，本次插件隔离合并尚未真机验收" },
    effort: { state: "documented", note: "按模型提供的档位生成 dsh 映射，不自造档位；仅配置测试，真实 CLI 未实测" },
    tiers: { state: "documented", note: "子 agent、小任务、标题和压缩模型写入私有 patch；Claude 历史版本实测标题走小模型，未触发子 agent；本次合并仅配置测试，真实 CLI 未实测" },
  },
  aider: {
    mcp: { state: "impossible", note: "原版 Aider 没有 MCP 客户端" },
  },
  "trae-agent": {
    picker: { state: "impossible", note: "它没有模型菜单，每次只能用命令行参数指定一个模型" },
    mcp: { state: "documented", note: "已通过私有配置及本地 stdio/HTTP 桥挂载，假服务测试通过，真实 CLI 未实测" },
  },
  "claude-desktop": {
    picker: { state: "todo", note: "第三方网关模式下它会读网关的模型列表，还没做" },
    launch: { state: "todo", note: "官方签名版 2.19675.1 忽略 CLAUDE_USER_DATA_DIR；隔离后台与界面只有模拟测试，真实应用尚未实测，真实启动已阻塞。不拦截、不绕过安全机制" },
    task: { state: "impossible", note: "桌面应用，没有无界面的调用方式" },
    mcp: { state: "todo", note: "还没查桌面端的 MCP 配置在第三方模式下怎么给" },
    effort: { state: "todo", note: "网关模式下档位由我们返回的模型信息决定（opencodex 就是这么做的），还没做" },
    tiers: { state: "todo", note: "还没查桌面端有没有子 agent / 小任务的模型设置" },
    source: { state: "impossible", note: "按你的决定：Claude 订阅不借给别的 harness" },
  },
};

/** The agents whose own subscription is worth turning into a model source (everyone else: not applicable). */
const SUBSCRIPTION_VENDOR: Record<string, SubscriptionVendor> = { "gemini-cli": "gemini-cli", "qoder-cli": "qoder", codebuddy: "codebuddy", trae: "trae", amp: "amp", doubao: "doubao", "grok-build": "grok", "minimax-code": "minimax", "kimi-cli": "kimi", droid: "droid" };
const HAS_SUBSCRIPTION = new Set(["gemini-cli", "qoder-cli", "codebuddy", "trae", "amp", "doubao", "grok-build", "minimax-code", "kimi-cli", "droid"]);

function derive(agent: AgentInfo): AgentCaps {
  const l = LAUNCHERS[agent.id];
  const d = DECLARED[agent.id] ?? {};
  const closed = agent.support === "open";
  const withForm = (form: unknown, what: string): Cap =>
    form ? { state: l!.verified ? "verified" : "documented", ...(l!.verified ? {} : { note: l!.caveat ? `没在真实程序上跑过。${l!.caveat}` : `${what}按官方文档写的，还没在真实程序上跑过` }) } : { state: "todo" };

  const launch: Cap = d.launch ?? (l?.interactive ? withForm(l.interactive, "启动方式")
    : closed ? { state: "todo", note: "还没定方案" }
    : { state: "todo", note: l ? "只做了无界面形态" : "还没写启动方式" });
  const task: Cap = d.task ?? (l?.headless ? withForm(l.headless, "无界面形态")
    : closed ? { state: "impossible", note: "桌面应用 / IDE，没有无界面的调用方式" }
    : { state: "todo", note: l ? "还没有无界面形态" : "还没写启动方式" });

  const hasLauncher = Boolean(l);
  const mcp: Cap = d.mcp ?? (launcherCarriesMcp(l)
    ? { state: MCP_VERIFIED.has(agent.id) ? "verified" : "documented", ...(l?.mcpCaveat && !MCP_VERIFIED.has(agent.id) ? { note: l.mcpCaveat } : {}) }
    : { state: "todo", note: hasLauncher ? "还没查它每次启动怎么指定 MCP" : "要先有启动方式" });
  const effort: Cap = d.effort ?? (!hasLauncher ? { state: "todo", note: "要先有启动方式" }
    : launcherHasOwnEffort(l) ? { state: l!.verified ? "verified" : "documented", note: effortsOf(agent.id) ? `用它自己的档位：${effortsOf(agent.id)!.join(" / ")}` : "模型有哪些档位就能设哪些，我们写进它的配置" }
    : { state: "documented", note: "没有自己的档位参数，由网关改写它发出的请求（上游认才有效）" });
  const tiers: Cap = d.tiers ?? ((l?.tiers?.length ?? 0) > 0 ? { state: "documented", note: l!.tiers!.map(t => t.label).join("、") }
    : { state: "todo", note: hasLauncher ? "还没调研它有没有对应设置" : "要先有启动方式" });
  const picker: Cap = d.picker ?? (launch.state === "impossible" ? { state: "impossible", note: "不经过 EasySwitch，用什么模型由它自己决定" }
    : !hasLauncher ? { state: "todo", note: "要先有启动方式" }
    : launcherListsModels(l) ? { state: l!.verified ? "verified" : "documented", note: "所有可用的模型都写进了它的私有配置，EasySwitch 里选的只是默认" + (l!.verified ? "" : "；还没在真实程序上确认它的菜单真的列出来") }
    : { state: "todo", note: l!.pickerNote ?? "它的配置一次只能指定一个模型，还没查它启动后能不能列出或切换到别的模型" });
  const source: Cap = agent.id === "qoder-cli" ? d.source! : agent.id === "codebuddy" ? { state: "documented", note: "实验性官方CLI纯文字来源：显式区域/API Key、私有会话、默认关闭；拒绝工具/媒体，不继承网关地址，只有fake验证，真实CLI未验收；与CodeBuddy入站启动器独立" } : agent.id === "droid" ? { state: "todo", note: "Droid纯文字控制器仅有假传输测试；生产传输和隔离尚未核实，创建与请求返回501" } : SUBSCRIPTION_VENDOR[agent.id] ? subscriptionSourceCapability(SUBSCRIPTION_VENDOR[agent.id]!) : d.source ?? (HAS_SUBSCRIPTION.has(agent.id) ? { state: "todo", note: "还没调研它的订阅怎么接" } : { state: "na", note: "没有可借用的订阅" });

  return { launch, task, mcp, effort, tiers, picker, source };
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
