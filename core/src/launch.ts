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
    "-c", `${SESSION_MARKER}={name="EasySwitch",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",env_key="EASYSWITCH_GATEWAY_TOKEN"}`,
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
/**
 * `keepLogin`: leave the user's own Claude login in place. No auth token is set, so Claude Code keeps
 * signing in as itself and the gateway can hand its requests for Claude's own models on to Anthropic;
 * the session token travels in a custom header instead. Without it (not signed in, or switched off)
 * the session runs on a placeholder token and only EasySwitch's models are available.
 */
export function claudeEnv(port: number, exposedModel: string | undefined, sessionToken: string, tiers: Record<string, string> = {}, keepLogin = false, caps = ""): Record<string, string> {
  const toId = (name: string) => {
    const at = name.indexOf("/");
    return at > 0 ? claudeModelId(name.slice(0, at), name.slice(at + 1)) : name;
  };
  const id = exposedModel ? toId(exposedModel) : undefined;
  const small = tiers.small ? toId(tiers.small) : id;
  return {
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ...(keepLogin
      // Blank, not absent: a key or model a provider switcher left in ~/.claude/settings.json must not reach Anthropic or pin a model.
      ? { ANTHROPIC_CUSTOM_HEADERS: `x-easyswitch-session: ${sessionToken}`, ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_API_KEY: "" }
      : { ANTHROPIC_AUTH_TOKEN: sessionToken }),
    ...(id
      ? { ANTHROPIC_MODEL: id, ANTHROPIC_DEFAULT_OPUS_MODEL: id, ANTHROPIC_DEFAULT_SONNET_MODEL: id }
      : keepLogin ? { ANTHROPIC_MODEL: "", ANTHROPIC_DEFAULT_OPUS_MODEL: "", ANTHROPIC_DEFAULT_SONNET_MODEL: "" } : {}),
    // Claude Code runs titles, summaries and other small requests on the haiku tier, and sub-agents on their own setting.
    ...(small ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: small } : keepLogin ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: "" } : {}),
    ...(tiers.small ? { ANTHROPIC_SMALL_FAST_MODEL: small } : {}),
    ...(tiers.subagent ? { CLAUDE_CODE_SUBAGENT_MODEL: toId(tiers.subagent) } : {}),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1",
    ...(caps ? { CLAUDE_CODE_MODEL_CAPABILITIES: caps } : {}),
    [CLAUDE_SESSION_MARKER]: "1",
  };
}

/**
 * Tells Claude Code which levels each of our models has, as "<id>=effort,xhigh_effort,max_effort;…".
 * A model Claude Code does not know gets no effort menu at all unless it is told; with this, its own
 * /effort control works for third-party models too, and shows only the levels the model has. Idea
 * from Magpie's CLAUDE_CODE_MODEL_CAPABILITIES handling; the list is built from our own per-model levels.
 */
export function claudeCapabilities(models: ReadonlyArray<{ providerId: string; model: string; efforts: string[] }>): string {
  const segs: string[] = [];
  for (const m of models) {
    const id = claudeModelId(m.providerId, m.model).toLowerCase();
    if (/[;=,*]/.test(id)) continue;
    const has = (l: string) => m.efforts.includes(l);
    if (!["low", "medium", "high", "xhigh", "max"].some(has)) continue;
    segs.push(`${id}=${["effort", ...(has("xhigh") ? ["xhigh_effort"] : []), ...(has("max") ? ["max_effort"] : [])].join(",")}`);
  }
  const text = segs.join(";");
  // Claude Code reads a bounded value; past it, the rest are simply left as Claude Code takes them.
  return text.length <= 8000 ? text : segs.slice(0, Math.floor(8000 / Math.max(1, text.length / segs.length))).join(";");
}

/**
 * `--settings` is a per-launch settings layer that outranks ~/.claude/settings.json,
 * so an `env` block a provider switcher left there cannot redirect this session,
 * and nothing is written to disk.
 */
export function claudeArgs(env: Record<string, string>): string[] {
  return [
    "--settings", JSON.stringify({ env }),
  ];
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

let loginCache: { at: number; value: boolean } | undefined;

/** Whether Claude Code has a Claude login of its own (`claude auth status`), cached for a minute. */
export async function claudeLoggedIn(): Promise<boolean> {
  if (loginCache && Date.now() - loginCache.at < 60_000) return loginCache.value;
  const bin = await findClaude();
  let value = false;
  if (bin) {
    try {
      const { stdout } = await run(bin, ["auth", "status"], { timeout: 8000 });
      const status = JSON.parse(stdout) as { loggedIn?: boolean; apiProvider?: string };
      value = status.loggedIn === true && (status.apiProvider ?? "firstParty") === "firstParty";
    } catch {
      value = false;
    }
  }
  loginCache = { at: Date.now(), value };
  return value;
}
