import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { AnthropicStream, chatToMessage, estimateTokens, messagesToChat } from "./anthropic.ts";
import type { GatewayDeps } from "./gateway.ts";
import type { GatewayLogEntry } from "./types.ts";
import { fromClaudeModelId } from "./catalog.ts";
import { withKey } from "./keypool.ts";
import { resolveModel } from "./gateway.ts";
import { anthropicHeaders } from "./probe.ts";
import { authHeaders, describeFailure, joinUrl, sseData } from "./upstream.ts";

type Json = Record<string, unknown>;

/** Claude-only request fields a third-party Messages endpoint would choke on, or should not see. */
const CLAUDE_ONLY_FIELDS = ["safeguards", "context_management", "output_config", "metadata"] as const;

function anthropicError(res: ServerResponse, status: number, type: string, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

export function handleCountTokens(res: ServerResponse, rawBody: string): void {
  let body: Json = {};
  try { body = JSON.parse(rawBody) as Json; } catch { /* estimate from nothing */ }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
}

export async function handleMessages(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: GatewayDeps): Promise<void> {
  const started = performance.now();
  let body: Json;
  try {
    body = JSON.parse(rawBody) as Json;
  } catch {
    anthropicError(res, 400, "invalid_request_error", "request body is not JSON");
    return;
  }
  // The /model menu hands back es-claude ids; logs and errors use the plain name.
  const asked = String(body.model ?? "");
  const exposed = fromClaudeModelId(asked) ?? asked;
  const resolved = resolveModel(deps.store, exposed);
  if (!resolved) {
    anthropicError(res, 404, "not_found_error", `EasySwitch has no provider for model "${exposed}". Expected "<provider>/<model>".`);
    return;
  }
  const { provider, model } = resolved;
  const route = provider.messagesRoute ?? "chat-translate";
  const finish = (status: number, note?: string, extra: Partial<GatewayLogEntry> = {}) =>
    deps.log({
      at: new Date().toISOString(), model: exposed, providerId: provider.id, route, harness: "claude",
      status, ms: Math.round(performance.now() - started), ...(note ? { note } : {}), ...extra,
    });
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  if (route === "anthropic-native") {
    const forwarded: Json = { ...body, model };
    for (const field of CLAUDE_ONLY_FIELDS) delete forwarded[field];
    const thinking = forwarded.thinking as Json | undefined;
    if (thinking && thinking.type !== "enabled") delete forwarded.thinking;
    const { response: upstream, keyId } = await withKey(deps.store, deps.secrets, provider, apiKey =>
      fetch(joinUrl(provider.anthropicBaseUrl ?? provider.baseUrl, "messages"), {
        method: "POST",
        headers: { ...anthropicHeaders(apiKey), accept: req.headers.accept ?? "application/json" },
        body: JSON.stringify(forwarded),
        signal: abort.signal,
      }).catch((error: Error) => error));
    if (upstream instanceof Error) {
      anthropicError(res, 502, "api_error", `upstream unreachable: ${upstream.message}`);
      finish(502, "unreachable");
      return;
    }
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    if (upstream.body) Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
    else res.end();
    res.on("finish", () => finish(upstream.status, undefined, keyId ? { keyId } : {}));
    return;
  }

  const { chat, dropped } = messagesToChat(body, model, { streamUsage: provider.streamUsage });
  const send = async (payload: unknown, apiKey?: string): Promise<Response | Error> => fetch(joinUrl(provider.baseUrl, "chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders(apiKey) },
    body: JSON.stringify(payload),
    signal: abort.signal,
  }).catch((error: Error) => error);

  let { response: upstream, keyId } = await withKey(deps.store, deps.secrets, provider, apiKey => send(chat, apiKey));
  const droppedList = [...new Set(dropped)];
  let note: string | undefined;
  if (!(upstream instanceof Error) && upstream.status === 400 && chat.max_tokens !== undefined) {
    // Claude Code asks for 32k output tokens; many chat models cap lower and
    // reject the request outright. Retry once and let the provider decide.
    await upstream.body?.cancel();
    const { max_tokens: _dropped, ...rest } = chat;
    upstream = await send(rest);
    note = "max_tokens 超出模型上限，已去掉后重试";
  }
  if (upstream instanceof Error) {
    anthropicError(res, 502, "api_error", `upstream unreachable: ${upstream.message}`);
    finish(502, "unreachable");
    return;
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await describeFailure(upstream);
    // 429 and 5xx keep their status so Claude Code's own retry logic applies.
    const type = upstream.status === 429 ? "rate_limit_error" : upstream.status >= 500 ? "api_error" : "invalid_request_error";
    anthropicError(res, upstream.status || 502, type, `upstream ${detail}`);
    finish(upstream.status, detail.slice(0, 120));
    return;
  }

  if (!chat.stream) {
    const json = (await upstream.json()) as Json;
    const message = chatToMessage(json, model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(message));
    const u = message.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
    finish(200, note, {
      ...(droppedList.length ? { dropped: droppedList } : {}),
      ...(keyId ? { keyId } : {}),
      inputTokens: u.input_tokens, outputTokens: u.output_tokens, cachedTokens: u.cache_read_input_tokens,
    });
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const stream = new AnthropicStream(model, chunk => res.write(chunk));
  stream.start();
  try {
    for await (const data of sseData(upstream.body)) {
      if (data === "[DONE]") break;
      let json: Json;
      try { json = JSON.parse(data) as Json; } catch { continue; }
      if (json.error) {
        stream.fail(JSON.stringify(json.error).slice(0, 300));
        res.end();
        finish(200, "upstream error mid-stream");
        return;
      }
      stream.chunk(json);
    }
    stream.finishStream();
    const usage = stream.usageSummary;
    finish(200, note, {
      ...(droppedList.length ? { dropped: droppedList } : {}),
      ...(keyId ? { keyId } : {}),
      ...(usage ? { inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cached } : {}),
    });
  } catch (error) {
    stream.fail(String((error as Error).message ?? error));
    finish(200, "stream interrupted");
  }
  res.end();
}
