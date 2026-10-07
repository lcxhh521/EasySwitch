import assert from "node:assert/strict";
import { test } from "node:test";
import { modelsHealthFingerprint, SourceHealthMonitor, type SourceHealthEligibility } from "../src/source-health.ts";
import { resolveAgentFallback } from "../src/agent-fallback.ts";
import type { Provider } from "../src/types.ts";

const BASE_NOW = Date.parse("2026-10-07T12:00:00Z"), INTERVAL = 300_000;
const provider = (id = "p", changes: Partial<Provider> = {}): Provider => ({ id, name: id, baseUrl: `https://${id}.example.invalid/v1`, models: ["m"], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "", ...changes });
const models = () => Response.json({ data: [{ id: "m" }] });
const allowed = (): SourceHealthEligibility => ({ eligible: true, basis: "verified_read_only" });
test("polling overrides cannot weaken interval, failure threshold or concurrency limits", () => {
  for (const over of [{ intervalMs: 60_000 }, { failureThreshold: 2 }, { concurrency: 3 }]) assert.throws(() => new SourceHealthMonitor({ headers: async () => ({}), ...over }), /health-check limits/);
});
function fixture(options: { fetch?: typeof fetch; eligibility?: (p: Provider) => SourceHealthEligibility; timeoutMs?: number; headers?: (p: Provider, signal: AbortSignal) => Promise<Record<string, string>> } = {}) {
  let now = BASE_NOW, mode = 200, calls = 0;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const health = new SourceHealthMonitor({ now: () => now, eligibility: options.eligibility ?? allowed, headers: options.headers ?? (async () => ({ authorization: "Bearer fixture-key" })), timeoutMs: options.timeoutMs,
    fetch: options.fetch ?? (async (url, init) => { calls++; requests.push({ url: String(url), init }); return mode === 200 ? models() : new Response(null, { status: mode }); }) });
  return { health, requests, advance: (ms = INTERVAL) => { now += ms; }, setMode: (value: number) => { mode = value; }, calls: () => calls };
}

test("ordinary relays need both explicit polling eligibility and a current model-list verification", async () => {
  let calls = 0; const p = provider();
  const defaultMonitor = new SourceHealthMonitor({ headers: async () => ({}), now: () => BASE_NOW, fetch: async () => { calls++; return models(); } });
  defaultMonitor.sync([p]); assert.ok(defaultMonitor.verify(p)); await defaultMonitor.runDue();
  assert.equal(defaultMonitor.snapshot(p.id).eligible, false); assert.equal(defaultMonitor.snapshot(p.id).blockedReason, "permission_required"); assert.equal(calls, 0);
  const { health, advance, calls: count } = fixture(); health.sync([p]); await health.runDue(); assert.equal(count(), 0);
  assert.equal(health.snapshot(p.id).status, "unknown"); health.verify(p); advance(); await health.runDue(); assert.equal(count(), 1);
});

test("explicit bootstrap verifies raw model-list responses, while failure never enables automatic polling", async () => {
  const p = provider(), f = fixture(); f.health.sync([p]);
  assert.equal(await f.health.checkNow(p.id), modelsHealthFingerprint(p));
  assert.equal(f.calls(), 1); assert.equal(f.health.snapshot(p.id).verified, true);
  assert.equal(await f.health.checkNow(p.id), undefined); assert.equal(f.calls(), 1, "repeated clicks respect the normal interval");
  f.advance(); await f.health.runDue(); assert.equal(f.calls(), 2);
  let calls = 0;
  const invalid = fixture({ fetch: async () => { calls++; return Response.json({ output: "not a raw models response" }); } }); invalid.health.sync([p]);
  assert.equal(await invalid.health.checkNow(p.id), undefined); assert.equal(invalid.health.snapshot(p.id).verified, false);
  invalid.advance(); await invalid.health.runDue(); assert.equal(calls, 1);
  invalid.advance(); assert.equal(await invalid.health.checkNow(p.id), undefined); assert.equal(calls, 2);
});

