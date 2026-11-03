import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AGENTS, AGENT_DETECTION_ERROR, type AgentDetectionState, type DetectedAgent } from "../src/agents.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

function detected(id: string, detection: AgentDetectionState): DetectedAgent {
  const agent = AGENTS.find(a => a.id === id); assert.ok(agent);
  return { ...agent, detection, installed: detection === "found", ...(detection === "found" ? { where: `/fixture/never-run-${id}` } : {}), ...(detection === "error" ? { detectionError: AGENT_DETECTION_ERROR } : {}) };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(t: TestContext, detect: () => Promise<DetectedAgent[]>, now?: () => number) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-agents-api-"));
  const store = new Store(dir), auth = new GatewayTokenAuthority();
  store.setSettings({ claudeNative: false });
  const counts = { secrets: 0, clients: 0, open: 0, requests: 0 };
  const denied = (kind: "secrets" | "clients" | "open"): never => { counts[kind]++; assert.fail(`installation metadata must not use ${kind}`); };
  const server = createEasySwitchServer({ store, port: 0, gatewayAuth: auth,
    agentDetection: { detect, ...(now ? { now } : {}) },
    secrets: { get: async () => denied("secrets"), set: async () => denied("secrets"), delete: async () => denied("secrets") },
    openUrl: async () => denied("open"),
    interactiveRuntime: { findBinary: async () => denied("clients"), newSessionDir: () => denied("clients"), launchInTerminal: async () => denied("clients") },
  });
  const waiters: Array<{ count: number; done: () => void }> = [];
  server.on("request", () => { counts.requests++; for (const waiter of waiters) if (counts.requests >= waiter.count) waiter.done(); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); });
  const http = (path: string, method = "GET", body?: unknown, header = true) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request(base + path, { method, headers: header ? { "x-easyswitch": "1" } : {} }, res => { let text = ""; res.on("data", part => text += part); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) })); });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { store, auth, counts, http, waitForRequests: (count: number) => counts.requests >= count ? Promise.resolve() : new Promise<void>(done => waiters.push({ count, done })) };
}

test("agent listing preserves explicit states and never probes help, launches, reads keys or issues tokens", async t => {
  let scans = 0;
  const f = await fixture(t, async () => { scans++; return [detected("codex", "found"), detected("claude", "found"), detected("hermes", "found"), detected("aider", "not_found"), detected("opencode", "error")]; });
  assert.equal((await f.http("/api/agents", "GET", undefined, false)).status, 403); assert.equal(scans, 0);
  const result = await f.http("/api/agents"); assert.equal(result.status, 200); assert.equal(scans, 1);
  assert.deepEqual(result.body.agents.map((a: any) => [a.id, a.detection, a.installed]), [["codex", "found", true], ["claude", "found", true], ["hermes", "found", true], ["aider", "not_found", false], ["opencode", "error", false]]);
  assert.equal(result.body.agents.at(-1).where, undefined); assert.equal(result.body.agents.at(-1).detectionError, AGENT_DETECTION_ERROR);
  assert.ok(result.body.agents[0].can); assert.ok(result.body.agents[0].caps); assert.ok(result.body.coverage); assert.ok(result.body.features);
  assert.deepEqual({ secrets: f.counts.secrets, clients: f.counts.clients, open: f.counts.open, tokens: f.auth.list().length }, { secrets: 0, clients: 0, open: 0, tokens: 0 });
});

test("normal listing reuses the 30-second cache and explicit refresh bypasses it immediately", async t => {
  let scans = 0, now = 1_000;
  const f = await fixture(t, async () => { scans++; return [detected("aider", scans === 1 ? "not_found" : "found")]; }, () => now);
  assert.equal((await f.http("/api/agents")).body.agents[0].detection, "not_found");
  now += 10;
  assert.equal((await f.http("/api/agents")).body.agents[0].detection, "not_found"); assert.equal(scans, 1);
  assert.equal((await f.http("/api/agents?refresh=1")).body.agents[0].detection, "found"); assert.equal(scans, 2);
  await f.http("/api/agents?refresh=0"); await f.http("/api/agents?refresh=true"); assert.equal(scans, 2);
  now += 30_001; await f.http("/api/agents"); assert.equal(scans, 3);
});

