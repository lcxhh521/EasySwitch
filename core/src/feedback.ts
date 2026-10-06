import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskStatus } from "./tasks.ts";

export type FeedbackRating = "good" | "bad";
export interface TaskFeedback { taskId: string; rating: FeedbackRating; at: string }

export class FeedbackStoreError extends Error {
  readonly code = "feedback_unavailable";
  constructor() { super("本机的任务评价暂时无法读取或保存，请检查应用数据目录后重试"); this.name = "FeedbackStoreError"; }
}

const taskIdValid = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id);
export function validTaskFeedback(value: unknown): value is TaskFeedback {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => ["taskId", "rating", "at"].includes(key))
    && taskIdValid(v.taskId) && (v.rating === "good" || v.rating === "bad")
    && typeof v.at === "string" && Number.isFinite(Date.parse(v.at));
}

/**
 * One current local rating per task. Corrections never inflate the sample size.
 * This separate versioned file does not rewrite tasks.jsonl or usage.jsonl, and
 * deliberately has no field for prompts, outputs, paths, credentials or notes.
 */
export class FeedbackBook {
  #file: string;
  #stamp = "";
  #ratings = new Map<string, TaskFeedback>();
  #now: () => Date;

  constructor(dir: string, options: { now?: () => Date } = {}) {
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, "task-feedback.json");
    this.#now = options.now ?? (() => new Date());
  }

  list(): TaskFeedback[] { this.load(); return [...this.#ratings.values()].map(v => ({ ...v })).sort((a, b) => a.at.localeCompare(b.at) || a.taskId.localeCompare(b.taskId)); }
  get(taskId: string): TaskFeedback | undefined { this.load(); const found = this.#ratings.get(taskId); return found ? { ...found } : undefined; }

  /** The caller resolves the actual task; an arbitrary HTTP id is not sufficient. */
  set(task: { id: string; status: TaskStatus }, rating: FeedbackRating | null): TaskFeedback | undefined {
    if (!taskIdValid(task?.id)) throw new TypeError("没有可评价的任务");
    if (!["done", "failed", "timeout", "stopped"].includes(task.status)) throw new TypeError("任务结束后才能评价");
    if (rating !== "good" && rating !== "bad" && rating !== null) throw new TypeError("请选择好或不好，也可以取消评价");
    this.load();
    const old = this.#ratings.get(task.id);
    if (old?.rating === rating || (!old && rating === null)) return old ? { ...old } : undefined;
    const next = new Map(this.#ratings);
    const feedback: TaskFeedback | undefined = rating === null ? undefined : { taskId: task.id, rating, at: this.#now().toISOString() };
    if (feedback) next.set(task.id, feedback); else next.delete(task.id);
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify({ version: 1, ratings: [...next.values()] }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.#file);
      this.#ratings = next; this.#stamp = "";
    } catch { throw new FeedbackStoreError(); }
    finally { try { rmSync(temp, { force: true }); } catch { /* No task or secret state is changed by cleanup failure. */ } }
    return feedback ? { ...feedback } : undefined;
  }

  private load(): void {
    try {
      let stat;
      try { stat = lstatSync(this.#file, { bigint: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        this.#ratings = new Map(); this.#stamp = "missing"; return;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32n * 1024n * 1024n || (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n)) throw new Error();
      const stamp = `${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeNs}/${stat.ctimeNs}`;
      if (stamp === this.#stamp) return;
      const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as { version?: unknown; ratings?: unknown };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1 || !Array.isArray(parsed.ratings) || Object.keys(parsed).some(k => k !== "version" && k !== "ratings")) throw new Error();
      const ratings = new Map<string, TaskFeedback>();
      for (const entry of parsed.ratings) {
        if (!validTaskFeedback(entry) || ratings.has(entry.taskId)) throw new Error();
        ratings.set(entry.taskId, entry);
      }
      this.#ratings = ratings; this.#stamp = stamp;
    } catch { throw new FeedbackStoreError(); }
  }
}
