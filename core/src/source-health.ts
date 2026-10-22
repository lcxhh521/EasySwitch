import { createHash, randomUUID } from "node:crypto";
import type { Provider } from "./types.ts";
import { endpointUrl } from "./upstream.ts";

export type SourceHealthStatus = "healthy" | "unavailable" | "unknown";
export type SourceHealthReason = "verified_models" | "unverified" | "unsupported" | "checking" | "consecutive_failures" | "rate_limited" | "inconclusive" | "stale";
export type SourceHealthEligibility = { eligible: true; basis: "verified_read_only" | "user_enabled" } | { eligible: false; blockedReason: "permission_required" | "unsupported" | "disabled" };
export interface SourceHealthSnapshot {
  providerId: string;
  status: SourceHealthStatus;
  reason: SourceHealthReason;
  verified: boolean;
  eligible: boolean;
  basis?: "verified_read_only" | "user_enabled";
  blockedReason?: "permission_required" | "unsupported" | "disabled";
  consecutiveFailures: number;
  checkedAt?: number;
  nextCheckAt?: number;
}
export interface SourceHealthTransition { id: string; providerId: string; status: "healthy" | "unavailable"; at: number }
interface Entry {
  provider: Provider;
  fingerprint: string;
  verified: boolean;
  eligibility: SourceHealthEligibility;
  verificationRevoked: boolean;
  status: SourceHealthStatus;
  reason: SourceHealthReason;
  failures: number;
  checkedAt?: number;
  nextCheckAt: number;
  notified: boolean;
  controller?: AbortController;
}
interface CheckResult { result: "healthy" | "failure" | "unknown" | "rate_limited" | "unsupported"; retryAt?: number }
interface CheckJob { entry: Entry; resolve: (fingerprint: string | undefined) => void }
const INTERVAL = 5 * 60_000;
const MAX_BODY_BYTES = 256 * 1024;

/** Only the ordinary, already verified, read-only model-list endpoint is eligible. */
export function modelsHealthFingerprint(provider: Provider): string | undefined {
  if (provider.off || provider.plan || provider.vertex || provider.cliTextBridge || provider.antigravity || provider.kimi || provider.cursor || provider.kiro || provider.mimoFree) return undefined;
  try {
    const url = new URL(endpointUrl(provider, "models"));
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.hash || !/\/models\/?$/.test(url.pathname)) return undefined;
    // Store only a digest; URLs, configured headers and credentials are never
    // exposed by health reports. Changing endpoint/auth configuration revokes proof.
    return createHash("sha256").update(JSON.stringify([provider.id, url.href, provider.wire ?? null, provider.keys?.map(k => [k.id, k.enabled]) ?? null])).digest("hex");
  } catch { return undefined; }
}

function retryAt(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const result = /^\d+(?:\.\d+)?$/.test(header.trim()) ? now + seconds * 1000 : Date.parse(header);
  return Number.isFinite(result) && result > now ? result : undefined;
}

async function modelsResult(response: Response, signal: AbortSignal, now: number): Promise<CheckResult> {
  const retry = retryAt(response.headers.get("retry-after"), now);
  const cancel = () => { void response.body?.cancel().catch(() => {}); };
  if (response.status === 429) { cancel(); return { result: "rate_limited", retryAt: retry ?? now + 30 * 60_000 }; }
  if (response.status === 404 || response.status === 405) { cancel(); return { result: "unsupported" }; }
  if (response.status === 401 || response.status === 403 || response.status >= 500) { cancel(); return { result: "failure", retryAt: retry }; }
  if (!response.ok || !response.body) { cancel(); return { result: "unknown", retryAt: retry }; }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      if (signal.aborted) throw new Error();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) { abort(); return { result: "unknown" }; }
      chunks.push(next.value);
    }
    if (signal.aborted) throw new Error();
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown; models?: unknown };
    const rows = value && (Array.isArray(value.data) ? value.data : Array.isArray(value.models) ? value.models : undefined);
    return { result: rows && rows.every(row => row && typeof row === "object" && (typeof row.id === "string" || typeof row.name === "string")) ? "healthy" : "unknown" };
  } catch { return { result: signal.aborted ? "failure" : "unknown" }; }
  finally { signal.removeEventListener("abort", abort); try { reader.releaseLock(); } catch { /* No raw errors enter health state. */ } }
}