test("simultaneous reloads share a scan and ordinary reads wait for its new result", async t => {
  let scans = 0;
  const pending = deferred<DetectedAgent[]>();
  const f = await fixture(t, async () => { scans++; return scans === 1 ? [detected("aider", "not_found")] : pending.promise; });
  await f.http("/api/agents");
  const reads = [f.http("/api/agents?refresh=1"), f.http("/api/agents?refresh=1"), f.http("/api/agents")];
  await f.waitForRequests(4); assert.equal(scans, 2);
  pending.resolve([detected("aider", "found")]);
  const results = await Promise.all(reads); assert.ok(results.every(r => r.body.agents[0].detection === "found"));
  await f.http("/api/agents"); assert.equal(scans, 2);
});

test("each server owns its own detection cache and cannot borrow another instance's installed path", async t => {
  let scansA = 0, scansB = 0;
  const a = await fixture(t, async () => { scansA++; return [detected("aider", "found")]; });
  const b = await fixture(t, async () => { scansB++; return [detected("aider", "not_found")]; });
  assert.equal((await a.http("/api/agents")).body.agents[0].installed, true);
  assert.equal((await b.http("/api/agents")).body.agents[0].installed, false);
  assert.deepEqual([scansA, scansB], [1, 1]);
});

test("a rejected refresh clears the old installed cache and returns only a safe error", async t => {
  let scans = 0;
  const f = await fixture(t, async () => { scans++; if (scans === 2) throw new Error("PRIVATE filesystem /Users/private/token secret"); return [detected("aider", scans === 1 ? "found" : "not_found")]; });
  assert.equal((await f.http("/api/agents")).body.agents[0].installed, true);
  const failure = await f.http("/api/agents?refresh=1"); assert.equal(failure.status, 500); assert.doesNotMatch(JSON.stringify(failure.body), /PRIVATE|Users\/private|token secret/);
  assert.equal((await f.http("/api/agents")).body.agents[0].installed, false); assert.equal(scans, 3);
});

test("inconclusive detection cannot become a missing-program diagnosis or open a client", async t => {
  const f = await fixture(t, async () => [detected("aider", "error")]);
  await f.http("/api/agents");
  const doctor = await f.http("/api/doctor");
  assert.equal(doctor.status, 200); assert.ok(!doctor.body.findings.some((x: any) => x.targetId === "aider" && x.code === "agent_not_installed"));
  const opened = await f.http("/api/agents/aider/open", "POST", {}); assert.equal(opened.status, 404);
  assert.equal(f.counts.clients, 0); assert.equal(f.counts.open, 0); assert.equal(f.auth.list().length, 0);
});

test("an invalidated old scan cannot overwrite a newer cached result", async t => {
  const old = deferred<DetectedAgent[]>(), fresh = deferred<DetectedAgent[]>(); let scans = 0;
  const f = await fixture(t, async () => { scans++; return scans === 1 ? old.promise : fresh.promise; });
  f.store.upsertProvider({ id: "plan", name: "Fixture plan", baseUrl: "http://127.0.0.1:1", models: [], route: "chat-translate", routePinned: false, streamUsage: false, createdAt: "", plan: { kind: "codex", accountId: "fixture-account" } });
  const earlier = f.http("/api/agents"); await f.waitForRequests(1); assert.equal(scans, 1);
  assert.equal((await f.http("/api/plan/fixture-account/switch", "PUT", { on: false })).status, 200);
  const later = f.http("/api/agents?refresh=1"); await f.waitForRequests(3); assert.equal(scans, 2);
  fresh.resolve([detected("aider", "not_found")]); assert.equal((await later).body.agents[0].installed, false);
  old.resolve([detected("aider", "found")]); await earlier;
  assert.equal((await f.http("/api/agents")).body.agents[0].installed, false); assert.equal(scans, 2);
});
