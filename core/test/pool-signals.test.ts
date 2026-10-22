import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import vm from "node:vm";
import { clearRest, markFailed, poolMembers } from "../src/pools.ts";
import { clearQuota, quotaOf, recordLimitReached, recordWindows } from "../src/quota.ts";
import { SourceHealthMonitor } from "../src/source-health.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { Pool, Provider } from "../src/types.ts";

// Pure records, VM rendering and loopback only. No accounts, clients or model probes.
// Dynamic loading lets the red phase assert the missing capability explicitly.
const modulePath = "../src/pool-signals.ts";
const signals = await import(modulePath).catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const NOW = Date.parse("2026-10-22T00:00:00Z");
let sequence = 0;
function take(store: Store, pool: Pool, options: Record<string, unknown> = {}): any {
  assert.equal(typeof signals.poolSignalSnapshot, "function", "read-only pool signal snapshot must exist");
  return signals.poolSignalSnapshot(store, pool, { now: NOW, ...options });
}
function fixture(t: TestContext) {
  clearRest(); clearQuota();
  const dir = mkdtempSync(join(tmpdir(), "es-pool-signals-"));
  t.after(() => { clearRest(); clearQuota(); rmSync(dir, { recursive: true, force: true }); });
  const store = new Store(dir);
  const add = (id: string, extra: Partial<Provider> = {}): Provider => {
    const p: Provider = { id, name: id, baseUrl: "http://127.0.0.1:1/v1", models: ["m"], route: "chat-translate", routePinned: false, streamUsage: true, createdAt: "", ...extra };
    store.upsertProvider(p); return p;
  };
  add("a"); add("b");
  const pool: Pool = { id: `snapshot-${++sequence}`, name: "Fixture", members: ["a/m", "b/m"], strategy: "rotate", createdAt: "" };
  store.upsertPool(pool);
  return { dir, store, pool, add };
}
function browser() {
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#providers" }, window: { addEventListener() {} }, document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], activeElement: null }, history: { replaceState() {} }, setTimeout: () => 0, clearTimeout() {}, console });
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (code: string): any => vm.runInContext(code, context);
  return { context, run };
}

test("unknown pool signals are immutable, repeatable and do not advance rotation or claim inference/quota", t => {
  const { store, pool, dir } = fixture(t);
  const before = readFileSync(join(dir, "state.json"), "utf8");
  const one = take(store, pool), two = take(store, pool);
  assert.deepEqual(one, two);
  assert.equal(one.members[0].selectable, true);
  assert.equal(one.members[0].generation, "unverified");
  assert.equal(one.members[0].quota.state, "unknown");
  assert.equal(one.members[0].quota.freshness, "unknown");
  assert.equal(one.members[0].effect, "normal");
  assert.throws(() => { one.members[0].quota.windows.push({}); }, TypeError);
  assert.throws(() => { one.members[0].effect = "later"; }, TypeError);
  assert.deepEqual(poolMembers(store, `pool/${pool.id}`), ["a/m", "b/m"]);
  assert.deepEqual(poolMembers(store, `pool/${pool.id}`), ["b/m", "a/m"]);
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
  assert.doesNotMatch(JSON.stringify(one), /remaining|apiKey|baseUrl|127\.0\.0\.1/);
});

test("catalog exclusions remain separate from all-waiting markers and existing routing still tries members", t => {
  const { store, pool, add } = fixture(t);
  add("off", { off: true }); add("budget"); add("missing-model", { models: ["other"] });
  pool.members.push("off/m", "budget/m", "missing-model/m", "gone/m");
  store.upsertPool(pool); store.setProviderBudgetChecker(p => p.id === "budget");
  const now = Date.now(); recordLimitReached("a", now); recordLimitReached("b", now);
  const snapshot = take(store, pool, { now });
  assert.deepEqual(snapshot.members.map((m: any) => m.reason), ["catalog_eligible", "catalog_eligible", "source_disabled", "budget_blocked", "model_missing", "source_missing"]);
  assert.deepEqual(snapshot.members.map((m: any) => m.effect), ["later", "later", "excluded", "excluded", "excluded", "excluded"]);
  assert.deepEqual(poolMembers(store, `pool/${pool.id}`), ["a/m", "b/m"], "negative signals are not a new hard exclusion");
});

