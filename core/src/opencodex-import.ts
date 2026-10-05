import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Provider } from "./types.ts";
import type { SecretStore } from "./secrets.ts";
import type { Store } from "./store.ts";
import { keySecretId, newKeyId } from "./keypool.ts";

/**
 * Import what the user already configured in opencodex, so switching tools
 * means pasting nothing twice. ~/.opencodex/config.json keeps providers with
 * plaintext keys; those move straight into the Keychain and are never logged,
 * returned, or shown. The ChatGPT passthrough provider (authMode "forward")
 * is skipped: it is opencodex's own subscription routing, not a key source.
 */

export interface OpencodexCandidate {
  /** opencodex's provider id (ark, tx, …). */
  sourceId: string;
  name: string;
  baseUrl: string;
  anthropicBaseUrl?: string;
  models: string[];
  defaultModel?: string;
  keys: number;
  /** Why it is not importable, when that is so. */
  skipReason?: string;
}

interface OcProvider {
  adapter?: string;
  baseUrl?: string;
  apiKey?: string;
  apiKeyPool?: Array<{ id?: string; key?: string; label?: string }>;
  models?: string[];
  defaultModel?: string;
  authMode?: string;
  headers?: Record<string, string>;
}

/** opencodex's tx-style base URLs sometimes point at the endpoint file itself. */
function normalizeBaseUrl(url: string): string {
  return url.replace(/\/chat\/completions\/?$/, "").replace(/\/+$/, "");
}

export function opencodexCandidates(configPath?: string): OpencodexCandidate[] {
  const file = configPath ?? join(homedir(), ".opencodex", "config.json");
  let config: { providers?: Record<string, OcProvider>; providers_meta?: Record<string, { name?: string }> };
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const meta = (config as { providers?: Record<string, OcProvider> } & { providers_meta?: Record<string, { name?: string }> }).providers_meta ?? {};
  const out: OpencodexCandidate[] = [];
  for (const [id, p] of Object.entries(config.providers ?? {})) {
    const name = meta[id]?.name ?? (id === "ark" ? "火山方舟" : id === "tx" ? "腾讯 TRT Copilot" : id === "dot" ? "Dot" : id === "dev" ? "dev" : id);
    const base = {
      sourceId: id, name,
      baseUrl: normalizeBaseUrl(p.baseUrl ?? ""),
      models: p.models ?? [],
      ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
      keys: (p.apiKey ? 1 : 0) + (p.apiKeyPool?.filter(k => k.key).length ?? 0),
    };
    if (p.authMode === "forward") out.push({ ...base, skipReason: "ChatGPT 透传（opencodex 自己的原生路由），不导入" });
    else if (!/^https?:\/\//.test(base.baseUrl)) out.push({ ...base, skipReason: "地址缺失" });
    else if (!base.keys) out.push({ ...base, skipReason: "没有 Key" });
    else out.push(base);
  }
  return out;
}

export interface ImportResult {
  imported: Array<{ sourceId: string; providerId: string; models: number; keys: number }>;
  failed: Array<{ sourceId: string; reason: string }>;
}

const ANTHROPIC_ADAPTERS = new Set(["anthropic", "claude", "anthropic-chat"]);

/** Imports the chosen candidates: provider row, models, and keys → Keychain. */
export async function importFromOpencodex(
  chosen: readonly string[],
  configPath: string | undefined,
  store: Store,
  secrets: SecretStore,
  probe: (provider: Provider, apiKey?: string) => Promise<{ models: string[] }>,
): Promise<ImportResult> {
  const file = configPath ?? join(homedir(), ".opencodex", "config.json");
  const config = JSON.parse(readFileSync(file, "utf8")) as { providers?: Record<string, OcProvider>; providers_meta?: Record<string, { name?: string }> };
  const result: ImportResult = { imported: [], failed: [] };
  for (const sourceId of chosen) {
    const p = config.providers?.[sourceId];
    if (!p?.baseUrl) {
      result.failed.push({ sourceId, reason: "配置里已经没有这一项" });
      continue;
    }
    const candidates = opencodexCandidates(configPath).filter(c => c.sourceId === sourceId);
    if (candidates[0]?.skipReason) {
      result.failed.push({ sourceId, reason: candidates[0].skipReason });
      continue;
    }
    const baseUrl = normalizeBaseUrl(p.baseUrl);
    const id = slugFor(sourceId, store);
    const provider: Provider = {
      id, name: candidates[0]?.name ?? sourceId,
      baseUrl,
      ...(ANTHROPIC_ADAPTERS.has(p.adapter ?? "") ? { anthropicBaseUrl: baseUrl } : {}),
      models: p.models ?? [],
      ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
      route: "chat-translate", routePinned: false, streamUsage: true,
      createdAt: new Date().toISOString(),
    };
    try {
      if (p.apiKey) await secrets.set(id, p.apiKey);
      for (const k of p.apiKeyPool ?? []) {
        if (k.key) await secrets.set(keySecretId(id, k.id ?? newKeyId()), k.key);
      }
      if (!provider.defaultModel && provider.models.length) provider.defaultModel = provider.models[0];
      // One cheap upstream call to refresh the model list with our own probe;
      // a failure keeps the imported list instead of failing the import.
      if (provider.defaultModel) {
        const apiKey = p.apiKey ? p.apiKey : undefined;
        try {
          const { models } = await probe(provider, apiKey);
          if (models.length) provider.models = models;
        } catch {
          // Keep the imported list.
        }
      }
      store.upsertProvider(provider);
      result.imported.push({ sourceId, providerId: id, models: provider.models.length, keys: (p.apiKey ? 1 : 0) + (p.apiKeyPool?.length ?? 0) });
    } catch (error) {
      result.failed.push({ sourceId, reason: String((error as Error).message ?? error) });
    }
  }
  return result;
}

function slugFor(sourceId: string, store: Store): string {
  const taken = store.providers().map(p => p.id);
  let slug = sourceId;
  for (let n = 2; taken.includes(slug); n += 1) slug = `${sourceId}-${n}`;
  return slug;
}

