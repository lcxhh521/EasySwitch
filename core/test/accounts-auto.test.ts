import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { pickAccount } from "../src/accounts.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { Account } from "../src/types.ts";

// Only synthetic account metadata, temporary state, loopback HTTP and injected
// runners. Never create a real account HOME, discover a client or read a login.
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-auto-accounts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.setAccountSettings({ autoPick: true });
  const add = (id: string, extra: Partial<Account> = {}) => {
    const a: Account = { id, harness: "codex", label: id, home: join(dir, id), enabled: true, addedAt: "2026-01-01T00:00:00Z", ...extra };
    store.upsertAccount(a);
    return a;
  };
  return { dir, store, add };
}

test("automatic choice refuses all resting accounts and reports the earliest marked retry time", t => {
  const { store, add } = fixture(t), now = Date.parse("2026-10-21T10:00:00Z");
  add("a-later", { restUntil: "2026-10-21T13:00:00Z" });
  add("a-first", { restUntil: "2026-10-21T20:00:00+08:00" });
  const before = JSON.stringify(store.accounts());
  const picked = pickAccount(store, "codex", store.accountSettings(), now);
  assert.equal(picked.ok, false);
  if (picked.ok) assert.fail("resting accounts must never be offered automatically");
  assert.equal(picked.code, "account_resting");
  assert.equal(picked.retryAt, "2026-10-21T12:00:00.000Z");
  assert.equal(JSON.stringify(store.accounts()), before);
  assert.equal(store.accountSettings().autoPick, true);
});

test("automatic choice only considers enabled accounts belonging to the requested client", t => {
  const { store, add } = fixture(t);
  add("a-disabled", { enabled: false });
  add("a-other", { harness: "claude" });
  const picked = pickAccount(store, "codex");
  assert.equal(picked.ok, false);
  if (picked.ok) assert.fail("there is no eligible account");
  assert.equal(picked.code, "account_unavailable");
  assert.equal(picked.retryAt, undefined);
});

test("automatic choice stays opt-in and keeps longest-unused ordering and exact expiry boundary", t => {
  const { store, add } = fixture(t), now = Date.parse("2026-10-21T10:00:00Z");
  const a = add("a-expired", { restUntil: new Date(now).toISOString(), lastUsedAt: "2026-10-20T00:00:00Z" });
  const b = add("a-never-used");
  add("a-resting", { restUntil: new Date(now + 1).toISOString() });
  store.setAccountSettings({ autoPick: false });
  const off = pickAccount(store, "codex", store.accountSettings(), now);
  assert.ok(!off.ok && off.code === "account_auto_disabled");
  store.setAccountSettings({ autoPick: true });
  const first = pickAccount(store, "codex", store.accountSettings(), now);
  assert.ok(first.ok && first.account.id === b.id);
  store.upsertAccount({ ...b, enabled: false });
  const next = pickAccount(store, "codex", store.accountSettings(), now);
  assert.ok(next.ok && next.account.id === a.id);
});

