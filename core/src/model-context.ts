import type { Provider } from "./types.ts";

/** Explicit source/model configuration, not a claim verified by a model-name heuristic. */
export interface ModelContext {
  tokens: number;
  source: "user" | "pool" | "partial-pool";
}

export function validContextTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function providerContext(provider: Provider | undefined, model: string): ModelContext | undefined {
  const tokens = provider?.modelContextWindows?.[model];
  return validContextTokens(tokens) ? { tokens, source: "user" } : undefined;
}

/** Include every configured member, even one temporarily disabled or budget-blocked. */
export function poolContext(members: readonly (ModelContext | undefined)[]): ModelContext | undefined {
  const known = members.filter((m): m is ModelContext => m !== undefined);
  return known.length ? {
    tokens: Math.min(...known.map(m => m.tokens)),
    source: known.length === members.length ? "pool" : "partial-pool",
  } : undefined;
}

/** Unknown members keep the launcher's legacy default as an additional upper bound. */
export function contextTokens(context: ModelContext | undefined, fallback: number): number {
  if (!context) return fallback;
  return context.source === "partial-pool" ? Math.min(context.tokens, fallback) : context.tokens;
}
