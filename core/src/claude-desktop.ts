import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gatewayTokens, type GatewayTokenAuthority } from "./gateway-auth.ts";

/**
 * A disposable Claude Desktop third-party gateway session. This never edits an
 * installed app, a managed OS policy, or the user's normal Claude directories.
 *
 * Public protocol/configuration facts (checked 2026-10-06):
 * https://claude.com/docs/third-party/claude-desktop/gateway
 * https://claude.com/docs/third-party/claude-desktop/configuration
 * https://claude.com/docs/third-party/claude-desktop/installation
 *
 * configLibrary and CLAUDE_USER_DATA_DIR are implementation details recorded in
 * research/agent-facts-4.md, NOT a public cross-version API. Unit tests prove
 * our file/process handling, not that any real Claude build honors the override.
 * No vendor source has been copied. No launcher is marked real-app verified.
 */

export type ClaudeDesktopPlatform = "darwin" | "linux";
export const CLAUDE_DESKTOP_ISOLATION_BLOCKER = "官方签名版 Claude 2.19675.1 会忽略 CLAUDE_USER_DATA_DIR；真实应用的独立目录方案尚未验证，已暂停真实启动";
export interface ClaudeDesktopModel { id: string; label?: string }
export interface ClaudeDesktopOptions {
  /** Absolute executable, not `open`, a shell command, or a macOS .app directory. */
  executable: string;
  port: number;
  /** Exact IDs exposed by the gateway; do not invent Claude capability aliases. */
  models: readonly ClaudeDesktopModel[];
  platform?: NodeJS.Platform;
  /** Existing directory used only as the parent of a fresh mkdtemp directory. */
  baseDir?: string;
  parentEnv?: NodeJS.ProcessEnv;
  discovery?: boolean;
  /** The same authority as the gateway; tests can inject an isolated registry. */
  gatewayAuth?: Pick<GatewayTokenAuthority, "issue" | "revoke">;
}

export interface ClaudeDesktopSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}
export interface ClaudeDesktopStatus {
  id: string;
  state: "prepared" | "starting" | "running" | "exited" | "failed" | "stopped" | "cleanup-blocked";
  /** Process start is not proof of a visible window or a working gateway. */
  verified: false;
  pid?: number;
  exitCode?: number | null;
  cleaned: boolean;
  error?: string;
}

function supported(platform: NodeJS.Platform): ClaudeDesktopPlatform {
  if (platform !== "darwin" && platform !== "linux") {
    throw new Error("Claude 桌面端的独立启动器目前只实现了 macOS / Linux；这个系统还没有安全的进程生命周期实现");
  }
  return platform;
}

