import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.ts";
import type { SiwcAccount, SiwcStorage } from "./siwc.ts";
import { catalogModels, type CatalogModel } from "./catalog.ts";
import { poolContext, providerContext } from "./model-context.ts";
import type { Profile } from "./types.ts";
import type { Account, AccountSettings, DisplaySettings, HarnessBinding, Pool, Provider, Settings } from "./types.ts";
import { buildProfilePreview, profileBindings, ProfilePreviewError } from "./profile-preview.ts";
import { automaticProviderConfiguration } from "./automatic-approval.ts";

interface StateFile {
  version: 1;
  providers: Provider[];
  bindings: HarnessBinding[];
  /** Per-harness write generations prevent a newer selection from reviving an older confirmation. */
  bindingRevisions?: Record<string, string>;
  /** Applying a profile replaces all bindings, including the choice to leave a harness unbound. */
  bindingProfileRevision?: string;
  accounts?: Account[];
  accountSettings?: AccountSettings;
  display?: DisplaySettings;
  settings?: Settings;
  /** Signed-in ChatGPT plan accounts (tokens are in the Keychain, never here). */
  siwc?: SiwcAccount[];
  siwcHostId?: string;
  pools?: Pool[];
  /** Opaque mutation generations, never credential contents or reversible credential fingerprints. */
  credentialRevisions?: Record<string, string>;
  /** Configuration changes cannot restore a previously granted identity by changing values back. */
  providerConfigurationRevisions?: Record<string, string>;
  /** Hashes of normalized model names the user explicitly declined for pool suggestions. */
  poolSuggestionDismissals?: string[];
  profiles?: Profile[];
  /** Legacy dispatch records are retained unchanged, never executed or migrated. */
  rules?: unknown[];
  /** Per agent, apart from its main model: thinking level and the other models it runs (sub-agent, small tasks). */
  prefs?: Record<string, AgentPrefs>;
}

export interface AgentPrefs {
  fallbackModel?: string;
  effort?: string;
  /** Tier id → `<provider>/<model>`. */
  tiers?: Record<string, string>;
}

const EMPTY: StateFile = { version: 1, providers: [], bindings: [] };
const DEFAULT_ACCOUNT_SETTINGS: AccountSettings = { autoPick: false, defaultRestHours: 5 };

/** Providers and bindings, without secrets, in one atomically replaced JSON file. */
export class Store {
  private budgetChecker?: (provider: Provider) => boolean;
  /** The owning server supplies its durable per-source accounting policy. */
  setProviderBudgetChecker(checker: (provider: Provider) => boolean): void { this.budgetChecker = checker; }
  providerBudgetStopped(provider: Provider): boolean { return this.budgetChecker?.(provider) ?? false; }

  private state: StateFile;
  private readonly file: string;
  /** Where this store lives; files EasySwitch generates (the Codex catalog) go next to it. */
  readonly dir: string;

