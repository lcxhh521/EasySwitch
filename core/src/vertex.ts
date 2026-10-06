import { createHash, createSign } from "node:crypto";
import type { SecretStore } from "./secrets.ts";
import type { Provider } from "./types.ts";
import { vertexKind, vertexProjectLocationIssue } from "./vertex-config.ts";
export { vertexConfigIssue, vertexKind, type VertexConfig } from "./vertex-config.ts";

/**
 * Preserved service-account Vertex Chat authentication from dev af91f97, with destination,
 * redirect, cache-identity and validation hardening. See vertex-gemini.ts for the distinct
 * supplied-token/Express Gemini routes. This module never discovers native credentials.
 */
export class VertexError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface ServiceAccount { client_email: string; private_key: string; token_uri?: string; project_id?: string }
const secretKey = (providerId: string) => `vertex:${providerId}`;
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const OAUTH_ENDPOINTS = new Set(["https://oauth2.googleapis.com/token", "https://accounts.google.com/o/oauth2/token"]);

/** A test flag can enable only literal-loopback fixtures, never another real credential recipient. */
function fixtureUrl(name: "EASYSWITCH_VERTEX_TOKEN_URI" | "EASYSWITCH_VERTEX_API"): string | undefined {
  const override = process.env[name];
  if (!override) return undefined;
  try {
    const url = new URL(override);
    if (process.env.EASYSWITCH_TEST_VERTEX_FIXTURES !== "1" || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.hash || url.search || (name === "EASYSWITCH_VERTEX_API" && url.pathname !== "/")) throw new Error();
    return url.toString().replace(/\/$/, "");
  } catch { throw new VertexError("Vertex 测试地址覆盖仅允许显式开启的本地环回夹具；凭据不会发往其他地址。"); }
}

function tokenUri(sa: ServiceAccount): string {
  // Validate the account's own audience even when a fixture replaces transport.
  const uri = sa.token_uri || "https://oauth2.googleapis.com/token";
  if (!OAUTH_ENDPOINTS.has(uri)) throw new VertexError("服务账号文件里的 token_uri 不是受支持的 Google HTTPS 令牌地址，已拒绝。");
  return fixtureUrl("EASYSWITCH_VERTEX_TOKEN_URI") ?? uri;
}

