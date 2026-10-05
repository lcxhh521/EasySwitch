/**
 * OpenAI Responses (what Codex speaks) <-> Chat Completions (what most relays
 * speak). Only what a coding harness needs: text, images, function tools,
 * custom (freeform) tools mapped to a one-string-argument function, streaming
 * and usage. Anything with no Chat equivalent is dropped and reported, never
 * silently reinterpreted.
 */

import { reasoningDelta } from "./quirks.ts";

type Json = Record<string, unknown>;

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  tools?: Json[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
}

/** Codex groups some tools (MCP servers, its sub-agent tools) into `namespace` tools; Chat only has flat functions. */
export type NamespaceMap = ReadonlyMap<string, { namespace: string; name: string }>;

export function flatToolName(namespace: string, name: string): string {
  return `${namespace}__${name}`;
}

export interface Translation {
  chat: ChatRequest;
  /** Tool names that were `custom` (freeform) tools in the original request. */
  customTools: Set<string>;
  /** What could not be carried over, for the log and the UI. */
  dropped: string[];
  /** Flattened function name → the namespace and bare name Codex knows it by. */
  namespaced: NamespaceMap;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      const p = part as Json;
      return typeof p.text === "string" ? p.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function userParts(content: unknown): string | ChatContentPart[] {
  if (!Array.isArray(content)) return textOf(content);
  const parts: ChatContentPart[] = [];
  for (const raw of content) {
    const p = raw as Json;
    if ((p.type === "input_text" || p.type === "output_text" || p.type === "text") && typeof p.text === "string") {
      parts.push({ type: "text", text: p.text });
    } else if (p.type === "input_image" && typeof p.image_url === "string") {
      parts.push({ type: "image_url", image_url: { url: p.image_url } });
    }
  }
  return parts.every(p => p.type === "text") ? parts.map(p => (p as { text: string }).text).join("\n\n") : parts;
}

function outputText(output: unknown): string {
  return typeof output === "string" ? output : textOf(output);
}

export function responsesToChat(body: Json, upstreamModel: string, opts: { streamUsage: boolean }): Translation {
  const dropped: string[] = [];
  const customTools = new Set<string>();
  const systemParts: string[] = [];
  const messages: ChatMessage[] = [];

  if (typeof body.instructions === "string" && body.instructions) systemParts.push(body.instructions);

  const pushToolCall = (call: ChatToolCall) => {
    const last = messages[messages.length - 1];
    if (last && last.role === "assistant" && last.tool_calls) last.tool_calls.push(call);
    else messages.push({ role: "assistant", content: null, tool_calls: [call] });
  };

  const input = typeof body.input === "string" ? [{ type: "message", role: "user", content: body.input }] : body.input;
  for (const raw of Array.isArray(input) ? input : []) {
    const item = raw as Json;
    const type = item.type ?? (item.role ? "message" : undefined);
    switch (type) {
      case "message": {
        const role = item.role;
        if (role === "system" || role === "developer") {
          // Chat providers disagree on mid-conversation system turns; one leading
          // system message is the shape every relay we have seen accepts.
          const text = textOf(item.content);
          if (text) systemParts.push(text);
        } else if (role === "assistant") {
          const text = textOf(item.content);
          if (text) messages.push({ role: "assistant", content: text });
        } else {
          messages.push({ role: "user", content: userParts(item.content) });
        }
        break;
      }
      case "function_call":
        pushToolCall({
          id: String(item.call_id ?? item.id),
          type: "function",
          function: {
            name: typeof item.namespace === "string" && item.namespace ? flatToolName(item.namespace, String(item.name)) : String(item.name),
            arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
          },
        });
        break;
      case "custom_tool_call":
        pushToolCall({
          id: String(item.call_id ?? item.id),
          type: "function",
          function: { name: String(item.name), arguments: JSON.stringify({ input: String(item.input ?? "") }) },
        });
        break;
      case "function_call_output":
      case "custom_tool_call_output":
        messages.push({ role: "tool", tool_call_id: String(item.call_id), content: outputText(item.output) });
        break;
      case "reasoning":
        // Encrypted reasoning from another model is meaningless upstream.
        break;
      default:
        dropped.push(`input:${String(type)}`);
    }
  }

  const tools: Json[] = [];
  const namespaced = new Map<string, { namespace: string; name: string }>();
  for (const raw of Array.isArray(body.tools) ? body.tools : []) {
    const tool = raw as Json;
    if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      for (const inner of tool.tools as Json[]) {
        if (inner.type !== "function") { dropped.push(`tool:namespace:${tool.name}:${String(inner.type)}`); continue; }
        const flat = flatToolName(tool.name, String(inner.name));
        namespaced.set(flat, { namespace: tool.name, name: String(inner.name) });
        tools.push({ type: "function", function: { name: flat, description: inner.description ?? "", parameters: inner.parameters ?? { type: "object", properties: {} } } });
      }
    } else if (tool.type === "function") {
      tools.push({
        type: "function",
        function: { name: tool.name, description: tool.description ?? "", parameters: tool.parameters ?? { type: "object", properties: {} } },
      });
    } else if (tool.type === "custom") {
      const name = String(tool.name);
      customTools.add(name);
      const format = tool.format as Json | undefined;
      const grammar = format && typeof format.definition === "string" ? `\n\nThe input must follow this ${String(format.syntax ?? "")} grammar:\n${format.definition}` : "";
      tools.push({
        type: "function",
        function: {
          name,
          description: `${String(tool.description ?? "")}${grammar}`,
          parameters: { type: "object", properties: { input: { type: "string", description: "The raw tool input." } }, required: ["input"] },
        },
      });
    } else {
      dropped.push(`tool:${String(tool.type)}${tool.name ? `:${String(tool.name)}` : ""}`);
    }
  }

