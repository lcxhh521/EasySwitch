import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.ts";
import type { SiwcAccount, SiwcStorage } from "./siwc.ts";
import { catalogModels, type CatalogModel } from "./catalog.ts";
import type { Profile } from "./types.ts";
import type { DispatchRule } from "./dispatch.ts";
import type { Account, AccountSettings, DisplaySettings, HarnessBinding, Pool, Provider, Settings } from "./types.ts";

interface StateFile {
  version: 1;
  providers: Provider[];
  bindings: HarnessBinding[];
  accounts?: Account[];
  accountSettings?: AccountSettings;
  display?: DisplaySettings;
  settings?: Settings;
  /** Signed-in ChatGPT plan accounts (tokens are in the Keychain, never here). */
  siwc?: SiwcAccount[];
  siwcHostId?: string;
  pools?: Pool[];
  /** Hashes of normalized model names the user explicitly declined for pool suggestions. */
  poolSuggestionDismissals?: string[];
  profiles?: Profile[];
  /** Dispatch rules, in the order they are tried (see dispatch.ts). */
  rules?: DispatchRule[];
  /** Per agent, apart from its main model: thinking level and the other models it runs (sub-agent, small tasks). */
  prefs?: Record<string, AgentPrefs>;
}

export interface AgentPrefs {
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
    const index = this.state.providers.findIndex(p => p.id === provider.id);
    if (index >= 0) this.state.providers[index] = provider;
    else this.state.providers.push(provider);
    this.save();
  }

  removeProvider(id: string): void {
    this.state.providers = this.state.providers.filter(p => p.id !== id);
    this.state.bindings = this.state.bindings.filter(b => b.providerId !== id);
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
    this.state.bindings = this.state.bindings.filter(b => b.harness !== harness);
    this.save();
  }

  setBinding(binding: HarnessBinding): void {
    this.state.bindings = this.state.bindings.filter(b => b.harness !== binding.harness);
    this.state.bindings.push(binding);
    this.save();
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

  rules(): DispatchRule[] {
    return structuredClone(this.state.rules ?? []);
  }

  addRule(rule: Omit<DispatchRule, "id">, beforeId?: string): DispatchRule {
    const added: DispatchRule = { id: `r-${createHash("sha256").update(`${rule.name}${Date.now()}${Math.random()}`).digest("hex").slice(0, 6)}`, ...rule };
    const previous=this.state.rules;const next=[...(previous??[])];
    if(next.some(r=>r.id===added.id))throw new Error("规则记录冲突，请重试，原规则未更改");
    const index=beforeId?next.findIndex(r=>r.id===beforeId):next.length;
    if(index<0)throw new Error("原规则已不存在，请刷新建议");next.splice(index,0,added);this.state.rules=next;
    try{this.save();}catch(error){this.state.rules=previous;throw error;}
    return structuredClone(added);
  }

  updateRule(id: string, rule: Omit<DispatchRule, "id">): DispatchRule | undefined {
    const list = this.state.rules ?? [];
    const at = list.findIndex(r => r.id === id);
    if (at < 0) return undefined;
    list[at] = { id, ...structuredClone(rule) };
    this.state.rules = list;
    this.save();
    return structuredClone(list[at]);
  }

  removeRule(id: string): boolean {
    const before = (this.state.rules ?? []).length;
    this.state.rules = (this.state.rules ?? []).filter(r => r.id !== id);
    this.save();
    return this.state.rules.length < before;
  }

  /** Moves a rule one place earlier (-1) or later (+1): earlier rules are tried first. */
  moveRule(id: string, direction: -1 | 1): boolean {
    const list = [...(this.state.rules ?? [])];
    const at = list.findIndex(r => r.id === id);
    const to = at + direction;
    if (at < 0 || to < 0 || to >= list.length) return false;
    [list[at], list[to]] = [list[to]!, list[at]!];
    this.state.rules = list;
    this.save();
    return true;
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

  /** Puts every agent's settings back as they were when the profile was saved. Providers and pools are not touched. */
  applyProfile(id: string): Profile | undefined {
    const profile = (this.state.profiles ?? []).find(p => p.id === id);
    if (!profile) return undefined;
    // A binding whose provider or pool has since gone is left out, so applying never points an agent at nothing.
    const exists = (b: HarnessBinding) => b.providerId === "pool" ? (this.state.pools ?? []).some(p => p.id === b.model) : this.state.providers.some(p => p.id === b.providerId);
    this.state.bindings = structuredClone(profile.bindings).filter(exists);
    this.state.prefs = structuredClone(profile.prefs);
    this.save();
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
    this.state.pools = (this.state.pools ?? []).filter(p => p.id !== id);
    this.state.bindings = this.state.bindings.filter(b => !(b.providerId === "pool" && b.model === id));
    this.save();
  }

  /** Every model an agent can be given: each provider's, then the pools. */
  catalog(): CatalogModel[] {
    const own = catalogModels(this.state.providers.filter(p => !this.providerBudgetStopped(p)));
    const have = new Set(own.map(m => `${m.providerId}/${m.model}`));
    const pools: CatalogModel[] = (this.state.pools ?? []).map(pool => {
      const lists = pool.members.filter(m => have.has(m)).map(member => own.find(m => `${m.providerId}/${m.model}` === member)!.efforts);
      return {
        providerId: "pool", providerName: "模型池", model: pool.id,
        efforts: lists.length ? lists[0]!.filter(l => lists.every(x => x.includes(l))) : [],
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
  setPrefs(agent: string, patch: { effort?: string; tiers?: Record<string, string> }): AgentPrefs {
    const cur = this.prefs(agent);
    const next: AgentPrefs = { ...cur };
    if (patch.effort !== undefined) { if (patch.effort) next.effort = patch.effort; else delete next.effort; }
    if (patch.tiers) {
      const tiers = { ...(cur.tiers ?? {}) };
      for (const [k, v] of Object.entries(patch.tiers)) { if (v) tiers[k] = v; else delete tiers[k]; }
      if (Object.keys(tiers).length) next.tiers = tiers; else delete next.tiers;
    }
    this.state.prefs = { ...(this.state.prefs ?? {}) };
    if (Object.keys(next).length) this.state.prefs[agent] = next; else delete this.state.prefs[agent];
    this.save();
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
    return { agentCalls: true, claudeNative: true, ...(this.state.settings ?? {}) };
  }

  setSettings(patch: Partial<Settings>): Settings {
    this.state.settings = { ...this.settings(), ...patch };
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
