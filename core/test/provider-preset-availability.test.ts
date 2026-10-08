import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { HYPERBOLIC_RETIRED, newProviderUnavailable, withPresetAvailability } from "../src/preset-availability.ts";
import { PRESETS } from "../src/presets.ts";
import { Store } from "../src/store.ts";
import { createEasySwitchServer } from "../src/server.ts";
import type { Provider, ProviderPreset } from "../src/types.ts";

test("retired service status decorates only Hyperbolic and retains the legacy preset unchanged", () => {
  const before = JSON.stringify(PRESETS);
  const decorated = PRESETS.map(withPresetAvailability);
  assert.equal(JSON.stringify(PRESETS), before);
  assert.deepEqual(decorated.filter(p => p.unavailable).map(p => p.id), ["hyperbolic"]);
  const retired = decorated.find(p => p.id === "hyperbolic")!;
  assert.equal(retired.baseUrl, "https://api.hyperbolic.xyz/v1");
  assert.deepEqual(Object.keys(retired.unavailable!).sort(), ["reason", "sourceUrl"]);
  assert.match(retired.unavailable!.reason, /已停用.*有效 Key.*无法调用/);
  assert.equal(retired.unavailable!.sourceUrl, "https://www.hyperbolic.ai/docs/faq/inference-models");
  retired.unavailable!.reason = "changed copy";
  assert.notEqual(withPresetAvailability(retired).unavailable!.reason, "changed copy");
  for (const p of decorated.filter(p => p.id !== "hyperbolic")) assert.equal(Object.hasOwn(p, "unavailable"), false);
});

test("new-provider preflight recognizes the retired preset and only the exact normalized old base", () => {
  for (const baseUrl of ["https://api.hyperbolic.xyz/v1", " https://API.HYPERBOLIC.XYZ:443/v1/// "]) {
    assert.equal(newProviderUnavailable({ baseUrl }), HYPERBOLIC_RETIRED);
  }
  assert.equal(newProviderUnavailable({ presetId: "hyperbolic", baseUrl: "http://127.0.0.1:1234/v1" }), HYPERBOLIC_RETIRED);
  for (const baseUrl of [undefined, 42, "not a URL", "https://api.hyperbolic.xyz/v2", "https://api.hyperbolic.xyz/custom/v1", "https://api.hyperbolic.xyz/v1?custom=1", "https://api.hyperbolic.xyz/v1#custom", "https://api.hyperbolic.xyz.evil.invalid/v1", "https://custom.invalid/v1", "http://127.0.0.1:1234/v1"]) {
    assert.equal(newProviderUnavailable({ baseUrl }), undefined, String(baseUrl));
  }
  assert.equal(newProviderUnavailable({ presetId: "relay", baseUrl: "https://custom.invalid/v1" }), undefined);
});

const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };

