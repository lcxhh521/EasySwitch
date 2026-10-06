import type { ApiProtocol } from "./types.ts";
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
  /** How this upstream wants the thinking level said, if it takes one at all. */
  reasoning: ReasoningStyle;
}

/**
 * "effort": Chat's `reasoning_effort` (OpenAI and the gateways that copy it).
 * "thinking": a `thinking: {type: enabled|disabled}` switch (Kimi K2.6, GLM).
 * "thinking-effort": a switch plus low/high/max effort (current DeepSeek).
 * "always-thinking": no adjustable switch or effort (Kimi K2.7 Code).
 * "enable_thinking": a boolean (Qwen on DashScope).
 * "none": nothing is sent; the model thinks as it normally does.
 */
export type ReasoningStyle = "effort" | "thinking" | "thinking-effort" | "always-thinking" | "enable_thinking" | "none";

/** Official API model-specific defaults, reviewed 2026-10-06; see docs/provider-thinking.md.
 * Model names alone never impose an official vendor's wire format on a relay.
 */
export function officialThinkingProfile(baseUrl: string, model: string): { style: ReasoningStyle; levels: string[]; note: string } | undefined {
  const host = hostOf(baseUrl);
  const m = upstreamModelId(model).toLowerCase();
  if (/(^|\.)deepseek\.com$/.test(host) && /^(deepseek-flash|deepseek-v4-flash(?:-vision-exp)?|deepseek-v4-pro)$/.test(m)) {
    return { style: "thinking-effort", levels: ["none", "low", "high", "max"], note: "可关闭思考；开启后支持 low / high / max。minimal 映射 low，medium / xhigh 映射 high，ultra 映射 max。" };
  }
  if (/(^|\.)moonshot\.(cn|ai)$/.test(host)) {
    if (m === "kimi-k3") return { style: "effort", levels: ["low", "high", "max"], note: "始终思考，仅支持 low / high / max；不支持关闭思考。" };
    if (m === "kimi-k2.6") return { style: "thinking", levels: ["none", "high"], note: "思考开关：关闭 / 开启；没有 low、medium、high 三档强度。" };
    if (/^kimi-k2\.7-code(?:-highspeed)?$/.test(m)) return { style: "always-thinking", levels: [], note: "始终思考，不能关闭；没有可调思考强度。" };
  }
  return undefined;
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
    reasoning: officialThinkingProfile(baseUrl, model)?.style ?? (/(^|\.)openai\.com$|(^|\.)openrouter\.ai$|(^|\.)x\.ai$|(^|\.)groq\.com$|(^|\.)together\.xyz$|(^|\.)fireworks\.ai$/.test(host) ? "effort"
      : /(^|\.)deepseek\.com$|bigmodel\.cn$|(^|\.)z\.ai$/.test(host) ? "thinking"
      : /dashscope(-intl)?\.aliyuncs\.com$/.test(host) ? "enable_thinking"
      : "none"),
  };
}

/**
 * Carries the thinking level the user chose to the upstream, in the way that upstream says it.
 * Only where the style is known (or the user said so on the provider): elsewhere a stray field
 * would be a 400, so it is left out and the model thinks as it normally does.
 */
export function applyEffort(chat: ChatRequest, effort: unknown, style: ReasoningStyle | boolean, has: readonly string[] = []): void {
  const how: ReasoningStyle = style === true ? "effort" : style === false ? "none" : style;
  if (how === "none" || typeof effort !== "string") return;
  const level = effort.toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(level)) return;
  const off = level === "none" || level === "minimal";
  const raw = chat as unknown as Json;
  // Agents have levels of their own above "high" (xhigh, max, ultra…); Chat's scale ends at high, so they all mean "as much as it goes".
  // A level the model is known to have goes through as it is; one it does not have becomes the closest the scale holds.
  if (how === "thinking-effort") {
    raw.thinking = { type: level === "none" ? "disabled" : "enabled" };
    if (level === "none") delete raw.reasoning_effort;
    else raw.reasoning_effort = level === "minimal" || level === "low" ? "low" : level === "max" || level === "ultra" ? "max" : "high";
  } else if (how === "effort") {
    // A model with no off/minimal level (e.g. Kimi K3) must never receive an invented one.
    const mapped = off ? "minimal" : level === "ultra" && has.includes("max") ? "max" : ["low", "medium", "high"].includes(level) ? level : "high";
    raw.reasoning_effort = has.includes(level) ? level : !has.length || has.includes(mapped) ? mapped : off ? has[0] : has.includes("high") ? "high" : has[has.length - 1];
  }
  // These upstreams only have on and off. Preserve vendor options such as Kimi thinking.keep.
  else if (how === "thinking") {
    delete raw.reasoning_effort;
    raw.thinking = { ...(raw.thinking && typeof raw.thinking === "object" && !Array.isArray(raw.thinking) ? raw.thinking as Json : {}), type: off ? "disabled" : "enabled" };
  } else if (how === "always-thinking") {
    // Ignore stale preferences after a model switch; neither a disabled thinking field nor a
    // reasoning_effort field is accepted by this model. Its native default is always enabled.
    delete raw.reasoning_effort; delete raw.thinking;
  } else if (how === "enable_thinking") raw.enable_thinking = !off;
}

/** Known non-Chat effort schemas. Return true only when this vendor mapping handled the field.
 * DeepSeek's off switch is not an output_config.effort value; its Messages and Responses APIs
 * express it differently. Other vendors retain the caller's ordinary protocol handling.
 */
export function applyOfficialProtocolEffort(body: Json, protocol: ApiProtocol, baseUrl: string, model: string, effort: unknown): boolean {
  const profile = officialThinkingProfile(baseUrl, model);
  if (profile?.style !== "thinking-effort" || !["messages", "responses"].includes(protocol) || typeof effort !== "string" || !/^[a-z][a-z0-9-]*$/i.test(effort)) return false;
  const level = effort.toLowerCase();
  const actual = level === "none" ? "none" : level === "minimal" || level === "low" ? "low" : level === "max" || level === "ultra" ? "max" : "high";
  if (protocol === "responses") body.reasoning = { ...(body.reasoning && typeof body.reasoning === "object" && !Array.isArray(body.reasoning) ? body.reasoning as Json : {}), effort: actual };
  else {
    body.thinking = { type: actual === "none" ? "disabled" : "enabled" };
    const output = { ...(body.output_config && typeof body.output_config === "object" && !Array.isArray(body.output_config) ? body.output_config as Json : {}) };
    if (actual === "none") delete output.effort; else output.effort = actual;
    if (Object.keys(output).length) body.output_config = output; else delete body.output_config;
  }
  return true;
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
        // A client that already sends it back (some do) is left alone.
        if (!(m as unknown as Json).reasoning_content) {
          const known = m.tool_calls.map(c => memory.recall(c.id)).find(Boolean);
          // A thinking-mode upstream insists on the field; a blank is accepted where the text is gone.
          (m as unknown as Json).reasoning_content = known ?? " ";
        }
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
