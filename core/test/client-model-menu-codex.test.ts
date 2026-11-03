import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request } from "node:http";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { writeCodexCatalog } from "../src/catalog.ts";

type Json = Record<string, any>;
const native = [{ slug: "native-fixture", visibility: "list", tool_mode: null, base_instructions: "synthetic template only", context_window: 1000 }];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: any, hook: { template?: (store: Store) => Promise<Record<string, unknown>[] | undefined>; find?: (store: Store) => Promise<string | undefined>; terminal?: () => Promise<void> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "es-client-menu-codex-")), store = new Store(dir), auth = new GatewayTokenAuthority(), sessions: string[] = [];
  store.upsertProvider({ id: "p", name: "P", baseUrl: "https://never-connect.invalid", models: ["main", "org/deep/model", "last"], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "", modelEfforts: { "main": ["high"], "last": ["low", "high"], "manual/child": ["high"] } });
  store.setBinding({ harness: "codex", providerId: "p", model: "main" });
  store.setPrefs("codex", { effort: "high", tiers: { subagent: "p/manual/child" }, modelMenu: ["p/last", "p/org/deep/model"] });
  const shared = join(dir, "codex-catalog.json"); writeFileSync(shared, "desktop-shared-sentinel");
  let templateReads = 0, terminalCalls = 0, secretReads = 0;
  const server = createEasySwitchServer({ store, port: 0, gatewayAuth: auth, secrets: { async get() { secretReads++; assert.fail("no keys read for launch preparation"); }, async set() { assert.fail("no key writes"); }, async delete() { assert.fail("no key deletes"); } }, interactiveRuntime: {
    findBinary: async () => hook.find ? hook.find(store) : "/fixture/never-run-codex",
    newSessionDir: () => { const path = mkdtempSync(join(dir, "session-")); sessions.push(path); return path; },
    readCodexCatalog: async (bin, stateDir) => { templateReads++; assert.equal(bin, "/fixture/never-run-codex"); assert.equal(stateDir, dir); return hook.template ? hook.template(store) : structuredClone(native); },
    launchInTerminal: async () => { terminalCalls++; if (hook.terminal) await hook.terminal(); else assert.fail("command-only preparation never starts a client"); },
  } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); assert.equal(secretReads, 0); assert.equal(readFileSync(shared, "utf8"), "desktop-shared-sentinel"); rmSync(dir, { recursive: true, force: true }); });
  const api = (path: string, body: unknown = {}) => new Promise<{ status: number; body: Json }>((resolve, reject) => { const q = request(`http://127.0.0.1:${(server.address() as any).port}${path}`, { method: "POST", headers: { "x-easyswitch": "1" } }, r => { let text = ""; r.on("data", d => text += d); r.on("end", () => resolve({ status: r.statusCode!, body: JSON.parse(text) })); }); q.on("error", reject); q.end(JSON.stringify(body)); });
  return { store, dir, auth, sessions, api, launch: (body: unknown = {}) => api("/api/agents/codex/command", body), templateReads: () => templateReads, terminalCalls: () => terminalCalls };
}
function catalogOf(command: Json) {
  const option = (command.args as string[]).find(arg => arg.startsWith("model_catalog_json=")); assert.ok(option);
  const file = JSON.parse(option.slice("model_catalog_json=".length));
  return { file: file as string, models: JSON.parse(readFileSync(file, "utf8")).models as Json[] };
}

