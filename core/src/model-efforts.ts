import { quirksFor } from "./quirks.ts";
import type { Provider } from "./types.ts";

/**
 * The thinking levels a model really has. A level is a property of the model, not of the agent that
 * talks to it: an agent can offer only the levels its model has and it can itself express.
 *
 * Order of authority: what the user set for this model on its provider; then what is known about
 * how the provider takes a level (see quirks.ts); a provider that takes none has none.
 */
export function modelEfforts(provider: Provider, model: string): string[] {
  if (provider.kiro) return [];
  const set = provider.modelEfforts?.[model];
  if (set) return set;
  const style = provider.plan ? "effort" : provider.reasoningEffort === undefined ? quirksFor(provider.baseUrl, model).reasoning : provider.reasoningEffort ? "effort" : "none";
  // "effort": Chat's scale, which ends at high (newer OpenAI models also take minimal).
  if (style === "effort") return /^(gpt-[5-9]|o[1-9])/i.test(model) ? ["minimal", "low", "medium", "high"] : ["low", "medium", "high"];
  // An on/off switch: not thinking, or thinking.
  if (style === "thinking" || style === "enable_thinking") return ["none", "high"];
  return [];
}

/** The levels an agent can offer for a model: its own words, kept in its order, that the model has too. */
export function levelsForAgentAndModel(agentLevels: readonly string[], modelLevels: readonly string[] | undefined): string[] {
  return modelLevels ? agentLevels.filter(l => modelLevels.includes(l)) : [...agentLevels];
}
