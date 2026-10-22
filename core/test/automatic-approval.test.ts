import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import type { Pool, Provider } from "../src/types.ts";
import type { SecretStore } from "../src/secrets.ts";
import { AutomaticApprovalError, mintAutomaticApproval, publicAutomaticApproval, readApprovedKey, revisionedSecrets, validateApproval, validateAutomaticSnapshot } from "../src/automatic-approval.ts";

class FakeSecrets implements SecretStore {
  values = new Map<string, string>();
  reads: string[] = [];
  mutateFailure = false;
  hook?: (id: string, value: string | undefined) => Promise<void>;
  async get(id: string) { this.reads.push(id); const value = this.values.get(id); await this.hook?.(id, value); return value; }
  async set(id: string, value: string) { if (this.mutateFailure) throw new Error("fake-auth-must-not-leak"); this.values.set(id, value); }
  async delete(id: string) { if (this.mutateFailure) throw new Error("fake-auth-must-not-leak"); this.values.delete(id); }
  health() { return { backend: "memory" as const, ready: true, status: "ready", keychainChecked: false }; }
}
const provider = (id: string): Provider => ({ id, name: id, baseUrl: `https://${id}.invalid/v1`, models: ["gpt-4.1"], protocols: ["chat"], route: "chat-translate", routePinned: true, streamUsage: false, billing: "usage", createdAt: "2026-10-22T00:00:00Z" });
function setup(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), "es-automatic-approval-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const store = new Store(dir); const raw = new FakeSecrets(); const secrets = revisionedSecrets(store, raw);
  store.upsertProvider(provider("a")); store.upsertProvider(provider("b"));
  raw.values.set("a", "fake-secret-a-automatic"); raw.values.set("b", "fake-secret-b-automatic");
  const members = ["b/gpt-4.1", "a/gpt-4.1"];
  const mint = () => mintAutomaticApproval(store, secrets, members);
  const install = async () => { const pool: Pool = { id: "auto-one", name: "approved", members, strategy: "automatic", createdAt: "2026-10-22T00:00:00Z", automaticApproval: await mint() }; store.installAutomaticPoolAndBind(pool, "codex"); return pool; };
  return { dir, store, raw, secrets, members, mint, install };
}

test("automatic approval preserves a finite ordered list and reads only ordinary existing secrets", async t => {
  const f = setup(t); const approval = await f.mint();
  assert.deepEqual(approval.members.map(m => m.member), f.members);
  assert.deepEqual(f.raw.reads, ["b", "a"]);
  assert.equal(f.store.pools().length, 0);
  assert.equal((await validateAutomaticSnapshot(f.store, f.secrets, f.members, approval)).ok, true);
});

test("configured pools pin exactly the first enabled key even when it is resting", async t => {
  const f = setup(t); const p = f.store.provider("a")!;
  p.keys = [ { id: "disabled", label: "Disabled", enabled: false, addedAt: "now" }, { id: "one", label: "Team API", enabled: true, addedAt: "now", restUntil: "2999-01-01T00:00:00Z" }, { id: "two", label: "Other API", enabled: true, addedAt: "now" } ];
  f.store.upsertProvider(p); f.raw.values.set("a#one", "fake-key-one"); f.raw.values.set("a#two", "fake-key-two");
  const pool = await f.install();
  assert.equal(pool.automaticApproval!.members[1]!.keyId, "one"); assert.equal(pool.automaticApproval!.members[1]!.credentialLabel, "Team API");
  assert.deepEqual(await readApprovedKey(f.store, f.secrets, pool, "a/gpt-4.1"), { apiKey: "fake-key-one", keyId: "one" });
  assert.ok(!f.raw.reads.includes("a") && !f.raw.reads.includes("a#two"));
});

