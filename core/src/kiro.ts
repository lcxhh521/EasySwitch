// Wire format and event handling follow opencodex's Kiro adapter (MIT), commit 5841269073b3898e5dd3ac9dcd956c7e56c1bb34,
// as adapted in this repository's earlier snapshot; the request builder and the Chat side are rewritten for EasySwitch's
// Chat outbound. Copyright (c) 2026 opencodex contributors. See third_party/opencodex/LICENSE.
import { randomUUID } from "node:crypto";
import { decodeEventStream } from "./aws-eventstream.ts";
import { KiroError, readKiroLogin, type KiroLogin } from "./kiro-login.ts";
import { kiroToolSchema } from "./kiro-schema.ts";
import type { ChatMessage, ChatRequest } from "./translate.ts";
import type { Provider } from "./types.ts";

/**
 * Kiro (Amazon's coding agent) as a model source. The user's own Kiro CLI login is read from its local
 * database for each request and sent only to Kiro's fixed hosts: nothing is copied, refreshed or written.
 * A Chat Completions request goes in; Kiro's AWS event stream comes back and is turned into Chat chunks,
 * so every inbound protocol the gateway speaks works with it.
 */

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
  assistantResponseMessage?: { content: string; toolUses?: ToolUse[] };
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

/** Asked for explicitly (importing the login, refreshing the list), never by the console's polling. */
export async function listKiroModels(loginPath?: string): Promise<{ models: string[]; region: string }> {
  const login = await readKiroLogin(loginPath);
  const url = new URL(process.env.EASYSWITCH_KIRO_MANAGEMENT ?? `https://management.${login.region}.kiro.dev/`);
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

/** Short aliases for identifiers Kiro does not accept as they are (its limit is 64 characters of [A-Za-z0-9_-]). */
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

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

/** A Chat Completions request as Kiro's conversation state. */
export function chatToKiro(chat: ChatRequest, login: KiroLogin): { body: Json; restoreName: (name: string) => string; dropped: string[] } {
  const choice = chat.tool_choice;
  if (choice !== undefined && choice !== null && choice !== "auto" && choice !== "none") throw new KiroError("Kiro 暂不支持强制指定工具调用。", 400);
  const specs = choice === "none" ? [] : (chat.tools ?? []).filter(t => t.type === "function").map(t => t.function as Json);
  const calls = chat.messages.flatMap(m => m.tool_calls ?? []);
  const names = aliases([...specs.map(t => String(t.name)), ...calls.map(c => c.function.name)]);
  const ids = aliases([...calls.map(c => c.id), ...chat.messages.filter(m => m.role === "tool").map(m => String(m.tool_call_id ?? ""))]);
  const tools = specs.map(t => ({ toolSpecification: { name: names.get(String(t.name)), description: String(t.description || t.name).slice(0, 1024), inputSchema: { json: kiroToolSchema(t.parameters) } } }));
  const origin = login.builderId || !login.profileArn ? "KIRO_CLI" : "AI_EDITOR";
  const history: Entry[] = [];
  const user = (): UserMessage => {
    const last = history.at(-1)?.userInputMessage;
    if (last) return last;
    const message: UserMessage = { content: "", modelId: chat.model, origin };
    history.push({ userInputMessage: message });
    return message;
  };
  const systems: string[] = [];
  for (const m of chat.messages) {
    const text = textOf(m.content);
    if (m.role === "system") { systems.push(text); continue; }
    if (m.role === "assistant") {
      if (!history.length) user().content = "Continue.";
      let assistant = history.at(-1)?.assistantResponseMessage;
      if (!assistant) { assistant = { content: "" }; history.push({ assistantResponseMessage: assistant }); }
      assistant.content += (assistant.content && text ? "\n\n" : "") + text;
      for (const call of m.tool_calls ?? []) {
        let input: Json;
        try { input = JSON.parse(call.function.arguments || "{}"); } catch { throw new KiroError("工具调用历史中的参数不是有效 JSON。", 400); }
        assistant.toolUses = [...(assistant.toolUses ?? []), { name: names.get(call.function.name), input, toolUseId: ids.get(call.id) }];
      }
      continue;
    }
    const message = user();
    if (m.role === "tool") {
      const context = message.userInputMessageContext ??= {};
      context.toolResults = [...(context.toolResults ?? []), { toolUseId: ids.get(String(m.tool_call_id ?? "")), content: [{ text: text || "(empty tool result)" }], status: "success" }];
      continue;
    }
    message.content += (message.content && text ? "\n\n" : "") + text;
    for (const part of Array.isArray(m.content) ? m.content : []) {
      if (part.type !== "image_url") continue;
      const image = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(part.image_url.url);
      if (!image) throw new KiroError("Kiro 图片需要 PNG/JPEG/GIF/WebP 的 base64 data URL。", 400);
      message.images = [...(message.images ?? []), { format: image[1]!, source: { bytes: image[2]!.replace(/\s/g, "") } }];
    }
  }
  const current = user();
  if (tools.length) (current.userInputMessageContext ??= {}).tools = tools;
  for (const entry of history) if (entry.userInputMessage && !entry.userInputMessage.content) entry.userInputMessage.content = "Continue.";
  const first = history[0]!.userInputMessage!;
  if (systems.length) first.content = systems.join("\n\n") + "\n\n" + first.content;
  history.pop();
  const dropped = (["max_tokens", "temperature", "top_p", "parallel_tool_calls"] as const).filter(name => chat[name] !== undefined);
  return {
    restoreName: names.restore, dropped,
    body: {
      conversationState: {
        chatTriggerType: "MANUAL", conversationId: randomUUID(),
        ...(origin === "KIRO_CLI" ? { agentContinuationId: randomUUID(), agentTaskType: "vibe" } : {}),
        currentMessage: { userInputMessage: current }, ...(history.length ? { history } : {}),
      },
      ...(login.profileArn ? { profileArn: login.profileArn } : {}),
    },
  };
}

interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens: number } }
type Piece = { delta: Json; finish?: string; usage?: Usage };

