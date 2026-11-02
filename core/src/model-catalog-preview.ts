import { createHash, randomUUID } from "node:crypto";
import { keySecretId } from "./keypool.ts";
import { listModels } from "./probe.ts";
import type { SecretStore } from "./secrets.ts";
import type { Store } from "./store.ts";
import type { Provider } from "./types.ts";

export class ModelCatalogError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "MODEL_CATALOG_ERROR") { super(message); this.status = status; this.code = code; }
}
const conflict = () => new ModelCatalogError(409, "来源或预览已改变，请重新刷新模型列表", "MODEL_CATALOG_CONFLICT");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const active = (signal?: AbortSignal) => { if (signal?.aborted) throw conflict(); };
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 512 && id.trim() === id && !/[\s\u0000-\u001f\u007f]/u.test(id) && !["__proto__", "prototype", "constructor"].includes(id);
interface Snapshot { provider: Provider; account: string; configuration: string; revision: string; credentialRevision: string; credentialHash: string; key?: string }
interface Preview { id: string; snapshot: Snapshot; added: string[]; expires: number }

/** Ephemeral consent, not a new catalog or background refresh job. */
export class ModelCatalogPreviews {
  #store: Store;
  #secrets: SecretStore;
  #now: () => number;
  #list: typeof listModels;
  #previews = new Map<string, Preview>();
  #pending = new Set<string>();
  constructor(store: Store, secrets: SecretStore, options: { now?: () => number; list?: typeof listModels } = {}) {
    this.#store = store; this.#secrets = secrets; this.#now = options.now ?? Date.now; this.#list = options.list ?? listModels;
  }
  #provider(id: string): Provider {
    const p = this.#store.provider(id);
    if (!p) throw new ModelCatalogError(404, "没有这个模型来源");
    if (["plan", "antigravity", "kimi", "cursor", "kiro", "vertex", "mimoFree", "cliTextBridge"].some(key => (p as unknown as Record<string, unknown>)[key] !== undefined)) throw new ModelCatalogError(409, "此来源使用专用模型列表，请使用其专用管理入口");
    if (!Array.isArray(p.models) || p.models.length > 10000 || p.models.some(id => !validId(id))) throw new ModelCatalogError(409, "已有模型列表格式无效，请先检查来源配置");
    return p;
  }
  async #capture(id: string, signal?: AbortSignal): Promise<Snapshot> {
    active(signal);
    const provider = this.#provider(id);
    const keyEntry = provider.keys?.find(key => key.enabled === true);
    if (provider.keys?.length && !keyEntry) throw new ModelCatalogError(409, "没有已启用的 Key，未读取模型列表");
    // Deterministic first enabled key; never rotate, retry, rest or mark a key used.
    const account = keyEntry ? keySecretId(id, keyEntry.id) : id;
    const configuration = hash(provider), revision = this.#store.providerConfigurationRevision(id), credentialRevision = this.#store.credentialRevision(account);
    let key: string | undefined;
    try { key = await this.#secrets.get(account); } catch { throw new ModelCatalogError(503, "暂时无法读取此来源的凭据"); }
    active(signal);
    if (hash(this.#provider(id)) !== configuration || this.#store.providerConfigurationRevision(id) !== revision || this.#store.credentialRevision(account) !== credentialRevision) throw conflict();
    if (keyEntry && !key) throw new ModelCatalogError(409, "所选已启用 Key 不可读取，请检查凭据");
    return { provider, account, configuration, revision, credentialRevision, credentialHash: hash(key ?? null), key };
  }
  #same(a: Snapshot, b: Snapshot): boolean { return a.configuration === b.configuration && a.revision === b.revision && a.account === b.account && a.credentialRevision === b.credentialRevision && a.credentialHash === b.credentialHash; }
  #prune() { for (const [token, p] of this.#previews) if (p.expires <= this.#now()) this.#previews.delete(token); }
  async preview(id: string, signal?: AbortSignal) {
    this.#prune();
    if (this.#pending.has(id) || this.#pending.size >= 16) throw new ModelCatalogError(409, "模型列表正在读取，请稍后重试");
    this.#pending.add(id);
    for (const [token, p] of this.#previews) if (p.id === id) this.#previews.delete(token);
    try {
      const before = await this.#capture(id, signal);
      let result: Awaited<ReturnType<typeof listModels>>;
      try { result = await this.#list(before.provider, before.key, signal); } catch { active(signal); throw new ModelCatalogError(502, "无法读取模型列表；请检查来源地址、凭据和目录接口"); }
      active(signal);
      if (result.check.status !== "pass" || !Array.isArray(result.models) || result.models.length > 500 || result.models.some(id => !validId(id))) throw new ModelCatalogError(502, "模型列表为空、读取失败或格式不受支持；现有模型未更改");
      const after = await this.#capture(id, signal);
      if (!this.#same(before, after)) throw conflict();
      const discovered = [...new Set(result.models)], current = new Set(before.provider.models);
      const added = discovered.filter(id => !current.has(id));
      if (before.provider.models.length + added.length > 10000) throw new ModelCatalogError(409, "模型列表超出容量，未更改现有模型");
      const token = randomUUID(), expires = this.#now() + 5 * 60_000;
      // Never retain plaintext credentials in the consent cache.
      delete before.key;
      while (this.#previews.size >= 64) this.#previews.delete(this.#previews.keys().next().value!);
      this.#previews.set(token, { id, snapshot: before, added, expires });
      return { token, expiresAt: new Date(expires).toISOString(), added, existing: discovered.filter(id => current.has(id)), missing: [...current].filter(id => !discovered.includes(id)), discoveredCount: discovered.length, limit: 500 };
    } finally { this.#pending.delete(id); }
  }
  async apply(id: string, token: unknown, models: unknown, signal?: AbortSignal) {
    if (typeof token !== "string" || !/^[a-f0-9-]{36}$/.test(token) || !Array.isArray(models) || !models.length || models.length > 500 || models.some(id => !validId(id)) || new Set(models).size !== models.length) throw new ModelCatalogError(400, "请选择本次预览中有效且不重复的新模型");
    this.#prune();
    const preview = this.#previews.get(token);
    if (!preview || preview.id !== id || models.some(model => !preview.added.includes(model))) throw conflict();
    const current = await this.#capture(id, signal);
    active(signal);
    if (this.#previews.get(token) !== preview || preview.expires <= this.#now() || !this.#same(preview.snapshot, current)) throw conflict();
    const added = preview.added.filter(model => models.includes(model));
    // No await from final guard to persistence: preserve all other current fields.
    this.#store.upsertProvider({ ...current.provider, models: [...current.provider.models, ...added] });
    this.#previews.delete(token);
    return { added, modelCount: current.provider.models.length + added.length };
  }
}
