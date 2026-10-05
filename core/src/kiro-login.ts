// Adapted from opencodex src/oauth/kiro-credentials.ts (MIT), commit 5841269073b3898e5dd3ac9dcd956c7e56c1bb34.
// Copyright (c) 2026 opencodex contributors. See third_party/opencodex/LICENSE.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_KEYS = ["kirocli:odic:token", "kirocli:oidc:token", "kirocli:social:token", "codewhisperer:odic:token"];
const REGISTRATION_KEYS = ["kirocli:odic:device-registration", "kirocli:oidc:device-registration", "codewhisperer:odic:device-registration"];
const BUILDER_PROFILE = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
type Json = Record<string, unknown>;

export interface KiroLogin {
  accessToken: string;
  region: string;
  profileArn?: string;
  builderId: boolean;
}

export class KiroError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

export function kiroLoginPath(home = homedir()): string {
  return process.platform === "darwin"
    ? join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3")
    : join(home, ".local", "share", "kiro-cli", "data.sqlite3");
}

function field(data: Json, ...names: string[]): string | undefined {
  for (const name of names) if (typeof data[name] === "string" && data[name]) return data[name] as string;
  return undefined;
}

/** Read the CLI's current session for this request. Never refresh, copy or write its tokens. */
export async function readKiroLogin(path = kiroLoginPath()): Promise<KiroLogin> {
  if (!existsSync(path)) throw new KiroError("没有找到 Kiro CLI 登录，请先在 Kiro CLI 登录后重试。", 401);
  // Load SQLite only for Kiro; other providers do not need this experimental Node 22 API.
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try { db = new DatabaseSync(path, { readOnly: true }); }
  catch { throw new KiroError("无法只读打开 Kiro CLI 登录库。", 401); }
  try {
    const columns = db.prepare("PRAGMA table_info(auth_kv)").all();
    if (!["key", "value"].every(name => columns.some(c => c.name === name))) {
      throw new KiroError("Kiro CLI 登录库格式不受支持。", 401);
    }
    const read = (keys: string[]): Json => {
      const query = db.prepare("SELECT value FROM auth_kv WHERE key = ?");
      for (const key of keys) {
        const row = query.get(key);
        if (row) return JSON.parse(String(row.value)) as Json;
      }
      return {};
    };
    const data = { ...read(REGISTRATION_KEYS), ...read(TOKEN_KEYS) };
    const accessToken = field(data, "accessToken", "access_token");
    if (!accessToken) throw new KiroError("Kiro CLI 没有可用登录，请先登录后重试。", 401);
    const expiry = data.expiresAt ?? data.expires_at;
    const expires = typeof expiry === "number" ? (expiry < 10_000_000_000 ? expiry * 1000 : expiry) : Date.parse(String(expiry));
    if (expiry !== undefined && (!Number.isFinite(expires) || expires <= Date.now())) {
      throw new KiroError("Kiro CLI 登录已过期，请在 Kiro CLI 刷新登录后重试。", 401);
    }
    let profileArn = field(data, "profileArn", "profile_arn");
    const stateColumns = db.prepare("PRAGMA table_info(state)").all();
    if (["key", "value"].every(name => stateColumns.some(c => c.name === name))) {
      const row = db.prepare("SELECT value FROM state WHERE key = ?").get("api.codewhisperer.profile");
      if (row) profileArn = field(JSON.parse(String(row.value)), "arn", "profileArn", "profile_arn") ?? profileArn;
    }
    if (profileArn === BUILDER_PROFILE) profileArn = undefined;
    const region = profileArn?.split(":")[3] ?? field(data, "apiRegion", "api_region", "region") ?? "us-east-1";
    // A local field becomes a host component: never allow it to redirect the bearer token.
    if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/.test(region)) throw new KiroError("Kiro CLI 登录中的区域无效。", 401);
    const builderId = !profileArn && Boolean(field(data, "clientId", "client_id") && field(data, "clientSecret", "client_secret"));
    return { accessToken, region, profileArn: profileArn ?? (builderId ? BUILDER_PROFILE : undefined), builderId };
  } catch (error) {
    if (error instanceof KiroError) throw error;
    // JSON/SQLite errors can include the source text; never expose a login record.
    throw new KiroError("无法读取 Kiro CLI 登录，请检查客户端登录状态。", 401);
  } finally { db.close(); }
}
