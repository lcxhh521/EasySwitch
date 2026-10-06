import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { canonicalAgentId } from "./agent-identity.ts";
import { GatewaySessionStore, GatewaySessionStoreError } from "./gateway-session-store.ts";
export { GatewaySessionStoreError } from "./gateway-session-store.ts";

/** Authentication is issuance-based, never inferred from a token's readable agent label. */
export interface GatewaySession {
  id: string;
  agentId: string;
  depth: number;
  allowMcp: boolean;
  allowNativeClaude: boolean;
  issuedAt: string;
  expiresAt: string;
  kind: "launch" | "manual";
}

export interface GatewayTokenOptions {
  depth?: number;
  allowMcp?: boolean;
  allowNativeClaude?: boolean;
  ttlMs?: number;
}

export type GatewayScope = "inference" | "models" | "mcp";
export const DEFAULT_LAUNCH_TTL = 24 * 60 * 60_000;
export const DEFAULT_MANUAL_TTL = 24 * 60 * 60_000;
const MAX_TTL = 30 * DEFAULT_LAUNCH_TTL;
const digest = (token: string): string => createHash("sha256").update(token).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const dateValue = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const keysAre = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);

export class GatewayIssuanceLimitError extends Error {
  status = 429;
  code = "gateway_session_issuance_limited";
}
export interface GatewayAuthorityOptions {
  now?: () => number;
  maxSessions?: number;
  stateFile?: string;
  maxManualSessions?: number;
  maxManualPerAgent?: number;
  manualRateLimit?: number;
  manualRateWindowMs?: number;
}

/**
 * Capabilities have finite, non-sliding expiry. Production can persist an append-only private journal;
 * tests without stateFile remain memory-only. No legacy signed/stable token is imported or trusted.
 */
export class GatewayTokenAuthority {
  #sessions = new Map<string, GatewaySession>();
  #seenHashes = new Set<string>();
  #seenIds = new Set<string>();
  #manualIssues: Array<{ agentId: string; at: number }> = [];
  #now: () => number;
  #maxSessions: number;
  #maxManual: number;
  #maxManualPerAgent: number;
  #manualRateLimit: number;
  #rateWindow: number;
  #store?: GatewaySessionStore;
  #blocked = false;

