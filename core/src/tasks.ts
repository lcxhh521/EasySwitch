import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The task book: every task handed to an agent, by the user in the console or by
 * another agent through the MCP server. Runs are asynchronous (a task can take
 * minutes); the book keeps what is running in memory and everything finished in
 * a local file only the user can read. Outputs are capped so a chatty agent
 * cannot fill the disk.
 */

export type TaskStatus = "running" | "done" | "failed" | "stopped" | "timeout";

export interface Task {
  id: string;
  at: string;
  /** The agent that does the work. */
  agent: string;
  model: string;
  /** Who handed it over: "console", or the agent id that called run_agent. */
  from: string;
  task: string;
  cwd?: string;
  /** Reasoning level it was started with, when one was asked for. */
  effort?: string;
  /** For a task sent to "auto": which rule decided, in words. */
  why?: string;
  /** Supplied by the authenticated parent session, never by task text. */
  parentTaskId?: string;
  status: TaskStatus;
  exitCode?: number | null;
  output?: string;
  ms?: number;
}

const MAX_OUTPUT = 64 * 1024;

export class TaskCancelledError extends Error {
  readonly status = 409;
  readonly code = "task_cancelled";
  constructor() { super("任务已取消，不能再创建子任务或签发会话令牌。"); }
}

/** A request admitted while its parent was running may finish discovery after the parent exits. */
export interface TaskParentAdmission { readonly parentTaskId: string; release(): void }
export type TaskInput = Pick<Task, "agent" | "model" | "from" | "task" | "cwd" | "effort" | "why" | "parentTaskId">;

