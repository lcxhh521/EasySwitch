import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Ledger } from "../src/ledger.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { resolveModel } from "../src/gateway.ts";

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "es-model-selection-")), store = new Store(dir), ledger = new Ledger(dir), auth = new GatewayTokenAuthority();
  const counts = { secrets: 0, probes: 0, clients: 0, issued: 0 };
  const forbidden = (key: keyof typeof counts): never => { counts[key]++; assert.fail(`Selection must not use ${key}`); };
  auth.issue = () => forbidden("issued");
  for (const id of ["old", "on", "off", "budget", "droid", "qoder"]) store.upsertProvider({ id, name: id, baseUrl: "http://127.0.0.1:1/v1", models: ["m", "vendor/model"], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "", ...(id === "off" ? { off: true } : {}), ...(id === "budget" ? { budget: { monthlyUsd: 1, stop: true } } : {}), ...(id === "droid" ? { cliTextBridge: { kind: "droid" as const } } : {}), ...(id === "qoder" ? { cliTextBridge: { kind: "qoder" as const, binary: "/fixture/qoder" } } : {}) });
  for (const [id, members] of Object.entries({ empty: [], off: ["off/m"], blocked: ["budget/m"], unsupported: ["droid/m"], missing: ["missing/m"], mixed: ["off/m", "budget/m", "on/vendor/model"] })) store.upsertPool({ id, name: id, members, strategy: "order", createdAt: "" });
  ledger.append({ at: new Date().toISOString(), providerId: "budget", model: "budget/m", route: "chat-translate", status: 200, ms: 1, costUsd: 2 });
  store.setBinding({ harness: "claude", providerId: "old", model: "m" });
  store.setPrefs("claude", { tiers: { small: "off/m" }, fallbackModel: "budget/m" });
  const server = createEasySwitchServer({ store, ledger, port: 0, gatewayAuth: auth,
    secrets: { get: async () => forbidden("secrets"), set: async () => forbidden("secrets"), delete: async () => forbidden("secrets") },
    sourceHealth: { fetch: async () => forbidden("probes") },
    interactiveRuntime: { findBinary: async () => forbidden("clients"), newSessionDir: () => forbidden("clients"), launchInTerminal: async () => forbidden("clients") },
    taskRunner: async () => forbidden("clients"),
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = async (path: string, body?: unknown, method = "PUT", consoleHeader = true) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(consoleHeader ? { "x-easyswitch": "1" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  };
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); assert.deepEqual(counts, { secrets: 0, probes: 0, clients: 0, issued: 0 }); });
  return { store, ledger, dir, api };
}

test("main binding rejects closed, budget-blocked and unsupported sources without changing saved state", async t => {
  const f = await fixture(t), before = readFileSync(join(f.dir, "state.json"), "utf8");
  for (const [providerId, code] of [["off", "source_disabled"], ["budget", "budget_blocked"], ["droid", "capability_unavailable"]] as const) {
    const result = await f.api("/api/bindings/claude", { providerId, model: "m" });
    assert.equal(result.status, 409); assert.equal(result.body.uiError.code, code); assert.ok(result.body.uiError.action.label);
    assert.deepEqual(f.store.binding("claude"), { harness: "claude", providerId: "old", model: "m" });
    assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
  }
});

test("empty pools are rejected while a pool with one selectable member remains selectable", async t => {
  const f = await fixture(t);
  for (const model of ["empty", "off", "blocked", "unsupported", "missing"]) {
    const before = readFileSync(join(f.dir, "state.json"), "utf8");
    const result = await f.api("/api/bindings/claude", { providerId: "pool", model });
    assert.equal(result.status, 409); assert.equal(result.body.uiError.code, "model_unavailable");
    assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
  }
  assert.equal((await f.api("/api/bindings/claude", { providerId: "pool", model: "mixed" })).status, 200);
  assert.equal(f.store.binding("claude")!.providerId, "pool");
});

test("main binding keeps malformed pool selectors rejected without replacing the binding", async t => {
  const f = await fixture(t), before = readFileSync(join(f.dir, "state.json"), "utf8");
  for (const providerId of [["pool"], [["pool"]]]) {
    const result = await f.api("/api/bindings/claude", { providerId, model: "mixed" });
    assert.equal(result.status, 400); assert.equal(result.body.uiError.code, "invalid_input");
    assert.deepEqual(f.store.binding("claude"), { harness: "claude", providerId: "old", model: "m" });
    assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
  }
  assert.equal((await f.api("/api/bindings/claude", { providerId: "pool", model: "mixed" })).status, 200);
});

