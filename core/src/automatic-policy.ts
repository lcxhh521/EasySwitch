import type { ApiProtocol } from "./types.ts";

/**
 * Automatic P0 deliberately supports only self-contained plain-text requests.
 * Check the raw shape, not decodeRequest's output: normalization can silently
 * discard native fields, signatures, tool controls, or unknown capability demands.
 * This is a capability gate, not authorization or a source/model selector.
 */
type ObjectValue = Record<string, unknown>;
const protocols: readonly string[] = ["chat", "responses", "messages", "gemini"];
const common = ["model", "stream", "tools"];
const fields: Record<ApiProtocol, readonly string[]> = {
  chat: [...common, "messages", "temperature", "top_p", "max_tokens", "max_completion_tokens", "response_format"],
  responses: [...common, "input", "instructions", "temperature", "top_p", "max_output_tokens", "text"],
  messages: [...common, "messages", "system", "temperature", "top_p", "max_tokens"],
  gemini: [...common, "contents", "systemInstruction", "system_instruction", "generationConfig"],
};
const unsupported = "自动选择目前仅支持无工具、无媒体、无续传状态的纯文本请求；此请求含有未支持的字段或格式，请选择固定来源重试。";
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: ObjectValue, key: string): boolean => Object.hasOwn(value, key);
const only = (value: ObjectValue, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const range = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const positiveInteger = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const list = (value: unknown, valid: (item: unknown) => boolean): boolean => Array.isArray(value) && value.length > 0 && value.every(valid);
const plainFormat = (value: unknown): boolean => object(value) && only(value, ["type"]) && value.type === "text";

function textContent(value: unknown, types: readonly string[]): boolean {
  return typeof value === "string" || list(value, part => object(part)
    && only(part, ["type", "text"]) && typeof part.type === "string" && types.includes(part.type) && typeof part.text === "string");
}
function message(value: unknown, roles: readonly string[], types: readonly string[], response = false): boolean {
  return object(value) && only(value, response ? ["type", "role", "content"] : ["role", "content"])
    && (!has(value, "type") || value.type === "message")
    && typeof value.role === "string" && roles.includes(value.role) && textContent(value.content, types);
}
function geminiParts(value: unknown): boolean {
  // text beside a native field is not pure text (including thought: false or a
  // null signature); never let the decoder's text branch conceal that field.
  return list(value, part => object(part) && only(part, ["text"]) && typeof part.text === "string");
}
function basicKnobs(value: ObjectValue, maxKey: string, temperatureMax = 2, topPKey = "top_p"): boolean {
  return (!has(value, maxKey) || positiveInteger(value[maxKey]))
    && (!has(value, "temperature") || range(value.temperature, 0, temperatureMax))
    && (!has(value, topPKey) || range(value[topPKey], 0, 1));
}

/** Undefined permits the request shape only; the caller must still validate the entire approved source/credential list. */
export function automaticTextRequestIssue(protocol: ApiProtocol, raw: string): string | undefined {
  if (!protocols.includes(protocol) || typeof raw !== "string") return unsupported;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return "自动选择收到的请求不是合法 JSON，请检查请求或选择固定来源重试。"; }
  if (!object(value) || !only(value, fields[protocol])) return unsupported;
  if (has(value, "model") && (typeof value.model !== "string" || !value.model.trim())) return unsupported;
  if (has(value, "stream") && typeof value.stream !== "boolean") return unsupported;
  if (has(value, "tools") && (!Array.isArray(value.tools) || value.tools.length !== 0)) return unsupported;

  if (protocol === "chat") {
    if (!list(value.messages, entry => message(entry, ["system", "developer", "user", "assistant"], ["text"]))
      || !basicKnobs(value, "max_tokens")
      || (has(value, "max_completion_tokens") && !positiveInteger(value.max_completion_tokens))
      || (has(value, "max_tokens") && has(value, "max_completion_tokens"))
      || (has(value, "response_format") && !plainFormat(value.response_format))) return unsupported;
  } else if (protocol === "responses") {
    if (!(typeof value.input === "string" || list(value.input, entry => message(entry, ["system", "developer", "user", "assistant"], ["input_text", "output_text"], true)))
      || (has(value, "instructions") && typeof value.instructions !== "string")
      || !basicKnobs(value, "max_output_tokens")
      || (has(value, "text") && (!object(value.text) || !only(value.text, ["format"]) || !plainFormat(value.text.format)))) return unsupported;
  } else if (protocol === "messages") {
    if (!list(value.messages, entry => message(entry, ["user", "assistant"], ["text"]))
      || (has(value, "system") && !textContent(value.system, ["text"]))
      || !positiveInteger(value.max_tokens) || !basicKnobs(value, "max_tokens", 1)) return unsupported;
  } else {
    if (!list(value.contents, entry => object(entry) && only(entry, ["role", "parts"])
      && (!has(entry, "role") || entry.role === "user" || entry.role === "model") && geminiParts(entry.parts))) return unsupported;
    if (has(value, "systemInstruction") && has(value, "system_instruction")) return unsupported;
    for (const key of ["systemInstruction", "system_instruction"]) if (has(value, key)) {
      const system = value[key];
      if (!object(system) || !only(system, ["parts"]) || !geminiParts(system.parts)) return unsupported;
    }
    if (has(value, "generationConfig")) {
      const config = value.generationConfig;
      if (!object(config) || !only(config, ["maxOutputTokens", "temperature", "topP"])
        || !basicKnobs(config, "maxOutputTokens", 2, "topP")) return unsupported;
    }
  }
  // Do not inspect text for marker-like substrings. Only structural continuation
  // fields are unsafe; a user can legitimately discuss the literal es-state:.
  return undefined;
}

