import type { ChatMessage, ChatRequest } from "./translate.ts";

/**
 * Provider and model quirks a chat-translate gateway has to absorb, so that
 * one translation serves every Chat-compatible upstream. The table below is
 * knowledge gathered by opencodex (MIT, src/adapters/openai-chat/** and
 * src/providers/registry/**) and Magpie (MIT, internal/gateway/chat*.go),
 * re-expressed here as a small profile per host/model; see PROVENANCE.md.
 * Vendor behaviour changes: treat each rule as a default the probe and the
 * retry-on-rejection path may overrule, not as a promise.
 */

type Json = Record<string, unknown>;

export interface Quirks {
  /** Only these tool_choice values are accepted (Kimi for Coding): anything else becomes "auto". */
  autoToolChoiceOnly: boolean;
  /** temperature / top_p / penalties are locked server-side and a different value is a 400. */
  noSampling: boolean;
  /** `stop` is rejected (xAI reasoning models). */
  noStop: boolean;
  /** Thinking models want the earlier reasoning_content of a tool turn sent back. */
  replayReasoning: boolean;
  /** Send a prompt_cache_key (Kimi coding plan hits its cache only with one). */
  promptCacheKey: boolean;
  /** `$ref` next to sibling keywords in a tool schema is a 400 (Moonshot). */
  flattenSchemaRefs: boolean;
}

function hostOf(baseUrl: string): string {
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ""; }
}

export function quirksFor(baseUrl: string, model: string): Quirks {
  const host = hostOf(baseUrl);
  const m = model.toLowerCase();
  const kimiHost = /(^|\.)moonshot\.(cn|ai)$|(^|\.)kimi\.com$/.test(host);
  const kimi = kimiHost || m.startsWith("kimi");
  const deepseek = /deepseek/.test(host) || m.startsWith("deepseek");
  const glm = /bigmodel\.cn$|(^|\.)z\.ai$/.test(host) || m.startsWith("glm");
  const minimax = /minimax/.test(host) || m.startsWith("minimax");
  const xai = /(^|\.)x\.ai$/.test(host) || m.startsWith("grok");
  return {
    autoToolChoiceOnly: m.includes("kimi-for-coding") || host === "api.kimi.com",
    noSampling: kimi && /k2|k3|kimi-for-coding|thinking/.test(m),
    noStop: xai && /grok-4|reasoning/.test(m),
    replayReasoning: deepseek || kimi || glm || minimax,
    promptCacheKey: host === "api.kimi.com",
    flattenSchemaRefs: kimiHost,
  };
}

/** Claude Code appends context markers such as `glm-5.3[1m]`; Chat upstreams reject them. */
export function upstreamModelId(model: string): string {
  return model.replace(/\[[^\]]*\]$/, "");
}

// ---------------------------------------------------------------- tool_choice

/** Responses' `{type:"function",name}` is Chat's `{type:"function",function:{name}}`. */
export function toolChoiceToChat(choice: unknown, quirks: Quirks): unknown {
  if (quirks.autoToolChoiceOnly && choice !== "none") return "auto";
  if (choice && typeof choice === "object") {
    const c = choice as Json;
    if (c.type === "function" && typeof c.name === "string") return { type: "function", function: { name: c.name } };
  }
  return choice;
}

// ---------------------------------------------------------------- tool pairing

/**
 * Chat upstreams want every assistant tool_call answered by a tool message right
 * after it, and every tool message to answer a call. Compaction and interrupted
 * turns break that (Kimi answers 400 "tool_call_id is not found"). This repairs
 * the history without inventing facts: results are ordered by call order,
 * duplicates and orphans become plain user text, and a call that never got a
 * result gets a stated "[no result]".
 */
export function repairToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const results = new Map<string, ChatMessage>();
  for (const m of messages) if (m.role === "tool" && m.tool_call_id && !results.has(m.tool_call_id)) results.set(m.tool_call_id, m);
  const used = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool") {
      const id = m.tool_call_id ?? "";
      // Answered calls are emitted right after their assistant message below; what is
      // left over is an orphan or a duplicate.
      if (!used.has(id) && !results.has(id)) out.push({ role: "user", content: `[earlier tool output without a call]\n${typeof m.content === "string" ? m.content : ""}` });
      continue;
    }
    out.push(m);
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const call of m.tool_calls) {
        const found = results.get(call.id);
        used.add(call.id);
        out.push(found ?? { role: "tool", tool_call_id: call.id, content: "[no result]" });
      }
    }
  }
  // A tool message that only appeared before its call was moved above; any still-unused
  // result is an orphan.
  for (const [id, m] of results) {
    if (!used.has(id)) out.push({ role: "user", content: `[earlier tool output without a call]\n${typeof m.content === "string" ? m.content : ""}` });
  }
  return out;
}