test("member failure waits preserve scope, have no invented observation time and expire without recovery claims", t => {
  const { store, pool, add } = fixture(t);
  add("a", { models: ["m", "other"] }); pool.members.push("a/other");
  markFailed("a/m");
  const before = take(store, pool, { now: Date.now() });
  assert.equal(before.members[0].failureWait.state, "active");
  assert.equal(before.members[0].failureWait.observedAt, null);
  assert.equal(before.members[0].failureWait.identity, "unverified");
  assert.equal(before.members[2].failureWait.state, "none");
  const until = before.members[0].failureWait.until;
  const at = take(store, pool, { now: until });
  assert.equal(at.members[0].failureWait.state, "elapsed");
  assert.equal(at.members[0].effect, "normal");
  assert.equal(at.members[0].generation, "unverified");
  assert.equal(take(store, pool, { now: until - 1 }).members[0].failureWait.state, "active", "reads do not clear the original marker");
});

test("zero reported usage is a historical value, not unknown, fresh, free or current available quota", t => {
  const { store, pool } = fixture(t);
  recordWindows("a", [{ id: "primary", usedPercent: 0 }], NOW - 1_000_000);
  const q = take(store, pool).members[0].quota;
  assert.equal(q.state, "recorded"); assert.equal(q.freshness, "unknown");
  assert.equal(q.identity, "unverified"); assert.equal(q.scope, "provider_id_record");
  assert.equal(q.windows[0].usedPercent, 0); assert.equal(q.windows[0].observedAt, null);
  assert.equal(q.windows[0].state, "recorded");
  assert.equal(q.wait.state, "none");
  assert.equal(take(store, pool).members[1].quota.state, "unknown");
});

test("elapsed vendor windows are stale, mixed windows stay distinct and record updates do not refresh observations", t => {
  const { store, pool } = fixture(t);
  recordWindows("a", [{ id: "primary", usedPercent: 100, resetAt: NOW }, { id: "secondary", usedPercent: 10, resetAt: NOW + 30_000 }], NOW - 5000);
  recordLimitReached("a", NOW - 1000);
  const q = take(store, pool).members[0].quota;
  assert.equal(q.updatedAt, NOW - 1000);
  assert.deepEqual(q.windows.map((w: any) => w.state), ["stale", "recorded"]);
  assert.equal(q.windows[0].observedAt, null);
  assert.equal(q.freshness, "unknown");
  const elapsed = take(store, pool, { now: NOW + 30_000 }).members[0];
  assert.equal(elapsed.quota.state, "stale"); assert.equal(elapsed.quota.freshness, "stale");
  assert.equal(elapsed.quota.wait.state, "elapsed"); assert.equal(elapsed.generation, "unverified");
  assert.equal(quotaOf("a")!.windows[0]!.usedPercent, 100, "snapshot never clears the source evidence");
});

test("unknown reset and anomalous times never become a current quota promise or bogus date", t => {
  const { store, pool } = fixture(t);
  recordLimitReached("a", NOW);
  let q = take(store, pool).members[0].quota;
  assert.equal(q.wait.basis, "retry_marker"); assert.equal(q.state, "recorded");
  const raw = quotaOf("a")!;
  raw.updatedAt = NOW + 1000;
  raw.windows = [{ id: "primary", usedPercent: NaN, resetAt: Infinity }];
  q = take(store, pool).members[0].quota;
  assert.equal(q.state, "unknown"); assert.equal(q.freshness, "unknown");
  assert.equal(q.updatedAt, undefined); assert.equal(q.windows[0].usedPercent, undefined);
  assert.equal(q.windows[0].vendorResetAt, undefined);
  assert.equal(q.wait.state, "active", "uncertain observation time does not erase an active routing marker");
  raw.exhaustedUntil = Infinity;
  const anomalous = take(store, pool).members[0];
  assert.equal(anomalous.quota.wait.state, "unknown"); assert.equal(anomalous.effect, "later", "describe existing routing without normalizing its decisions");
});

