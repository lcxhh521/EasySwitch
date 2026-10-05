import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { withKey } from "./keypool.ts";
import { quirksFor, reasoningDelta, reasoningMemory, shapeChat } from "./quirks.ts";
import { applyThinking } from "./gateway.ts";
import type { ChatRequest } from "./translate.ts";
import type { GatewayLogEntry } from "./types.ts";
import { describeFailure, endpointUrl, sseData, upstreamHeaders } from "./upstream.ts";
import { resolveModel, type GatewayDeps } from "./gateway.ts";
import { sendChat } from "./upstream-chat.ts";

/**
 * Inbound OpenAI Chat Completions: what most coding agents (Qwen Code, opencode,
 * Hermes, Aider, Pi, …) speak to a custom endpoint. The body is already in the
 * shape the upstream wants, so it is forwarded as it came, with only what a
 * provider needs changed: the model name, the quirks pass (tool pairs, reasoning
 * replay, sampling locks…), and usage reporting switched on so the ledger can
 * count. The reply is streamed straight back; it is only read on the side for
 * usage and for the reasoning to replay on the next turn.
 */

type Json = Record<string, unknown>;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function openaiError(message: string, type = "easyswitch_error", code?: string): Json {
  return { error: { message, type, ...(code ? { code } : {}) } };
}

/** The agent behind a request, from the per-launch gateway token `es-session-<agent>-<id>`; unknown tokens log as "chat". */
/** The agent a call belongs to: from its per-launch token, else the protocol's usual client. */
export function agentOf(header: string | string[] | undefined, fallback: string): string {
  const id = agentFromAuth(header);
  return id === "chat" ? fallback : id;
}

export function agentFromAuth(header: string | string[] | undefined): string {
  const token = String(Array.isArray(header) ? header[0] : header ?? "").replace(/^Bearer\s+/i, "");
  const id = /^es-session-([a-z0-9]+)-/.exec(token)?.[1];
  // The older Claude Code token has no agent in it, only a UUID: that is not an agent id.
  return id && !/^[0-9a-f]{8}$/.test(id) ? id : "chat";
}

interface Tap {
  usage?: { input: number; output: number; cached: number };
  reasoning: string;
  callIds: string[];
}

function readUsage(raw: unknown): Tap["usage"] {
  const u = raw as Json | undefined;
  if (!u || typeof u !== "object") return undefined;
  const details = u.prompt_tokens_details as Json | undefined;
  return {
    input: Number(u.prompt_tokens ?? 0),
    output: Number(u.completion_tokens ?? 0),
    cached: Number(details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0),
  };
}

export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: GatewayDeps): Promise<void> {
  const started = performance.now();
  let body: Json;
  try {
    body = JSON.parse(rawBody) as Json;
  } catch {
    sendJson(res, 400, openaiError("request body is not JSON", "invalid_request_error"));
    return;
  }
  const exposed = String(body.model ?? "");
  const resolved = resolveModel(deps.store, exposed);
  if (!resolved) {
    sendJson(res, 404, openaiError(`EasySwitch has no provider for model "${exposed}". Expected "<provider>/<model>".`, "not_found_error", "model_not_found"));
    return;
  }
  const { provider, model } = resolved;
  const harness = agentFromAuth(req.headers.authorization);
  const finish = (status: number, note?: string, extra: Partial<GatewayLogEntry> = {}) =>
    deps.log({
      at: new Date().toISOString(), model: exposed, providerId: provider.id, route: "chat-translate", harness,
      status, ms: Math.round(performance.now() - started), ...(note ? { note } : {}), ...extra,
    });

  const stream = body.stream === true;
  const chat = { ...body, model } as unknown as ChatRequest;
  const quirks = quirksFor(provider.baseUrl, model);
  applyThinking(chat, deps.store, harness, (body as Json).reasoning_effort, provider, quirks);
  shapeChat(chat, { quirks });
  // Usage is what the ledger counts; ask for it when the client did not.
  if (stream && provider.streamUsage && !(chat as unknown as Json).stream_options) chat.stream_options = { include_usage: true };

  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const { response: upstream, keyId } = await withKey(deps.store, deps.secrets, provider, apiKey =>
    sendChat(provider, apiKey, chat, abort.signal));
  if (upstream instanceof Error) {
    sendJson(res, 502, openaiError(`upstream unreachable: ${upstream.message}`, "api_error"));
    finish(502, "unreachable");
    return;
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await describeFailure(upstream);
    // Keep the upstream status: agents retry 429 and 5xx on their own.
    sendJson(res, upstream.status || 502, openaiError(`upstream ${detail}`, upstream.status === 429 ? "rate_limit_error" : "api_error"));
    finish(upstream.status, detail.slice(0, 120), keyId ? { keyId } : {});
    return;
  }

  const tap: Tap = { reasoning: "", callIds: [] };
  const done = () => {
    reasoningMemory.remember(tap.callIds, tap.reasoning);
    finish(200, undefined, {
      ...(keyId ? { keyId } : {}),
      ...(tap.usage ? { inputTokens: tap.usage.input, outputTokens: tap.usage.output, cachedTokens: tap.usage.cached } : {}),
    });
  };

  if (!stream) {
    const json = (await upstream.json().catch(() => undefined)) as Json | undefined;
    if (!json) {
      sendJson(res, 502, openaiError("upstream returned something that is not JSON", "api_error"));
      finish(502, "bad body");
      return;
    }
    const message = ((json.choices as Json[] | undefined)?.[0]?.message ?? {}) as Json;
    tap.reasoning = reasoningDelta(message);
    tap.callIds = (Array.isArray(message.tool_calls) ? message.tool_calls as Json[] : []).map(c => String(c.id));
    tap.usage = readUsage(json.usage);
    sendJson(res, 200, json);
    done();
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  try {
    // Pass each chunk through untouched while a copy is read on the side.
    const tee = upstream.body.tee();
    const forward = (async () => { for await (const chunk of tee[0]) if (!res.write(chunk)) await new Promise(r => res.once("drain", r)); })();
    for await (const data of sseData(tee[1])) {
      if (data === "[DONE]") break;
      let json: Json;
      try { json = JSON.parse(data) as Json; } catch { continue; }
      if (json.usage) tap.usage = readUsage(json.usage) ?? tap.usage;
      const delta = ((json.choices as Json[] | undefined)?.[0]?.delta ?? {}) as Json;
      tap.reasoning += reasoningDelta(delta);
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls as Json[] : []) {
        if (typeof call.id === "string" && !tap.callIds.includes(call.id)) tap.callIds.push(call.id);
      }
    }
    await forward;
  } catch (error) {
    finish(200, `stream interrupted: ${String((error as Error).message ?? error)}`.slice(0, 120), keyId ? { keyId } : {});
    res.end();
    return;
  }
  res.end();
  done();
}

/** A fresh per-launch gateway token for an agent: the agent id rides in it so the ledger can tell who called. */
export function sessionToken(agentId: string): string {
  return `es-session-${agentId.replace(/[^a-z0-9]/g, "")}-${randomUUID()}`;
}
