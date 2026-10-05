import type { ChatMessage, ChatRequest, ChatToolCall } from "./translate.ts";

/**
 * Gemini generateContent <-> OpenAI Chat, for agents that speak Google's API
 * (Gemini CLI and anything built on the @google/genai SDK). Only what a coding
 * agent uses: text, images, function declarations / calls / responses,
 * system instruction, generation settings, streaming and usage.
 */

type Json = Record<string, unknown>;

export interface GeminiTranslation {
  chat: ChatRequest;
  dropped: string[];
}

/** Gemini writes schema types in capitals ("OBJECT"); Chat tools want JSON Schema. */
export function lowerSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lowerSchema);
  if (!node || typeof node !== "object") return node;
  const out: Json = {};
  for (const [k, v] of Object.entries(node as Json)) {
    if (k === "type" && typeof v === "string") out[k] = v.toLowerCase();
    // Fields Gemini adds that JSON Schema validators on other providers reject.
    else if (k === "nullable" || k === "propertyOrdering") continue;
    else out[k] = lowerSchema(v);
  }
  return out;
}

function textOf(parts: unknown): string {
  return (Array.isArray(parts) ? parts : []).map(p => ((p as Json).text ? String((p as Json).text) : "")).filter(Boolean).join("\n\n");
}

export function geminiToChat(body: Json, upstreamModel: string, opts: { stream: boolean; streamUsage: boolean }): GeminiTranslation {
  const dropped: string[] = [];
  const messages: ChatMessage[] = [];
  const system = textOf((body.systemInstruction as Json | undefined)?.parts) || textOf((body.system_instruction as Json | undefined)?.parts);
  if (system) messages.push({ role: "system", content: system });

  // Gemini has no call ids: a call gets one by position, and a response is matched to the
  // oldest unanswered call of the same name.
  let nextCall = 0;
  const open: Array<{ id: string; name: string }> = [];

  for (const raw of Array.isArray(body.contents) ? body.contents : []) {
    const content = raw as Json;
    const parts = (Array.isArray(content.parts) ? content.parts : []) as Json[];
    const role = content.role === "model" ? "assistant" : "user";
    if (role === "assistant") {
      const calls: ChatToolCall[] = [];
      for (const p of parts) {
        if (p.functionCall) {
          const fc = p.functionCall as Json;
          const id = `call_${nextCall++}`;
          open.push({ id, name: String(fc.name) });
          calls.push({ id, type: "function", function: { name: String(fc.name), arguments: JSON.stringify(fc.args ?? {}) } });
        } else if (p.thought === true) {
          dropped.push("thought");
        }
      }
      const text = parts.filter(p => p.thought !== true).map(p => (p.text ? String(p.text) : "")).filter(Boolean).join("");
      if (text || calls.length) messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    const userParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [];
    for (const p of parts) {
      if (p.functionResponse) {
        const fr = p.functionResponse as Json;
        const at = open.findIndex(c => c.name === fr.name);
        const id = at >= 0 ? open.splice(at, 1)[0]!.id : `call_${nextCall++}`;
        messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(fr.response ?? {}) });
      } else if (typeof p.text === "string") {
        userParts.push({ type: "text", text: p.text });
      } else if (p.inlineData) {
        const d = p.inlineData as Json;
        userParts.push({ type: "image_url", image_url: { url: `data:${String(d.mimeType)};base64,${String(d.data)}` } });
      } else {
        dropped.push(`part:${Object.keys(p)[0] ?? "unknown"}`);
      }
    }
    if (userParts.length) {
      messages.push({ role: "user", content: userParts.every(x => x.type === "text") ? userParts.map(x => (x as { text: string }).text).join("\n\n") : userParts });
    }
  }

  const tools: Json[] = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const decls = (t as Json).functionDeclarations;
    if (Array.isArray(decls)) {
      for (const d of decls as Json[]) {
        tools.push({ type: "function", function: { name: d.name, description: d.description ?? "", parameters: lowerSchema(d.parameters ?? d.parametersJsonSchema ?? { type: "OBJECT", properties: {} }) } });
      }
    } else {
      dropped.push(`tool:${Object.keys(t as Json)[0] ?? "unknown"}`);
    }
  }

  const chat: ChatRequest = { model: upstreamModel, messages, stream: opts.stream };
  if (opts.stream && opts.streamUsage) chat.stream_options = { include_usage: true };
  if (tools.length) {
    chat.tools = tools;
    const mode = ((body.toolConfig as Json | undefined)?.functionCallingConfig as Json | undefined)?.mode;
    if (mode === "ANY") chat.tool_choice = "required";
    else if (mode === "NONE") chat.tool_choice = "none";
  }
  const gen = (body.generationConfig ?? {}) as Json;
  if (typeof gen.temperature === "number") chat.temperature = gen.temperature;
  if (typeof gen.topP === "number") chat.top_p = gen.topP;
  if (typeof gen.maxOutputTokens === "number") chat.max_tokens = gen.maxOutputTokens;
  if (Array.isArray(gen.stopSequences) && gen.stopSequences.length) (chat as unknown as Json).stop = gen.stopSequences;
  return { chat, dropped };
}