for (const keys of [[], [{ id: "off", label: "Off", enabled: false, addedAt: "now" }], [{ id: "missing", label: "Missing", enabled: true, addedAt: "now" }]]) {
  test(`explicit key pool ${JSON.stringify(keys.map(k => k.id))} never falls back to legacy`, async t => {
    const f = setup(t); f.store.upsertProvider({ ...f.store.provider("a")!, keys });
    await assert.rejects(f.mint(), AutomaticApprovalError); assert.ok(!f.raw.reads.includes("a"));
  });
}

test("missing or blank legacy credentials fail closed without exposing read errors", async t => {
  const f = setup(t);
  for (const value of [undefined, "", "   "]) { value === undefined ? f.raw.values.delete("a") : f.raw.values.set("a", value); await assert.rejects(f.mint(), AutomaticApprovalError); }
  f.raw.hook = async () => { throw new Error("fake-private-token-error"); };
  await assert.rejects(f.mint(), e => e instanceof AutomaticApprovalError && !e.message.includes("fake-private"));
});

for (const field of ["plan", "antigravity", "kimi", "cursor", "kiro", "vertex", "mimoFree", "cliTextBridge"] as const) {
  test(`specialized ${field} identity is rejected before secret reads`, async t => {
    const f = setup(t); const p = { ...f.store.provider("b")!, [field]: field === "mimoFree" ? true : {} } as Provider;
    f.store.upsertProvider(p); await assert.rejects(f.mint(), AutomaticApprovalError); assert.deepEqual(f.raw.reads, []);
  });
}

test("invalid, mismatched, duplicate, disabled or absent members fail closed", async t => {
  const f = setup(t);
  for (const members of [[], ["a/gpt-4.1"], ["a/gpt-4.1", "a/gpt-4.1"], ["a/gpt-4.1", "b/gpt-5"], ["pool/a", "b/gpt-4.1"], ["x/gpt-4.1", "b/gpt-4.1"]]) await assert.rejects(mintAutomaticApproval(f.store, f.secrets, members), AutomaticApprovalError);
  f.store.upsertProvider({ ...f.store.provider("b")!, off: true }); await assert.rejects(f.mint(), AutomaticApprovalError);
});

const changes: Array<[string, (p: Provider) => void]> = [
  ["endpoint", p => { p.baseUrl += "/changed"; }], ["secondary endpoint", p => { p.anthropicBaseUrl = "https://else.invalid"; }],
  ["model", p => { p.models = ["gpt-5"]; }], ["protocol", p => { p.protocols = ["responses"]; }], ["model protocol", p => { p.modelProtocols = { "gpt-4.1": ["responses"] }; }],
  ["billing", p => { p.billing = "subscription"; }], ["budget", p => { p.budget = { monthlyUsd: 5, stop: true }; }], ["price", p => { p.prices = { "gpt-4.1": { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }; }],
  ["wire", p => { p.wire = { authHeader: "x-key" }; }], ["enablement", p => { p.off = true; }], ["key identity", p => { p.keys = [{ id: "new", label: "new", enabled: true, addedAt: "now" }]; }],
];
for (const [name, mutate] of changes) test(`${name} change invalidates the entire installed approval`, async t => {
  const f = setup(t); const pool = await f.install(); const p = f.store.provider("a")!; mutate(p); f.store.upsertProvider(p);
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
  await assert.rejects(readApprovedKey(f.store, f.secrets, pool, "b/gpt-4.1"), AutomaticApprovalError);
});

test("external replacement under the same legacy or key ID is detected by secret content", async t => {
  const f = setup(t); const p = f.store.provider("a")!; p.keys = [{ id: "fixed", label: "fixed", enabled: true, addedAt: "now" }]; f.store.upsertProvider(p); f.raw.values.set("a#fixed", "fake-fixed-old");
  const pool = await f.install(); f.raw.values.set("a#fixed", "fake-fixed-new");
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
  f.raw.values.set("a#fixed", "fake-fixed-old"); f.raw.values.set("b", "fake-legacy-new");
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
});

test("same-value credential mutation and replacement-then-restore remain invalid after restart", async t => {
  const f = setup(t); const pool = await f.install(); await f.secrets.set("a", "fake-secret-a-automatic");
  const first = f.store.credentialRevision("a"); assert.ok(first);
  await f.secrets.set("a", "different-fake"); await f.secrets.set("a", "fake-secret-a-automatic"); assert.notEqual(f.store.credentialRevision("a"), first);
  const restarted = new Store(f.dir); assert.equal((await validateApproval(restarted, revisionedSecrets(restarted, f.raw), pool)).ok, false);
});

test("failed secret writes and deletes conservatively invalidate approval before touching backend", async t => {
  const f = setup(t); const pool = await f.install(); f.raw.mutateFailure = true;
  await assert.rejects(f.secrets.set("a", "fake-new")); assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
  const before = f.store.credentialRevision("a"); await assert.rejects(f.secrets.delete("a")); assert.notEqual(f.store.credentialRevision("a"), before);
});

test("failed revision persistence rolls back and does not invoke a secret mutation", async t => {
  const f = setup(t); const pool = await f.install(); const before = f.store.credentialRevision("a"); mkdirSync(join(f.dir, "state.json.tmp"));
  await assert.rejects(f.secrets.set("a", "must-not-write")); assert.equal(f.store.credentialRevision("a"), before); assert.equal(f.raw.values.get("a"), "fake-secret-a-automatic");
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, true);
});

