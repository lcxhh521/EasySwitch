import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.ts";
import type { GatewayLogEntry } from "./types.ts";

/**
 * Usage ledger: one JSON line per gateway request, numbers only — never
 * prompt or answer content. Kept beside state.json so the console can show
 * usage over days without a database.
 */
interface PendingUsage { entry: GatewayLogEntry; line: Buffer; attempt?: { identity: string; offset: number } }
const pendingLine = (entry: GatewayLogEntry, id: string): Buffer => Buffer.from(`${JSON.stringify({ ledgerVersion: 1, ledgerId: id, ...entry })}\n`);

export class Ledger {
  private readonly file: string;
  private readonly pendingDir: string;
  private pending = new Map<string, PendingUsage>();
  private entries: Array<{ entry: GatewayLogEntry; at: number }> = [];
  private ids = new Map<string, string>();
  private windows = new Map<string, { summary: LedgerBudgetSummary; index: number; future: Array<{ entry: GatewayLogEntry; at: number }>; now: number }>();
  private offset = 0;
  private tail = Buffer.alloc(0);
  private identity = "";
  private modified = "";
  private corrupt: Error | undefined;
  private unavailable = false;
  private journalUnavailable = false;
  private lostEntry = false;
  private bytesRead = 0;
  private parsedLines = 0;