export class TaskBook {
  private readonly file: string;
  private readonly tasks = new Map<string, Task>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly cancelled = new Set<string>();
  private readonly completions = new Map<string, { promise: Promise<Task>; resolve: (task: Task) => void }>();
  private readonly admissions = new WeakMap<TaskParentAdmission, { parentTaskId: string; active: boolean }>();
  private readonly admissionCounts = new Map<string, number>();
  private readonly retains = new Map<string, number>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "tasks.jsonl");
    if (existsSync(this.file)) {
      // A task that was running when the process ended did not finish; say so rather than leave it spinning.
      for (const line of readFileSync(this.file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const t = JSON.parse(line) as Task;
          this.tasks.set(t.id, t.status === "running" ? { ...t, status: "stopped", output: t.output ?? "EasySwitch was restarted before this task finished." } : t);
          if (t.status === "running" || t.status === "stopped") this.cancelled.add(t.id);
        } catch {
          // A torn last line is skipped.
        }
      }
    }
  }

  list(limit = 50): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  running(): number {
    return [...this.tasks.values()].filter(t => t.status === "running").length;
  }

  isPending(id: string): boolean { return this.completions.has(id); }
  isCancelled(id: string): boolean { return this.cancelled.has(id) || this.tasks.get(id)?.status === "stopped"; }
  whenFinished(id: string): Promise<Task | undefined> { return this.completions.get(id)?.promise ?? Promise.resolve(this.tasks.get(id)); }

  /** Runtime cleanup can outlive the recorded result; history clearing must keep that owner reachable. */
  retain(id: string): () => void {
    if (!this.tasks.has(id)) throw new Error("任务不存在。");
    this.retains.set(id, (this.retains.get(id) ?? 0) + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const remaining = (this.retains.get(id) ?? 1) - 1;
      if (remaining) this.retains.set(id, remaining); else this.retains.delete(id);
    };
  }

  /** Contains the selected task as well as every currently registered descendant. */
  descendants(id: string): string[] {
    if (!this.tasks.has(id)) return [];
    const found = new Set([id]);
    for (let changed = true; changed;) {
      changed = false;
      for (const task of this.tasks.values()) if (task.parentTaskId && found.has(task.parentTaskId) && !found.has(task.id)) { found.add(task.id); changed = true; }
    }
    return [...found];
  }

  admitChild(parentTaskId: string): TaskParentAdmission {
    if (this.isCancelled(parentTaskId)) throw new TaskCancelledError();
    if (this.tasks.get(parentTaskId)?.status !== "running") throw new Error("上级任务已结束，不能接受新的子任务请求。");
    const state = { parentTaskId, active: true };
    this.admissionCounts.set(parentTaskId, (this.admissionCounts.get(parentTaskId) ?? 0) + 1);
    const admission = Object.freeze({ parentTaskId, release: () => {
      if (!state.active) return;
      state.active = false;
      const count = (this.admissionCounts.get(parentTaskId) ?? 1) - 1;
      if (count) this.admissionCounts.set(parentTaskId, count); else this.admissionCounts.delete(parentTaskId);
    } });
    this.admissions.set(admission, state);
    return admission;
  }

  /** Starts a record and returns it with an abort handle for the run. */
  start(input: TaskInput, options: { parentAdmission?: TaskParentAdmission } = {}): { task: Task; signal: AbortSignal } {
    if (input.parentTaskId !== undefined) {
      const parent = this.tasks.get(input.parentTaskId);
      if (this.isCancelled(input.parentTaskId)) throw new TaskCancelledError();
      const admission = options.parentAdmission && this.admissions.get(options.parentAdmission);
      if (!parent || (parent.status !== "running" && !(admission?.active && admission.parentTaskId === parent.id))) throw new Error("上级任务已结束或不存在，不能创建子任务。");
      if (parent.parentTaskId) throw new Error("任务深度不能超过两层。");
    } else if (options.parentAdmission) throw new Error("子任务请求缺少上级任务。");
    const task: Task = { id: `t-${crypto.randomUUID().replace(/-/g, "")}`, at: new Date().toISOString(), status: "running", ...input };
    if(this.tasks.has(task.id))throw new Error("本地任务记录冲突，请重试，原记录未更改");
    const abort = new AbortController();
    // Record the start too: a restart must not silently erase an unfinished task/tree.
    appendFileSync(this.file, `${JSON.stringify(task)}\n`, { mode: 0o600 });
    this.tasks.set(task.id, task);
    this.aborts.set(task.id, abort);
    let resolve!: (task: Task) => void;
    const promise = new Promise<Task>(done => { resolve = done; });
    this.completions.set(task.id, { promise, resolve });
    return { task, signal: abort.signal };
  }

  finish(id: string, result: { exitCode: number | null; output: string; timedOut: boolean }): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const completion = this.completions.get(id);
    if (!completion) return t; // An old/duplicate result must never revive a terminal task.
    const aborted = this.isCancelled(id);
    this.aborts.delete(id);
    t.status = aborted ? "stopped" : result.timedOut ? "timeout" : result.exitCode === 0 ? "done" : "failed";
    t.exitCode = result.exitCode;
    t.output = result.output.length > MAX_OUTPUT ? `${result.output.slice(0, MAX_OUTPUT)}\n…（输出太长，已截断）` : result.output;
    t.ms = Date.now() - new Date(t.at).getTime();
    this.completions.delete(id);
    try { appendFileSync(this.file, `${JSON.stringify(t)}\n`, { mode: 0o600 }); }
    finally { completion.resolve(t); }
    return t;
  }

  /** Mark the entire tree before dispatching any abort listener; cleanup is still pending until finish. */
  stop(id: string): boolean {
    const ids = this.descendants(id);
    let changed = false;
    const marked: Task[] = [];
    for (const target of ids) {
      this.cancelled.add(target);
      const task = this.tasks.get(target)!;
      if (task.status === "running") {
        task.status = "stopped"; task.exitCode = null; task.output ??= "任务已取消";
        task.ms = Math.max(0, Date.now() - Date.parse(task.at));
        marked.push(task); changed = true;
      }
      if (this.admissionCounts.has(target)) changed = true;
    }
    // Persistence failure must not prevent process termination or sibling cancellation.
    let failed = false;
    for (const task of marked) { try { appendFileSync(this.file, `${JSON.stringify(task)}\n`, { mode: 0o600 }); } catch { failed = true; } }
    for (const target of ids) this.aborts.get(target)?.abort();
    if (failed) throw new Error("任务已请求取消，但本机取消记录未能保存。");
    return changed;
  }

  /** Forget finished tasks (the file keeps the history of a restart; this rewrites it without them). */
  clearFinished(): number {
    const required = new Set([...this.completions.keys(), ...this.admissionCounts.keys(), ...this.retains.keys()]);
    for (const id of [...required]) { const parent = this.tasks.get(id)?.parentTaskId; if (parent) required.add(parent); }
    const keep = [...this.tasks.values()].filter(t => required.has(t.id));
    const dropped = this.tasks.size - keep.length;
    writeFileSync(this.file, keep.map(t => `${JSON.stringify(t)}\n`).join(""), { mode: 0o600 });
    this.tasks.clear();
    for (const t of keep) this.tasks.set(t.id, t);
    return dropped;
  }
}