/**
 * A bounded, daemon-local health monitor. runDue() is externally scheduled and
 * single-flight. It sends only GET model-list requests, never generation probes.
 * This reduces load; it cannot promise that every vendor never charges or limits
 * a metadata request. Unsupported sources remain unknown and are not polled.
 */
export class SourceHealthMonitor {
  #entries = new Map<string, Entry>();
  #events: SourceHealthTransition[] = [];
  #sweep?: Promise<void>;
  #jobs = new Map<Entry, Promise<string | undefined>>();
  #queue: CheckJob[] = [];
  #active = new Set<string>();
  #closed = false;
  #now: () => number;
  #fetch: typeof fetch;
  #headers: (provider: Provider, signal: AbortSignal) => Promise<Record<string, string>>;
  #eligibility: (provider: Provider) => SourceHealthEligibility;
  #interval: number;
  #stale: number;
  #timeout: number;
  #threshold: number;
  #concurrency: number;

  constructor(options: {
    headers: (provider: Provider, signal: AbortSignal) => Promise<Record<string, string>>;
    /** Successful metadata responses alone never grant permission to poll a relay. */
    eligibility?: (provider: Provider) => SourceHealthEligibility;
    fetch?: typeof fetch;
    now?: () => number;
    intervalMs?: number;
    staleAfterMs?: number;
    timeoutMs?: number;
    failureThreshold?: number;
    concurrency?: number;
  }) {
    this.#headers = options.headers; this.#fetch = options.fetch ?? fetch; this.#now = options.now ?? Date.now;
    this.#eligibility = options.eligibility ?? (() => ({ eligible: false, blockedReason: "permission_required" }));
    this.#interval = options.intervalMs ?? INTERVAL;
    this.#stale = options.staleAfterMs ?? Math.max(this.#interval * 3, 15 * 60_000);
    this.#timeout = options.timeoutMs ?? 5_000; this.#threshold = options.failureThreshold ?? 3; this.#concurrency = options.concurrency ?? 2;
    if (!Number.isFinite(this.#interval) || this.#interval < INTERVAL || !Number.isFinite(this.#stale) || this.#stale < this.#interval
      || !Number.isInteger(this.#timeout) || this.#timeout < 10 || this.#timeout > 30_000
      || !Number.isInteger(this.#threshold) || this.#threshold < 3 || this.#threshold > 10
      || !Number.isInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 2) throw new TypeError("Invalid health-check limits");
  }

  /** Revoke evidence on configuration changes and cancel removed/disabled checks. */
  sync(providers: readonly Provider[]): void {
    const ids = new Set<string>();
    for (const provider of providers) {
      ids.add(provider.id);
      const fingerprint = modelsHealthFingerprint(provider.off ? { ...provider, off: false } : provider) ?? "";
      const eligibility: SourceHealthEligibility = provider.off ? { eligible: false, blockedReason: "disabled" } : fingerprint ? this.#eligibility(provider) : { eligible: false, blockedReason: "unsupported" };
      const prior = this.#entries.get(provider.id);
      if (prior?.fingerprint === fingerprint && JSON.stringify(prior.eligibility) === JSON.stringify(eligibility)) { prior.provider = structuredClone(provider); continue; }
      prior?.controller?.abort();
      this.#events = this.#events.filter(event => event.providerId !== provider.id);
      this.#entries.set(provider.id, { provider: structuredClone(provider), fingerprint, eligibility: { ...eligibility }, verified: prior?.fingerprint === fingerprint ? prior.verified : false, verificationRevoked: prior?.fingerprint === fingerprint ? prior.verificationRevoked : false, status: "unknown", reason: fingerprint ? "unverified" : "unsupported", failures: 0, nextCheckAt: prior?.fingerprint === fingerprint ? Math.max(this.#now(), prior.nextCheckAt) : this.#now(), notified: false });
    }
    for (const [id, entry] of this.#entries) if (!ids.has(id)) { entry.controller?.abort(); this.#entries.delete(id); this.#events = this.#events.filter(event => event.providerId !== id); }
  }

  /** Call only after this exact provider configuration returned a valid model list. */
  verify(provider: Provider): string | undefined {
    const fingerprint = modelsHealthFingerprint(provider), entry = this.#entries.get(provider.id);
    if (!fingerprint || !entry || entry.fingerprint !== fingerprint || this.#closed) return undefined;
    entry.controller?.abort();
    const current = { ...entry, verified: true, verificationRevoked: false, controller: undefined };
    this.#entries.set(provider.id, current);
    this.apply(current, { result: "healthy" }); return fingerprint;
  }

  /** A saved digest is proof of endpoint validation, not proof of current health. */
  restoreVerification(provider: Provider, fingerprint: string): boolean {
    const entry = this.#entries.get(provider.id);
    if (!entry || !fingerprint || entry.verificationRevoked || entry.fingerprint !== fingerprint || modelsHealthFingerprint(provider) !== fingerprint || this.#closed) return false;
    if (entry.verified) return true;
    entry.verified = true; entry.reason = "checking"; entry.nextCheckAt = Math.max(entry.nextCheckAt, this.#now()); return true;
  }

  /** Credentials replaced under the same key id need explicit revalidation. */
  invalidate(providerId: string): void {
    const entry = this.#entries.get(providerId); if (!entry) return;
    entry.controller?.abort();
    this.#events = this.#events.filter(event => event.providerId !== providerId);
    this.#entries.set(providerId, { ...entry, verified: false, verificationRevoked: true, status: "unknown", reason: "unverified", failures: 0, checkedAt: undefined, controller: undefined });
  }

  snapshot(providerId: string): SourceHealthSnapshot {
    const entry = this.#entries.get(providerId);
    if (!entry) return { providerId, status: "unknown", reason: "unverified", verified: false, eligible: false, blockedReason: "permission_required", consecutiveFailures: 0 };
    const stale = entry.checkedAt !== undefined && this.#now() - entry.checkedAt > this.#stale;
    return { providerId, status: stale || !entry.eligibility.eligible ? "unknown" : entry.status, reason: stale ? "stale" : entry.reason, verified: entry.verified, ...entry.eligibility, consecutiveFailures: entry.failures,
      ...(entry.checkedAt === undefined ? {} : { checkedAt: entry.checkedAt }), ...(entry.eligibility.eligible ? { nextCheckAt: entry.nextCheckAt } : {}) };
  }
  snapshots(): SourceHealthSnapshot[] { return [...this.#entries.keys()].map(id => this.snapshot(id)); }

  /** Read-only view for a supplied configuration, without sync or verification. */
  snapshotFor(provider: Provider): SourceHealthSnapshot {
    const entry = this.#entries.get(provider.id), fingerprint = modelsHealthFingerprint(provider);
    if (!entry || !fingerprint || entry.fingerprint !== fingerprint
      || JSON.stringify(entry.eligibility) !== JSON.stringify(this.#eligibility(provider))) {
      return { providerId: provider.id, status: "unknown", reason: "unverified", verified: false, eligible: false, consecutiveFailures: 0 };
    }
    return this.snapshot(provider.id);
  }
  drainTransitions(): SourceHealthTransition[] { const events = this.#events; this.#events = []; return events.filter(event => this.snapshot(event.providerId).status === event.status); }
  close(): void { this.#closed = true; for (const entry of this.#entries.values()) entry.controller?.abort(); this.pump(); }

  /**
   * One explicitly requested bootstrap/check using the same bounded GET path.
   * Eligibility is separate from endpoint verification. Only a valid response
   * returns a persistable fingerprint; a failed bootstrap never enables polling.
   * Existing cooldowns and the shared per-source/global limits still apply.
   */
  checkNow(providerId: string): Promise<string | undefined> {
    const entry = this.#entries.get(providerId);
    return entry ? this.enqueue(entry) : Promise.resolve(undefined);
  }

  runDue(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#sweep) return this.#sweep;
    const due = [...this.#entries.values()].filter(entry => entry.verified && entry.eligibility.eligible && entry.nextCheckAt <= this.#now()).sort((a, b) => a.nextCheckAt - b.nextCheckAt);
    let index = 0;
    const worker = async () => { while (!this.#closed && index < due.length) { const entry = due[index++]!; if (this.#entries.get(entry.provider.id) === entry && entry.verified) await this.enqueue(entry); } };
    const sweep = Promise.all(Array.from({ length: Math.min(this.#concurrency, due.length) }, worker)).then(() => {});
    this.#sweep = sweep.finally(() => { this.#sweep = undefined; }); return this.#sweep;
  }

  private enqueue(entry: Entry): Promise<string | undefined> {
    const existing = this.#jobs.get(entry); if (existing) return existing;
    if (this.#closed || !entry.fingerprint || !entry.eligibility.eligible || this.#entries.get(entry.provider.id) !== entry || entry.nextCheckAt > this.#now()) return Promise.resolve(undefined);
    let resolve!: CheckJob["resolve"];
    const promise = new Promise<string | undefined>(done => { resolve = done; });
    this.#jobs.set(entry, promise); this.#queue.push({ entry, resolve }); this.pump(); return promise;
  }

  private pump(): void {
    for (let i = 0; i < this.#queue.length;) {
      const job = this.#queue[i]!, entry = job.entry;
      if (this.#closed || !entry.eligibility.eligible || this.#entries.get(entry.provider.id) !== entry || entry.nextCheckAt > this.#now()) {
        this.#queue.splice(i, 1); this.#jobs.delete(entry); job.resolve(undefined); continue;
      }
      if (this.#active.size >= this.#concurrency || this.#active.has(entry.provider.id)) { i++; continue; }
      this.#queue.splice(i, 1); this.#active.add(entry.provider.id);
      const finish = (fingerprint: string | undefined) => {
        this.#active.delete(entry.provider.id); this.#jobs.delete(entry); job.resolve(fingerprint); this.pump();
      };
      void this.check(entry).then(finish, () => finish(undefined));
    }
  }

  private async check(entry: Entry): Promise<string | undefined> {
    // Reserve before the first await so a permission/off toggle cannot cancel
    // an in-flight GET and immediately start another under the same fingerprint.
    entry.nextCheckAt = Math.max(entry.nextCheckAt, this.#now() + this.#interval);
    const controller = new AbortController(); entry.controller = controller;
    let requestStarted = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CheckResult>(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ result: requestStarted ? "failure" : "unknown" }); }, this.#timeout); });
    const request = async (): Promise<CheckResult> => {
      try {
        const headers = await this.#headers(structuredClone(entry.provider), controller.signal);
        if (controller.signal.aborted) return { result: "unknown" };
        requestStarted = true;
        const response = await this.#fetch(endpointUrl(entry.provider, "models"), { method: "GET", headers, redirect: "error", signal: controller.signal });
        return await modelsResult(response, controller.signal, this.#now());
      } catch { return { result: requestStarted ? "failure" : "unknown" }; }
    };
    try {
      const result = await Promise.race([request(), timeout]);
      const current = this.#entries.get(entry.provider.id);
      // Keep late vendor cooldowns for the same endpoint even when its health
      // observation became obsolete during an off/permission/credential change.
      if (current && current !== entry && current.fingerprint === entry.fingerprint && result.retryAt) current.nextCheckAt = Math.max(current.nextCheckAt, result.retryAt);
      if (!this.#closed && this.#entries.get(entry.provider.id) === entry) {
        if (result.result === "healthy") { entry.verified = true; entry.verificationRevoked = false; }
        this.apply(entry, result);
        if (result.result === "healthy") return entry.fingerprint;
      }
      return undefined;
    }
    finally { if (timer) clearTimeout(timer); if (entry.controller === controller) entry.controller = undefined; }
  }

  private apply(entry: Entry, result: CheckResult): void {
    const now = this.#now(); entry.checkedAt = now; entry.nextCheckAt = Math.max(now + this.#interval, entry.nextCheckAt, result.retryAt ?? 0);
    if (result.result === "healthy") {
      entry.status = "healthy"; entry.reason = "verified_models"; entry.failures = 0;
      if (entry.notified) this.event(entry, "healthy", now);
      entry.notified = false;
    } else if (result.result === "failure") {
      entry.failures++;
      entry.status = entry.verified && entry.failures >= this.#threshold ? "unavailable" : "unknown";
      entry.reason = entry.status === "unavailable" ? "consecutive_failures" : "inconclusive";
      if (entry.status === "unavailable" && !entry.notified) { this.event(entry, "unavailable", now); entry.notified = true; }
    } else {
      entry.status = "unknown"; entry.failures = 0;
      entry.reason = result.result === "rate_limited" ? "rate_limited" : result.result === "unsupported" ? "unsupported" : "inconclusive";
      if (result.result === "unsupported") { entry.verified = false; entry.verificationRevoked = true; }
    }
  }
  private event(entry: Entry, status: "healthy" | "unavailable", at: number): void {
    this.#events = this.#events.filter(event => event.providerId !== entry.provider.id);
    if (this.#events.length >= 1000) this.#events.shift();
    this.#events.push({ id: randomUUID(), providerId: entry.provider.id, status, at });
  }
}
