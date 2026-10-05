import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { accountCommandLine, clearResting, createAccount, markResting, pickAccount } from "../src/accounts.ts";
import { findCodex } from "../src/launch.ts";
import { Store } from "../src/store.ts";

const run = promisify(execFile);

function newStore(): Store {
  return new Store(mkdtempSync(join(tmpdir(), "es-accounts-")));
}

test("an account gets its own home; Codex accounts link shared config but never auth", () => {
  const globalHome = mkdtempSync(join(tmpdir(), "es-global-codex-"));
  writeFileSync(join(globalHome, "config.toml"), "model = \"x\"\n");
  writeFileSync(join(globalHome, "auth.json"), "{}");
  process.env.CODEX_HOME = globalHome;
  try {
    const store = newStore();
    const a = createAccount(store, "codex", "主号");
    assert.equal(a.label, "主号");
    assert.ok(existsSync(join(a.home, "config.toml")) && lstatSync(join(a.home, "config.toml")).isSymbolicLink());
    assert.equal(existsSync(join(a.home, "auth.json")), false, "the login is never copied or linked");
    const b = createAccount(store, "codex", "");
    assert.notEqual(a.home, b.home);
    assert.equal(b.label, "Codex 2");
  } finally {
    delete process.env.CODEX_HOME;
  }
});

test("auto pick is off until the user turns it on, then it prefers the longest-unused ready account", () => {
  const store = newStore();
  const a = createAccount(store, "claude", "A");
  const b = createAccount(store, "claude", "B");
  assert.equal(pickAccount(store, "claude").ok, false, "off by default");
  store.setAccountSettings({ autoPick: true });

  const first = pickAccount(store, "claude");
  assert.ok(first.ok && first.account.id === a.id, "never-used accounts come first, in order");
  a.lastUsedAt = new Date().toISOString();
  store.upsertAccount(a);
  const second = pickAccount(store, "claude");
  assert.ok(second.ok && second.account.id === b.id);

  markResting(store, b.id);
  const third = pickAccount(store, "claude");
  assert.ok(third.ok && third.account.id === a.id, "a resting account is skipped");

  markResting(store, a.id);
  const all = pickAccount(store, "claude");
  assert.ok(all.ok && all.note, "everything rests: still serves one, with a note");

  clearResting(store, a.id);
  assert.equal(store.account(a.id)!.restUntil, undefined);
});

test("a rest mark ends by itself", () => {
  const store = newStore();
  const a = createAccount(store, "codex", "A");
  store.setAccountSettings({ autoPick: true });
  markResting(store, a.id, new Date(Date.now() - 1000));
  const picked = pickAccount(store, "codex");
  assert.ok(picked.ok && !picked.note, "an expired rest is just a ready account");
});

test("the command line sets the home and clears variables that would override the login", () => {
  const store = newStore();
  const claude = createAccount(store, "claude", "A");
  const line = accountCommandLine("/x/claude", claude);
  assert.match(line, /-u 'ANTHROPIC_API_KEY'|-u ANTHROPIC_API_KEY/);
  assert.ok(line.includes(`CLAUDE_CONFIG_DIR='${claude.home}'`));
  assert.ok(line.endsWith("'/x/claude'"));
  const codex = createAccount(store, "codex", "B");
  assert.ok(accountCommandLine("/x/codex", codex).includes(`CODEX_HOME='${codex.home}'`));
});

test("a real Codex started on an account home reads that home and leaves the real ~/.codex alone", async t => {
  const codex = await findCodex();
  if (!codex) { t.skip("codex not installed"); return; }
  const realConfig = join(homedir(), ".codex", "config.toml");
  const before = existsSync(realConfig) ? createHash("sha256").update(readFileSync(realConfig)).digest("hex") : "absent";
  const store = newStore();
  const account = createAccount(store, "codex", "isolated");
  // `codex login status` reads the credentials of the home it is given; a fresh home has none.
  const result = await run(codex, ["login", "status"], { env: { ...process.env, CODEX_HOME: account.home, HOME: mkdtempSync(join(tmpdir(), "es-home-")), OPENAI_API_KEY: "" } })
    .catch((error: { stdout?: string; stderr?: string }) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "" }));
  assert.match(`${result.stdout}${result.stderr}`, /not logged in|no credentials|Not logged in/i);
  const after = existsSync(realConfig) ? createHash("sha256").update(readFileSync(realConfig)).digest("hex") : "absent";
  assert.equal(after, before, "the real Codex config was not touched");
});
