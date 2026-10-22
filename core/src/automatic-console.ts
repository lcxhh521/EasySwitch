import { automaticLocalStamp } from "./automatic-local-stamp.ts";
/** Explicit local review and atomic binding. Never launches, probes, rotates keys or expands an old pool. */
import { randomUUID } from "node:crypto";
import { AGENTS } from "./agents.ts";
import { buildPoolSuggestions } from "./pool-suggestions.ts";
import { mintAutomaticApproval, validateAutomaticSnapshot, validateApproval, publicAutomaticApproval, automaticToolApprovalId } from "./automatic-approval.ts";
import { ProtocolError } from "./protocol.ts";
import type { Store } from "./store.ts";
import type { SecretStore } from "./secrets.ts";
import type { HarnessBinding, Pool } from "./types.ts";

const TTL = 5 * 60_000;
const changed = () => new ProtocolError("来源、固定凭据或程序选择已变化，请重新核对并确认。", 409);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function publicAutomaticPool(pool: Pool) {
  const { automaticApproval, ...plain } = pool;
  return { ...plain, ...(automaticApproval ? { automaticApproval: publicAutomaticApproval(automaticApproval), automaticToolsApprovalId: automaticToolApprovalId(pool) } : {}) };
}
interface Pending {
  expiresAt: number;
  harness: string;
  previous?: HarnessBinding;
  previousRevision: string;
  localStamp: string;
  resultRevision?: string;
  pool: Pool;
  result?: { pool: ReturnType<typeof publicAutomaticPool>; binding: HarnessBinding };
  running?: Promise<{ pool: ReturnType<typeof publicAutomaticPool>; binding: HarnessBinding }>;
}
export class AutomaticPoolConsole {
  private readonly store: Store;
  private readonly secrets: SecretStore;
  private readonly pending = new Map<string, Pending>();
  constructor(store: Store, secrets: SecretStore) { this.store = store; this.secrets = secrets; }
  async preview(modelId: unknown, harness: unknown) {
    if (typeof modelId !== "string" || modelId.length > 512 || typeof harness !== "string" || !AGENTS.some(a => a.id === harness)) throw new ProtocolError("请选择当前模型和已登记的程序。", 400);
    const previous = this.store.binding(harness), previousRevision = this.store.bindingRevision(harness);
    if (previous && `${previous.providerId}/${previous.model}` !== modelId) throw changed();
    // Reuse conservative name matching, without rewriting or absorbing any existing pool.
    const suggestion = buildPoolSuggestions({ models: this.store.catalog(), pools: [], dismissed: [] }).find(s => s.members.some(m => m.modelId === modelId));
    if (!suggestion) throw new ProtocolError("这个模型还没有两个可确认的同名来源，请继续使用固定来源。", 400);
    const members = [modelId, ...suggestion.members.map(m => m.modelId).filter(m => m !== modelId)];
    const labels = new Map(suggestion.members.map(m => [m.modelId, m.providerName]));
    const localStamp = automaticLocalStamp(this.store, members);
    let approval;
    try { approval = await mintAutomaticApproval(this.store, this.secrets, members); }
    catch { throw new ProtocolError("这些来源暂不能核实为普通HTTP来源与固定Key，请使用固定来源或检查设置。", 400); }
    if (localStamp !== automaticLocalStamp(this.store, members) || previousRevision !== this.store.bindingRevision(harness) || !same(previous, this.store.binding(harness))) throw changed();
    const now = Date.now();
    for (const [id, p] of this.pending) if (p.expiresAt <= now && !p.running) this.pending.delete(id);
    if (this.pending.size >= 64) throw new ProtocolError("待确认的选择太多，请稍后重新打开。", 429);
    const confirmationId = `automatic-${randomUUID()}`, expiresAt = now + TTL;
    const pool: Pool = { id: `auto-${randomUUID()}`, name: `${suggestion.model} · 自动`, strategy: "automatic", members, automaticApproval: approval, createdAt: new Date(now).toISOString() };
    this.pending.set(confirmationId, { expiresAt, harness, previous, previousRevision, localStamp, pool });
    return { confirmationId, expiresAt, model: suggestion.model, primaryModelId: modelId, harness,
      members: approval.members.map(m => ({ modelId: m.member, providerName: labels.get(m.member)!, keyLabel: m.credentialLabel || "固定Key", billing: this.store.provider(m.member.slice(0, m.member.indexOf("/")))!.billing ?? "usage" })) };
  }
  async confirm(confirmationId: unknown) {
    if (typeof confirmationId !== "string" || !/^automatic-[a-f0-9-]{36}$/.test(confirmationId)) throw new ProtocolError("请先核对自动选择的来源名单。", 400);
    const pending = this.pending.get(confirmationId);
    if (!pending || pending.expiresAt <= Date.now()) throw changed();
    if (pending.running) return pending.running;
    const localCurrent = () => pending.localStamp === automaticLocalStamp(this.store, pending.pool.members);
    const resultCurrent = () => localCurrent() && same(this.store.pool(pending.pool.id), pending.pool)
      && pending.resultRevision === this.store.bindingRevision(pending.harness) && same(this.store.binding(pending.harness), pending.result?.binding);
    const operation = async () => {
      if (pending.result) {
        // An uncertain response can be checked, but never used to overwrite a later choice.
        if (!resultCurrent() || !(await validateApproval(this.store, this.secrets, pending.pool)).ok || !resultCurrent()) throw changed();
        return structuredClone(pending.result);
      }
      if (!localCurrent() || (pending.previousRevision !== this.store.bindingRevision(pending.harness) || !same(this.store.binding(pending.harness), pending.previous))) throw changed();
      if (!(await validateAutomaticSnapshot(this.store, this.secrets, pending.pool.members, pending.pool.automaticApproval!)).ok) throw changed();
      if (pending.expiresAt <= Date.now() || !localCurrent() || (pending.previousRevision !== this.store.bindingRevision(pending.harness) || !same(this.store.binding(pending.harness), pending.previous))) throw changed();
      const allowed = new Set(this.store.catalog().map(m => `${m.providerId}/${m.model}`));
      if (pending.pool.members.some(m => !allowed.has(m))) throw changed();
      this.store.installAutomaticPoolAndBind(pending.pool, pending.harness);
      pending.resultRevision = this.store.bindingRevision(pending.harness);
      pending.result = { pool: publicAutomaticPool(pending.pool), binding: this.store.binding(pending.harness)! };
      return structuredClone(pending.result);
    };
    pending.running = operation();
    try { return await pending.running; } finally { pending.running = undefined; }
  }
}
