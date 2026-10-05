/**
 * Anthropic Messages (what Claude Code speaks) <-> Chat Completions.
 * Text, images, tool_use / tool_result, streaming and usage. Claude-only
 * request fields (thinking, context_management, safeguards, output_config,
 * cache_control) have no Chat meaning and are left behind.
 */
import type { ChatContentPart, ChatMessage, ChatRequest } from "./translate.ts";

type Json = Record<string, unknown>;

export interface MessagesTranslation {
  chat: ChatRequest;
  dropped: string[];
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(b => ((b as Json).type === "text" && typeof (b as Json).text === "string" ? String((b as Json).text) : ""))
    .filter(Boolean)
    .join("\n\n");
}

function imagePart(block: Json): ChatContentPart | undefined {
  const source = block.source as Json | undefined;
  if (!source) return undefined;
  if (source.type === "base64" && typeof source.data === "string") {
    return { type: "image_url", image_url: { url: `data:${String(source.media_type ?? "image/png")};base64,${source.data}` } };
  }
  if (source.type === "url" && typeof source.url === "string") return { type: "image_url", image_url: { url: source.url } };
  return undefined;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  return blockText(content) || JSON.stringify(content ?? "");
}

export function messagesToChat(body: Json, upstreamModel: string, opts: { streamUsage: boolean }): MessagesTranslation {
  const dropped: string[] = [];
  const systemParts: string[] = [];
  const messages: ChatMessage[] = [];

  const system = blockText(body.system);
  if (system) systemParts.push(system);

  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const message = raw as Json;
    const role = message.role;
    if (role === "system") {
      const text = blockText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    const blocks: Json[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : (Array.isArray(message.content) ? message.content : []) as Json[];

    if (role === "assistant") {
      const text = blocks.filter(b => b.type === "text").map(b => String(b.text ?? "")).filter(Boolean).join("\n\n");
      const calls = blocks.filter(b => b.type === "tool_use").map(b => ({
        id: String(b.id),
        type: "function" as const,
        function: { name: String(b.name), arguments: JSON.stringify(b.input ?? {}) },
      }));
      for (const b of blocks) if (!["text", "tool_use", "thinking", "redacted_thinking"].includes(String(b.type))) dropped.push(`assistant:${String(b.type)}`);
      if (text || calls.length) messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }

    // User turn: tool results must directly follow the assistant's calls, so
    // they go first; any text or images in the same turn follow as a user message.
    const parts: ChatContentPart[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const text = toolResultText(b.content);
        messages.push({ role: "tool", tool_call_id: String(b.tool_use_id), content: b.is_error ? `Error: ${text}` : text });
      } else if (b.type === "text" && typeof b.text === "string") {
        parts.push({ type: "text", text: b.text });
      } else if (b.type === "image") {
        const part = imagePart(b);
        if (part) parts.push(part);
      } else {
        dropped.push(`user:${String(b.type)}`);
      }
    }
    if (parts.length) {
      messages.push({
        role: "user",
        content: parts.every(p => p.type === "text") ? parts.map(p => (p as { text: string }).text).join("\n\n") : parts,
      });
    }
  }

  const tools: Json[] = [];
  for (const raw of Array.isArray(body.tools) ? body.tools : []) {
    const tool = raw as Json;
    if (tool.input_schema && (tool.type === undefined || tool.type === "custom")) {
      tools.push({ type: "function", function: { name: tool.name, description: tool.description ?? "", parameters: tool.input_schema } });
    } else {
      dropped.push(`tool:${String(tool.type ?? "unknown")}:${String(tool.name ?? "")}`);
    }
  }

  const chat: ChatRequest = {
    model: upstreamModel,
    messages: [...(systemParts.length ? [{ role: "system" as const, content: systemParts.join("\n\n") }] : []), ...messages],
    stream: body.stream === true,
  };
  if (chat.stream && opts.streamUsage) chat.stream_options = { include_usage: true };
  if (tools.length) {
    chat.tools = tools;
    const choice = body.tool_choice as Json | undefined;
    if (choice?.type === "any") chat.tool_choice = "required";
    else if (choice?.type === "tool" && typeof choice.name === "string") chat.tool_choice = { type: "function", function: { name: choice.name } };
    else if (choice?.type === "none") chat.tool_choice = "none";
    else if (choice?.type === "auto") chat.tool_choice = "auto";
    if (choice && choice.disable_parallel_tool_use === true) chat.parallel_tool_calls = false;
  }
  if (typeof body.max_tokens === "number") chat.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) (chat as unknown as Json).stop = body.stop_sequences;
  return { chat, dropped };
}

// ---------------------------------------------------------------------------
// Chat -> Anthropic

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
}

