import { automaticLocalStamp } from "./automatic-local-stamp.ts";
import type { SecretStore } from "./secrets.ts";
import { validateApproval, readApprovedKey } from "./automatic-approval.ts";
import { AutomaticFailureLedger, automaticTextRequestIssue } from "./automatic-policy.ts";
import { withAutomaticAttempt, type AutomaticDispatchBudget } from "./automatic-dispatch.ts";
import { ProtocolError } from "./protocol.ts";
import type { ApiProtocol } from "./types.ts";
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
  private readonly retryAllowed: (status: number) => boolean;

  constructor(real: ServerResponse, canRetry: boolean, retryAllowed: (status: number) => boolean = retriable) {
    super();
    this.real = real;
    this.canRetry = canRetry;
    this.retryAllowed = retryAllowed;
    real.on("close", () => this.emit("close"));
  }

  writeHead(status: number, headers?: Record<string, string>): this {
    this.statusCode = status;
    this.headersSent = true;
    if (this.canRetry && this.retryAllowed(status)) this.discard = true;
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
  automatic?: AutomaticPoolRuntime,
): Promise<void> {
  const pool = exposed ? poolOf(store, exposed) : undefined;
  if (pool?.strategy === "automatic") { await runAutomaticPool(store, pool, res, attempt, automatic); return; }
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

/** Only explicit automatic requests use this runtime; ordinary order/rotate stay unchanged. */
export interface AutomaticPoolRuntime {
  secrets: SecretStore;
  protocol: ApiProtocol;
  raw: string;
  failures: AutomaticFailureLedger;
  compatibilityIssue?: string;
  /** Must reauthenticate the original session and check the current global budget. */
  assertAllowed(): void;
}
function automaticError(res: ServerResponse, protocol: ApiProtocol, status: number, message: string): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(protocol === "gemini" ? { error: { code: status, message, status: "FAILED_PRECONDITION" } }
    : { ...(protocol === "messages" ? { type: "error" } : {}), error: { type: "automatic_selection_error", code: "automatic_selection_paused", message } }));
}
async function runAutomaticPool(store: Store, pool: Pool, res: ServerResponse,
  attempt: (res: ServerResponse, member: string | undefined, ctx?: PoolContext) => Promise<void>, runtime?: AutomaticPoolRuntime): Promise<void> {
  const protocol = runtime?.protocol ?? "chat";
  try {
    if (!runtime) throw new ProtocolError("自动选择缺少逐次权限检查，已停止请求。", 409);
    runtime.assertAllowed();
    const issue = runtime.compatibilityIssue ?? automaticTextRequestIssue(protocol, runtime.raw);
    if (issue) throw new ProtocolError(issue, 400);
    const localStamp = automaticLocalStamp(store, pool.members, pool.id);
    const approval = await validateApproval(store, runtime.secrets, pool);
    if (!approval.ok) throw new ProtocolError(approval.reason, 409);
    runtime.assertAllowed();
    const selected = pool.automaticApproval!.members;
    const identities = new Map(selected.map(m => [m.member, `${pool.id}:${pool.automaticApproval!.salt}:${m.seal}`]));
    const configured = new Set(liveMembers(store, pool));
    const eligible = pool.members.filter(m => configured.has(m));
    if (!eligible.length) throw new ProtocolError("已确认的来源当前都被配置或预算阻断，请检查后重新请求。", 429);
    const members = eligible.filter(m => runtime.failures.waitUntil(identities.get(m)!, protocol) === undefined);
    if (!members.length) throw new ProtocolError("已确认的来源都在失败等待中，已暂停且未发送请求；请等待标记到期后主动重试，或检查来源设置。到期不代表真实额度已恢复。", 503);
    const shared: AutomaticDispatchBudget = { used: 0, limit: 2 };
    let retryFrom: PoolRetryEvidence | undefined;
    for (let i = 0; i < members.length && shared.used < 2; i += 1) {
      if (res.destroyed || res.writableEnded) return;
      const member = members[i]!, providerId = member.slice(0, member.indexOf("/"));
      const pinned = selected.find(m => m.member === member)!;
      let observed: { status: number; at: number } | undefined;
      let requestKey: string | undefined;
      const assertDispatch = () => {
        runtime.assertAllowed();
        if (automaticLocalStamp(store, pool.members, pool.id) !== localStamp) throw new ProtocolError("已确认来源或凭据代次已变化，请重新核对名单。", 409);
        if (!liveMembers(store, pool).includes(member)) throw new ProtocolError("这个已确认来源当前被配置或预算阻断，已停止请求。", 429);
      };
      const check = async (signal: AbortSignal) => {
        signal.throwIfAborted(); assertDispatch();
        // Re-read the selected credential last, including on nested adapter repairs.
        // Never silently refresh prepared authentication to a newly stored value.
        let current;
        try { current = await readApprovedKey(store, runtime.secrets, pool, member, signal); }
        catch { throw new ProtocolError("自动选择的固定凭据已改变或无法核实，请重新确认。", 409); }
        if (!requestKey || current.apiKey !== requestKey) throw new ProtocolError("本次请求的固定凭据已变化，已停止请求。", 409);
        signal.throwIfAborted(); assertDispatch();
      };
      const gate = new Gate(res, i < members.length - 1, status => shared.used < 2 && observed?.status === status && retriable(status));
      const settled = new Promise<void>(resolve => { gate.once("finish", resolve); gate.once("close", resolve); });
      await withAutomaticAttempt({ providerId, ...(pinned.keyId === undefined ? {} : { keyId: pinned.keyId }),
        readKey: async signal => {
          runtime.assertAllowed();
          try { requestKey = (await readApprovedKey(store, runtime.secrets, pool, member, signal)).apiKey; return requestKey; }
          catch { throw new ProtocolError("自动选择的固定凭据已改变或无法核实，请重新确认。", 409); }
        }, beforeDispatch: check, assertDispatch, observe: status => { observed = { status, at: Date.now() }; },
      }, shared, () => attempt(gate as unknown as ServerResponse, member, { pool: `pool/${pool.id}`, attempt: i + 1, attempts: Math.min(members.length, 2), ...(retryFrom ? { retryFrom: { ...retryFrom } } : {}) }));
      await settled;
      // Only a real HTTP observation tied to the still-current full snapshot can influence future requests.
      // Local budget/auth/input failures and late results from replaced credentials never become health facts.
      const fact = observed as { status: number; at: number } | undefined;
      if (fact && (await validateApproval(store, runtime.secrets, pool)).ok) runtime.failures.record(identities.get(member)!, protocol, fact.status, fact.at);
      if (res.destroyed || res.writableEnded || !gate.retry) return;
      retryFrom = { member, attempt: i + 1, status: fact!.status };
    }
  } catch (error) {
    automaticError(res, protocol, error instanceof ProtocolError ? error.status : 409,
      error instanceof ProtocolError ? error.message : "自动选择无法安全继续，请核对已确认来源后重新请求。");
  }
}
