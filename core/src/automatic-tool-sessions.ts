/** Process-local, explicitly launched Chat tool scopes. Never persists credentials or conversation bodies. */
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { automaticToolApprovalId, validateApproval, readApprovedKey } from "./automatic-approval.ts";
export { automaticToolApprovalId } from "./automatic-approval.ts";
import { withAutomaticAttempt, type AutomaticDispatchBudget } from "./automatic-dispatch.ts";
import { automaticLocalStamp } from "./automatic-local-stamp.ts";
import { createAutomaticToolOutput } from "./automatic-tool-output.ts";
import { parseAutomaticToolRequest, type AutomaticToolCall } from "./automatic-tool-policy.ts";
import type { GatewaySession } from "./gateway-auth.ts";
import { liveMembers, type AutomaticPoolRuntime, type PoolContext } from "./pools.ts";
import { ProtocolError } from "./protocol.ts";
import { sourceProtocols } from "./outbound.ts";
import { upstreamModelId } from "./quirks.ts";
import type { Store } from "./store.ts";
import type { Pool } from "./types.ts";

const PAUSED = "本次工具增强会话已暂停。请检查已有工具执行结果后新开会话；不会换来源、换 Key 或自动重放。";
const UNREGISTERED = "本次工具增强会话没有当前服务进程的可信登记，可能已重启或过期。请新开增强会话，不会退回自动重选。";
const CHANGED = "本次工具增强会话的来源、固定凭据或确认代次已变化。请新开会话，不会切换备用。";
const HASH = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Retain a fixed-size comparison digest, not a copy of the complete source configuration. */
function toolLocalStamp(store: Store, pool: Pool): string {
  return createHash("sha256").update(automaticLocalStamp(store, pool.members, pool.id)).digest("hex");
}

interface ToolPin {
  member: string;
  providerId: string;
  keyId?: string;
  endpoint: string;
  model: string;
  protocol: "chat";
  approvalId: string;
  localStamp: string;
}
interface Scope {
  sessionStamp: string;
  poolId: string;
  approvalId: string;
  expiresAt: number;
  paused: boolean;
  active?: symbol;
  pin?: Readonly<ToolPin>;
  calls: Map<string, AutomaticToolCall>;
}
interface ToolLease {
  pin?: Readonly<ToolPin>;
  calls: ReadonlyMap<string, AutomaticToolCall>;
  assertCurrent(): void;
  commitPin(pin: ToolPin): void;
  commitCalls(calls: readonly AutomaticToolCall[]): void;
  complete(): void;
  release(): void;
  pause(): void;
}
export interface AutomaticToolSessionOptions { now?: () => number; maxSessions?: number; maxCalls?: number; maxTotalCalls?: number }

function sessionStamp(session: GatewaySession): string {
  return JSON.stringify([session.id, session.agentId, session.kind, session.depth, session.allowMcp, session.allowNativeClaude,
    session.issuedAt, session.expiresAt, session.automaticTools]);
}
function validSession(session: GatewaySession, now: number): boolean {
  const marker = session.automaticTools;
  return typeof session.id === "string" && session.id.length > 0 && session.id.length <= 128
    && session.agentId === "opencode" && session.kind === "launch" && session.depth === 0 && session.allowMcp === false && session.allowNativeClaude === false
    && Number.isFinite(Date.parse(session.issuedAt)) && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) > now
    && Date.parse(session.expiresAt) > Date.parse(session.issuedAt)
    && !!marker && !Array.isArray(marker) && marker.version === 1 && typeof marker.poolId === "string" && SAFE_ID.test(marker.poolId)
    && typeof marker.approvalId === "string" && HASH.test(marker.approvalId)
    && Object.keys(marker).length === 3 && Object.keys(marker).every(key => ["version", "poolId", "approvalId"].includes(key));
}