const cooldownMs = 60_000;
const maxEntries = 1_024;
const maxIdentityLength = 4_096;
const timestamp = (value: number): boolean => Number.isSafeInteger(value) && value >= 0 && Number.isSafeInteger(value + cooldownMs);
const eligibleStatus = (value: number): boolean => Number.isInteger(value) && (value === 401 || value === 403 || value === 429 || (value >= 500 && value <= 599));

/**
 * Short-lived, passive negative evidence from actual inference HTTP responses.
 * identity must be an opaque approval-snapshot + member/credential fingerprint,
 * never merely a provider ID. The caller revalidates the installed approval
 * before recording. No quota maps, positive scores, probes, disk, or secrets.
 * Expiry/absence means unknown, not healthy, paid allowance, or quota restored.
 */
export class AutomaticFailureLedger {
  #observed = new Map<string, number>();

  #key(identity: string, protocol: ApiProtocol): string | undefined {
    if (typeof identity !== "string" || !identity.length || identity.length > maxIdentityLength || !protocols.includes(protocol)) return undefined;
    return JSON.stringify([identity, protocol]);
  }

  waitUntil(identity: string, protocol: ApiProtocol, now = Date.now()): number | undefined {
    const key = this.#key(identity, protocol);
    if (key === undefined || !timestamp(now)) return undefined;
    const observedAt = this.#observed.get(key);
    if (observedAt === undefined || !timestamp(observedAt) || observedAt > now) return undefined;
    const until = observedAt + cooldownMs;
    // Reads neither prune nor promote entries. Status reads cannot advance routing.
    return until > now ? until : undefined;
  }

  record(identity: string, protocol: ApiProtocol, status: number, observedAt = Date.now()): void {
    const key = this.#key(identity, protocol);
    if (key === undefined || !eligibleStatus(status) || !timestamp(observedAt) || observedAt > Date.now()) return;
    const previous = this.#observed.get(key);
    if (previous !== undefined && previous >= observedAt) return;
    this.#observed.delete(key);
    this.#observed.set(key, observedAt);
    if (this.#observed.size > maxEntries) this.#observed.delete(this.#observed.keys().next().value!);
  }
}
