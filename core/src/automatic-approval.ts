/** Explicit automatic selection grants. No network, refresh, probe, account inference or key rotation. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizePoolModel } from "./pool-suggestions.ts";
import type { SecretStore } from "./secrets.ts";
import type { Store } from "./store.ts";
import type { AutomaticApproval, Pool, Provider } from "./types.ts";

const MAX_MEMBERS = 32;
const INVALID = "自动选择的来源或固定凭据已变更或无法核实，请重新确认来源名单。";
const ABORTED = "请求已取消，不再读取或切换自动选择来源。";

export class AutomaticApprovalError extends Error {
  readonly code = "automatic_approval_invalid";
  constructor(cancelled = false) { super(cancelled ? ABORTED : INVALID); this.name = "AutomaticApprovalError"; }
}
export type AutomaticApprovalValidation = { ok: true } | { ok: false; reason: string };
export type PublicAutomaticApproval = Pick<AutomaticApproval, "version"> & { members: Array<Omit<AutomaticApproval["members"][number], "seal" | "configurationSeal">> };

/** Sort object properties so irrelevant serialization order is not a configuration change. */
function canonical(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, normalize(x)]));
    return v;
  };
  return JSON.stringify(normalize(value));
}

/** Identity-affecting configuration only. Passive usage/health records are not a new authorization. */
export function automaticProviderConfiguration(provider: Provider): string {
  // Context windows only describe a future client's catalog; they do not change dispatch identity.
  const { probe: _probe, healthMonitor: _health, icon: _icon, modelContextWindows: _windows, keys, ...config } = provider;
  // sourceProtocols uses this exact legacy Chat result; observation timestamps/latency/detail do not affect routing.
  const routingChatProbeStatus = provider.probe?.checks.find(check => check.id === "chat" && check.status !== "skip")?.status;
  return canonical({ ...config, routingChatProbeStatus, ...(keys !== undefined ? { keys: Array.isArray(keys) ? keys.map(({ lastUsedAt: _used, restUntil: _rest, lastError: _error, ...key }) => key) : keys } : {}) });
}

/** All set/delete paths must use this wrapper. Even a failed write invalidates a previous grant. */
export function revisionedSecrets(store: Store, secrets: SecretStore): SecretStore {
  return {
    get: account => secrets.get(account),
    set: async (account, value) => { store.touchCredentialRevision(account); await secrets.set(account, value); },
    delete: async account => { store.touchCredentialRevision(account); await secrets.delete(account); },
    ...(secrets.health ? { health: options => secrets.health!(options) } : {}),
  };
}

export function publicAutomaticApproval(approval: AutomaticApproval): PublicAutomaticApproval {
  return { version: 1, members: approval.members.map(({ member, keyId, credentialLabel }) => ({ member, ...(keyId !== undefined ? { keyId } : {}), credentialLabel })) };
}

/** Non-secret consent revision, not an identity claim or bearer capability. */
export function automaticToolApprovalId(pool: Pool): string {
  if (!pool.automaticApproval) throw new AutomaticApprovalError();
  return createHash("sha256").update(JSON.stringify(pool.automaticApproval)).digest("hex");
}

function active(signal?: AbortSignal): void { if (signal?.aborted) throw new AutomaticApprovalError(true); }
function fail(): never { throw new AutomaticApprovalError(); }

interface CapturedMember {
  member: string;
  keyId?: string;
  credentialLabel: string;
  account: string;
  configuration: string;
  configurationRevision: string;
  credentialRevision: string;
}

/** Reject special identities even when their malformed configuration happens to be falsy. */
function ordinary(provider: Provider): void {
  if (["plan", "antigravity", "kimi", "cursor", "kiro", "vertex", "mimoFree", "cliTextBridge"].some(key => (provider as unknown as Record<string, unknown>)[key] !== undefined)) fail();
  if (provider.off || !Array.isArray(provider.models) || typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) fail();
  for (const value of [provider.baseUrl, provider.anthropicBaseUrl].filter(v => v !== undefined)) {
    try { const url = new URL(value!); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) fail(); } catch { fail(); }
  }
}

