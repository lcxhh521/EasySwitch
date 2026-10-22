import type { ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { fromClaudeModelId } from "./catalog.ts";
import { modelEfforts } from "./model-efforts.ts";
import type { Store } from "./store.ts";
import type { Pool, PoolRetryEvidence } from "./types.ts";
import { exhaustedUntil } from "./quota.ts";

/**
 * Model pools: one name, several places to get the model from. A request for `pool/<id>` goes to a
 * member chosen by the pool's strategy, and when that member fails before answering (it is down,
 * out of quota, or refuses the key) the next member is tried, so the agent never notices.
 *
 *   order   the first member that works; the others are the fallback
 *   rotate  members take turns, spreading the load (and the quota)
 *
 * A member that has just failed rests for a minute and is tried last until then.
 */

export const POOL_PREFIX = "pool/";
const REST_MS = 60_000;
const resting = new Map<string, number>();
const turns = new Map<string, number>();

export function isPoolName(name: string): boolean {
  return name.startsWith(POOL_PREFIX);
}

export function poolOf(store: Store, name: string): Pool | undefined {
  return isPoolName(name) ? store.pool(name.slice(POOL_PREFIX.length)) : undefined;
}

/** Members that still exist, as `<provider>/<model>`. */
export function liveMembers(store: Store, pool: Pool): string[] {
  const have = new Set(store.catalog().filter(m => m.providerId !== "pool").map(m => `${m.providerId}/${m.model}`));
  return pool.members.filter(m => have.has(m));
}

export interface PoolMemberState {
  member: string;
  /** Catalog eligibility only, never a health or remaining-quota assertion. */
  selectable: boolean;
  reason: "catalog_eligible" | "source_missing" | "source_disabled" | "budget_blocked" | "model_missing" | "unsupported" | "unknown_excluded";
}

/** Read-only explanation. Unlike poolMembers(), this never consumes a rotate turn. */
export function poolMemberStates(store: Store, pool: Pool): PoolMemberState[] {
  const live = new Set(liveMembers(store, pool));
  return pool.members.map(member => {
    const slash = member.indexOf("/"), provider = store.provider(member.slice(0, slash));
    const model = member.slice(slash + 1);
    const reason: PoolMemberState["reason"] = !provider ? "source_missing" : provider.off ? "source_disabled"
      : store.providerBudgetStopped(provider) ? "budget_blocked" : provider.cliTextBridge?.kind === "droid" ? "unsupported"
      : !(provider.models.length ? provider.models : provider.defaultModel ? [provider.defaultModel] : []).includes(model) ? "model_missing"
      : live.has(member) ? "catalog_eligible" : "unknown_excluded";
    return { member, selectable: reason === "catalog_eligible", reason };
  });
}

/** The members to try for one request, in order; undefined when the name is not a pool. */
export function poolMembers(store: Store, name: string): string[] | undefined {
  const pool = poolOf(store, name);
  if (!pool) return undefined;
  let members = liveMembers(store, pool);
  if (pool.strategy === "rotate" && members.length > 1) {
    const turn = turns.get(pool.id) ?? 0;
    turns.set(pool.id, turn + 1);
    const at = turn % members.length;
    members = [...members.slice(at), ...members.slice(0, at)];
  }
  const now = Date.now();
  // A member rests for a minute after a failure, and a member whose plan is used up rests until the plan is back.
  const restUntil = (m: string) => Math.max(resting.get(m) ?? 0, exhaustedUntil(m.slice(0, m.indexOf("/")), now) ?? 0);
  const fresh = members.filter(m => restUntil(m) <= now);
  return [...fresh, ...members.filter(m => restUntil(m) > now)];
}

/** Forget which members are resting (tests, and a "try everything again" for the future). */
export function clearRest(): void {
  resting.clear();
}

export function markFailed(member: string): void {
  resting.set(member, Date.now() + REST_MS);
}

/** Existing member marker only; reading it neither clears it nor consumes a turn. */
export function poolRestUntil(member: string): number | undefined {
  return resting.get(member);
}

/** The thinking levels every member has: the pool can only promise what all of them can do. */
export function poolEfforts(store: Store, pool: Pool): string[] {
  const lists = liveMembers(store, pool).map(member => {
    const slash = member.indexOf("/");
    const provider = store.provider(member.slice(0, slash));
    return provider ? modelEfforts(provider, member.slice(slash + 1)) : [];
  });
  if (!lists.length) return [];
  return lists[0]!.filter(level => lists.every(l => l.includes(level)));
}

/** A failure the next member might not have: it is down, limited, or does not accept the key. */
function retriable(status: number): boolean {
  return status === 429 || status === 401 || status === 403 || status >= 500;
}

/**
 * Stands in for the response while one member is tried. If the member answers with a retriable
 * failure before anything was sent and another member remains, the whole attempt is discarded;
 * otherwise it passes straight through to the real response (streams included).
 */
class Gate extends Writable {
  retry = false;
  statusCode = 200;
  headersSent = false;
  private discard = false;
  private readonly real: ServerResponse;
  private readonly canRetry: boolean;

  constructor(real: ServerResponse, canRetry: boolean) {
    super();
    this.real = real;
    this.canRetry = canRetry;
    real.on("close", () => this.emit("close"));
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headersSent = true;
    if (this.canRetry && retriable(status)) this.discard = true;
    else this.real.writeHead(status, headers);
    this.retry = this.discard;
    return this;
  }

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (error?: Error | null) => void): void {
    if (this.discard) { cb(); return; }
    if (!this.real.headersSent) this.real.writeHead(this.statusCode);
    this.real.write(chunk, cb);
  }

  override _final(cb: (error?: Error | null) => void): void {
    if (!this.discard) this.real.end();
    cb();
  }

  override _destroy(error: Error | null, cb: (error?: Error | null) => void): void {
    // A broken forwarded stream must stay broken; a clean EOF could look like success.
    if (error && !this.discard) this.real.destroy();
    cb(error);
  }
}

