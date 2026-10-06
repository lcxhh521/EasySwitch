import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayLogEntry } from "./types.ts";
import type { TaskUsage } from "./suggestions.ts";

type UsageEntry = Pick<GatewayLogEntry, "costUsd" | "costNote" | "inputTokens" | "outputTokens">;
interface AccountingTask {
  taskId: string;
  parentTaskId?: string;
  finished: boolean;
  callsStarted: number;
  callsFinished: number;
  holdsStarted: number;
  holdsFinished: number;
  records: number;
  unknownRecords: number;
  emptyCalls: number;
  costUsd: number;
  /** Interrupted tasks and failed writes remain explicitly uncertain. */
  incomplete: boolean;
}
export interface TaskAccountingCall { record(entry: UsageEntry, options?: { complete?: boolean }): void; end(): void }
export class TaskAccountingError extends Error {
  readonly code = "task_accounting_unavailable";
  constructor(unrecordedFailure = false) { super(unrecordedFailure ? "这次费用和失败状态都无法保存，请暂停使用并检查磁盘后再恢复" : "这次任务的费用无法完整记录，请检查应用数据目录；费用会标为未知"); this.name = "TaskAccountingError"; }
}
export const TASK_ACCOUNTING_CAPACITY = 5000;
export class TaskAccountingCapacityError extends Error {
  readonly code = "task_accounting_capacity";
  constructor() { super("本机任务费用簿已达到 5000 个任务的容量，新任务费用将标为未知；原有记录会保留"); this.name = "TaskAccountingCapacityError"; }
}
const validId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
const validCount = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const validAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const MAX_DEPTH = 64;
const emptyTask = (taskId: string, parentTaskId?: string): AccountingTask => ({ taskId, ...(parentTaskId ? { parentTaskId } : {}), finished: false, callsStarted: 0, callsFinished: 0, holdsStarted: 0, holdsFinished: 0, records: 0, unknownRecords: 0, emptyCalls: 0, costUsd: 0, incomplete: false });

function validTask(value: unknown): value is AccountingTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as AccountingTask;
  if (Object.keys(v).some(k => !["taskId", "parentTaskId", "finished", "callsStarted", "callsFinished", "holdsStarted", "holdsFinished", "records", "unknownRecords", "emptyCalls", "costUsd", "incomplete"].includes(k))) return false;
  return validId(v.taskId) && (v.parentTaskId === undefined || (validId(v.parentTaskId) && v.parentTaskId !== v.taskId))
    && typeof v.finished === "boolean" && typeof v.incomplete === "boolean" && validAmount(v.costUsd)
    && [v.callsStarted, v.callsFinished, v.holdsStarted, v.holdsFinished, v.records, v.unknownRecords, v.emptyCalls].every(validCount)
    && v.callsFinished <= v.callsStarted && v.holdsFinished <= v.holdsStarted && v.unknownRecords <= v.records && v.emptyCalls <= v.callsFinished
    && v.records >= v.callsFinished - v.emptyCalls;
}

/**
 * One daemon's exact task-attribution book, separate from the budget ledger.
 * Callers register task relationships and authenticated request boundaries.
 * This file has no prompts, output, raw tokens, credentials, model names or paths.
 * An empty/partial/subscription record is unknown, never evidence of free work.
 */
