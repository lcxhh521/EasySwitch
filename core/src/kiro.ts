// Adapted from opencodex's Kiro wire, payload and event handling (MIT), commit 5841269073b3898e5dd3ac9dcd956c7e56c1bb34.
// Copyright (c) 2026 opencodex contributors. See third_party/opencodex/LICENSE.
import { randomUUID } from "node:crypto";
import { decodeEventStream } from "./aws-eventstream.ts";
import { KiroError, readKiroLogin, type KiroLogin } from "./kiro-login.ts";
import { kiroToolSchema } from "./kiro-schema.ts";
import { decodeRequest } from "./inbound.ts";
import { unpackState, type Conversation, type InboundRequest, type OutputEvent } from "./protocol.ts";
import type { Provider } from "./types.ts";
import type { PreparedOutbound } from "./outbound.ts";

type Json = Record<string, any>;
interface ToolUse { name: string; input: Json; toolUseId: string }
interface ToolResult { content: Array<{ text: string }>; status: string; toolUseId: string }
interface UserMessage {
  content: string; modelId: string; origin: string;
  images?: Array<{ format: string; source: { bytes: string } }>;
  userInputMessageContext?: { tools?: unknown[]; toolResults?: ToolResult[] };
}
interface Entry {
  userInputMessage?: UserMessage;
  assistantResponseMessage?: { content: string; toolUses?: ToolUse[]; reasoningContent?: Json };
}

function headers(login: KiroLogin, target: string): Record<string, string> {
  return {
    authorization: `Bearer ${login.accessToken}`,
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": target,
    "x-amzn-codewhisperer-optout": "true",
  };
}

function upstreamError(status: number): KiroError {
  const detail = status === 401 || status === 403 ? "请在 Kiro CLI 检查登录和订阅权限后重试。"
    : status === 429 ? "额度不足或请求过于频繁，请稍后重试。" : "请稍后重试。";
  return new KiroError(`Kiro 返回 HTTP ${status}；${detail}`, status >= 400 ? status : 502);
}

