import { createHash } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { GatewayLogEntry } from "./types.ts";

/**
 * Claude's own models inside a Claude Code session that also has third-party models.
 *
 * Claude Code, started by EasySwitch with its own login kept, sends every request here. Requests
 * for third-party models are served by their providers, as always. Requests for Claude's own models
 * are handed on to Anthropic unchanged, with the headers Claude Code itself sent, so it is the same
 * client and the same login talking to Anthropic, just through this local gateway. The login is
 * never stored, logged, or sent anywhere else, and only these three paths on one fixed host
 * are ever forwarded: the host never comes from the request.
 */

type Json = Record<string, unknown>;

export function anthropicUpstream(): string {
  return process.env.EASYSWITCH_ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com";
}

/** A model id Anthropic serves, as opposed to one of ours (those are `es-claude-…` or `<provider>/<model>`). */
export function isNativeClaude(model: string): boolean {
  return /^claude-/i.test(model) && !model.startsWith("es-claude-");
}

/** The caller's own headers, minus the ones that belong to this hop or to EasySwitch. */
const NOT_FORWARDED = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "upgrade", "expect", "x-easyswitch", "x-easyswitch-session", "keep-alive", "proxy-connection", "x-easyswitch-session"]);

export function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || NOT_FORWARDED.has(name)) continue;
    if (["authorization", "x-api-key", "x-goog-api-key"].includes(name) && /^(?:Bearer\s+)?es-session-/i.test(String(value))) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Forwards one request for a Claude model to Anthropic and streams the answer back. */
export async function forwardNative(
  req: IncomingMessage, res: ServerResponse, pathAndQuery: string, rawBody: string, model: string,
  log: (entry: GatewayLogEntry) => void,
): Promise<void> {
  const started = performance.now();
  // Claude Code may append a context marker such as [1m] to the id; Anthropic does not know it.
  let body = rawBody;
  if (/\[[^\]]*\]"/.test(rawBody)) {
    try {
      const parsed = JSON.parse(rawBody) as Json;
      if (typeof parsed.model === "string") parsed.model = parsed.model.replace(/\[[^\]]*\]$/, "");
      body = JSON.stringify(parsed);
    } catch {
      // Forward as it came.
    }
  }
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const upstream = await fetch(`${anthropicUpstream()}${pathAndQuery}`, {
    method: "POST", redirect: "error", headers: forwardHeaders(req.headers), body, signal: abort.signal,
  }).catch((error: Error) => error);
  const entry = (status: number, note?: string): GatewayLogEntry => ({
    at: new Date().toISOString(), model, providerId: "claude", route: "anthropic-native", harness: "claude",
    status, ms: Math.round(performance.now() - started), ...(note ? { note } : {}),
  });
  if (upstream instanceof Error) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `Anthropic unreachable: ${upstream.message}` } }));
    log(entry(502, "unreachable"));
    return;
  }
  const keep: Record<string, string> = {};
  for (const name of ["content-type", "request-id", "retry-after", "anthropic-ratelimit-requests-remaining", "x-should-retry"]) {
    const v = upstream.headers.get(name);
    if (v) keep[name] = v;
  }
  res.writeHead(upstream.status, keep);
  if (upstream.body) Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  else res.end();
  res.on("finish", () => log(entry(upstream.status)));
}

// ---------------------------------------------------------------- model list

interface Cached { at: number; models: Json[] }
const listCache = new Map<string, Cached>();
const LIST_TTL_MS = 10 * 60_000;

/** Anthropic's own list of models for whoever is signed in, so Claude Code's /model menu shows them next to ours. */
export async function nativeModels(headers: IncomingHttpHeaders): Promise<Json[]> {
  const auth = `${headers.authorization ?? ""}|${headers["x-api-key"] ?? ""}`;
  if (auth === "|") return [];
  // Our own per-launch placeholder is not a login: nothing to ask Anthropic with, and nothing of ours is sent there.
  if (/^Bearer es-session-/i.test(String(headers.authorization ?? "")) || String(headers["x-api-key"] ?? "").startsWith("es-session-")) return [];
  // The cache key is a hash: the login itself is not kept as a map key.
  const key = createHash("sha256").update(auth).digest("hex");
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.models;
  const wanted = ["authorization", "x-api-key", "anthropic-version", "anthropic-beta", "user-agent", "x-app", "anthropic-dangerous-direct-browser-access"];
  const send: Record<string, string> = {};
  for (const name of wanted) {
    const v = headers[name];
    if (typeof v === "string") send[name] = v;
  }
  try {
    const res = await fetch(`${anthropicUpstream()}/v1/models?limit=100`, { redirect: "error", headers: send, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Json[] };
    const models = (json.data ?? []).filter(m => typeof m.id === "string");
    listCache.set(key, { at: Date.now(), models });
    return models;
  } catch {
    return [];
  }
}
