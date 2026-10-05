import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Every coding agent we know of, and how far EasySwitch can go with each.
 * Entries come from a survey of what opencodex (MIT), Magpie (MIT) and CC Switch
 * list as supported, plus the vendors' own agents; the survey and the per-agent
 * launch hooks are recorded in PROVENANCE.md. Detection is read-only: a binary
 * on PATH or an app bundle, nothing is started.
 *
 * support:
 *  - "ready"   EasySwitch can start an augmented session on the user's models.
 *  - "planned" speaks an open protocol with a per-launch override; being added.
 *  - "open"    closed or login-bound: EasySwitch can only detect and open it.
 */
export type AgentSupport = "ready" | "planned" | "open";
export type AgentKind = "cli" | "desktop" | "ide";
export type WireProtocol = "responses" | "anthropic" | "chat" | "gemini";

export interface AgentInfo {
  id: string;
  name: string;
  vendor: string;
  kind: AgentKind;
  support: AgentSupport;
  /** What it speaks to a custom endpoint; empty for closed agents. */
  protocols: WireProtocol[];
  icon: string;
  /** Command names to look for on PATH. */
  bins?: string[];
  /** App bundle names under /Applications or ~/Applications. */
  apps?: string[];
  /** Extra absolute paths that count as installed. */
  paths?: string[];
  /** One honest line: how it is wired, or why it cannot be. */
  note: string;
}

const A = (id: string, name: string, vendor: string, kind: AgentKind, support: AgentSupport, protocols: WireProtocol[], icon: string, note: string, find: Pick<AgentInfo, "bins" | "apps" | "paths"> = {}): AgentInfo =>
  ({ id, name, vendor, kind, support, protocols, icon, note, ...find });

