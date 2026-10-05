import { execFile } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import { promisify } from "node:util";
import type { SecretStore } from "./secrets.ts";

const run = promisify(execFile);

/**
 * Sign in with ChatGPT, for a tool that runs on the user's own machine: OpenAI's documented way to
 * use the ChatGPT plan from a third-party open-source tool (developers.openai.com/siwc, "token
 * sharing for open-source apps"). It is an ordinary OAuth authorization-code flow with PKCE and a
 * client registered on the spot, a loopback callback on 127.0.0.1, and calls to the public Responses
 * API with the resulting access token. Written from that documentation.
 *
 * The tokens stay on this machine: the secret part (access, refresh and ID token) lives in the
 * Keychain, the rest (who, which client, expiry) in EasySwitch's own state file. They are sent only to
 * OpenAI's own hosts, and never logged.
 */

export function authBase(): string {
  return process.env.EASYSWITCH_OPENAI_AUTH ?? "https://auth.openai.com";
}

export function apiBase(): string {
  return process.env.EASYSWITCH_OPENAI_API ?? "https://api.openai.com/v1";
}

const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const PLAN_SCOPE = "chatgpt.tokens.use.direct";
const AGENT_NAME = "EasySwitch";

export interface SiwcAccount {
  id: string;
  /** What the user sees: their label, else the email. */
  label: string;
  email?: string;
  /** The validated identity (`sub` of the ID token). */
  subject: string;
  /** The client OpenAI issued for this registration; kept with this account only. */
  clientId: string;
  scopes: string[];
  /** When the current access token stops working, in ms since the epoch. */
  expiresAt: number;
  /** Whether the user allowed use of the ChatGPT plan (the plan scope was granted). */
  planUsage: boolean;
  /** Set when OpenAI refused a refresh for good: the user has to sign in again. */
  needsSignIn?: boolean;
}

/** Where account records live (the Store implements it; tests use a plain object). */
export interface SiwcStorage {
  /** A stable id for this machine, made once and kept. */
  hostId(): string;
  accounts(): SiwcAccount[];
  save(account: SiwcAccount): void;
  remove(id: string): void;
}

interface Tokens {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
}