test("approval survives ordinary restart and persists no raw or encoded credential", async t => {
  const f = setup(t); const pool = await f.install(); const state = readFileSync(join(f.dir, "state.json"), "utf8");
  for (const value of f.raw.values.values()) { assert.ok(!state.includes(value)); assert.ok(!state.includes(Buffer.from(value).toString("base64"))); }
  const restarted = new Store(f.dir); assert.equal((await validateApproval(restarted, revisionedSecrets(restarted, f.raw), pool)).ok, true);
  const publicSnapshot = JSON.stringify(publicAutomaticApproval(pool.automaticApproval!));
  for (const member of pool.automaticApproval!.members) assert.ok(!publicSnapshot.includes(member.seal));
  assert.ok(!publicSnapshot.includes('"seal"'));
});

for (const stage of ["mint", "validate", "read"] as const) test(`late secret result cannot survive config change during ${stage}`, async t => {
  const f = setup(t); const pool = stage === "mint" ? undefined : await f.install(); let once = true;
  f.raw.hook = async () => { if (once) { once = false; f.store.upsertProvider({ ...f.store.provider("b")!, baseUrl: "https://changed.invalid" }); } };
  if (stage === "mint") await assert.rejects(f.mint(), AutomaticApprovalError);
  else if (stage === "validate") assert.equal((await validateApproval(f.store, f.secrets, pool!)).ok, false);
  else await assert.rejects(readApprovedKey(f.store, f.secrets, pool!, "a/gpt-4.1"), AutomaticApprovalError);
});

test("credential mutation and restoration during an asynchronous read cannot mint an approval", async t => {
  const f = setup(t); let once = true; f.raw.hook = async id => { if (once) { once = false; const value = f.raw.values.get(id)!; await f.secrets.set(id, "fake-temp"); await f.secrets.set(id, value); } };
  await assert.rejects(f.mint(), AutomaticApprovalError);
});

test("pool replacement/removal, reordered approval, and selected nonmember cannot reuse approval", async t => {
  const f = setup(t); const pool = await f.install();
  await assert.rejects(readApprovedKey(f.store, f.secrets, pool, "a/not-approved"), AutomaticApprovalError);
  const altered = structuredClone(pool); altered.members.reverse(); f.store.upsertPool(altered); assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
  f.store.removePool(pool.id); assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
});

