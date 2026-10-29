import { createHash } from "node:crypto";
import type { HarnessBinding, Profile, Provider, Pool } from "./types.ts";

export class ProfilePreviewError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 422, code = "PROFILE_PREVIEW_INVALID") {
    super(message); this.status = status; this.code = code;
  }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function validPrefs(value: unknown): boolean {
  return record(value) && Object.values(value).every(p => record(p) && Object.keys(p).every(k => ["effort", "fallbackModel", "tiers"].includes(k)) &&
    (p.effort === undefined || typeof p.effort === "string") && (p.fallbackModel === undefined || typeof p.fallbackModel === "string") &&
    (p.tiers === undefined || record(p.tiers) && Object.values(p.tiers).every(v => typeof v === "string")));
}
function validBindings(value: unknown): value is HarnessBinding[] {
  return Array.isArray(value) && value.every(b => record(b) && Object.keys(b).every(k => ["harness", "providerId", "model"].includes(k)) && [b.harness, b.providerId, b.model].every(v => typeof v === "string" && v.length > 0)) && new Set(value.map(b => b.harness)).size === value.length;
}
export function profileBindings(profile: Profile, providers: Provider[], pools: Pool[]): HarnessBinding[] {
  return structuredClone(profile.bindings).filter(b => b.providerId === "pool" ? pools.some(p => p.id === b.model) : providers.some(p => p.id === b.providerId));
}
export function buildProfilePreview(profile: Profile, current: { bindings: HarnessBinding[]; prefs: Profile["prefs"]; revision?: string; budgetBlocked?: string[]; bindingRevisions?: Record<string, string>; providerRevisions?: Record<string, string> }, providers: Provider[], pools: Pool[]) {
  if (!validBindings(profile.bindings) || !validPrefs(profile.prefs) || !validBindings(current.bindings) || !validPrefs(current.prefs)) {
    throw new ProfilePreviewError("这套设置或当前设置不完整，无法安全预览；请重新保存后再试");
  }
  const proposed = profileBindings(profile, providers, pools);
  const view = (bindings: HarnessBinding[], prefs: Profile["prefs"], harness: string) => {
    const b = bindings.find(item => item.harness === harness), p = prefs[harness];
    return { binding: b ? { providerId: b.providerId, model: b.model } : null,
      prefs: p ? { ...(p.effort === undefined ? {} : { effort: p.effort }), ...(p.fallbackModel === undefined ? {} : { fallbackModel: p.fallbackModel }), ...(p.tiers === undefined ? {} : { tiers: structuredClone(p.tiers) }) } : {} };
  };
  const warning = (id: string): string[] => {
    if (!id) return [];
    const slash = id.indexOf("/"), providerId = id.slice(0, slash), model = id.slice(slash + 1);
    if (slash < 1) return ["模型标识无法解析；设置仍会原样恢复"];
    if (providerId === "pool") return pools.some(p => p.id === model) ? ["模型池将按当前成员和策略运行，不恢复历史池配置"] : ["模型池已不存在"];
    const p = providers.find(p => p.id === providerId);
    if (!p) return ["来源已不存在"];
    return [...(p.off ? ["来源已关闭；恢复设置不会自动开启"] : []), ...(current.budgetBlocked?.includes(p.id) ? ["来源已被当前预算暂停；恢复设置不会解除预算"] : []), ...(!(p.models.length ? p.models : p.defaultModel ? [p.defaultModel] : []).includes(model) ? ["模型未在来源当前列表中；恢复不保证可用"] : [])];
  };
  const harnesses = [...new Set([...current.bindings.map(b => b.harness), ...profile.bindings.map(b => b.harness), ...Object.keys(current.prefs), ...Object.keys(profile.prefs)])].sort();
  const changes = harnesses.map(harness => {
    const before = view(current.bindings, current.prefs, harness), after = view(proposed, profile.prefs, harness);
    const original = profile.bindings.find(b => b.harness === harness), prefs = profile.prefs[harness];
    const warnings = [...(original && !after.binding ? ["主模型的来源或模型池已移除；应用后恢复原生"] : []),
      ...(original ? warning(`${original.providerId}/${original.model}`).map(w => `主模型：${w}`) : []),
      ...(prefs?.fallbackModel ? warning(prefs.fallbackModel).map(w => `备用模型：${w}`) : []),
      ...Object.entries(prefs?.tiers ?? {}).flatMap(([tier, id]) => warning(id).map(w => `${tier}：${w}`))];
    return { harness, before, after, changed: JSON.stringify(before) !== JSON.stringify(after), warnings };
  });
  const fingerprint = createHash("sha256").update(JSON.stringify({ version: 1, current, profile,
    providers: providers.map(p => ({ id: p.id, off: p.off, models: p.models, defaultModel: p.defaultModel })), pools })).digest("hex");
  return { profileId: profile.id, name: profile.name, fingerprint, changes,
    summary: { clients: changes.length, changed: changes.filter(c => c.changed).length, clearedBindings: changes.filter(c => c.before.binding && !c.after.binding).length },
    warnings: ["将替换全部客户端的主模型、思考级别、备用和辅助模型；未保存的设置会清除。来源、模型池、账号和原生客户端配置不变。预览不发起登录、探测或推理请求，不保证实际模型可用。"] };
}
