import { randomUUID } from "node:crypto";
import { recordLimitReached } from "../quota.ts";
import type { ChatMessage, ChatRequest } from "../translate.ts";
import type { Provider } from "../types.ts";
import { CursorError } from "./errors.ts";
import type { TurnInput } from "./messages.ts";
import { runTurn, type TurnEvent } from "./transport.ts";

/**
 * Cursor as a model source for the Chat gateway: a Chat Completions request in, a Chat answer (or stream) out.
 * Text only for now: the tools a caller offers are not passed on (Cursor answers in words), and earlier tool calls and
 * results in the history are written into the conversation as plain text.
 */

type Json = Record<string, any>;

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

/** A Chat conversation as Cursor's turn: system apart, history as plain user/assistant messages, the last user message to answer. */
export function chatToTurn(chat: ChatRequest): TurnInput {
  const system: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; text: string }> = [];
  const add = (role: "user" | "assistant", text: string) => {
    if (!text) return;
    const last = turns[turns.length - 1];
    if (last?.role === role) last.text += `\n\n${text}`; else turns.push({ role, text });
  };
  for (const m of chat.messages) {
    if (m.role === "system" || (m.role as string) === "developer") { const t = textOf(m.content); if (t) system.push(t); }
    else if (m.role === "user") add("user", textOf(m.content));
    else if (m.role === "assistant") {
      const calls = (m.tool_calls ?? []).map(c => `[调用了工具 ${c.function.name}，参数 ${c.function.arguments}]`).join("\n");
      add("assistant", [textOf(m.content), calls].filter(Boolean).join("\n"));
    } else add("user", `[工具返回的结果]\n${textOf(m.content)}`);
  }
  const last = turns[turns.length - 1];
  let user = "请继续。";
  if (last?.role === "user") { user = last.text; turns.pop(); }
  return { system: system.join("\n\n"), history: turns, user, modelId: chat.model };
}

const failure = (error: unknown): CursorError => (error instanceof CursorError ? error : new CursorError("Cursor 请求失败，请检查网络或稍后重试。"));

/** One Chat request to Cursor. Failures come back as a Response with the status and a plain reason. */
export async function sendCursor(provider: Provider, token: string | undefined, chat: ChatRequest, signal: AbortSignal, opts: { heartbeatMs?: number; silenceMs?: number } = {}): Promise<Response> {
  const fail = (error: unknown) => {
    const e = failure(error);
    if (e.status === 429) recordLimitReached(provider.id);
    return Response.json({ error: { type: "cursor_error", message: e.message } }, { status: e.status });
  };
  if (!token) return fail(new CursorError("没有拿到 Cursor 的登录，请回到 EasySwitch 重新登录。", 401, true));
  const turn = runTurn({ baseUrl: provider.baseUrl, token, input: chatToTurn(chat), signal, ...opts });
  // The first event decides whether this is an answer or an error, so a failure can still be a proper HTTP error (and a pool can move on).
  let first: IteratorResult<TurnEvent>;
  try { first = await turn.next(); } catch (error) { return fail(error); }

  const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const piece = (delta: Json, finish: string | null = null, usage?: Json) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: chat.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
  const deltaOf = (e: TurnEvent): Json => (e.kind === "text" ? { content: e.text } : e.kind === "thinking" ? { reasoning_content: e.text } : {});

  if (chat.stream) {
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
  return Response.json({ id, object: "chat.completion", created, model: chat.model, choices: [{ index: 0, message, finish_reason: "stop" }], ...(usage ? { usage } : {}) });
}