export class SiwcError extends Error {
  readonly code: "signin_required" | "denied" | "not_eligible" | "network" | "invalid";
  constructor(code: SiwcError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const secretName = (id: string) => `siwc:${id}`;
const b64url = (buf: Buffer) => buf.toString("base64url");

// ---------------------------------------------------------------- ID token

interface Jwk { kid?: string; kty: string; alg?: string; [k: string]: unknown }
type Claims = { iss?: string; aud?: string | string[]; sub?: string; exp?: number; nonce?: string; email?: string };

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new SiwcError("network", `${url} answered ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Checks an ID token's signature against OpenAI's published keys, and its issuer, audience, expiry and nonce. */
export async function validateIdToken(idToken: string, clientId: string, nonce: string): Promise<Claims> {
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new SiwcError("invalid", "the ID token is malformed");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: string; kid?: string };
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Claims;
  const config = await getJson(`${authBase()}/.well-known/openid-configuration`);
  const jwks = (await getJson(String(config.jwks_uri))).keys as Jwk[];
  const jwk = jwks.find(k => (header.kid ? k.kid === header.kid : true) && k.kty === "RSA");
  if (header.alg !== "RS256" || !jwk) throw new SiwcError("invalid", "the ID token is not signed with a key OpenAI publishes");
  const ok = verify("RSA-SHA256", Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk as never, format: "jwk" }), Buffer.from(s, "base64url"));
  if (!ok) throw new SiwcError("invalid", "the ID token's signature does not match");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== config.issuer) throw new SiwcError("invalid", "the ID token comes from a different issuer");
  if (!aud.includes(clientId)) throw new SiwcError("invalid", "the ID token is for a different client");
  if (!claims.exp || claims.exp * 1000 < Date.now()) throw new SiwcError("invalid", "the ID token has expired");
  if (claims.nonce !== nonce) throw new SiwcError("invalid", "the ID token's nonce does not match this sign-in");
  if (!claims.sub) throw new SiwcError("invalid", "the ID token has no subject");
  return claims;
}

// ---------------------------------------------------------------- sign in

export interface SignIn {
  /** Where the browser has to go. */
  url: string;
  /** Resolves with the saved account once the user has finished in the browser. */
  done: Promise<SiwcAccount>;
  cancel(): void;
}

async function openInBrowser(url: string): Promise<void> {
  await run("open", [url]);
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => { throw new SiwcError("network", `OpenAI is unreachable: ${e.message}`); });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * Starts a sign-in: a loopback listener, then the browser. `existing` signs an account in again with
 * the client it was registered with (no new registration, and the browser skips the account picker).
 */
export async function beginSignIn(
  deps: { storage: SiwcStorage; secrets: SecretStore; open?: (url: string) => Promise<void> },
  opts: { label?: string; existingId?: string } = {},
): Promise<SignIn> {
  const existing = opts.existingId ? deps.storage.accounts().find(a => a.id === opts.existingId) : undefined;
  if (opts.existingId && !existing) throw new SiwcError("invalid", "no such account");
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  let finish!: (a: SiwcAccount) => void;
  let fail!: (e: Error) => void;
  const done = new Promise<SiwcAccount>((resolve, reject) => { finish = resolve; fail = reject; });
  done.catch(() => {});

  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
  const stop = () => { clearTimeout(timer); server.closeAllConnections(); server.close(); };
  const timer = setTimeout(() => { fail(new SiwcError("denied", "the sign-in was not finished in time")); stop(); }, 5 * 60_000);
  timer.unref();

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
    const page = (text: string) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>EasySwitch</title><body style="font:16px system-ui;padding:3rem">${text}</body>`);
    void (async () => {
      try {
        if (url.searchParams.get("state") !== state) throw new SiwcError("invalid", "the sign-in answer does not belong to this attempt");
        const error = url.searchParams.get("error");
        if (error) throw new SiwcError(error === "access_denied" ? "denied" : "invalid", error === "access_denied" ? "you did not allow EasySwitch to use your ChatGPT plan" : `OpenAI answered: ${error}`);
        const code = url.searchParams.get("code");
        const clientId = existing?.clientId ?? url.searchParams.get("client_id") ?? url.searchParams.get("clientId");
        if (!code || !clientId) throw new SiwcError("invalid", "the sign-in answer has no code or client");
        const token = await postForm(`${authBase()}/api/accounts/oauth/token`, {
          grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: apiBase(),
        });
        if (token.status !== 200) throw new SiwcError("invalid", `the code could not be exchanged (${String(token.json.error ?? token.status)})`);
        const tokens = token.json as unknown as Tokens & { expires_in?: number; scope?: string };
        if (!tokens.id_token || !tokens.access_token) throw new SiwcError("invalid", "OpenAI returned no tokens");
        const claims = await validateIdToken(tokens.id_token, clientId, nonce);
        if (existing && existing.subject !== claims.sub) throw new SiwcError("invalid", "this is a different ChatGPT account from the one being signed in again");
        const scopes = String(tokens.scope ?? url.searchParams.get("scope") ?? "").split(/[\s+]+/).filter(Boolean);
        const id = existing?.id ?? `s-${randomBytes(4).toString("hex")}`;
        const account: SiwcAccount = {
          id, subject: claims.sub!, clientId, scopes,
          label: opts.label?.trim() || existing?.label || claims.email || "ChatGPT",
          ...(claims.email ? { email: claims.email } : {}),
          expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          planUsage: scopes.includes(PLAN_SCOPE),
        };
        await deps.secrets.set(secretName(id), JSON.stringify({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, id_token: tokens.id_token } satisfies Tokens));
        deps.storage.save(account);
        page(account.planUsage ? "已登录。可以回到 EasySwitch 了，这个窗口可以关掉。" : "已登录，但你没有允许使用 ChatGPT 订阅额度。回到 EasySwitch 重新授权即可。");
        finish(account);
      } catch (error) {
        page(`没有登录成功：${String((error as Error).message)}。回到 EasySwitch 再试一次。`);
        fail(error as Error);
      } finally {
        stop();
      }
    })();
  });

  const params = new URLSearchParams({
    response_type: "code", redirect_uri: redirectUri, scope: SCOPES, resource: apiBase(),
    state, nonce, code_challenge_method: "S256", code_challenge: challenge,
    ext_agent_host_id: deps.storage.hostId(),
    ...(existing ? { client_id: existing.clientId, ...(existing.email ? { login_hint: existing.email } : {}) } : { client_id: "dynamic_agent_client", agent_name_hint: AGENT_NAME }),
  });
  const url = `${authBase()}/api/accounts/authorize?${params.toString()}`;
  void (deps.open ?? openInBrowser)(url).catch(error => { fail(new SiwcError("network", `could not open the browser: ${(error as Error).message}`)); stop(); });
  return { url, done, cancel: () => { fail(new SiwcError("denied", "cancelled")); stop(); } };
}

// ---------------------------------------------------------------- tokens

const refreshing = new Map<string, Promise<string>>();

async function readTokens(secrets: SecretStore, id: string): Promise<Tokens | undefined> {
  const raw = await secrets.get(secretName(id));
  if (!raw) return undefined;
  try { return JSON.parse(raw) as Tokens; } catch { return undefined; }
}