// ---------------------------------------------------------------- reasoning replay

/**
 * Thinking models (DeepSeek, Kimi, GLM, MiniMax) answer a tool turn with
 * `reasoning_content`, and the next request must carry it back on that
 * assistant message or the upstream answers 400. The harness does not know
 * the field exists, so the gateway remembers it by tool call id for as long
 * as it is plausibly needed.
 */
export class ReasoningMemory {
  private readonly byCall = new Map<string, string>();
  private readonly limit: number;

  constructor(limit = 2000) {
    this.limit = limit;
  }

  remember(callIds: readonly string[], reasoning: string): void {
    if (!reasoning || !callIds.length) return;
    for (const id of callIds) {
      this.byCall.delete(id);
      this.byCall.set(id, reasoning);
    }
    while (this.byCall.size > this.limit) this.byCall.delete(this.byCall.keys().next().value as string);
  }

  recall(callId: string): string | undefined {
    return this.byCall.get(callId);
  }
}

export const reasoningMemory = new ReasoningMemory();

/** The reasoning text a stream chunk carries; vendors name it two ways. */
export function reasoningDelta(delta: Json): string {
  const r = delta.reasoning_content ?? delta.reasoning;
  return typeof r === "string" ? r : "";
}

// ---------------------------------------------------------------- shaping

function flattenRefs(node: unknown, defs: Json | undefined): unknown {
  if (Array.isArray(node)) return node.map(n => flattenRefs(n, defs));
  if (!node || typeof node !== "object") return node;
  const obj = node as Json;
  if (typeof obj.$ref === "string") {
    const name = obj.$ref.split("/").pop() ?? "";
    const target = defs?.[name];
    // Replace the whole node: Moonshot rejects a $ref with siblings, so the siblings go too.
    if (target && typeof target === "object") return flattenRefs(target, defs);
    return {};
  }
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) if (k !== "$defs" && k !== "definitions") out[k] = flattenRefs(v, defs);
  return out;
}

export interface ShapeOptions {
  quirks: Quirks;
  memory?: ReasoningMemory;
  /** A stable session key to send as prompt_cache_key when the provider wants one. */
  cacheKey?: string;
}

/** Applies provider quirks to a translated Chat request, in place. */
export function shapeChat(chat: ChatRequest, opts: ShapeOptions): ChatRequest {
  const { quirks, memory = reasoningMemory } = opts;
  chat.model = upstreamModelId(chat.model);
  chat.messages = repairToolPairs(chat.messages);

  for (const m of chat.messages) {
    if (m.role === "assistant") {
      // Some upstreams (Volcengine, several relays) reject null content next to tool_calls.
      if (m.content === null || m.content === undefined) m.content = "";
      if (quirks.replayReasoning && m.tool_calls?.length) {
        const known = m.tool_calls.map(c => memory.recall(c.id)).find(Boolean);
        // A thinking-mode upstream insists on the field; a blank is accepted where the text is gone.
        (m as unknown as Json).reasoning_content = known ?? " ";
      }
    }
  }

  if (chat.tool_choice !== undefined) chat.tool_choice = toolChoiceToChat(chat.tool_choice, quirks) as ChatRequest["tool_choice"];
  const c = chat as unknown as Json;
  if (quirks.noSampling) for (const k of ["temperature", "top_p", "presence_penalty", "frequency_penalty"]) delete c[k];
  if (quirks.noStop) delete c.stop;
  if (quirks.promptCacheKey && opts.cacheKey) c.prompt_cache_key = opts.cacheKey;
  if (quirks.flattenSchemaRefs && Array.isArray(chat.tools)) {
    for (const tool of chat.tools as Json[]) {
      const fn = tool.function as Json | undefined;
      if (fn?.parameters && typeof fn.parameters === "object") {
        const params = fn.parameters as Json;
        fn.parameters = flattenRefs(params, (params.$defs ?? params.definitions) as Json | undefined);
      }
    }
  }
  return chat;
}
