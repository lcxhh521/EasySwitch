import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Marker every EasySwitch-launched Codex carries, so "back to native" can find them. */
export const SESSION_MARKER = "model_providers.easyswitch";

const BUNDLED_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";

export async function findCodex(): Promise<string | undefined> {
  try {
    const { stdout } = await run("/bin/zsh", ["-lc", "command -v codex"]);
    const path = stdout.trim();
    if (path && existsSync(path)) return path;
  } catch {
    // Not on PATH.
  }
  return existsSync(BUNDLED_CODEX) ? BUNDLED_CODEX : undefined;
}

/**
 * The Codex argv for one augmented session. Everything rides on `-c`
 * overrides for this process only; ~/.codex/config.toml is never written.
 */
export function codexArgs(port: number, exposedModel: string): string[] {
  return [
    "-c", 'model_provider="easyswitch"',
    "-c", `${SESSION_MARKER}={name="EasySwitch",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`,
    "-m", exposedModel,
  ];
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function codexCommandLine(codexPath: string, port: number, exposedModel: string): string {
  return [codexPath, ...codexArgs(port, exposedModel)].map(shellQuote).join(" ");
}

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Opens a Terminal window running the augmented session. Closing it is the whole "undo". */
export async function launchInTerminal(commandLine: string, banner: string): Promise<void> {
  const script = `printf '%s\\n\\n' ${shellQuote(banner)}; ${commandLine}`;
  await run("osascript", [
    "-e", `tell application "Terminal" to do script ${appleScriptString(script)}`,
    "-e", 'tell application "Terminal" to activate',
  ]);
}

/** Every running augmented Codex session, found by its command-line marker. */
export async function augmentedSessions(): Promise<number[]> {
  try {
    const { stdout } = await run("pgrep", ["-f", SESSION_MARKER]);
    return stdout.split("\n").map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}
