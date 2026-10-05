import { join } from "node:path";
import type { ApiProtocol, Provider } from "./types.ts";
import { decodeRequest } from "./inbound.ts";
import { encodeRequest, restoreNativeState } from "./outbound-format.ts";
import { readOutput } from "./upstream-events.ts";
import { ProtocolError, type InboundRequest, type Json, type OutputEvent, type Tool } from "./protocol.ts";
import { endpointUrl, upstreamHeaders } from "./upstream.ts";
import { anthropicHeaders } from "./probe.ts";
import { applyEffort, quirksFor, shapeChat, upstreamModelId } from "./quirks.ts";
import type { ChatRequest } from "./translate.ts";
import { modelEfforts } from "./model-efforts.ts";
import { shapePlanRequest } from "./responses-upstream.ts";
import { planTarget } from "./siwc.ts";
import { dataDir } from "./paths.ts";
import { mimoChatUrl, mimoHeaders, mimoJwt, withMimoMarker } from "./mimo-free.ts";
import { prepareKiro } from "./kiro.ts";

/** Legacy route settings remain readable; explicit model/source capabilities take precedence. */
export function sourceProtocols(p: Provider, model: string): ApiProtocol[] {
  if (p.plan && p.plan.kind !== "copilot") return ["responses"];
  if (p.mimoFree || p.plan?.kind === "copilot") return ["chat"];
  const set = p.modelProtocols?.[model] ?? p.protocols;
  if (set?.length) return set;
  const result: ApiProtocol[] = [];
  if (p.route === "responses-native") result.push("responses");
  if (p.messagesRoute === "anthropic-native") result.push("messages");
  // A failed Chat probe must not turn a Responses-only source into a Chat source.
  const chat = p.probe?.checks.find(c => c.id === "chat");
  if (chat?.status === "pass" || (!chat && !result.length) || (p.routePinned && p.route === "chat-translate")) result.push("chat");
  return result;
}

export interface PreparedOutbound {
  adapter: string;
  protocol: ApiProtocol | "kiro";
  passthrough: boolean;
  tools: Tool[];
  dropped: string[];
  send: (key: string | undefined, signal: AbortSignal) => Promise<Response | Error>;
  events: (response: Response) => AsyncIterable<OutputEvent>;
}

export function prepareOutbound(provider: Provider, input: InboundRequest): PreparedOutbound {
  const request = { ...input, model: upstreamModelId(input.model), source: provider.id };
  if (provider.kiro) return prepareKiro(provider, request);
  const protocols = sourceProtocols(provider, input.model);
  const target = protocols.includes(input.protocol) ? input.protocol : protocols[0];
  if (!target) throw new ProtocolError("这个来源没有可用的出站协议，请在来源设置里选择。", 400);
  const conversation = target === input.protocol ? undefined : decodeRequest(request);
  let body = conversation ? encodeRequest(conversation, request, target) : structuredClone(input.body);
  const dropped = conversation?.dropped ?? [];
  if (!conversation) restoreNativeState(body, request, dropped);
  if (target !== "gemini") { body.model = request.model; body.stream = request.stream; }
  if (target === "chat") {
    const quirks = quirksFor(provider.baseUrl, request.model);
    const style = provider.reasoningEffort === undefined ? quirks.reasoning : provider.reasoningEffort ? "effort" : "none";
    // Known provider quirks live at egress. An ordinary same-protocol call retains its fields.
    if (conversation || Object.values(quirks).some(v => v === true)) shapeChat(body as ChatRequest, { quirks, ...(typeof request.body.prompt_cache_key === "string" ? { cacheKey: request.body.prompt_cache_key } : {}) });
    const effort = request.effort ?? conversation?.effort;
    if (conversation) delete body.reasoning_effort;
    applyEffort(body as ChatRequest, effort, style, modelEfforts(provider, request.model));
    if (request.stream && provider.streamUsage && !body.stream_options) body.stream_options = { include_usage: true };
  } else if (request.effort) {
    if (target === "responses") body.reasoning = { ...body.reasoning, effort: request.effort };
    else if (target === "messages") body.output_config = { ...body.output_config, effort: request.effort };
    else body.generationConfig = { ...body.generationConfig, thinkingConfig: { ...body.generationConfig?.thinkingConfig, thinkingLevel: request.effort.toUpperCase() } };
  }
  const plan = provider.plan && provider.plan.kind !== "copilot" ? provider.plan : undefined;
  if (plan) {
    if (conversation) {
      const instructions = conversation.turns.filter(t => t.role === "system" || t.role === "developer").flatMap(t => t.parts.filter(p => p.type === "text").map(p => p.text)).join("\n\n");
      if (instructions) { body.instructions = instructions; body.input = body.input.filter((i: Json) => i.role !== "system" && i.role !== "developer"); }
    }
    const shaped = shapePlanRequest(body); body = shaped.body; dropped.push(...shaped.dropped);
    if (plan.kind === "codex" && !body.instructions) body.instructions = "You are a helpful assistant.";
  }
  const adapter = plan ? "chatgpt-plan" : provider.mimoFree ? "mimo-free" : "api-" + target;
  return {
    adapter, protocol: target, tools: conversation?.tools ?? [], dropped,
    passthrough: target === input.protocol && !(plan && !request.stream),
    events: response => readOutput(response, target),
    async send(key, signal) {
      try {
        let url: string;
        let headers: Record<string, string>;
        let payload: unknown = body;
        if (plan && plan.kind !== "copilot") {
          const destination = planTarget(plan.kind, key ?? "", "/responses"); url = destination.url; headers = destination.headers;
        } else if (provider.mimoFree) {
          const jwt = await mimoJwt(join(dataDir(), "mimo")); url = mimoChatUrl(); headers = mimoHeaders(jwt); payload = withMimoMarker(body);
        } else if (target === "gemini") {
          url = endpointUrl(provider, "gemini", request.model, request.stream);
          headers = { ...(key ? { "x-goog-api-key": key } : {}), ...upstreamHeaders(provider, provider.wire?.authHeader ? key : undefined) };
        } else {
          url = endpointUrl(provider, target);
          headers = target === "messages" ? { ...anthropicHeaders(key, provider), ...request.headers } : upstreamHeaders(provider, key);
        }
        const init: RequestInit = { method: "POST", redirect: "error", signal, headers: { "content-type": "application/json", accept: plan || request.stream ? "text/event-stream" : "application/json", ...headers } };
        const response = await fetch(url, { ...init, body: JSON.stringify(payload) });
        // Claude Code commonly requests 32k output. Retry only an explicit limit rejection,
        // using the same destination, key and source shaping as the original attempt.
        if (input.protocol === "messages" && target === "chat" && response.status === 400 && body.max_tokens !== undefined) {
          const detail = await response.clone().text();
          if (/max[_ ](?:completion[_ ])?tokens/i.test(detail) && /exceed|too (?:large|high)|at most|less than|maximum|limit|range|超出|上限/i.test(detail)) {
            await response.body?.cancel();
            const retry = { ...(payload as Json) }; delete retry.max_tokens;
            dropped.push("max_tokens:upstream_limit");
            return await fetch(url, { ...init, body: JSON.stringify(retry) });
          }
        }
        return response;
      } catch (error) {
        if (provider.mimoFree) return new Error("MiMo Free 请求失败，请检查网络后重试。");
        return error as Error;
      }
    },
  };
}
