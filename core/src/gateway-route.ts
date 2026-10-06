import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { resolveModel, noModelMessage, type GatewayDeps } from "./gateway.ts";
import { withKey } from "./keypool.ts";
import { modelEfforts, resolveModelEffort } from "./model-efforts.ts";
import { prepareOutbound, type PreparedOutbound } from "./outbound.ts";
import { Downstream } from "./downstream.ts";
import { ProtocolError, type InboundRequest, type Json, type Usage } from "./protocol.ts";
import { reasoningMemory, upstreamModelId } from "./quirks.ts";
import { sseData } from "./upstream.ts";
import { usageOf } from "./upstream-events.ts";
import type { ApiProtocol, GatewayLogEntry } from "./types.ts";

/** Only response metadata intended for clients. Never forward cookies or hop-by-hop headers. */
export function passthroughHeaders(headers: Headers): Record<string, string> {
  const safe: Record<string, string> = {};
  const fixed = new Set(["content-type", "cache-control", "retry-after", "retry-after-ms", "x-should-retry", "request-id", "x-request-id", "openai-processing-ms", "openai-version"]);
  for (const [name, value] of headers) {
    if (fixed.has(name) || /^(?:x-ratelimit-|anthropic-ratelimit-)[a-z0-9-]+$/.test(name)) safe[name] = value;
  }
  return safe;
}

export function gatewayError(res: ServerResponse, protocol: ApiProtocol, status: number, message: string, code?: string): void {
  const type = status === 404 ? "not_found_error" : status === 400 ? "invalid_request_error" : status === 429 ? "rate_limit_error" : "api_error";
  const error = protocol === "gemini" ? { code: status, message, status: status === 404 ? "NOT_FOUND" : status === 400 ? "INVALID_ARGUMENT" : "UNAVAILABLE" } : { type, message, ...(code ? { code } : {}) };
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ ...(protocol === "messages" ? { type: "error" } : {}), error }));
}

export function parseRequest(res: ServerResponse, protocol: ApiProtocol, raw: string): Json | undefined {
  try {
    const body = JSON.parse(raw);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { gatewayError(res, protocol, 400, "request body is not a JSON object"); return undefined; }
}

/** Observe native replies without translating or filtering their payloads. */
async function observe(response: Response, protocol: ApiProtocol): Promise<{ usage?: Usage; failed?: boolean }> {
  let usage: Usage | undefined; let failed = false; let messageUsage: Json = {};
  const ids: string[] = []; let reasoning = "";
  const take = (j: Json) => {
    if (j.error || j.type === "error" || j.type === "response.failed") failed = true;
    if (protocol === "messages") {
      if (j.type === "message_start") messageUsage = j.message?.usage ?? {};
      if (j.usage) { messageUsage = { ...messageUsage, ...j.usage }; usage = usageOf(protocol, messageUsage); }
    } else {
      const raw = protocol === "gemini" ? j.usageMetadata : j.usage ?? j.response?.usage;
      if (raw) usage = usageOf(protocol, raw);
    }
    if (protocol === "chat") {
      const m = j.choices?.[0]?.delta ?? j.choices?.[0]?.message ?? {};
      reasoning += m.reasoning_content ?? m.reasoning ?? "";
      for (const c of m.tool_calls ?? []) if (c.id) ids.push(c.id);
    }
  };
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for await (const data of sseData(response.body!)) {
      if (data === "[DONE]") break;
      try { take(JSON.parse(data)); } catch { /* An observation must never change the native reply. */ }
    }
  } else take(await response.json() as Json);
  reasoningMemory.remember(ids, reasoning);
  return { usage, failed };
}

