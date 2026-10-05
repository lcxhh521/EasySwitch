import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./paths.ts";
import type { HarnessBinding, Provider } from "./types.ts";

interface StateFile {
  version: 1;
  providers: Provider[];
  bindings: HarnessBinding[];
}

const EMPTY: StateFile = { version: 1, providers: [], bindings: [] };

/** Providers and bindings, without secrets, in one atomically replaced JSON file. */
export class Store {
  private state: StateFile;
  private readonly file: string;

  constructor(dir: string = dataDir()) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "state.json");
    this.state = this.load();
  }

  private load(): StateFile {
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as StateFile;
      if (parsed.version === 1 && Array.isArray(parsed.providers) && Array.isArray(parsed.bindings)) return parsed;
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

  binding(harness: HarnessBinding["harness"]): HarnessBinding | undefined {
    const found = this.state.bindings.find(b => b.harness === harness);
    return found ? structuredClone(found) : undefined;
  }

  setBinding(binding: HarnessBinding): void {
    this.state.bindings = this.state.bindings.filter(b => b.harness !== binding.harness);
    this.state.bindings.push(binding);
    this.save();
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
