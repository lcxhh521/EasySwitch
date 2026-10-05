import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account, AccountSettings } from "./types.ts";
import type { Store } from "./store.ts";

/**
 * Several subscription logins per harness, for one person on one Mac.
 *
 * The mechanism is per-process isolation, nothing more: each account owns a
 * directory, and a session is started with CODEX_HOME / CLAUDE_CONFIG_DIR
 * pointing at it. ~/.codex and ~/.claude are never written, the harness does
 * its own login inside that directory, and no login token ever passes
 * through EasySwitch. Choosing the account is manual or, when the user has
 * switched it on, automatic at session start: the least recently used
 * account that is not marked as out of quota.
 */

const HOME_VAR = { codex: "CODEX_HOME", claude: "CLAUDE_CONFIG_DIR" } as const;

/** Files worth sharing between a user's own Codex homes; auth.json and history are never shared. */
const SHARED_CODEX_FILES = ["config.toml", "AGENTS.md", "skills"];

export function accountsRoot(dataDir: string): string {
  return join(dataDir, "accounts");
}

export function newAccountId(): string {
  return `a-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Creates the account's isolated home. For Codex, the user's config.toml,
 * AGENTS.md and skills are linked in so every account behaves alike; the
 * login (auth.json) and the session history stay separate. A refresh token
 * belongs to exactly one home: it rotates, so copying one auth.json into two
 * homes would sign the other out.
 */
export function createAccount(store: Store, harness: Account["harness"], label: string): Account {
  const id = newAccountId();
  const home = join(accountsRoot(store.dir), harness, id);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  if (harness === "codex") {
    const globalHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    for (const name of SHARED_CODEX_FILES) {
      const source = join(globalHome, name);
      if (existsSync(source)) {
        try {
          symlinkSync(source, join(home, name));
        } catch {
          // A missing link only means this account starts with defaults.
        }
      }
    }
  }
  const account: Account = { id, harness, label: label.trim() || `${harness === "codex" ? "Codex" : "Claude"} ${store.accounts(harness).length + 1}`, home, enabled: true, addedAt: new Date().toISOString() };
  store.upsertAccount(account);
  return account;
}

export function isResting(account: Account, now = Date.now()): boolean {
  return Boolean(account.restUntil) && new Date(account.restUntil!).getTime() > now;
}

/** "Hit the limit" — rests the account until `until`, or for the default number of hours. */
export function markResting(store: Store, id: string, until?: Date): Account | undefined {
  const account = store.account(id);
  if (!account) return undefined;
  const hours = store.accountSettings().defaultRestHours;
  account.restUntil = (until ?? new Date(Date.now() + hours * 3_600_000)).toISOString();
  store.upsertAccount(account);
  return account;
}

export function clearResting(store: Store, id: string): Account | undefined {
  const account = store.account(id);
  if (!account) return undefined;
  delete account.restUntil;
  store.upsertAccount(account);
  return account;
}

export type PickResult =
  | { ok: true; account: Account; note?: string }
  | { ok: false; reason: string };

/**
 * Automatic choice, only when the user turned it on: among enabled accounts,
 * those not resting go first and the one used longest ago wins; when every
 * account rests, the one whose rest ends soonest is offered with a note.
 */
export function pickAccount(store: Store, harness: Account["harness"], settings: AccountSettings = store.accountSettings(), now = Date.now()): PickResult {
  if (!settings.autoPick) return { ok: false, reason: "自动选号没有开启；先在账号页手动选一个，或开启自动选号" };
  const enabled = store.accounts(harness).filter(a => a.enabled);
  if (!enabled.length) return { ok: false, reason: "还没有可用的账号" };
  const ready = enabled.filter(a => !isResting(a, now)).sort((a, b) => (a.lastUsedAt ?? "").localeCompare(b.lastUsedAt ?? ""));
  if (ready[0]) return { ok: true, account: ready[0] };
  const soonest = [...enabled].sort((a, b) => (a.restUntil ?? "").localeCompare(b.restUntil ?? ""))[0]!;
  return { ok: true, account: soonest, note: "所有账号都标了限额，先用最早恢复的这个" };
}

export function touch(store: Store, id: string): void {
  const account = store.account(id);
  if (!account) return;
  account.lastUsedAt = new Date().toISOString();
  store.upsertAccount(account);
}

/** The environment overrides and variables to clear for one session on this account. */
export function accountEnv(account: Account): { set: Record<string, string>; unset: string[] } {
  return account.harness === "codex"
    ? { set: { [HOME_VAR.codex]: account.home }, unset: ["OPENAI_API_KEY", "CODEX_API_KEY"] }
    // Claude Code prefers these over the login in the account's directory.
    : { set: { [HOME_VAR.claude]: account.home }, unset: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"] };
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** `env -u … VAR=… <binary>`: one process on this account, nothing exported. */
export function accountCommandLine(binary: string, account: Account): string {
  const { set, unset } = accountEnv(account);
  return ["env", ...unset.flatMap(v => ["-u", v]), ...Object.entries(set).map(([k, v]) => `${k}=${shellQuote(v)}`), shellQuote(binary)].join(" ");
}
