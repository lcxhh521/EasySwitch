import type { ApiProtocol } from "./types.ts";

/** Fixed decoder field paths only. Never retain raw payloads, names or provider strings. */
export type UsageField =
  | "prompt_tokens" | "completion_tokens" | "prompt_tokens_details.cached_tokens" | "prompt_cache_hit_tokens" | "completion_tokens_details.reasoning_tokens"
  | "input_tokens" | "output_tokens" | "input_tokens_details.cached_tokens" | "output_tokens_details.reasoning_tokens"
  | "cache_read_input_tokens" | "cache_creation_input_tokens"
  | "promptTokenCount" | "candidatesTokenCount" | "cachedContentTokenCount" | "thoughtsTokenCount";

export type TokenObservation =
  | { state: "observed"; field: UsageField; value: number }
  | { state: "missing" | "invalid"; field: UsageField }
  /** No decoder mapping, not evidence that this token category is absent upstream. */
  | { state: "unmapped" };

/**
 * Additive diagnostic evidence, never a billing-completeness or pricing decision.
 * Counts describe the selected adapter's decoder input, which may already be
 * normalized by a subscription/CLI adapter. Earlier retries are not represented.
 * In Messages, input is the raw uncached input_tokens, NOT Usage.input's sum.
 * A missing observation on an old/unmetered entry means unknown, never zero.
 */
export interface UsageObservation {
  version: 1;
  protocol: ApiProtocol;
  stage: "decoder-input";
  scope: "selected-attempt";
  streaming: boolean;
  /** Latest decoded usage snapshot; Messages retains its existing start/delta merge. */
  counters: {
    input: TokenObservation;
    output: TokenObservation;
    cacheRead: TokenObservation;
    cacheWrite: TokenObservation;
    reasoning: TokenObservation;
  };
  /** A protocol terminal was seen, including length-limited/incomplete terminals. */
  terminalObserved: boolean;
  /** Final usage placement was verified at decoder finish, not complete billing. */
  finalUsageObserved: boolean;
  /** Error observed by capture time; false does not assert decoder success. */
  decoderFailed: boolean;
  /** Invalid frame observed by capture time; false does not assert validity. */
  decoderInvalid: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function at(raw: unknown, field: UsageField): unknown {
  let value: unknown = raw;
  for (const key of field.split(".")) {
    if (value === undefined) return undefined;
    // A malformed parent is invalid evidence, rather than a missing counter.
    if (!record(value)) return null;
    value = Object.hasOwn(value, key) ? value[key] : undefined;
  }
  return value;
}

function observed(raw: unknown, field: UsageField): TokenObservation {
  const value = at(raw, field);
  return count(value) ? { state: "observed", field, value } : { state: value === undefined ? "missing" : "invalid", field };
}

/** Whitelisted scalar extraction only; state is deliberately independent of usageOf defaults. */
export function observeUsage(protocol: ApiProtocol, raw: unknown, streaming: boolean): UsageObservation {
  const unmapped: TokenObservation = { state: "unmapped" };
  let counters: UsageObservation["counters"];
  if (protocol === "chat") {
    const primary = at(raw, "prompt_tokens_details.cached_tokens");
    const fallback = at(raw, "prompt_cache_hit_tokens");
    // Match the numeric decoder's nullish alias precedence without losing a
    // malformed primary when neither field provides a usable fallback.
    const cacheField = primary == null && fallback !== undefined ? "prompt_cache_hit_tokens" : "prompt_tokens_details.cached_tokens";
    counters = { input: observed(raw, "prompt_tokens"), output: observed(raw, "completion_tokens"), cacheRead: observed(raw, cacheField), cacheWrite: unmapped, reasoning: observed(raw, "completion_tokens_details.reasoning_tokens") };
  } else if (protocol === "responses") {
    counters = { input: observed(raw, "input_tokens"), output: observed(raw, "output_tokens"), cacheRead: observed(raw, "input_tokens_details.cached_tokens"), cacheWrite: unmapped, reasoning: observed(raw, "output_tokens_details.reasoning_tokens") };
  } else if (protocol === "messages") {
    counters = { input: observed(raw, "input_tokens"), output: observed(raw, "output_tokens"), cacheRead: observed(raw, "cache_read_input_tokens"), cacheWrite: observed(raw, "cache_creation_input_tokens"), reasoning: unmapped };
  } else {
    counters = { input: observed(raw, "promptTokenCount"), output: observed(raw, "candidatesTokenCount"), cacheRead: observed(raw, "cachedContentTokenCount"), cacheWrite: unmapped, reasoning: observed(raw, "thoughtsTokenCount") };
  }
  return { version: 1, protocol, stage: "decoder-input", scope: "selected-attempt", streaming, counters, terminalObserved: false, finalUsageObserved: false, decoderFailed: false, decoderInvalid: false };
}
