import { constants, type Stats } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";

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
  A("claude-desktop", "Claude 桌面端", "Anthropic", "desktop", "planned", ["anthropic"], "claude-color", "官方第三方网关模式；隔离后端和界面已做模拟测试，但签名版 2.19675.1 忽略目录覆盖变量，真实启动已暂停；不拦截、不改平时的 Claude", { bins: ["claude-desktop"], apps: ["Claude"] }),

  // Planned: open protocol, per-launch override exists
  A("qwen-code", "Qwen Code", "阿里", "cli", "planned", ["chat"], "qwen-color", "OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL", { bins: ["qwen"] }),
  A("gemini-cli", "Gemini CLI", "Google", "cli", "planned", ["gemini"], "gemini-color", "GOOGLE_GEMINI_BASE_URL / GEMINI_API_KEY（网关已提供 Gemini 协议入口）", { bins: ["gemini"] }),
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
  A("codebuddy", "CodeBuddy Code", "腾讯", "cli", "planned", ["anthropic"], "letter:C", "官方环境变量支持 Anthropic 兼容来源；使用私有配置目录与每次启动参数，已做配置测试，真实 CLI 未实测", { bins: ["codebuddy"] }),
  A("workbuddy", "WorkBuddy", "腾讯", "desktop", "planned", ["chat"], "letter:W", "桌面应用，读 WORKBUDDY_CONFIG_DIR 下的 models.json 里的自定义模型；具体用哪个模型要在它的窗口里选；使用条款待核实", { apps: ["WorkBuddy"] }),
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

export type AgentDetectionState = "found" | "not_found" | "error";

export interface DetectedAgent extends AgentInfo {
  /** Metadata-only result, not a claim about version, login or launch compatibility. */
  detection: AgentDetectionState;
  /** Backward-compatible flag: an inconclusive check is never installed. */
  installed: boolean;
  /** Where it was found (a path), only when detection is found. */
  where?: string;
  /** Fixed safe explanation; never contains filesystem errors or local output. */
  detectionError?: string;
}

export const AGENT_DETECTION_ERROR = "安装位置检测未完成，请检查 EasySwitch 的运行环境或读取权限后重试。";

/** In-process fixture inputs only. Never accepted from HTTP or stored settings. */
export interface AgentDetectionRuntime {
  platform: NodeJS.Platform;
  home: string;
  path: string;
  pathExt: string;
  stat: (path: string) => Promise<Pick<Stats, "isFile" | "isDirectory">>;
  access: (path: string, mode: number) => Promise<void>;
  /** One bounded budget for the whole scan, including stalled filesystem probes. */
  timeoutMs: number;
}

type ProbeResult = { state: "found"; where: string } | { state: "not_found" | "error" };
const NOT_FOUND: ProbeResult = { state: "not_found" };
const PROBE_ERROR: ProbeResult = { state: "error" };

/**
 * Read only filesystem metadata. In particular do not start a login shell:
 * sourcing its startup files is code execution, even for command -v.
 * PATH means the EasySwitch service's PATH, not a separate terminal's PATH.
 */
export async function detectAgents(agents: readonly AgentInfo[] = AGENTS, fixtures: Partial<AgentDetectionRuntime> = {}): Promise<DetectedAgent[]> {
  const runtime: AgentDetectionRuntime = {
    platform: process.platform, home: homedir(), path: process.env.PATH ?? "",
    pathExt: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD", stat, access, timeoutMs: 10_000,
    ...fixtures,
  };
  const paths = runtime.platform === "win32" ? win32 : posix;
  const deadline = Date.now() + Math.max(1, runtime.timeoutMs);
  const probes = new Map<string, Promise<ProbeResult>>();
  function probe(path: string, kind: "bin" | "app" | "path"): Promise<ProbeResult> {
    const key = `${kind}\0${path}`;
    const existing = probes.get(key); if (existing) return existing;
    const pending = (async (): Promise<ProbeResult> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return PROBE_ERROR;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const inspection = (async (): Promise<ProbeResult> => {
        try {
          const info = await runtime.stat(path);
          if (kind === "app" ? !info.isDirectory() : kind === "bin" ? !info.isFile() : !info.isFile() && !info.isDirectory()) return NOT_FOUND;
          // A directory named after a command, or a non-executable file, must
          // never be handed to existing launch callers as a runnable binary.
          if (kind === "bin" || (kind === "path" && info.isFile())) {
            await runtime.access(path, runtime.platform === "win32" ? constants.F_OK : constants.X_OK);
          }
          return { state: "found", where: path };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException | null)?.code;
          return code === "ENOENT" || code === "ENOTDIR" ? NOT_FOUND : PROBE_ERROR;
        }
      })();
      try {
        return await Promise.race([inspection, new Promise<ProbeResult>(resolve => { timer = setTimeout(() => resolve(PROBE_ERROR), remaining); })]);
      } finally { if (timer) clearTimeout(timer); }
    })();
    probes.set(key, pending);
    return pending;
  }

  const pathEntries = runtime.path.split(runtime.platform === "win32" ? ";" : ":");
  const dirs = [...new Set(pathEntries.filter(Boolean))];
  // Relative PATH entries depend on a mutable working directory and cannot be
  // returned safely to a later launch. Treat that portion as inconclusive.
  const relativePath = pathEntries.some(dir => !dir || !paths.isAbsolute(dir));
  const binResults = new Map<string, Promise<ProbeResult>>();
  function bin(name: string): Promise<ProbeResult> {
    const existing = binResults.get(name); if (existing) return existing;
    const pending = (async (): Promise<ProbeResult> => {
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) return PROBE_ERROR;
      let failed = relativePath;
      const suffixes = runtime.platform === "win32"
        ? ["", ...runtime.pathExt.split(";").filter(ext => /^\.[a-zA-Z0-9]+$/.test(ext))]
        : [""];
      for (const dir of dirs.filter(dir => paths.isAbsolute(dir))) {
        for (const suffix of suffixes) {
          const result = await probe(paths.join(dir, `${name}${suffix}`), "bin");
          if (result.state === "found") return result;
          failed ||= result.state === "error";
        }
      }
      return failed ? PROBE_ERROR : NOT_FOUND;
    })();
    binResults.set(name, pending);
    return pending;
  }

  return Promise.all(agents.map(async agent => {
    let failed = false;
    let found: string | undefined;
    for (const name of agent.bins ?? []) {
      const result = await bin(name);
      if (result.state === "found") { found = result.where; break; }
      failed ||= result.state === "error";
    }
    if (!found) for (const path of agent.paths ?? []) {
      // Catalogued macOS app-internal paths do not prove installation elsewhere.
      if (runtime.platform !== "darwin" && /(^|\/)Applications\//.test(path)) continue;
      const result = paths.isAbsolute(path) ? await probe(path, "path") : PROBE_ERROR;
      if (result.state === "found") { found = result.where; break; }
      failed ||= result.state === "error";
    }
    if (!found && runtime.platform === "darwin") outer: for (const app of agent.apps ?? []) {
      for (const dir of ["/Applications", paths.join(runtime.home, "Applications")]) {
        const result = await probe(paths.join(dir, `${app}.app`), "app");
        if (result.state === "found") { found = result.where; break outer; }
        failed ||= result.state === "error";
      }
    }
    const detection: AgentDetectionState = found ? "found" : failed ? "error" : "not_found";
    return { ...agent, detection, installed: detection === "found", ...(found ? { where: found } : {}), ...(detection === "error" ? { detectionError: AGENT_DETECTION_ERROR } : {}) };
  }));
}