function capture(store: Store, members: readonly string[]): CapturedMember[] {
  if (!Array.isArray(members) || members.length < 2 || members.length > MAX_MEMBERS || new Set(members).size !== members.length) fail();
  const providers = new Set<string>(); let common: string | undefined;
  return members.map(member => {
    if (typeof member !== "string" || member.length > 512) fail();
    const slash = member.indexOf("/"); const providerId = member.slice(0, slash), model = member.slice(slash + 1);
    if (slash <= 0 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(providerId) || providerId === "pool" || providers.has(providerId)) fail();
    providers.add(providerId);
    const normalized = normalizePoolModel(model);
    if (!normalized || (common !== undefined && normalized !== common)) fail(); common = normalized;
    const provider = store.provider(providerId); if (!provider) fail(); ordinary(provider);
    if (!(provider.models.length ? provider.models : provider.defaultModel ? [provider.defaultModel] : []).includes(model)) fail();
    let keyId: string | undefined; let credentialLabel = "原有单一 API Key";
    if (provider.keys !== undefined) {
      if (!Array.isArray(provider.keys) || provider.keys.some(k => !k || typeof k.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(k.id) || typeof k.label !== "string" || typeof k.enabled !== "boolean") || new Set(provider.keys.map(k => k.id)).size !== provider.keys.length) fail();
      const key = provider.keys.find(k => k.enabled); if (!key) fail();
      keyId = key.id; credentialLabel = key.label;
    }
    const account = keyId === undefined ? provider.id : `${provider.id}#${keyId}`;
    return { member, ...(keyId !== undefined ? { keyId } : {}), credentialLabel, account, configuration: automaticProviderConfiguration(provider), configurationRevision: store.providerConfigurationRevision(provider.id), credentialRevision: store.credentialRevision(account) };
  });
}

function sameCaptured(store: Store, members: readonly string[], baseline: readonly CapturedMember[]): void {
  if (canonical(capture(store, members)) !== canonical(baseline)) fail();
}

function seal(salt: string, captured: CapturedMember, secret: string): string {
  // Credential material is the HMAC key, never serialized. The salted MAC cannot authenticate upstream.
  return createHmac("sha256", secret).update("easyswitch-automatic-approval-v1\0").update(salt).update("\0").update(canonical(captured)).digest("hex");
}

function configurationSeal(salt: string, captured: CapturedMember): string {
  return createHash("sha256").update("easyswitch-automatic-configuration-v1\0").update(salt).update("\0").update(canonical(captured)).digest("hex");
}

function observedReplacement(store: Store, captured: CapturedMember): never {
  store.invalidateCredentialRevision(captured.account);
  fail();
}

function validShape(members: readonly string[], approval: AutomaticApproval): void {
  if (!approval || approval.version !== 1 || typeof approval.salt !== "string" || !/^[a-f0-9]{64}$/.test(approval.salt) || !Array.isArray(approval.members)
    || approval.members.length !== members.length || approval.members.some((entry, i) => !entry || entry.member !== members[i] || typeof entry.credentialLabel !== "string" || typeof entry.seal !== "string" || !/^[a-f0-9]{64}$/.test(entry.seal)
      || typeof entry.configurationSeal !== "string" || !/^[a-f0-9]{64}$/.test(entry.configurationSeal))) fail();
}

async function readSecret(secrets: SecretStore, account: string, signal?: AbortSignal, afterRead?: () => void, onMissing?: () => never): Promise<string> {
  active(signal); let secret: string | undefined;
  try { secret = await secrets.get(account); } catch { active(signal); fail(); }
  active(signal); afterRead?.();
  if (typeof secret !== "string" || !secret.trim()) { onMissing?.(); fail(); } return secret;
}

/** Read-only mint for a bounded preview. The server owns confirmation and atomic installation. */
export async function mintAutomaticApproval(store: Store, secrets: SecretStore, members: readonly string[], signal?: AbortSignal): Promise<AutomaticApproval> {
  try {
    active(signal); const ordered = [...members]; const baseline = capture(store, ordered); const salt = randomBytes(32).toString("hex");
    const approval: AutomaticApproval = { version: 1, salt, members: [] };
    for (const captured of baseline) {
      const secret = await readSecret(secrets, captured.account, signal); sameCaptured(store, ordered, baseline);
      approval.members.push({ member: captured.member, ...(captured.keyId !== undefined ? { keyId: captured.keyId } : {}), credentialLabel: captured.credentialLabel, configurationSeal: configurationSeal(salt, captured), seal: seal(salt, captured, secret) });
    }
    active(signal); sameCaptured(store, ordered, baseline); return approval;
  } catch (error) { throw error instanceof AutomaticApprovalError ? error : new AutomaticApprovalError(); }
}

