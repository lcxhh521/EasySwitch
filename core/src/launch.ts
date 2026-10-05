import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { claudeModelId, fromClaudeModelId } from "./catalog.ts";
import type { SessionInfo } from "./types.ts";

const run = promisify(execFile);

/** Marker every EasySwitch-launched Codex carries, so "back to native" can find them. */
export const SESSION_MARKER = "model_providers.easyswitch";

/** The same for Claude Code sessions: it rides in the --settings JSON on argv. */
export const CLAUDE_SESSION_MARKER = "EASYSWITCH_SESSION";

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
export function codexArgs(port: number, exposedModel: string, catalogPath?: string): string[] {
  return [
    "-c", 'model_provider="easyswitch"',
    "-c", `${SESSION_MARKER}={name="EasySwitch",base_url="http://127.0.0.1:${port}/v1",wire_api="responses"}`,
    // Codex's own /model menu then lists every EasySwitch model (a JSON string is a valid TOML string).
    ...(catalogPath ? ["-c", `model_catalog_json=${JSON.stringify(catalogPath)}`] : []),
    "-m", exposedModel,
  ];
}

/**
 * The real Claude Code binary. Not a shell alias or wrapper: a wrapper such as
 * CC Switch's unsets ANTHROPIC_* variables, which is exactly what we pass.
 */
export async function findClaude(): Promise<string | undefined> {
  const native = join(homedir(), ".local", "bin", "claude");
  if (existsSync(native)) return native;
  try {
    const { stdout } = await run("/bin/zsh", ["-lc", "command -v claude"]);
    const path = stdout.trim();
    if (path.startsWith("/") && existsSync(path)) return path;
  } catch {
    // Not on PATH.
  }
  return undefined;
}

/**
 * Environment for one augmented Claude Code session. Every model tier maps to
 * the bound model, and gateway model discovery makes Claude Code's own /model
 * menu list every EasySwitch model, so switching mid-session works.
 */
export function claudeEnv(port: number, exposedModel: string, sessionToken: string): Record<string, string> {
  const slash = exposedModel.indexOf("/");
  const id = slash > 0 ? claudeModelId(exposedModel.slice(0, slash), exposedModel.slice(slash + 1)) : exposedModel;
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: sessionToken,
    ANTHROPIC_MODEL: id,
    ANTHROPIC_DEFAULT_OPUS_MODEL: id,
    ANTHROPIC_DEFAULT_SONNET_MODEL: id,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: id,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    [CLAUDE_SESSION_MARKER]: "1",
  };
}

/**
 * `--settings` is a per-launch settings layer that outranks ~/.claude/settings.json,
 * so an `env` block a provider switcher left there cannot redirect this session,
 * and nothing is written to disk.
 */
export function claudeArgs(env: Record<string, string>): string[] {
  return ["--settings", JSON.stringify({ env })];
}

export function claudeCommandLine(claudePath: string, env: Record<string, string>): string {
  const assignments = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`);
  return ["env", ...assignments, shellQuote(claudePath), ...claudeArgs(env).map(shellQuote)].join(" ");
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function codexCommandLine(codexPath: string, port: number, exposedModel: string, catalogPath?: string): string {
  return [codexPath, ...codexArgs(port, exposedModel, catalogPath)].map(shellQuote).join(" ");
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

/** Running augmented sessions with what they run: harness, model and start time, from `ps`. */
export async function sessionDetails(): Promise<SessionInfo[]> {
  const pids = new Set(await augmentedSessions());
  if (!pids.size) return [];
  try {
    const { stdout } = await run("ps", ["-o", "pid=,lstart=,command=", "-p", [...pids].join(",")]);
    const out: SessionInfo[] = [];
    for (const line of stdout.split("\n")) {
      // `lstart` is five fields: "Mon Oct  5 16:40:15 2026".
      const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
      if (!match) continue;
      const [, pid, started, command] = match as unknown as [string, string, string, string];
      const harness = command.includes(SESSION_MARKER) ? "codex" : "claude";
      const model = harness === "codex"
        ? /\s-m\s+(\S+)/.exec(command)?.[1]
        : (id => id && (fromClaudeModelId(id) ?? id))(/"ANTHROPIC_MODEL":"([^"]+)"/.exec(command)?.[1]);
      const startedAt = new Date(started);
      out.push({
        pid: Number(pid), harness,
        ...(model ? { model } : {}),
        ...(Number.isNaN(startedAt.getTime()) ? {} : { startedAt: startedAt.toISOString() }),
      });
    }
    return out;
  } catch {
    return [...pids].map(pid => ({ pid, harness: "codex" as const }));
  }
}

/** Every running augmented session (Codex or Claude Code), found by its command-line marker. */
export async function augmentedSessions(): Promise<number[]> {
  try {
    const { stdout } = await run("pgrep", ["-f", `${SESSION_MARKER}|${CLAUDE_SESSION_MARKER}`]);
    return stdout.split("\n").map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch {
    return [];
  }
}
