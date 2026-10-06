// The sign-in and project discovery follow opencodex's Antigravity adapter (MIT), commit
// 5841269073b3898e5dd3ac9dcd956c7e56c1bb34 (src/oauth/google-antigravity.ts, src/adapters/google.ts); the request
// conversion is our own (gemini-upstream.ts). Copyright (c) 2026 opencodex contributors. See third_party/opencodex/LICENSE.
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import {
  ANTIGRAVITY_API_VERSION, ANTIGRAVITY_CALLBACK_PORT, ANTIGRAVITY_SCOPES,
  antigravityClientCredentials, AntigravityClientError, type AntigravityClientCredentials,
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
// Serialize only owned account writes. A cancelled old login must not undo a newer login/delete.
const accountWrites = new Map<string, Promise<unknown>>();
const accountEpochs = new Map<string, number>();
const accountRemovals = new Map<string, number>();
const epochOf = (id: string) => accountEpochs.get(id) ?? 0;
const advanceEpoch = (id: string) => accountEpochs.set(id, epochOf(id) + 1);
async function withAccountWrite<T>(id: string, run: () => Promise<T>): Promise<T> {
  const previous = accountWrites.get(id) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  accountWrites.set(id, next);
  try { return await next; } finally { if (accountWrites.get(id) === next) accountWrites.delete(id); }
}

type Json = Record<string, any>;

async function postToken(body: Record<string, string>, tokenEndpoint = antigravityEndpoints().token, signal?: AbortSignal): Promise<Json> {
  const response = await fetch(tokenEndpoint, {
    method: "POST", redirect: "error",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
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
export async function discoverProject(token: string, signal?: AbortSignal): Promise<string | undefined> {
  signal?.throwIfAborted();
  const requestSignal = () => signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  const { api, onboardApi } = antigravityEndpoints();
  const found = await fetch(`${api}/${ANTIGRAVITY_API_VERSION}:loadCodeAssist`, {
    method: "POST", redirect: "error", headers: apiHeaders(token), body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }), signal: requestSignal(),
  }).then(r => (r.ok ? (r.json() as Promise<Json>) : undefined)).catch(() => undefined);
  signal?.throwIfAborted();
  const existing = projectIdOf(found);
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt++) {
    signal?.throwIfAborted();
    const response = await fetch(`${onboardApi}/${ANTIGRAVITY_API_VERSION}:onboardUser`, {
      method: "POST", redirect: "error", headers: apiHeaders(token),
      body: JSON.stringify({ tier_id: "free-tier", metadata: { ide_type: "ANTIGRAVITY", ide_name: "antigravity" } }), signal: requestSignal(),
    }).catch(() => undefined);
    signal?.throwIfAborted();
    if (response?.ok) {
      const data = (await response.json().catch(() => ({}))) as Json;
      if (data.done === true) return projectIdOf(data.response);
    } else if (response && response.status !== 429 && response.status < 500) return undefined;
    await new Promise<void>((resolve, reject) => {
      const delay = setTimeout(done, process.env.NODE_TEST_CONTEXT && process.env.EASYSWITCH_TEST_ANTIGRAVITY_FIXTURES === "1" ? 1 : 2000);
      function done() { signal?.removeEventListener("abort", aborted); resolve(); }
      function aborted() { clearTimeout(delay); signal?.removeEventListener("abort", aborted); reject(new DOMException("Cancelled", "AbortError")); }
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    });
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
export async function beginAntigravitySignIn(deps: { secrets: SecretStore; open?: (url: string) => Promise<void>; timeoutMs?: number; client?: () => AntigravityClientCredentials }): Promise<SignIn> {
  const endpoints = antigravityEndpoints();
  const client = (deps.client ?? antigravityClientCredentials)();
  const identity = clientIdentity(client);
  const controller = new AbortController();
  let finished = false, callbackStarted = false, pendingCommit = false;
  let cancelled: AntigravityError | undefined;
  const ensureActive = () => { if (finished) throw new AntigravityError("登录已经结束，请重新开始。", 499); controller.signal.throwIfAborted(); };
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
  const finish = () => { finished = true; controller.abort(); clearTimeout(timer); server?.closeAllConnections(); server?.close(); };
  const cancel = (error: AntigravityError) => {
    if (finished) return;
    cancelled = error;
    finish();
    // A started credential write is not cancellable. Wait for its serialized rollback before reporting cancellation.
    if (!pendingCommit) settle.fail(error);
  };
  const timer = setTimeout(() => cancel(new AntigravityError("等待登录超时。", 408)), deps.timeoutMs ?? 5 * 60_000);
  server!.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
    const page = (text: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>EasySwitch</title><body style="font:16px system-ui;padding:48px">${text}</body>`);
    if (url.searchParams.get("state") !== state) { page("登录请求不匹配，请回到 EasySwitch 重新开始。"); return; }
    if (finished || callbackStarted) { res.writeHead(409).end("登录请求已处理"); return; }
    callbackStarted = true;
    const code = url.searchParams.get("code");
    if (!code) { page("没有拿到授权码，请回到 EasySwitch 重新开始。"); settle.fail(new AntigravityError("登录被取消或没有授权。", 400)); finish(); return; }
    try {
      const tokens = await postToken({ grant_type: "authorization_code", client_id: client.clientId, client_secret: client.clientSecret, code, redirect_uri: redirectUri, code_verifier: verifier }, endpoints.token, controller.signal);
      ensureActive();
      const access = String(tokens.access_token ?? "");
      const refresh = String(tokens.refresh_token ?? "");
      if (!access || !refresh) throw new AntigravityError("Google 没有返回完整的登录信息。");
      const info = await fetch(endpoints.userinfo, { redirect: "error", headers: { authorization: `Bearer ${access}`, accept: "application/json" }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(TIMEOUT_MS)]) })
        .then(r => (r.ok ? (r.json() as Promise<Json>) : undefined)).catch(() => undefined);
      ensureActive();
      const email = typeof info?.email === "string" ? info.email.toLowerCase() : undefined;
      if (!email) throw new AntigravityError("没能确认是哪个 Google 账号。");
      const projectId = await discoverProject(access, controller.signal);
      ensureActive();
      if (!projectId) throw new AntigravityError("这个账号没有 Antigravity（Cloud Code Assist）的使用资格，或还没开通。");
      const id = email.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      await withAccountWrite(id, async () => {
        ensureActive();
        const key = secretKey(id);
        const previous = await deps.secrets.get(key);
        ensureActive();
        pendingCommit = true;
        try {
          await deps.secrets.set(key, refresh);
          ensureActive();
        } catch (error) {
          // Restore only the value written by this attempt while all owned mutations are serialized.
          try {
            if (await deps.secrets.get(key) === refresh) {
              if (previous === undefined) await deps.secrets.delete(key);
              else await deps.secrets.set(key, previous);
            }
          } catch { throw new AntigravityError("登录未完成，凭据恢复也未能确认。请检查本机密钥存储后重新登录。", 503); }
          throw cancelled ?? error;
        } finally { pendingCommit = false; }
      });
      ensureActive();
      advanceEpoch(id);
      cache.set(id, { token: access, identity, expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 });
      page("登录完成，可以回到 EasySwitch 了。");
      settle.ok({ id, email, projectId });
    } catch (error) {
      page("登录没有成功，请回到 EasySwitch 看原因。");
      settle.fail(error instanceof AntigravityError ? error : new AntigravityError("登录没有成功。"));
    }
    finish();
  });
  const params = new URLSearchParams({
    response_type: "code", client_id: client.clientId, redirect_uri: redirectUri, scope: ANTIGRAVITY_SCOPES.join(" "),
    code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent select_account", state,
  });
  const url = `${endpoints.auth}?${params}`;
  await (deps.open ?? openInBrowser)(url).catch(() => undefined);
  return { url, done, cancel: () => cancel(new AntigravityError("已取消。", 499)) };
}

const cache = new Map<string, { token: string; expires: number; identity: string }>();
const clientIdentity = (client: AntigravityClientCredentials) => createHash("sha256").update(JSON.stringify([client.clientId, client.clientSecret])).digest("hex");

/** The account's access token, renewed from the refresh token when it is about to end. */
export async function antigravityAccessToken(secrets: SecretStore, accountId: string): Promise<string> {
  const endpoints = antigravityEndpoints();
  const client = antigravityClientCredentials();
  const identity = clientIdentity(client);
  const epoch = epochOf(accountId);
  const ensureCurrent = () => { if (accountRemovals.has(accountId) || epochOf(accountId) !== epoch) throw new AntigravityError("这个 Antigravity 账号的登录已变更，请重新登录。", 401); };
  ensureCurrent();
  const have = cache.get(accountId);
  if (have && have.identity === identity && have.expires - Date.now() > 60_000) return have.token;
  const refresh = await secrets.get(secretKey(accountId));
  ensureCurrent();
  if (!refresh) throw new AntigravityError("这个 Antigravity 账号的登录信息不见了，请重新登录。", 401);
  const tokens = await postToken({ grant_type: "refresh_token", client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refresh }, endpoints.token);
  ensureCurrent();
  const token = String(tokens.access_token ?? "");
  if (!token) throw new AntigravityError("Google 没有返回新的访问令牌，请重新登录。", 401);
  cache.set(accountId, { token, identity, expires: Date.now() + (Number(tokens.expires_in) || 3600) * 1000 });
  return token;
}

export async function forgetAntigravityAccount(secrets: SecretStore, accountId: string): Promise<void> {
  advanceEpoch(accountId);
  accountRemovals.set(accountId, (accountRemovals.get(accountId) ?? 0) + 1);
  cache.delete(accountId);
  try { await withAccountWrite(accountId, () => secrets.delete(secretKey(accountId))); }
  finally {
    const remaining = (accountRemovals.get(accountId) ?? 1) - 1;
    if (remaining) accountRemovals.set(accountId, remaining); else accountRemovals.delete(accountId);
    cache.delete(accountId);
  }
}

export function clearAntigravityCache(): void { cache.clear(); }

/** The models the account can use. The shape is read leniently: a map by id, or a list. */
export async function listAntigravityModels(token: string, projectId?: string): Promise<string[]> {
  const response = await fetch(`${antigravityEndpoints().api}/${ANTIGRAVITY_API_VERSION}:fetchAvailableModels`, {
    method: "POST", redirect: "error", headers: apiHeaders(token), body: JSON.stringify(projectId ? { project: projectId } : {}), signal: AbortSignal.timeout(TIMEOUT_MS),
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
    if (error instanceof GeminiUpstreamError || error instanceof AntigravityError || error instanceof AntigravityClientError) return fail(error.message, error.status);
    return fail("Antigravity 请求失败，请检查网络或稍后重试。", 502);
  }
}