/** Kiro's event stream as Chat deltas, the last one carrying the finish reason. */
async function* kiroPieces(source: ReadableStream<Uint8Array>, restoreName: (name: string) => string): AsyncGenerator<Piece> {
  let toolIndex = -1; let openTool: { id: string; input: string } | undefined; let stop = ""; let usage: Usage | undefined;
  for await (const event of decodeEventStream(source)) {
    const type = event.headers[":event-type"];
    if (["exception", "error"].includes(event.headers[":message-type"] ?? "") || type === "error" || type === "invalidStateEvent") throw new KiroError("Kiro 在生成过程中返回错误，请重试或检查会话上下文。");
    if (!["assistantResponseEvent", "reasoningContentEvent", "toolUseEvent", "metadataEvent"].includes(type ?? "")) continue;
    let data: Json;
    try { data = JSON.parse(new TextDecoder().decode(event.payload)); } catch { throw new KiroError("Kiro 返回了无效的事件数据。"); }
    if (type === "assistantResponseEvent" && typeof data.content === "string") yield { delta: { content: data.content } };
    else if (type === "reasoningContentEvent" && typeof data.text === "string") yield { delta: { reasoning_content: data.text } };
    else if (type === "toolUseEvent") {
      const args = typeof data.input === "string" ? data.input : "";
      if (!openTool) {
        if (!data.toolUseId || !data.name) throw new KiroError("Kiro 工具调用缺少名称或标识。");
        openTool = { id: data.toolUseId, input: "" }; toolIndex++;
        yield { delta: { tool_calls: [{ index: toolIndex, id: data.toolUseId, type: "function", function: { name: restoreName(data.name), arguments: args } }] } };
      } else {
        if (data.toolUseId && data.toolUseId !== openTool.id) throw new KiroError("Kiro 工具调用在结束前切换了标识。");
        if (args) yield { delta: { tool_calls: [{ index: toolIndex, function: { arguments: args } }] } };
      }
      openTool.input += args;
      if (data.stop) {
        try { JSON.parse(openTool.input || "{}"); } catch { throw new KiroError("Kiro 工具参数不完整，请重试。"); }
        openTool = undefined;
      }
    } else if (type === "metadataEvent") {
      stop = typeof data.stopReason === "string" ? data.stopReason.toUpperCase() : stop;
      const u = data.tokenUsage;
      if (u) {
        const cached = Number(u.cacheReadInputTokens ?? 0);
        const input = Number(u.uncachedInputTokens ?? 0) + cached + Number(u.cacheWriteInputTokens ?? 0);
        const output = Number(u.outputTokens ?? 0);
        usage = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output, ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}) };
      }
    }
  }
  if (openTool || !["END_TURN", "STOP_SEQUENCE", "TOOL_USE", "MAX_TOKENS", "CONTENT_FILTERED"].includes(stop) || (stop === "TOOL_USE" && toolIndex < 0)) throw new KiroError("Kiro 响应未收到有效结束状态，请重试。");
  yield { delta: {}, finish: stop === "MAX_TOKENS" ? "length" : stop === "CONTENT_FILTERED" ? "content_filter" : toolIndex >= 0 ? "tool_calls" : "stop", ...(usage ? { usage } : {}) };
}

