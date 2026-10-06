import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SecretStore } from "../secrets.ts";
import { CURSOR_API } from "./transport.ts";
import { CursorError } from "./errors.ts";

/**
 * Signing in to Cursor: the person approves the login in the browser while EasySwitch polls for the result, with a
 * one-use PKCE pair and no client secret. The refresh token goes to the secret store (the Keychain); the access token
 * (a JWT) is kept in memory and renewed shortly before it ends.
 */

export const CURSOR_WEB = "https://cursor.com";
const api = () => process.env.EASYSWITCH_CURSOR_API ?? CURSOR_API;
const web = () => process.env.EASYSWITCH_CURSOR_WEB ?? CURSOR_WEB;

export interface CursorAccount { id: string; email?: string }

const secretKey = (id: string) => `cursor:${id}`;
type Json = Record<string, any>;

/** The claims of a JWT, read without checking the signature (we only need the name and the end time). */
export function jwtClaims(token: string): Json {
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Json; } catch { return {}; }
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "cursor";

export function accountOf(accessToken: string): CursorAccount {
  const claims = jwtClaims(accessToken);
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : undefined;
  const sub = typeof claims.sub === "string" || Number.isSafeInteger(claims.sub) ? String(claims.sub) : undefined;
  const id = slug(email ?? sub ?? randomUUID());
  return { id, ...(email ? { email } : {}) };
}

/** When the access token ends (a margin of five minutes taken off), or an hour from now if it says nothing. */
function expiryOf(token: string): number {
  const exp = Number(jwtClaims(token).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 - 5 * 60_000 : Date.now() + 60 * 60_000;
}

const cache = new Map<string, { token: string; expires: number }>();

function openInBrowser(url: string): Promise<void> {
  return new Promise(resolve => {
    if (process.platform !== "darwin") { resolve(); return; }
    execFile("open", [url], () => resolve());
  });
}

export interface SignIn { url: string; done: Promise<CursorAccount>; cancel: () => void }

export async function beginCursorSignIn(deps: { secrets: SecretStore; open?: (url: string) => Promise<void>; timeoutMs?: number; pollMs?: number }): Promise<SignIn> {
  const verifier = randomBytes(96).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const uuid = randomUUID();
  const url = `${web()}/loginDeepControl?${new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" })}`;
  let cancelled = false;
  const done = (async (): Promise<CursorAccount> => {
    const until = Date.now() + (deps.timeoutMs ?? 5 * 60_000);
    let delay = deps.pollMs ?? 1000;
    let failures = 0;
    while (Date.now() < until) {
      if (cancelled) throw new CursorError("已取消。", 499);
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 1.2, deps.pollMs ? deps.pollMs * 10 : 10_000);
      let response: Response;
      try { response = await fetch(`${api()}/auth/poll?${new URLSearchParams({ uuid, verifier })}`, { signal: AbortSignal.timeout(15_000) }); }
      catch { if (++failures >= 3) throw new CursorError("连不上 Cursor 的登录服务。"); continue; }
      if (response.status === 404) { await response.body?.cancel(); failures = 0; continue; }
      if ([400, 401, 403, 410].includes(response.status)) { await response.body?.cancel(); throw new CursorError("这次登录已失效或被拒绝，请重新开始。", 401, true); }
      if (!response.ok) { await response.body?.cancel(); if (++failures >= 3) throw new CursorError(`Cursor 的登录服务返回 HTTP ${response.status}。`); continue; }
      const tokens = (await response.json().catch(() => ({}))) as Json;
      const access = String(tokens.accessToken ?? ""); const refresh = String(tokens.refreshToken ?? "");
      if (!access || !refresh) throw new CursorError("Cursor 没有返回完整的登录信息。");
      const account = accountOf(access);
      await deps.secrets.set(secretKey(account.id), refresh);
      cache.set(account.id, { token: access, expires: expiryOf(access) });
      return account;
    }
    throw new CursorError("等待登录超时。", 408);
  })();
  done.catch(() => undefined);
  await (deps.open ?? openInBrowser)(url).catch(() => undefined);
  return { url, done, cancel: () => { cancelled = true; } };
}

/** The account's access token, renewed from the refresh token when it is about to end. */
export async function cursorAccessToken(secrets: SecretStore, accountId: string): Promise<string> {
  const have = cache.get(accountId);
  if (have && have.expires - Date.now() > 0) return have.token;
  const refresh = await secrets.get(secretKey(accountId));
  if (!refresh) throw new CursorError("这个 Cursor 账号的登录信息不见了，请重新登录。", 401, true);
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(r => setTimeout(r, 300 * 2 ** (attempt - 1)));
    const response = await fetch(`${api()}/auth/exchange_user_api_key`, {
      method: "POST", headers: { authorization: `Bearer ${refresh}`, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    if (!response) continue;
    lastStatus = response.status;
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new CursorError("Cursor 的登录已过期，请重新登录。", 401, true); }
    if (!response.ok) { await response.body?.cancel(); if ([429, 500, 502, 503, 504].includes(response.status)) continue; break; }
    const tokens = (await response.json().catch(() => ({}))) as Json;
    const access = String(tokens.accessToken ?? "");
    if (!access) break;
    if (typeof tokens.refreshToken === "string" && tokens.refreshToken && tokens.refreshToken !== refresh) await secrets.set(secretKey(accountId), tokens.refreshToken);
    cache.set(accountId, { token: access, expires: expiryOf(access) });
    return access;
  }
  throw new CursorError(lastStatus ? `Cursor 没有给出新的访问令牌（HTTP ${lastStatus}）。` : "连不上 Cursor 的登录服务。", 502);
}

export async function forgetCursorAccount(secrets: SecretStore, accountId: string): Promise<void> {
  cache.delete(accountId);
  await secrets.delete(secretKey(accountId));
}

export function clearCursorCache(): void { cache.clear(); }