export class TaskAccounting {
  #file: string;
  #pendingFile: string;
  #failedFile: string;
  #tasks = new Map<string, AccountingTask>();
  #stamp = "missing";
  #pendingStamp = "missing";
  #pendingIds = new Set<string>();
  #blocked = false;
  #writeFailed = false;
  #capacityExceeded = false;
  #failureUnrecorded = false;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, "task-accounting.json");
    this.#pendingFile = join(dir, "task-accounting.pending.json");
    this.#failedFile = join(dir, "task-accounting.failed.json");
    try {
      if (this.fileStamp(this.#failedFile) !== "missing") throw new Error();
      const stamp = this.fileStamp();
      const parsed = stamp === "missing" ? { version: 1, tasks: [] } : JSON.parse(readFileSync(this.#file, "utf8")) as { version?: unknown; tasks?: unknown };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.tasks) || Object.keys(parsed).some(k => k !== "version" && k !== "tasks")) throw new Error();
      if (parsed.tasks.length > TASK_ACCOUNTING_CAPACITY) { this.#capacityExceeded = true; throw new Error(); }
      const tasks = new Map<string, AccountingTask>();
      for (const row of parsed.tasks) {
        if (!validTask(row) || tasks.has(row.taskId)) throw new Error();
        tasks.set(row.taskId, { ...row, incomplete: row.incomplete || !row.finished || row.callsStarted !== row.callsFinished || row.holdsStarted !== row.holdsFinished });
      }
      for (const row of tasks.values()) {
        const seen = new Set([row.taskId]);
        let parent = row.parentTaskId;
        while (parent) {
          if (!tasks.has(parent) || seen.has(parent) || seen.size >= MAX_DEPTH) throw new Error();
          seen.add(parent); parent = tasks.get(parent)!.parentTaskId;
        }
      }
      const pendingStamp = this.fileStamp(this.#pendingFile);
      if (pendingStamp !== "missing") {
        const pending = JSON.parse(readFileSync(this.#pendingFile, "utf8")) as { version?: unknown; taskIds?: unknown };
        if (!pending || pending.version !== 1 || !Array.isArray(pending.taskIds) || !pending.taskIds.length || pending.taskIds.some(id => !validId(id)) || new Set(pending.taskIds).size !== pending.taskIds.length || Object.keys(pending).some(k => k !== "version" && k !== "taskIds")) throw new Error();
        for (const id of pending.taskIds as string[]) {
          // A failed new registration still reserves its id as unknown; never
          // resurrect an older rating against a fresh task with that same id.
          const task = tasks.get(id) ?? emptyTask(id); task.incomplete = true; tasks.set(id, task);
          this.#pendingIds.add(id);
        }
        if (tasks.size > TASK_ACCOUNTING_CAPACITY) { this.#capacityExceeded = true; throw new Error(); }
      }
      this.#tasks = tasks; this.#stamp = stamp; this.#pendingStamp = pendingStamp; this.#writeFailed = this.#pendingIds.size > 0;
    } catch { this.#blocked = true; }
  }

  status(): { available: boolean; tasks: number; incompleteTasks: number; capacity: number; capacityReached: boolean; failureUnrecorded: boolean } {
    this.refresh();
    return { available: !this.#blocked && !this.#writeFailed, tasks: this.#tasks.size, incompleteTasks: [...this.#tasks.values()].filter(t => t.incomplete || !t.finished || t.callsStarted !== t.callsFinished || t.holdsStarted !== t.holdsFinished).length, capacity: TASK_ACCOUNTING_CAPACITY, capacityReached: this.#capacityExceeded || this.#tasks.size >= TASK_ACCOUNTING_CAPACITY, failureUnrecorded: this.#failureUnrecorded };
  }

  beginTask(taskId: string, parentTaskId?: string): void {
    this.writable();
    if (!validId(taskId) || (parentTaskId !== undefined && !validId(parentTaskId))) throw new TypeError("需要有效的任务标识");
    if (this.#tasks.has(taskId)) throw new TypeError("这个任务已有费用记录，不能重新开始覆盖");
    if (parentTaskId !== undefined && !this.#tasks.has(parentTaskId)) throw new TypeError("请先登记上级任务，再登记子任务");
    if (this.#tasks.size >= TASK_ACCOUNTING_CAPACITY) {
      // The caller may still run this task under normal gateway/budget rules.
      // A registered parent must not then look complete without this child.
      if (parentTaskId) { this.#tasks.get(parentTaskId)!.incomplete = true; this.save(parentTaskId); }
      throw new TaskAccountingCapacityError();
    }
    if (parentTaskId) {
      const parent = this.#tasks.get(parentTaskId)!;
      if (parent.finished && parent.holdsStarted === parent.holdsFinished) {
        parent.incomplete = true; this.save(parentTaskId);
        throw new TypeError("已结束的上级任务没有待完成的派活请求，不能追加子任务");
      }
    }
    let depth = 1, parent = parentTaskId;
    while (parent) { depth++; if (depth > MAX_DEPTH) throw new TypeError("任务层级太深，无法可靠归集费用"); parent = this.#tasks.get(parent)?.parentTaskId; }
    this.#tasks.set(taskId, emptyTask(taskId, parentTaskId));
    this.save(taskId);
  }

  /** Track an authenticated MCP operation while child discovery/registration is pending. */
  beginHold(taskId: string): { end(): void } {
    this.writable();
    const task = this.requireTask(taskId);
    if (task.finished) {
      task.incomplete = true; this.save(taskId);
      throw new TypeError("已结束的任务不能再开始新的派活请求");
    }
    this.increment(task, "holdsStarted"); this.save(taskId);
    let ended = false;
    return { end: () => {
      if (ended) return;
      ended = true; this.writable();
      this.increment(this.requireTask(taskId), "holdsFinished"); this.save(taskId);
    } };
  }

  beginCall(taskId: string): TaskAccountingCall {
    this.writable();
    const task = this.requireTask(taskId);
    if (task.finished) {
      task.incomplete = true; this.save(taskId);
      throw new TypeError("已结束的任务不能再开始新的模型请求");
    }
    this.increment(task, "callsStarted"); this.save(taskId);
    let ended = false, recorded = 0;
    return {
      record: (entry, options) => {
        if (ended) {
          // A late pool/native-stream log proves that an earlier end boundary
          // was incomplete. Never leave that previously published total known.
          this.writable(); this.requireTask(taskId).incomplete = true; this.save(taskId);
          throw new TypeError("模型请求结束后不能再补入费用");
        }
        this.writable();
        const current = this.requireTask(taskId);
        const priced = entry && validAmount(entry.costUsd) && entry.costNote === undefined;
        const metered = entry && validCount(entry.inputTokens) && validCount(entry.outputTokens);
        this.increment(current, "records"); recorded++;
        if (!priced || !metered || options?.complete === false) this.increment(current, "unknownRecords");
        if (priced) {
          const next = current.costUsd + entry.costUsd!;
          if (Number.isFinite(next)) current.costUsd = next;
          else { current.costUsd = Number.MAX_VALUE; current.incomplete = true; }
        }
        this.save(taskId);
      },
      end: () => {
        if (ended) return;
        ended = true;
        this.writable();
        const current = this.requireTask(taskId);
        this.increment(current, "callsFinished");
        if (!recorded) this.increment(current, "emptyCalls");
        this.save(taskId);
      },
    };
  }

  finishTask(taskId: string): void {
    this.writable();
    const task = this.requireTask(taskId);
    if (task.finished) return;
    task.finished = true; this.save(taskId);
  }

  /** Each task's result includes all registered descendants, with no time/agent heuristics. */
  usage(knownTaskIds: readonly string[] = []): TaskUsage[] {
    this.refresh();
    const ids = [...new Set([...this.#tasks.keys(), ...knownTaskIds.filter(validId)])];
    if (this.#blocked) return ids.map(taskId => ({ taskId, unknownCost: true }));
    const children = new Map<string, string[]>();
    for (const task of this.#tasks.values()) if (task.parentTaskId) {
      const list = children.get(task.parentTaskId) ?? []; list.push(task.taskId); children.set(task.parentTaskId, list);
    }
    const totals = new Map<string, TaskUsage>();
    const total = (id: string): TaskUsage => {
      const hit = totals.get(id); if (hit) return hit;
      const task = this.#tasks.get(id);
      if (!task) return { taskId: id, unknownCost: true };
      let costUsd = task.costUsd;
      let unknownCost = task.incomplete || !task.finished || !task.callsStarted || task.callsFinished !== task.callsStarted || task.holdsStarted !== task.holdsFinished || !task.records || task.unknownRecords > 0 || task.emptyCalls > 0;
      for (const child of children.get(id) ?? []) {
        const value = total(child); unknownCost ||= value.unknownCost;
        const next = costUsd + (value.costUsd ?? 0);
        if (Number.isFinite(next)) costUsd = next;
        else { costUsd = Number.MAX_VALUE; unknownCost = true; }
      }
      const result = { taskId: id, costUsd, unknownCost };
      totals.set(id, result); return result;
    };
    return ids.map(total);
  }

  private requireTask(taskId: string): AccountingTask {
    const task = this.#tasks.get(taskId);
    if (!task) throw new TypeError("这个请求没有已登记的任务，不能猜测费用归属");
    return task;
  }
  private increment(task: AccountingTask, key: "callsStarted" | "callsFinished" | "holdsStarted" | "holdsFinished" | "records" | "unknownRecords" | "emptyCalls"): void {
    if (!Number.isSafeInteger(task[key] + 1)) { task.incomplete = true; throw new TaskAccountingError(); }
    task[key]++;
  }
  private fileStamp(file = this.#file): string {
    let stat;
    try { stat = lstatSync(file, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32n * 1024n * 1024n || (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)) throw new Error();
    return `${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeNs}/${stat.ctimeNs}`;
  }
  private refresh(): void {
    if (this.#blocked) return;
    try { if (this.fileStamp() !== this.#stamp || this.fileStamp(this.#pendingFile) !== this.#pendingStamp || this.fileStamp(this.#failedFile) !== "missing") this.#blocked = true; }
    catch { this.#blocked = true; }
  }
  private writable(): void { this.refresh(); if (this.#blocked) throw new TaskAccountingError(); }
  private save(taskId: string): void {
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    const affected = new Set(this.#pendingIds);
    let id: string | undefined = taskId;
    while (id) { affected.add(id); id = this.#tasks.get(id)?.parentTaskId; }
    try {
      this.writePending(affected);
      writeFileSync(temp, `${JSON.stringify({ version: 1, tasks: [...this.#tasks.values()] })}\n`, { flag: "wx", mode: 0o600 });
      if (this.fileStamp() !== this.#stamp || this.fileStamp(this.#pendingFile) !== this.#pendingStamp) { this.#blocked = true; throw new Error(); }
      renameSync(temp, this.#file);
      this.#stamp = this.fileStamp();
      rmSync(this.#pendingFile); this.#pendingStamp = "missing";
      this.#pendingIds.clear(); this.#writeFailed = false;
    } catch {
      for (const affectedId of affected) { const task = this.#tasks.get(affectedId); if (task) task.incomplete = true; }
      this.#pendingIds = affected;
      this.#writeFailed = true;
      // A separate, small intent survives snapshot ENOSPC/short-write failures.
      // Retry only our own marker; never overwrite an observed external change.
      let durable = false;
      if (!this.#blocked) { try { this.writePending(affected); durable = true; } catch { /* Fall back to a metadata-only quarantine below. */ } }
      if (!durable && !this.#blocked) durable = this.quarantine();
      // If every filesystem mutation is denied, no implementation can persist
      // a new fact. Expose that fatal limit instead of promising restart safety.
      this.#failureUnrecorded ||= !durable;
      throw new TaskAccountingError(!durable);
    } finally { try { rmSync(temp, { force: true }); } catch { /* Never replace an accounting error with raw filesystem details. */ } }
  }

  private quarantine(): boolean {
    this.#blocked = true;
    try {
      if (this.fileStamp() !== this.#stamp || this.fileStamp(this.#failedFile) !== "missing" || this.#stamp === "missing") return false;
      // Renaming preserves the entire old book and requires no new file data.
      // Startup never trusts a quarantined complete-looking snapshot. Recovery
      // requires review of the preserved file, not automatic silent re-enabling.
      renameSync(this.#file, this.#failedFile);
      this.#stamp = "missing";
      return true;
    } catch { return false; }
  }

  private writePending(taskIds: Set<string>): void {
    const temp = `${this.#pendingFile}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, taskIds: [...taskIds] }), { flag: "wx", mode: 0o600 });
      if (this.fileStamp(this.#pendingFile) !== this.#pendingStamp) { this.#blocked = true; throw new Error(); }
      renameSync(temp, this.#pendingFile); this.#pendingStamp = this.fileStamp(this.#pendingFile);
    } finally { try { rmSync(temp, { force: true }); } catch { /* Preserve the primary accounting failure. */ } }
  }
}