  constructor(options: GatewayAuthorityOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxSessions = options.maxSessions ?? 2048;
    this.#maxManual = options.maxManualSessions ?? Math.min(64, Math.max(0, this.#maxSessions - 1));
    this.#maxManualPerAgent = options.maxManualPerAgent ?? 8;
    this.#manualRateLimit = options.manualRateLimit ?? 4;
    this.#rateWindow = options.manualRateWindowMs ?? 60_000;
    if (!Number.isInteger(this.#maxSessions) || this.#maxSessions < 1 || !Number.isInteger(this.#maxManual) || this.#maxManual < 0 || this.#maxManual >= this.#maxSessions
      || !Number.isInteger(this.#maxManualPerAgent) || this.#maxManualPerAgent < 1 || !Number.isInteger(this.#manualRateLimit) || this.#manualRateLimit < 1
      || !Number.isSafeInteger(this.#rateWindow) || this.#rateWindow < 1) throw new TypeError("Invalid session limits");
    if (options.stateFile) this.#store = new GatewaySessionStore(options.stateFile);
    // Corrupt persistence leaves a closed authority that can report a clear error without overwriting it.
    try { this.sync(); } catch { /* issue/list/revoke will surface the storage blocker; auth always refuses. */ }
  }

  issue(agentId: string, options: GatewayTokenOptions = {}): GatewaySession & { token: string } {
    return this.issueKind(agentId, options, "launch");
  }
  issueManual(agentId: string, options: GatewayTokenOptions = {}): GatewaySession & { token: string } {
    return this.issueKind(agentId, options, "manual");
  }
  private issueKind(agentId: string, options: GatewayTokenOptions, kind: GatewaySession["kind"]): GatewaySession & { token: string } {
    const agent = canonicalAgentId(agentId);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent)) throw new TypeError("Invalid agent id");
    const depth = options.depth ?? 0;
    if (!Number.isInteger(depth) || depth < 0 || depth > 2) throw new TypeError("Invalid session depth");
    const ttlMs = options.ttlMs ?? (kind === "manual" ? DEFAULT_MANUAL_TTL : DEFAULT_LAUNCH_TTL);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL) throw new TypeError("Session lifetime must be between 1 millisecond and 30 days");
    if (options.allowMcp !== undefined && typeof options.allowMcp !== "boolean") throw new TypeError("Invalid MCP permission");
    if (options.allowNativeClaude !== undefined && typeof options.allowNativeClaude !== "boolean") throw new TypeError("Invalid native Claude permission");
    this.sync();
    if (this.#sessions.size >= this.#maxSessions) throw new GatewayIssuanceLimitError("Too many active gateway sessions; revoke an unused token first");
    const now = this.#now();
    if (kind === "manual") {
      const manual = [...this.#sessions.values()].filter(session => session.kind === "manual");
      if (manual.length >= this.#maxManual || manual.filter(session => session.agentId === agent).length >= this.#maxManualPerAgent)
        throw new GatewayIssuanceLimitError("手动令牌数量已达上限；请撤销不再使用的手动令牌。");
      if (this.#manualIssues.filter(event => event.agentId === agent).length >= this.#manualRateLimit || this.#manualIssues.length >= 64)
        throw new GatewayIssuanceLimitError("手动令牌签发过于频繁，请稍后再试。");
    }
    const session: GatewaySession = {
      id: randomUUID(), agentId: agent, depth, allowMcp: options.allowMcp ?? false,
      allowNativeClaude: options.allowNativeClaude ?? false, kind,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
    };
    const token = `es-session-${agent}-${randomBytes(32).toString("hex")}`;
    this.record({ op: "issue", hash: digest(token), session });
    return { ...session, token };
  }

  authenticate(headers: IncomingHttpHeaders, url?: URL, scope: GatewayScope = "inference"): GatewaySession | undefined {
    const token = requestToken(headers, url);
    if (!token) return undefined;
    try { this.sync(); } catch { return undefined; }
    const session = this.#sessions.get(digest(token));
    if (!session || (scope === "mcp" && !session.allowMcp)) return undefined;
    return { ...session };
  }
  revoke(token: string): boolean {
    this.sync(); const hash = digest(token);
    if (!this.#sessions.has(hash)) return false;
    this.record({ op: "revoke", hash }); return true;
  }
  revokeId(id: string): boolean {
    this.sync();
    for (const [hash, session] of this.#sessions) if (session.id === id) { this.record({ op: "revoke", hash }); return true; }
    return false;
  }
  clear(): void { this.sync(); this.record({ op: "clear" }); }
  list(): GatewaySession[] { this.sync(); return [...this.#sessions.values()].map(session => ({ ...session })); }

  private record(event: unknown): void {
    try {
      if (this.#store) { this.#store.append(event); this.sync(); }
      else { this.apply(event); this.prune(); }
    } catch { this.#blocked = true; this.#sessions.clear(); throw new GatewaySessionStoreError(); }
  }
  private sync(): void {
    if (this.#blocked) throw new GatewaySessionStoreError();
    try { for (const event of this.#store?.read() ?? []) this.apply(event); this.prune(); }
    catch { this.#blocked = true; this.#sessions.clear(); throw new GatewaySessionStoreError(); }
  }
  private apply(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewaySessionStoreError();
    const event = value as Record<string, unknown>;
    if (event.op === "clear" && keysAre(event, ["op"])) { this.#sessions.clear(); return; }
    if (event.op === "revoke" && keysAre(event, ["op", "hash"]) && typeof event.hash === "string" && HASH.test(event.hash)) {
      if (!this.#seenHashes.has(event.hash)) throw new GatewaySessionStoreError();
      this.#sessions.delete(event.hash); return;
    }
    if (event.op !== "issue" || !keysAre(event, ["op", "hash", "session"]) || typeof event.hash !== "string" || !HASH.test(event.hash) || !event.session || typeof event.session !== "object" || Array.isArray(event.session)) throw new GatewaySessionStoreError();
    const s = event.session as Record<string, unknown>;
    if (!keysAre(s, ["id", "agentId", "depth", "allowMcp", "allowNativeClaude", "issuedAt", "expiresAt", "kind"])
      || typeof s.id !== "string" || !UUID.test(s.id) || typeof s.agentId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(s.agentId) || canonicalAgentId(s.agentId) !== s.agentId
      || typeof s.depth !== "number" || !Number.isInteger(s.depth) || s.depth < 0 || s.depth > 2
      || typeof s.allowMcp !== "boolean" || typeof s.allowNativeClaude !== "boolean" || !dateValue(s.issuedAt) || !dateValue(s.expiresAt)
      || Date.parse(s.expiresAt) <= Date.parse(s.issuedAt) || Date.parse(s.expiresAt) - Date.parse(s.issuedAt) > MAX_TTL
      || (s.kind !== "launch" && s.kind !== "manual") || this.#seenHashes.has(event.hash) || this.#seenIds.has(s.id)) throw new GatewaySessionStoreError();
    const session = s as unknown as GatewaySession;
    this.#seenHashes.add(event.hash); this.#seenIds.add(session.id);
    this.#sessions.set(event.hash, { ...session });
    if (session.kind === "manual") this.#manualIssues.push({ agentId: session.agentId, at: Date.parse(session.issuedAt) });
    if (this.#sessions.size > this.#maxSessions) {
      this.prune(); if (this.#sessions.size > this.#maxSessions) throw new GatewaySessionStoreError();
    }
  }
  private prune(): void {
    const now = this.#now();
    for (const [hash, session] of this.#sessions) if (Date.parse(session.expiresAt) <= now) this.#sessions.delete(hash);
    this.#manualIssues = this.#manualIssues.filter(event => event.at > now - this.#rateWindow);
  }
}

/**
 * Claude's local session header coexists with its genuine vendor Authorization.
 * An explicit invalid local header never falls back to a different credential.
 * Ordinary clients may use Bearer, x-api-key or x-goog-api-key; Gemini also uses ?key=.
 * Conflicting/duplicated fields are rejected rather than selecting a lucky valid one.
 */
export function requestToken(headers: IncomingHttpHeaders, url?: URL): string | undefined {
  if (headers["x-easyswitch-session"] !== undefined) {
    const custom = headers["x-easyswitch-session"];
    return typeof custom === "string" && validTokenShape(custom) ? custom : undefined;
  }
  const tokens: string[] = [];
  if (headers.authorization !== undefined) {
    if (typeof headers.authorization !== "string") return undefined;
    const bearer = /^Bearer ([^\s,]+)$/i.exec(headers.authorization)?.[1];
    if (!bearer) return undefined;
    tokens.push(bearer);
  }
  for (const name of ["x-api-key", "x-goog-api-key"]) {
    const value = headers[name];
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    tokens.push(value);
  }
  if (url && (/^\/v1beta\/(?:models(?:\/|$)|openai\/models(?:\/|$))/.test(url.pathname) || /^\/v1\/models\/.+:(?:generateContent|streamGenerateContent|countTokens)$/.test(url.pathname))) {
    const keys = url.searchParams.getAll("key");
    if (keys.length > 1) return undefined;
    if (keys.length) tokens.push(keys[0]!);
  }
  if (!tokens.length || new Set(tokens).size !== 1 || !validTokenShape(tokens[0]!)) return undefined;
  return tokens[0];
}

function validTokenShape(token: string): boolean {
  return /^es-session-[a-z][a-z0-9-]{0,63}-[a-f0-9]{64}$/.test(token);
}

/** Shared by in-process launchers and the production server; tests may inject their own authority. */
export const gatewayTokens = new GatewayTokenAuthority();
export function sessionToken(agentId: string, options: GatewayTokenOptions = {}): string {
  return gatewayTokens.issue(agentId, options).token;
}