test("explicit bootstrap cannot bypass denied eligibility, unsupported URLs or Retry-After", async () => {
  const p = provider(); let calls = 0;
  const denied = fixture({ eligibility: () => ({ eligible: false, blockedReason: "permission_required" }), fetch: async () => { calls++; return models(); } }); denied.health.sync([p]);
  assert.equal(await denied.health.checkNow(p.id), undefined); assert.equal(calls, 0);
  denied.health.sync([provider("bad", { wire: { paths: { models: "chat/completions" } } })]); assert.equal(await denied.health.checkNow("bad"), undefined); assert.equal(calls, 0);
  const limited = fixture({ fetch: async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "3600" } }); } }); limited.health.sync([p]);
  assert.equal(await limited.health.checkNow(p.id), undefined); assert.equal(limited.health.snapshot(p.id).nextCheckAt, BASE_NOW + 3600_000);
  limited.advance(); assert.equal(await limited.health.checkNow(p.id), undefined); await limited.health.runDue(); assert.equal(calls, 1);
  limited.advance(3600_000); await limited.health.runDue(); assert.equal(calls, 1, "a failed bootstrap must not join automatic polling");
});

test("restoring prior endpoint evidence cannot shorten a bootstrap refusal cooldown", async () => {
  let calls = 0; const p = provider();
  const f = fixture({ fetch: async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "3600" } }); } });
  f.health.sync([p]); await f.health.checkNow(p.id);
  assert.equal(f.health.restoreVerification(p, modelsHealthFingerprint(p)!), true);
  assert.equal(f.health.snapshot(p.id).status, "unknown"); assert.equal(f.health.snapshot(p.id).nextCheckAt, BASE_NOW + 3600_000);
  f.advance(); await f.health.runDue(); assert.equal(await f.health.checkNow(p.id), undefined); assert.equal(calls, 1);
});

test("a cancelled in-flight bootstrap reserves its interval and preserves late same-endpoint vendor cooldowns", async () => {
  let calls = 0, resolve!: (value: Response) => void; const p = provider();
  const f = fixture({ fetch: async () => { calls++; return new Promise<Response>(done => { resolve = done; }); } });
  f.health.sync([p]); const first = f.health.checkNow(p.id); await new Promise(r => setImmediate(r));
  f.health.sync([{ ...p, off: true }]); f.health.sync([p]);
  assert.equal(await f.health.checkNow(p.id), undefined); assert.equal(calls, 1);
  resolve(new Response(null, { status: 429, headers: { "retry-after": "3600" } })); assert.equal(await first, undefined);
  assert.equal(f.health.snapshot(p.id).verified, false); assert.equal(f.health.snapshot(p.id).nextCheckAt, BASE_NOW + 3600_000);
  f.advance(); assert.equal(await f.health.checkNow(p.id), undefined); assert.equal(calls, 1);
});

test("explicit bootstrap and automatic sweeps share per-source single-flight and a global two-request cap", async () => {
  let active = 0, maximum = 0, calls = 0; const releases: Array<() => void> = [];
  const f = fixture({ fetch: async () => { calls++; active++; maximum = Math.max(maximum, active); await new Promise<void>(resolve => releases.push(resolve)); active--; return models(); } });
  const ps = [provider("a"), provider("b"), provider("c"), provider("d")]; f.health.sync(ps); f.health.verify(ps[0]!); f.advance();
  const sweep = f.health.runDue(); const joined = f.health.checkNow("a"); const b = f.health.checkNow("b"), bAgain = f.health.checkNow("b"); assert.equal(b, bAgain);
  const c = f.health.checkNow("c"), d = f.health.checkNow("d"); await new Promise(r => setImmediate(r)); assert.equal(calls, 2);
  releases.splice(0).forEach(resolve => resolve()); await new Promise(r => setImmediate(r)); assert.equal(calls, 4);
  releases.splice(0).forEach(resolve => resolve()); const results = await Promise.all([joined, b, c, d]); await sweep;
  assert.ok(results.every(Boolean)); assert.equal(maximum, 2); assert.equal(calls, 4);
});