/** Discovery is performed explicitly, never by the console's polling refresh. */
export async function listKiroModels(loginPath?: string): Promise<{ models: string[]; region: string }> {
  const login = await readKiroLogin(loginPath);
  const url = new URL(`https://management.${login.region}.kiro.dev/`);
  url.searchParams.set("origin", "AI_EDITOR");
  if (login.profileArn) url.searchParams.set("profileArn", login.profileArn);
  const response = await fetch(url, {
    method: "POST", redirect: "error",
    headers: { ...headers(login, "KiroControlPlaneBearerService.ListAvailableModels"), accept: "application/json" },
    body: JSON.stringify({ origin: "AI_EDITOR", profileArn: login.profileArn }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) { await response.body?.cancel(); throw upstreamError(response.status); }
  const body = await response.json() as Json;
  const models = [...new Set<string>((body.models ?? []).map((m: Json) => m.modelId).filter((id: unknown) => typeof id === "string" && id.length > 0))];
  if (!models.length) throw new KiroError("Kiro 没有返回可用模型，请检查订阅权限。");
  return { models, region: login.region };
}

/** Short aliases for Kiro's 64-character tool identifiers, shared by specs and history. */
function aliases(originals: string[]) {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const reserved = new Set(originals.filter(n => /^[a-zA-Z0-9_-]{1,64}$/.test(n)));
  let next = 0;
  for (const original of originals) {
    if (forward.has(original)) continue;
    let wire = original;
    if (!reserved.has(original)) {
      do { wire = `es_tool_${next++}`; } while (reserved.has(wire));
      reserved.add(wire);
    }
    forward.set(original, wire); reverse.set(wire, original);
  }
  return { get: (name: string) => forward.get(name) ?? name, restore: (name: string) => reverse.get(name) ?? name };
}

export function kiroRequest(c: Conversation, request: InboundRequest, login: KiroLogin) {
  if (c.format && c.format.type !== "text") throw new KiroError("Kiro 暂不支持结构化输出。", 400);
  if (c.choice && c.choice !== "auto" && c.choice !== "none") throw new KiroError("Kiro 暂不支持强制指定工具调用。", 400);
  const specs = c.choice === "none" ? [] : c.tools;
  const parts = c.turns.flatMap(t => t.parts);
  const calls = parts.filter(p => p.type === "call");
  const names = aliases([...specs.map(t => t.name), ...calls.map(p => p.name)]);
  const ids = aliases([...calls.map(p => p.id), ...parts.filter(p => p.type === "result").map(p => p.id)]);
  const tools = specs.map(t => ({ toolSpecification: { name: names.get(t.name), description: (t.description || t.name).slice(0, 1024), inputSchema: { json: kiroToolSchema(t.parameters) } } }));
  const history: Entry[] = [];
  const origin = login.builderId || !login.profileArn ? "KIRO_CLI" : "AI_EDITOR";
  const user = (): UserMessage => {
    const last = history.at(-1)?.userInputMessage;
    if (last) return last;
    const message: UserMessage = { content: "", modelId: request.model, origin };
    history.push({ userInputMessage: message }); return message;
  };
  const systems: string[] = [];
  for (const turn of c.turns) {
    if (turn.parts.some(p => p.type === "native")) throw new KiroError("Kiro 暂不支持请求中的原生内容块。", 400);
    const text = turn.parts.filter(p => p.type === "text").map(p => p.text).join("\n");
    if (turn.role === "system" || turn.role === "developer") { systems.push(text); continue; }
    if (turn.role === "assistant") {
      if (!history.length) user().content = "Continue.";
      let assistant = history.at(-1)?.assistantResponseMessage;
      if (!assistant) { assistant = { content: "" }; history.push({ assistantResponseMessage: assistant }); }
      assistant.content += (assistant.content && text ? "\n\n" : "") + text;
      for (const p of turn.parts) {
        if (p.type === "call") {
          let input;
          try { input = JSON.parse(p.arguments || "{}"); } catch { throw new KiroError("工具调用历史中的参数不是有效 JSON。", 400); }
          assistant.toolUses = [...(assistant.toolUses ?? []), { name: names.get(p.name), input, toolUseId: ids.get(p.id) }];
        } else if (p.type === "reasoning") {
          const state = unpackState(p.signature ?? p.encrypted, request.source ?? "", request.model);
          if (state?.protocol === "kiro") {
            // A .KTR signature is not base64: retain which AWS wire field it came from.
            assistant.reasoningContent = state.signature ? { signature: state.signature } : { redactedContent: state.encrypted };
          } else if (p.signature || p.encrypted) c.dropped.push("reasoning:foreign_state");
        } else if (p.type === "image" || p.type === "result") throw new KiroError("Kiro assistant 历史中不支持图片或工具结果。", 400);
      }
      continue;
    }
    const message = user();
    message.content += (message.content && text ? "\n\n" : "") + text;
    for (const p of turn.parts) {
      if (p.type === "result") {
        const context = message.userInputMessageContext ??= {};
        const value = typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
        context.toolResults = [...(context.toolResults ?? []), { toolUseId: ids.get(p.id), content: [{ text: value || "(empty tool result)" }], status: p.error ? "error" : "success" }];
      } else if (p.type === "image") {
        const image = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(p.url);
        if (!image) throw new KiroError("Kiro 图片需要 PNG/JPEG/GIF/WebP 的 base64 data URL。", 400);
        message.images = [...(message.images ?? []), { format: image[1]!, source: { bytes: image[2]!.replace(/\s/g, "") } }];
      }
    }
  }
  const current = user();
  if (tools.length) (current.userInputMessageContext ??= {}).tools = tools;
  for (const entry of history) if (entry.userInputMessage && !entry.userInputMessage.content) entry.userInputMessage.content = "Continue.";
  const first = history[0]!.userInputMessage!;
  if (systems.length) first.content = systems.join("\n\n") + "\n\n" + first.content;
  history.pop();
  for (const name of ["maxTokens", "temperature", "topP", "stop", "effort", "parallelTools"] as const) if (c[name] !== undefined) c.dropped.push(name);
  return {
    restoreName: names.restore,
    body: { conversationState: { chatTriggerType: "MANUAL", conversationId: randomUUID(),
      ...(origin === "KIRO_CLI" ? { agentContinuationId: randomUUID(), agentTaskType: "vibe" } : {}),
      currentMessage: { userInputMessage: current }, ...(history.length ? { history } : {}),
    }, ...(login.profileArn ? { profileArn: login.profileArn } : {}) },
  };
}

export async function* kiroEvents(source: ReadableStream<Uint8Array>, restoreName: (name: string) => string): AsyncGenerator<OutputEvent> {
  let toolIndex = -1; let openTool: { id: string; input: string } | undefined; let stop = "";
  for await (const event of decodeEventStream(source)) {
    const type = event.headers[":event-type"];
    if (["exception", "error"].includes(event.headers[":message-type"] ?? "") || type === "error" || type === "invalidStateEvent") throw new KiroError("Kiro 在生成过程中返回错误，请重试或检查会话上下文。");
    if (!["assistantResponseEvent", "reasoningContentEvent", "toolUseEvent", "metadataEvent"].includes(type ?? "")) continue;
    let data: Json;
    try { data = JSON.parse(new TextDecoder().decode(event.payload)); } catch { throw new KiroError("Kiro 返回了无效的事件数据。"); }
    if (type === "assistantResponseEvent" && typeof data.content === "string") yield { type: "text", text: data.content };
    else if (type === "reasoningContentEvent") yield { type: "reasoning", text: data.text, signature: data.signature, encrypted: data.redactedContent };
    else if (type === "toolUseEvent") {
      const args = typeof data.input === "string" ? data.input : "";
      if (!openTool) {
        if (!data.toolUseId || !data.name) throw new KiroError("Kiro 工具调用缺少名称或标识。");
        openTool = { id: data.toolUseId, input: "" }; toolIndex++;
        yield { type: "call", index: toolIndex, id: data.toolUseId, name: restoreName(data.name), arguments: args };
      } else {
        if (data.toolUseId && data.toolUseId !== openTool.id) throw new KiroError("Kiro 工具调用在结束前切换了标识。");
        if (args) yield { type: "arguments", index: toolIndex, text: args };
      }
      openTool.input += args;
      if (data.stop) {
        try { JSON.parse(openTool.input || "{}"); } catch { throw new KiroError("Kiro 工具参数不完整，请重试。"); }
        openTool = undefined;
      }
    } else if (type === "metadataEvent") {
      stop = typeof data.stopReason === "string" ? data.stopReason.toUpperCase() : stop;
      const u = data.tokenUsage;
      if (u) yield { type: "usage", usage: { input: (u.uncachedInputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0), output: u.outputTokens ?? 0, cached: u.cacheReadInputTokens, cacheWrite: u.cacheWriteInputTokens } };
    }
  }
  if (openTool || !["END_TURN", "STOP_SEQUENCE", "TOOL_USE", "MAX_TOKENS", "CONTENT_FILTERED"].includes(stop) || (stop === "TOOL_USE" && toolIndex < 0)) throw new KiroError("Kiro 响应未收到有效结束状态，请重试。");
  yield { type: "stop", reason: stop === "MAX_TOKENS" ? "length" : stop === "CONTENT_FILTERED" ? "filter" : toolIndex >= 0 ? "tool" : "stop" };
}

export function prepareKiro(provider: Provider, request: InboundRequest): PreparedOutbound {
  const conversation = decodeRequest(request);
  let restoreName = (name: string) => name;
  return {
    adapter: "kiro", protocol: "kiro", passthrough: false, tools: conversation.tools, dropped: conversation.dropped,
    events: response => kiroEvents(response.body!, restoreName),
    async send(_key, signal) {
      try {
        const login = await readKiroLogin(provider.kiro!.loginPath);
        const prepared = kiroRequest(conversation, request, login); restoreName = prepared.restoreName;
        const cli = login.builderId || !login.profileArn;
        const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
        const ua = "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/" + platform + " lang/rust/1.92.0 m/F app/AmazonQ-For-CLI";
        const upstream = await fetch("https://runtime." + login.region + ".kiro.dev/", {
          method: "POST", redirect: "error", signal,
          headers: { ...headers(login, "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"), accept: "application/vnd.amazon.eventstream",
            "user-agent": cli ? ua + " md/appVersion-2.14.2" : "aws-sdk-js/1.0.27 KiroIDE-1.0.0",
            "x-amz-user-agent": cli ? ua : "aws-sdk-js/1.0.27 KiroIDE-1.0.0", "amz-sdk-invocation-id": randomUUID(),
            ...(!cli ? { "x-amzn-kiro-agent-mode": "vibe" } : {}), ...(login.profileArn ? { "x-amzn-kiro-profile-arn": login.profileArn } : {}),
          }, body: JSON.stringify(prepared.body),
        });
        if (!upstream.ok) { await upstream.body?.cancel(); throw upstreamError(upstream.status); }
        return upstream;
      } catch (error) {
        const failure = error instanceof KiroError ? error : new KiroError("Kiro 请求失败，请检查网络或稍后重试。");
        return Response.json({ error: { type: "kiro_error", message: failure.message } }, { status: failure.status });
      }
    },
  };
}