/** Kiro's answer as a Chat Completions stream (`stream: true`) or one Chat answer. */
export function kiroToChatResponse(upstream: Response, opts: { stream: boolean; model: string; restoreName: (name: string) => string }): Response | Promise<Response> {
  const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (piece: Piece) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: opts.model, choices: [{ index: 0, delta: piece.delta, finish_reason: piece.finish ?? null }], ...(piece.usage ? { usage: piece.usage } : {}) })}\n\n`;
  const failure = (error: unknown) => (error instanceof KiroError ? error : new KiroError("Kiro 请求失败，请检查网络或稍后重试。"));

  if (opts.stream) {
    const encoder = new TextEncoder();
    const pieces = kiroPieces(upstream.body!, opts.restoreName);
    let started = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) { started = true; controller.enqueue(encoder.encode(chunk({ delta: { role: "assistant", content: "" } }))); return; }
        try {
          const next = await pieces.next();
          if (next.done) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return; }
          controller.enqueue(encoder.encode(chunk(next.value)));
        } catch (error) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: failure(error).message, code: "upstream_error", type: "upstream_error" } })}\n\ndata: [DONE]\n\n`));
          controller.close();
        }
      },
      cancel() { void pieces.return(undefined); },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  return (async () => {
    let text = ""; let reasoning = ""; let finish = "stop"; let usage: Usage | undefined;
    const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    try {
      for await (const piece of kiroPieces(upstream.body!, opts.restoreName)) {
        const d = piece.delta as Json;
        if (typeof d.content === "string") text += d.content;
        if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
        for (const c of (d.tool_calls ?? []) as Json[]) {
          if (c.id) calls[c.index] = { id: c.id, type: "function", function: { name: c.function.name, arguments: c.function.arguments ?? "" } };
          else if (calls[c.index]) calls[c.index]!.function.arguments += c.function.arguments ?? "";
        }
        if (piece.finish) { finish = piece.finish; usage = piece.usage; }
      }
    } catch (error) {
      return Response.json({ error: { message: failure(error).message, code: "upstream_error", type: "upstream_error" } }, { status: failure(error).status });
    }
    const message: Json = { role: "assistant", content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
    return Response.json({ id, object: "chat.completion", created, model: opts.model, choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) });
  })();
}

/** One Chat request to Kiro. Failures come back as a Response with the status and a plain reason. */
export async function sendKiro(provider: Provider, chat: ChatRequest, signal: AbortSignal): Promise<Response> {
  const fail = (error: unknown) => {
    const e = error instanceof KiroError ? error : new KiroError("Kiro 请求失败，请检查网络或稍后重试。");
    return Response.json({ error: { type: "kiro_error", message: e.message } }, { status: e.status });
  };
  try {
    const login = await readKiroLogin(provider.kiro?.loginPath);
    const prepared = chatToKiro(chat, login);
    const cli = login.builderId || !login.profileArn;
    const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
    const ua = "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererstreaming/0.1.17975 os/" + platform + " lang/rust/1.92.0 m/F app/AmazonQ-For-CLI";
    const host = process.env.EASYSWITCH_KIRO_RUNTIME ?? `https://runtime.${login.region}.kiro.dev/`;
    const upstream = await fetch(host, {
      method: "POST", redirect: "error", signal,
      headers: {
        ...headers(login, "AmazonCodeWhispererStreamingService.GenerateAssistantResponse"), accept: "application/vnd.amazon.eventstream",
        "user-agent": cli ? ua + " md/appVersion-2.14.2" : "aws-sdk-js/1.0.27 KiroIDE-1.0.0",
        "x-amz-user-agent": cli ? ua : "aws-sdk-js/1.0.27 KiroIDE-1.0.0", "amz-sdk-invocation-id": randomUUID(),
        ...(!cli ? { "x-amzn-kiro-agent-mode": "vibe" } : {}), ...(login.profileArn ? { "x-amzn-kiro-profile-arn": login.profileArn } : {}),
      },
      body: JSON.stringify(prepared.body),
    });
    if (!upstream.ok) { await upstream.body?.cancel(); throw upstreamError(upstream.status); }
    return await kiroToChatResponse(upstream, { stream: chat.stream, model: chat.model, restoreName: prepared.restoreName });
  } catch (error) {
    return fail(error);
  }
}
