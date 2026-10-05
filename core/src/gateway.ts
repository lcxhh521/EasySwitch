import { anthropicModelList, catalogModels } from "./catalog.ts";
import { withKey } from "./keypool.ts";
import { applyEffort, quirksFor, reasoningMemory, shapeChat, upstreamModelId, type Quirks } from "./quirks.ts";
import { agentOf } from "./gateway-chat.ts";
import { modelEfforts } from "./model-efforts.ts";
import { liveMembers, poolOf } from "./pools.ts";
import { sendChat, sendResponses } from "./upstream-chat.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { SecretStore } from "./secrets.ts";
import type { Store } from "./store.ts";
import { type ChatRequest, ResponsesStream, responsesToChat } from "./translate.ts";
import type { GatewayLogEntry, Provider } from "./types.ts";
import { describeFailure, endpointUrl, sseData, upstreamHeaders } from "./upstream.ts";

type Json = Record<string, unknown>;

export interface GatewayDeps {
  store: Store;
  secrets: SecretStore;
  log: (entry: GatewayLogEntry) => void;
}

/** `<provider id>/<upstream model>`: the provider is everything before the first slash. */
export function resolveModel(store: Store, exposed: string): { provider: Provider; model: string } | undefined {
  // A pool stands for its first member wherever a single model is needed (validation, defaults); requests themselves are spread over the members by runWithPool.
  const pool = poolOf(store, exposed);
  if (pool) {
    const first = liveMembers(store, pool)[0];
    return first ? resolveModel(store, first) : undefined;
  }
  const slash = exposed.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = store.provider(exposed.slice(0, slash));
  const model = exposed.slice(slash + 1);
  return provider && model ? { provider, model } : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function errorBody(message: string, type = "easyswitch_error") {
  return { error: { message, type } };
}

/** OpenAI's list shape by default; Anthropic's ModelInfo list when Claude Code asks. */
/**
 * The thinking level for one call. What the user saved for the agent wins and is said in the
 * upstream's own way; without one, an agent's own request is passed on only to upstreams that
 * take Chat's `reasoning_effort`, so nothing changes for anyone who never touched the setting.
 */
export function applyThinking(chat: ChatRequest, store: Store, agent: string, requested: unknown, provider: Provider, quirks: Quirks): void {
  const style = provider.plan ? "effort" : provider.reasoningEffort === undefined ? quirks.reasoning : provider.reasoningEffort ? "effort" : "none";
  const saved = store.prefs(agent).effort;
  const has = modelEfforts(provider, chat.model);
  if (saved) applyEffort(chat, saved, style, has);
  else if (style === "effort") applyEffort(chat, requested, style, has);
}

export function listExposedModels(store: Store, anthropic = false): Json {
  const models = store.catalog();
  if (anthropic) return anthropicModelList(models);
  return { object: "list", data: models.map(m => ({ id: `${m.providerId}/${m.model}`, object: "model", owned_by: m.providerId })) };
}

export async function handleResponses(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: GatewayDeps): Promise<void> {
  const started = performance.now();
  let body: Json;
  try {
    body = JSON.parse(rawBody) as Json;
  } catch {
    sendJson(res, 400, errorBody("request body is not JSON"));
    return;
  }
  const exposed = String(body.model ?? "");
  const resolved = resolveModel(deps.store, exposed);
  if (!resolved) {
    sendJson(res, 404, errorBody(`EasySwitch has no provider for model "${exposed}". Expected "<provider>/<model>".`, "model_not_found"));
    return;
  }
  const { provider, model } = resolved;
  const finish = (status: number, note?: string, extra: Partial<GatewayLogEntry> = {}) =>
    deps.log({
      at: new Date().toISOString(), model: exposed, providerId: provider.id, route: provider.route, harness: agentOf(req.headers.authorization, "codex"),
      status, ms: Math.round(performance.now() - started), ...(note ? { note } : {}), ...extra,
    });

  const abort = new AbortController();
  res.on("close", () => abort.abort());

  if (provider.route === "responses-native") {
    // The relay speaks Responses itself: forward the request untouched except
    // for the model name, and stream its bytes straight back.
    const forwarded: Json = { ...body, model: upstreamModelId(model) };
    // The thinking level saved for this agent is carried in the request's own `reasoning` field.
    const saved = deps.store.prefs(agentOf(req.headers.authorization, "codex")).effort;
    if (saved && modelEfforts(provider, model).includes(saved)) forwarded.reasoning = { ...((body.reasoning as Json | undefined) ?? {}), effort: saved };
    const { response: upstream, keyId } = await withKey(deps.store, deps.secrets, provider, apiKey =>
      sendResponses(provider, apiKey, forwarded, String(req.headers.accept ?? "text/event-stream"), abort.signal));
    if (upstream instanceof Error) {
      sendJson(res, 502, errorBody(`upstream unreachable: ${upstream.message}`));
      finish(502, "unreachable");
      return;
    }
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
    if (upstream.body) Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
    else res.end();
    res.on("finish", () => finish(upstream.status, undefined, keyId ? { keyId } : {}));
    return;
  }

  const { chat, customTools, dropped, namespaced } = responsesToChat(body, model, { streamUsage: provider.streamUsage });
  const quirks = quirksFor(provider.baseUrl, model);
  applyThinking(chat, deps.store, agentOf(req.headers.authorization, "codex"), (body.reasoning as Json | undefined)?.effort, provider, quirks);
  shapeChat(chat, {
    quirks,
    ...(typeof body.prompt_cache_key === "string" ? { cacheKey: body.prompt_cache_key } : {}),
  });
  const { response: upstream, keyId } = await withKey(deps.store, deps.secrets, provider, apiKey =>
    sendChat(provider, apiKey, chat, abort.signal));
  const droppedList = [...new Set(dropped)];
  const note = undefined;
  if (upstream instanceof Error) {
    sendJson(res, 502, errorBody(`upstream unreachable: ${upstream.message}`));
    finish(502, "unreachable");
    return;
  }
  if (!upstream.ok || !upstream.body) {
    // Keep the upstream status: Codex retries 429 and 5xx on its own.
    const detail = await describeFailure(upstream);
    sendJson(res, upstream.status || 502, errorBody(`upstream ${detail}`, "upstream_error"));
    finish(upstream.status, detail.slice(0, 120));
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const stream = new ResponsesStream(model, customTools, chunk => res.write(chunk), namespaced);
  stream.start();
  try {
    for await (const data of sseData(upstream.body)) {
      if (data === "[DONE]") break;
      let json: Json;
      try {
        json = JSON.parse(data) as Json;
      } catch {
        continue;
      }
      if (json.error) {
        stream.fail("upstream_error", JSON.stringify(json.error).slice(0, 300));
        res.end();
        finish(200, "upstream error mid-stream");
        return;
      }
      stream.chunk(json);
    }
    stream.finish();
    reasoningMemory.remember(stream.turn.callIds, stream.turn.reasoning);
    const usage = stream.usageSummary;
    finish(200, note, {
      ...(droppedList.length ? { dropped: droppedList } : {}),
      ...(keyId ? { keyId } : {}),
      ...(usage ? { inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cached } : {}),
    });
  } catch (error) {
    stream.fail("stream_interrupted", String((error as Error).message ?? error));
    finish(200, "stream interrupted");
  }
  res.end();
}
