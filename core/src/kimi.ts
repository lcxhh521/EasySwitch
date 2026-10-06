import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { release } from "node:os";
import type { SecretStore } from "./secrets.ts";

/**
 * Kimi Code (Moonshot's coding plan) with the person's own sign-in: a device-code login at auth.kimi.com, then the
 * access token is used as the bearer on Kimi's OpenAI-compatible coding endpoint. Kimi lets its members use that
 * endpoint from other tools. The refresh token is kept in the secret store (the Keychain); the access token only in
 * memory. The sign-in identifies itself the way Kimi's own command-line tool does, which Kimi's auth host expects.
 *
 * The endpoints and headers come from reading opencodex's Kimi sign-in (MIT); not checked against a live account.
 */

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const authHost = () => process.env.EASYSWITCH_KIMI_AUTH ?? "https://auth.kimi.com";
export const kimiApi = () => process.env.EASYSWITCH_KIMI_API ?? "https://api.kimi.com/coding/v1";
const TOKEN_KEY = (id: string) => `kimi:${id}`;
const DEVICE_KEY = "kimi-device-id";

export class KimiError extends Error {
  status: number;
  auth: boolean;
  constructor(message: string, status = 502, auth = false) { super(message); this.status = status; this.auth = auth; }
}

export interface KimiAccount { id: string; email?: string }
type Json = Record<string, any>;

/** The identity headers: they say which kind of client this is and name this machine by a random id, nothing personal. */
export async function kimiHeaders(secrets: SecretStore): Promise<Record<string, string>> {
  let device = await secrets.get(DEVICE_KEY);
  if (!device || !/^[0-9a-f]{32}$/.test(device)) { device = randomBytes(16).toString("hex"); await secrets.set(DEVICE_KEY, device); }
  return {
    "user-agent": "KimiCLI/0.14.0", "x-msh-platform": "kimi_code_cli", "x-msh-version": "0.14.0",
    "x-msh-device-name": "EasySwitch", "x-msh-device-model": process.platform === "darwin" ? "macOS" : process.platform,
    "x-msh-os-version": release(), "x-msh-device-id": device,
  };
}


