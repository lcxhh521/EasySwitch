// The sign-in and project discovery follow opencodex's Antigravity adapter (MIT), commit
// 5841269073b3898e5dd3ac9dcd956c7e56c1bb34 (src/oauth/google-antigravity.ts, src/adapters/google.ts); the request
// conversion is our own (gemini-upstream.ts). Copyright (c) 2026 opencodex contributors. See third_party/opencodex/LICENSE.
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  ANTIGRAVITY_API_VERSION, ANTIGRAVITY_CALLBACK_PORT, ANTIGRAVITY_CLIENT_ID, ANTIGRAVITY_CLIENT_SECRET, ANTIGRAVITY_SCOPES,
  antigravityEndpoints, antigravityUserAgent,
} from "./antigravity-client.ts";
import { conversationToGemini, GeminiUpstreamError, geminiToChatResponse } from "./gemini-upstream.ts";
import { isUsageLimit, recordLimitReached } from "./quota.ts";
import type { SecretStore } from "./secrets.ts";
import type { Provider } from "./types.ts";
import type { Conversation, InboundRequest } from "./protocol.ts";

/**
 * Google Antigravity (Cloud Code Assist) as a model source: a Google sign-in done in the user's browser, with the
 * refresh token kept in the secret store (the Keychain) and the access token renewed when it is about to end.
 * Cloud Code Assist speaks Gemini's API inside a small envelope; see gemini-upstream.ts for the body.
 */

export class AntigravityError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export interface AntigravityAccount { id: string; email: string; projectId: string }

const secretKey = (accountId: string) => `antigravity:${accountId}`;
const TIMEOUT_MS = 30_000;

type Json = Record<string, any>;

async function postToken(body: Record<string, string>): Promise<Json> {
  const response = await fetch(antigravityEndpoints().token, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  // Only the status is reported: the body can carry grant and account details.
  if (!response.ok) throw new AntigravityError(`Google 拒绝了登录请求（HTTP ${response.status}）。`, response.status === 400 || response.status === 401 ? 401 : 502);
  return (await response.json()) as Json;
}

function apiHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: "*/*", "content-type": "application/json", "user-agent": antigravityUserAgent() };
}

function projectIdOf(data: Json | undefined): string | undefined {
  if (!data) return undefined;
  for (const key of ["cloudaicompanionProject", "projectId", "project"]) {
    const value = data[key];
    if (typeof value === "string" && value) return value;
    if (value && typeof value === "object" && typeof value.id === "string") return value.id;
  }
  return undefined;
}

