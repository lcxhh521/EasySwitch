import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import net from "node:net";
import { Readable } from "node:stream";
import tls from "node:tls";
import { catalogModels, codexCatalog, pickTemplate } from "./catalog.ts";
import { handleResponses, resolveModel, type GatewayDeps } from "./gateway.ts";

/**
 * The ChatGPT desktop app's side of the gateway.
 *
 * The app talks to `<openai_base_url>/…` with the user's own ChatGPT login. Point
 * that base URL at this gateway (per launch, through the launcher; see
 * chatgpt.ts) and:
 *  - GET /models   → ChatGPT's real list plus EasySwitch's models, so one picker
 *                    holds both;
 *  - POST /responses with an EasySwitch model ("provider/model") → the usual
 *                    translation to that provider;
 *  - everything else (native models, quotas, WebSocket upgrades) → forwarded
 *                    to ChatGPT untouched, with the app's own headers.
 * Nothing is stored or logged from the forwarded traffic, and the login
 * token is only ever passed along to the address it was meant for. Design
 * after Magpie's codex_backend (MIT) and opencodex's catalog injection (MIT);
 * see PROVENANCE.md.
 */

type Json = Record<string, unknown>;

export const CHATGPT_PREFIX = "/backend-api/codex";

export function chatgptUpstream(): string {
  return (process.env.EASYSWITCH_CHATGPT_UPSTREAM ?? "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");
}

export function isChatgptPath(path: string): boolean {
  return path === CHATGPT_PREFIX || path.startsWith(`${CHATGPT_PREFIX}/`);
}

/** Request headers that describe the hop, not the request, and must not be copied. */
const HOP = new Set(["host", "connection", "content-length", "accept-encoding", "transfer-encoding", "keep-alive", "upgrade", "te", "proxy-connection"]);

function forwardHeaders(req: IncomingMessage, dropConditional = false): Record<string, string> {
  const out: Record<string, string> = { "accept-encoding": "identity" };
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP.has(name) || value === undefined) continue;
    if (dropConditional && (name === "if-none-match" || name === "if-modified-since")) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

function upstreamUrl(path: string, search: string): string {
  return `${chatgptUpstream()}${path.slice(CHATGPT_PREFIX.length)}${search}`;
}

async function readBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Copy a fetch Response back to the client, streaming the body. */
function relay(upstream: Response, res: ServerResponse, onDone?: () => void): void {
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    // fetch has already decoded the body; length and encoding no longer describe it.
    if (!["content-length", "content-encoding", "transfer-encoding", "connection", "keep-alive"].includes(name)) headers[name] = value;
  });
  res.writeHead(upstream.status, headers);
  if (upstream.body && upstream.status !== 204 && upstream.status !== 304) {
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  } else {
    res.end();
  }
  if (onDone) res.on("finish", onDone);
}

/** The merged model list: ChatGPT's own entries first, then ours, under an ETag that covers both. */
export async function handleChatgptModels(req: IncomingMessage, res: ServerResponse, search: string, deps: GatewayDeps): Promise<void> {
  // Conditional headers are answered here against the merged list, not by ChatGPT against its own.
  const upstream = await fetch(upstreamUrl(`${CHATGPT_PREFIX}/models`, search), { headers: forwardHeaders(req, true) }).catch((e: Error) => e);
  if (upstream instanceof Error) {
    sendJson(res, 502, { error: { message: `ChatGPT unreachable: ${upstream.message}` } });
    return;
  }
  if (!upstream.ok) {
    relay(upstream, res);
    return;
  }
  let list: Json;
  try {
    list = (await upstream.json()) as Json;
  } catch {
    sendJson(res, 502, { error: { message: "ChatGPT returned a model list that is not JSON" } });
    return;
  }
  const native = Array.isArray(list.models) ? (list.models as Json[]) : [];
  const template = pickTemplate(native);
  const ours = template ? (codexCatalog(template, deps.store.catalog()).models as Json[]) : [];
  const taken = new Set(native.map(m => String(m.slug)));
  const merged = [...native, ...ours.filter(m => !taken.has(String(m.slug)))];
  const tag = `"${createHash("sha256").update(`${upstream.headers.get("etag") ?? JSON.stringify(native.map(m => m.slug))}|${ours.map(m => m.slug).join(",")}`).digest("hex").slice(0, 24)}"`;
  if (req.headers["if-none-match"] === tag) {
    res.writeHead(304, { etag: tag });
    res.end();
    return;
  }
  sendJson(res, 200, { ...list, models: merged }, { etag: tag });
}

/** POST /responses: an EasySwitch model is translated, any other goes to ChatGPT as it came. */
async function handleChatgptResponses(req: IncomingMessage, res: ServerResponse, search: string, deps: GatewayDeps): Promise<void> {
  const raw = await readBuffer(req);
  let model = "";
  try {
    model = String((JSON.parse(raw.toString("utf8")) as Json).model ?? "");
  } catch {
    // Not JSON: let ChatGPT answer it.
  }
  if (model.includes("/") && resolveModel(deps.store, model)) {
    await handleResponses(req, res, raw.toString("utf8"), deps);
    return;
  }
  await forward(req, res, `${CHATGPT_PREFIX}/responses`, search, raw);
}

async function forward(req: IncomingMessage, res: ServerResponse, path: string, search: string, body?: Buffer): Promise<void> {
  const method = req.method ?? "GET";
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const upstream = await fetch(upstreamUrl(path, search), {
    method,
    headers: forwardHeaders(req),
    ...(body && method !== "GET" && method !== "HEAD" ? { body: new Uint8Array(body) } : {}),
    signal: abort.signal,
  }).catch((e: Error) => e);
  if (upstream instanceof Error) {
    if (!res.headersSent) sendJson(res, 502, { error: { message: `ChatGPT unreachable: ${upstream.message}` } });
    else res.end();
    return;
  }
  relay(upstream, res);
}

/** Entry point for every request under /backend-api/codex. */
export async function handleChatgpt(req: IncomingMessage, res: ServerResponse, path: string, search: string, deps: GatewayDeps): Promise<void> {
  const method = req.method ?? "GET";
  if (method === "GET" && path === `${CHATGPT_PREFIX}/models`) return handleChatgptModels(req, res, search, deps);
  if (method === "POST" && path === `${CHATGPT_PREFIX}/responses`) return handleChatgptResponses(req, res, search, deps);
  const body = method === "GET" || method === "HEAD" ? undefined : await readBuffer(req);
  return forward(req, res, path, search, body);
}

/**
 * A WebSocket upgrade under /backend-api/codex belongs to a ChatGPT-native model
 * (EasySwitch's models are listed without WebSocket support), so it is piped to
 * ChatGPT as raw bytes: no frames are read, nothing is stored.
 */
export function handleChatgptUpgrade(req: IncomingMessage, socket: net.Socket, head: Buffer): void {
  const target = new URL(upstreamUrl((req.url ?? "").split("?")[0] ?? "", (req.url ?? "").includes("?") ? `?${(req.url ?? "").split("?")[1]}` : ""));
  const secure = target.protocol === "https:";
  const port = Number(target.port || (secure ? 443 : 80));
  const onConnect = (upstream: net.Socket) => {
    const lines = [`${req.method} ${target.pathname}${target.search} HTTP/1.1`, `Host: ${target.host}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? "";
      if (name.toLowerCase() === "host") continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ""}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  };
  const upstream = secure
    ? tls.connect({ host: target.hostname, port, servername: target.hostname }, () => onConnect(upstream))
    : net.connect({ host: target.hostname, port }, () => onConnect(upstream));
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on("error", close);
  socket.on("error", close);
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}
