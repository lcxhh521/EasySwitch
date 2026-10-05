import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { writeCodexCatalog } from "./catalog.ts";
import type { Provider } from "./types.ts";

const run = promisify(execFile);

/**
 * Starting the ChatGPT desktop app so that its Codex points at the EasySwitch
 * gateway, for this launch only. The app reads CODEX_CLI_PATH to pick the
 * Codex program it runs as its app-server (found in the app's own code); we
 * hand it a small launcher that adds `-c openai_base_url=…` and then runs the
 * real program. Nothing in ~/.codex is written. Going back is just starting
 * the app again without the variable.
 *
 * The launcher fails open: if the gateway is not answering when the app
 * starts, it runs the real program untouched, so a stopped EasySwitch never
 * leaves ChatGPT without a working Codex.
 */

export const CHATGPT_BUNDLE_ID = "com.openai.codex";
export const CHATGPT_APP = "/Applications/ChatGPT.app";

const CODEX_CANDIDATES = [
  "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "Contents/Resources/codex-cli/bin/codex",
];

export function chatgptCodexBinary(app = CHATGPT_APP): string | undefined {
  return CODEX_CANDIDATES.map(p => join(app, p)).find(p => existsSync(p));
}

/** The marker that tells an enhanced app-server apart in `ps`. */
export function gatewayBase(port: number): string {
  return `http://127.0.0.1:${port}/backend-api/codex`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The launcher script. `extra` are further `-c` overrides decided at write time
 * (for example a catalog that replaces another tool's static one).
 */
export function launcherScript(real: string, port: number, extra: readonly string[] = []): string {
  const overrides = [`openai_base_url="${gatewayBase(port)}"`, ...extra].map(o => `-c ${shellQuote(o)}`).join(" ");
  return `#!/bin/bash
# EasySwitch: start the ChatGPT app's Codex on the local gateway, for this launch only.
REAL=${shellQuote(real)}
if [ ! -x "$REAL" ]; then
  echo "EasySwitch: the Codex program moved; start ChatGPT normally" >&2
  exit 127
fi
# Fail open: with no gateway answering, run the untouched program.
if /usr/bin/curl -sf --max-time 1 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
  exec "$REAL" ${overrides} "$@"
fi
exec "$REAL" "$@"
`;
}

export function launcherPath(dataDir: string): string {
  return join(dataDir, "chatgpt-launcher.sh");
}

/** True when ~/.codex/config.toml holds a static model catalog (another tool's), which would hide the gateway's merged list. */
export function configHasStaticCatalog(codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex")): boolean {
  try {
    return /^\s*model_catalog_json\s*=/m.test(readFileSync(join(codexHome, "config.toml"), "utf8"));
  } catch {
    return false;
  }
}

export interface ChatgptStatus {
  installed: boolean;
  running: boolean;
  /** The running app is on the EasySwitch gateway. */
  enhanced: boolean;
  /** Another tool's static catalog in config.toml will be overridden for the enhanced launch. */
  staticCatalog: boolean;
}

/** Exact argv of a process via macOS' KERN_PROCARGS2: `ps` flattens arguments that contain spaces. */
const ARGV_SCRIPT = `
import ctypes, ctypes.util, struct, sys
libc = ctypes.CDLL(ctypes.util.find_library("c"))
pid = int(sys.argv[1])
mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2, pid
size = ctypes.c_size_t(0)
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0: sys.exit(1)
buf = ctypes.create_string_buffer(size.value)
if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0: sys.exit(1)
raw = buf.raw[:size.value]
argc = struct.unpack("i", raw[:4])[0]
parts = raw[4:].split(b"\\0")
parts = [p for p in parts if p != b""]
exe, argv = parts[0], parts[1:1 + argc]
sys.stdout.write("\\0".join(a.decode("utf8", "replace") for a in argv))
`;

export async function processArgv(pid: number): Promise<string[] | undefined> {
  try {
    const { stdout } = await run("python3", ["-c", ARGV_SCRIPT, String(pid)], { timeout: 5000 });
    return stdout ? stdout.split("\0") : undefined;
  } catch {
    return undefined;
  }
}

async function pids(pattern: string): Promise<number[]> {
  try {
    const { stdout } = await run("pgrep", ["-f", pattern]);
    return stdout.split("\n").map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}

export async function chatgptMainPid(): Promise<number | undefined> {
  return (await pids("ChatGPT.app/Contents/MacOS/ChatGPT"))[0];
}

export async function chatgptStatus(port: number): Promise<ChatgptStatus> {
  const installed = existsSync(CHATGPT_APP);
  const main = installed ? await chatgptMainPid() : undefined;
  const enhanced = main ? (await pids(`openai_base_url="${gatewayBase(port)}"`)).length > 0 : false;
  return { installed, running: main !== undefined, enhanced, staticCatalog: configHasStaticCatalog() };
}

export interface Prepared {
  launcher: string;
  staticCatalog: boolean;
}

/** Writes the launcher (and, if another tool's static catalog is in the way, a merged catalog for this launch). */
export async function prepareLauncher(dataDir: string, port: number, providers: readonly Provider[]): Promise<Prepared | undefined> {
  const real = chatgptCodexBinary();
  if (!real) return undefined;
  const staticCatalog = configHasStaticCatalog();
  const extra: string[] = [];
  if (staticCatalog) {
    const catalog = await writeCodexCatalog(real, join(dataDir, "chatgpt"), providers, { includeNative: true });
    if (catalog) extra.push(`model_catalog_json=${JSON.stringify(catalog)}`);
  }
  mkdirSync(dataDir, { recursive: true });
  const path = launcherPath(dataDir);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, launcherScript(real, port, extra), { mode: 0o755 });
  chmodSync(tmp, 0o755);
  renameSync(tmp, path);
  return { launcher: path, staticCatalog };
}

async function waitGone(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await check())) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return !(await check());
}

export interface RestartResult {
  ok: boolean;
  error?: string;
}

/**
 * Quits ChatGPT politely (the user asked for it in the console), then starts it again with the same
 * arguments it had, plus CODEX_CLI_PATH when `launcher` is given. Conversations are the app's own and persist.
 */
export async function restartChatgpt(launcher: string | undefined): Promise<RestartResult> {
  const main = await chatgptMainPid();
  const argv = main ? (await processArgv(main)) ?? [] : [];
  if (main) {
    await run("osascript", ["-e", `tell application id "${CHATGPT_BUNDLE_ID}" to quit`]).catch(() => undefined);
    if (!(await waitGone(async () => (await chatgptMainPid()) !== undefined, 20_000))) {
      return { ok: false, error: "ChatGPT 没有退出（可能有未保存的内容在等你确认），请手动退出后再试" };
    }
  }
  // The original arguments (a proxy flag, for instance) are kept; argv[0] is the executable itself.
  const args = argv.slice(1);
  const open = ["-b", CHATGPT_BUNDLE_ID, ...(launcher ? ["--env", `CODEX_CLI_PATH=${launcher}`] : []), ...(args.length ? ["--args", ...args] : [])];
  try {
    await run("open", open);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `启动失败：${String((error as Error).message ?? error)}` };
  }
}