/** Read-only executable discovery; never starts a login shell or the app. */
export function findClaudeDesktopExecutable(options: { platform?: NodeJS.Platform; home?: string; path?: string } = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const candidates = platform === "darwin"
    ? ["/Applications/Claude.app/Contents/MacOS/Claude", ...(options.home ? [join(options.home, "Applications/Claude.app/Contents/MacOS/Claude")] : [])]
    : platform === "linux"
      ? (options.path ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(":").filter(isAbsolute).map(p => join(p, "claude-desktop"))
      : [];
  return candidates.find(p => {
    try { return lstatSync(realpathSync(p)).isFile(); } catch { return false; }
  });
}

/** No inherited credentials, CLI hooks, preload flags, proxy settings, or app overrides. */
export function claudeDesktopEnvironment(root: string, platform: ClaudeDesktopPlatform, parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE", "TZ", "DISPLAY", "XAUTHORITY", "SYSTEMROOT", "WINDIR"]) {
    if (parent[key]) env[key] = parent[key];
  }
  const home = join(root, "home");
  Object.assign(env, {
    PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    APPDATA: join(root, "config"), LOCALAPPDATA: join(root, "data"),
    CLAUDE_USER_DATA_DIR: join(root, "claude-data"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    NO_PROXY: "127.0.0.1,localhost,::1",
  });
  // A Wayland socket normally lives in the ORIGINAL runtime directory. Do not
  // point back into it (or share the original DBus/keyring session) to make the
  // app appear to work. Linux desktop validation currently requires X11.
  if (platform === "linux" && parent.DISPLAY) env.XDG_SESSION_TYPE = "x11";
  return env;
}

function directory(path: string): void { mkdirSync(path, { recursive: true, mode: 0o700 }); }
function json(path: string, data: unknown): void { writeFileSync(path, JSON.stringify(data, null, 2) + "\n", { mode: 0o600, flag: "wx" }); }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Owns only the child process group it creates. Do not use pgrep/pkill, ask the
 * normal app to quit, register a URL handler, or detach through `open -a`.
 * Environment isolation is not an OS sandbox; real-app filesystem auditing is
 * still required before the integration can be marked verified.
 */
export class ClaudeDesktopSession {
  readonly id: string;
  readonly directory: string;
  readonly spec: ClaudeDesktopSpec;
  #identity: { dev: number; ino: number };
  #state: ClaudeDesktopStatus;
  #child?: ChildProcess;
  #leaderExited = false;
  #signalAuthority = false;
  #quarantine?: { directory: string; target: string; dev: number; ino: number; owned: boolean };
  #spawnFixture?: typeof spawn;
  #gatewayAuth: Pick<GatewayTokenAuthority, "issue" | "revoke">;
  #token?: string;
  #finished: Promise<void> = Promise.resolve();
  #resolveFinished?: () => void;
  #stopping?: Promise<void>;

  /** fixtureSpawn is a test dependency, never derived from an HTTP request. */
  constructor(options: ClaudeDesktopOptions, fixtureSpawn?: typeof spawn) {
    const platform = supported(options.platform ?? process.platform);
    if (!isAbsolute(options.executable) || options.executable.includes("\0") || options.executable.endsWith(".app")) throw new Error("需要 Claude 桌面端可执行文件的绝对路径");
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("无效的本地网关端口");
    if (!options.models.length || options.models.some(m => !m.id.trim() || /[\r\n\0]/.test(m.id))) throw new Error("独立窗口至少需要一个有效的网关模型 ID");
    const baseDir = realpathSync(options.baseDir ?? tmpdir());
    this.id = randomUUID();
    this.directory = mkdtempSync(join(baseDir, "easyswitch-claude-desktop-"));
    this.#identity = lstatSync(this.directory);
    this.#state = { id: this.id, state: "prepared", verified: false, cleaned: false };
    this.#spawnFixture = fixtureSpawn;
    this.#gatewayAuth = options.gatewayAuth ?? gatewayTokens;
    const env = claudeDesktopEnvironment(this.directory, platform, options.parentEnv ?? process.env);
    this.spec = {
      command: options.executable,
      args: [`--user-data-dir=${env.CLAUDE_USER_DATA_DIR}`, `--disk-cache-dir=${env.XDG_CACHE_HOME}`, `--log-file=${join(this.directory, "logs", "electron.log")}`],
      env,
      cwd: String(env.HOME),
    };
    try {
      for (const name of ["home", "config", "cache", "data", "state", "runtime", "tmp", "logs", "claude-data", "home/.claude", "home/Library/Logs", "home/Library/Caches"]) directory(join(this.directory, name));
      const bootstrapDir = platform === "darwin" ? join(String(env.HOME), "Library", "Application Support", "Claude-3p") : join(String(env.XDG_CONFIG_HOME), "Claude-3p");
      const token = this.#gatewayAuth.issue("claude-desktop").token;
      this.#token = token;
      const profile = {
        inferenceProvider: "gateway",
        inferenceCredentialKind: "static",
        inferenceGatewayBaseUrl: `http://127.0.0.1:${options.port}`,
        inferenceGatewayApiKey: token,
        inferenceGatewayAuthScheme: "bearer",
        modelDiscoveryEnabled: options.discovery ?? false,
        inferenceModels: options.models.map(m => ({ name: m.id, ...(m.label ? { labelOverride: m.label } : {}) })),
        deploymentDisplayName: "EasySwitch 独立会话",
        disableDeploymentModeChooser: true,
        disableDeepLinkRegistration: true,
        disableAutoUpdates: true,
        disableEssentialTelemetry: true,
        disableNonessentialTelemetry: true,
        disableNonessentialServices: true,
        modelCatalogEnabled: false,
      };
      // Some builds locate the 3P configuration before applying userData. Both
      // candidates remain PRIVATE, and neither reads/copies a native profile.
      for (const dir of [String(env.CLAUDE_USER_DATA_DIR), bootstrapDir]) {
        directory(join(dir, "configLibrary"));
        json(join(dir, "configLibrary", `${this.id}.json`), profile);
        json(join(dir, "configLibrary", "_meta.json"), { appliedId: this.id, entries: [{ id: this.id, name: "EasySwitch" }] });
        json(join(dir, "claude_desktop_config.json"), { deploymentMode: "3p" });
      }
    } catch (error) {
      this.#revokeToken();
      this.cleanup();
      throw error;
    }
  }

  status(): ClaudeDesktopStatus { return { ...this.#state }; }

  async start(): Promise<ClaudeDesktopStatus> {
    if (this.#state.state !== "prepared" || this.#state.cleaned) throw new Error("这个独立会话不能重复启动，请新建会话");
    if (!this.#spawnFixture) {
      this.#state.state = "failed";
      this.#state.error = CLAUDE_DESKTOP_ISOLATION_BLOCKER;
      this.cleanup();
      throw new Error(CLAUDE_DESKTOP_ISOLATION_BLOCKER);
    }
    this.#state.state = "starting";
    this.#finished = new Promise(resolve => { this.#resolveFinished = resolve; });
    try {
      const child = this.#spawnFixture(this.spec.command, this.spec.args, { env: this.spec.env, cwd: this.spec.cwd, detached: true, stdio: "ignore" });
      this.#child = child;
      this.#signalAuthority = Boolean(child.pid);
      child.once("exit", () => { this.#leaderExited = true; this.#signalAuthority = false; this.#revokeToken(); });
      child.once("close", (code, signal) => {
        this.#state.exitCode = code;
        if (this.#state.state !== "failed") this.#state.state = this.#stopping ? "stopped" : signal || code ? "failed" : "exited";
        // Do not remove files while members of the tracked process group remain.
        // A helper that creates its own session escapes this tracking; real-app
        // validation must establish that this does not happen before shipping.
        try {
          if (!this.#groupAlive()) this.cleanup();
          else { this.#state.state = "cleanup-blocked"; this.#state.error = "独立窗口的子进程仍在运行，保留私有目录；需要停止该会话"; }
        } catch {
          this.#state.state = "cleanup-blocked";
          this.#state.error = "私有目录状态异常，未自动清理";
        }
        this.#resolveFinished?.();
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => {
          this.#state.pid = child.pid;
          this.#state.state = "running";
          resolve();
        });
        child.once("error", () => {
          // Do not include arbitrary vendor errors or environment values in API logs.
          this.#state.state = "failed";
          this.#state.error = "独立窗口进程未能启动，请检查可执行文件和运行权限";
          this.#revokeToken();
          try { if (!this.#groupAlive()) this.cleanup(); }
          catch { this.#state.state = "cleanup-blocked"; this.#state.error = "进程启动失败且私有目录状态异常，未自动清理"; }
          reject(new Error(this.#state.error));
        });
      });
      return this.status();
    } catch (error) {
      this.#revokeToken();
      if (!this.#child?.pid) {
        this.#state.state = "failed";
        this.#state.error = "独立窗口进程未能启动，请检查可执行文件和运行权限";
        try { this.cleanup(); }
        catch { this.#state.state = "cleanup-blocked"; this.#state.error = "进程启动失败且私有目录状态异常，未自动清理"; }
      }
      this.#resolveFinished?.();
      throw error;
    }
  }

  /** Wait for the directly owned process; status tells whether helpers remain. */
  async wait(): Promise<ClaudeDesktopStatus> { await this.#finished; return this.status(); }

  #revokeToken(): void {
    if (!this.#token) return;
    this.#gatewayAuth.revoke(this.#token);
    this.#token = undefined;
  }

  #groupAlive(): boolean {
    if (this.#state.cleaned || !this.#child?.pid) return false;
    try { process.kill(-this.#child.pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return true;
      this.#signalAuthority = false;
      return false;
    }
  }

  #signal(signal: NodeJS.Signals): void {
    // Once the leader has exited, a later numeric PGID could belong to someone
    // else. Never re-acquire signal authority based on kill(..., 0).
    if (!this.#signalAuthority || this.#leaderExited || !this.#child?.pid || !this.#groupAlive()) return;
    try { process.kill(-this.#child.pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }

  /** Stop only our detached process group; keep files if exit cannot be proven. */
  async stop(graceMs = 3000): Promise<void> {
    if (this.#state.cleaned) return;
    if (this.#stopping) return this.#stopping;
    if (!Number.isFinite(graceMs) || graceMs < 0 || graceMs > 30_000) throw new Error("无效的退出等待时间");
    // Even if an orphan cannot safely be signalled, a stop request must end its
    // inference authority. Other sessions in this registry remain untouched.
    this.#revokeToken();
    this.#stopping = (async () => {
      this.#signal("SIGTERM");
      const until = Date.now() + graceMs;
      while (this.#groupAlive() && Date.now() < until) await pause(20);
      if (this.#groupAlive()) this.#signal("SIGKILL");
      const hardUntil = Date.now() + 1000;
      while (this.#groupAlive() && Date.now() < hardUntil) await pause(20);
      if (this.#groupAlive()) {
        this.#state.state = "cleanup-blocked";
        this.#state.error = "未能确认独立会话完全退出，私有目录暂时保留";
        throw new Error(this.#state.error);
      }
      this.#state.state = "stopped";
      this.cleanup();
    })();
    try { await this.#stopping; } finally { this.#stopping = undefined; }
  }

  /**
   * Move into a fresh private quarantine before recursive deletion, then verify
   * the moved inode. A replacement raced into the old path is preserved. This
   * is defensive filesystem handling, not an adversarial same-UID sandbox:
   * another process with our UID could also race inside the private quarantine.
   */
  cleanup(): void {
    if (this.#state.cleaned) return;
    if (this.#state.state === "starting" || this.#groupAlive()) throw new Error("独立会话仍在运行，不能清理目录");
    // Files may be preserved after a failed identity check; their old token
    // must nevertheless be unusable once this session has ended.
    this.#revokeToken();
    const owns = (path: string, identity: { dev: number; ino: number }) => {
      const stat = lstatSync(path);
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino && realpathSync(path) === resolve(path);
    };
    try {
      if (!this.#quarantine && existsSync(this.directory)) {
        if (!owns(this.directory, this.#identity)) throw new Error("私有目录已被替换，拒绝清理");
        const quarantine = mkdtempSync(join(dirname(this.directory), ".easyswitch-cleanup-"));
        const identity = lstatSync(quarantine);
        const target = join(quarantine, "session");
        this.#quarantine = { directory: quarantine, target, dev: identity.dev, ino: identity.ino, owned: false };
        // rename is atomic on the same filesystem. Inspect AFTER the rename;
        // inspect-then-rm of the original pathname would delete a replacement.
        renameSync(this.directory, target);
        if (!owns(target, this.#identity)) throw new Error("清理期间私有目录被替换，隔离目录中的文件已保留");
        this.#quarantine.owned = true;
      }
      if (this.#quarantine) {
        const q = this.#quarantine;
        if (!q.owned || !owns(q.directory, q) || !owns(q.target, this.#identity)) throw new Error("私有目录已被替换，隔离目录中的文件已保留");
        rmSync(q.target, { recursive: true, force: false });
        rmdirSync(q.directory);
        this.#quarantine = undefined;
      }
    } catch (error) {
      this.#state.state = "cleanup-blocked";
      this.#state.error = "私有目录清理未完成，文件已保留";
      throw error;
    }
    this.#state.cleaned = true;
  }
}

export function prepareClaudeDesktopSession(options: ClaudeDesktopOptions): ClaudeDesktopSession {
  return new ClaudeDesktopSession(options);
}

/** Explicit mock-program seam. Production server wiring never selects this factory. */
export function prepareClaudeDesktopFixtureSession(options: ClaudeDesktopOptions): ClaudeDesktopSession {
  return new ClaudeDesktopSession(options, spawn);
}