test("failed first validation remains unknown even after repeated explicit attempts, and queued permission revocation sends nothing", async () => {
  const f = fixture(), p = provider(); f.health.sync([p]); f.setMode(503);
  for (let i = 0; i < 4; i++) { assert.equal(await f.health.checkNow(p.id), undefined); f.advance(); }
  assert.equal(f.health.snapshot(p.id).status, "unknown"); assert.equal(f.health.snapshot(p.id).verified, false); assert.deepEqual(f.health.drainTransitions(), []);
  let calls = 0; const releases: Array<() => void> = []; let disabled = false;
  const queued = fixture({ eligibility: p => p.id === "c" && disabled ? { eligible: false, blockedReason: "disabled" } : allowed(), fetch: async () => { calls++; await new Promise<void>(resolve => releases.push(resolve)); return models(); } });
  const ps = [provider("a"), provider("b"), provider("c")]; queued.health.sync(ps);
  const all = ps.map(p => queued.health.checkNow(p.id)); await new Promise(r => setImmediate(r)); assert.equal(calls, 2);
  disabled = true; queued.health.sync(ps); releases.splice(0).forEach(resolve => resolve());
  assert.equal((await Promise.all(all))[2], undefined); assert.equal(calls, 2); assert.equal(queued.health.snapshot("c").verified, false);
});

test("only consecutive definitive failures mark a source unavailable; recovery and outage alerts are emitted once", async () => {
  const f = fixture(), p = provider(); f.health.sync([p]); f.health.verify(p); f.setMode(503);
  for (let i = 0; i < 2; i++) { f.advance(); await f.health.runDue(); assert.equal(f.health.snapshot(p.id).status, "unknown"); }
  f.advance(); await f.health.runDue(); assert.equal(f.health.snapshot(p.id).status, "unavailable");
  assert.deepEqual(f.health.drainTransitions().map(e => e.status), ["unavailable"]);
  f.advance(); await f.health.runDue(); assert.deepEqual(f.health.drainTransitions(), []);
  f.setMode(200); f.advance(); await f.health.runDue(); assert.equal(f.health.snapshot(p.id).status, "healthy");
  assert.deepEqual(f.health.drainTransitions().map(e => e.status), ["healthy"]);
  f.advance(); await f.health.runDue(); assert.deepEqual(f.health.drainTransitions(), []);
  assert.ok(f.requests.every(r => r.url.endsWith("/v1/models") && r.init?.method === "GET" && r.init.body === undefined && r.init.redirect === "error"));
  assert.doesNotMatch(JSON.stringify(f.health.snapshots()), /fixture-key|example.invalid|Bearer/);
});

test("notifications discard obsolete outages after removal, invalidation, stale evidence or recovery", async () => {
  for (const action of ["remove", "invalidate", "stale", "recover"] as const) {
    const f = fixture(), p = provider(); f.health.sync([p]); f.health.verify(p); f.setMode(503);
    for (let i = 0; i < 3; i++) { f.advance(); await f.health.runDue(); }
    if (action === "remove") f.health.sync([]);
    else if (action === "invalidate") f.health.invalidate(p.id);
    else if (action === "stale") f.advance(16 * 60_000);
    else { f.setMode(200); f.advance(); await f.health.runDue(); }
    assert.deepEqual(f.health.drainTransitions().map(e => e.status), action === "recover" ? ["healthy"] : []);
  }
});

