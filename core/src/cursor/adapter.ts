import { randomUUID } from "node:crypto";
import { recordLimitReached } from "../quota.ts";
import type { ChatRequest } from "../translate.ts";
import type { Provider } from "../types.ts";
import { decodeRequest } from "../inbound.ts";
import type { Conversation, InboundRequest } from "../protocol.ts";
import { repairConversation, resultText } from "../subscription-input.ts";
import { CursorError } from "./errors.ts";
import type { TurnInput } from "./messages.ts";
import { runTurn, type TurnEvent } from "./transport.ts";

/**
 * Cursor as a model source for the Chat gateway: a Chat Completions request in, a Chat answer (or stream) out.
 * Text only for now: the tools a caller offers are not passed on (Cursor answers in words), and earlier tool calls and
 * results in the history are written into the conversation as plain text.
 */

type Json = Record<string, any>;

/** Kept for legacy callers; the selected production source receives Conversation directly. */
export function chatToTurn(chat: ChatRequest): TurnInput {
  return conversationToTurn(decodeRequest({ protocol: "chat", body: chat, model: chat.model, stream: chat.stream }), chat.model).turn;
}
export function conversationToTurn(value: Conversation, model: string): { turn: TurnInput; dropped: string[] } {
  const c = repairConversation(value), system: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  const add = (role: "user" | "assistant", text: string) => {
    if (!text) return;
    const last = turns.at(-1); if (last?.role === role) last.text += `\n\n${text}`; else turns.push({ role, text });
  };
  if (c.tools.length || c.choice) c.dropped.push("tools:cursor_text_only");
  for (const t of c.turns) {
    const text: string[] = [];
    for (const p of t.parts) {
      if (p.type === "text") text.push(p.text);
      else if (p.type === "call") { text.push(`[调用了工具 ${p.name}，参数 ${p.arguments}]`); c.dropped.push("tool_history:cursor_text_only"); }
      else if (p.type === "result") { text.push(`[工具返回的结果]\n${resultText(p.content)}`); c.dropped.push("tool_history:cursor_text_only"); }
      else if (p.type === "image") c.dropped.push("media:cursor_text_only");
      else if (p.type === "reasoning") c.dropped.push("reasoning:cursor_text_only");
    }
    if (t.role === "system" || t.role === "developer") system.push(text.join("\n"));
    else add(t.role, text.join("\n"));
  }
  const last = turns.at(-1); let user = "请继续。";
  if (last?.role === "user") { user = last.text; turns.pop(); }
  for (const [name, v] of [["max_tokens", c.maxTokens], ["temperature", c.temperature], ["top_p", c.topP], ["stop", c.stop], ["response_format", c.format], ["effort:cursor", c.effort]] as const) if (v !== undefined) c.dropped.push(name);
  return { turn: { system: system.filter(Boolean).join("\n\n"), history: turns, user, modelId: model }, dropped: c.dropped };
}

const failure = (error: unknown): CursorError => (error instanceof CursorError ? error : new CursorError("Cursor 请求失败，请检查网络或稍后重试。"));

/** One Chat request to Cursor. Failures come back as a Response with the status and a plain reason. */
export async function sendCursor(provider: Provider, token: string | undefined, chat: ChatRequest, signal: AbortSignal, opts: { heartbeatMs?: number; silenceMs?: number } = {}): Promise<Response> {
  const request: InboundRequest = { protocol: "chat", body: chat, model: chat.model, stream: chat.stream };
  return sendCursorConversation(provider, token, decodeRequest(request), request, signal, opts);
}
export async function sendCursorConversation(provider: Provider, token: string | undefined, conversation: Conversation, request: InboundRequest, signal: AbortSignal, opts: { heartbeatMs?: number; silenceMs?: number } = {}): Promise<Response> {
  const fail = (error: unknown) => {
    const e = failure(error);
    if (e.status === 429) recordLimitReached(provider.id);
    return Response.json({ error: { type: "cursor_error", message: e.message } }, { status: e.status });
  };
  if (!token) return fail(new CursorError("没有拿到 Cursor 的登录，请回到 EasySwitch 重新登录。", 401, true));
  const turn = runTurn({ baseUrl: provider.baseUrl, token, input: conversationToTurn(conversation, request.model).turn, signal, ...opts });
  // The first event decides whether this is an answer or an error, so a failure can still be a proper HTTP error (and a pool can move on).
  let first: IteratorResult<TurnEvent>;
  try { first = await turn.next(); } catch (error) { return fail(error); }

  const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const piece = (delta: Json, finish: string | null = null, usage?: Json) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: request.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  const deltaOf = (e: TurnEvent): Json => (e.kind === "text" ? { content: e.text } : e.kind === "thinking" ? { reasoning_content: e.text } : {});

  if (request.stream) {
    const encoder = new TextEncoder();
    let pending: IteratorResult<TurnEvent> | undefined = first;
    let started = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!started) { started = true; controller.enqueue(encoder.encode(piece({ role: "assistant", content: "" }))); return; }
        try {
          const next = pending ?? await turn.next();
          pending = undefined;
          if (next.done) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); return; }
          const e = next.value;
          if (e.kind === "done") controller.enqueue(encoder.encode(piece({}, "stop", e.usage)));
          else controller.enqueue(encoder.encode(piece(deltaOf(e))));
        } catch (error) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: failure(error).message, code: "upstream_error", type: "upstream_error" } })}\n\ndata: [DONE]\n\n`));
          controller.close();
        }
      },
      cancel() { void turn.return(undefined); },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  let text = ""; let reasoning = ""; let usage: Json | undefined;
  try {
    for (let next: IteratorResult<TurnEvent> = first; !next.done; next = await turn.next()) {
      const e = next.value;
      if (e.kind === "text") text += e.text; else if (e.kind === "thinking") reasoning += e.text; else usage = e.usage;
    }
  } catch (error) { return fail(error); }
  const message: Json = { role: "assistant", content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}) };
  return Response.json({ id, object: "chat.completion", created, model: request.model, choices: [{ index: 0, message, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
}
