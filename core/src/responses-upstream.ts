import type { ChatRequest } from "./translate.ts";

/**
 * Talking to an upstream that only has the Responses API (the ChatGPT plan route is one), for agents
 * that speak Chat Completions, Messages or Gemini to us. Inbound requests are first turned into Chat
 * requests by the handlers; this turns a Chat request into a Responses request, and the Responses
 * event stream that comes back into Chat chunks (or one Chat answer when the caller did not stream),
 * so every handler's existing code for the way back keeps working.
 */

type Json = Record<string, unknown>;

/** Fields this upstream rejects (from OpenAI's preview limitations for ChatGPT plan use). */
const UNSUPPORTED_FIELDS = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt",
  "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
];
/** Tools it does not run (it runs function and custom tools, and web search subject to policy). */
const UNSUPPORTED_TOOLS = new Set(["image_generation", "file_search", "code_interpreter", "computer_use", "computer_use_preview", "mcp", "tool_search"]);

/** A request meant for the Responses API, made acceptable to the ChatGPT plan route. */
export function shapePlanRequest(body: Json): { body: Json; dropped: string[] } {
  const out: Json = { ...body };
  const dropped: string[] = [];
  for (const field of UNSUPPORTED_FIELDS) {
    if (field in out) { delete out[field]; dropped.push(field); }
  }
  out.store = false;
  out.stream = true;
  if (Array.isArray(out.tools)) {
    out.tools = (out.tools as Json[]).filter(t => {
      const bad = UNSUPPORTED_TOOLS.has(String(t.type));
      if (bad) dropped.push(`tool:${String(t.type)}`);
      return !bad;
    });
  }
  // Explicit system items are refused; developer is the same thing in this API.
  if (Array.isArray(out.input)) {
    out.input = (out.input as Json[]).map(item => (item.type === "message" || item.type === undefined) && item.role === "system" ? { ...item, role: "developer" } : item);
  }
  return { body: out, dropped };
}

function contentParts(content: unknown, role: "user" | "assistant"): Json[] {
  const textType = role === "user" ? "input_text" : "output_text";
  if (typeof content === "string") return content ? [{ type: textType, text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Json[] = [];
  for (const part of content as Json[]) {
    if (part.type === "text" && typeof part.text === "string") out.push({ type: textType, text: part.text });
    else if (part.type === "image_url" && role === "user") {
      const url = typeof part.image_url === "string" ? part.image_url : String((part.image_url as Json | undefined)?.url ?? "");
      if (url) out.push({ type: "input_image", image_url: url });
    }
  }
  return out;
}

/** A Chat Completions request as a Responses request for the ChatGPT plan route. */
export function chatToResponses(chat: ChatRequest): { body: Json; dropped: string[] } {
  const raw = chat as unknown as Json;
  const instructions: string[] = [];
  const input: Json[] = [];
  for (const m of chat.messages) {
    const msg = m as unknown as Json;
    if (m.role === "system") {
      const text = contentParts(msg.content, "user").map(p => String(p.text)).join("\n");
      if (text) instructions.push(text);
    } else if (m.role === "user") {
      const content = contentParts(msg.content, "user");
      if (content.length) input.push({ type: "message", role: "user", content });
    } else if (m.role === "assistant") {
      const content = contentParts(msg.content, "assistant");
      if (content.length) input.push({ type: "message", role: "assistant", content });
      for (const call of (msg.tool_calls as Json[] | undefined) ?? []) {
        const fn = (call.function ?? {}) as Json;
        input.push({ type: "function_call", call_id: String(call.id), name: String(fn.name), arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}) });
      }
    } else if (m.role === "tool") {
      const out = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
      input.push({ type: "function_call_output", call_id: String(msg.tool_call_id), output: out });
    }
  }
  const body: Json = { model: chat.model, input, store: false, stream: true };
  if (instructions.length) body.instructions = instructions.join("\n\n");
  const tools = ((raw.tools as Json[] | undefined) ?? []).filter(t => t.type === "function").map(t => {
    const fn = (t.function ?? {}) as Json;
    return { type: "function", name: String(fn.name), description: String(fn.description ?? ""), parameters: fn.parameters ?? { type: "object", properties: {} }, strict: false };
  });
  if (tools.length) body.tools = tools;
  const choice = raw.tool_choice;
  if (choice === "auto" || choice === "none" || choice === "required") body.tool_choice = choice;
  else if (choice && typeof choice === "object") body.tool_choice = { type: "function", name: String(((choice as Json).function as Json | undefined)?.name ?? "") };
  if (typeof raw.parallel_tool_calls === "boolean") body.parallel_tool_calls = raw.parallel_tool_calls;
  if (typeof raw.reasoning_effort === "string") body.reasoning = { effort: raw.reasoning_effort };
  const dropped = ["max_tokens", "temperature", "top_p", "stop", "stream_options"].filter(k => k in raw && raw[k] !== undefined);
  return { body, dropped };
}

// ---------------------------------------------------------------- the way back

interface SseEvent { event: string; data: Json }

async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
      let event = "";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (!data.length || data.join("") === "[DONE]") continue;
      try {
        const json = JSON.parse(data.join("\n")) as Json;
        yield { event: event || String(json.type ?? ""), data: json };
      } catch {
        // A line that is not JSON is skipped.
      }
    }
  }
}

interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens: number } }

function usageOf(response: Json | undefined): Usage | undefined {
  const u = response?.usage as Json | undefined;
  if (!u) return undefined;
  const input = Number(u.input_tokens ?? 0);
  const output = Number(u.output_tokens ?? 0);
  const cached = Number(((u.input_tokens_details ?? {}) as Json).cached_tokens ?? 0);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: Number(u.total_tokens ?? input + output), ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}) };
}

/** What went wrong in a Responses stream, in words. */
function failure(data: Json): { code: string; message: string } {
  const err = (data.error ?? (data.response as Json | undefined)?.error ?? {}) as Json;
  return { code: String(err.code ?? data.code ?? "upstream_error"), message: String(err.message ?? data.message ?? "the upstream failed") };
}

/**
 * Turns the upstream's Responses event stream into Chat Completions chunks (`stream: true`) or one
 * Chat Completions answer. Tool calls keep their ids; reasoning summaries come as `reasoning_content`.
 */
export function responsesToChatResponse(upstream: Response, opts: { stream: boolean; model: string }): Response {
  const id = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Json, finish: string | null = null, usage?: Usage) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: opts.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;

  async function* chunks(): AsyncGenerator<string> {
    const calls = new Map<string, number>(); // item id -> tool call index
    let usage: Usage | undefined;
    yield chunk({ role: "assistant", content: "" });
    for await (const { event, data } of readEvents(upstream.body!)) {
      if (event === "response.output_text.delta" && typeof data.delta === "string") yield chunk({ content: data.delta });
      else if ((event === "response.reasoning_summary_text.delta" || event === "response.reasoning_text.delta") && typeof data.delta === "string") yield chunk({ reasoning_content: data.delta });
      else if (event === "response.output_item.added" && (data.item as Json | undefined)?.type === "function_call") {
        const item = data.item as Json;
        const index = calls.size;
        calls.set(String(item.id), index);
        yield chunk({ tool_calls: [{ index, id: String(item.call_id ?? item.id), type: "function", function: { name: String(item.name), arguments: "" } }] });
      } else if (event === "response.function_call_arguments.delta" && typeof data.delta === "string") {
        const index = calls.get(String(data.item_id));
        if (index !== undefined) yield chunk({ tool_calls: [{ index, function: { arguments: data.delta } }] });
      } else if (event === "response.completed" || event === "response.incomplete") {
        usage = usageOf(data.response as Json | undefined);
        const reason = event === "response.incomplete" ? "length" : calls.size ? "tool_calls" : "stop";
        yield chunk({}, reason, usage);
        yield "data: [DONE]\n\n";
        return;
      } else if (event === "response.failed" || event === "error") {
        const f = failure(data);
        yield `data: ${JSON.stringify({ error: { message: f.message, code: f.code, type: "upstream_error" } })}\n\n`;
        yield "data: [DONE]\n\n";
        return;
      }
    }
    // The stream ended without a terminal event: say so rather than look finished.
    yield `data: ${JSON.stringify({ error: { message: "the upstream stream ended early", code: "stream_interrupted", type: "upstream_error" } })}\n\n`;
    yield "data: [DONE]\n\n";
  }

  if (opts.stream) {
    const encoder = new TextEncoder();
    const gen = chunks();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await gen.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      },
      cancel() { void gen.return(undefined); },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  // Not streaming: read the whole stream and answer once.
  const run = (async () => {
    let text = "";
    let reasoning = "";
    const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    const byItem = new Map<string, number>();
    let usage: Usage | undefined;
    let reason = "stop";
    for await (const { event, data } of readEvents(upstream.body!)) {
      if (event === "response.output_text.delta" && typeof data.delta === "string") text += data.delta;
      else if ((event === "response.reasoning_summary_text.delta" || event === "response.reasoning_text.delta") && typeof data.delta === "string") reasoning += data.delta;
      else if (event === "response.output_item.added" && (data.item as Json | undefined)?.type === "function_call") {
        const item = data.item as Json;
        byItem.set(String(item.id), calls.length);
        calls.push({ id: String(item.call_id ?? item.id), type: "function", function: { name: String(item.name), arguments: "" } });
      } else if (event === "response.function_call_arguments.delta" && typeof data.delta === "string") {
        const at = byItem.get(String(data.item_id));
        if (at !== undefined) calls[at]!.function.arguments += data.delta;
      } else if (event === "response.completed" || event === "response.incomplete") {
        usage = usageOf(data.response as Json | undefined);
        reason = event === "response.incomplete" ? "length" : calls.length ? "tool_calls" : "stop";
        break;
      } else if (event === "response.failed" || event === "error") {
        const f = failure(data);
        return new Response(JSON.stringify({ error: { message: f.message, code: f.code, type: "upstream_error" } }), { status: 502, headers: { "content-type": "application/json" } });
      }
    }
    const message: Json = { role: "assistant", content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
    return new Response(JSON.stringify({ id, object: "chat.completion", created, model: opts.model, choices: [{ index: 0, message, finish_reason: reason }], ...(usage ? { usage } : {}) }), { status: 200, headers: { "content-type": "application/json" } });
  })();
  // A Response whose body is produced once the stream has been read.
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      const res = await run;
      controller.enqueue(new Uint8Array(await res.arrayBuffer()));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
