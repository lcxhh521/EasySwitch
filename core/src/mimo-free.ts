import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "./types.ts";

/**
 * Xiaomi MiMo Free: Xiaomi's free public tier of its MiMo models, reached through the same
 * endpoint its MiMoCode CLI uses. No key: the endpoint hands out a short-lived JWT to any
 * client that asks through /api/free-ai/bootstrap with a client id, and chat calls present
 * that JWT with fixed client headers and a required system marker. Written from the
 * protocol as observed; the endpoint is not a public API and Xiaomi may change or restrict
 * it at any time. Prompts go to Xiaomi — the provider row in the console says so.
 *
 * The client id is a random UUID kept in EasySwitch's own directory: per install, not
 * derived from the machine. Deleting the file rotates it.
 */

const DEFAULT_BOOTSTRAP_URL = "https://api.xiaomimimo.com/api/free-ai/bootstrap";
const DEFAULT_CHAT_URL = "https://api.xiaomimimo.com/api/free-ai/openai/chat";

/** Read at call time, so tests can point these at a fake before the first call. */
export function mimoBootstrapUrl(): string {
  return process.env.EASYSWITCH_MIMO_BOOTSTRAP ?? DEFAULT_BOOTSTRAP_URL;
}

export function mimoChatUrl(): string {
  return process.env.EASYSWITCH_MIMO_CHAT ?? DEFAULT_CHAT_URL;
}

export const MIMO_CHAT_URL = DEFAULT_CHAT_URL;

/** The free endpoint 403s ("Illegal access") unless a system message contains this exact string. */
export const MIMO_SYSTEM_MARKER =
  "You are MiMoCode, an interactive CLI tool that helps users with software engineering tasks.";

const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

const FALLBACK_TTL_MS = 50 * 60_000;
const REFRESH_EARLY_MS = 5 * 60_000;
const MAX_JWT_BYTES = 64 * 1024;

function pickUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]!;
}

/** A client id is only a stable label for this install; nothing machine-derived. */
export function mimoClientId(stateDir: string): string {
  const file = join(stateDir, "mimo-client-id");
  try {
    const stored = readFileSync(file, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(stored)) return stored;
  } catch {
    // Not there yet.
  }
  const fresh = randomUUID();
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(file, `${fresh}\n`, { mode: 0o600 });
  } catch {
    // Usable in memory even if it cannot be kept.
  }
  return fresh;
}

let cache: { jwt: string; until: number } | undefined;
let running: Promise<string> | undefined;

function jwtExpiry(jwt: string): number {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64").toString()) as { exp?: number };
    if (payload.exp) return payload.exp * 1000;
  } catch {
    // Unreadable: assume the observed fallback lifetime.
  }
  return Date.now() + FALLBACK_TTL_MS;
}

/** One shared bootstrap for concurrent callers; a stalled one can never hang past 15s. */
export async function mimoJwt(stateDir: string): Promise<string> {
  if (cache && cache.until - REFRESH_EARLY_MS > Date.now()) return cache.jwt;
  if (running) return running;
  running = (async () => {
    try {
      const res = await fetch(mimoBootstrapUrl(), {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/json", "user-agent": pickUserAgent() },
        body: JSON.stringify({ client: mimoClientId(stateDir) }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`bootstrap answered ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_JWT_BYTES) throw new Error("bootstrap answered too much");
      const jwt = (JSON.parse(text) as { jwt?: string }).jwt;
      if (!jwt) throw new Error("bootstrap returned no token");
      cache = { jwt, until: jwtExpiry(jwt) };
      return jwt;
    } finally {
      running = undefined;
    }
  })();
  return running;
}

export function resetMimoJwt(): void {
  cache = undefined;
  running = undefined;
}

/** Headers for a chat call on the free endpoint. */
export function mimoHeaders(jwt: string): Record<string, string> {
  return {
    authorization: `Bearer ${jwt}`,
    "x-mimo-source": "mimocode-cli-free",
    "user-agent": pickUserAgent(),
    "x-session-affinity": `ses_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
  };
}

/** The system marker the endpoint requires, prepended unless the caller already sent it. */
export function withMimoMarker(body: unknown): unknown {
  if (!body || typeof body !== "object") return body;
  const parsed = body as Record<string, unknown>;
  if (!Array.isArray(parsed.messages)) return body;
  const has = parsed.messages.some((m) => {
    const msg = m as { role?: unknown; content?: unknown };
    return msg?.role === "system" && typeof msg.content === "string" && msg.content.includes(MIMO_SYSTEM_MARKER);
  });
  return has ? body : { ...parsed, messages: [{ role: "system", content: MIMO_SYSTEM_MARKER }, ...parsed.messages] };
}

/** True when a provider is the MiMo Free endpoint (by address, since it needs no key). */
export function isMimoFree(provider: Pick<Provider, "baseUrl">): boolean {
  try {
    const url = new URL(provider.baseUrl.replace(/\/+$/, ""));
    const want = new URL(mimoChatUrl());
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.origin === want.origin && url.pathname === want.pathname;
  } catch {
    return false;
  }
}