test("cancellation before and during secret reads is fail-closed", async t => {
  const f = setup(t); const pool = await f.install(); const ctrl = new AbortController(); ctrl.abort();
  await assert.rejects(readApprovedKey(f.store, f.secrets, pool, "a/gpt-4.1", ctrl.signal), AutomaticApprovalError);
  const mid = new AbortController(); f.raw.hook = async () => { mid.abort(); }; assert.equal((await validateApproval(f.store, f.secrets, pool, mid.signal)).ok, false);
});

test("passive observations and health reads do not invalidate or mutate credential identity", async t => {
  const f = setup(t); const p = f.store.provider("a")!; p.keys = [{ id: "fixed", label: "fixed", enabled: true, addedAt: "now" }]; f.store.upsertProvider(p); f.raw.values.set("a#fixed", "fake-fixed");
  const pool = await f.install(); const after = f.store.provider("a")!; after.keys![0]!.lastUsedAt = "later"; after.keys![0]!.restUntil = "2999-01-01"; after.keys![0]!.lastError = { at: "later", status: 429, reason: "rate" }; after.healthMonitor = { enabled: true }; f.store.upsertProvider(after);
  const state = readFileSync(join(f.dir, "state.json"), "utf8"); assert.deepEqual(f.secrets.health?.({ passive: true }), f.raw.health());
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, true); assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), state);
});

test("atomic install+bind preserves old order/rotate pools and commits both or neither", async t => {
  const f = setup(t); for (const strategy of ["order", "rotate"] as const) f.store.upsertPool({ id: strategy, name: strategy, strategy, members: ["a/gpt-4.1", "b/gpt-4.1"], createdAt: "old" });
  f.store.setBinding({ harness: "codex", providerId: "a", model: "gpt-4.1" }); const old = f.store.pools(); const binding = f.store.binding("codex"); const approval = await f.mint();
  const pool: Pool = { id: "fresh", name: "fresh", strategy: "automatic", members: f.members, createdAt: "now", automaticApproval: approval };
  const state = readFileSync(join(f.dir, "state.json"), "utf8"); mkdirSync(join(f.dir, "state.json.tmp")); assert.throws(() => f.store.installAutomaticPoolAndBind(pool, "codex"));
  assert.deepEqual(f.store.pools(), old); assert.deepEqual(f.store.binding("codex"), binding); assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), state);
  rmSync(join(f.dir, "state.json.tmp"), { recursive: true }); f.store.installAutomaticPoolAndBind(pool, "codex"); assert.deepEqual(f.store.pools().slice(0, 2), old); assert.deepEqual(f.store.binding("codex"), { harness: "codex", providerId: "pool", model: "fresh" });
  assert.throws(() => f.store.installAutomaticPoolAndBind(pool, "codex"));
});

test("old schema and unrelated legacy records are preserved on revision or automatic writes", async t => {
  const f = setup(t); const file = join(f.dir, "state.json"); const state = JSON.parse(readFileSync(file, "utf8")); state.rules = [{ retired: true }]; state.unknownLegacy = { keep: "yes" }; writeFileSync(file, JSON.stringify(state));
  const store = new Store(f.dir); store.touchCredentialRevision("a"); const after = JSON.parse(readFileSync(file, "utf8")); assert.deepEqual(after.rules, state.rules); assert.deepEqual(after.unknownLegacy, state.unknownLegacy); assert.equal(after.version, 1);
});

test("configuration mutation then restoration cannot resurrect a persisted approval", async t => {
  const f = setup(t); const pool = await f.install(); const original = f.store.provider("a")!;
  f.store.upsertProvider({ ...original, baseUrl: "https://temporary.invalid" }); f.store.upsertProvider(original);
  const restarted = new Store(f.dir); assert.equal((await validateApproval(restarted, revisionedSecrets(restarted, f.raw), pool)).ok, false);
});

test("configuration mutation then restoration across an await cannot mint a stale approval", async t => {
  const f = setup(t); const original = f.store.provider("a")!; let once = true;
  f.raw.hook = async () => { if (once) { once = false; f.store.upsertProvider({ ...original, protocols: ["responses"] }); f.store.upsertProvider(original); } };
  await assert.rejects(f.mint(), AutomaticApprovalError);
});