  const chat: ChatRequest = {
    model: upstreamModel,
    messages: [...(systemParts.length ? [{ role: "system" as const, content: systemParts.join("\n\n") }] : []), ...messages],
    stream: body.stream !== false,
  };
  if (chat.stream && opts.streamUsage) chat.stream_options = { include_usage: true };
  if (tools.length) {
    chat.tools = tools;
    if (body.tool_choice !== undefined) chat.tool_choice = body.tool_choice;
    // Codex always says true, which Kimi and NIM-style upstreams reject; true is the default anyway.
    if (body.parallel_tool_calls === false) chat.parallel_tool_calls = false;
  }
  if (typeof body.max_output_tokens === "number") chat.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") chat.temperature = body.temperature;
  if (typeof body.top_p === "number") chat.top_p = body.top_p;
  return { chat, customTools, dropped, namespaced };
}

// ---------------------------------------------------------------------------
// Chat stream -> Responses SSE

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens_details: { reasoning_tokens: number };
}

function usageFromChat(raw: unknown): Usage | undefined {
  const u = raw as Json | undefined;
  if (!u || typeof u !== "object") return undefined;
  const input = Number(u.prompt_tokens ?? 0);
  const output = Number(u.completion_tokens ?? 0);
  const cached = Number((u.prompt_tokens_details as Json | undefined)?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0);
  const reasoning = Number((u.completion_tokens_details as Json | undefined)?.reasoning_tokens ?? 0);
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Number(u.total_tokens ?? input + output),
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

interface ToolState {
  itemId: string;
  callId: string;
  name: string;
  args: string;
  outputIndex: number;
  custom: boolean;
}

let counter = 0;
function newId(prefix: string): string {
  counter += 1;
  return `${prefix}_es${Date.now().toString(36)}${counter.toString(36)}`;
}

/**
 * Turns Chat completion chunks into the Responses event sequence Codex
 * consumes: created, output_item.added/done, text and argument deltas,
 * completed (or failed).
 */
export class ResponsesStream {
  readonly responseId = newId("resp");
  private seq = 0;
  private readonly output: Json[] = [];
  private nextIndex = 0;
  private text?: { itemId: string; outputIndex: number; value: string };
  private readonly tools = new Map<number, ToolState>();
  private usage?: Usage;
  private done = false;
  private reasoning = "";
  private readonly callIds: string[] = [];
  private readonly model: string;
  private readonly customTools: ReadonlySet<string>;
  private readonly namespaced: NamespaceMap;
  private readonly write: (chunk: string) => void;

  constructor(model: string, customTools: ReadonlySet<string>, write: (chunk: string) => void, namespaced: NamespaceMap = new Map()) {
    this.model = model;
    this.customTools = customTools;
    this.write = write;
    this.namespaced = namespaced;
  }

  /** The function_call fields for a tool the model named: Codex wants namespace and bare name back. */
  private callFields(name: string): { name: string; namespace?: string } {
    const ns = this.namespaced.get(name);
    return ns ? { namespace: ns.namespace, name: ns.name } : { name };
  }

  private emit(type: string, payload: Json): void {
    this.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.seq++, ...payload })}\n\n`);
  }

  private shell(status: string): Json {
    return { id: this.responseId, object: "response", created_at: Math.floor(Date.now() / 1000), model: this.model, status, output: [] };
  }

  /** Token usage the upstream reported, if any (for the ledger). */
  get usageSummary(): { input: number; output: number; cached: number } | undefined {
    const u = this.usage;
    return u ? { input: u.input_tokens, output: u.output_tokens, cached: u.input_tokens_details.cached_tokens } : undefined;
  }

  /** What a thinking model said before its tool calls, to be sent back with them next turn. */
  get turn(): { reasoning: string; callIds: readonly string[] } {
    return { reasoning: this.reasoning, callIds: this.callIds };
  }

  start(): void {
    this.emit("response.created", { response: this.shell("in_progress") });
    this.emit("response.in_progress", { response: this.shell("in_progress") });
  }

  private openText(): NonNullable<ResponsesStream["text"]> {
    if (!this.text) {
      this.text = { itemId: newId("msg"), outputIndex: this.nextIndex++, value: "" };
      this.emit("response.output_item.added", {
        output_index: this.text.outputIndex,
        item: { id: this.text.itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
      });
      this.emit("response.content_part.added", {
        item_id: this.text.itemId, output_index: this.text.outputIndex, content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      });
    }
    return this.text;
  }

  private closeText(): void {
    const t = this.text;
    if (!t) return;
    const part = { type: "output_text", text: t.value, annotations: [] };
    this.emit("response.output_text.done", { item_id: t.itemId, output_index: t.outputIndex, content_index: 0, text: t.value });
    this.emit("response.content_part.done", { item_id: t.itemId, output_index: t.outputIndex, content_index: 0, part });
    const item = { id: t.itemId, type: "message", role: "assistant", status: "completed", content: [part] };
    this.output[t.outputIndex] = item;
    this.emit("response.output_item.done", { output_index: t.outputIndex, item });
    this.text = undefined;
  }

  /** Feed one parsed Chat chunk. */
  chunk(chunk: Json): void {
    if (chunk.usage) this.usage = usageFromChat(chunk.usage) ?? this.usage;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const delta = (choices[0] as Json | undefined)?.delta as Json | undefined;
    if (!delta) return;
    this.reasoning += reasoningDelta(delta);

    if (typeof delta.content === "string" && delta.content) {
      const t = this.openText();
      t.value += delta.content;
      this.emit("response.output_text.delta", { item_id: t.itemId, output_index: t.outputIndex, content_index: 0, delta: delta.content });
    }

    for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const call = raw as Json;
      const index = typeof call.index === "number" ? call.index : 0;
      const fn = (call.function ?? {}) as Json;
      let state = this.tools.get(index);
      if (!state) {
        this.closeText();
        const name = String(fn.name ?? "");
        state = {
          itemId: newId("fc"),
          callId: String(call.id ?? newId("call")),
          name,
          args: "",
          outputIndex: this.nextIndex++,
          custom: this.customTools.has(name),
        };
        this.tools.set(index, state);
        this.callIds.push(state.callId);
        this.emit("response.output_item.added", {
          output_index: state.outputIndex,
          item: state.custom
            ? { id: state.itemId, type: "custom_tool_call", call_id: state.callId, name: state.name, input: "", status: "in_progress" }
            : { id: state.itemId, type: "function_call", call_id: state.callId, ...this.callFields(state.name), arguments: "", status: "in_progress" },
        });
      } else if (typeof fn.name === "string" && fn.name && !state.name) {
        state.name = fn.name;
      }
      if (typeof fn.arguments === "string" && fn.arguments) {
        state.args += fn.arguments;
        if (!state.custom) {
          this.emit("response.function_call_arguments.delta", { item_id: state.itemId, output_index: state.outputIndex, delta: fn.arguments });
        }
      }
    }
  }

  private closeTools(): void {
    for (const state of [...this.tools.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      let item: Json;
      if (state.custom) {
        let input = state.args;
        try {
          const parsed = JSON.parse(state.args) as Json;
          if (typeof parsed.input === "string") input = parsed.input;
        } catch {
          // Not JSON: the model sent the raw input, keep it as is.
        }
        item = { id: state.itemId, type: "custom_tool_call", call_id: state.callId, name: state.name, input, status: "completed" };
      } else {
        const args = state.args || "{}";
        this.emit("response.function_call_arguments.done", { item_id: state.itemId, output_index: state.outputIndex, arguments: args });
        item = { id: state.itemId, type: "function_call", call_id: state.callId, ...this.callFields(state.name), arguments: args, status: "completed" };
      }
      this.output[state.outputIndex] = item;
      this.emit("response.output_item.done", { output_index: state.outputIndex, item });
    }
    this.tools.clear();
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    this.closeText();
    this.closeTools();
    const usage = this.usage ?? {
      input_tokens: 0, output_tokens: 0, total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
    };
    this.emit("response.completed", { response: { ...this.shell("completed"), output: this.output.filter(Boolean), usage } });
  }

  fail(code: string, message: string): void {
    if (this.done) return;
    this.done = true;
    this.emit("response.failed", { response: { ...this.shell("failed"), error: { code, message } } });
  }
}
