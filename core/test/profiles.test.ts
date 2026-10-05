import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import type { Provider } from "../src/types.ts";

const provider = (id: string): Provider => ({ id, name: id, baseUrl: `https://${id}.example/v1`, models: ["m1", "m2"], route: "chat-translate", routePinned: false, streamUsage: true, createdAt: "2026-01-01T00:00:00Z" }) as Provider;

function fresh(): Store {
  const store = new Store(mkdtempSync(join(tmpdir(), "es-profiles-")));
  store.upsertProvider(provider("a"));
  store.upsertProvider(provider("b"));
  return store;
}

test("a profile remembers every agent's main model, thinking level and other models, and switching brings them all back", () => {
  const store = fresh();
  store.setBinding({ harness: "claude", providerId: "a", model: "m1" });
  store.setBinding({ harness: "opencode", providerId: "b", model: "m2" });
  store.setPrefs("claude", { effort: "high", tiers: { subagent: "b/m2" } });
  const saved = store.saveProfile("专注");

  store.setBinding({ harness: "claude", providerId: "b", model: "m1" });
  store.clearBinding("opencode");
  store.setPrefs("claude", { effort: "low", tiers: { subagent: "" } });

  store.applyProfile(saved.id);
  assert.deepEqual(store.binding("claude"), { harness: "claude", providerId: "a", model: "m1" });
  assert.deepEqual(store.binding("opencode"), { harness: "opencode", providerId: "b", model: "m2" });
  assert.deepEqual(store.prefs("claude"), { effort: "high", tiers: { subagent: "b/m2" } });
});

test("saving under a name already used replaces that profile; deleting removes it", () => {
  const store = fresh();
  store.setBinding({ harness: "claude", providerId: "a", model: "m1" });
  const first = store.saveProfile("x");
  store.setBinding({ harness: "claude", providerId: "b", model: "m2" });
  const again = store.saveProfile("x");
  assert.equal(again.id, first.id);
  assert.equal(store.profiles().length, 1);
  store.applyProfile(first.id);
  assert.equal(store.binding("claude")!.providerId, "b");
  store.removeProfile(first.id);
  assert.equal(store.profiles().length, 0);
});

test("applying never points an agent at a source or pool that no longer exists, and does not touch sources", () => {
  const store = fresh();
  store.setBinding({ harness: "claude", providerId: "a", model: "m1" });
  store.setBinding({ harness: "opencode", providerId: "b", model: "m2" });
  const saved = store.saveProfile("both");
  store.removeProvider("a");
  store.applyProfile(saved.id);
  assert.equal(store.binding("claude"), undefined, "its source is gone, so it is back on native");
  assert.equal(store.binding("opencode")!.providerId, "b");
  assert.deepEqual(store.providers().map(p => p.id), ["b"], "profiles never add or remove sources");
});

test("profiles survive a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-profiles-keep-"));
  const one = new Store(dir);
  one.upsertProvider(provider("a"));
  one.setBinding({ harness: "claude", providerId: "a", model: "m1" });
  one.saveProfile("keep");
  assert.deepEqual(new Store(dir).profiles().map(p => p.name), ["keep"]);
});
