import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";

async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "es-client-menu-api-")), store = new Store(dir), auth = new GatewayTokenAuthority();
  store.upsertProvider({ id: "p", name: "P", baseUrl: "https://never-connect.invalid/private", models: ["main", "org/deep/model", "last"], route: "chat-translate", routePinned: false, streamUsage: true, createdAt: "" });
  store.setBinding({ harness: "codex", providerId: "p", model: "main" });
  let secretReads = 0, discovery = 0;
  const server = createEasySwitchServer({ store, port: 0, gatewayAuth: auth, secrets: { async get() { secretReads++; assert.fail("menu never reads a key"); }, async set() { assert.fail("menu never writes a key"); }, async delete() { assert.fail("menu never removes a key"); } }, agentDetection: { detect: async () => { discovery++; assert.fail("menu never detects clients"); } } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); });
  const api = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = { "x-easyswitch": "1" }) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const q = request(`http://127.0.0.1:${(server.address() as any).port}${path}`, { method, headers }, r => { let data = ""; r.on("data", d => data += d); r.on("end", () => resolve({ status: r.statusCode!, body: JSON.parse(data) })); }); q.on("error", reject); q.end(body === undefined ? undefined : JSON.stringify(body));
  });
  t.after(() => { assert.equal(secretReads, 0); assert.equal(discovery, 0); });
  return { store, auth, api, path: "/api/agents/codex/model-menu", dir };
}

