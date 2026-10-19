import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentLauncher, LaunchInput, LaunchSpec } from "./agent-launch.ts";

const run = promisify(execFile);

/**
 * Ask an explicitly selected real program for `--help` and compare its flags. No task is sent, but this still
 * executes third-party code with the inherited environment: a CLI may read configuration or logins during
 * startup. It is not a no-execution or credential-isolation check. Tests inject a runner and execute no program.
 * The comparison cannot prove that a private-directory variable is honoured or that an agent actually works.
 */

const PROBE: LaunchInput = {
  bin: "/bin/agent", port: 1, model: "prov/alpha-1", models: ["prov/alpha-1", "prov/beta-2"], token: "es-session-probe-0",
  sessionDir: "/tmp/es-verify", stateDir: "/tmp/es-verify-state", task: "TASK_TEXT", effort: "high",
};

export interface LauncherFlags {
  /** The words before the first flag that name a sub-command (`run`, `exec`, `chat`…): its help is the one to read. */
  subcommand: string[];
  flags: string[];
}

/** The sub-command and the flags a launcher puts on the command line, in either of its forms. */
export function launcherFlags(l: AgentLauncher): LauncherFlags[] {
  const forms = [l.interactive, l.headless].filter(Boolean) as Array<(i: LaunchInput) => LaunchSpec>;
  return forms.map(form => {
    const args = form(PROBE).args;
    const subcommand: string[] = [];
    for (const a of args) {
      if (/^[a-z][a-z0-9-]*$/.test(a) && a !== "TASK_TEXT") subcommand.push(a); else break;
    }
    const flags = [...new Set(args.filter(a => /^--?[A-Za-z][A-Za-z0-9-]*$/.test(a)))];
    return { subcommand, flags };
  });
}

/** Which of the flags the help text does not mention. */
export function missingFlags(help: string, flags: string[]): string[] {
  return flags.filter(f => !new RegExp(`(^|[\\s,\\[|(<=])${f.replace(/[-]/g, "\\-")}(?![A-Za-z0-9-])`, "m").test(help));
}

export interface Verdict {
  form: string;
  helpOk: boolean;
  checked: string[];
  missing: string[];
  error?: string;
}

/** Explicit dependency seam for pure fixtures; production still uses execFile with bounded help output. */
export type HelpRunner = (bin: string, args: string[], options: { timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; killSignal: "SIGKILL"; signal?: AbortSignal }) => Promise<{ stdout: string; stderr: string }>;

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Launcher help check cancelled", "AbortError");
}

/** What the program prints for `--help` (many print it on stderr or exit non-zero for it, so both are read). */
async function helpOf(bin: string, args: string[], runHelp: HelpRunner, signal?: AbortSignal): Promise<string | undefined> {
  try {
    checkCancelled(signal);
    const { stdout, stderr } = await runHelp(bin, [...args, "--help"], { timeout: 15_000, maxBuffer: 2_000_000, killSignal: "SIGKILL", env: { ...process.env, NO_COLOR: "1" }, ...(signal ? { signal } : {}) });
    checkCancelled(signal);
    return `${stdout}\n${stderr}`;
  } catch (error) {
    checkCancelled(signal);
    const e = error as { stdout?: string; stderr?: string };
    const help = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    return help.trim().length > 40 ? help : undefined;
  }
}

/**
 * Asks the program for help, once per form, and compares. A flag counts as found when the sub-command's help or the
 * program's own top-level help mentions it: some flags belong to the program and are written only there.
 */
export async function verifyLauncher(bin: string, l: AgentLauncher, runHelp: HelpRunner = run, signal?: AbortSignal): Promise<Verdict[]> {
  checkCancelled(signal);
  const names = [l.interactive ? "interactive" : undefined, l.headless ? "headless" : undefined].filter(Boolean) as string[];
  const out: Verdict[] = [];
  const forms = launcherFlags(l);
  let top: string | undefined | null = null; // null: not asked yet
  for (let k = 0; k < forms.length; k++) {
    const { subcommand, flags } = forms[k]!;
    checkCancelled(signal);
    const own = await helpOf(bin, subcommand, runHelp, signal);
    if (subcommand.length && top === null) top = await helpOf(bin, [], runHelp, signal);
    const help = [own, subcommand.length ? top : undefined].filter(Boolean).join("\n");
    if (!help) { out.push({ form: names[k]!, helpOk: false, checked: flags, missing: [], error: "没能得到帮助文字" }); continue; }
    out.push({ form: names[k]!, helpOk: true, checked: flags, missing: missingFlags(help, flags) });
  }
  return out;
}