export const AGENTS: AgentInfo[] = [
  // Ready
  A("codex", "ChatGPT", "OpenAI", "desktop", "ready", ["responses"], "openai", "命令行和桌面端；每次启动单独指向 EasySwitch，不改 ~/.codex", { bins: ["codex"], apps: ["ChatGPT"] }),
  A("claude", "Claude Code", "Anthropic", "cli", "ready", ["anthropic"], "claudecode-color", "环境变量 + --settings，只对这一次启动生效；Claude 订阅流量不经过 EasySwitch", { bins: ["claude"], paths: [join(homedir(), ".local/bin/claude")] }),

  // Planned: open protocol, per-launch override exists
  A("qwen-code", "Qwen Code", "阿里", "cli", "planned", ["chat"], "qwen-color", "OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL", { bins: ["qwen"] }),
  A("gemini-cli", "Gemini CLI", "Google", "cli", "ready", ["gemini"], "gemini-color", "GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY（网关已提供 Gemini 协议入口）", { bins: ["gemini"] }),
  A("opencode", "opencode", "sst", "cli", "planned", ["chat", "anthropic", "responses"], "opencode", "OPENCODE_CONFIG_CONTENT 内联配置", { bins: ["opencode"] }),
  A("dsh", "DeepSeek Harness", "深度求索", "cli", "planned", ["chat"], "deepseek-harness", "dsh --patch 每次启动叠加一层配置", { bins: ["dsh"], apps: ["DeepSeek Harness"], paths: ["/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"] }),
  A("kimi-cli", "Kimi Code", "月之暗面", "cli", "planned", ["chat"], "kimi-color", "KIMI_CODE_HOME 临时目录 + 配置", { bins: ["kimi"] }),
  A("copilot-cli", "Copilot CLI", "GitHub", "cli", "planned", ["chat", "anthropic"], "github-copilot-color", "官方 BYOK：COPILOT_PROVIDER_BASE_URL / TYPE / API_KEY", { bins: ["copilot"] }),
  A("hermes", "Hermes Agent", "Nous", "cli", "ready", ["chat"], "hermes-agent", "私有 HERMES_HOME 临时目录，不碰 ~/.hermes（已在真实程序上跑通）", { bins: ["hermes"], paths: [join(homedir(), ".local/bin/hermes")], apps: ["Hermes"] }),
  A("pi", "Pi", "pi-mono", "cli", "planned", ["chat", "anthropic", "responses"], "pi", "PI_CODING_AGENT_DIR 临时目录 + models.json", { bins: ["pi"] }),
  A("omp", "Oh My Pi", "社区", "cli", "planned", ["chat"], "oh-my-pi", "PI_CONFIG_DIR + models.yml", { bins: ["omp"] }),
  A("droid", "Droid", "Factory", "cli", "planned", ["chat", "anthropic", "responses"], "factory-droid", "FACTORY_HOME_OVERRIDE + customModels", { bins: ["droid"] }),
  A("cline", "Cline CLI", "Cline", "cli", "planned", ["chat", "anthropic"], "cline-color", "CLINE_DIR + providers.json", { bins: ["cline"] }),
  A("aider", "Aider", "社区", "cli", "planned", ["chat", "anthropic"], "letter:A", "--openai-api-base / --openai-api-key / --model", { bins: ["aider"] }),
  A("goose", "Goose", "Block", "cli", "planned", ["chat"], "letter:G", "custom_providers 配置 + 环境变量", { bins: ["goose"], apps: ["Goose"] }),
  A("crush", "Crush", "Charm", "cli", "planned", ["chat", "anthropic"], "letter:C", "CRUSH_GLOBAL_CONFIG / XDG_CONFIG_HOME", { bins: ["crush"] }),
  A("grok-build", "Grok Build", "xAI", "cli", "planned", ["chat"], "grok", "GROK_HOME 临时目录 + config.toml", { bins: ["grok"] }),
  A("minimax-code", "MiniMax Code", "MiniMax", "cli", "planned", ["anthropic"], "minimax-color", "MINIMAX_DATA_DIR + config.yaml", { bins: ["mcode"] }),
  A("qoder-cli", "Qoder CLI", "阿里", "cli", "planned", ["chat"], "letter:Q", "QODER_CONFIG_DIR + settings.json（国区 QODERCN_CONFIG_DIR）", { bins: ["qodercli"] }),
  A("codebuddy", "CodeBuddy / WorkBuddy", "腾讯", "cli", "planned", ["chat"], "letter:C", "WORKBUDDY_CONFIG_DIR + models.json；使用条款待核实", { bins: ["codebuddy"], apps: ["WorkBuddy"] }),
  A("openclaw", "OpenClaw", "社区", "cli", "planned", ["chat", "anthropic"], "openclaw", "OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR", { bins: ["openclaw"] }),
  A("trae-agent", "Trae Agent", "字节跳动", "cli", "planned", ["chat", "anthropic"], "letter:T", "开源命令行：--config-file / --model-base-url / --api-key（豆包和火山方舟的模型可用）", { bins: ["trae-cli"] }),
  A("atomcode", "Atomcode", "AtomGit", "cli", "planned", ["chat"], "letter:A", "ATOMCODE_HOME + config.toml", { bins: ["atomcode"] }),

  // Open: closed or login-bound; detect and open only
  A("cursor", "Cursor", "Cursor", "ide", "open", [], "cursor-color", "请求走 Cursor 自己的服务器，没有本地可改的端点；只能检测并打开", { bins: ["cursor", "cursor-agent"], apps: ["Cursor"] }),
  A("trae", "Trae", "字节跳动", "ide", "open", [], "letter:T", "闭源 IDE，自定义模型只能在它的界面里手动添加；只能检测并打开", { apps: ["Trae", "Trae CN"] }),
  A("antigravity", "Antigravity", "Google", "ide", "open", [], "antigravity-color", "绑定 Google 登录，没有自定义端点；只能检测并打开", { apps: ["Antigravity"] }),
  A("windsurf", "Windsurf / Devin", "Cognition", "ide", "open", [], "devin", "闭源，没有自定义端点；只能检测并打开", { apps: ["Windsurf", "Wind"], bins: ["windsurf", "devin"] }),
  A("kiro", "Kiro", "AWS", "ide", "open", [], "kiro-color", "绑定 AWS 登录；只能检测并打开", { apps: ["Kiro"], bins: ["kiro-cli", "kiro"] }),
  A("amp", "Amp", "Sourcegraph", "cli", "open", [], "letter:A", "绑定账号，没有自定义端点；只能检测并打开", { bins: ["amp"] }),
  A("zcode", "Z Code", "智谱", "desktop", "open", ["anthropic"], "zcode", "只有全局配置文件，没有按次启动的覆盖办法；暂只检测并打开", { apps: ["Z Code", "ZCode"], paths: [join(homedir(), ".zcode")] }),
  A("doubao", "豆包", "字节跳动", "desktop", "open", [], "letter:豆", "聊天客户端，没有自定义端点入口；只能检测并打开（豆包的模型可通过火山方舟接入）", { apps: ["Doubao", "豆包"] }),
];

export interface DetectedAgent extends AgentInfo {
  installed: boolean;
  /** Where it was found (a path), when installed. */
  where?: string;
}

function appPath(name: string): string | undefined {
  for (const dir of ["/Applications", join(homedir(), "Applications")]) {
    const p = join(dir, `${name}.app`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

/** One login-shell pass for every command name, so the user's real PATH is used. */
async function resolveBins(names: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!names.length) return found;
  try {
    const script = names.map(n => `p=$(command -v ${JSON.stringify(n)} 2>/dev/null) && printf '%s\\t%s\\n' ${JSON.stringify(n)} "$p"`).join("; ");
    const { stdout } = await run("/bin/zsh", ["-lc", script], { timeout: 10_000 });
    for (const line of stdout.split("\n")) {
      const [name, path] = line.split("\t");
      if (name && path?.startsWith("/")) found.set(name, path);
    }
  } catch {
    // A shell that fails to start just means nothing is found on PATH.
  }
  return found;
}

export async function detectAgents(agents: readonly AgentInfo[] = AGENTS): Promise<DetectedAgent[]> {
  const bins = await resolveBins([...new Set(agents.flatMap(a => a.bins ?? []))]);
  return agents.map(a => {
    const where =
      (a.bins ?? []).map(b => bins.get(b)).find(Boolean)
      ?? (a.paths ?? []).find(p => existsSync(p))
      ?? (a.apps ?? []).map(appPath).find(Boolean);
    return { ...a, installed: Boolean(where), ...(where ? { where } : {}) };
  });
}
