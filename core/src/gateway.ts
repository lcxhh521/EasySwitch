import { anthropicModelList } from "./catalog.ts";
import { applyEffort, type Quirks } from "./quirks.ts";
import { agentOf } from "./gateway-chat.ts";
import { modelEfforts } from "./model-efforts.ts";
import { liveMembers, poolOf } from "./pools.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SecretStore } from "./secrets.ts";
import type { Store } from "./store.ts";
import type { ChatRequest } from "./translate.ts";
import type { GatewayLogEntry, Provider } from "./types.ts";
import { parseRequest, routeRequest } from "./gateway-route.ts";

type Json = Record<string, unknown>;

export interface GatewayDeps {
  store: Store;
  secrets: SecretStore;
  log: (entry: GatewayLogEntry) => void;
}

/** `<provider id>/<upstream model>`: the provider is everything before the first slash. */
export function resolveModel(store: Store, exposed: string): { provider: Provider; model: string } | undefined {
  // A pool stands for its first member wherever a single model is needed (validation, defaults); requests themselves are spread over the members by runWithPool.
  const pool = poolOf(store, exposed);
  if (pool) {
    const first = liveMembers(store, pool)[0];
    return first ? resolveModel(store, first) : undefined;
  }
  const slash = exposed.indexOf("/");
  if (slash <= 0) return undefined;
  const provider = store.provider(exposed.slice(0, slash));
  const model = exposed.slice(slash + 1);
  return provider && model ? { provider, model } : undefined;
}

/** OpenAI's list shape by default; Anthropic's ModelInfo list when Claude Code asks. */
/**
 * The thinking level for one call. What the user saved for the agent wins and is said in the
 * upstream's own way; without one, an agent's own request is passed on only to upstreams that
 * take Chat's `reasoning_effort`, so nothing changes for anyone who never touched the setting.
 */
export function applyThinking(chat: ChatRequest, store: Store, agent: string, requested: unknown, provider: Provider, quirks: Quirks): void {
  const style = provider.plan ? "effort" : provider.reasoningEffort === undefined ? quirks.reasoning : provider.reasoningEffort ? "effort" : "none";
  const saved = store.prefs(agent).effort;
  const has = modelEfforts(provider, chat.model);
  if (saved) applyEffort(chat, saved, style, has);
  else if (style === "effort") applyEffort(chat, requested, style, has);
}

export function listExposedModels(store: Store, anthropic = false): Json {
  const models = store.catalog();
  if (anthropic) return anthropicModelList(models);
  return { object: "list", data: models.map(m => ({ id: `${m.providerId}/${m.model}`, object: "model", owned_by: m.providerId })) };
}

export async function handleResponses(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: GatewayDeps): Promise<void> {
  const body = parseRequest(res, "responses", rawBody);
  if (body) await routeRequest(req, res, { protocol: "responses", body, model: String(body.model ?? ""), stream: body.stream === true }, agentOf(req.headers.authorization, "codex"), deps);
}