test("stale selection is checked at save time and becomes selectable after explicit reopening", async t => {
  const f = await fixture(t);
  assert.ok(f.store.catalog().some(m => m.providerId === "on"));
  f.store.upsertProvider({ ...f.store.provider("on")!, off: true });
  assert.equal((await f.api("/api/bindings/claude", { providerId: "on", model: "m" })).status, 409);
  assert.equal(f.store.binding("claude")!.providerId, "old");
  assert.equal((await f.api("/api/bindings/claude", { providerId: "pool", model: "mixed" })).status, 409);
  f.store.upsertProvider({ ...f.store.provider("on")!, off: false });
  assert.equal((await f.api("/api/bindings/claude", { providerId: "on", model: "m" })).status, 200);
  assert.equal((await f.api("/api/bindings/claude", { providerId: "qoder", model: "m" })).status, 200);
});

test("main binding retains explicit upstream IDs and does not require a successful health check", async t => {
  const f = await fixture(t);
  for (const model of ["vendor/model", "unlisted/upstream-id"]) {
    assert.equal((await f.api("/api/bindings/claude", { providerId: "on", model })).status, 200);
    assert.equal(f.store.binding("claude")!.model, model);
    assert.equal(resolveModel(f.store, `on/${model}`)?.model, model);
  }
  assert.equal((await f.api("/api/bindings/claude", { providerId: "on", model: "m" }, "PUT", false)).status, 403);
  assert.equal((await f.api("/api/bindings/claude", { providerId: "missing", model: "m" })).status, 400);
});

test("a source budget reached after catalog loading rejects the later save without replacing the binding", async t => {
  const f = await fixture(t);
  f.store.upsertProvider({ ...f.store.provider("on")!, budget: { monthlyUsd: 1, stop: true } });
  assert.ok(f.store.catalog().some(m => m.providerId === "on"));
  f.ledger.append({ at: new Date().toISOString(), providerId: "on", model: "on/m", route: "chat-translate", status: 200, ms: 1, costUsd: 2 });
  const before = readFileSync(join(f.dir, "state.json"), "utf8");
  const result = await f.api("/api/bindings/claude", { providerId: "on", model: "m" });
  assert.equal(result.status, 409); assert.equal(result.body.uiError.code, "budget_blocked");
  assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
});

test("tier and fallback rejection preserve saved values and only explicit clear changes them", async t => {
  const f = await fixture(t), before = f.store.prefs("claude");
  for (const providerId of ["off", "budget", "droid"]) {
    assert.equal((await f.api("/api/bindings/claude/tiers/small", { providerId, model: "m" })).status, 400);
    assert.equal((await f.api("/api/bindings/claude/fallback", { model: `${providerId}/m` })).status, 400);
    assert.deepEqual(f.store.prefs("claude"), before);
  }
  assert.equal((await f.api("/api/bindings/claude/fallback", { model: "pool/mixed" })).status, 400);
  assert.equal((await f.api("/api/bindings/claude", undefined, "DELETE")).status, 200);
  assert.deepEqual(f.store.prefs("claude"), before);
  assert.equal((await f.api("/api/bindings/claude/tiers/small", undefined, "DELETE")).status, 200);
  assert.equal((await f.api("/api/bindings/claude/fallback", { model: "" })).status, 200);
  assert.deepEqual(f.store.prefs("claude"), {});
});

const ruleDraft = (model?: string) => ({ name: "选择模型", enabled: true, when: { anyWords: ["test"] }, then: { agent: "claude", ...(model === undefined ? {} : { model }) } });