test("the final pinned read rechecks every member's revision and the installed pool", async t => {
  const f = setup(t); const pool = await f.install(); let reads = 0;
  f.raw.hook = async () => { if (++reads === 3) await f.secrets.set("b", "fake-secret-b-automatic"); };
  await assert.rejects(readApprovedKey(f.store, f.secrets, pool, "a/gpt-4.1"), AutomaticApprovalError);
  assert.equal(reads, 3);
});

test("late selected credential contents are compared again after whole-approval validation", async t => {
  const f = setup(t); const pool = await f.install(); let reads = 0;
  f.raw.hook = async () => { if (++reads === 2) f.raw.values.set("a", "externally-replaced-fake"); };
  await assert.rejects(readApprovedKey(f.store, f.secrets, pool, "a/gpt-4.1"), AutomaticApprovalError);
});

test("fixed key removal, disablement, reorder or relabel invalidates rather than substituting another key", async t => {
  const f = setup(t); const p = f.store.provider("a")!;
  p.keys = [{ id: "first", label: "First", enabled: true, addedAt: "now" }, { id: "second", label: "Second", enabled: true, addedAt: "now" }];
  f.store.upsertProvider(p); f.raw.values.set("a#first", "fake-first"); f.raw.values.set("a#second", "fake-second");
  const pool = await f.install(); const firstSeal = pool.automaticApproval!.members[1]!.seal;
  p.keys.reverse(); f.store.upsertProvider(p);
  const next = await f.mint(); assert.equal(next.members[1]!.keyId, "second"); assert.notEqual(next.members[1]!.seal, firstSeal);
  f.raw.reads = []; await assert.rejects(readApprovedKey(f.store, f.secrets, pool, "a/gpt-4.1"), AutomaticApprovalError); assert.ok(!f.raw.reads.includes("a#second"));
});

test("failed provider config write rolls back configuration and generation", async t => {
  const f = setup(t); const pool = await f.install(); const original = f.store.provider("a")!, revision = f.store.providerConfigurationRevision("a"); mkdirSync(join(f.dir, "state.json.tmp"));
  assert.throws(() => f.store.upsertProvider({ ...original, baseUrl: "https://failed.invalid" })); assert.deepEqual(f.store.provider("a"), original); assert.equal(f.store.providerConfigurationRevision("a"), revision);
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, true);
});

test("malformed approval and read failures reveal no key, hash, backend error or salt", async t => {
  const f = setup(t); const pool = await f.install(); f.raw.hook = async () => { throw new Error("fake-backend-secret-message"); };
  const result = await validateApproval(f.store, f.secrets, pool); assert.equal(result.ok, false);
  for (const fragment of ["fake-backend", "fake-secret", pool.automaticApproval!.salt, ...pool.automaticApproval!.members.map(m => m.seal)]) assert.ok(!JSON.stringify(result).includes(fragment));
  f.raw.hook = undefined; const broken = structuredClone(pool); broken.automaticApproval!.members[0]!.seal = "invalid"; f.store.upsertPool(broken);
  assert.equal((await validateApproval(f.store, f.secrets, broken)).ok, false);
  const pub = JSON.stringify(publicAutomaticApproval(pool.automaticApproval!)); assert.ok(!pub.includes(pool.automaticApproval!.salt));
});

test("deleting and recreating the same source does not restore an old approval", async t => {
  const f = setup(t); const pool = await f.install(); const original = f.store.provider("a")!; f.store.removeProvider("a"); f.store.upsertProvider(original);
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
});