/**
 * The server calls register only for a newly issued, explicitly requested launch. Restored tokens
 * never populate this registry. Entries are bounded and expire at the token's fixed expiry; live
 * entries are never evicted into a fresh state. One active request prevents split-source bootstrap.
 */
export class AutomaticToolSessions {
  #scopes = new Map<string, Scope>();
  #now: () => number;
  #maxSessions: number;
  #maxCalls: number;
  #maxTotalCalls: number;
  #callCount = 0;
  constructor(options: AutomaticToolSessionOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxSessions = options.maxSessions ?? 2048;
    this.#maxCalls = options.maxCalls ?? 4096;
    this.#maxTotalCalls = options.maxTotalCalls ?? 65_536;
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1 || this.#maxSessions > 2048
      || !Number.isSafeInteger(this.#maxCalls) || this.#maxCalls < 1 || this.#maxCalls > 4096
      || !Number.isSafeInteger(this.#maxTotalCalls) || this.#maxTotalCalls < 1 || this.#maxTotalCalls > 65_536) throw new TypeError("Invalid automatic tool session limits");
  }
  #prune(): void {
    const now = this.#now();
    // At most maxSessions entries, with no timer or unbounded tombstone collection.
    for (const [id, scope] of this.#scopes) if (scope.expiresAt <= now) this.remove(id);
  }
  register(session: GatewaySession): void {
    this.#prune();
    if (!validSession(session, this.#now())) throw new ProtocolError(UNREGISTERED, 409);
    if (this.#scopes.has(session.id)) throw new ProtocolError("工具增强会话不能重复登记或重置，请新开会话。", 409);
    if (this.#scopes.size >= this.#maxSessions) throw new ProtocolError("当前工具增强会话已达到数量上限，请结束旧会话后重新启动。", 429);
    this.#scopes.set(session.id, { sessionStamp: sessionStamp(session), poolId: session.automaticTools!.poolId,
      approvalId: session.automaticTools!.approvalId, expiresAt: Date.parse(session.expiresAt), paused: false, calls: new Map() });
  }
  remove(sessionId: string): void {
    const scope = this.#scopes.get(sessionId);
    if (scope) { this.#callCount -= scope.calls.size; this.#scopes.delete(sessionId); }
  }
  pause(sessionId: string): void { const scope = this.#scopes.get(sessionId); if (scope) scope.paused = true; }

  /** Internal runner lease. Every mutation is synchronous and tied to this exact request. */
  acquire(session: GatewaySession, pool: Pool): ToolLease {
    this.#prune();
    const scope = this.#scopes.get(session.id);
    if (!scope) throw new ProtocolError(UNREGISTERED, 409);
    if (!validSession(session, this.#now()) || scope.sessionStamp !== sessionStamp(session)
      || pool.strategy !== "automatic" || !pool.automaticApproval || scope.poolId !== pool.id || scope.approvalId !== automaticToolApprovalId(pool)) {
      scope.paused = true; throw new ProtocolError(CHANGED, 409);
    }
    if (scope.paused) throw new ProtocolError(PAUSED, 409);
    if (scope.active) throw new ProtocolError("本次启动的自动模型正在处理另一个请求，请等待它完成后再继续。未发送本次请求。", 409);
    const requestId = Symbol("automatic tool request"); scope.active = requestId;
    const assertCurrent = () => {
      if (this.#scopes.get(session.id) !== scope || scope.expiresAt <= this.#now()) throw new ProtocolError(UNREGISTERED, 409);
      if (scope.paused || scope.active !== requestId) throw new ProtocolError(PAUSED, 409);
      if (scope.sessionStamp !== sessionStamp(session)) { scope.paused = true; throw new ProtocolError(CHANGED, 409); }
    };
    const release = () => { if (scope.active === requestId) delete scope.active; };
    return {
      pin: scope.pin,
      calls: new Map([...scope.calls].map(([id, call]) => [id, Object.freeze({ ...call })])),
      assertCurrent,
      commitPin: pin => {
        assertCurrent();
        if (scope.pin && JSON.stringify(scope.pin) !== JSON.stringify(pin)) { scope.paused = true; throw new ProtocolError(CHANGED, 409); }
        if (!scope.pin) scope.pin = Object.freeze({ ...pin });
      },
      commitCalls: calls => {
        assertCurrent();
        // Check the complete batch before writing. Duplicate upstream IDs cannot silently replace proofs.
        const ids = new Set<string>();
        for (const call of calls) {
          if (ids.has(call.id) || scope.calls.has(call.id) || !call.id || !call.name || !HASH.test(call.argumentsHash)) {
            scope.paused = true; throw new ProtocolError("工具调用标识重复或无法核实，本次会话已暂停。", 409);
          }
          ids.add(call.id);
        }
        if (scope.calls.size + ids.size > this.#maxCalls || this.#callCount + ids.size > this.#maxTotalCalls) { scope.paused = true; throw new ProtocolError("本次工具会话的可信调用记录已满，请新开会话。", 409); }
        for (const call of calls) scope.calls.set(call.id, Object.freeze({ id: call.id, name: call.name, argumentsHash: call.argumentsHash }));
        this.#callCount += ids.size;
      },
      complete: () => { assertCurrent(); release(); },
      release,
      // A late cancellation of an older output invalidates this scope, not merely its old lease.
      pause: () => { scope.paused = true; release(); },
    };
  }
}

export interface AutomaticToolPoolRuntime extends AutomaticPoolRuntime { session: GatewaySession; registry: AutomaticToolSessions }
function respondError(res: ServerResponse, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof ProtocolError ? error.status : 409;
  const message = error instanceof ProtocolError ? error.message : PAUSED;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "automatic_selection_error", code: "automatic_tool_session_paused", message } }));
}

/** One actual inference send per logical request, no source fallback, credential rotation or shape repair. */
export async function runAutomaticToolPool(store: Store, pool: Pool, res: ServerResponse,
  attempt: (res: ServerResponse, member: string | undefined, ctx?: PoolContext) => Promise<void>, runtime: AutomaticToolPoolRuntime): Promise<void> {
  let lease: ToolLease | undefined;
  let complete = false;
  let validated = false;
  let finishCheck: (() => void) | undefined;
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  let guarded = false;
  let pinCommitted = false;
  const budget: AutomaticDispatchBudget = { used: 0, limit: 1 };
  let observed: { status: number; at: number } | undefined;
  let identity: string | undefined;
  let source: Readable | undefined;
  const disconnected = () => {
    if (res.writableFinished) return;
    if (budget.used > 0 || pinCommitted) lease?.pause();
    source?.destroy(new ProtocolError(PAUSED, 409));
    settle();
  };
  res.once("close", disconnected);
  const finished = () => {
    try {
      if (validated && !complete) { finishCheck?.(); lease!.complete(); complete = true; }
    } catch { lease?.pause(); }
    finally { res.removeListener("close", disconnected); settle(); }
  };
  res.once("finish", finished);
  try {
    if (!runtime?.registry || !runtime.session) throw new ProtocolError(UNREGISTERED, 409);
    lease = runtime.registry.acquire(runtime.session, pool);
    if (runtime.protocol !== "chat" || runtime.compatibilityIssue) throw new ProtocolError(runtime.compatibilityIssue ?? "工具增强会话目前仅支持普通 Chat 同协议请求。", 400);
    const parsed = parseAutomaticToolRequest(runtime.raw, lease.calls, lease.pin !== undefined);
    if (parsed.model !== `pool/${pool.id}`) throw new ProtocolError("工具增强会话只能使用启动时确认的自动模型。", 409);
    const active = (finishing = false) => {
      lease!.assertCurrent();
      if (res.destroyed || (res.writableEnded && !(finishing && res.writableFinished))) throw new ProtocolError("请求已取消，未继续发送。", 409);
      try { runtime.assertAllowed(); } catch (error) { lease!.pause(); throw error; }
    };
    active();
    const localStamp = toolLocalStamp(store, pool);
    if (lease.pin && lease.pin.localStamp !== localStamp) { lease.pause(); throw new ProtocolError(CHANGED, 409); }
    const approval = await validateApproval(store, runtime.secrets, pool);
    if (!approval.ok) { lease.pause(); throw new ProtocolError(approval.reason, 409); }
    active();
    if (automaticToolApprovalId(pool) !== runtime.session.automaticTools!.approvalId || toolLocalStamp(store, pool) !== localStamp) {
      lease.pause(); throw new ProtocolError(CHANGED, 409);
    }
    const selected = pool.automaticApproval!.members;
    const configured = new Set(liveMembers(store, pool));
    // Configuration eligibility is not a probe or a claim of real tool support. P1 cannot convert.
    const chatCapable = new Set(pool.members.filter(member => {
      const slash = member.indexOf("/"), provider = store.provider(member.slice(0, slash));
      return provider && sourceProtocols(provider, upstreamModelId(member.slice(slash + 1))).includes("chat");
    }));
    const identityOf = (member: string) => `${pool.id}:${pool.automaticApproval!.salt}:${selected.find(m => m.member === member)!.seal}`;
    let member = lease.pin?.member;
    if (member) {
      if (!configured.has(member)) { lease.pause(); throw new ProtocolError("本次固定来源已被配置或预算阻断，请新开会话。", 429); }
      if (runtime.failures.waitUntil(identityOf(member), "chat") !== undefined) { lease.pause(); throw new ProtocolError("本次固定来源在失败等待中，不会切换到其他来源，请新开会话。", 503); }
    } else {
      if (!chatCapable.size) throw new ProtocolError("已确认来源的配置均不支持 Chat 同协议工具会话，未发送请求。请选择明确的固定来源。", 400);
      const eligible = pool.members.filter(m => configured.has(m) && chatCapable.has(m));
      if (!eligible.length) throw new ProtocolError("已确认的来源当前都被配置或预算阻断，未发送请求。", 429);
      member = eligible.find(m => runtime.failures.waitUntil(identityOf(m), "chat") === undefined);
      if (!member) throw new ProtocolError("已确认来源都在失败等待中，未发送请求。请等待后主动重试；到期不代表真实额度恢复。", 503);
    }
    const chosen = selected.find(m => m.member === member)!;
    const providerId = member.slice(0, member.indexOf("/")), provider = store.provider(providerId)!;
    const pin: ToolPin = { member, providerId, ...(chosen.keyId === undefined ? {} : { keyId: chosen.keyId }), endpoint: provider.baseUrl,
      model: member.slice(member.indexOf("/") + 1), protocol: "chat", approvalId: runtime.session.automaticTools!.approvalId, localStamp };
    identity = identityOf(member);
    let requestKey: string | undefined;
    const checkIdentity = (finishing = false) => {
      active(finishing);
      if (toolLocalStamp(store, pool) !== localStamp || automaticToolApprovalId(pool) !== pin.approvalId) {
        lease!.pause(); throw new ProtocolError(CHANGED, 409);
      }
      if (!liveMembers(store, pool).includes(member!)) { lease!.pause(); throw new ProtocolError("本次固定来源已被配置或预算阻断，已停止请求。", 429); }
    };
    finishCheck = () => checkIdentity(true);
    await withAutomaticAttempt({ providerId, ...(chosen.keyId === undefined ? {} : { keyId: chosen.keyId }), requireNativeChat: true,
      readKey: async signal => {
        signal.throwIfAborted(); checkIdentity();
        try {
          const key = await readApprovedKey(store, runtime.secrets, pool, member!, signal);
          signal.throwIfAborted(); checkIdentity(); requestKey = key.apiKey; return requestKey;
        } catch (error) {
          if (!signal.aborted || lease!.pin || pinCommitted) lease!.pause();
          signal.throwIfAborted();
          throw error instanceof ProtocolError ? error : new ProtocolError(CHANGED, 409);
        }
      },
      beforeDispatch: async signal => {
        signal.throwIfAborted(); checkIdentity();
        try {
          const current = await readApprovedKey(store, runtime.secrets, pool, member!, signal);
          signal.throwIfAborted(); checkIdentity();
          if (!requestKey || current.apiKey !== requestKey) throw new ProtocolError(CHANGED, 409);
        } catch (error) {
          if (!signal.aborted || lease!.pin || pinCommitted) lease!.pause();
          signal.throwIfAborted();
          throw error instanceof ProtocolError ? error : new ProtocolError(CHANGED, 409);
        }
      },
      assertDispatch: () => { checkIdentity(); lease!.commitPin(pin); pinCommitted = true; },
      observe: status => { observed = { status, at: Date.now() }; if (status < 200 || status >= 300) lease!.pause(); },
      guardResponse: (response: Response) => {
        if (guarded) { lease!.pause(); throw new ProtocolError(PAUSED, 409); }
        guarded = true;
        if (!response.ok) { lease!.pause(); return response; }
        try { checkIdentity(); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
        if (!response.body) { lease!.pause(); throw new ProtocolError("工具增强会话未收到完整响应，已暂停。", 502); }
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
        if (contentType !== (parsed.stream ? "text/event-stream" : "application/json")) {
          lease!.pause(); void response.body.cancel().catch(() => undefined); throw new ProtocolError("工具增强会话的响应格式与请求不符，已暂停。", 502);
        }
        source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
        const output = createAutomaticToolOutput({ stream: parsed.stream, toolNames: parsed.outputToolNames, requireToolCall: parsed.requireToolCall, allowParallelToolCalls: parsed.allowParallelToolCalls,
          commitCalls: calls => { checkIdentity(); if (budget.used !== 1 || !observed || observed.status < 200 || observed.status >= 300) throw new ProtocolError(PAUSED, 409); lease!.commitCalls(calls); },
          onComplete: () => { checkIdentity(); validated = true; },
          onError: () => lease!.pause(),
        });
        source.once("error", error => output.destroy(error));
        output.once("error", error => source?.destroy(error));
        output.once("close", () => { if (!validated) lease!.pause(); if (!source?.destroyed) source?.destroy(); });
        source.pipe(output);
        const headers = new Headers(response.headers); headers.delete("content-length");
        return new Response(Readable.toWeb(output) as ReadableStream<Uint8Array>, { status: response.status, statusText: response.statusText, headers });
      },
    }, budget, () => attempt(res, member, { pool: `pool/${pool.id}`, attempt: 1, attempts: 1 }));
    if (validated && !complete && !res.destroyed) {
      // A nonstandard handler can return after end() but before backpressure flushes. Keep its
      // lease until HTTP finish/close, never turn an undelivered terminal into another dispatch.
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([settled, new Promise<void>(resolve => {
        timer = setTimeout(() => { lease!.pause(); source?.destroy(); res.destroy(); resolve(); }, 30_000);
      })]);
      if (timer) clearTimeout(timer);
    }
    if (!complete && (budget.used > 0 || pinCommitted)) lease.pause();
  } catch (error) {
    // HTTP finish unlocks before unrelated logging awaits; a validated but undelivered terminal does not.
    if (!complete && (budget.used > 0 || pinCommitted || lease?.pin)) lease?.pause();
    respondError(res, error);
  } finally {
    lease?.release();
    if (res.writableFinished || res.destroyed) { res.removeListener("close", disconnected); res.removeListener("finish", finished); }
  }
  // Passive negative evidence only; never delay releasing a completed success for logging/health work.
  if (observed && (observed.status === 401 || observed.status === 403 || observed.status === 429 || observed.status >= 500) && identity
    && (await validateApproval(store, runtime.secrets, pool)).ok) runtime.failures.record(identity, "chat", observed.status, observed.at);
}