function finishReason(reason: unknown, sawTool: boolean): string {
  if (sawTool) return "STOP";
  if (reason === "length") return "MAX_TOKENS";
  if (reason === "content_filter") return "SAFETY";
  return "STOP";
}

function usageMetadata(usage: unknown): Json | undefined {
  const u = usage as Json | undefined;
  if (!u || typeof u !== "object") return undefined;
  const cached = Number((u.prompt_tokens_details as Json | undefined)?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0);
  const prompt = Number(u.prompt_tokens ?? 0);
  const out = Number(u.completion_tokens ?? 0);
  return { promptTokenCount: prompt, candidatesTokenCount: out, totalTokenCount: prompt + out, ...(cached ? { cachedContentTokenCount: cached } : {}) };
}

function parseArgs(raw: string): Json {
  try {
    const v = JSON.parse(raw || "{}") as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : { value: v };
  } catch {
    return { raw };
  }
}

/** A complete (non-streamed) Chat answer as a Gemini response. */
export function chatToGemini(json: Json, model: string): Json {
  const choice = ((json.choices as Json[] | undefined)?.[0] ?? {}) as Json;
  const message = (choice.message ?? {}) as Json;
  const parts: Json[] = [];
  if (typeof message.content === "string" && message.content) parts.push({ text: message.content });
  const calls = Array.isArray(message.tool_calls) ? (message.tool_calls as Json[]) : [];
  for (const c of calls) {
    const fn = (c.function ?? {}) as Json;
    parts.push({ functionCall: { name: String(fn.name), args: parseArgs(String(fn.arguments ?? "")) } });
  }
  return {
    candidates: [{ content: { role: "model", parts }, finishReason: finishReason(choice.finish_reason, calls.length > 0), index: 0 }],
    ...(usageMetadata(json.usage) ? { usageMetadata: usageMetadata(json.usage) } : {}),
    modelVersion: model,
  };
}

/** Chat stream chunks → Gemini SSE chunks. Text goes out as it arrives; tool calls once complete. */
export class GeminiStream {
  private readonly write: (chunk: string) => void;
  private readonly model: string;
  private readonly tools = new Map<number, { name: string; args: string }>();
  private finish: unknown = null;
  private usage?: unknown;
  private done = false;
  /** What the call used, for the ledger. */
  get usageSummary(): { input: number; output: number; cached: number } | undefined {
    const m = usageMetadata(this.usage);
    return m ? { input: Number(m.promptTokenCount), output: Number(m.candidatesTokenCount), cached: Number(m.cachedContentTokenCount ?? 0) } : undefined;
  }
  /** Reasoning and call ids of the turn, for the same replay memory the other paths use. */
  reasoning = "";
  readonly callIds: string[] = [];

  constructor(model: string, write: (chunk: string) => void) {
    this.model = model;
    this.write = write;
  }

  private send(parts: Json[], finishReason?: string, withUsage = false): void {
    const candidate: Json = { content: { role: "model", parts }, index: 0 };
    if (finishReason) candidate.finishReason = finishReason;
    const usage = withUsage ? usageMetadata(this.usage) : undefined;
    this.write(`data: ${JSON.stringify({ candidates: [candidate], ...(usage ? { usageMetadata: usage } : {}), modelVersion: this.model })}\r\n\r\n`);
  }

  chunk(chunk: Json): void {
    if (chunk.usage) this.usage = chunk.usage;
    const choice = ((chunk.choices as Json[] | undefined)?.[0] ?? undefined) as Json | undefined;
    if (choice?.finish_reason) this.finish = choice.finish_reason;
    const delta = choice?.delta as Json | undefined;
    if (!delta) return;
    const thought = delta.reasoning_content ?? delta.reasoning;
    if (typeof thought === "string") this.reasoning += thought;
    if (typeof delta.content === "string" && delta.content) this.send([{ text: delta.content }]);
    for (const raw of Array.isArray(delta.tool_calls) ? (delta.tool_calls as Json[]) : []) {
      const index = typeof raw.index === "number" ? raw.index : 0;
      const fn = (raw.function ?? {}) as Json;
      const t = this.tools.get(index) ?? { name: "", args: "" };
      if (typeof fn.name === "string" && fn.name) t.name = fn.name;
      if (typeof fn.arguments === "string") t.args += fn.arguments;
      if (typeof raw.id === "string" && !this.callIds.includes(raw.id)) this.callIds.push(raw.id);
      this.tools.set(index, t);
    }
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    const calls = [...this.tools.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => ({ functionCall: { name: t.name, args: parseArgs(t.args) } }));
    this.send(calls, finishReason(this.finish, calls.length > 0), true);
  }
}