/** Runs one request against a pool's members in turn. Anything that is not a pool runs once, as it is. */
export interface PoolContext {
  /** Which pool and which try this is, for the log. */
  pool: string;
  attempt: number;
  attempts: number;
  /** Present only when this subsequent attempt actually enters its handler. */
  retryFrom?: PoolRetryEvidence;
}

export async function runWithPool(
  store: Store, exposed: string | undefined, res: ServerResponse,
  attempt: (res: ServerResponse, member: string | undefined, ctx?: PoolContext) => Promise<void>,
): Promise<void> {
  const members = exposed ? poolMembers(store, exposed) : undefined;
  if (!members?.length) { await attempt(res, undefined); return; }
  let retryFrom: PoolRetryEvidence | undefined;
  for (let i = 0; i < members.length; i++) {
    if (res.destroyed || res.writableEnded) return;
    const gate = new Gate(res, i < members.length - 1);
    const settled = new Promise<void>(resolve => { gate.once("finish", resolve); gate.once("close", resolve); });
    await attempt(gate as unknown as ServerResponse, members[i], { pool: exposed!, attempt: i + 1, attempts: members.length, ...(retryFrom ? { retryFrom: { ...retryFrom } } : {}) });
    await settled;
    if (res.destroyed || res.writableEnded) return;
    if (!gate.retry) return;
    markFailed(members[i]!);
    retryFrom = { member: members[i]!, attempt: i + 1, status: gate.statusCode };
  }
}

/** The model a request body names, with Claude Code's picker ids decoded. */
export function modelOfBody(rawBody: string): string | undefined {
  try {
    const m = (JSON.parse(rawBody) as { model?: unknown }).model;
    return typeof m === "string" ? (fromClaudeModelId(m) ?? m) : undefined;
  } catch {
    return undefined;
  }
}

/** The same body for another model. */
export function withModel(rawBody: string, model: string): string {
  try {
    return JSON.stringify({ ...(JSON.parse(rawBody) as Record<string, unknown>), model });
  } catch {
    return rawBody;
  }
}