/** The Cloud Code Assist project of an account: looked up, or created for an account that has none yet. */
export async function discoverProject(token: string): Promise<string | undefined> {
  const { api, onboardApi } = antigravityEndpoints();
  const found = await fetch(`${api}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`, {
    method: "POST", headers: apiHeaders(token), body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }), signal: AbortSignal.timeout(TIMEOUT_MS),
  }).then(r => (r.ok ? (r.json() as Promise<Json>) : undefined)).catch(() => undefined);
  const existing = projectIdOf(found);
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${onboardApi}/${ANTIGRAVITY_API_VERSION}:onboardUser`, {
      method: "POST", headers: apiHeaders(token),
      body: JSON.stringify({ tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity" } }), signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => undefined);
    if (response?.ok) {
      const data = (await response.json().catch(() => ({}))) as Json;
      if (data.done === true) return projectIdOf(data.response);
    } else if (response && response.status !== 429 && response.status < 500) return undefined;
    await new Promise(r => setTimeout(r, process.env.EASYSWITCH_ANTIGRAVITY_POLL_MS ? Number(process.env.EASYSWITCH_ANTIGRAVITY_POLL_MS) : 2000));
  }
  return undefined;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function openInBrowser(url: string): Promise<void> {
  return new Promise(resolve => {
    if (process.platform !== "darwin") { resolve(); return; }
    execFile("open", [url], () => resolve());
  });
}

export interface SignIn { url: string; done: Promise<AntigravityAccount>; cancel: () => void }

/**
 * Starts the Google sign-in: a one-use page on this machine catches the redirect, the code is exchanged, the
 * account's project is found, and the refresh token goes to the secret store. Nothing else is kept.
 */
export async function beginAntigravitySignIn(deps: { secrets: SecretStore; open?: (url: string) => Promise<void>; timeoutMs?: number }): Promise<SignIn> {
  const { verifier, challenge } = pkce();
  const state = randomBytes(16).toString("hex");
  let server: Server | undefined;
  let settle!: { ok: (a: AntigravityAccount) => void; fail: (e: Error) => void };
  const done = new Promise<AntigravityAccount>((ok, fail) => { settle = { ok, fail }; });
  done.catch(() => undefined);
  const listen = (port: number) => new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => { server = s; resolve((s.address() as { port: number }).port); });
  });
  const port = await listen(ANTIGRAVITY_CALLBACK_PORT).catch(() => listen(0));
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const finish = () => { clearTimeout(timer); server?.closeAllConnections(); server?.close(); };
  const timer = setTimeout(() => { settle.fail(new AntigravityError("等待登录超时。", 408)); finish(); }, deps.timeoutMs ?? 5 * 60_000);
  server!.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const page = (text: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>EasySwitch</title><body style="font:16px system-ui;padding:48px">${text}</body>`);
    if (url.searchParams.get("state") !== state) { page("登录请求不匹配，请回到 EasySwitch 重新开始。"); return; }
    const code = url.searchParams.get("code");
    if (!code) { page("没有拿到授权码，请回到 EasySwitch 重新开始。"); settle.fail(new AntigravityError("登录被取消或没有授权。", 400)); finish(); return; }
    try {
      const tokens = await postToken({ grant_type: "authorization_code", client_id: ANTIGRAVITY_CLIENT_ID, client_secret: ANTIGRAVITY_CLIENT_SECRET, code, redirect_uri: redirectUri, code_verifier: verifier });
      const access = String(tokens.access_token ?? "");
      const refresh = String(tokens.refresh_token ?? "");
      if (!access || !refresh) throw new AntigravityError("Google 没有返回完整的登录信息。");
      const info = await fetch(antigravityEndpoints().userinfo, { headers: { authorization: `Bearer ${access}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) })
        .then(r => (r.ok ? (r.json() as Promise<Json>) : undefined)).catch(() => undefined);
      const email = typeof info?.email === "string" ? info.email.toLowerCase() : undefined;
      if (!email) throw new AntigravityError("没能确认是哪个 Google 账号。");
      const projectId = await discoverProject(access);
      if (!projectId) throw new AntigravityError("这个账号没有 Antigravity（Cloud Code Assist）的使用资格，或还没开通。");
      const id = email.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      await deps.secrets.set(secretKey(id), refresh);
      cache.set(id, { token: access, expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 });
      page("登录完成，可以回到 EasySwitch 了。");
      settle.ok({ id, email, projectId });
    } catch (error) {
      page("登录没有成功，请回到 EasySwitch 看原因。");
      settle.fail(error instanceof AntigravityError ? error : new AntigravityError("登录没有成功。"));
    }
    finish();
  });
  const params = new URLSearchParams({
    response_type: "code", client_id: ANTIGRAVITY_CLIENT_ID, redirect_uri: redirectUri, scope: ANTIGRAVITY_SCOPES.join(" "),
    code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent select_account", state,
  });
  const url = `${antigravityEndpoints().auth}?${params}`;
  await (deps.open ?? openInBrowser)(url).catch(() => undefined);
  return { url, done, cancel: () => { settle.fail(new AntigravityError("已取消。", 499)); finish(); } };
}

const cache = new Map<string, { token: string; expires: number }>();

/** The account's access token, renewed from the refresh token when it is about to end. */
export async function antigravityAccessToken(secrets: SecretStore, accountId: string): Promise<string> {
  const have = cache.get(accountId);
  if (have && have.expires - Date.now() > 60_000) return have.token;
  const refresh = await secrets.get(secretKey(accountId));
  if (!refresh) throw new AntigravityError("这个 Antigravity 账号的登录信息不见了，请重新登录。", 401);
  const tokens = await postToken({ grant_type: "refresh_token", client_id: ANTIGRAVITY_CLIENT_ID, client_secret: ANTIGRAVITY_CLIENT_SECRET, refresh_token: refresh });
  const token = String(tokens.access_token ?? "");
  if (!token) throw new AntigravityError("Google 没有返回新的访问令牌，请重新登录。", 401);
  cache.set(accountId, { token, expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 });
  return token;
}

export async function forgetAntigravityAccount(secrets: SecretStore, accountId: string): Promise<void> {
  cache.delete(accountId);
  await secrets.delete(secretKey(accountId));
}

export function clearAntigravityCache(): void { cache.clear(); }

/** The models the account can use. The shape is read leniently: a map by id, or a list. */
export async function listAntigravityModels(token: string, projectId?: string): Promise<string[]> {
  const response = await fetch(`${antigravityEndpoints().api}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`, {
    method: "POST", headers: apiHeaders(token), body: JSON.stringify(projectId ? { project: projectId } : {}), signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) { await response.body?.cancel(); throw new AntigravityError(`Antigravity 返回 HTTP ${response.status}，没能取到模型列表。`, response.status === 401 || response.status === 403 ? 401 : 502); }
  const body = (await response.json()) as Json;
  const raw = body.models;
  const entries: Array<[string, Json]> = Array.isArray(raw) ? raw.map((m: Json) => [String(m.id ?? m.name ?? m.model ?? ""), m] as [string, Json]) : Object.entries(raw ?? {}) as Array<[string, Json]>;
  const ids = entries.filter(([id, m]) => id && !/^(chat|tab|rev|internal)[_-]/i.test(id) && m?.isInternal !== true).map(([id]) => id.replace(/^models\//, ""));
  const unique = [...new Set(ids)];
  if (!unique.length) throw new AntigravityError("Antigravity 没有返回可用模型，请检查账号的使用资格。");
  return unique;
}

export async function sendAntigravityConversation(provider: Provider, token: string | undefined, conversation: Conversation, request: InboundRequest, signal: AbortSignal): Promise<Response> {
  const fail = (message: string, status: number) => Response.json({ error: { type: "antigravity_error", message } }, { status });
  try {
    if (!token) return fail("没有拿到 Antigravity 的登录，请回到 EasySwitch 重新登录。", 401);
    const info = provider.antigravity;
    if (!info?.projectId) return fail("这个来源缺少 Cloud Code Assist 项目，请重新登录一次。", 409);
    const prepared = conversationToGemini(conversation, request);
    const envelope = { model: request.model, userAgent: "antigravity", requestType: "agent", project: info.projectId, requestId: `agent-${randomUUID()}`, request: { ...prepared.body, sessionId: `-${Math.floor(Math.random() * 9e18)}` } };
    const upstream = await fetch(`${antigravityEndpoints().api}/${ANTIGRAVITY_API_VERSION}:streamGenerateContent?alt=sse`, {
      method: "POST", redirect: "error", headers: apiHeaders(token), body: JSON.stringify(envelope), signal,
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      if (isUsageLimit(upstream.status, text)) recordLimitReached(provider.id);
      const detail = upstream.status === 401 || upstream.status === 403 ? "请重新登录，或检查这个账号的 Antigravity 使用资格。"
        : upstream.status === 429 ? "额度不足或请求过于频繁，请稍后重试。" : "请稍后重试。";
      return fail(`Antigravity 返回 HTTP ${upstream.status}；${detail}`, upstream.status >= 400 ? upstream.status : 502);
    }
    return await geminiToChatResponse(upstream, { stream: request.stream, model: request.model, restoreName: prepared.restoreName });
  } catch (error) {
    if (error instanceof GeminiUpstreamError || error instanceof AntigravityError) return fail(error.message, error.status);
    return fail("Antigravity 请求失败，请检查网络或稍后重试。", 502);
  }
}
