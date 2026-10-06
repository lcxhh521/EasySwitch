import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { canonicalAgentId } from "./agent-identity.ts";

/** Authentication is issuance-based, never inferred from a token's readable agent label. */
export interface GatewaySession {
  id: string;
  agentId: string;
  depth: number;
  allowMcp: boolean;
  allowNativeClaude: boolean;
  issuedAt: string;
  expiresAt: string;
}

export interface GatewayTokenOptions {
  depth?: number;
  allowMcp?: boolean;
  allowNativeClaude?: boolean;
  ttlMs?: number;
}

export type GatewayScope = "inference" | "models" | "mcp";
const DEFAULT_TTL = 24 * 60 * 60_000;
const MAX_TTL = 30 * DEFAULT_TTL;
const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

/**
 * Process-local session capabilities. Only hashes are retained; neither the console's
 * state file nor logs receive tokens. Restarting EasySwitch invalidates all sessions.
 * A token is shown once to its launcher/manual-client setup, then only metadata is listed.
 */
export class GatewayTokenAuthority {
  #sessions = new Map<string, GatewaySession>();
  #now: () => number;
  #maxSessions: number;

  constructor(options: { now?: () => number; maxSessions?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#maxSessions = options.maxSessions ?? 2048;
    if (!Number.isInteger(this.#maxSessions) || this.#maxSessions < 1) throw new TypeError("Invalid session capacity");
  }

  issue(agentId: string, options: GatewayTokenOptions = {}): GatewaySession & { token: string } {
    const agent = canonicalAgentId(agentId);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(agent)) throw new TypeError("Invalid agent id");
    const depth = options.depth ?? 0;
    if (!Number.isInteger(depth) || depth < 0 || depth > 2) throw new TypeError("Invalid session depth");
    const ttlMs = options.ttlMs ?? DEFAULT_TTL;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL) throw new TypeError("Session lifetime must be between 1 millisecond and 30 days");
    if (options.allowMcp !== undefined && typeof options.allowMcp !== "boolean") throw new TypeError("Invalid MCP permission");
    if (options.allowNativeClaude !== undefined && typeof options.allowNativeClaude !== "boolean") throw new TypeError("Invalid native Claude permission");
    this.prune();
    if (this.#sessions.size >= this.#maxSessions) throw new Error("Too many active gateway sessions; revoke an unused token first");
    const now = this.#now();
    const session: GatewaySession = {
      id: randomUUID(), agentId: agent, depth, allowMcp: options.allowMcp ?? false,
      allowNativeClaude: options.allowNativeClaude ?? false,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
    };
    const token = `es-session-${agent}-${randomBytes(32).toString("hex")}`;
    this.#sessions.set(digest(token), session);
    return { ...session, token };
  }

  authenticate(headers: IncomingHttpHeaders, url?: URL, scope: GatewayScope = "inference"): GatewaySession | undefined {
    const token = requestToken(headers, url);
    if (!token) return undefined;
    const key = digest(token);
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (Date.parse(session.expiresAt) <= this.#now()) { this.#sessions.delete(key); return undefined; }
    if (scope === "mcp" && !session.allowMcp) return undefined;
    return { ...session };
  }

  revoke(token: string): boolean { return this.#sessions.delete(digest(token)); }
  revokeId(id: string): boolean {
    for (const [hash, session] of this.#sessions) if (session.id === id) return this.#sessions.delete(hash);
    return false;
  }
  clear(): void { this.#sessions.clear(); }
  list(): GatewaySession[] { this.prune(); return [...this.#sessions.values()].map(session => ({ ...session })); }

  private prune(): void {
    const now = this.#now();
    for (const [hash, session] of this.#sessions) if (Date.parse(session.expiresAt) <= now) this.#sessions.delete(hash);
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
