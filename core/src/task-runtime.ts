import { TaskBook, TaskCancelledError, type Task } from "./tasks.ts";
export { TaskCancelledError } from "./tasks.ts";

export interface TaskRuntimeUsage { taskId: string; costUsd?: number; unknownCost: boolean }
export interface TaskCleanupSummary { pending: number; failed: number }
export interface TaskRuntimeView extends Task {
  elapsedMs: number;
  usage: TaskRuntimeUsage;
  cleanup: TaskCleanupSummary;
  cleanupPending: boolean;
  cleanupFailed: number;
}
export interface TaskRuntimeNode extends TaskRuntimeView { children: TaskRuntimeNode[] }
export interface TaskCancelResult { found: boolean; taskIds: string[]; cleanup: TaskCleanupSummary }
interface OwnedToken { owner: string; revoke: () => boolean | void; release: () => void }
interface RuntimeEntry { run?: Promise<void>; runPending: boolean; failed: number; failureRetained?: boolean }

/** Runtime ownership only. TaskBook and TaskAccounting remain the sole history/usage stores.
 * The registered run must settle after its owned child process has closed and cleaned up.
 * No process lookup, PID-based kill, shell, token issuance or new accounting occurs here.
 */
export class TaskRuntime {
  #book: TaskBook;
  #usage: () => readonly TaskRuntimeUsage[];
  #now: () => number;
  #entries = new Map<string, RuntimeEntry>();
  #tokens = new Map<string, OwnedToken>();
  #cancels = new Map<string, Promise<TaskCancelResult>>();

  constructor(options: { book: TaskBook; usage?: () => readonly TaskRuntimeUsage[]; now?: () => number }) {
    this.#book = options.book;
    this.#usage = options.usage ?? (() => []);
    this.#now = options.now ?? Date.now;
  }