export function parseServiceAccount(text: string | object): ServiceAccount {
  let value: unknown;
  try {
    if (typeof text === "string" && text.length > 1024 * 1024) throw new Error();
    value = typeof text === "string" ? JSON.parse(text) : text;
  } catch { throw new VertexError("服务账号文件不是有效的 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VertexError("服务账号文件必须是 JSON 对象。");
  const data = value as Record<string, unknown>;
  if (data.type !== undefined && data.type !== "service_account") throw new VertexError("这不是服务账号密钥文件，不能替代手动令牌或 Express Key。");
  const email = data.client_email, key = data.private_key;
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new VertexError("服务账号文件里没有有效的 client_email。");
  if (typeof key !== "string" || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new VertexError("服务账号文件里没有 private_key。");
  if (data.token_uri !== undefined && typeof data.token_uri !== "string") throw new VertexError("服务账号文件里的 token_uri 无效。");
  return { client_email: email, private_key: key, ...(typeof data.token_uri === "string" ? { token_uri: data.token_uri } : {}), ...(typeof data.project_id === "string" ? { project_id: data.project_id } : {}) };
}

/** Fixed validated Chat-compatible endpoint. Gemini native modes must not use this helper. */
export function vertexBaseUrl(project: string, location: string): string {
  const issue = vertexProjectLocationIssue(project, location);
  if (issue) throw new VertexError(issue);
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  const root = fixtureUrl("EASYSWITCH_VERTEX_API") ?? `https://${host}`;
  return `${root}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}
export const DEFAULT_VERTEX_MODELS = ["google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.0-flash-001"];

const cache = new Map<string, { identity: string; token: string; expires: number }>();
const running = new Map<string, Promise<string>>();
let generation = 0;
const identityFor = (sa: ServiceAccount, audience: string) => createHash("sha256").update(JSON.stringify([sa.client_email, sa.private_key, audience])).digest("hex");

function signedAssertion(sa: ServiceAccount, audience: string, now: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" });
  const iat = Math.floor(now / 1000);
  const claims = b64({ iss: sa.client_email, scope: SCOPE, aud: audience, iat, exp: iat + 3600 });
  let signature: string;
  try { signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key, "base64url"); }
  catch { throw new VertexError("服务账号的 private_key 不能用来签名，请检查密钥文件。"); }
  return `${head}.${claims}.${signature}`;
}

/** Cache lookup is always after audience validation, and bound to the exact supplied identity. */
export async function mintAccessToken(providerKey: string, account: ServiceAccount): Promise<string> {
  const sa = parseServiceAccount(account);
  const uri = tokenUri(sa);
  const identity = identityFor(sa, uri);
  const have = cache.get(providerKey);
  if (have?.identity === identity && have.expires - Date.now() > 60_000) return have.token;
  const jobKey = `${generation}:${providerKey}:${identity}`;
  const existing = running.get(jobKey);
  if (existing) return existing;
  const epoch = generation;
  const job = (async () => {
    const assertion = signedAssertion(sa, uri, Date.now());
    let response: Response;
    try {
      response = await fetch(uri, {
        method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new VertexError("Google 令牌请求未完成，请检查网络；不会跟随重定向。", 502); }
    if (!response.ok) throw new VertexError(`Google 没有接受这个服务账号（HTTP ${response.status}）：请检查密钥是否有效、没被停用。`, response.status === 400 || response.status === 401 ? 401 : 502);
    let body: { access_token?: unknown; expires_in?: unknown };
    try { body = await response.json(); } catch { throw new VertexError("Google 返回的令牌响应格式无效。", 502); }
    if (!body || typeof body.access_token !== "string" || !body.access_token || /\s/.test(body.access_token) || body.access_token.length > 16_384) throw new VertexError("Google 没有返回有效访问令牌。", 502);
    const ttl = body.expires_in === undefined ? 3600 : Number(body.expires_in);
    if (!Number.isFinite(ttl) || ttl <= 0) throw new VertexError("Google 返回的令牌有效期无效。", 502);
    if (epoch === generation) cache.set(providerKey, { identity, token: body.access_token, expires: Date.now() + Math.min(ttl, 3600) * 1000 });
    return body.access_token;
  })();
  running.set(jobKey, job);
  try { return await job; } finally { if (running.get(jobKey) === job) running.delete(jobKey); }
}

export async function vertexAccessToken(secrets: SecretStore, provider: Provider): Promise<string> {
  if (vertexKind(provider.vertex) !== "service-account") throw new VertexError("只有服务账号模式可以读取 Vertex 服务账号密钥。", 400);
  const stored = await secrets.get(secretKey(provider.id));
  if (!stored) throw new VertexError("这个 Vertex 来源的服务账号密钥不见了，请重新提供相同模式的凭据。", 401);
  const sa = parseServiceAccount(stored);
  if ("clientEmail" in provider.vertex! && provider.vertex.clientEmail !== sa.client_email) throw new VertexError("来源与所存服务账号身份不一致；不会自动更换账号。", 401);
  return mintAccessToken(provider.id, sa);
}

export async function storeServiceAccount(secrets: SecretStore, providerId: string, account: ServiceAccount): Promise<void> {
  const sa = parseServiceAccount(account);
  const identity = identityFor(sa, tokenUri(sa));
  if (cache.get(providerId)?.identity !== identity) { cache.delete(providerId); generation++; }
  await secrets.set(secretKey(providerId), JSON.stringify(sa));
}
export async function forgetServiceAccount(secrets: SecretStore, providerId: string): Promise<void> {
  generation++; cache.delete(providerId);
  await secrets.delete(secretKey(providerId));
}
export function clearVertexCache(): void { generation++; cache.clear(); running.clear(); }