test("ordinary sources require an HTTP endpoint without embedded credentials", async t => {
  const f = setup(t);
  for (const baseUrl of ["", "cli://qoder", "file:///tmp/fake", "https://fake-user:fake-password@a.invalid/v1"]) {
    f.store.upsertProvider({ ...provider("b"), baseUrl }); f.raw.reads = [];
    await assert.rejects(f.mint(), AutomaticApprovalError); assert.deepEqual(f.raw.reads, []);
  }
});

test("binding revision prevents A to B to A previews and survives restart", t => {
  const f = setup(t), a = { harness: "codex", providerId: "a", model: "gpt-4.1" };
  assert.equal(f.store.bindingRevision("codex"), ""); f.store.setBinding(a); const reviewed = f.store.bindingRevision("codex");
  f.store.setBinding({ ...a, providerId: "b" }); f.store.setBinding(a); assert.deepEqual(f.store.binding("codex"), a); assert.notEqual(f.store.bindingRevision("codex"), reviewed);
  assert.equal(new Store(f.dir).bindingRevision("codex"), f.store.bindingRevision("codex"));
});

test("binding revision changes on same-value save and repeated explicit clear but not another harness", t => {
  const f = setup(t), a = { harness: "codex", providerId: "a", model: "gpt-4.1" }; f.store.setBinding(a); const first = f.store.bindingRevision("codex");
  f.store.setBinding({ harness: "claude", providerId: "b", model: "gpt-4.1" }); assert.equal(f.store.bindingRevision("codex"), first);
  f.store.setBinding(a); assert.notEqual(f.store.bindingRevision("codex"), first); const second = f.store.bindingRevision("codex");
  f.store.clearBinding("codex"); assert.notEqual(f.store.bindingRevision("codex"), second); const third = f.store.bindingRevision("codex");
  f.store.clearBinding("codex"); assert.notEqual(f.store.bindingRevision("codex"), third);
});

test("binding revision changes atomically with automatic installation", async t => {
  const f = setup(t); f.store.setBinding({ harness: "codex", providerId: "a", model: "gpt-4.1" }); const before = f.store.bindingRevision("codex");
  const pool = await f.install(); assert.notEqual(f.store.bindingRevision("codex"), before); assert.equal(new Store(f.dir).binding("codex")!.model, pool.id);
});

test("binding revision advances for profile replacement including same values and unbound harnesses", t => {
  const f = setup(t); const empty = f.store.saveProfile("empty"); const unbound = f.store.bindingRevision("new-harness");
  f.store.applyProfile(empty.id); assert.notEqual(f.store.bindingRevision("new-harness"), unbound);
  f.store.setBinding({ harness: "codex", providerId: "a", model: "gpt-4.1" }); const profile = f.store.saveProfile("same"); const before = f.store.bindingRevision("codex");
  f.store.applyProfile(profile.id); assert.notEqual(f.store.bindingRevision("codex"), before);
  const next = f.store.bindingRevision("codex"); f.store.applyProfile(empty.id); assert.equal(f.store.binding("codex"), undefined); assert.notEqual(f.store.bindingRevision("codex"), next);
  const stable = f.store.bindingRevision("codex"); assert.equal(f.store.applyProfile("missing"), undefined); assert.equal(f.store.bindingRevision("codex"), stable);
});

for (const path of ["removeProvider", "removePool"] as const) test(`binding revision follows ${path} only for affected harnesses`, t => {
  const f = setup(t); f.store.upsertPool({ id: "old", name: "old", strategy: "order", members: f.members, createdAt: "now" });
  f.store.setBinding({ harness: "codex", providerId: path === "removeProvider" ? "a" : "pool", model: path === "removeProvider" ? "gpt-4.1" : "old" });
  f.store.setBinding({ harness: "claude", providerId: "b", model: "gpt-4.1" }); const before = f.store.bindingRevision("codex"), other = f.store.bindingRevision("claude");
  if (path === "removeProvider") f.store.removeProvider("a"); else f.store.removePool("old");
  assert.equal(f.store.binding("codex"), undefined); assert.notEqual(f.store.bindingRevision("codex"), before); assert.equal(f.store.bindingRevision("claude"), other);
});

