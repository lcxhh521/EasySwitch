import { createSign } from "node:crypto";
import type { SecretStore } from "./secrets.ts";
import type { Provider } from "./types.ts";

/**
 * Google Vertex AI as a model source. Vertex has an OpenAI-compatible endpoint, so requests go out as ordinary Chat
 * requests; what is special is the sign-in: a service-account key (kept in the secret store, never on disk or in
 * what the console shows) is turned into a short-lived access token by signing a JWT, and the token is renewed
 * before it ends.
 */

export class VertexError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export interface ServiceAccount { client_email: string; private_key: string; token_uri?: string; project_id?: string }

const secretKey = (providerId: string) => `vertex:${providerId}`;
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** The token endpoint a key names. Only Google's own is accepted: the signed assertion must not go anywhere else. */
function tokenUri(sa: ServiceAccount): string {
  const override = process.env.EASYSWITCH_VERTEX_TOKEN_URI;
  if (override) return override;
  const uri = sa.token_uri || "https://oauth2.googleapis.com/token";
  let host: string;
  try { const u = new URL(uri); if (u.protocol !== "https:") throw new Error("not https"); host = u.hostname; }
  catch { throw new VertexError("服务账号文件里的 token_uri 不是有效的 https 地址。"); }
  if (host !== "oauth2.googleapis.com" && host !== "accounts.google.com" && !host.endsWith(".googleapis.com")) throw new VertexError("服务账号文件里的 token_uri 不是 Google 的地址，已拒绝（签名凭证不会发给别处）。");
  return uri;
}

export function parseServiceAccount(text: string | object): ServiceAccount {
  let data: Record<string, unknown>;
  try { data = (typeof text === "string" ? JSON.parse(text) : text) as Record<string, unknown>; }
  catch { throw new VertexError("服务账号文件不是有效的 JSON。"); }
  const email = data.client_email;
  const key = data.private_key;
  if (typeof email !== "string" || !email.includes("@")) throw new VertexError("服务账号文件里没有 client_email。");
  if (typeof key !== "string" || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new VertexError("服务账号文件里没有 private_key。");
  return { client_email: email, private_key: key, ...(typeof data.token_uri === "string" ? { token_uri: data.token_uri } : {}), ...(typeof data.project_id === "string" ? { project_id: data.project_id } : {}) };
}

/** The OpenAI-compatible endpoint of a project in a location (`global` has no region in the host). */
export function vertexBaseUrl(project: string, location: string): string {
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  const root = process.env.EASYSWITCH_VERTEX_API ?? `https://${host}`;
  return `${root.replace(/\/+$/, "")}/v1/projects/${project}/locations/${location}/endpoints/openapi`;
}

export const DEFAULT_VERTEX_MODELS = ["google/gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.0-flash-001"];

const cache = new Map<string, { token: string; expires: number }>();

function signedAssertion(sa: ServiceAccount, audience: string, now: number): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = b64({ alg: "RS256", typ: "JWT" });
  const iat = Math.floor(now / 1000);
  const claims = b64({ iss: sa.client_email, scope: SCOPE, aud: audience, iat, exp: iat + 3600 });
  let signature: string;
  try { signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(sa.private_key, "base64url"); }
  catch { throw new VertexError("服务账号的 private_key 不能用来签名，请重新下载一份密钥文件。"); }
  return `${head}.${claims}.${signature}`;
}

/** An access token for the key, minted from the key and cached until a minute before it ends. */
export async function mintAccessToken(providerKey: string, sa: ServiceAccount): Promise<string> {
  const have = cache.get(providerKey);
  if (have && have.expires - Date.now() > 60_000) return have.token;
  const uri = tokenUri(sa);
  const response = await fetch(uri, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(sa, uri, Date.now()) }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  // Only the status is reported: the body can carry details of the account.
  if (!response.ok) throw new VertexError(`Google 没有接受这个服务账号（HTTP ${response.status}）：请检查密钥是否有效、没被停用。`, response.status === 400 || response.status === 401 ? 401 : 502);
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new VertexError("Google 没有返回访问令牌。", 502);
  cache.set(providerKey, { token: body.access_token, expires: Date.now() + (Number(body.expires_in) || 3600) * 1000 });
  return body.access_token;
}

export async function vertexAccessToken(secrets: SecretStore, provider: Provider): Promise<string> {
  const stored = await secrets.get(secretKey(provider.id));
  if (!stored) throw new VertexError("这个 Vertex 来源的服务账号密钥不见了，请删掉它重新添加。", 401);
  return mintAccessToken(provider.id, parseServiceAccount(stored));
}

export async function storeServiceAccount(secrets: SecretStore, providerId: string, sa: ServiceAccount): Promise<void> {
  await secrets.set(secretKey(providerId), JSON.stringify(sa));
}

export async function forgetServiceAccount(secrets: SecretStore, providerId: string): Promise<void> {
  cache.delete(providerId);
  await secrets.delete(secretKey(providerId));
}

export function clearVertexCache(): void { cache.clear(); }