async function apiFixture(t: TestContext, options: { failLaunch?: boolean; onFind?: (store: Store) => void } = {}) {
  const f = fixture(t), calls = { find: [] as string[], launch: [] as string[], keys: 0 };
  const server = createEasySwitchServer({ store: f.store, port: 0,
    secrets: { async get() { calls.keys++; assert.fail("no credentials may be read"); }, async set() { assert.fail("no credential writes"); }, async delete() { assert.fail("no credential deletes"); } },
    interactiveRuntime: {
      async findBinary(id) { calls.find.push(id); options.onFind?.(f.store); return `/fixture/never-run-${id}`; },
      newSessionDir() { assert.fail("account launches use their existing synthetic HOME"); },
      async launchInTerminal(command) { calls.launch.push(command); if (options.failLaunch) throw new Error("fixture launch failure"); },
    },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const port = (server.address() as { port: number }).port;
  const post = (body: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}/api/accounts/launch`, { method: "POST", headers: { "x-easyswitch": "1", "content-type": "application/json" } }, res => {
      let text = ""; res.on("data", chunk => text += chunk); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject); req.end(JSON.stringify(body));
  });
  return { ...f, calls, post };
}

test("all-resting API refusal happens before discovery, launch, credentials or history changes", async t => {
  const f = await apiFixture(t), retryAt = new Date(Date.now() + 3_600_000).toISOString();
  f.add("a-one", { restUntil: retryAt }); f.add("a-two", { restUntil: new Date(Date.now() + 7_200_000).toISOString() });
  const before = readFileSync(join(f.dir, "state.json"), "utf8");
  const result = await f.post({ harness: "codex" });
  assert.equal(result.status, 409); assert.equal(result.body.code, "account_resting");
  assert.equal(result.body.retryAt, retryAt); assert.equal(result.body.uiError.action.target, "settings");
  assert.match(result.body.error, /休息标记/);
  assert.deepEqual(f.calls, { find: [], launch: [], keys: 0 });
  assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
});

test("invalid explicit account selections do not silently fall back or mix client identities", async t => {
  const f = await apiFixture(t); f.add("a-ready"); f.add("a-claude", { harness: "claude" });
  const before = JSON.stringify(f.store.accounts());
  for (const body of [{ harness: "codex", accountId: "a-missing" }, { harness: "codex", accountId: "a-claude" }, { harness: "codex", accountId: null }, { harness: "unknown" }]) {
    const result = await f.post(body);
    assert.equal(result.status, 409); assert.equal(result.body.code, "account_selection_invalid");
  }
  assert.deepEqual(f.calls, { find: [], launch: [], keys: 0 }); assert.equal(JSON.stringify(f.store.accounts()), before);
});

test("explicit manual selection still works for a resting account excluded from automatic choice", async t => {
  const f = await apiFixture(t), restUntil = new Date(Date.now() + 3_600_000).toISOString();
  f.store.setAccountSettings({ autoPick: false });
  const a = f.add("a-manual", { harness: "claude", restUntil, enabled: false });
  const result = await f.post({ harness: "claude", accountId: a.id });
  assert.equal(result.status, 200); assert.equal(result.body.account.id, a.id);
  assert.deepEqual(f.calls.find, ["claude"]); assert.equal(f.calls.launch.length, 1);
  assert.match(f.calls.launch[0]!, /CLAUDE_CONFIG_DIR=/); assert.match(f.calls.launch[0]!, /never-run-claude/);
  assert.equal(f.calls.keys, 0); assert.equal(f.store.account(a.id)!.restUntil, restUntil);
  assert.equal(f.store.account(a.id)!.enabled, false); assert.ok(f.store.account(a.id)!.lastUsedAt);
});

test("a failed injected launch does not mark an account as used", async t => {
  const f = await apiFixture(t, { failLaunch: true }); const a = f.add("a-ready");
  const result = await f.post({ harness: "codex" });
  assert.equal(result.status, 500); assert.equal(f.calls.launch.length, 1);
  assert.equal(f.store.account(a.id)!.lastUsedAt, undefined); assert.equal(f.calls.keys, 0);
});

test("automatic choice is rechecked after asynchronous client discovery", async t => {
  const f = await apiFixture(t, { onFind(store) { const a = store.account("a-ready")!; store.upsertAccount({ ...a, restUntil: new Date(Date.now() + 3_600_000).toISOString() }); } });
  f.add("a-ready");
  const result = await f.post({ harness: "codex" });
  assert.equal(result.status, 409); assert.equal(result.body.code, "account_resting");
  assert.equal(f.calls.find.length, 1); assert.equal(f.calls.launch.length, 0);
  assert.equal(f.store.account("a-ready")!.lastUsedAt, undefined);
});

test("turning off automatic choice during discovery prevents launch", async t => {
  const f = await apiFixture(t, { onFind(store) { store.setAccountSettings({ autoPick: false }); } });
  f.add("a-ready");
  const result = await f.post({ harness: "codex" });
  assert.equal(result.status, 409); assert.equal(result.body.code, "account_auto_disabled");
  assert.equal(f.calls.launch.length, 0); assert.equal(f.store.account("a-ready")!.lastUsedAt, undefined);
});

test("automatic recheck can choose another still-ready account without clearing the first marker", async t => {
  const retryAt = new Date(Date.now() + 3_600_000).toISOString();
  const f = await apiFixture(t, { onFind(store) { store.upsertAccount({ ...store.account("a-first")!, restUntil: retryAt }); } });
  f.add("a-first", { lastUsedAt: "2026-01-01T00:00:00Z" });
  f.add("a-second", { lastUsedAt: "2026-02-01T00:00:00Z" });
  const result = await f.post({ harness: "codex" });
  assert.equal(result.status, 200); assert.equal(result.body.account.id, "a-second");
  assert.equal(f.calls.launch.length, 1); assert.match(f.calls.launch[0]!, /a-second/);
  assert.equal(f.store.account("a-first")!.restUntil, retryAt);
  assert.equal(f.store.account("a-first")!.lastUsedAt, "2026-01-01T00:00:00Z");
  assert.notEqual(f.store.account("a-second")!.lastUsedAt, "2026-02-01T00:00:00Z");
});

test("a manual account removed during discovery never falls back to a different ready account", async t => {
  const f = await apiFixture(t, { onFind(store) { store.removeAccount("a-manual"); } });
  f.add("a-manual"); f.add("a-other");
  const result = await f.post({ harness: "codex", accountId: "a-manual" });
  assert.equal(result.status, 409); assert.equal(result.body.code, "account_selection_invalid");
  assert.equal(f.calls.launch.length, 0); assert.equal(f.store.account("a-other")!.lastUsedAt, undefined);
});
