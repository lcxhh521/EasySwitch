/**
 * Dedicated subscription dispatcher. Each vendor consumes neutral Conversation directly.
 * Existing login boundaries and vendor output parsers remain intact. No account is read here.
 */
import { isAbsolute } from "node:path";
import type { Provider } from "./types.ts";
import type { PreparedOutbound } from "./outbound.ts";
import { decodeRequest } from "./inbound.ts";
import { ProtocolError, type InboundRequest } from "./protocol.ts";
import { readOutput } from "./upstream-events.ts";
import { upstreamModelId } from "./quirks.ts";
import { conversationToKiro, sendKiroConversation } from "./kiro.ts";
import { sendAntigravityConversation } from "./antigravity.ts";
import { conversationToTurn, sendCursorConversation } from "./cursor/adapter.ts";
import { CURSOR_API } from "./cursor/transport.ts";
import { kimiApi } from "./kimi.ts";
import { conversationToGemini } from "./gemini-upstream.ts";
import { conversationToKimi, sendKimiConversation } from "./kimi-upstream.ts";

export type ExistingSubscriptionKind = "kiro" | "antigravity" | "cursor" | "kimi";

function accountConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return !Object.keys(config).some(k => !["accountId", "email"].includes(k))
    && typeof config.accountId === "string" && /^[a-z0-9][a-z0-9-]{0,255}$/.test(config.accountId)
    && (config.email === undefined || (typeof config.email === "string" && config.email.length <= 320 && config.email.trim().length > 0 && !/[\r\n]/.test(config.email)));
}

/** Native account tokens never follow an arbitrary persisted source URL or wire override. */
function accountEndpoint(kind: "cursor" | "kimi"): string {
  const base = kind === "cursor" ? process.env.EASYSWITCH_CURSOR_API ?? CURSOR_API : kimiApi();
  let url: URL;
  try { url = new URL(base); } catch { throw new ProtocolError("订阅来源地址无效。", 400); }
  const local = process.env.EASYSWITCH_TEST_SUBSCRIPTION_FIXTURES === "1" && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  const official = url.protocol === "https:" && !url.port && (kind === "cursor" ? url.hostname === "api2.cursor.sh" : ["api.kimi.com", "api.kimi.ai"].includes(url.hostname));
  const path = url.pathname.replace(/\/+$/, "");
  if ((!local && !official) || url.username || url.password || url.search || url.hash || (kind === "cursor" ? path !== "" : path !== "/coding/v1")) throw new ProtocolError("订阅令牌只能发送到对应厂商的固定入口；本地测试必须显式使用数字环回夹具。", 400);
  return url.origin + path;
}


export function existingSubscriptionKind(provider: Provider): ExistingSubscriptionKind | undefined {
  const present = ["kiro", "antigravity", "cursor", "kimi"] as const;
  if (present.some(k => provider[k] !== undefined)) {
    const auth = [...present.map(k => provider[k]), provider.plan, provider.vertex].filter(v => v !== undefined).length + (provider.mimoFree ? 1 : 0);
    if (auth > 1) throw new ProtocolError("一个来源不能同时声明多种专用鉴权。", 400);
  }
  for (const kind of ["cursor", "kimi"] as const) if (provider[kind] !== undefined) {
    if (!accountConfig(provider[kind])) throw new ProtocolError(`${kind === "kimi" ? "Kimi" : "Cursor"} 来源配置无效，请使用它的专用登录入口。`, 400);
    return kind;
  }
  if (provider.kiro !== undefined) {
    const config = provider.kiro;
    if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(k => k !== "loginPath") || (config.loginPath !== undefined && (typeof config.loginPath !== "string" || !isAbsolute(config.loginPath)))) throw new ProtocolError("Kiro 来源配置无效，请使用它的专用导入入口。", 400);
    if (provider.antigravity || provider.plan || provider.vertex || provider.mimoFree) throw new ProtocolError("一个来源不能同时声明多种专用鉴权。", 400);
    return "kiro";
  }
  if (provider.antigravity !== undefined) {
    const config = provider.antigravity;
    if (!config || typeof config !== "object" || Array.isArray(config) || Object.keys(config).some(k => !["accountId", "email", "projectId"].includes(k)) || ![config.accountId, config.email, config.projectId].every(v => typeof v === "string" && v.length > 0)) throw new ProtocolError("Antigravity 来源配置无效，请使用它的专用登录入口。", 400);
    if (provider.plan || provider.vertex || provider.mimoFree) throw new ProtocolError("一个来源不能同时声明多种专用鉴权。", 400);
    return "antigravity";
  }
  return undefined;
}
export function prepareExistingSubscription(provider: Provider, input: InboundRequest): PreparedOutbound {
  const kind = existingSubscriptionKind(provider);
  if (!kind) throw new ProtocolError("没有已登记的专用订阅适配器。", 400);
  const endpoint = kind === "kimi" || kind === "cursor" ? accountEndpoint(kind) : undefined;
  const request = { ...input, model: upstreamModelId(input.model), source: provider.id };
  const conversation = decodeRequest(request);
  // Pure preparation validates unsupported content before key lookup/native account reads.
  const dropped = kind === "kiro" ? conversationToKiro(conversation, request, { accessToken: "", region: "", builderId: true }).dropped
    : kind === "antigravity" ? conversationToGemini(conversation, request).dropped
    : kind === "cursor" ? conversationToTurn(conversation, request.model).dropped
    : conversationToKimi(provider, conversation, request).dropped;
  return { adapter: `${kind}-conversation`, protocol: "chat", passthrough: input.protocol === "chat", tools: kind === "cursor" ? [] : conversation.tools, dropped,
    events: response => readOutput(response, "chat"),
    async send(key, signal) {
      try {
        signal.throwIfAborted();
        if (kind === "cursor") return await sendCursorConversation({ ...provider, baseUrl: endpoint! }, key, conversation, request, signal);
        if (kind === "kimi") return await sendKimiConversation(provider, key, conversation, request, endpoint!, signal);
        return kind === "kiro" ? await sendKiroConversation(provider, conversation, request, signal) : await sendAntigravityConversation(provider, key, conversation, request, signal);
      } catch { return new Error("订阅适配器请求未完成。"); }
    },
  };
}