for (const path of ["setBinding", "clearBinding", "applyProfile", "removeProvider", "removePool", "installAutomaticPoolAndBind"] as const) test(`binding revision and all state roll back on failed ${path}`, async t => {
  const f = setup(t); f.store.setBinding({ harness: "codex", providerId: "a", model: "gpt-4.1" }); f.store.setPrefs("codex", { effort: "low" }); const profile = f.store.saveProfile("low"); f.store.setPrefs("codex", { effort: "high" });
  f.store.upsertPool({ id: "old", name: "old", strategy: "rotate", members: f.members, createdAt: "now" }); f.store.setBinding({ harness: "claude", providerId: "pool", model: "old" });
  const pool: Pool = { id: "new-auto", name: "automatic", members: f.members, strategy: "automatic", automaticApproval: await f.mint(), createdAt: "now" };
  const file = join(f.dir, "state.json"), state = readFileSync(file, "utf8"), bindings = f.store.allBindings(), providers = f.store.providers(), pools = f.store.pools(), prefs = f.store.allPrefs(), revisions = ["codex", "claude", "unbound"].map(h => f.store.bindingRevision(h));
  mkdirSync(join(f.dir, "state.json.tmp"));
  assert.throws(() => {
    if (path === "setBinding") f.store.setBinding({ harness: "codex", providerId: "b", model: "gpt-4.1" });
    else if (path === "clearBinding") f.store.clearBinding("codex");
    else if (path === "applyProfile") f.store.applyProfile(profile.id);
    else if (path === "removeProvider") f.store.removeProvider("a");
    else if (path === "removePool") f.store.removePool("old");
    else f.store.installAutomaticPoolAndBind(pool, "codex");
  });
  assert.equal(readFileSync(file, "utf8"), state); assert.deepEqual(f.store.allBindings(), bindings); assert.deepEqual(f.store.providers(), providers); assert.deepEqual(f.store.pools(), pools); assert.deepEqual(f.store.allPrefs(), prefs); assert.deepEqual(["codex", "claude", "unbound"].map(h => f.store.bindingRevision(h)), revisions);
});

test("binding revision cannot be bypassed by mutating a caller-owned binding object", t => {
  const f = setup(t), binding = { harness: "codex", providerId: "a", model: "gpt-4.1" }; f.store.setBinding(binding); const saved = f.store.binding("codex"); binding.providerId = "b"; assert.deepEqual(f.store.binding("codex"), saved);
});

for (const observed of ["changed", "missing", "blank"] as const) test(`observed external ${observed} credential cannot revive an old grant after restoration or restart`, async t => {
  const f = setup(t); const pool = await f.install();
  if (observed === "missing") f.raw.values.delete("a"); else f.raw.values.set("a", observed === "blank" ? "  " : "fake-external-replacement");
  assert.equal((await validateAutomaticSnapshot(f.store, f.secrets, pool.members, pool.automaticApproval!)).ok, false);
  f.raw.values.set("a", "fake-secret-a-automatic");
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
  const restarted = new Store(f.dir); assert.equal((await validateApproval(restarted, revisionedSecrets(restarted, f.raw), pool)).ok, false);
});

test("observed external fixed-key replacement invalidates only that key generation", async t => {
  const f = setup(t); const p = f.store.provider("a")!; p.keys = [{ id: "fixed", label: "fixed", enabled: true, addedAt: "now" }]; f.store.upsertProvider(p); f.raw.values.set("a#fixed", "fake-fixed-old");
  const pool = await f.install(); const other = f.store.credentialRevision("b"); f.raw.values.set("a#fixed", "fake-fixed-new");
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false); assert.ok(f.store.credentialRevision("a#fixed")); assert.equal(f.store.credentialRevision("b"), other);
  f.raw.values.set("a#fixed", "fake-fixed-old"); await assert.rejects(readApprovedKey(f.store, f.secrets, pool, "a/gpt-4.1"), AutomaticApprovalError);
});