/** Routing is independent of the caller's protocol. Only source adapters own upstream I/O. */
export async function routeRequest(req: IncomingMessage, res: ServerResponse, input: InboundRequest, harness: string, deps: GatewayDeps): Promise<void> {
  const started = performance.now();
  harness = deps.session?.agentId ?? harness;
  const resolved = resolveModel(deps.store, input.model);
  if (!resolved) { gatewayError(res, input.protocol, 404, noModelMessage(deps.store, input.model), "model_not_found"); return; }
  const { provider, model } = resolved;
  let prepared: PreparedOutbound | undefined; let keyId: string | undefined; let usage: Usage | undefined;
  const finish = (status: number, note?: string) => deps.log({
    at: new Date().toISOString(), model: input.model, providerId: provider.id, harness,
    route: prepared?.protocol === "responses" ? "responses-native" : prepared?.protocol === "messages" ? "anthropic-native" : "chat-translate",
    inboundProtocol: input.protocol, outboundProtocol: prepared?.protocol, adapter: prepared?.adapter,
    status, ms: Math.round(performance.now() - started), ...(note ? { note } : {}), ...(keyId ? { keyId } : {}),
    ...(prepared?.dropped.length ? { dropped: [...new Set(prepared.dropped)] } : {}),
    ...(usage ? { inputTokens: usage.input, outputTokens: usage.output, cachedTokens: usage.cached } : {}),
  } satisfies GatewayLogEntry);
  const abort = new AbortController(); res.on("close", () => abort.abort());
  let downstream: Downstream | undefined;
  let upstreamFailed = false;
  try {
    const saved = deps.store.prefs(harness).effort;
    const effort = saved ? resolveModelEffort(saved, modelEfforts(provider, model)) : undefined;
    try { prepared = prepareOutbound(provider, { ...input, model, effort }, { qoderExecutor: deps.qoderExecutor }); }
    catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) throw new ProtocolError("请求字段或工具参数格式不正确。");
      throw error;
    }
    const sent = provider.mimoFree || provider.kiro
      ? { response: await prepared.send(undefined, abort.signal), keyId: undefined }
      : await withKey(deps.store, deps.secrets, provider, key => prepared!.send(key, abort.signal));
    keyId = sent.keyId;
    const upstream = sent.response;
    if (upstream instanceof Error) throw new ProtocolError("上游连接失败，请检查来源地址和网络。", 502);
    if (prepared.passthrough) {
      // Native errors are native responses too. Preserve their status, body bytes and retry
      // metadata, including empty 204/304 responses. Key/pool retries still happen before output.
      res.writeHead(upstream.status, passthroughHeaders(upstream.headers));
      if (!upstream.body) { res.end(); finish(upstream.status); return; }
      const [bytes, side] = upstream.body.tee();
      const observed = observe(new Response(side, { headers: upstream.headers }), input.protocol).catch(() => ({}));
      const source = Readable.fromWeb(bytes as import("node:stream/web").ReadableStream);
      source.once("error", () => { if (!abort.signal.aborted) upstreamFailed = true; });
      await pipeline(source, res);
      const tap = await observed as { usage?: Usage; failed?: boolean };
      usage = tap.usage; finish(upstream.ok && tap.failed ? 502 : upstream.status, tap.failed ? "upstream error" : undefined); return;
    }
    if (!upstream.ok || !upstream.body) {
      const status = upstream.ok ? 502 : upstream.status;
      await upstream.body?.cancel();
      // Upstream bodies can contain echoed request data or credentials. Keep them out of logs.
      gatewayError(res, input.protocol, status, status === 429 ? "upstream rate limit (HTTP 429)" : "upstream HTTP " + status); finish(status, "upstream HTTP " + status); return;
    }
    downstream = new Downstream(input.protocol, upstreamModelId(model), provider.id, prepared.protocol, prepared.tools, input.stream ? chunk => res.write(chunk) : undefined);
    if (input.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      downstream.start();
    }
    for await (const event of prepared.events(upstream)) downstream.accept(event);
    usage = downstream.usage;
    reasoningMemory.remember(downstream.items.filter(i => i.kind === "call").map(i => i.callId!), downstream.items.filter(i => i.kind === "reasoning").map(i => i.text).join(""));
    if (input.stream) downstream.finish();
    else { const result = downstream.result(); res.writeHead(200, { "content-type": "application/json" }); res.write(JSON.stringify(result)); }
    res.end(); finish(200);
  } catch (error) {
    const status = error instanceof ProtocolError ? error.status : 502;
    const message = error instanceof ProtocolError ? error.message : "上游响应无法完成，请检查来源或重试。";
    if (res.destroyed || abort.signal.aborted) { finish(upstreamFailed ? 502 : 499, upstreamFailed ? "upstream stream interrupted" : "client disconnected"); return; }
    if (!res.headersSent) gatewayError(res, input.protocol, status, message);
    else if (prepared?.passthrough) res.destroy();
    else { downstream?.fail(message); res.end(); }
    finish(status, message);
  }
}
