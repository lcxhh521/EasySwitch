/** Runtime client metadata only. This module contains no bundled OAuth client identity. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

export class AntigravityClientError extends Error {
  status = 503;
  code = "antigravity_client_unavailable";
  constructor() { super("Antigravity 客户端配置尚未就绪，请先检查明确指定的本机私有配置文件。"); }
}
export interface AntigravityClientCredentials { readonly clientId: string; readonly clientSecret: string }
export interface AntigravityClientOptions { env?: NodeJS.ProcessEnv; read?: (path: string) => string }
const CONFIG_ENV = "EASYSWITCH_ANTIGRAVITY_CLIENT_CONFIG";
const MAX_BYTES = 16 * 1024;

/** No directory discovery, native-app inspection, import-time I/O or credential persistence. */
function readPrivateConfig(path: string): string {
  let fd: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_BYTES || (before.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && before.uid !== process.getuid())) throw new AntigravityClientError();
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0) throw new AntigravityClientError();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let used = 0;
    while (used < bytes.length) { const count = readSync(fd, bytes, used, bytes.length - used, null); if (!count) break; used += count; }
    const after = fstatSync(fd);
    if (used > MAX_BYTES || after.size !== used || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) throw new AntigravityClientError();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, used));
  } catch { throw new AntigravityClientError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** Caller supplies the path explicitly. Missing/invalid configuration is never replaced by a built-in secret. */
export function antigravityClientCredentials(options: AntigravityClientOptions = {}): AntigravityClientCredentials {
  try {
    const path = (options.env ?? process.env)[CONFIG_ENV];
    if (!path || !isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) throw new AntigravityClientError();
    const raw = (options.read ?? readPrivateConfig)(path);
    if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_BYTES) throw new AntigravityClientError();
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || typeof value !== "object" || value.version !== 1
      || Object.keys(value).sort().join(",") !== "clientId,clientSecret,version") throw new AntigravityClientError();
    for (const key of ["clientId", "clientSecret"]) {
      if (typeof value[key] !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(value[key])) throw new AntigravityClientError();
    }
    return Object.freeze({ clientId: value.clientId, clientSecret: value.clientSecret });
  } catch { throw new AntigravityClientError(); }
}

export const ANTIGRAVITY_API_VERSION = "v1internal";
export const ANTIGRAVITY_CALLBACK_PORT = 0;
export const ANTIGRAVITY_SCOPES = Object.freeze(["openid", "email", "profile", "https://www.googleapis.com/auth/cloud-platform"]);
const DESTINATIONS = Object.freeze({
  auth: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  userinfo: "https://openidconnect.googleapis.com/v1/userinfo",
  api: "https://cloudcode-pa.googleapis.com",
  onboardApi: "https://cloudcode-pa.googleapis.com",
});
const OVERRIDES = { auth: "AUTH", token: "TOKEN", userinfo: "USERINFO", api: "API", onboardApi: "ONBOARD_API" } as const;

/** Fixed Google destinations. Overrides are possible only inside explicit Node loopback fixtures. */
export function antigravityEndpoints(env: NodeJS.ProcessEnv = process.env): typeof DESTINATIONS {
  const out: Record<string, string> = { ...DESTINATIONS };
  const fixture = !!process.env.NODE_TEST_CONTEXT && env.EASYSWITCH_TEST_ANTIGRAVITY_FIXTURES === "1";
  for (const [key, suffix] of Object.entries(OVERRIDES)) {
    const raw = env[`EASYSWITCH_ANTIGRAVITY_${suffix}`];
    if (raw === undefined) continue;
    if (!fixture) throw new AntigravityClientError();
    let url: URL;
    try { url = new URL(raw); } catch { throw new AntigravityClientError(); }
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new AntigravityClientError();
    if ((key === "api" || key === "onboardApi") && url.pathname !== "/") throw new AntigravityClientError();
    out[key] = raw.replace(/\/$/, "");
  }
  if (fixture && env.EASYSWITCH_ANTIGRAVITY_API && !env.EASYSWITCH_ANTIGRAVITY_ONBOARD_API) out.onboardApi = out.api!;
  return Object.freeze(out) as typeof DESTINATIONS;
}

/** Identifies this integration honestly rather than inventing an installed IDE version. */
export function antigravityUserAgent(): string { return "EasySwitch/0.0.1"; }