  constructor(dir: string = dataDir()) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "state.json");
    this.state = this.load();
  }

  private load(): StateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
      if (parsed.version === 1 && Array.isArray(parsed.providers) && Array.isArray(parsed.bindings)) {
        // Earlier versions kept these on the main-model binding; they belong to the agent, not to its main model.
        for (const b of parsed.bindings as Array<HarnessBinding & { effort?: string; tiers?: Record<string, string> }>) {
          if (!b.effort && !b.tiers) continue;
          parsed.prefs ??= {};
          parsed.prefs[b.harness] = { ...(b.effort ? { effort: b.effort } : {}), ...(b.tiers ? { tiers: b.tiers } : {}), ...(parsed.prefs[b.harness] ?? {}) };
          delete b.effort;
          delete b.tiers;
        }
        return parsed;
      }
    } catch {
      // Missing or unreadable: start empty rather than guess.
    }
    return structuredClone(EMPTY);
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  providers(): Provider[] {
    return structuredClone(this.state.providers);
  }

  provider(id: string): Provider | undefined {
    const found = this.state.providers.find(p => p.id === id);
    return found ? structuredClone(found) : undefined;
  }

  upsertProvider(provider: Provider): void {
    const before = this.state.providers;
    const revisions = this.state.providerConfigurationRevisions;
    const current = before.find(p => p.id === provider.id);
    if (!current || automaticProviderConfiguration(current) !== automaticProviderConfiguration(provider)) {
      this.state.providerConfigurationRevisions = { ...(revisions ?? {}), [provider.id]: randomUUID() };
    }
    this.state.providers = before.some(p=>p.id===provider.id) ? before.map(p=>p.id===provider.id?structuredClone(provider):p) : [...before,structuredClone(provider)];
    try { this.save(); } catch(error) { this.state.providers=before; this.state.providerConfigurationRevisions=revisions; throw error; }
  }

  removeProvider(id: string): void {
    const before = this.state.providers, bindings = this.state.bindings, revisions = this.state.providerConfigurationRevisions, bindingRevisions = this.state.bindingRevisions;
    this.state.providers = this.state.providers.filter(p => p.id !== id);
    this.state.bindings = this.state.bindings.filter(b => b.providerId !== id);
    this.advanceBindingRevisions(bindings.filter(b => b.providerId === id).map(b => b.harness));
    this.state.providerConfigurationRevisions = { ...(revisions ?? {}), [id]: randomUUID() };
    try { this.save(); } catch(error) { this.state.providers=before; this.state.bindings=bindings; this.state.providerConfigurationRevisions=revisions; this.state.bindingRevisions=bindingRevisions; throw error; }
  }

  private revision(map: Record<string, string> | undefined, id: string): string {
    if (!map || !Object.hasOwn(map, id)) return "";
    const value = map[id];
    if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new Error("来源授权记录无法安全读取，请重新确认自动选择");
    return value;
  }

  credentialRevision(account: string): string { return this.revision(this.state.credentialRevisions, account); }
  providerConfigurationRevision(providerId: string): string { return this.revision(this.state.providerConfigurationRevisions, providerId); }

  /** Read-only opaque generation for a harness, also changed by an all-bindings profile replacement. */
  bindingRevision(harness: string): string {
    const local = this.revision(this.state.bindingRevisions, harness);
    const profile = this.state.bindingProfileRevision === undefined ? "" : this.revision({ profile: this.state.bindingProfileRevision }, "profile");
    return local || profile ? createHash("sha256").update(JSON.stringify([local, profile])).digest("hex") : "";
  }

  /** The caller saves this together with its binding changes and rolls the old map back on failure. */
  private advanceBindingRevisions(harnesses: readonly string[]): void {
    if (!harnesses.length) return;
    const next = { ...(this.state.bindingRevisions ?? {}) };
    for (const harness of new Set(harnesses)) Object.defineProperty(next, harness, { value: randomUUID(), enumerable: true, writable: true, configurable: true });
    this.state.bindingRevisions = next;
  }

  /** Persist before any backend mutation, including same-value set and failed mutation attempts. */
  touchCredentialRevision(account: string): void {
    const before = this.state.credentialRevisions;
    this.state.credentialRevisions = { ...(before ?? {}), [account]: randomUUID() };
    try { this.save(); } catch(error) { this.state.credentialRevisions=before; throw error; }
  }

  /** A replacement was already observed outside our writes. A failed save must not revive that grant in memory. */
  invalidateCredentialRevision(account: string): void {
    this.state.credentialRevisions = { ...(this.state.credentialRevisions ?? {}), [account]: randomUUID() };
    // Intentionally no rollback: the external mutation happened before this save, unlike touch-before-write.
    // A newly reviewed grant can only be installed through a successful save that persists this generation too.
    this.save();
  }

  allBindings(): HarnessBinding[] {
    return structuredClone(this.state.bindings);
  }

  binding(harness: HarnessBinding["harness"]): HarnessBinding | undefined {
    const found = this.state.bindings.find(b => b.harness === harness);
    return found ? structuredClone(found) : undefined;
  }

  clearBinding(harness: HarnessBinding["harness"]): void {
    const bindings = this.state.bindings, revisions = this.state.bindingRevisions;
    this.state.bindings = bindings.filter(b => b.harness !== harness);
    this.advanceBindingRevisions([harness]);
    try { this.save(); } catch(error) { this.state.bindings=bindings; this.state.bindingRevisions=revisions; throw error; }
  }

  setBinding(binding: HarnessBinding): void {
    const bindings = this.state.bindings, revisions = this.state.bindingRevisions;
    this.state.bindings = [...bindings.filter(b => b.harness !== binding.harness), structuredClone(binding)];
    this.advanceBindingRevisions([binding.harness]);
    try { this.save(); } catch(error) { this.state.bindings=bindings; this.state.bindingRevisions=revisions; throw error; }
  }

  accounts(harness?: Account["harness"]): Account[] {
    const all = structuredClone(this.state.accounts ?? []);
    return harness ? all.filter(a => a.harness === harness) : all;
  }

  account(id: string): Account | undefined {
    const found = (this.state.accounts ?? []).find(a => a.id === id);
    return found ? structuredClone(found) : undefined;
  }

  upsertAccount(account: Account): void {
    const list = this.state.accounts ?? (this.state.accounts = []);
    const index = list.findIndex(a => a.id === account.id);
    if (index >= 0) list[index] = account;
    else list.push(account);
    this.save();
  }

  removeAccount(id: string): void {
    this.state.accounts = (this.state.accounts ?? []).filter(a => a.id !== id);
    this.save();
  }

  profiles(): Profile[] {
    return structuredClone(this.state.profiles ?? []);
  }

  /** Saves what every agent is set to now under a name (a name already used is replaced). */
  saveProfile(name: string): Profile {
    const list = this.state.profiles ?? [];
    const existing = list.find(p => p.name === name);
    const profile: Profile = {
      id: existing?.id ?? `f-${createHash("sha256").update(`${name}${Date.now()}`).digest("hex").slice(0, 6)}`,
      name, bindings: structuredClone(this.state.bindings), prefs: structuredClone(this.state.prefs ?? {}),
      createdAt: new Date().toISOString(),
    };
    this.state.profiles = existing ? list.map(p => (p.id === existing.id ? profile : p)) : [...list, profile];
    this.save();
    return structuredClone(profile);
  }

  previewProfile(id: string) {
    const profile = (this.state.profiles ?? []).find(p => p.id === id);
    if (!profile) return undefined;
    return buildProfilePreview(profile, { bindings: this.state.bindings, prefs: this.state.prefs ?? {}, revision: this.state.bindingProfileRevision, budgetBlocked: this.state.providers.filter(p => this.providerBudgetStopped(p)).map(p => p.id), bindingRevisions: this.state.bindingRevisions, providerRevisions: this.state.providerConfigurationRevisions }, this.state.providers, this.state.pools ?? []);
  }

  /** Puts every agent's settings back as they were when the profile was saved. Providers and pools are not touched. */
  applyProfile(id: string, expectedPreview?: string): Profile | undefined {
    const profile = (this.state.profiles ?? []).find(p => p.id === id);
    if (!profile) return undefined;
    if (expectedPreview !== undefined && this.previewProfile(id)?.fingerprint !== expectedPreview) {
      throw new ProfilePreviewError("设置已变化，请重新预览后确认", 409, "PROFILE_PREVIEW_CONFLICT");
    }
    const bindings = this.state.bindings, prefs = this.state.prefs, revision = this.state.bindingProfileRevision;
    this.state.bindings = profileBindings(profile, this.state.providers, this.state.pools ?? []);
    this.state.prefs = structuredClone(profile.prefs);
    this.state.bindingProfileRevision = randomUUID();
    try { this.save(); } catch(error) { this.state.bindings=bindings; this.state.prefs=prefs; this.state.bindingProfileRevision=revision; throw error; }
    return structuredClone(profile);
  }

  removeProfile(id: string): void {
    this.state.profiles = (this.state.profiles ?? []).filter(p => p.id !== id);
    this.save();
  }

  pools(): Pool[] {
    return structuredClone(this.state.pools ?? []);
  }

  pool(id: string): Pool | undefined {
    const found = (this.state.pools ?? []).find(p => p.id === id);
    return found ? structuredClone(found) : undefined;
  }

  upsertPool(pool: Pool): void {
    const old = this.state.pools;
    const list = [...(old ?? [])];
    const at = list.findIndex(p => p.id === pool.id);
    if (at >= 0) list[at] = structuredClone(pool); else list.push(structuredClone(pool));
    this.state.pools = list;
    try { this.save(); } catch (error) { this.state.pools = old; throw error; }
  }

  /** Creates a new confirmed pool and its binding in one replacement. Never modifies an old pool. */
  installAutomaticPoolAndBind(pool: Pool, harness: string): void {
    if (pool.strategy !== "automatic" || !pool.id || !harness || pool.automaticApproval?.version !== 1
      || pool.members.length < 2 || pool.members.length > 32
      || JSON.stringify(pool.members) !== JSON.stringify(pool.automaticApproval.members.map(m => m.member))
      || (this.state.pools ?? []).some(p => p.id === pool.id)) throw new Error("自动选择确认无效，请重新检查来源名单");
    const pools = this.state.pools, bindings = this.state.bindings, revisions = this.state.bindingRevisions;
    this.state.pools = [...(pools ?? []), structuredClone(pool)];
    this.state.bindings = [...bindings.filter(b => b.harness !== harness), { harness, providerId: "pool", model: pool.id }];
    this.advanceBindingRevisions([harness]);
    try { this.save(); } catch(error) { this.state.pools=pools; this.state.bindings=bindings; this.state.bindingRevisions=revisions; throw error; }
  }

  dismissedPoolSuggestions(): string[] {
    const list = this.state.poolSuggestionDismissals ?? [];
    if (!Array.isArray(list) || list.length > 4096 || list.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new Error("模型池建议记录无法安全读取，请检查本机存储");
    return [...new Set(list)];
  }

  dismissPoolSuggestion(key: string): void {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("模型池建议标识无效");
    const list = this.dismissedPoolSuggestions();
    if (list.includes(key)) return;
    if (list.length >= 4096) throw new Error("模型池建议记录已达到上限，请检查本机存储");
    const old = this.state.poolSuggestionDismissals;
    this.state.poolSuggestionDismissals = [...list, key];
    try { this.save(); } catch (error) { this.state.poolSuggestionDismissals = old; throw error; }
  }

  removePool(id: string): void {
    const pools = this.state.pools, bindings = this.state.bindings, revisions = this.state.bindingRevisions;
    this.state.pools = (this.state.pools ?? []).filter(p => p.id !== id);
    this.state.bindings = this.state.bindings.filter(b => !(b.providerId === "pool" && b.model === id));
    this.advanceBindingRevisions(bindings.filter(b => b.providerId === "pool" && b.model === id).map(b => b.harness));
    try { this.save(); } catch(error) { this.state.pools=pools; this.state.bindings=bindings; this.state.bindingRevisions=revisions; throw error; }
  }

  /** Every model an agent can be given: each provider's, then the pools. */
  catalog(): CatalogModel[] {
    const own = catalogModels(this.state.providers.filter(p => !this.providerBudgetStopped(p)));
    const have = new Set(own.map(m => `${m.providerId}/${m.model}`));
    const pools: CatalogModel[] = (this.state.pools ?? []).map(pool => {
      const lists = pool.members.filter(m => have.has(m)).map(member => own.find(m => `${m.providerId}/${m.model}` === member)!.efforts);
      const context = poolContext(pool.members.map(member => {
        const slash = member.indexOf("/");
        return providerContext(this.provider(member.slice(0, slash)), member.slice(slash + 1));
      }));
      return {
        providerId: "pool", providerName: "模型池", model: pool.id,
        efforts: lists.length ? lists[0]!.filter(l => lists.every(x => x.includes(l))) : [],
        ...(context ? { context } : {}),
      };
    }).filter(p => this.state.pools!.find(x => x.id === p.model)!.members.some(m => have.has(m)));
    return [...own, ...pools];
  }

  prefs(agent: string): AgentPrefs {
    return structuredClone(this.state.prefs?.[agent] ?? {});
  }

  allPrefs(): Record<string, AgentPrefs> {
    return structuredClone(this.state.prefs ?? {});
  }

  /** Changes one agent's preferences. `effort: ""` clears the level; a tier set to `""` clears that tier. */
  setPrefs(agent: string, patch: { effort?: string; tiers?: Record<string, string>; fallbackModel?: string }): AgentPrefs {
    const cur = this.prefs(agent);
    const next: AgentPrefs = { ...cur };
    if (patch.fallbackModel !== undefined) { if (patch.fallbackModel) next.fallbackModel = patch.fallbackModel; else delete next.fallbackModel; }
    if (patch.effort !== undefined) { if (patch.effort) next.effort = patch.effort; else delete next.effort; }
    if (patch.tiers) {
      const tiers = { ...(cur.tiers ?? {}) };
      for (const [k, v] of Object.entries(patch.tiers)) { if (v) tiers[k] = v; else delete tiers[k]; }
      if (Object.keys(tiers).length) next.tiers = tiers; else delete next.tiers;
    }
    const before = this.state.prefs;
    this.state.prefs = { ...(this.state.prefs ?? {}) };
    if (Object.keys(next).length) this.state.prefs[agent] = next; else delete this.state.prefs[agent];
    try { this.save(); } catch(error) { this.state.prefs=before; throw error; }
    return structuredClone(next);
  }

  /** Where "Sign in with ChatGPT" keeps its account records. */
  siwcStorage(): SiwcStorage {
    return {
      hostId: () => {
        if (!this.state.siwcHostId) {
          this.state.siwcHostId = `urn:uuid:${crypto.randomUUID()}`;
          this.save();
        }
        return this.state.siwcHostId;
      },
      accounts: () => structuredClone(this.state.siwc ?? []),
      save: account => {
        const list = this.state.siwc ?? [];
        const at = list.findIndex(a => a.id === account.id);
        if (at >= 0) list[at] = structuredClone(account); else list.push(structuredClone(account));
        this.state.siwc = list;
        this.save();
      },
      remove: id => {
        this.state.siwc = (this.state.siwc ?? []).filter(a => a.id !== id);
        this.save();
      },
    };
  }

  settings(): Settings {
    const { agentCalls: _retired, ...settings } = (this.state.settings ?? {}) as Partial<Settings> & { agentCalls?: unknown };
    return { claudeNative: true, ...settings };
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.state.settings = { ...this.state.settings, ...this.settings(), ...patch };
    this.save();
    return this.settings();
  }

  display(): DisplaySettings {
    return { currency: "CNY", usdToCny: 7.2, ...(this.state.display ?? {}) };
  }

  setDisplay(patch: Partial<DisplaySettings>): DisplaySettings {
    this.state.display = { ...this.display(), ...patch };
    this.save();
    return this.display();
  }

  accountSettings(): AccountSettings {
    return { ...DEFAULT_ACCOUNT_SETTINGS, ...(this.state.accountSettings ?? {}) };
  }

  setAccountSettings(settings: Partial<AccountSettings>): AccountSettings {
    this.state.accountSettings = { ...this.accountSettings(), ...settings };
    this.save();
    return this.accountSettings();
  }
}

/**
 * A slug from a display name: lowercase ascii, digits and dashes. A name with
 * no ascii letters at all (a Chinese name, say) gets a short stable hash
 * instead of a meaningless "provider".
 */
export function slugify(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    || `p-${createHash("sha256").update(name).digest("hex").slice(0, 6)}`;
  let slug = base;
  for (let n = 2; taken.includes(slug); n += 1) slug = `${base}-${n}`;
  return slug;
}
