import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import type { Provider } from "../src/types.ts";
import { buildClientModelMenuView, clientModelMenuPreviewGuard, clientSessionCatalog, normalizeClientModelMenu, parseClientModelMenuRequest, validClientModelId, validClientModelMenu } from "../src/client-model-menu.ts";

const source = (id = "a"): Provider => ({ id, name: id, baseUrl: "https://private-fixture.invalid/v1", models: ["m", "org/deep/model", "last"], route: "chat-translate", routePinned: false, streamUsage: true, createdAt: "", modelEfforts: { "m": ["low", "high"], "manual/child": ["high"] } });
function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), "es-client-menu-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Store(dir); s.upsertProvider(source()); s.upsertProvider({ ...source("b"), off: true });
  s.setBinding({ harness: "codex", providerId: "a", model: "m" });
  s.setPrefs("codex", { effort: "high", fallbackModel: "a/last", tiers: { subagent: "a/manual/child", unknown: "a/last" } });
  return s;
}
const snapshot = (s: Store) => JSON.stringify((s as any).state);
const preview = (s: Store, menu: unknown, agent = "codex") => s.previewClientModelMenu(agent, menu, s.clientModelMenuGuard(agent), ["subagent"]);
const apply = (s: Store, menu: unknown, agent = "codex") => { const p = preview(s, menu, agent); return s.applyClientModelMenu(agent, menu, p.baseGuard, p.previewGuard, ["subagent"]); };

