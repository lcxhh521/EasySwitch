import assert from "node:assert/strict";
import { test } from "node:test";
import { isKeyFailure, markResult, pick, withKey } from "../src/keypool.ts";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "../src/types.ts";

function provider(keys: Array<Record<string, unknown>>): Provider {
  const now = new Date().toISOString();
  return {
    id: "relay", name: "Relay", baseUrl: "http://127.0.0.1:1/v1", models: ["m"],
    route: "chat-translate", routePinned: false, streamUsage: true, createdAt: now,
    keys: keys.map(k => ({ id: (k.id as string) ?? "k", label: (k.label as string) ?? "K", enabled: k.enabled !== false, addedAt: now, ...k })) as Provider["keys"],
  } as Provider;
}

test("the pool rotates round-robin and skips disabled keys", () => {
  const p = provider([{ id: "a" }, { id: "b" }, { id: "c", enabled: false }]);
  const seen = [pick(p)!.id, pick(p)!.id, pick(p)!.id, pick(p)!.id];
  assert.ok(seen.every(id => id === "a" || id === "b"), `only enabled keys are picked: ${seen}`);
  assert.notEqual(seen[0], seen[1], "consecutive picks differ: it rotates");
  assert.notEqual(seen[1], seen[2], "…and alternates");
});

test("a resting key steps aside; when all rest, the least-recently rested still answers", () => {
  const soon = new Date(Date.now() + 60_000).toISOString();
  const p = provider([{ id: "a", restUntil: soon }, { id: "b" }]);
  assert.equal(pick(p)!.id, "b"); // only b is usable
  const later = new Date(Date.now() - 1000).toISOString();
  const allDown = provider([{ id: "a", restUntil: soon }, { id: "b", restUntil: later }]);
  assert.ok(["a", "b"].includes(pick(allDown)!.id), "when every key rests, one is still served");
});

test("withKey retries on a key failure but not on other errors", async t => {
  const store = new Store(mkdtempSync(join(tmpdir(), "es-keypool-")));
  const secrets = createSecretStore();
  const p = provider([{ id: "a" }, { id: "b" }]);
  store.upsertProvider(p);
  await secrets.set("relay#a", "first");
  await secrets.set("relay#b", "second");

  let recordedKeys: string[] = [];
  const json = (status: number) => new Response(JSON.stringify({ status }), { status });
  const { response, keyId } = await withKey(store, secrets, store.provider("relay")!, async (apiKey?: string) => {
    recordedKeys = [...recordedKeys, apiKey as string];
    return apiKey === "first" ? json(429) : json(200);
  });
  assert.ok(!(response instanceof Error) && response.status === 200);
  assert.deepEqual(recordedKeys, ["first", "second"], "the failed key is retried with the next one");
  assert.equal(keyId, "b");
  // The 429 key rests, with a reason the console can show.
  const rested = store.provider("relay")!.keys!.find(k => k.id === "a")!;
  assert.ok(rested.restUntil && rested.lastError?.reason);

  recordedKeys = [];
  await withKey(store, secrets, store.provider("relay")!, async apiKey => {
    recordedKeys = [...recordedKeys, apiKey as string];
    return json(500); // not the key's fault: no second call
  });
  assert.equal(recordedKeys.length, 1);

  recordedKeys = [];
  await withKey(store, secrets, store.provider("relay")!, async (apiKey?: string) => {
    recordedKeys = [...recordedKeys, apiKey ?? "(none)"];
    return new Error("upstream unreachable");
  });
  assert.equal(recordedKeys.length, 1, "network errors are not retried with another key");
});

test("markResult clears the rest flag when a key works again", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "es-keypool-")));
  const p = provider([{ id: "a", restUntil: new Date(Date.now() + 60_000).toISOString(), lastError: { at: new Date().toISOString(), status: 429, reason: "限流" } }]);
  store.upsertProvider(p);
  await markResult(store, store.provider("relay")!, "a", 200);
  const key = store.provider("relay")!.keys![0]!;
  assert.equal(key.restUntil, undefined);
  assert.equal(key.lastError, undefined);
  assert.ok(!isKeyFailure(500) && isKeyFailure(401) && isKeyFailure(403) && isKeyFailure(429));
});


test("retry metadata is present only after an actual second run, without changing key selection", async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "es-keypool-metadata-"))), secrets = createSecretStore();
  const p = { ...provider([{ id: "a" }, { id: "b" }]), id: "retry-metadata" }; store.upsertProvider(p);
  await secrets.set("retry-metadata#a", "first"); await secrets.set("retry-metadata#b", "second");
  let calls = 0;
  const retried = await withKey(store, secrets, p, async () => new Response("", { status: ++calls === 1 ? 429 : 200 }));
  assert.equal(calls, 2); assert.equal(retried.hadRetry, true);
  calls = 0;
  const success = await withKey(store, secrets, p, async () => { calls++; return new Response("", { status: 200 }); });
  assert.equal(calls, 1); assert.notEqual(success.hadRetry, true);
  const one = { ...provider([{ id: "only" }]), id: "one-key-metadata" }; store.upsertProvider(one); await secrets.set("one-key-metadata#only", "fake");
  calls = 0;
  const exhausted = await withKey(store, secrets, one, async () => { calls++; return new Response("", { status: 429 }); });
  assert.equal(calls, 1); assert.notEqual(exhausted.hadRetry, true);
});