test("429 is cooldown evidence, never proof of spent quota, and Retry-After prevents extra checks", async () => {
  let calls = 0;
  const f = fixture({ fetch: async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": "3600" } }); } }), p = provider();
  f.health.sync([p]); f.health.verify(p); f.advance(); await f.health.runDue();
  assert.equal(f.health.snapshot(p.id).status, "unknown"); assert.equal(f.health.snapshot(p.id).reason, "rate_limited");
  for (let i = 0; i < 10; i++) { f.advance(); await f.health.runDue(); }
  assert.equal(calls, 1); assert.deepEqual(f.health.drainTransitions(), []);
  f.advance(600_000); await f.health.runDue(); assert.equal(calls, 2);
});

test("HTTP-date Retry-After survives permission toggles and a newer explicit verification", async () => {
  let calls = 0, permission = true;
  const f = fixture({ eligibility: () => permission ? allowed() : { eligible: false, blockedReason: "disabled" }, fetch: async () => { calls++; return new Response(null, { status: 429, headers: { "retry-after": new Date(BASE_NOW + INTERVAL + 3600_000).toUTCString() } }); } }), p = provider();
  f.health.sync([p]); f.health.verify(p); f.advance(); await f.health.runDue(); assert.equal(calls, 1);
  permission = false; f.health.sync([p]); permission = true; f.health.sync([p]); f.advance(1); await f.health.runDue(); assert.equal(calls, 1);
  f.health.sync([{ ...p, off: true }]); assert.equal(f.health.snapshot(p.id).blockedReason, "disabled");
  f.health.sync([p]); f.advance(1); await f.health.runDue(); assert.equal(calls, 1, "disabling a source also preserves its outstanding cooldown");
  f.health.verify(p); f.advance(); await f.health.runDue(); assert.equal(calls, 1, "metadata success cannot erase an outstanding polling cooldown");
  f.advance(3600_000); await f.health.runDue(); assert.equal(calls, 2);
});

test("unsupported sources, insecure remote URLs and generation overrides are never polled", async () => {
  const ps = [provider("off", { off: true }), provider("plan", { plan: { kind: "codex", accountId: "fixture" } }), provider("kiro", { kiro: {} }), provider("remote", { baseUrl: "http://remote.example/v1" }), provider("generation", { wire: { paths: { models: "chat/completions" } } }), provider("userinfo", { baseUrl: "https://user:secret@p.example/v1" })];
  const f = fixture(); f.health.sync(ps);
  for (const p of ps) { assert.equal(modelsHealthFingerprint(p), undefined); assert.equal(f.health.verify(p), undefined); }
  await f.health.runDue(); assert.equal(f.calls(), 0);
  assert.ok(modelsHealthFingerprint(provider("local", { baseUrl: "http://127.0.0.1:9999/v1" })));
});

test("endpoint and credential configuration changes revoke proof; saved digests restore qualification, not health", async () => {
  const f = fixture(), p = provider(); f.health.sync([p]); const fingerprint = f.health.verify(p)!;
  const changed = { ...p, baseUrl: "https://different.example/v1" }; f.health.sync([changed]);
  assert.equal(f.health.snapshot(p.id).verified, false); assert.equal(f.health.restoreVerification(changed, fingerprint), false);
  f.advance(); await f.health.runDue(); assert.equal(f.calls(), 0);
  f.health.sync([p]); assert.equal(f.health.restoreVerification(p, fingerprint), true); assert.equal(f.health.snapshot(p.id).status, "unknown");
  await f.health.runDue(); assert.equal(f.calls(), 1); f.health.invalidate(p.id);
  f.advance(); await f.health.runDue(); assert.equal(f.calls(), 1); assert.equal(f.health.snapshot(p.id).verified, false);
  assert.equal(f.health.restoreVerification(p, fingerprint), false, "an explicitly revoked proof cannot be restored from stale settings");
  assert.ok(f.health.verify(p), "a newly successful explicit model-list check can replace revoked proof");
});

test("repeated restoration cannot bypass cooldown and fresh manual verification wins over older in-flight polls", async () => {
  let resolve!: (r: Response) => void;
  const f = fixture({ fetch: async () => new Promise<Response>(r => { resolve = r; }) }), p = provider();
  f.health.sync([p]); const proof = f.health.verify(p)!;
  for (let i = 0; i < 5; i++) assert.equal(f.health.restoreVerification(p, proof), true);
  await f.health.runDue(); assert.equal(Boolean(resolve), false, "restoration does not advance the next check");
  f.advance(); const sweep = f.health.runDue(); await new Promise(r => setImmediate(r));
  f.health.verify(p); resolve(new Response(null, { status: 503 })); await sweep;
  assert.equal(f.health.snapshot(p.id).status, "healthy"); assert.equal(f.health.snapshot(p.id).consecutiveFailures, 0);
});

test("single-flight sweeps bound concurrency and a repeated tick never doubles any source request", async () => {
  let active = 0, maxActive = 0, calls = 0; const releases: Array<() => void> = [];
  const f = fixture({ fetch: async () => { calls++; active++; maxActive = Math.max(maxActive, active); await new Promise<void>(resolve => releases.push(resolve)); active--; return models(); } });
  const ps = [provider("a"), provider("b"), provider("c")]; f.health.sync(ps); ps.forEach(p => f.health.verify(p)); f.advance();
  const first = f.health.runDue(), second = f.health.runDue(); assert.equal(first, second); await new Promise(r => setImmediate(r));
  assert.equal(calls, 2); releases.shift()!(); await new Promise(r => setImmediate(r)); assert.equal(calls, 3);
  releases.splice(0).forEach(resolve => resolve()); await Promise.all([first, second]); assert.equal(maxActive, 2); assert.equal(active, 0);
  await f.health.runDue(); assert.equal(calls, 3);
});

test("removed sources and revoked polling permission discard in-flight results", async () => {
  let resolve!: (r: Response) => void, permission = true, signal: AbortSignal | undefined;
  const f = fixture({ eligibility: () => permission ? allowed() : { eligible: false, blockedReason: "disabled" }, fetch: async (_url, init) => { signal = init?.signal ?? undefined; return new Promise<Response>(r => { resolve = r; }); } });
  const p = provider(); f.health.sync([p]); f.health.verify(p); f.advance(); const sweep = f.health.runDue(); await new Promise(r => setImmediate(r));
  permission = false; f.health.sync([p]); assert.equal(signal?.aborted, true); resolve(models()); await sweep;
  assert.equal(f.health.snapshot(p.id).status, "unknown"); assert.equal(f.health.snapshot(p.id).eligible, false);
  f.health.sync([]); assert.deepEqual(f.health.snapshots(), []); await f.health.runDue();
});

test("timeouts bound even uncooperative injected transports and errors never expose secrets", async () => {
  const f = fixture({ timeoutMs: 10, fetch: async () => new Promise<Response>(() => {}) }), p = provider();
  f.health.sync([p]); f.health.verify(p);
  for (let i = 0; i < 3; i++) { f.advance(); await f.health.runDue(); }
  assert.equal(f.health.snapshot(p.id).status, "unavailable");
  f.health.close(); f.advance(); await f.health.runDue();
  const bad = fixture({ headers: async () => { throw new Error("Bearer fixture-secret https://private-host"); } }); bad.health.sync([p]); bad.health.verify(p);
  for (let i = 0; i < 3; i++) { bad.advance(); await bad.health.runDue(); }
  assert.equal(bad.health.snapshot(p.id).status, "unknown"); assert.equal(bad.health.snapshot(p.id).consecutiveFailures, 0); assert.equal(bad.calls(), 0);
  assert.doesNotMatch(JSON.stringify(bad.health.snapshots()), /fixture-secret|private-host/);
});

test("invalid or oversized model-list replies are inconclusive, and removed endpoints revoke verification", async () => {
  let reply = () => Response.json({ output: "not a model list" });
  const f = fixture({ fetch: async () => reply() }), p = provider(); f.health.sync([p]); f.health.verify(p);
  for (let i = 0; i < 4; i++) { f.advance(); await f.health.runDue(); }
  assert.equal(f.health.snapshot(p.id).status, "unknown"); assert.equal(f.health.snapshot(p.id).consecutiveFailures, 0);
  reply = () => new Response("x".repeat(256 * 1024 + 1)); f.advance(); await f.health.runDue(); assert.equal(f.health.snapshot(p.id).status, "unknown");
  reply = () => new Response(null, { status: 404 }); f.advance(); await f.health.runDue(); assert.equal(f.health.snapshot(p.id).verified, false);
});

test("stale evidence becomes unknown, and fake outage/recovery changes only preflight direct routing", async () => {
  const f = fixture(), p = provider(); f.health.sync([p]); f.health.verify(p); f.setMode(503);
  const input = { requestedModel: "p/m", fallbackModel: "backup/m", now: BASE_NOW, resolveModel: (name: string) => ({ providerId: name.split("/")[0]! }), healthOf: (id: string) => f.health.snapshot(id) };
  for (let i = 0; i < 3; i++) { f.advance(); await f.health.runDue(); }
  assert.equal(resolveAgentFallback(input).model, "backup/m");
  f.setMode(200); f.advance(); await f.health.runDue(); assert.equal(resolveAgentFallback(input).model, "p/m");
  f.advance(16 * 60_000); assert.equal(f.health.snapshot(p.id).status, "unknown"); assert.equal(f.health.snapshot(p.id).reason, "stale");
});
