import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The thinking levels an agent really has, read from the installed program itself, because they
 * differ between agents (Hermes has "none" and "ultra", Claude Code stops at "max") and, for Codex,
 * between models. What was written into the launcher is only the fallback for when the program
 * cannot be asked.
 */

/** Weakest to strongest, for ordering what the programs report; anything unknown goes last in the order given. */
const ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

export function sortLevels(levels: Iterable<string>): string[] {
  const seen = [...new Set(levels)];
  return seen.sort((a, b) => {
    const ia = ORDER.indexOf(a);
    const ib = ORDER.indexOf(b);
    return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
  });
}

/**
 * Finds the list of levels a `--help` text gives for one flag: the first run of three or more
 * comma-separated words ("low, medium, high" or "none, minimal, …, or ultra") after the flag.
 */
export function parseHelpLevels(help: string, flag: string): string[] | undefined {
  // The flag's own entry starts a line; the usage summary at the top also mentions it, in brackets.
  const entry = new RegExp(`^\\s+${flag.replace(/[-]/g, "\\-")}\\b`, "m").exec(help);
  const at = entry ? entry.index : help.indexOf(flag);
  if (at < 0) return undefined;
  const text = help.slice(at, at + 600).replace(/\s+/g, " ");
  const list = /\b([a-z][a-z0-9-]*(?:, (?:or )?[a-z][a-z0-9-]*){2,})(?: or ([a-z][a-z0-9-]*))?/.exec(text.slice(flag.length));
  if (!list) return undefined;
  const words = [...list[1]!.split(/, (?:or )?/), ...(list[2] ? [list[2]] : [])];
  // A prose list ("for the current session, this run") is not levels: most words must be known ones.
  return words.filter(w => ORDER.includes(w)).length >= 2 ? words : undefined;
}

export interface Discovered {
  levels: string[];
  /** Codex: the levels of each model in its own catalog. */
  perModel?: Record<string, string[]>;
}

const cache = new Map<string, { at: number; value: Discovered | null }>();
const TTL_MS = 6 * 3600_000;

async function ask(bin: string, args: string[]): Promise<string> {
  const { stdout, stderr } = await run(bin, args, { timeout: 15_000, maxBuffer: 32 * 1024 * 1024 }).catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
  return `${stdout}\n${stderr}`;
}

async function discover(agentId: string, bin: string): Promise<Discovered | null> {
  if (agentId === "claude") {
    const levels = parseHelpLevels(await ask(bin, ["--help"]), "--effort");
    return levels ? { levels } : null;
  }
  if (agentId === "hermes") {
    const levels = parseHelpLevels(await ask(bin, ["chat", "--help"]), "--reasoning");
    return levels ? { levels } : null;
  }
  if (agentId === "codex") {
    try {
      const out = await ask(bin, ["debug", "models"]);
      const json = JSON.parse(out.slice(out.indexOf("{"))) as { models?: Array<{ slug?: string; supported_reasoning_levels?: Array<{ effort?: string }> }> };
      const perModel: Record<string, string[]> = {};
      for (const m of json.models ?? []) {
        if (m.slug) perModel[m.slug] = (m.supported_reasoning_levels ?? []).map(l => String(l.effort)).filter(Boolean);
      }
      const levels = sortLevels(Object.values(perModel).flat());
      return levels.length ? { levels, perModel } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Asks the program (once per six hours) and remembers the answer. */
export async function discoverEfforts(agentId: string, bin: string | undefined): Promise<Discovered | undefined> {
  if (!bin) return undefined;
  const key = `${agentId}|${bin}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value ?? undefined;
  const value = await discover(agentId, bin);
  cache.set(key, { at: Date.now(), value });
  byAgent.set(agentId, value);
  return value ?? undefined;
}

const byAgent = new Map<string, Discovered | null>();

/** What was last discovered for an agent, without asking again. */
export function knownEfforts(agentId: string): Discovered | undefined {
  return byAgent.get(agentId) ?? undefined;
}