test("quota records remain explicitly unbound after endpoint, key and same-id source replacement", t => {
  const { store, pool, add } = fixture(t);
  recordWindows("a", [{ id: "primary", usedPercent: 42, resetAt: NOW + 60_000 }], NOW);
  const first = take(store, pool);
  add("a", { baseUrl: "https://changed.example.invalid/v1", keys: [{ id: "replacement", enabled: true }] as Provider["keys"] });
  const changed = take(store, pool);
  assert.equal(changed.members[0].quota.identity, "unverified");
  assert.equal(changed.members[0].quota.freshness, "unknown");
  assert.equal(changed.members[0].generation, "unverified");
  quotaOf("a")!.windows[0]!.usedPercent = 99;
  assert.equal(first.members[0].quota.windows[0].usedPercent, 42, "nested source mutations cannot change a previously returned snapshot");
  assert.doesNotMatch(JSON.stringify(changed), /changed\.example|replacement/);
});

test("metadata health snapshot rejects changed identity without syncing, checking or consuming monitor events", t => {
  const { store, pool, add } = fixture(t);
  let now = NOW, calls = 0;
  const p = add("a", { healthMonitor: { enabled: true } });
  const health = new SourceHealthMonitor({ now: () => now, eligibility: p => p.healthMonitor?.enabled ? { eligible: true, basis: "user_enabled" } : { eligible: false, blockedReason: "permission_required" }, headers: async () => { calls++; throw new Error("no credentials"); }, fetch: async () => { calls++; throw new Error("no probes"); } });
  t.after(() => health.close()); health.sync([p]); health.verify(p);
  assert.equal(typeof (health as any).snapshotFor, "function");
  const options = { healthOf: (provider: Provider) => (health as any).snapshotFor(provider) };
  const normal = take(store, pool, options).members[0];
  assert.equal(normal.metadata.state, "passed"); assert.equal(normal.generation, "unverified");
  add("a", { ...p, off: true });
  assert.equal(take(store, pool, options).members[0].metadata.state, "unknown");
  add("a", { ...p, healthMonitor: { enabled: false } });
  assert.equal(take(store, pool, options).members[0].metadata.state, "unknown");
  add("a", { ...p, keys: [{ id: "different-key", enabled: true }] as Provider["keys"] });
  assert.equal(take(store, pool, options).members[0].metadata.state, "unknown");
  add("a", { ...p, baseUrl: "https://changed.example.invalid/v1" });
  assert.equal(take(store, pool, options).members[0].metadata.state, "unknown");
  assert.equal(health.snapshot("a").status, "healthy", "snapshot does not sync or rewrite the old monitor entry");
  store.upsertProvider(p); now += 15 * 60_000 + 1;
  assert.equal(take(store, pool, { ...options, now }).members[0].metadata.state, "stale");
  now = NOW - 1;
  assert.equal(take(store, pool, { ...options, now }).members[0].metadata.state, "unknown");
  now = NOW; health.invalidate("a");
  assert.equal(take(store, pool, options).members[0].metadata.state, "unknown", "same-id credential replacement remains unverified");
  assert.equal(calls, 0);
});

test("metadata failure, rate limits, missing times and wrong subjects never become generation health", t => {
  const { store, pool } = fixture(t);
  const base = { providerId: "a", status: "healthy", reason: "verified_models", checkedAt: NOW, verified: true, eligible: true, consecutiveFailures: 0 };
  const evidence = (extra: Record<string, unknown>) => take(store, pool, { healthOf: () => ({ ...base, ...extra }) }).members[0];
  assert.equal(evidence({ status: "unavailable", reason: "consecutive_failures", consecutiveFailures: 3 }).metadata.state, "failed");
  for (const extra of [{ reason: "rate_limited", status: "unknown" }, { checkedAt: undefined }, { checkedAt: NOW + 1 }, { providerId: "b" }, { verified: false }, { eligible: false }]) {
    const member = evidence(extra);
    assert.equal(member.metadata.state, "unknown"); assert.equal(member.generation, "unverified");
  }
});

