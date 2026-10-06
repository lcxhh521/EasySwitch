import { randomUUID } from "node:crypto";
import type { ChatMessage, ChatRequest } from "./translate.ts";

/**
 * A Chat Completions request as a Gemini `GenerateContent` body, and Gemini's event stream as Chat chunks.
 * Used for upstreams that speak Gemini (Antigravity's Cloud Code Assist wraps the same body in an envelope).
 * What Gemini has no equivalent for is dropped and listed, never reinterpreted.
 */

type Json = Record<string, any>;

/** Gemini's own signature check wants one on the first function call of a model turn; this value makes it pass when we have none. */
export const THOUGHT_SIGNATURE_BYPASS = "skip_thought_signature_validator";

export class GeminiUpstreamError extends Error {
  status: number;
  constructor(message: string, status = 502) { super(message); this.status = status; }
}

const SCHEMA_KEYS = new Set(["type", "format", "description", "nullable", "enum", "properties", "required", "items", "minItems", "maxItems", "minimum", "maximum", "minLength", "maxLength", "pattern", "anyOf", "title"]);

/** A JSON Schema reduced to the subset Gemini accepts (an OpenAPI 3.0 schema). */
export function geminiSchema(schema: unknown): Json {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  const out: Json = {};
  const s = schema as Json;
  for (const [key, value] of Object.entries(s)) {
    if (key === "const") { out.enum = [value]; continue; }
    if (!SCHEMA_KEYS.has(key)) continue;
    if (key === "type" && Array.isArray(value)) {
      const types = value.filter(t => t !== "null");
      out.type = String(types[0] ?? "string");
      if (value.includes("null")) out.nullable = true;
    } else if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, geminiSchema(v)]));
    } else if (key === "items") out.items = geminiSchema(value);
    else if (key === "anyOf" && Array.isArray(value)) out.anyOf = value.map(v => geminiSchema(v));
    else out[key] = value;
  }
  // Gemini wants a type even with an enum; a schema with neither a type nor alternatives is taken for a string (or an object when it has properties).
  if (out.type === undefined && !out.anyOf) out.type = out.properties ? "object" : "string";
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

/** Function names Gemini accepts are short; longer or odd ones get an alias that is mapped back. */
function nameAliases(originals: string[]) {
  const forward = new Map<string, string>();
  const reverse = new Map<string, string>();
  const ok = (n: string) => /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/.test(n);
  const used = new Set(originals.filter(ok));
  let next = 0;
  for (const original of originals) {
    if (forward.has(original)) continue;
    let wire = original;
    if (!ok(original)) { do { wire = `es_fn_${next++}`; } while (used.has(wire)); used.add(wire); }
    forward.set(original, wire); reverse.set(wire, original);
  }
  return { get: (n: string) => forward.get(n) ?? n, restore: (n: string) => reverse.get(n) ?? n };
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(p => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

export function chatToGemini(chat: ChatRequest): { body: Json; restoreName: (name: string) => string; dropped: string[] } {
  const choice = chat.tool_choice;
  const specs = choice === "none" ? [] : (chat.tools ?? []).filter(t => t.type === "function").map(t => t.function as Json);
  const calls = chat.messages.flatMap(m => m.tool_calls ?? []);
  const names = nameAliases([...specs.map(t => String(t.name)), ...calls.map(c => c.function.name)]);
  // A tool result names the function it answers; Chat only has the call id.
  const nameOfCall = new Map(calls.map(c => [c.id, c.function.name]));
  const signs = /^gemini[-.\d]/i.test(chat.model);
  const contents: Array<{ role: "user" | "model"; parts: Json[] }> = [];
  const push = (role: "user" | "model", parts: Json[]) => {
    if (!parts.length) return;
    const last = contents.at(-1);
    if (last && last.role === role) last.parts.push(...parts); else contents.push({ role, parts });
  };
  const system: string[] = [];
  for (const m of chat.messages) {
    if (m.role === "system") { const t = textOf(m.content); if (t) system.push(t); continue; }
    if (m.role === "tool") {
      const name = nameOfCall.get(String(m.tool_call_id ?? "")) ?? "unknown";
      push("user", [{ functionResponse: { name: names.get(name), response: { result: textOf(m.content) } } }]);
      continue;
    }
    if (m.role === "assistant") {
      const parts: Json[] = [];
      const text = textOf(m.content);
      if (text) parts.push({ text });
      let first = true;
      for (const call of m.tool_calls ?? []) {
        let args: Json;
        try { args = JSON.parse(call.function.arguments || "{}"); } catch { throw new GeminiUpstreamError("工具调用历史中的参数不是有效 JSON。", 400); }
        parts.push({ functionCall: { name: names.get(call.function.name), args }, ...(signs && first ? { thoughtSignature: THOUGHT_SIGNATURE_BYPASS } : {}) });
        first = false;
      }
      push("model", parts);
      continue;
    }
    const parts: Json[] = [];
    if (typeof m.content === "string") { if (m.content) parts.push({ text: m.content }); }
    else for (const part of m.content ?? []) {
      if (part.type === "text") { if (part.text) parts.push({ text: part.text }); continue; }
      const image = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(part.image_url.url);
      if (!image) throw new GeminiUpstreamError("图片需要 PNG/JPEG/GIF/WebP 的 base64 data URL。", 400);
      parts.push({ inlineData: { mimeType: image[1], data: image[2]!.replace(/\s/g, "") } });
    }
    push("user", parts);
  }
  // Gemini starts a conversation with the user.
  if (contents[0]?.role === "model") contents.unshift({ role: "user", parts: [{ text: "Continue." }] });
  const body: Json = { contents };
  if (system.length) body.systemInstruction = { role: "user", parts: [{ text: system.join("\n\n") }] };
  if (specs.length) {
    body.tools = [{ functionDeclarations: specs.map(t => ({ name: names.get(String(t.name)), description: String(t.description ?? t.name).slice(0, 1024), parameters: geminiSchema(t.parameters) })) }];
    if (choice === "required") body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
    else if (choice && typeof choice === "object") {
      const forced = String(((choice as Json).function as Json | undefined)?.name ?? "");
      if (forced) body.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [names.get(forced)] } };
    }
  }
  const generation: Json = {};
  if (chat.max_tokens !== undefined) generation.maxOutputTokens = chat.max_tokens;
  if (chat.temperature !== undefined) generation.temperature = chat.temperature;
  if (chat.top_p !== undefined) generation.topP = chat.top_p;
  if (Object.keys(generation).length) body.generationConfig = generation;
  const dropped = chat.parallel_tool_calls !== undefined ? ["parallel_tool_calls"] : [];
  return { body, restoreName: names.restore, dropped };
}

interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number; prompt_tokens_details?: { cached_tokens: number } }
type Piece = { delta: Json; finish?: string; usage?: Usage };

function usageOf(meta: Json | undefined): Usage | undefined {
  if (!meta) return undefined;
  const input = Number(meta.promptTokenCount ?? 0);
  const output = Number(meta.candidatesTokenCount ?? 0) + Number(meta.thoughtsTokenCount ?? 0);
  const cached = Number(meta.cachedContentTokenCount ?? 0);
  return { prompt_tokens: input, completion_tokens: output, total_tokens: Number(meta.totalTokenCount ?? input + output), ...(cached ? { prompt_tokens_details: { cached_tokens: cached } } : {}) };
}

async function* sseObjects(source: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const decoder = new TextDecoder();
  let buffer = "";
  const emit = function* (block: string): Generator<Json> {
    const data = block.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    try { yield JSON.parse(data) as Json; } catch { /* a line that is not JSON is skipped */ }
  };
  for await (const chunk of source as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
      yield* emit(block);
    }
  }
  if (buffer.trim()) yield* emit(buffer);
}

/** Gemini's streamed answer as Chat deltas, the last carrying the finish reason. Any `wrapper` (Cloud Code Assist's `response`) is unwrapped. */
async function* geminiPieces(source: ReadableStream<Uint8Array>, restoreName: (n: string) => string): AsyncGenerator<Piece> {
  let calls = 0; let finish: string | undefined; let usage: Usage | undefined;
  for await (const raw of sseObjects(source)) {
    if (raw.error) throw new GeminiUpstreamError(String(raw.error.message ?? "上游返回错误"), Number(raw.error.code) >= 400 ? Number(raw.error.code) : 502);
    const obj: Json = raw.response ?? raw;
    usage = usageOf(obj.usageMetadata) ?? usage;
    const candidate = obj.candidates?.[0] as Json | undefined;
    for (const part of (candidate?.content?.parts ?? []) as Json[]) {
      if (part.functionCall) {
        yield { delta: { tool_calls: [{ index: calls, id: `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "function", function: { name: restoreName(String(part.functionCall.name)), arguments: JSON.stringify(part.functionCall.args ?? {}) } }] } };
        calls++;
      } else if (typeof part.text === "string" && part.text) {
        yield { delta: part.thought === true ? { reasoning_content: part.text } : { content: part.text } };
      }
    }
    if (typeof candidate?.finishReason === "string") finish = candidate.finishReason;
  }
  if (!finish) throw new GeminiUpstreamError("Gemini 的回答没有正常结束，请重试。");
  const reason = finish === "MAX_TOKENS" ? "length" : ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(finish) ? "content_filter" : calls ? "tool_calls" : "stop";
  yield { delta: {}, finish: reason, ...(usage ? { usage } : {}) };
}

/** Gemini's answer as a Chat Completions stream, or as one Chat answer when the caller did not stream. */
export function geminiToChatResponse(upstream: Response, opts: { stream: boolean; model: string; restoreName: (n: string) => string }): Response | Promise<Response> {
  const id = `chatcmpl-${randomUUID().slice(0, 12)}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (p: Piece) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model: opts.model, choices: [{ index: 0, delta: p.delta, finish_reason: p.finish ?? null }], ...(p.usage ? { usage: p.usage } : {}) })}\n\n`;
  const failure = (e: unknown) => (e instanceof GeminiUpstreamError ? e : new GeminiUpstreamError("请求失败，请检查网络或稍后重试。"));
  if (opts.stream) {
    const encoder = new TextEncoder();
    const pieces = geminiPieces(upstream.body!, opts.restoreName);
    let started = false;
    return new Response(new ReadableStream<Uint8Array>({
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
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return (async () => {
    let text = ""; let reasoning = ""; let finish = "stop"; let usage: Usage | undefined;
    const calls: Json[] = [];
    try {
      for await (const piece of geminiPieces(upstream.body!, opts.restoreName)) {
        const d = piece.delta;
        if (typeof d.content === "string") text += d.content;
        if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
        for (const c of (d.tool_calls ?? []) as Json[]) calls.push({ id: c.id, type: "function", function: c.function });
        if (piece.finish) { finish = piece.finish; usage = piece.usage; }
      }
    } catch (error) {
      return Response.json({ error: { message: failure(error).message, code: "upstream_error", type: "upstream_error" } }, { status: failure(error).status });
    }
    const message: Json = { role: "assistant", content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) };
    return Response.json({ id, object: "chat.completion", created, model: opts.model, choices: [{ index: 0, message, finish_reason: finish }], ...(usage ? { usage } : {}) });
  })();
}
