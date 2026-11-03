import { createHash } from "node:crypto";
import type { CatalogModel } from "./catalog.ts";

/** A display preference only. It is never a gateway authorization or routing whitelist. */
export const MAX_CLIENT_MODEL_MENU = 80;
export const MAX_CLIENT_MODEL_ID = 512;
export class ClientModelMenuError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 422, code = "CLIENT_MODEL_MENU_INVALID") {
    super(message); this.status = status; this.code = code;
  }
}

/** Split only at the first slash: upstream names can themselves contain slashes. */
export function validClientModelId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_CLIENT_MODEL_ID || value.trim() !== value || /[\p{C}\u2028\u2029]/u.test(value)) return false;
  const slash = value.indexOf("/");
  return slash > 0 && slash < value.length - 1;
}
export function validClientModelMenu(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_CLIENT_MODEL_MENU
    && Array.from(value).every(validClientModelId) && new Set(value).size === value.length;
}
export function readClientModelMenu(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!validClientModelMenu(value)) throw new ClientModelMenuError("模型菜单须为最多 80 个不重复的完整模型标识；请保留原始名称和顺序");
  return [...value];
}
/** null is the wire reset operation, never a persisted menu value. */
export function normalizeClientModelMenu(value: unknown): string[] | undefined {
  return value === null ? undefined : readClientModelMenu(value);
}
export function clientModelMenuDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function clientModelMenuConflict(): ClientModelMenuError {
  return new ClientModelMenuError("设置或可选模型已变化，请重新读取菜单并预览后确认", 409, "CLIENT_MODEL_MENU_CONFLICT");
}
export function clientModelMenuPreviewGuard(agentId: string, baseGuard: string, modelMenu: readonly string[] | undefined): string {
  return clientModelMenuDigest({ version: 1, agentId, baseGuard, modelMenu: modelMenu ?? null });
}
export function parseClientModelMenuRequest(body: unknown, apply: boolean): { modelMenu: string[] | undefined; baseGuard: string; previewGuard?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ClientModelMenuError("请提供完整菜单和预览确认标识", 400);
  const input = body as Record<string, unknown>, keys = apply ? ["modelMenu", "baseGuard", "previewGuard"] : ["modelMenu", "baseGuard"];
  if (Object.keys(input).length !== keys.length || keys.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !keys.includes(key))
    || typeof input.baseGuard !== "string" || !/^[a-f0-9]{64}$/.test(input.baseGuard)
    || apply && (typeof input.previewGuard !== "string" || !/^[a-f0-9]{64}$/.test(input.previewGuard))) {
    throw new ClientModelMenuError("请先重新读取菜单并完成预览；不能省略确认标识", 400);
  }
  return { modelMenu: normalizeClientModelMenu(input.modelMenu), baseGuard: input.baseGuard, ...(apply ? { previewGuard: input.previewGuard as string } : {}) };
}
export function validateClientModelMenuChange(menu: readonly string[] | undefined, before: readonly string[] | undefined, catalog: readonly CatalogModel[]): void {
  const selectable = new Set(catalog.map(m => `${m.providerId}/${m.model}`)), existing = new Set(before ?? []);
  if (menu?.some(id => !selectable.has(id) && !existing.has(id))) throw new ClientModelMenuError("新增模型必须在当前可选列表中；已有失效项可以保留、调整顺序或移除");
}
export interface RequiredClientModel { model: CatalogModel; reasons: string[] }
export function buildClientModelMenuView(input: { agentId: string; modelMenu: readonly string[] | undefined; baseGuard: string; catalog: readonly CatalogModel[]; required: readonly RequiredClientModel[] }) {
  const { agentId, modelMenu, baseGuard } = input;
  const catalog = [...new Map(input.catalog.filter(m => validClientModelId(`${m.providerId}/${m.model}`)).map(m => [`${m.providerId}/${m.model}`, m])).values()];
  if (catalog.length > 10_000) throw new ClientModelMenuError("可选模型超过 10,000 项，请先缩小来源目录后再编辑菜单");
  const ids = new Set(catalog.map(m => `${m.providerId}/${m.model}`));
  const selected = modelMenu === undefined ? [...ids] : modelMenu.filter(id => ids.has(id));
  const requiredRetained = agentId === "codex" && modelMenu !== undefined ? input.required
    .filter(r => !selected.includes(`${r.model.providerId}/${r.model.model}`))
    .map(r => ({ id: `${r.model.providerId}/${r.model.model}`, reasons: [...r.reasons] })) : [];
  const effectiveModelMenu = [...new Set([...selected, ...requiredRetained.map(r => r.id)])];
  return {
    agentId, modelMenu: modelMenu === undefined ? null : [...modelMenu], baseGuard,
    selectable: catalog.map(m => ({ id: `${m.providerId}/${m.model}`, providerName: m.providerName, model: m.model })),
    entries: (modelMenu ?? [...ids]).map(id => ({ id, selectable: ids.has(id) })),
    scope: agentId === "codex" ? { kind: "codex-next-enhanced-session" as const, description: "仅下次新开的 Codex CLI 增强会话使用此菜单；已有会话和 ChatGPT 桌面端不变" }
      : { kind: "console-only" as const, description: "仅用于 EasySwitch 控制台的本客户端菜单；不修改此客户端原生模型列表" },
    requiredRetained, effectiveModelMenu,
    warnings: ["只调整菜单，不改变主模型、备用模型、辅助模型、思考档位、来源开关或预算，也不是路由或访问白名单。",
      ...(modelMenu?.some(id => !ids.has(id)) ? [agentId === "codex" ? "已有失效项会原样保存；除下列必须保留的主模型或辅助模型外，不会加入下次生成的 Codex 模型目录。" : "已有失效项会原样保存，但当前不可选择；不会改动原生客户端菜单。"] : []),
      ...(requiredRetained.length ? ["为保持当前启动配置，Codex 仍会在自定义菜单末尾加入下列有效主模型或辅助模型。"] : [])],
  };
}

/** Produces a session catalog without mutating the global model catalog. */
export function clientSessionCatalog(catalog: readonly CatalogModel[], menu: readonly string[] | undefined, required: readonly RequiredClientModel[]): CatalogModel[] {
  const map = new Map(catalog.map(m => [`${m.providerId}/${m.model}`, m]));
  if (menu === undefined) return structuredClone([...catalog]);
  const result = menu.flatMap(id => map.has(id) ? [map.get(id)!] : []), have = new Set(result.map(m => `${m.providerId}/${m.model}`));
  for (const item of required) {
    const id = `${item.model.providerId}/${item.model.model}`;
    if (!have.has(id)) { result.push(item.model); have.add(id); }
  }
  return structuredClone(result);
}