test("signal API is read-only and does not read secrets, probe, log, rewrite state or consume a turn", async t => {
  const { store, pool, dir } = fixture(t);
  const server = createEasySwitchServer({ store, port: 0, sourceHealth: { now: () => NOW, fetch: async () => { assert.fail("no network probe"); } }, secrets: { async get() { assert.fail("no credentials"); }, async set() { assert.fail("no credentials"); }, async delete() { assert.fail("no credentials"); } },
    interactiveRuntime: { async findBinary() { assert.fail("no discovery"); }, newSessionDir() { assert.fail("no launch"); }, async launchInTerminal() { assert.fail("no launch"); } } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const before = readFileSync(join(dir, "state.json"), "utf8");
  const ledgerBefore = existsSync(join(dir, "usage.jsonl")) ? readFileSync(join(dir, "usage.jsonl"), "utf8") : null;
  const get = () => new Promise<any>((resolve, reject) => { request(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/pools`, res => { let text = ""; res.on("data", b => text += b); res.on("end", () => resolve(JSON.parse(text))); }).on("error", reject).end(); });
  let previous;
  for (let i = 0; i < 3; i++) {
    const result = (await get()).pools[0].signals;
    assert.ok(result, "API exposes the signal snapshot");
    assert.equal(result.members[0].quota.state, "unknown");
    if (previous) assert.deepEqual(result, previous);
    previous = result;
  }
  assert.deepEqual(poolMembers(store, `pool/${pool.id}`), pool.members);
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
  assert.equal(existsSync(join(dir, "usage.jsonl")) ? readFileSync(join(dir, "usage.jsonl"), "utf8") : null, ledgerBefore);
});

test("pool signal UI is folded, preserves expansion and safely explains unknown, waits, stale records and metadata", t => {
  const { store, pool } = fixture(t);
  recordWindows("a", [{ id: "primary", usedPercent: 100, resetAt: NOW + 60_000 }], NOW);
  const app = browser(); app.context.fixture = { ...pool, memberStates: [], live: pool.members, signals: take(store, pool) };
  app.run('state={providers:[{id:"a",name:"<img src=x onerror=alert(1)>"}],pools:[fixture]}');
  const html = app.run("poolsCard()");
  assert.match(html, /查看选择依据/); assert.match(html, /<details[^>]*data-keep="pool-signals:/);
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:\s|>)/);
  assert.match(html, /仍可能.*尝试/); assert.match(html, /额度未知/);
  assert.match(html, /当前账号.*未核验|未核验.*当前账号/);
  assert.match(html, /推理可用性未验证/);
  assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img src=x/);
  app.run(`openDetails.add(${JSON.stringify(`pool-signals:${pool.id}`)})`);
  assert.match(app.run("poolsCard()"), /<details[^>]*\sopen(?:\s|>)/);
  app.context.fixture = { ...pool, live: pool.members, signals: take(store, pool, { now: NOW + 60_000 }) };
  app.run("state.pools=[fixture]");
  assert.match(app.run("poolsCard()"), /已过期|已到期/);
  assert.doesNotMatch(app.run("poolsCard()"), /额度已恢复|余量充足|保证成功|100%可用/);
});

test("old and hostile UI snapshots never infer success or render arbitrary evidence as HTML", () => {
  const app = browser();
  app.run('state={providers:[],pools:[{id:"p",name:"Fixture",strategy:"order",members:["a/m"],live:["a/m"]}]}');
  assert.match(app.run("poolsCard()"), /尚无.*信号|信号.*未提供/);
  app.run('state.pools[0].signals={members:[{member:"a/m",effect:"<img src=x>",quota:{state:"<img src=x>",windows:[]},metadata:{state:"<img src=x>"}}]}');
  const html = app.run("poolsCard()");
  assert.match(html, /额度未知/); assert.match(html, /推理可用性未验证/);
  assert.doesNotMatch(html, /<img src=x>|余量充足|已经恢复|生成成功/);
});