for (const observed of ["changed", "missing"] as const) test(`final pinned read permanently invalidates observed ${observed} credential`, async t => {
  const f = setup(t); const pool = await f.install(); let reads = 0;
  f.raw.hook = async () => { if (++reads === 2) { if (observed === "missing") f.raw.values.delete("a"); else f.raw.values.set("a", "fake-external-last-read"); } };
  await assert.rejects(readApprovedKey(f.store, f.secrets, pool, "a/gpt-4.1"), AutomaticApprovalError);
  f.raw.hook = undefined; f.raw.values.set("a", "fake-secret-a-automatic"); assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
});

test("observed credential invalidation survives failed persistence in memory; a new grant cannot install until save succeeds", async t => {
  const f = setup(t); const pool = await f.install(); const before = f.store.credentialRevision("a"), oldDisk = readFileSync(join(f.dir, "state.json"), "utf8"); mkdirSync(join(f.dir, "state.json.tmp"));
  f.raw.values.set("a", "fake-external-failed-save"); assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
  assert.notEqual(f.store.credentialRevision("a"), before); assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), oldDisk);
  f.raw.values.set("a", "fake-secret-a-automatic"); assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
  const newPool: Pool = { ...pool, id: "renewed", automaticApproval: await f.mint() };
  assert.throws(() => f.store.installAutomaticPoolAndBind(newPool, "codex")); assert.equal(f.store.pool("renewed"), undefined); assert.equal(f.store.binding("codex")!.model, pool.id);
  rmSync(join(f.dir, "state.json.tmp"), { recursive: true }); f.store.installAutomaticPoolAndBind(newPool, "codex");
  const restarted = new Store(f.dir); assert.equal((await validateApproval(restarted, revisionedSecrets(restarted, f.raw), pool)).ok, false); assert.equal((await validateApproval(restarted, revisionedSecrets(restarted, f.raw), newPool)).ok, true);
});

test("configuration drift and backend read errors do not masquerade as observed secret replacement", async t => {
  const f = setup(t); const pool = await f.install(); const revisions = [f.store.credentialRevision("a"), f.store.credentialRevision("b")];
  f.store.upsertProvider({ ...f.store.provider("a")!, baseUrl: "https://config-only.invalid" });
  assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false); assert.deepEqual([f.store.credentialRevision("a"), f.store.credentialRevision("b")], revisions);
  const approval = await f.mint(); f.raw.hook = async () => { throw new Error("fake-backend-unavailable"); };
  assert.equal((await validateAutomaticSnapshot(f.store, f.secrets, f.members, approval)).ok, false); assert.deepEqual([f.store.credentialRevision("a"), f.store.credentialRevision("b")], revisions);
});

test("legacy Chat probe routing status invalidates approval while probe timestamps and other checks do not", async t => {
  const f = setup(t); const p = f.store.provider("a")!; delete p.protocols; p.routePinned = false;
  p.probe = { at: "old", model: "gpt-4.1", checks: [{ id: "chat", label: "chat", status: "pass", latencyMs: 20, detail: "old" }], recommendedRoute: "chat-translate" };
  f.store.upsertProvider(p); const pool = await f.install(); const before = f.store.providerConfigurationRevision("a");
  p.probe.at = "new"; p.probe.checks[0]!.latencyMs = 100; p.probe.checks[0]!.detail = "new"; p.probe.checks.push({ id: "models", label: "models", status: "fail", detail: "metadata" }); f.store.upsertProvider(p);
  assert.equal(f.store.providerConfigurationRevision("a"), before); assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, true);
  p.probe.checks[0]!.status = "fail"; f.store.upsertProvider(p); assert.notEqual(f.store.providerConfigurationRevision("a"), before); assert.equal((await validateApproval(f.store, f.secrets, pool)).ok, false);
});
