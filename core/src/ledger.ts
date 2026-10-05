import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.ts";
import type { GatewayLogEntry } from "./types.ts";

/**
 * Usage ledger: one JSON line per gateway request, numbers only — never
 * prompt or answer content. Kept beside state.json so the console can show
 * usage over days without a database.
 */
export class Ledger {
  private readonly file: string;

  constructor(dir: string = dataDir()) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "usage.jsonl");
  }

  append(entry: GatewayLogEntry): void {
    try {
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Usage accounting must never break a request.
    }
  }

  /** Entries at or after `since`, newest last. Reads at most the last 50k lines. */
  read(since?: Date): GatewayLogEntry[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-50_000);
    const out: GatewayLogEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as GatewayLogEntry;
        if (!since || new Date(entry.at) >= since) out.push(entry);
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
    return out;
  }
}

export type UsageRange = "today" | "7d" | "30d" | "all";

interface Totals {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Calls whose upstream reported no usage (passthrough routes). */
  unmetered: number;
}

function emptyTotals(): Totals {
  return { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, unmetered: 0 };
}

function add(t: Totals, e: GatewayLogEntry): void {
  t.calls += 1;
  if (e.status >= 400) t.errors += 1;
  if (e.inputTokens === undefined && e.outputTokens === undefined) t.unmetered += 1;
  t.inputTokens += e.inputTokens ?? 0;
  t.outputTokens += e.outputTokens ?? 0;
  t.cachedTokens += e.cachedTokens ?? 0;
}

function dayKey(at: string): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function rangeStart(range: UsageRange, now = new Date()): Date | undefined {
  if (range === "all") return undefined;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "7d") start.setDate(start.getDate() - 6);
  if (range === "30d") start.setDate(start.getDate() - 29);
  return start;
}

export function summarize(entries: GatewayLogEntry[], range: UsageRange, now = new Date()) {
  const totals = emptyTotals();
  const byProvider = new Map<string, Totals>();
  const byHarness = new Map<string, Totals>();
  const byKey = new Map<string, Totals>();
  const byDay = new Map<string, Totals>();
  for (const e of entries) {
    add(totals, e);
    const provider = e.providerId ?? e.model.split("/")[0] ?? "unknown";
    const harness = e.harness ?? "codex";
    const groups: Array<[Map<string, Totals>, string]> = [[byProvider, provider], [byHarness, harness], [byDay, dayKey(e.at)]];
    // `<provider>#<key id>`, for the per-key view of a pool.
    if (e.keyId) groups.push([byKey, `${provider}#${e.keyId}`]);
    for (const [map, key] of groups) {
      let t = map.get(key);
      if (!t) map.set(key, (t = emptyTotals()));
      add(t, e);
    }
  }
  // A continuous run of days, so a chart has a slot for quiet days too.
  const days: Array<{ day: string } & Totals> = [];
  const start = rangeStart(range, now) ?? (entries[0] ? new Date(entries[0].at) : new Date(now));
  start.setHours(0, 0, 0, 0);
  for (const d = new Date(start); d <= now; d.setDate(d.getDate() + 1)) {
    const key = dayKey(d.toISOString());
    days.push({ day: key, ...(byDay.get(key) ?? emptyTotals()) });
  }
  return {
    range,
    totals,
    cacheHitRate: totals.inputTokens ? totals.cachedTokens / totals.inputTokens : null,
    byProvider: Object.fromEntries(byProvider),
    byHarness: Object.fromEntries(byHarness),
    byKey: Object.fromEntries(byKey),
    days,
  };
}