/**
 * A working access token for the account, renewed shortly before it ends. Renewal is serialised per
 * account: the refresh token rotates, so two renewals at once would sign the account out.
 */
export async function accessToken(deps: { storage: SiwcStorage; secrets: SecretStore }, id: string): Promise<string> {
  const account = deps.storage.accounts().find(a => a.id === id);
  if (!account) throw new SiwcError("signin_required", "this ChatGPT account is not signed in");
  if (!account.planUsage) throw new SiwcError("not_eligible", "ChatGPT plan use was not allowed for this account");
  const tokens = await readTokens(deps.secrets, id);
  if (!tokens) throw new SiwcError("signin_required", "this ChatGPT account has no saved login");
  if (account.expiresAt - Date.now() > 120_000 && !account.needsSignIn) return tokens.access_token;
  const running = refreshing.get(id);
  if (running) return running;
  const job = (async () => {
    try {
      if (!tokens.refresh_token) throw new SiwcError("signin_required", "the login cannot be renewed, sign in again");
      const res = await postForm(`${authBase()}/api/accounts/oauth/token`, {
        grant_type: "refresh_token", client_id: account.clientId, refresh_token: tokens.refresh_token, resource: apiBase(),
      });
      if (res.status !== 200) {
        const terminal = res.status === 400 || res.status === 401;
        if (terminal) deps.storage.save({ ...account, needsSignIn: true });
        throw new SiwcError(terminal ? "signin_required" : "network", terminal ? "OpenAI no longer accepts this login, sign in again" : `renewal failed (${res.status})`);
      }
      const next = res.json as unknown as Tokens & { expires_in?: number; scope?: string };
      // The access token, expiry, scopes and the rotated refresh token are replaced together.
      await deps.secrets.set(secretName(id), JSON.stringify({ access_token: next.access_token, refresh_token: next.refresh_token ?? tokens.refresh_token, id_token: next.id_token ?? tokens.id_token } satisfies Tokens));
      const scopes = next.scope ? next.scope.split(/\s+/).filter(Boolean) : account.scopes;
      deps.storage.save({ ...account, scopes, planUsage: scopes.includes(PLAN_SCOPE), expiresAt: Date.now() + (next.expires_in ?? 3600) * 1000, needsSignIn: false });
      return next.access_token;
    } finally {
      refreshing.delete(id);
    }
  })();
  refreshing.set(id, job);
  return job;
}

/** The models this account may use (`GET /v1/models`, entries meant for a picker). */
export async function listModels(token: string): Promise<Array<{ slug: string; name: string; efforts?: string[] }>> {
  const res = await fetch(`${apiBase()}/models`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) })
    .catch((e: Error) => { throw new SiwcError("network", `OpenAI is unreachable: ${e.message}`); });
  if (!res.ok) throw new SiwcError(res.status === 401 ? "signin_required" : res.status === 403 ? "not_eligible" : "network", `the model list answered ${res.status}`);
  const json = (await res.json()) as { models?: Array<{ slug?: string; display_name?: string; visibility?: string; supported_reasoning_levels?: Array<{ effort?: string }> }>; data?: Array<{ id?: string }> };
  const models = (json.models ?? []).filter(m => m.slug && (m.visibility ?? "list") === "list").map(m => {
    // The model's own thinking levels, as OpenAI lists them for this account.
    const efforts = (m.supported_reasoning_levels ?? []).map(l => String(l.effort ?? "")).filter(Boolean);
    return { slug: String(m.slug), name: m.display_name ?? String(m.slug), ...(efforts.length ? { efforts } : {}) };
  });
  return models.length ? models : (json.data ?? []).filter(m => m.id).map(m => ({ slug: String(m.id), name: String(m.id) }));
}

/** Ends the renewable session at OpenAI, then forgets the account here. */
export async function signOut(deps: { storage: SiwcStorage; secrets: SecretStore }, id: string): Promise<{ revoked: boolean }> {
  const account = deps.storage.accounts().find(a => a.id === id);
  const tokens = await readTokens(deps.secrets, id);
  let revoked = false;
  if (account && tokens?.refresh_token) {
    try {
      const config = await getJson(`${authBase()}/.well-known/openid-configuration`);
      const endpoint = String(config.revocation_endpoint ?? "");
      if (endpoint) {
        const res = await postForm(endpoint, { token: tokens.refresh_token, token_type_hint: "refresh_token", client_id: account.clientId });
        revoked = res.status === 200;
      }
    } catch {
      revoked = false;
    }
  }
  await deps.secrets.delete(secretName(id));
  deps.storage.remove(id);
  return { revoked };
}
