/** Kimi's actual outbound protocol is Chat; neutral content is encoded here, never in the dispatcher. */
import type { Provider } from "./types.ts";
import type { Conversation, InboundRequest, Json } from "./protocol.ts";
import { encodeRequest } from "./outbound-format.ts";
import { repairConversation, subscriptionCacheKey } from "./subscription-input.ts";
import { applyEffort, quirksFor, shapeChat } from "./quirks.ts";
import { modelEfforts } from "./model-efforts.ts";
import type { ChatRequest } from "./translate.ts";

const KIMI_MODEL_ENDPOINT = "https://api.kimi.com/coding/v1";
export function conversationToKimi(provider: Provider, value: Conversation, request: InboundRequest): { body: Json; dropped: string[] } {
  const c = repairConversation(value);
  const encoded = encodeRequest(c, request, "chat");
  // Keep vendor-native extra options only for native input, after rebuilding/repairing its content.
  const body: Json = request.protocol === "chat" ? { ...structuredClone(request.body), ...encoded } : encoded;
  const quirks = quirksFor(KIMI_MODEL_ENDPOINT, request.model);
  const style = provider.reasoningEffort === undefined ? quirks.reasoning : provider.reasoningEffort ? "effort" : "none";
  delete body.reasoning_effort;
  const effort = request.effort ?? (style === "effort" ? c.effort : undefined);
  applyEffort(body as ChatRequest, effort, style, modelEfforts({ ...provider, baseUrl: KIMI_MODEL_ENDPOINT }, request.model));
  if (c.effort && (style === "none" || (!request.effort && style !== "effort"))) c.dropped.push("effort:unsupported_kimi");
  shapeChat(body as ChatRequest, { quirks, cacheKey: subscriptionCacheKey(request) });
  if (request.stream && provider.streamUsage) body.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
  return { body, dropped: request.protocol === "chat" ? c.dropped.filter(d => !d.startsWith("field:")) : c.dropped };
}

export async function sendKimiConversation(provider: Provider, token: string | undefined, value: Conversation, request: InboundRequest, endpoint: string, signal: AbortSignal): Promise<Response> {
  if (!token) return Response.json({ error: { type: "kimi_error", message: "没有拿到 Kimi 的有效登录，请回到 EasySwitch 重新登录。" } }, { status: 401 });
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(provider.wire?.headers ?? {})) if (["user-agent", "x-msh-platform", "x-msh-version", "x-msh-device-name", "x-msh-device-model", "x-msh-os-version", "x-msh-device-id"].includes(name.toLowerCase()) && typeof value === "string" && !/[\r\n]/.test(value)) headers[name.toLowerCase()] = value;
  return fetch(`${endpoint}/chat/completions`, {
    method: "POST", redirect: "error", signal,
    headers: { ...headers, "content-type": "application/json", accept: request.stream ? "text/event-stream" : "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(conversationToKimi(provider, value, request).body),
  });
}