test("new-provider API rejects retirement before secrets, persistence, model reads or probes; saved providers are unchanged", async t => {
  const root = mkdtempSync(join(tmpdir(), "es-preset-retired-"));
  const store = new Store(root);
  for (const [id, baseUrl] of [["saved-retired", "https://api.hyperbolic.xyz/v1"], ["saved-custom", "https://api.hyperbolic.xyz/custom/v1"]]) {
    const provider: Provider = { id: id!, name: id!, baseUrl: baseUrl!, models: ["saved-model"], defaultModel: "saved-model", route: "chat-translate", routePinned: false, streamUsage: true, off: false, wire: { paths: { chat: "/custom-chat" } }, createdAt: "2026-10-01T00:00:00.000Z" };
    store.upsertProvider(provider);
  }
  const before = store.providers(), storedBytes = readFileSync(join(root, "state.json"), "utf8");
  let secretReads = 0, secretWrites = 0, secretDeletes = 0, upstreamRequests = 0, externalAttempts = 0;
  const guardedFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.hostname !== "127.0.0.1") { externalAttempts++; throw new Error("Unexpected non-fixture request"); }
    return guardedFetch(input, init);
  });
  const api = createEasySwitchServer({ store, port: 0, secrets: {
    get: async () => { secretReads++; return undefined; },
    set: async () => { secretWrites++; }, delete: async () => { secretDeletes++; },
  } });
  const upstream = createServer((_req, res) => { upstreamRequests++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); });
  t.after(async () => { await Promise.all([close(api), close(upstream)]); rmSync(root, { recursive: true, force: true }); });
  const apiBase = await listen(api), upstreamBase = await listen(upstream);
  const headers = { "x-easyswitch": "1", "content-type": "application/json" };
  const listed = await fetch(`${apiBase}/api/presets`, { headers });
  assert.equal(listed.status, 200);
  const available = await listed.json() as ProviderPreset[];
  assert.deepEqual(available, PRESETS.map(withPresetAvailability));
  assert.deepEqual(available.find(p => p.id === "hyperbolic")!.unavailable, HYPERBOLIC_RETIRED);
  const rejected: Array<{ path: string; body: Record<string, unknown> }> = [
    { path: "/api/providers", body: { name: "Retired fixture", baseUrl: `${upstreamBase}/v1`, presetId: "hyperbolic", apiKey: "sk-fixture-retired-secret" } },
    { path: "/api/providers", body: { name: "Private fixture", baseUrl: "https://private-fixture.invalid/custom", presetId: "hyperbolic", apiKey: "sk-fixture-retired-secret" } },
    { path: "/api/providers", body: { name: "Exact retired base", baseUrl: "https://api.hyperbolic.xyz/v1", apiKey: "sk-fixture-retired-secret" } },
    { path: "/api/providers", body: { name: "Normalized retired base", baseUrl: " https://API.HYPERBOLIC.XYZ:443/v1/// ", presetId: "relay", apiKey: "sk-fixture-retired-secret" } },
    { path: "/api/providers", body: { name: "Coerced retired base", baseUrl: ["https://api.hyperbolic.xyz/v1"], apiKey: "sk-fixture-retired-secret" } },
    { path: "/api/import", body: { name: "Retired pasted source", text: "https://api.hyperbolic.xyz/v1 sk-fixture-retired-secret" } },
  ];
  for (const { path, body } of rejected) {
    const response = await fetch(`${apiBase}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 409, path);
    const result = await response.json();
    assert.equal(result.code, "source_retired");
    assert.match(result.error, /已停用.*密钥有效.*本次新增和自动检测已停止/);
    assert.deepEqual(result.unavailable, HYPERBOLIC_RETIRED);
    assert.doesNotMatch(JSON.stringify(result), /sk-fixture|private-fixture/);
  }
  assert.deepEqual({ secretReads, secretWrites, secretDeletes, upstreamRequests, externalAttempts }, { secretReads: 0, secretWrites: 0, secretDeletes: 0, upstreamRequests: 0, externalAttempts: 0 });
  assert.deepEqual(store.providers(), before);
  assert.equal(readFileSync(join(root, "state.json"), "utf8"), storedBytes);
  const ordinary = await fetch(`${apiBase}/api/providers`, { method: "POST", headers, body: JSON.stringify({ name: "Ordinary fixture", baseUrl: `${upstreamBase}/v1`, presetId: "relay" }) });
  assert.equal(ordinary.status, 201);
  assert.equal(upstreamRequests, 1);
  assert.equal(externalAttempts, 0);
  assert.deepEqual(store.providers().slice(0, 2), before);
});

function ui() {
  const handlers: Record<string, Array<(event: any) => unknown>> = {};
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#providers" }, window: { addEventListener() {} }, history: { replaceState() {} }, console,
    document: { addEventListener(name: string, fn: (event: any) => unknown) { (handlers[name] ??= []).push(fn); }, querySelector: () => ({ innerHTML: "", textContent: "", className: "" }), querySelectorAll: () => [], activeElement: null },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {}, fetch() { throw new Error("No transport permitted in UI fixture"); },
    FormData: class { form: any; constructor(form: any) { this.form = form; } get(name: string) { return this.form.values[name]; } },
  });
  for (const file of ["errors.js", "onboarding.js"]) vm.runInContext(readFileSync(new URL(`../../web/${file}`, import.meta.url), "utf8"), context);
  const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(app.slice(0, app.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (source: string): any => vm.runInContext(source, context);
  run(`presets=${JSON.stringify(PRESETS.map(withPresetAvailability))}; state={providers:[],log:[]}; agentList=[]; addForm={preset:null}; globalThis.requests=[]; globalThis.renderCount=0;
    call=async(...args)=>{requests.push(args);return {};};render=()=>{renderCount++;};refresh=async()=>{};`);
  const dispatch = async (name: string, target: unknown) => {
    let stop = false;
    for (const handler of handlers[name] ?? []) { await handler({ target, preventDefault() {}, stopImmediatePropagation() { stop = true; } }); if (stop) break; }
  };
  const button = (selector: string, dataset: Record<string, string>) => { const target: any = { disabled: false, dataset, closest: (s: string) => s === selector ? target : null }; return target; };
  return { run, dispatch, button };
}

test("manual picker presents disabled retirement with accessible official guidance and blocks stale/repeated selection", async () => {
  const app = ui();
  app.run("presetQuery='Hyperbolic'");
  const html = app.run("presetGroups()") as string;
  assert.match(html, /data-preset="hyperbolic" disabled aria-describedby="preset-status-hyperbolic"/);
  assert.match(html, /id="preset-status-hyperbolic"/);
  assert.match(html, /已停用/);
  assert.match(html, /href="https:\/\/www\.hyperbolic\.ai\/docs\/faq\/inference-models" target="_blank" rel="noopener">官方停用说明/);
  const retired = app.button("[data-preset]", { preset: "hyperbolic" });
  await app.dispatch("click", retired); await app.dispatch("click", retired);
  assert.equal(app.run("addForm.preset"), null);
  app.run("addForm={preset:presets.find(p=>p.id==='hyperbolic')}");
  const stale = app.run("renderAddForm()") as string;
  assert.match(stale, /官方停用说明/); assert.doesNotMatch(stale, /name="apiKey"|type="submit"|添加并测试/);
  await app.run("submitAdd({})");
  assert.equal(app.run("requests.length"), 0);
  await app.dispatch("click", app.button("[data-cancel-add]", {}));
  assert.equal(app.run("addForm"), null);
  await app.dispatch("click", app.button("[data-preset]", { preset: "relay" }));
  assert.equal(app.run("addForm.preset.id"), "relay");
  assert.match(app.run("renderAddForm()"), /name="apiKey"/);
});

test("first-run options and injected stale submissions never create or probe retired presets", async () => {
  const app = ui();
  assert.equal(app.run("firstRunPresets().some(p=>p.id==='hyperbolic')"), false);
  app.run("firstRun.presetId='hyperbolic'");
  assert.doesNotMatch(app.run("firstRunCard()"), /value="hyperbolic"/);
  const target = { values: { presetId: "hyperbolic", apiKey: "fixture-only-key" }, matches: (s: string) => s === "[data-first-source]" };
  await app.dispatch("submit", target);
  assert.equal(app.run("requests.length"), 0);
  assert.equal(app.run("firstRun.providerId"), "");
});

test("retirement explanations escape text and reject non-HTTPS notice links", () => {
  const app = ui();
  const html = app.run(`presetUnavailableNotice({id:'bad',name:'<script>fixture</script>',unavailable:{reason:'<img onerror=fixture>',sourceUrl:'javascript:fixture'}})`) as string;
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;img onerror=fixture&gt;/);
  assert.doesNotMatch(html, /<script>|<img|href=|javascript:/);
});
