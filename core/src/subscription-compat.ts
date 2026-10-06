/**
 * Compatibility boundary for Claude-owned B20 modules from the approved dev handoff.
 * They retain their own login/wire implementations and return Chat-shaped results.
 * New ordinary APIs still use the neutral four-protocol layer. No account is read here.
 */
import { isAbsolute } from "node:path";
import type { Provider } from "./types.ts";
import type { PreparedOutbound } from "./outbound.ts";
import { decodeRequest } from "./inbound.ts";
import { encodeRequest } from "./outbound-format.ts";
import { ProtocolError, type InboundRequest } from "./protocol.ts";
import { readOutput } from "./upstream-events.ts";
import { quirksFor, shapeChat, upstreamModelId } from "./quirks.ts";
import type { ChatRequest } from "./translate.ts";
import { sendKiro } from "./kiro.ts";
import { sendAntigravity } from "./antigravity.ts";
import { sendCursor } from "./cursor/adapter.ts";
import { CURSOR_API } from "./cursor/transport.ts";
import { kimiApi } from "./kimi.ts";

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
  const conversation = input.protocol === "chat" ? undefined : decodeRequest(request);
  const body = conversation ? encodeRequest(conversation, request, "chat") : structuredClone(input.body);
  body.model = request.model; body.stream = request.stream;
  const dropped = conversation?.dropped ?? [];
  if (kind === "cursor") {
    if (Array.isArray(body.tools) && body.tools.length) dropped.push("tools:cursor_text_only");
    if (body.messages?.some((m: { role?: string; tool_calls?: unknown[] }) => m.role === "tool" || m.tool_calls?.length)) dropped.push("tool_history:cursor_text_only");
    if (body.messages?.some((m: { content?: unknown }) => Array.isArray(m.content) && m.content.some((p: { type?: string }) => p.type !== "text"))) dropped.push("media:cursor_text_only");
  }
  if (kind === "kimi") {
    if (conversation) delete body.reasoning_effort;
    shapeChat(body as ChatRequest, { quirks: quirksFor(endpoint!, request.model), ...(typeof request.body.prompt_cache_key === "string" ? { cacheKey: request.body.prompt_cache_key } : {}) });
  }
  const kimiHeaders: Record<string, string> = {};
  if (kind === "kimi") for (const [name, value] of Object.entries(provider.wire?.headers ?? {})) {
    if (["user-agent", "x-msh-platform", "x-msh-version", "x-msh-device-name", "x-msh-device-model", "x-msh-os-version", "x-msh-device-id"].includes(name.toLowerCase()) && typeof value === "string" && !/[\r\n]/.test(value)) kimiHeaders[name.toLowerCase()] = value;
  }
  if (request.effort) dropped.push("effort:legacy_subscription_adapter");
  return { adapter: `${kind}-compat`, protocol: "chat", passthrough: input.protocol === "chat", tools: conversation?.tools ?? [], dropped,
    events: response => readOutput(response, "chat"),
    async send(key, signal) {
      try {
        signal.throwIfAborted();
        if (kind === "cursor") return await sendCursor({ ...provider, baseUrl: endpoint! }, key, body as ChatRequest, signal);
        if (kind === "kimi") {
          if (!key) return Response.json({ error: { type: "kimi_error", message: "没有拿到 Kimi 的有效登录，请回到 EasySwitch 重新登录。" } }, { status: 401 });
          return await fetch(`${endpoint}/chat/completions`, {
            method: "POST", redirect: "error", signal,
            headers: { ...kimiHeaders, "content-type": "application/json", accept: request.stream ? "text/event-stream" : "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify(body),
          });
        }
        return kind === "kiro" ? await sendKiro(provider, body as ChatRequest, signal) : await sendAntigravity(provider, key, body as ChatRequest, signal);
      } catch { return new Error("订阅适配器请求未完成。"); }
    },
  };
}