function claims(token: string): Json {
  try { return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Json; } catch { return {}; }
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "kimi";

export function kimiAccountOf(accessToken: string): KimiAccount {
  const c = claims(accessToken);
  const email = typeof c.email === "string" ? c.email.toLowerCase() : undefined;
  const who = email ?? (typeof c.user_id === "string" ? c.user_id : typeof c.sub === "string" ? c.sub : randomBytes(4).toString("hex"));
  return { id: slug(who), ...(email ? { email } : {}) };
}

const expiryOf = (token: string): number => {
  const exp = Number(claims(token).exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 - 60_000 : Date.now() + 15 * 60_000;
};

const cache = new Map<string, { token: string; expires: number }>();

async function postForm(path: string, form: Record<string, string>, secrets: SecretStore): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${authHost()}${path}`, {
    method: "POST", headers: { ...(await kimiHeaders(secrets)), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Json };
}

function openInBrowser(url: string): Promise<void> {
  return new Promise(resolve => { if (process.platform !== "darwin") { resolve(); return; } execFile("open", [url], () => resolve()); });
}

export interface KimiSignIn { url: string; userCode: string; done: Promise<KimiAccount>; cancel: () => void }

export async function beginKimiSignIn(deps: { secrets: SecretStore; open?: (url: string) => Promise<void>; pollMs?: number }): Promise<KimiSignIn> {
  const start = await postForm("/api/oauth/device_authorization", { client_id: KIMI_CLIENT_ID }, deps.secrets).catch(() => undefined);
  const info = start?.body ?? {};
  const deviceCode = String(info.device_code ?? ""); const userCode = String(info.user_code ?? "");
  const url = String(info.verification_uri_complete ?? info.verification_uri ?? "");
  if (!start || start.status !== 200 || !deviceCode || !url) throw new KimiError("没能向 Kimi 申请登录码，请检查网络后重试。");
  let cancelled = false;
  const done = (async (): Promise<KimiAccount> => {
    const until = Date.now() + (Number(info.expires_in) || 600) * 1000;
    let wait = deps.pollMs ?? (Number(info.interval) || 5) * 1000;
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, wait));
      if (cancelled) throw new KimiError("已取消。", 499);
      const { status, body } = await postForm("/api/oauth/token", { client_id: KIMI_CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }, deps.secrets).catch(() => ({ status: 0, body: {} as Json }));
      if (status === 200 && body.access_token) {
        const access = String(body.access_token); const refresh = String(body.refresh_token ?? "");
        if (!refresh) throw new KimiError("Kimi 没有返回完整的登录信息。");
        const account = kimiAccountOf(access);
        await deps.secrets.set(TOKEN_KEY(account.id), refresh);
        cache.set(account.id, { token: access, expires: expiryOf(access) });
        return account;
      }
      const error = String(body.error ?? "");
      if (error === "slow_down") wait += 5000;
      else if (error === "access_denied") throw new KimiError("登录被拒绝了。", 401, true);
      else if (error === "expired_token") break;
      else if (error && error !== "authorization_pending" && status !== 0) throw new KimiError(`Kimi 的登录服务返回了错误（${error}）。`);
    }
    throw new KimiError("等待登录超时。", 408);
  })();
  done.catch(() => undefined);
  await (deps.open ?? openInBrowser)(url).catch(() => undefined);
  return { url, userCode, done, cancel: () => { cancelled = true; } };
}

/** The account's access token, renewed from the refresh token when it is about to end. */
export async function kimiAccessToken(secrets: SecretStore, accountId: string): Promise<string> {
  const have = cache.get(accountId);
  if (have && have.expires - Date.now() > 0) return have.token;
  const refresh = await secrets.get(TOKEN_KEY(accountId));
  if (!refresh) throw new KimiError("这个 Kimi 账号的登录信息不见了，请重新登录。", 401, true);
  let result: { status: number; body: Json } | undefined;
  try { result = await postForm("/api/oauth/token", { client_id: KIMI_CLIENT_ID, grant_type: "refresh_token", refresh_token: refresh }, secrets); }
  catch { throw new KimiError("连不上 Kimi 的登录服务。"); }
  if (result.status === 401 || result.status === 403 || (result.status === 400 && /invalid_grant|expired/.test(String(result.body.error ?? ""))))
    throw new KimiError("Kimi 的登录已过期，请重新登录。", 401, true);
  const access = String(result.body.access_token ?? "");
  if (result.status !== 200 || !access) throw new KimiError(`Kimi 没有给出新的访问令牌（HTTP ${result.status}）。`);
  if (typeof result.body.refresh_token === "string" && result.body.refresh_token && result.body.refresh_token !== refresh) await secrets.set(TOKEN_KEY(accountId), result.body.refresh_token);
  cache.set(accountId, { token: access, expires: expiryOf(access) });
  return access;
}

export async function forgetKimiAccount(secrets: SecretStore, accountId: string): Promise<void> {
  cache.delete(accountId);
  await secrets.delete(TOKEN_KEY(accountId));
}

export function clearKimiCache(): void { cache.clear(); }

/** The models the account can use. */
export async function listKimiModels(token: string, secrets: SecretStore): Promise<string[]> {
  const response = await fetch(`${kimiApi()}/models`, { headers: { ...(await kimiHeaders(secrets)), authorization: `Bearer ${token}`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) { await response.body?.cancel(); throw new KimiError(`Kimi 返回 HTTP ${response.status}，没能取到模型列表。`, response.status === 401 || response.status === 403 ? 401 : 502, response.status === 401); }
  const body = (await response.json().catch(() => ({}))) as Json;
  const ids = (Array.isArray(body.data) ? (body.data as Json[]) : []).map(m => String(m.id ?? "")).filter(Boolean);
  if (!ids.length) throw new KimiError("Kimi 没有返回可用模型，请检查会员是否有效。");
  return [...new Set(ids)];
}
