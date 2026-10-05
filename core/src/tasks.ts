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
  status: TaskStatus;
  exitCode?: number | null;
  output?: string;
  ms?: number;
}

const MAX_OUTPUT = 64 * 1024;

export class TaskBook {
  private readonly file: string;
  private readonly tasks = new Map<string, Task>();
  private readonly aborts = new Map<string, AbortController>();

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

  /** Starts a record and returns it with an abort handle for the run. */
  start(input: { agent: string; model: string; from: string; task: string; cwd?: string; effort?: string }): { task: Task; signal: AbortSignal } {
    const task: Task = { id: `t-${crypto.randomUUID().slice(0, 8)}`, at: new Date().toISOString(), status: "running", ...input };
    const abort = new AbortController();
    this.tasks.set(task.id, task);
    this.aborts.set(task.id, abort);
    return { task, signal: abort.signal };
  }

  finish(id: string, result: { exitCode: number | null; output: string; timedOut: boolean }): Task | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const aborted = this.aborts.get(id)?.signal.aborted ?? false;
    this.aborts.delete(id);
    t.status = aborted ? "stopped" : result.timedOut ? "timeout" : result.exitCode === 0 ? "done" : "failed";
    t.exitCode = result.exitCode;
    t.output = result.output.length > MAX_OUTPUT ? `${result.output.slice(0, MAX_OUTPUT)}\n…（输出太长，已截断）` : result.output;
    t.ms = Date.now() - new Date(t.at).getTime();
    appendFileSync(this.file, `${JSON.stringify(t)}\n`, { mode: 0o600 });
    return t;
  }

  /** Asks a running task to stop; the run's own completion then records it as stopped. */
  stop(id: string): boolean {
    const abort = this.aborts.get(id);
    if (!abort || abort.signal.aborted) return false;
    abort.abort();
    return true;
  }

  /** Forget finished tasks (the file keeps the history of a restart; this rewrites it without them). */
  clearFinished(): number {
    const keep = [...this.tasks.values()].filter(t => t.status === "running");
    const dropped = this.tasks.size - keep.length;
    this.tasks.clear();
    for (const t of keep) this.tasks.set(t.id, t);
    writeFileSync(this.file, "", { mode: 0o600 });
    return dropped;
  }
}