/** Validate complete configuration before/after every await, not only the selected member. */
async function checkSnapshot(store: Store, secrets: SecretStore, members: readonly string[], approval: AutomaticApproval, signal?: AbortSignal, checkPool?: () => void): Promise<CapturedMember[]> {
  active(signal); validShape(members, approval); checkPool?.();
  const approvalBefore = canonical(approval), baseline = capture(store, members);
  // Establish that the entire configuration still matches before diagnosing any credential contents.
  // A combined credential HMAC alone cannot distinguish stale configuration from an external secret replacement.
  for (let i = 0; i < baseline.length; i += 1) {
    const captured = baseline[i]!, approved = approval.members[i]!;
    if (approved.keyId !== captured.keyId || approved.credentialLabel !== captured.credentialLabel || configurationSeal(approval.salt, captured) !== approved.configurationSeal) fail();
  }
  for (let i = 0; i < baseline.length; i += 1) {
    const captured = baseline[i]!, approved = approval.members[i]!;
    const afterRead = () => { sameCaptured(store, members, baseline); checkPool?.(); if (canonical(approval) !== approvalBefore) fail(); };
    const secret = await readSecret(secrets, captured.account, signal, afterRead, () => observedReplacement(store, captured));
    if (!timingSafeEqual(Buffer.from(approved.seal, "hex"), Buffer.from(seal(approval.salt, captured, secret), "hex"))) observedReplacement(store, captured);
  }
  active(signal); sameCaptured(store, members, baseline); checkPool?.(); return baseline;
}

export async function validateAutomaticSnapshot(store: Store, secrets: SecretStore, members: readonly string[], approval: AutomaticApproval, signal?: AbortSignal): Promise<AutomaticApprovalValidation> {
  try { await checkSnapshot(store, secrets, members, approval, signal); return { ok: true }; }
  catch { return { ok: false, reason: signal?.aborted ? ABORTED : INVALID }; }
}

function installedCheck(store: Store, pool: Pool): () => void {
  const expected = canonical(pool);
  return () => {
    if (pool.strategy !== "automatic" || !pool.automaticApproval || canonical(pool) !== expected || canonical(store.pool(pool.id)) !== expected) fail();
  };
}

export async function validateApproval(store: Store, secrets: SecretStore, pool: Pool, signal?: AbortSignal): Promise<AutomaticApprovalValidation> {
  try { await checkSnapshot(store, secrets, pool.members, pool.automaticApproval!, signal, installedCheck(store, pool)); return { ok: true }; }
  catch { return { ok: false, reason: signal?.aborted ? ABORTED : INVALID }; }
}

/** The only automatic-mode credential read used for dispatch: whole-grant validation, then pinned read. */
export async function readApprovedKey(store: Store, secrets: SecretStore, pool: Pool, memberId: string, signal?: AbortSignal): Promise<{ apiKey: string; keyId?: string }> {
  try {
    const checkPool = installedCheck(store, pool); checkPool();
    const baseline = await checkSnapshot(store, secrets, pool.members, pool.automaticApproval!, signal, checkPool);
    const index = baseline.findIndex(m => m.member === memberId); if (index < 0) fail();
    const captured = baseline[index]!, approved = pool.automaticApproval!.members[index]!;
    const apiKey = await readSecret(secrets, captured.account, signal, () => { sameCaptured(store, pool.members, baseline); checkPool(); }, () => observedReplacement(store, captured));
    if (!timingSafeEqual(Buffer.from(approved.seal, "hex"), Buffer.from(seal(pool.automaticApproval!.salt, captured, apiKey), "hex"))) observedReplacement(store, captured);
    return { apiKey, ...(captured.keyId !== undefined ? { keyId: captured.keyId } : {}) };
  } catch (error) { throw error instanceof AutomaticApprovalError ? error : new AutomaticApprovalError(); }
}