  #entry(taskId: string): RuntimeEntry {
    if (!this.#book.get(taskId)) throw new Error("任务不存在。");
    let entry = this.#entries.get(taskId);
    if (!entry) { entry = { runPending: false, failed: 0 }; this.#entries.set(taskId, entry); }
    return entry;
  }

  /** Server catches runner failures to persist a Task; retain a failed cleanup result separately. */
  noteCleanupFailure(taskId: string): void {
    const entry = this.#entry(taskId);
    entry.failed++;
    if (!entry.failureRetained) {
      // Unconfirmed process/token cleanup cannot become success by clearing history.
      // This hold intentionally lasts for the lifetime of this daemon/book.
      this.#book.retain(taskId); entry.failureRetained = true;
    }
  }

  /** Must be called synchronously after starting the runner, before exposing it to callers. */
  trackRun(taskId: string, done: Promise<unknown>): void {
    const entry = this.#entry(taskId);
    if (entry.run) throw new Error("这个任务已经登记了执行过程。");
    const release = this.#book.retain(taskId);
    entry.runPending = true;
    entry.run = Promise.resolve(done).then(() => {}, () => { this.noteCleanupFailure(taskId); }).finally(() => { entry.runPending = false; release(); });
  }

  /** Call immediately after issue. A late issuance is revoked before cancellation is reported. */
  ownToken(taskId: string, token: string, revoke: () => boolean | void): void {
    this.#entry(taskId);
    const existing = this.#tokens.get(token);
    if (!token || (existing && existing.owner !== taskId)) throw new Error("会话令牌的任务归属冲突。");
    if (!existing) this.#tokens.set(token, { owner: taskId, revoke, release: this.#book.retain(taskId) });
    if (this.#book.isCancelled(taskId) || this.#book.get(taskId)?.status !== "running") {
      this.revokeToken(taskId, token);
      throw new TaskCancelledError();
    }
  }

  /** Never forwards an unowned token to the authority. Each registered revoker runs once. */
  revokeToken(taskId: string, token: string): boolean {
    const owned = this.#tokens.get(token);
    if (!owned || owned.owner !== taskId) return false;
    this.#tokens.delete(token);
    try { owned.revoke(); }
    catch { this.noteCleanupFailure(taskId); }
    finally { owned.release(); }
    return true;
  }

  /** Suitable for runner finally: revokes remaining owned tokens and does not wait on the runner itself. */
  async release(taskId: string): Promise<TaskCleanupSummary> {
    if (!this.#book.get(taskId)) return { pending: 0, failed: 0 };
    for (const [token, owned] of this.#tokens) if (owned.owner === taskId) this.revokeToken(taskId, token);
    return this.#cleanup(taskId);
  }

  #cleanup(taskId: string): TaskCleanupSummary {
    const entry = this.#entries.get(taskId);
    return { pending: this.#book.isPending(taskId) || entry?.runPending ? 1 : 0, failed: entry?.failed ?? 0 };
  }

  /** Idempotent, cascades before awaiting anything, and waits for actual owned run/cleanup completion. */
  cancelTree(taskId: string): Promise<TaskCancelResult> {
    const old = this.#cancels.get(taskId);
    if (old) return old;
    const taskIds = this.#book.descendants(taskId);
    if (!taskIds.length) return Promise.resolve({ found: false, taskIds: [], cleanup: { pending: 0, failed: 0 } });
    // Install the promise first: synchronous abort listeners may request cancellation again.
    let resolve!: (result: TaskCancelResult) => void;
    const done = new Promise<TaskCancelResult>(finish => { resolve = finish; });
    this.#cancels.set(taskId, done);
    try { this.#book.stop(taskId); }
    catch { this.noteCleanupFailure(taskId); }
    void (async () => {
      await Promise.all(taskIds.map(id => this.release(id)));
      await Promise.all(taskIds.map(async id => {
        await this.#book.whenFinished(id);
        await this.#entries.get(id)?.run;
        await this.release(id);
      }));
      const cleanup = taskIds.reduce((sum, id) => { const value = this.#cleanup(id); return { pending: sum.pending + value.pending, failed: sum.failed + value.failed }; }, { pending: 0, failed: 0 });
      resolve({ found: true, taskIds, cleanup });
    })().catch(() => { this.noteCleanupFailure(taskId); resolve({ found: true, taskIds, cleanup: { pending: taskIds.filter(id => this.#cleanup(id).pending).length, failed: taskIds.reduce((sum, id) => sum + this.#cleanup(id).failed, 0) } }); });
    return done;
  }

  snapshot(limit = 50): { tasks: TaskRuntimeView[]; tree: TaskRuntimeNode[]; running: number } {
    const all = this.#book.list(Number.MAX_SAFE_INTEGER);
    const byId = new Map(all.map(task => [task.id, task]));
    const wanted = new Set(all.slice(0, Number.isSafeInteger(limit) && limit >= 0 ? limit : 50).map(task => task.id));
    // Keep every active/cancelling task and the ancestors of visible children in the tree.
    for (const task of all) { const cleanup = this.#cleanup(task.id); if (task.status === "running" || cleanup.pending || cleanup.failed) wanted.add(task.id); }
    for (const id of [...wanted]) {
      let parent = byId.get(id)?.parentTaskId;
      const seen = new Set([id]);
      while (parent && !seen.has(parent) && byId.has(parent)) { seen.add(parent); wanted.add(parent); parent = byId.get(parent)?.parentTaskId; }
    }
    let rows: readonly TaskRuntimeUsage[] = [];
    try { rows = this.#usage(); } catch { /* Storage/coverage failure means unknown, never zero. */ }
    const usage = new Map(rows.map(row => [row.taskId, row]));
    const tasks = all.filter(task => wanted.has(task.id)).map(task => {
      const row = usage.get(task.id), cleanup = this.#cleanup(task.id);
      const cost = row?.costUsd;
      const validCost = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
      const elapsed = task.status === "running" || cleanup.pending ? this.#now() - Date.parse(task.at) : task.ms ?? 0;
      return { ...task, elapsedMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
        usage: { taskId: task.id, ...(validCost ? { costUsd: cost } : {}), unknownCost: !validCost || row?.unknownCost !== false || task.status === "running" || cleanup.pending > 0 || cleanup.failed > 0 },
        cleanup, cleanupPending: task.status !== "running" && cleanup.pending > 0, cleanupFailed: cleanup.failed };
    });
    const nodes = new Map(tasks.map(task => [task.id, { ...task, children: [] } as TaskRuntimeNode]));
    const tree: TaskRuntimeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentTaskId && nodes.get(node.parentTaskId);
      // Records written by older versions may be malformed; never construct a cyclic JSON tree.
      const seen = new Set([node.id]); let ancestor: TaskRuntimeNode | undefined = parent || undefined; let cyclic = false;
      while (ancestor) { if (seen.has(ancestor.id)) { cyclic = true; break; } seen.add(ancestor.id); ancestor = ancestor.parentTaskId ? nodes.get(ancestor.parentTaskId) : undefined; }
      if (parent && !cyclic) parent.children.push(node); else tree.push(node);
    }
    return { tasks, tree, running: this.#book.running() };
  }
}
