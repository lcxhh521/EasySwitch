import type { IncomingMessage, ServerResponse } from "node:http";
import { catalogModels } from "./catalog.ts";
import { agentFromAuth } from "./gateway-chat.ts";
import { resolveModel, type GatewayDeps } from "./gateway.ts";
import { chatToGemini, GeminiStream, geminiToChat } from "./gemini.ts";
import { withKey } from "./keypool.ts";
import { quirksFor, reasoningDelta, reasoningMemory, shapeChat } from "./quirks.ts";
import type { GatewayLogEntry } from "./types.ts";
import { describeFailure, endpointUrl, sseData, upstreamHeaders } from "./upstream.ts";

/**
 * Inbound Gemini API (`/v1beta/models/<model>:generateContent` and friends) for
 * Gemini CLI and other @google/genai clients. The model in the path is the
 * gateway's `<provider>/<model>` (URL-encoded slash accepted). Translated to
 * Chat for whichever provider owns the model; nothing Gemini-specific leaves
 * this machine.
 */

type Json = Record<string, unknown>;

export const GEMINI_PATH = /^\/(v1beta|v1)\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;

function geminiError(res: ServerResponse, status: number, message: string, state = "INVALID_ARGUMENT"): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code: status, message, status: state } }));
}

export function listGeminiModels(deps: GatewayDeps): Json {
  return {
    models: catalogModels(deps.store.providers()).map(m => ({
      name: `models/${m.providerId}/${m.model}`,
      displayName: m.model,
      description: `${m.providerName} · 经 EasySwitch`,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
    })),
  };
}

/** A rough token count for countTokens; coding agents only use it to budget context. */
function estimate(body: Json): number {
  return Math.ceil(JSON.stringify(body.contents ?? []).length / 4);
}

export async function handleGemini(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray, rawBody: string, deps: GatewayDeps): Promise<void> {
  const started = performance.now();
  const exposed = decodeURIComponent(match[2] ?? "").replace(/^models\//, "");
  const method = match[3];
  let body: Json;
  try {
    body = JSON.parse(rawBody) as Json;
  } catch {
    geminiError(res, 400, "request body is not JSON");
    return;
  }
  if (method === "countTokens") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ totalTokens: estimate((body.generateContentRequest as Json | undefined) ?? body) }));
    return;
  }
  const resolved = resolveModel(deps.store, exposed);
  if (!resolved) {
    geminiError(res, 404, `EasySwitch has no provider for model "${exposed}". Expected "<provider>/<model>".`, "NOT_FOUND");
    return;
  }
  const { provider, model } = resolved;
  const harness = agentFromAuth(req.headers.authorization ?? req.headers["x-goog-api-key"]);
  const stream = method === "streamGenerateContent";
  const finish = (status: number, note?: string, extra: Partial<GatewayLogEntry> = {}) =>
    deps.log({ at: new Date().toISOString(), model: exposed, providerId: provider.id, route: "chat-translate", harness, status, ms: Math.round(performance.now() - started), ...(note ? { note } : {}), ...extra });

  const { chat, dropped } = geminiToChat(body, model, { stream, streamUsage: provider.streamUsage });
  shapeChat(chat, { quirks: quirksFor(provider.baseUrl, model) });
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const { response: upstream, keyId } = await withKey(deps.store, deps.secrets, provider, apiKey =>
    fetch(endpointUrl(provider, "chat"), {
      method: "POST",
      headers: { "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json", ...upstreamHeaders(provider, apiKey) },
      body: JSON.stringify(chat),
      signal: abort.signal,
    }).catch((error: Error) => error));
  if (upstream instanceof Error) {
    geminiError(res, 502, `upstream unreachable: ${upstream.message}`, "UNAVAILABLE");
    finish(502, "unreachable");
    return;
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await describeFailure(upstream);
    geminiError(res, upstream.status || 502, `upstream ${detail}`, upstream.status === 429 ? "RESOURCE_EXHAUSTED" : "INTERNAL");
    finish(upstream.status, detail.slice(0, 120), keyId ? { keyId } : {});
    return;
  }
  const droppedList = [...new Set(dropped)];
  const base: Partial<GatewayLogEntry> = { ...(keyId ? { keyId } : {}), ...(droppedList.length ? { dropped: droppedList } : {}) };

  if (!stream) {
    const json = (await upstream.json().catch(() => undefined)) as Json | undefined;
    if (!json) {
      geminiError(res, 502, "upstream returned something that is not JSON", "INTERNAL");
      finish(502, "bad body");
      return;
    }
    const message = ((json.choices as Json[] | undefined)?.[0]?.message ?? {}) as Json;
    reasoningMemory.remember((Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : []).map(c => String(c.id)), reasoningDelta(message));
    const out = chatToGemini(json, model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(out));
    const u = out.usageMetadata as Json | undefined;
    finish(200, undefined, { ...base, ...(u ? { inputTokens: Number(u.promptTokenCount), outputTokens: Number(u.candidatesTokenCount), cachedTokens: Number(u.cachedContentTokenCount ?? 0) } : {}) });
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const out = new GeminiStream(model, chunk => res.write(chunk));
  try {
    for await (const data of sseData(upstream.body)) {
      if (data === "[DONE]") break;
      let json: Json;
      try { json = JSON.parse(data) as Json; } catch { continue; }
      if (json.error) {
        finish(200, "upstream error mid-stream", base);
        res.end();
        return;
      }
      out.chunk(json);
    }
    out.end();
    reasoningMemory.remember(out.callIds, out.reasoning);
    const usage = out.usageSummary;
    finish(200, undefined, { ...base, ...(usage ? { inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cached } : {}) });
  } catch (error) {
    finish(200, `stream interrupted: ${String((error as Error).message ?? error)}`.slice(0, 120), base);
  }
  res.end();
}