test("new and changed rule targets reject unavailable sources before changing rules, IDs or order", async t => {
  const f = await fixture(t);
  const first = f.store.addRule({ ...ruleDraft(), name: "first" });
  const saved = f.store.addRule(ruleDraft("old/m"));
  const last = f.store.addRule({ ...ruleDraft(), name: "last" });
  const before = readFileSync(join(f.dir, "state.json"), "utf8"), rules = f.store.rules();
  for (const [target, status, code, uiCode] of [
    ["missing/m", 400, "invalid_input", "invalid_input"],
    ["on", 400, "invalid_input", "invalid_input"],
    ["on/", 400, "invalid_input", "invalid_input"],
    ["/m", 400, "invalid_input", "invalid_input"],
    ["off/m", 409, "provider_disabled", "source_disabled"],
    ["budget/m", 409, "provider_budget_exceeded", "budget_blocked"],
    ["droid/m", 409, "capability_unavailable", "capability_unavailable"],
  ] as const) {
    for (const method of ["POST", "PUT"]) {
      for (const enabled of [true, false]) {
        const result = await f.api(method === "POST" ? "/api/rules" : `/api/rules/${saved.id}`, { ...ruleDraft(target), name: "must not replace", enabled }, method);
        assert.equal(result.status, status, `${method} ${target}`);
        assert.equal(result.body.code, code); assert.equal(result.body.uiError.code, uiCode); assert.ok(result.body.uiError.action.label);
        assert.deepEqual(f.store.rules(), rules);
        assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
      }
    }
  }
  const listed = await f.api("/api/rules", undefined, "GET");
  assert.equal(listed.status, 200); assert.deepEqual(listed.body.rules.map((r: { id: string }) => r.id), [first.id, saved.id, last.id]);
});

test("rule targets are rechecked after a source closes or reaches its budget after selection", async t => {
  const f = await fixture(t);
  f.store.upsertProvider({ ...f.store.provider("on")!, budget: { monthlyUsd: 1, stop: true } });
  const saved = f.store.addRule(ruleDraft("on/m"));
  assert.ok(f.store.catalog().some(m => m.providerId === "on"));
  f.store.upsertProvider({ ...f.store.provider("on")!, off: true });
  for (const expectedCode of ["source_disabled", "budget_blocked"]) {
    const before = readFileSync(join(f.dir, "state.json"), "utf8"), rules = f.store.rules();
    const created = await f.api("/api/rules", ruleDraft("on/m"), "POST");
    const changed = await f.api(`/api/rules/${saved.id}`, ruleDraft("on/another/model"));
    for (const result of [created, changed]) { assert.equal(result.status, 409); assert.equal(result.body.uiError.code, expectedCode); }
    assert.deepEqual(f.store.rules(), rules); assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
    if (expectedCode === "source_disabled") {
      f.store.upsertProvider({ ...f.store.provider("on")!, off: false });
      assert.ok(f.store.catalog().some(m => m.providerId === "on"));
      f.ledger.append({ at: new Date().toISOString(), providerId: "on", model: "on/m", route: "chat-translate", status: 200, ms: 1, costUsd: 2 });
    }
  }
});

test("rule pool targets require one selectable member and accept a mixed pool", async t => {
  const f = await fixture(t), saved = f.store.addRule(ruleDraft("old/m"));
  f.store.upsertPool({ id: "unlisted", name: "unlisted", members: ["on/unlisted/upstream"], strategy: "order", createdAt: "" });
  for (const pool of ["empty", "off", "blocked", "unsupported", "missing", "unlisted", "not-a-pool"]) {
    const before = readFileSync(join(f.dir, "state.json"), "utf8"), rules = f.store.rules();
    for (const method of ["POST", "PUT"]) {
      const result = await f.api(method === "POST" ? "/api/rules" : `/api/rules/${saved.id}`, ruleDraft(`pool/${pool}`), method);
      assert.equal(result.status, pool === "not-a-pool" ? 400 : 409);
      assert.equal(result.body.uiError.code, pool === "not-a-pool" ? "invalid_input" : "model_unavailable");
      if (pool !== "not-a-pool") assert.equal(result.body.code, "model_not_found");
      assert.deepEqual(f.store.rules(), rules); assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
    }
  }
  const created = await f.api("/api/rules", ruleDraft("pool/mixed"), "POST");
  assert.equal(created.status, 201); assert.equal(created.body.then.model, "pool/mixed");
  const changed = await f.api(`/api/rules/${saved.id}`, ruleDraft("pool/mixed"));
  assert.equal(changed.status, 200); assert.equal(changed.body.id, saved.id); assert.equal(changed.body.then.model, "pool/mixed");
  // The last allowed pool member can disappear between opening the picker and saving.
  f.store.upsertProvider({ ...f.store.provider("on")!, off: true });
  const before = readFileSync(join(f.dir, "state.json"), "utf8");
  assert.equal((await f.api("/api/rules", ruleDraft("pool/mixed"), "POST")).status, 409);
  assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
});