test("next Codex command uses private ordered catalog and discloses required main/tiers without shared overwrite", async t => {
  const f = await fixture(t), before = { providers: f.store.providers(), binding: f.store.binding("codex"), prefs: f.store.prefs("codex"), global: f.store.catalog() };
  const made = await f.launch(); assert.equal(made.status, 200, JSON.stringify(made.body));
  const { file, models } = catalogOf(made.body); assert.equal(dirname(file), made.body.sessionDir); assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(made.body.sessionDir).mode & 0o777, 0o700);
  assert.deepEqual(models.map(m => m.slug), ["p/last", "p/org/deep/model", "p/main", "p/manual/child"]);
  assert.deepEqual(models.map(m => m.priority), [1, 2, 3, 4]); assert.ok(models.every(m => m.base_instructions === "synthetic template only" && m.visibility === "list"));
  assert.deepEqual(made.body.modelMenu.requiredRetained, [{ id: "p/main", reasons: ["main"] }, { id: "p/manual/child", reasons: ["tier:subagent"] }]);
  assert.deepEqual(made.body.modelMenu.effectiveModelMenu, models.map(m => m.slug)); assert.equal(made.body.model, "p/main");
  assert.ok(made.body.args.includes('agents.default_subagent_model="p/manual/child"')); assert.ok(made.body.args.includes('model_reasoning_effort="high"'));
  assert.deepEqual({ providers: f.store.providers(), binding: f.store.binding("codex"), prefs: f.store.prefs("codex"), global: f.store.catalog() }, before);
  assert.equal(f.auth.list().length, 1); assert.equal(f.templateReads(), 1); assert.equal(f.terminalCalls(), 0); assert.doesNotMatch(readFileSync(file, "utf8"), /es-session-/);
});
test("simultaneous sessions have separate immutable catalogs and later menu edits affect only new launches", async t => {
  const f = await fixture(t), [one, two] = await Promise.all([f.launch(), f.launch()]);
  assert.equal(one.status, 200); assert.equal(two.status, 200); const a = catalogOf(one.body), b = catalogOf(two.body); assert.notEqual(a.file, b.file);
  const before = readFileSync(a.file, "utf8"); f.store.setPrefs("codex", { modelMenu: [] });
  const three = await f.launch(); assert.equal(three.status, 200); assert.deepEqual(catalogOf(three.body).models.map(m => m.slug), ["p/main", "p/manual/child"]);
  assert.equal(readFileSync(a.file, "utf8"), before); assert.equal(readFileSync(b.file, "utf8"), before); assert.equal(f.auth.list().length, 3);
});
test("all/null keeps global catalog order; custom empty still includes valid required models, invalid refs are skipped", async t => {
  const f = await fixture(t); f.store.setPrefs("codex", { modelMenu: null });
  const all = await f.launch(); assert.equal(all.status, 200); assert.deepEqual(catalogOf(all.body).models.map(m => m.slug), f.store.catalog().map(m => `${m.providerId}/${m.model}`));
  assert.equal(all.body.modelMenu.modelMenu, null); assert.deepEqual(all.body.modelMenu.requiredRetained, []);
  f.store.setPrefs("codex", { modelMenu: ["gone/m", "p/last"] }); const custom = await f.launch(); assert.equal(custom.status, 200);
  assert.deepEqual(catalogOf(custom.body).models.map(m => m.slug), ["p/last", "p/main", "p/manual/child"]); assert.equal(custom.body.modelMenu.entries[0].selectable, false);
});
test("explicit launch model override is retained/disclosed without rewriting saved main model", async t => {
  const f = await fixture(t), made = await f.launch({ model: "p/manual/override" }); assert.equal(made.status, 200);
  assert.deepEqual(catalogOf(made.body).models.map(m => m.slug), ["p/last", "p/org/deep/model", "p/manual/override", "p/manual/child"]);
  assert.deepEqual(made.body.modelMenu.requiredRetained[0], { id: "p/manual/override", reasons: ["main"] }); assert.equal(f.store.binding("codex")!.model, "main");
});
for (const mutate of ["prefs", "binding", "provider", "pool", "profile"] as const) test(`async Codex template rejects ${mutate} ABA and cleans its token and session catalog`, async t => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture(t, { template: async () => { entered.resolve(); await release.promise; return structuredClone(native); } });
  const pending = f.launch(); await entered.promise; assert.equal(f.auth.list().length, 1); assert.equal(f.sessions.length, 1);
  if (mutate === "prefs") { f.store.setPrefs("codex", { effort: "low" }); f.store.setPrefs("codex", { effort: "high" }); }
  if (mutate === "binding") { f.store.clearBinding("codex"); f.store.setBinding({ harness: "codex", providerId: "p", model: "main" }); }
  if (mutate === "provider") { const p = f.store.provider("p")!; f.store.upsertProvider({ ...p, off: true }); f.store.upsertProvider(p); }
  if (mutate === "pool") { f.store.upsertPool({ id: "temp", name: "temp", strategy: "order", members: ["p/main"], createdAt: "" }); f.store.removePool("temp"); }
  if (mutate === "profile") { const p = f.store.saveProfile("temp"); f.store.removeProfile(p.id); }
  release.resolve(); const made = await pending;
  assert.equal(made.status, 409, JSON.stringify(made.body)); assert.equal(made.body.code, "CLIENT_MODEL_MENU_CONFLICT"); assert.equal(made.body.command, undefined);
  assert.equal(f.auth.list().length, 0); assert.ok(f.sessions.every(dir => !existsSync(dir))); assert.equal(f.terminalCalls(), 0);
});
test("binary lookup configuration race rejects before issuing token or creating private files", async t => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture(t, { find: async () => { entered.resolve(); await release.promise; return "/fixture/never-run-codex"; } });
  const pending = f.launch(); await entered.promise; f.store.setPrefs("codex", { modelMenu: [] }); release.resolve();
  const made = await pending; assert.equal(made.status, 409); assert.equal(made.body.code, "CLIENT_MODEL_MENU_CONFLICT"); assert.equal(f.templateReads(), 0); assert.equal(f.auth.list().length, 0); assert.deepEqual(f.sessions, []);
});
for (const missing of [undefined, []]) test(`missing ${missing === undefined ? "native" : "model"} Codex template fails closed and revokes token`, async t => {
  const f = await fixture(t, { template: async () => missing }); const made = await f.launch();
  assert.equal(made.status, 409, JSON.stringify(made.body)); assert.equal(made.body.code, "CODEX_MODEL_CATALOG_UNAVAILABLE"); assert.equal(made.body.command, undefined); assert.equal(f.auth.list().length, 0);
  assert.ok(f.sessions.every(dir => !existsSync(dir))); assert.equal(f.terminalCalls(), 0);
});
test("template exception and terminal failure clean token and every generated private file", async t => {
  const failTemplate = await fixture(t, { template: async () => { throw new Error("synthetic template failure"); } });
  assert.equal((await failTemplate.launch()).status, 500); assert.equal(failTemplate.auth.list().length, 0); assert.ok(failTemplate.sessions.every(dir => !existsSync(dir)));
  const failTerminal = await fixture(t, { terminal: async () => { throw new Error("synthetic terminal failure"); } });
  assert.equal((await failTerminal.api("/api/agents/codex/launch")).status, 500); assert.equal(failTerminal.auth.list().length, 0); assert.ok(failTerminal.sessions.every(dir => !existsSync(dir))); assert.equal(failTerminal.terminalCalls(), 1);
});
test("other client custom preference remains console-only, never changes generated OpenCode models", async t => {
  const f = await fixture(t); f.store.setPrefs("opencode", { modelMenu: [] });
  const made = await f.api("/api/agents/opencode/command", { model: "p/main" }); assert.equal(made.status, 200);
  const config = JSON.parse(made.body.env.OPENCODE_CONFIG_CONTENT); assert.deepEqual(Object.keys(config.provider.easyswitch.models), ["p/main", "p/org/deep/model", "p/last"]);
  assert.equal(f.templateReads(), 0); assert.equal(made.body.modelMenu, undefined);
});
test("catalog writer default destination and desktop native inclusion retain their previous contract", async t => {
  const dir = mkdtempSync(join(tmpdir(), "es-menu-catalog-writer-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const models = [{ providerId: "p", providerName: "P", model: "m", efforts: [] }];
  const file = await writeCodexCatalog("/fixture/never-run", dir, [], { includeNative: true, models, loadNative: async () => structuredClone(native) });
  assert.equal(file, join(dir, "codex-catalog.json")); assert.deepEqual(JSON.parse(readFileSync(file!, "utf8")).models.map((m: Json) => m.slug), ["native-fixture", "p/m"]);
  assert.deepEqual(readdirSync(dir), ["codex-catalog.json"]);
});

test("legacy all-model mode may still prepare Codex without a template and claims no generated custom menu", async t => {
  const f = await fixture(t, { template: async () => undefined }); f.store.setPrefs("codex", { modelMenu: null });
  const made = await f.launch(); assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.modelMenu, undefined); assert.equal(made.body.args.some((a: string) => a.startsWith("model_catalog_json=")), false);
  assert.equal(f.auth.list().length, 1); assert.deepEqual(readdirSync(made.body.sessionDir), []); assert.equal(f.terminalCalls(), 0);
});
test("custom Codex menu refuses unsafe legacy required main or tier instead of silently omitting it", async t => {
  for (const kind of ["main", "tier"]) {
    const f = await fixture(t), unsafe = "p/" + "x".repeat(511);
    if (kind === "main") f.store.setBinding({ harness: "codex", providerId: "p", model: unsafe.slice(2) });
    else f.store.setPrefs("codex", { tiers: { subagent: unsafe } });
    const made = await f.launch(); assert.equal(made.status, 422); assert.equal(made.body.code, "CLIENT_MODEL_MENU_INVALID");
    assert.equal(f.auth.list().length, 0); assert.equal(f.templateReads(), 0); assert.deepEqual(f.sessions, []);
  }
});