test("plain bounded exact IDs, first slash, ordered uniqueness and explicit empty/all", () => {
  assert.equal(validClientModelId("a/org/deep/model"), true);
  assert.deepEqual(normalizeClientModelMenu(["a/z", "a/org/deep/model"]), ["a/z", "a/org/deep/model"]);
  assert.deepEqual(normalizeClientModelMenu([]), []); assert.equal(normalizeClientModelMenu(null), undefined); assert.equal(normalizeClientModelMenu(undefined), undefined);
  for (const id of ["", "/m", "a/", " a/m", "a/m ", "a/m\n", "a/m\t", "a/\x7f", "a/\u0085", "a/\u202e", "a/\u200b", "a/\ud800", "a/" + "x".repeat(511), 3, null, {}]) assert.equal(validClientModelId(id), false, String(id));
  for (const menu of ["a/m", null, {}, ["a/m", "a/m"], [1], Array(1), Array.from({ length: 81 }, (_, i) => `a/${i}`)]) assert.equal(validClientModelMenu(menu), false);
  assert.equal(validClientModelMenu(Array.from({ length: 80 }, (_, i) => `a/${i}`)), true);
});
test("strict request shape requires both guards at apply and rejects coercion/extra fields", () => {
  const baseGuard = "a".repeat(64), previewGuard = "b".repeat(64);
  assert.deepEqual(parseClientModelMenuRequest({ modelMenu: null, baseGuard }, false), { modelMenu: undefined, baseGuard });
  assert.deepEqual(parseClientModelMenuRequest({ modelMenu: [], baseGuard, previewGuard }, true), { modelMenu: [], baseGuard, previewGuard });
  for (const body of [null, [], "x", {}, { baseGuard }, { modelMenu: [], baseGuard: 2 }, { modelMenu: [], baseGuard, extra: true }, { modelMenu: [], baseGuard, previewGuard }]) assert.throws(() => parseClientModelMenuRequest(body, false));
  for (const body of [{ modelMenu: [], baseGuard }, { modelMenu: [], baseGuard, previewGuard: null }, { modelMenu: [], baseGuard, previewGuard, other: true }]) assert.throws(() => parseClientModelMenuRequest(body, true));
  assert.notEqual(clientModelMenuPreviewGuard("codex", baseGuard, []), clientModelMenuPreviewGuard("codex", baseGuard, undefined));
});
test("preview is read-only, allowlisted, ordered and discloses valid required unlisted model retention", t => {
  const s = fixture(t), before = snapshot(s), p = preview(s, ["a/last", "a/org/deep/model"]);
  assert.equal(snapshot(s), before); assert.equal(p.changed, true); assert.equal(p.before, null);
  assert.deepEqual(p.requiredRetained, [{ id: "a/m", reasons: ["main"] }, { id: "a/manual/child", reasons: ["tier:subagent"] }]);
  assert.deepEqual(p.effectiveModelMenu, ["a/last", "a/org/deep/model", "a/m", "a/manual/child"]);
  assert.equal(p.scope.kind, "codex-next-enhanced-session");
  assert.doesNotMatch(JSON.stringify(p), /private-fixture|baseUrl|createdAt|credential|apiKey/);
  const applied = apply(s, p.modelMenu); assert.deepEqual(applied.modelMenu, p.modelMenu);
  assert.deepEqual(s.prefs("codex"), { effort: "high", fallbackModel: "a/last", tiers: { subagent: "a/manual/child", unknown: "a/last" }, modelMenu: ["a/last", "a/org/deep/model"] });
  assert.deepEqual(s.catalog().map(m => `${m.providerId}/${m.model}`), ["a/m", "a/org/deep/model", "a/last"]);
  assert.deepEqual(s.clientModelMenuCatalog("codex", ["subagent"]).map(m => `${m.providerId}/${m.model}`), p.effectiveModelMenu);
});
test("invalid existing references can remain/reorder/remove, but cannot be newly added", t => {
  const s = fixture(t); s.setPrefs("codex", { modelMenu: ["gone/m", "b/m", "a/m"] });
  const p = preview(s, ["b/m", "gone/m", "a/last"]);
  assert.deepEqual(p.entries, [{ id: "b/m", selectable: false }, { id: "gone/m", selectable: false }, { id: "a/last", selectable: true }]);
  assert.match(p.warnings.join(" "), /失效/); apply(s, p.modelMenu);
  assert.throws(() => preview(s, ["new/m"]), /新增/); assert.throws(() => preview(s, ["a/manual/child"]), /新增/);
  apply(s, ["a/last"]); assert.throws(() => preview(s, ["gone/m"]), /新增/);
  apply(s, null); assert.equal(Object.hasOwn(s.prefs("codex"), "modelMenu"), false);
  apply(s, []); assert.deepEqual(s.prefs("codex").modelMenu, []);
  assert.deepEqual(s.clientModelMenu("codex", ["subagent"]).effectiveModelMenu, ["a/m", "a/manual/child"]);
});
test("other clients keep a console-only preference and never receive required native additions", t => {
  const s = fixture(t); apply(s, ["a/last"], "opencode");
  const view = s.clientModelMenu("opencode", ["small", "subagent"]);
  assert.equal(view.scope.kind, "console-only"); assert.deepEqual(view.requiredRetained, []); assert.deepEqual(view.effectiveModelMenu, ["a/last"]);
  assert.equal(s.prefs("codex").modelMenu, undefined);
});
test("required entries deduplicate reasons, ignore unknown/invalid tiers and retain the default launch model", t => {
  const s = fixture(t); s.setPrefs("codex", { tiers: { subagent: "a/m" }, modelMenu: [] });
  assert.deepEqual(s.clientModelMenu("codex", ["subagent"]).requiredRetained, [{ id: "a/m", reasons: ["main", "tier:subagent"] }]);
  s.setPrefs("codex", { tiers: { subagent: "gone/m" } }); s.clearBinding("codex");
  assert.deepEqual(s.clientModelMenu("codex", ["subagent"]).requiredRetained, [{ id: "a/m", reasons: ["main"] }]);
  s.setProviderBudgetChecker(() => true); assert.deepEqual(s.clientModelMenu("codex", ["subagent"]).requiredRetained, []);
});
test("source disable/budget/droid and unusable pools are never offered as new entries", t => {
  const s = fixture(t); s.upsertProvider({ ...source("d"), cliTextBridge: { kind: "droid" } } as Provider);
  s.upsertPool({ id: "live", name: "live", members: ["a/m"], strategy: "order", createdAt: "" });
  s.upsertPool({ id: "dead", name: "dead", members: ["b/m"], strategy: "order", createdAt: "" });
  const ids = s.clientModelMenu("codex").selectable.map(x => x.id);
  assert.ok(ids.includes("pool/live")); assert.ok(!ids.some(id => /^(?:b|d)\//.test(id))); assert.ok(!ids.includes("pool/dead"));
  apply(s, ["pool/live"]); const before = preview(s, ["pool/live"]); s.setProviderBudgetChecker(p => p.id === "a");
  assert.throws(() => s.applyClientModelMenu("codex", before.modelMenu, before.baseGuard, before.previewGuard), /重新读取/);
  assert.equal(preview(s, ["pool/live"]).entries[0]?.selectable, false);
});

test("all configuration write families, same-value writes, ABA and cross-client changes invalidate reviews", t => {
  const mutations: Array<(s: Store) => void> = [
    s => s.setPrefs("codex", { effort: "high" }),
    s => { s.setPrefs("codex", { effort: "low" }); s.setPrefs("codex", { effort: "high" }); },
    s => { s.setPrefs("opencode", { effort: "low" }); s.setPrefs("opencode", { effort: "" }); },
    s => s.setBinding(s.binding("codex")!),
    s => { s.clearBinding("codex"); s.setBinding({ harness: "codex", providerId: "a", model: "m" }); },
    s => { s.setBinding({ harness: "opencode", providerId: "a", model: "m" }); s.clearBinding("opencode"); },
    s => s.upsertProvider(source()),
    s => { s.upsertProvider({ ...source(), off: true }); s.upsertProvider(source()); },
    s => { s.upsertPool({ id: "p", name: "p", members: ["a/m"], strategy: "order", createdAt: "" }); s.removePool("p"); },
    s => { const p = s.saveProfile("temporary"); s.removeProfile(p.id); },
    s => { const p = s.saveProfile("current"); s.applyProfile(p.id); },
  ];
  for (const mutate of mutations) {
    const s = fixture(t), p = preview(s, ["a/last"]); mutate(s); const before = snapshot(s);
    assert.throws(() => s.applyClientModelMenu("codex", p.modelMenu, p.baseGuard, p.previewGuard, ["subagent"]), (e: any) => e.status === 409 && e.code === "CLIENT_MODEL_MENU_CONFLICT");
    assert.equal(snapshot(s), before);
  }
});
test("payload change, cross-client guard and duplicate/no-op replay conflict", t => {
  const s = fixture(t), p = preview(s, ["a/last"]), before = snapshot(s);
  assert.throws(() => s.applyClientModelMenu("codex", ["a/m"], p.baseGuard, p.previewGuard), /重新读取/);
  assert.throws(() => s.applyClientModelMenu("opencode", p.modelMenu, p.baseGuard, p.previewGuard), /重新读取/);
  assert.equal(snapshot(s), before);
  s.applyClientModelMenu("codex", p.modelMenu, p.baseGuard, p.previewGuard); assert.throws(() => s.applyClientModelMenu("codex", p.modelMenu, p.baseGuard, p.previewGuard), /重新读取/);
  const noop = preview(s, p.modelMenu); assert.equal(noop.changed, false); s.applyClientModelMenu("codex", noop.modelMenu, noop.baseGuard, noop.previewGuard);
  assert.throws(() => s.applyClientModelMenu("codex", noop.modelMenu, noop.baseGuard, noop.previewGuard), /重新读取/);
});
test("save failure rolls back exact prefs and revision; the same preview can retry and persist", t => {
  const s = fixture(t), p = preview(s, []), before = snapshot(s), bytes = readFileSync(join(s.dir, "state.json"), "utf8"), save = (s as any).save;
  (s as any).save = () => { throw new Error("synthetic disk failure"); };
  assert.throws(() => s.applyClientModelMenu("codex", [], p.baseGuard, p.previewGuard), /synthetic disk/);
  assert.equal(snapshot(s), before); assert.equal(readFileSync(join(s.dir, "state.json"), "utf8"), bytes); assert.equal(s.clientModelMenuGuard("codex"), p.baseGuard);
  (s as any).save = save; s.applyClientModelMenu("codex", [], p.baseGuard, p.previewGuard);
  const restarted = new Store(s.dir); assert.deepEqual(restarted.prefs("codex").modelMenu, []); assert.equal(restarted.clientModelMenuGuard("codex"), s.clientModelMenuGuard("codex"));
});
test("profiles round-trip ordered/empty menus; absent old profile restores all and revisions advance", t => {
  const s = fixture(t), old = s.saveProfile("old"), oldRevision = s.prefsRevision("codex");
  apply(s, ["a/last", "a/m"]); s.setPrefs("opencode", { modelMenu: [] }); const custom = s.saveProfile("custom");
  assert.notEqual(s.prefsRevision("codex"), oldRevision);
  let p = s.previewProfile(old.id)!; assert.equal(Object.hasOwn(p.changes.find(c => c.harness === "codex")!.after.prefs, "modelMenu"), false);
  const beforeApply = s.prefsRevision("codex"); s.applyProfile(old.id, p.fingerprint); assert.equal(s.prefs("codex").modelMenu, undefined); assert.equal(s.prefs("opencode").modelMenu, undefined); assert.notEqual(s.prefsRevision("codex"), beforeApply);
  p = s.previewProfile(custom.id)!; assert.deepEqual(p.changes.find(c => c.harness === "codex")!.after.prefs.modelMenu, ["a/last", "a/m"]);
  s.applyProfile(custom.id, p.fingerprint); assert.deepEqual(s.prefs("codex").modelMenu, ["a/last", "a/m"]); assert.deepEqual(s.prefs("opencode").modelMenu, []);
});
test("profile menu warnings preserve missing references without enabling sources or changing budgets", t => {
  const s = fixture(t); s.setPrefs("codex", { modelMenu: ["a/m", "b/m", "gone/m", "pool/gone"] }); const p = s.saveProfile("stale"); s.setProviderBudgetChecker(p => p.id === "a");
  const view = s.previewProfile(p.id)!; assert.match(JSON.stringify(view), /模型菜单/); assert.match(JSON.stringify(view), /预算暂停/); assert.match(JSON.stringify(view), /已关闭/); assert.match(JSON.stringify(view), /已不存在/);
  s.applyProfile(p.id, view.fingerprint); assert.deepEqual(s.prefs("codex").modelMenu, p.prefs.codex!.modelMenu); assert.equal(s.provider("b")!.off, true); assert.equal(s.providerBudgetStopped(s.provider("a")!), true);
});
test("strict profile validation rejects malformed menu and menu-only changes count", t => {
  for (const value of [null, {}, ["a/m", "a/m"], ["a/x\n"], Array.from({ length: 81 }, (_, i) => `a/${i}`)]) {
    const s = fixture(t), p = s.saveProfile("bad"); (s as any).state.profiles[0].prefs.codex.modelMenu = value;
    assert.throws(() => s.previewProfile(p.id), /不完整/);
  }
  const s = fixture(t), p = s.saveProfile("all"); apply(s, []); const view = s.previewProfile(p.id)!;
  assert.equal(view.changes.find(c => c.harness === "codex")!.changed, true);
  const review = view.fingerprint; s.setPrefs("codex", { effort: "high" }); assert.throws(() => s.applyProfile(p.id, review), /重新预览/);
});
test("save/remove/profile application persistence failures restore review state", t => {
  for (const action of ["save", "replace", "remove", "apply"] as const) {
    const s = fixture(t), p = s.saveProfile("saved"), before = snapshot(s), guard = s.clientModelMenuGuard("codex"), rev = s.prefsRevision("codex");
    (s as any).save = () => { throw new Error("synthetic disk failure"); };
    assert.throws(() => action === "save" ? s.saveProfile("new") : action === "replace" ? s.saveProfile("saved") : action === "remove" ? s.removeProfile(p.id) : s.applyProfile(p.id), /synthetic disk/);
    assert.equal(snapshot(s), before); assert.equal(s.clientModelMenuGuard("codex"), guard); assert.equal(s.prefsRevision("codex"), rev);
  }
});
test("pure session catalog copies, preserves exact order, skips invalid refs and never mutates global catalog", () => {
  const catalog = ["one", "two"].map(model => ({ providerId: "p", providerName: "P", model, efforts: ["high"] })), required = [{ model: { ...catalog[0]!, model: "manual/child" }, reasons: ["tier:subagent"] }];
  const out = clientSessionCatalog(catalog, ["p/two", "gone/m", "p/one"], required);
  assert.deepEqual(out.map(m => m.model), ["two", "one", "manual/child"]); out[0]!.efforts.push("low"); assert.deepEqual(catalog[1]!.efforts, ["high"]);
  assert.deepEqual(clientSessionCatalog(catalog, undefined, required), catalog);
  assert.throws(() => buildClientModelMenuView({ agentId: "codex", baseGuard: "", modelMenu: undefined, required: [], catalog: Array.from({ length: 10_001 }, (_, i) => ({ ...catalog[0]!, model: String(i) })) }), /10,000/);
});

test("malformed persisted null menu never silently resets to all or overwrites stored data", t => {
  const s = fixture(t); (s as any).state.prefs.codex.modelMenu = null; const before = snapshot(s);
  assert.throws(() => s.clientModelMenu("codex"), /最多 80/);
  assert.throws(() => s.previewClientModelMenu("codex", [], s.clientModelMenuGuard("codex")), /最多 80/);
  assert.throws(() => s.clientModelMenuCatalog("codex"), /最多 80/);
  assert.equal(snapshot(s), before);
});