  constructor(dir: string = dataDir()) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "usage.jsonl");
    this.pendingDir = join(dir, "usage-pending");
    // The strict budget reader can distinguish a new empty ledger from a file
    // that disappears after startup. Never truncate an existing usage history.
    try { writeFileSync(this.file, "", { flag: "ax", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") this.unavailable = true; }
    try { mkdirSync(this.pendingDir, { recursive: true, mode: 0o700 }); } catch { this.journalUnavailable = true; }
  }

  append(entry: GatewayLogEntry): void {
    const id = randomUUID();
    try {
      // New rows retain the old flat layout. The version/id only make interrupted
      // retries idempotent; existing ledgers are never rewritten or truncated.
      const copy = JSON.parse(JSON.stringify(entry)) as GatewayLogEntry;
      const pending = { entry: copy, line: pendingLine(copy, id) };
      this.pending.set(id, pending);
      this.persistPending(id, pending);
      this.refresh();
    } catch {
      // Keep the queued row for retry. A serialization failure is explicitly
      // incomplete accounting, never permission to lower a stop budget.
      if (!this.pending.has(id)) this.lostEntry = true;
      this.unavailable = true;
    }
  }

  /** Entries at or after `since`, newest last. Reads at most the last 50k lines. */
  read(since?: Date): GatewayLogEntry[] {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean).slice(-50_000);
    const out: GatewayLogEntry[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as GatewayLogEntry & { ledgerVersion?: number; ledgerId?: string };
        const { ledgerVersion: _version, ledgerId: _id, ...entry } = parsed;
        if (!since || new Date(entry.at) >= since) out.push(entry);
      } catch {
        // A torn last line from a crash: skip it.
      }
    }
    return out;
  }

  /**
   * Compatibility reader. Production controllers use budgetSummary below, so
   * warm decisions neither parse historical JSON nor loop over historical rows.
   * A final unterminated row waits for completion; complete malformed rows fail.
   */
  readForBudget(since?: Date): GatewayLogEntry[] {
    this.refresh();
    if (this.corrupt) throw this.corrupt;
    if (this.unavailable || this.journalUnavailable || this.pending.size || this.lostEntry) throw new Error("Usage accounting is incomplete");
    return this.entries.filter(row => !since || row.at >= since.getTime()).map(row => ({ ...row.entry }));
  }

  /** Per-window counters advance only for newly appended rows or due future rows. */
  budgetSummary(start: Date, end: Date, now = new Date()): LedgerBudgetSummary {
    this.refresh();
    const key = `${start.getTime()}/${end.getTime()}`;
    let window = this.windows.get(key);
    if (!window || now.getTime() < window.now) {
      window = { summary: emptyBudgetSummary(), index: 0, future: [], now: now.getTime() };
      this.windows.set(key, window);
      if (this.windows.size > 16) this.windows.delete(this.windows.keys().next().value!);
    }
    const take = (row: { entry: GatewayLogEntry; at: number }) => {
      if (row.at < start.getTime() || row.at >= end.getTime()) return;
      if (row.at > now.getTime()) pushFuture(window!.future, row);
      else addBudgetEntry(window!.summary, row.entry);
    };
    while (window.future[0] && window.future[0].at <= now.getTime()) addBudgetEntry(window.summary, popFuture(window.future)!.entry);
    for (; window.index < this.entries.length; window.index++) take(this.entries[window.index]!);
    window.now = now.getTime();
    return {
      ...window.summary,
      byProvider: Object.fromEntries(Object.entries(window.summary.byProvider).map(([id, totals]) => [id, { ...totals }])),
      accountingUnavailable: window.summary.accountingUnavailable || this.unavailable || this.journalUnavailable || Boolean(this.corrupt) || this.pending.size > 0 || this.lostEntry,
      pendingPartialLine: this.tail.length > 0,
    };
  }

  /** Numeric diagnostics for regression tests and support; no content or credentials. */
  budgetDiagnostics(): { bytesRead: number; parsedLines: number; offset: number; pendingBytes: number; pendingWrites: number } {
    return { bytesRead: this.bytesRead, parsedLines: this.parsedLines, offset: this.offset, pendingBytes: this.tail.length, pendingWrites: this.pending.size };
  }

  private persistPending(id: string, item: PendingUsage): boolean {
    const path = join(this.pendingDir, `${id}.json`), temp = `${path}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, id, entry: item.entry, ...(item.attempt ? { attempt: item.attempt } : {}) }), { mode: 0o600 });
      renameSync(temp, path);
      return true;
    } catch { return false; }
    finally { try { rmSync(temp, { force: true }); } catch { /* Keep failures visible via the pending queue. */ } }
  }

  private loadPending(): void {
    this.journalUnavailable = false;
    try {
      for (const name of readdirSync(this.pendingDir).sort()) {
        if (!/^[a-f0-9-]{36}\.json(?:\.tmp)?$/.test(name)) { this.journalUnavailable = true; continue; }
        const id = name.slice(0, 36), temporary = name.endsWith(".tmp");
        if (this.pending.has(id)) {
          // A committed journal already preserves this call. A crash while
          // rewriting its attempt metadata may leave a harmless partial temp.
          if (temporary) { try { rmSync(join(this.pendingDir, name)); } catch { this.journalUnavailable = true; } }
          continue;
        }
        try {
          const raw = readFileSync(join(this.pendingDir, name), "utf8");
          if (raw.length > 1_048_576) throw new Error();
          const saved = JSON.parse(raw) as { version: unknown; id: unknown; entry: GatewayLogEntry; attempt?: { identity: string; offset: number } };
          if (saved.version !== 1 || saved.id !== id || !validBudgetEntry(saved.entry)) throw new Error();
          if (saved.attempt && (typeof saved.attempt.identity !== "string" || !/^\d+\/\d+$/.test(saved.attempt.identity) || !Number.isSafeInteger(saved.attempt.offset) || saved.attempt.offset < 0)) throw new Error();
          this.pending.set(id, { entry: saved.entry, line: pendingLine(saved.entry, id), ...(saved.attempt ? { attempt: saved.attempt } : {}) });
          if (temporary) renameSync(join(this.pendingDir, name), join(this.pendingDir, `${id}.json`));
        } catch { this.journalUnavailable = true; }
      }
    } catch { this.journalUnavailable = true; }
  }

  private refresh(): void {
    this.loadPending();
    try {
      this.sync();
      if (!this.corrupt) {
        // Recover the row that owns an interrupted tail before appending later rows.
        const queued = [...this.pending];
        if (this.tail.length) queued.sort((a, b) => Number(this.ownsTail(b[0], b[1])) - Number(this.ownsTail(a[0], a[1])));
        for (const [id, item] of queued) {
          if (!this.ids.has(id)) {
            if (this.tail.length && !this.ownsTail(id, item)) break;
            if (!this.tail.length) item.attempt = { identity: this.identity, offset: this.offset };
            if (!this.persistPending(id, item)) break;
            try { appendFileSync(this.file, item.line.subarray(this.tail.length), { flag: "a", mode: 0o600 }); }
            catch { /* A short write can leave a prefix; the next sync/retry resumes it. */ }
            this.sync();
            if (!this.ids.has(id)) break;
          }
          // A journal left after a completed main write is a retry, never a new call.
          if (this.ids.get(id) !== JSON.stringify(item.entry)) { this.corrupt = new Error("Usage accounting contains a conflicting retry"); break; }
          this.pending.delete(id);
          try { rmSync(join(this.pendingDir, `${id}.json`), { force: true }); } catch { /* A later refresh retries harmless cleanup. */ }
        }
      }
      this.unavailable = false;
    } catch { this.unavailable = true; }
  }

  private ownsTail(id: string, item: PendingUsage): boolean {
    if (!this.tail.length || !item.line.subarray(0, this.tail.length).equals(this.tail)) return false;
    // Sharing a JSON prefix (timestamp, provider, etc.) is NOT ownership. A
    // durable write-attempt position or the complete unique id must match.
    return (item.attempt?.identity === this.identity && item.attempt.offset === this.offset - this.tail.length)
      || this.tail.includes(Buffer.from(`"ledgerId":"${id}"`));
  }

  private sync(): void {
    const stat = statSync(this.file, { bigint: true });
    if (!stat.isFile()) throw new Error("Usage accounting is not a file");
    const size = Number(stat.size);
    if (!Number.isSafeInteger(size)) throw new Error("Usage accounting file is too large");
    const identity = `${stat.dev}/${stat.ino}`;
    const modified = `${stat.mtimeNs}/${stat.ctimeNs}`;
    if (identity !== this.identity || size < this.offset || (modified !== this.modified && (size === this.offset || this.corrupt))) {
      this.offset = 0; this.tail = Buffer.alloc(0); this.entries = []; this.ids.clear(); this.windows.clear(); this.corrupt = undefined;
    }
    this.identity = identity; this.modified = modified;
    if (size === this.offset) return;
    const fd = openSync(this.file, "r");
    try {
      const chunk = Buffer.alloc(64 * 1024);
      while (this.offset < size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, size - this.offset), this.offset);
        if (!count) throw new Error("Usage accounting changed during read");
        this.offset += count; this.bytesRead += count;
        const data = Buffer.concat([this.tail, chunk.subarray(0, count)]);
        let start = 0, newline: number;
        while ((newline = data.indexOf(10, start)) >= 0) {
          const line = data.subarray(start, newline).toString("utf8"); start = newline + 1;
          if (!line.trim()) continue;
          this.parsedLines++;
          try {
            if (Buffer.byteLength(line) > 1_048_576) throw new Error();
            const raw = JSON.parse(line) as GatewayLogEntry & { ledgerVersion?: number; ledgerId?: string };
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error();
            const { ledgerVersion, ledgerId, ...entry } = raw;
            if (ledgerVersion !== undefined && (ledgerVersion !== 1 || typeof ledgerId !== "string" || !/^[a-f0-9-]{36}$/.test(ledgerId))) throw new Error();
            if (ledgerVersion === undefined && ledgerId !== undefined) throw new Error();
            if (!validBudgetEntry(entry)) throw new Error();
            if (ledgerId) {
              const serialized = JSON.stringify(entry);
              const existing = this.ids.get(ledgerId);
              if (existing !== undefined) { if (existing !== serialized) throw new Error(); else continue; }
              this.ids.set(ledgerId, serialized);
            }
            this.entries.push({ entry, at: Date.parse(entry.at) });
          } catch { this.corrupt ??= new Error("Usage accounting contains an invalid entry or amount"); }
        }
        this.tail = Buffer.from(data.subarray(start));
        if (this.tail.length > 1_048_576) {
          this.corrupt = new Error("Usage accounting contains an oversized partial row");
          throw this.corrupt;
        }
      }
    } finally { closeSync(fd); }
  }
}

export interface BudgetTotals {
  estimatedCostUsd: number; calls: number; unpricedCalls: number; unmeteredCalls: number;
  subscriptionCalls: number; unknownCostCalls: number;
}
export interface LedgerBudgetSummary extends BudgetTotals {
  byProvider: Record<string, BudgetTotals>;
  unattributedCalls: number; unattributedCostUsd: number;
  accountingUnavailable: boolean; pendingPartialLine: boolean;
}
export type BudgetSummaryReader = (start: Date, end: Date, now: Date) => LedgerBudgetSummary;
type FutureRow = { entry: GatewayLogEntry; at: number };
function pushFuture(heap: FutureRow[], row: FutureRow): void {
  let at = heap.length; heap.push(row);
  while (at > 0) {
    const parent = Math.floor((at - 1) / 2);
    if (heap[parent]!.at <= row.at) break;
    heap[at] = heap[parent]!; at = parent;
  }
  heap[at] = row;
}
function popFuture(heap: FutureRow[]): FutureRow | undefined {
  const first = heap[0], last = heap.pop();
  if (!heap.length || !last) return first;
  let at = 0;
  while (at * 2 + 1 < heap.length) {
    let child = at * 2 + 1;
    if (child + 1 < heap.length && heap[child + 1]!.at < heap[child]!.at) child++;
    if (last.at <= heap[child]!.at) break;
    heap[at] = heap[child]!; at = child;
  }
  heap[at] = last;
  return first;
}
const emptyBudgetTotals = (): BudgetTotals => ({ estimatedCostUsd: 0, calls: 0, unpricedCalls: 0, unmeteredCalls: 0, subscriptionCalls: 0, unknownCostCalls: 0 });
export const emptyBudgetSummary = (): LedgerBudgetSummary => ({ ...emptyBudgetTotals(), byProvider: Object.create(null) as Record<string, BudgetTotals>, unattributedCalls: 0, unattributedCostUsd: 0, accountingUnavailable: false, pendingPartialLine: false });

export function validBudgetEntry(entry: unknown): entry is GatewayLogEntry {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry as GatewayLogEntry;
  if (typeof e.at !== "string" || !Number.isFinite(Date.parse(e.at)) || typeof e.model !== "string" || typeof e.route !== "string" || !Number.isInteger(e.status) || !Number.isFinite(e.ms)) return false;
  if (e.providerId !== undefined && (typeof e.providerId !== "string" || !e.providerId)) return false;
  for (const field of ["costUsd", "inputTokens", "outputTokens", "cachedTokens"] as const) if (e[field] !== undefined && (typeof e[field] !== "number" || !Number.isFinite(e[field]) || e[field]! < 0)) return false;
  return e.costNote === undefined || e.costNote === "unpriced" || e.costNote === "subscription";
}

function addBudgetEntry(summary: LedgerBudgetSummary, entry: GatewayLogEntry): void {
  const slash = entry.model.indexOf("/");
  const id = entry.providerId ?? (slash > 0 ? entry.model.slice(0, slash) : undefined);
  const totals: BudgetTotals[] = [summary];
  if (id) totals.push(summary.byProvider[id] ??= emptyBudgetTotals());
  else {
    summary.unattributedCalls++;
    if (entry.costNote !== "subscription" && entry.costNote !== "unpriced") summary.unattributedCostUsd += entry.costUsd ?? 0;
  }
  for (const total of totals) {
    total.calls++;
    if (entry.costNote === "subscription") { total.subscriptionCalls++; continue; }
    const priced = entry.costUsd !== undefined && entry.costNote !== "unpriced";
    const metered = entry.inputTokens !== undefined && entry.outputTokens !== undefined;
    if (priced) total.estimatedCostUsd += entry.costUsd!;
    else total.unpricedCalls++;
    if (!metered) total.unmeteredCalls++;
    if (!priced || !metered) total.unknownCostCalls++;
    if (!Number.isFinite(total.estimatedCostUsd)) { total.estimatedCostUsd = Number.MAX_VALUE; summary.accountingUnavailable = true; }
  }
  if (!Number.isFinite(summary.unattributedCostUsd)) { summary.unattributedCostUsd = Number.MAX_VALUE; summary.accountingUnavailable = true; }
}

/** Fallback for injected readers and compatibility; production uses Ledger's cached counters. */
export function summarizeBudgetEntries(entries: GatewayLogEntry[], start: Date, end: Date, now: Date): LedgerBudgetSummary {
  const summary = emptyBudgetSummary();
  if (!Array.isArray(entries)) { summary.accountingUnavailable = true; return summary; }
  for (const entry of entries) {
    if (!validBudgetEntry(entry)) { summary.accountingUnavailable = true; continue; }
    const at = Date.parse(entry.at);
    if (at >= start.getTime() && at < end.getTime() && at <= now.getTime()) addBudgetEntry(summary, entry);
  }
  return summary;
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
  /** Estimated USD at pay-as-you-go prices, over the calls that could be priced. */
  costUsd: number;
  /** Calls with usage but no known price; their cost is missing, not zero. */
  unpriced: number;
  /** Calls on a flat subscription: tokens count, per-call cost does not. */
  subscription: number;
}

function emptyTotals(): Totals {
  return { calls: 0, errors: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, unmetered: 0, costUsd: 0, unpriced: 0, subscription: 0 };
}

function add(t: Totals, e: GatewayLogEntry): void {
  t.calls += 1;
  if (e.status >= 400) t.errors += 1;
  if (e.inputTokens === undefined && e.outputTokens === undefined) t.unmetered += 1;
  t.inputTokens += e.inputTokens ?? 0;
  t.outputTokens += e.outputTokens ?? 0;
  t.cachedTokens += e.cachedTokens ?? 0;
  t.costUsd += e.costUsd ?? 0;
  if (e.costNote === "unpriced") t.unpriced += 1;
  if (e.costNote === "subscription") t.subscription += 1;
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
