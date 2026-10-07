import type { ChildProcess } from "node:child_process";

export type CoreSupervisorState = "idle" | "running" | "backoff" | "stopping" | "stopped" | "failed";
export interface CoreSupervisorStatus { state: CoreSupervisorState; restarts: number; failure?: "spawn_failed" | "crash_loop" | "stop_unconfirmed" }
export interface CoreSupervisorDeps {
  spawn: () => ChildProcess;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
  changed?: (status: CoreSupervisorStatus) => void;
}

/** Owns only the returned child. Never finds/kills a process by its port, name or borrowed PID. */
export class CoreSupervisor {
  #deps: CoreSupervisorDeps;
  #child?: ChildProcess;
  #status: CoreSupervisorStatus = { state: "idle", restarts: 0 };
  #timer?: unknown;
  #forceTimer?: unknown;
  #startedAt = 0;
  #stopping = false;
  #stop?: Promise<void>;
  #resolveStop?: () => void;
  #rejectStop?: (error: Error) => void;
  constructor(deps: CoreSupervisorDeps) { this.#deps = deps; }
  status(): CoreSupervisorStatus { return { ...this.#status }; }
  #set(state: CoreSupervisorState, failure?: CoreSupervisorStatus["failure"]) {
    this.#status = { state, restarts: this.#status.restarts, ...(failure ? { failure } : {}) };
    this.#deps.changed?.(this.status());
  }
  #schedule(callback: () => void, delay: number): unknown { return (this.#deps.schedule ?? ((f, ms) => setTimeout(f, ms)))(callback, delay); }
  #cancel(timer: unknown) { if (timer !== undefined) (this.#deps.cancel ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>)))(timer); }
  #now() { return (this.#deps.now ?? Date.now)(); }
  start(): void {
    if (this.#child || ["running", "backoff", "stopping"].includes(this.#status.state)) return;
    this.#stopping = false; this.#stop = undefined; this.#status.restarts = 0;
    this.#launch();
  }
  #launch(): void {
    this.#timer = undefined;
    if (this.#stopping) return;
    this.#startedAt = this.#now();
    let child: ChildProcess;
    try { child = this.#deps.spawn(); }
    catch { this.#ended(undefined, "spawn_failed"); return; }
    this.#child = child; this.#set("running");
    child.once("error", () => {
      // Spawn errors have no live PID. A later error cannot authorize a duplicate core.
      if (!child.pid) this.#ended(child, "spawn_failed");
    });
    child.once("close", () => this.#ended(child));
  }
  #ended(child?: ChildProcess, failure?: CoreSupervisorStatus["failure"]) {
    if (child && child !== this.#child) return;
    this.#child = undefined;
    this.#cancel(this.#forceTimer); this.#forceTimer = undefined;
    if (this.#stopping) {
      this.#cancel(this.#timer); this.#timer = undefined;
      this.#set("stopped"); this.#resolveStop?.(); return;
    }
    if (this.#now() - this.#startedAt >= 30_000) this.#status.restarts = 0;
    if (this.#status.restarts >= 5) { this.#set("failed", "crash_loop"); return; }
    const delay = Math.min(5_000, 250 * 2 ** this.#status.restarts);
    this.#status.restarts++; this.#set("backoff", failure);
    this.#timer = this.#schedule(() => this.#launch(), delay);
  }
  stop(): Promise<void> {
    if (this.#stop) return this.#stop;
    this.#stopping = true; this.#cancel(this.#timer); this.#timer = undefined;
    this.#stop = new Promise<void>((resolve, reject) => { this.#resolveStop = resolve; this.#rejectStop = reject; });
    const child = this.#child;
    if (!child) { this.#set("stopped"); this.#resolveStop!(); return this.#stop; }
    this.#set("stopping");
    try { child.kill("SIGTERM"); } catch { /* escalate only this owned process below */ }
    if (child !== this.#child) return this.#stop;
    this.#timer = this.#schedule(() => {
      if (child !== this.#child) return;
      try { child.kill("SIGKILL"); } catch { /* report unconfirmed termination */ }
      if (child !== this.#child) return;
      this.#forceTimer = this.#schedule(() => {
        if (child !== this.#child) return;
        this.#set("failed", "stop_unconfirmed");
        this.#rejectStop?.(new Error("Owned core termination was not confirmed"));
      }, 1_000);
    }, 3_000);
    return this.#stop;
  }
}