test("menu HTTP reads require local header/host, perform no discovery/auth and return exact public schema", async t => {
  const { api, path, auth } = await fixture(t);
  assert.equal((await api(path, "GET", undefined, {})).status, 403);
  assert.equal((await api(path, "GET", undefined, { "x-easyswitch": "1", host: "foreign.invalid" })).status, 421);
  const { status, body } = await api(path); assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), ["agentId", "baseGuard", "effectiveModelMenu", "entries", "modelMenu", "requiredRetained", "scope", "selectable", "warnings"].sort());
  assert.equal(body.modelMenu, null); assert.match(body.baseGuard, /^[a-f0-9]{64}$/); assert.equal(body.agentId, "codex");
  assert.doesNotMatch(JSON.stringify(body), /never-connect|private|baseUrl|token|credential/i); assert.equal(auth.list().length, 0);
  assert.equal((await api("/api/agents/unknown-fixture/model-menu")).status, 404);
  assert.equal((await api(`${path}/preview`)).status, 405);
  assert.equal((await api(path, "PUT", {})).status, 405);
});
test("HTTP requires base at preview, both guards at apply, strict null/all empty/custom distinction", async t => {
  const { api, path, store } = await fixture(t), initial = (await api(path)).body;
  const before = readFileSync(join(store.dir, "state.json"), "utf8");
  for (const body of [null, [], "text", {}, { baseGuard: initial.baseGuard }, { modelMenu: [] }, { modelMenu: [], baseGuard: "" }, { modelMenu: [], baseGuard: initial.baseGuard, extra: true }]) assert.equal((await api(`${path}/preview`, "POST", body)).status, 400);
  assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), before);
  for (const body of [{ modelMenu: [], baseGuard: initial.baseGuard }, { modelMenu: [], baseGuard: initial.baseGuard, previewGuard: null }]) assert.equal((await api(`${path}/apply`, "POST", body)).status, 400);
  const p = await api(`${path}/preview`, "POST", { modelMenu: [], baseGuard: initial.baseGuard }); assert.equal(p.status, 200); assert.deepEqual(p.body.before, null); assert.deepEqual(p.body.modelMenu, []);
  assert.deepEqual(p.body.requiredRetained, [{ id: "p/main", reasons: ["main"] }]);
  assert.equal(readFileSync(join(store.dir, "state.json"), "utf8"), before);
  const applied = await api(`${path}/apply`, "POST", { modelMenu: [], baseGuard: initial.baseGuard, previewGuard: p.body.previewGuard });
  assert.equal(applied.status, 200); assert.equal(applied.body.ok, true); assert.deepEqual(store.prefs("codex").modelMenu, []); assert.notEqual(applied.body.baseGuard, initial.baseGuard);
  const reset = await api(`${path}/preview`, "POST", { modelMenu: null, baseGuard: applied.body.baseGuard });
  assert.equal((await api(`${path}/apply`, "POST", { modelMenu: null, baseGuard: applied.body.baseGuard, previewGuard: reset.body.previewGuard })).status, 200);
  assert.equal(Object.hasOwn(store.prefs("codex"), "modelMenu"), false);
});
test("HTTP semantic validation bounds IDs and count, preserves slash suffix and rejects unavailable additions", async t => {
  const { api, path } = await fixture(t), baseGuard = (await api(path)).body.baseGuard;
  for (const modelMenu of [["p/main", "p/main"], ["p/m\n"], ["p/\u202e"], [" p/main"], ["p/" + "x".repeat(511)], ["gone/m"], [1], Array.from({ length: 81 }, (_, i) => `p/${i}`)]) {
    const r = await api(`${path}/preview`, "POST", { modelMenu, baseGuard }); assert.equal(r.status, 422, JSON.stringify(modelMenu)); assert.equal(r.body.code, "CLIENT_MODEL_MENU_INVALID");
  }
  const p = await api(`${path}/preview`, "POST", { modelMenu: ["p/org/deep/model", "p/main"], baseGuard }); assert.equal(p.status, 200); assert.deepEqual(p.body.modelMenu, ["p/org/deep/model", "p/main"]);
  assert.equal((await api(`${path}/apply`, "POST", { modelMenu: p.body.modelMenu, baseGuard, previewGuard: p.body.previewGuard })).status, 200);
});
test("HTTP rejects cross-tab stale/ABA, changed payload and replay, without changing other prefs", async t => {
  const { api, path, store } = await fixture(t); store.setPrefs("codex", { effort: "high", fallbackModel: "p/last" });
  const get = async () => { const v = (await api(path)).body; return (await api(`${path}/preview`, "POST", { modelMenu: ["p/last"], baseGuard: v.baseGuard })).body; };
  const old = await get(); store.setPrefs("codex", { effort: "low" }); store.setPrefs("codex", { effort: "high" });
  const apply = (p: any, menu = p.modelMenu) => api(`${path}/apply`, "POST", { modelMenu: menu, baseGuard: p.baseGuard, previewGuard: p.previewGuard });
  let r = await apply(old); assert.equal(r.status, 409); assert.equal(r.body.code, "CLIENT_MODEL_MENU_CONFLICT");
  const p = await get(); assert.equal((await apply(p, ["p/main"])).status, 409); assert.equal((await apply(p)).status, 200); assert.equal((await apply(p)).status, 409);
  assert.deepEqual(store.prefs("codex"), { effort: "high", fallbackModel: "p/last", modelMenu: ["p/last"] });
  assert.deepEqual(store.binding("codex"), { harness: "codex", providerId: "p", model: "main" });
});
test("HTTP persistence failure leaves guard retryable and exposes no raw storage error", async t => {
  const { api, path, store } = await fixture(t), get = (await api(path)).body, p = (await api(`${path}/preview`, "POST", { modelMenu: [], baseGuard: get.baseGuard })).body;
  const body = { modelMenu: [], baseGuard: get.baseGuard, previewGuard: p.previewGuard }, save = (store as any).save;
  (store as any).save = () => { throw new Error("synthetic private-disk-path"); };
  const failed = await api(`${path}/apply`, "POST", body); assert.equal(failed.status, 500); assert.doesNotMatch(JSON.stringify(failed.body), /private-disk-path/);
  assert.equal((await api(path)).body.baseGuard, get.baseGuard); (store as any).save = save;
  assert.equal((await api(`${path}/apply`, "POST", body)).status, 200);
});
test("menu selection is not a route/auth whitelist; global console/gateway catalogs stay unchanged", async t => {
  const { api, path, auth } = await fixture(t), globalBefore = (await api("/api/models")).body;
  const session = auth.issue("codex", { depth: 0, allowMcp: false, allowNativeClaude: false });
  const gatewayHeaders = { authorization: `Bearer ${session.token}` }, gatewayBefore = (await api("/v1/models", "GET", undefined, gatewayHeaders)).body;
  const get = (await api(path)).body, p = (await api(`${path}/preview`, "POST", { modelMenu: [], baseGuard: get.baseGuard })).body;
  assert.equal((await api(`${path}/apply`, "POST", { modelMenu: [], baseGuard: get.baseGuard, previewGuard: p.previewGuard })).status, 200);
  assert.deepEqual((await api("/api/models")).body, globalBefore); assert.deepEqual((await api("/v1/models", "GET", undefined, gatewayHeaders)).body, gatewayBefore);
  assert.equal((await api("/v1/models", "GET", undefined, {})).status, 401); assert.equal(auth.list().length, 1);
});

test("two concurrent HTTP confirmations commit once and preserve the winner", async t => {
  const { api, path, store } = await fixture(t), baseGuard = (await api(path)).body.baseGuard;
  const one = (await api(`${path}/preview`, "POST", { modelMenu: ["p/last"], baseGuard })).body;
  const two = (await api(`${path}/preview`, "POST", { modelMenu: ["p/main"], baseGuard })).body;
  const outcomes = await Promise.all([one, two].map(p => api(`${path}/apply`, "POST", { modelMenu: p.modelMenu, baseGuard, previewGuard: p.previewGuard })));
  assert.deepEqual(outcomes.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual(store.prefs("codex").modelMenu, outcomes.find(r => r.status === 200)!.body.modelMenu);
});