test("rule saves accept usable sources with unknown health and preserve unlisted slash-containing model IDs", async t => {
  const f = await fixture(t);
  for (const target of ["on/vendor/model", "on/unlisted/vendor/model", "qoder/unlisted/model"]) {
    const created = await f.api("/api/rules", ruleDraft(`  ${target}  `), "POST");
    assert.equal(created.status, 201); assert.equal(created.body.then.model, target);
    const next = `${target}/v2`;
    const changed = await f.api(`/api/rules/${created.body.id}`, ruleDraft(`  ${next}  `));
    assert.equal(changed.status, 200); assert.equal(changed.body.then.model, next);
    assert.equal(f.store.rules().find(r => r.id === created.body.id)!.then.model, next);
    assert.equal(resolveModel(f.store, next)?.model, next.slice(next.indexOf("/") + 1));
  }
});

test("unchanged unavailable rule targets remain editable, reorderable, toggleable and deletable", async t => {
  const f = await fixture(t), first = f.store.addRule({ ...ruleDraft(), name: "first" });
  for (const target of ["off/m", "budget/m", "droid/m", "missing/m", "pool/empty", "pool/not-a-pool", "legacy-invalid"]) {
    const saved = f.store.addRule({ ...ruleDraft(target), enabled: false });
    for (const enabled of [false, true, false]) {
      const changed = await f.api(`/api/rules/${saved.id}`, { ...saved, name: "renamed", enabled, when: { minChars: 7 }, then: { agent: "codex", model: ` ${target} `, effort: "high" } });
      assert.equal(changed.status, 200, target); assert.equal(changed.body.id, saved.id);
      assert.deepEqual(changed.body, { id: saved.id, name: "renamed", enabled, when: { minChars: 7 }, then: { agent: "codex", model: target, effort: "high" } });
      assert.deepEqual(f.store.rules().map(r => r.id), [first.id, saved.id]);
    }
    assert.equal((await f.api(`/api/rules/${saved.id}/move`, { direction: "up" }, "POST")).status, 200);
    assert.deepEqual(f.store.rules().map(r => r.id), [saved.id, first.id]);
    assert.equal((await f.api(`/api/rules/${saved.id}`, undefined, "DELETE")).status, 200);
    assert.deepEqual(f.store.rules(), [first]);
  }
});

test("rule model clearing and new own-model rules remain allowed without resolving a source", async t => {
  const f = await fixture(t);
  for (const model of [undefined, "", "   "]) {
    const created = await f.api("/api/rules", ruleDraft(model), "POST");
    assert.equal(created.status, 201); assert.deepEqual(created.body.then, { agent: "claude" });
    const saved = f.store.addRule(ruleDraft("missing/model"));
    const changed = await f.api(`/api/rules/${saved.id}`, ruleDraft(model));
    assert.equal(changed.status, 200); assert.equal(changed.body.id, saved.id);
    assert.deepEqual(changed.body.then, { agent: "claude" });
    assert.deepEqual(f.store.rules().find(r => r.id === saved.id)!.then, { agent: "claude" });
  }
});

test("rule save validation keeps console authorization and parse errors ahead of mutation", async t => {
  const f = await fixture(t), saved = f.store.addRule(ruleDraft("on/m"));
  const before = readFileSync(join(f.dir, "state.json"), "utf8"), rules = f.store.rules();
  for (const method of ["POST", "PUT"]) {
    const path = method === "POST" ? "/api/rules" : `/api/rules/${saved.id}`;
    assert.equal((await f.api(path, ruleDraft("on/unlisted/model"), method, false)).status, 403);
    assert.equal((await f.api(path, { ...ruleDraft("on/unlisted/model"), name: "" }, method)).status, 400);
    assert.deepEqual(f.store.rules(), rules); assert.equal(readFileSync(join(f.dir, "state.json"), "utf8"), before);
  }
});