function usageOf(raw: unknown): AnthropicUsage | undefined {
  const u = raw as Json | undefined;
  if (!u || typeof u !== "object") return undefined;
  return {
    input_tokens: Number(u.prompt_tokens ?? 0),
    output_tokens: Number(u.completion_tokens ?? 0),
    cache_read_input_tokens: Number((u.prompt_tokens_details as Json | undefined)?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0),
  };
}

function stopReason(finish: unknown, sawTool: boolean): string {
  if (finish === "tool_calls" || (sawTool && finish !== "length")) return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

let counter = 0;
function messageId(): string {
  counter += 1;
  return `msg_es${Date.now().toString(36)}${counter.toString(36)}`;
}

/** A complete (non-streamed) Chat completion as an Anthropic message. */
export function chatToMessage(json: Json, model: string): Json {
  const choice = (Array.isArray(json.choices) ? json.choices[0] : undefined) as Json | undefined;
  const message = (choice?.message ?? {}) as Json;
  const content: Json[] = [];
  if (typeof message.content === "string" && message.content) content.push({ type: "text", text: message.content });
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  for (const raw of calls) {
    const call = raw as Json;
    const fn = (call.function ?? {}) as Json;
    let input: unknown = {};
    try { input = JSON.parse(String(fn.arguments || "{}")); } catch { input = { raw: fn.arguments }; }
    content.push({ type: "tool_use", id: String(call.id ?? messageId()), name: String(fn.name), input });
  }
  const usage = usageOf(json.usage) ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  return {
    id: messageId(), type: "message", role: "assistant", model, content,
    stop_reason: stopReason(choice?.finish_reason, calls.length > 0), stop_sequence: null, usage,
  };
}

interface Block {
  index: number;
  kind: "text" | "tool_use";
}

/** Chat completion chunks -> Anthropic message stream events. */
export class AnthropicStream {
  private readonly id = messageId();
  private readonly model: string;
  private readonly write: (chunk: string) => void;
  private nextIndex = 0;
  private text?: Block;
  private readonly tools = new Map<number, Block>();
  private usage?: AnthropicUsage;
  private finish: unknown;
  private sawTool = false;
  private done = false;

  constructor(model: string, write: (chunk: string) => void) {
    this.model = model;
    this.write = write;
  }

  private emit(type: string, payload: Json): void {
    this.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  }

  start(): void {
    this.emit("message_start", {
      message: {
        id: this.id, type: "message", role: "assistant", model: this.model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  private closeText(): void {
    if (!this.text) return;
    this.emit("content_block_stop", { index: this.text.index });
    this.text = undefined;
  }

  chunk(chunk: Json): void {
    if (chunk.usage) this.usage = usageOf(chunk.usage) ?? this.usage;
    const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as Json | undefined;
    if (choice?.finish_reason) this.finish = choice.finish_reason;
    const delta = choice?.delta as Json | undefined;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content) {
      if (!this.text) {
        this.text = { index: this.nextIndex++, kind: "text" };
        this.emit("content_block_start", { index: this.text.index, content_block: { type: "text", text: "" } });
      }
      this.emit("content_block_delta", { index: this.text.index, delta: { type: "text_delta", text: delta.content } });
    }
    for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const call = raw as Json;
      const slot = typeof call.index === "number" ? call.index : 0;
      const fn = (call.function ?? {}) as Json;
      let block = this.tools.get(slot);
      if (!block) {
        this.closeText();
        // Close the previous tool block: Anthropic streams one open block at a time.
        for (const open of this.tools.values()) this.emit("content_block_stop", { index: open.index });
        this.tools.clear();
        block = { index: this.nextIndex++, kind: "tool_use" };
        this.tools.set(slot, block);
        this.sawTool = true;
        this.emit("content_block_start", {
          index: block.index,
          content_block: { type: "tool_use", id: String(call.id ?? `toolu_${messageId()}`), name: String(fn.name ?? ""), input: {} },
        });
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        this.emit("content_block_delta", { index: block.index, delta: { type: "input_json_delta", partial_json: fn.arguments } });
      }
    }
  }

  finishStream(): void {
    if (this.done) return;
    this.done = true;
    this.closeText();
    for (const open of this.tools.values()) this.emit("content_block_stop", { index: open.index });
    this.tools.clear();
    const usage = this.usage ?? { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    this.emit("message_delta", {
      delta: { stop_reason: stopReason(this.finish, this.sawTool), stop_sequence: null },
      usage,
    });
    this.emit("message_stop", {});
  }

  fail(message: string): void {
    if (this.done) return;
    this.done = true;
    this.emit("error", { error: { type: "api_error", message } });
  }
}

/** Rough count for /v1/messages/count_tokens when no upstream can answer it. */
export function estimateTokens(body: Json): number {
  return Math.ceil(JSON.stringify({ s: body.system, m: body.messages, t: body.tools }).length / 3.5);
}
