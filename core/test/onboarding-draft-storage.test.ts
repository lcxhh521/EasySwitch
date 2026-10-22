import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

// Pure VM/storage fixtures only: no browser, account, API, client or model access.
const key = "easyswitch:first-run:draft:v1";
const ttlMs = 30 * 60 * 1000;
const now = 1_800_000_000_000;
const input = { providerId: "fixture-provider", model: "fixture-model", agent: "aider", phase: "select" };
const record = () => ({ schema: 1, updatedAt: now, ...input });
type Draft = ReturnType<typeof record>;
type Api = {
  key: string; ttlMs: number;
  read: (at?: unknown) => Draft | null;
  write: (value: unknown, at?: unknown) => boolean;
  clear: () => boolean;
  validate: (value: unknown, at?: unknown) => Draft | null;
};
function storage() {
  const values = new Map<string, string>();
  const calls: Array<{ op: string; key: string; value?: string }> = [];
  return { values, calls,
    getItem(name: string) { calls.push({ op: "get", key: name }); return values.has(name) ? values.get(name)! : null; },
    setItem(name: string, value: string) { calls.push({ op: "set", key: name, value }); values.set(name, value); },
    removeItem(name: string) { calls.push({ op: "remove", key: name }); values.delete(name); },
  };
}
function load(store: unknown = storage(), getter?: () => unknown) {
  let clock = now;
  const forbidden: string[] = [];
  const globals: Record<string, unknown> = {
    TextEncoder,
    Date: class extends Date { static now() { return clock; } },
    fetch() { forbidden.push("fetch"); throw new Error("No transport in draft VM"); },
  };
  Object.defineProperty(globals, "sessionStorage", { get: getter ?? (() => store) });
  for (const name of ["localStorage", "indexedDB", "XMLHttpRequest", "WebSocket", "document", "navigator"]) {
    Object.defineProperty(globals, name, { get() { forbidden.push(name); throw new Error(`Forbidden ${name}`); } });
  }
  const context = vm.createContext(globals);
  vm.runInContext(readFileSync(new URL("../../web/onboarding-draft.js", import.meta.url), "utf8"), context);
  return { api: context.EasySwitchFirstRunDraft as Api, forbidden, tick(at: number) { clock = at; } };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("draft exports the exact storage key, TTL and four callable operations", () => {
  const { api } = load();
  assert.equal(api.key, key); assert.equal(api.ttlMs, ttlMs);
  assert.deepEqual(Object.keys(api).sort(), ["clear", "key", "read", "ttlMs", "validate", "write"]);
  for (const operation of ["read", "write", "clear", "validate"] as const) assert.equal(typeof api[operation], "function");
});

test("draft writes only its explicit non-secret schema and preserves caller input", () => {
  const store = storage(), { api } = load(store);
  const choice = Object.freeze({ ...input });
  assert.equal(api.write(choice, now), true);
  assert.deepEqual(JSON.parse(store.values.get(key)!), record());
  assert.deepEqual(choice, input);
  assert.deepEqual(plain(api.read(now)), record());
  assert.equal(store.calls.filter(call => call.op === "set").length, 1);
  assert.deepEqual([...store.values.keys()], [key]);
});

test("draft can resume in the same storage after reload but independent tabs do not share it", () => {
  const first = storage(), second = storage();
  assert.equal(load(first).api.write(input, now), true);
  assert.deepEqual(plain(load(first).api.read(now)), record());
  assert.equal(load(second).api.read(now), null);
  assert.equal(load(second).api.write({ ...input, providerId: "other-tab" }, now), true);
  assert.equal(load(first).api.read(now)?.providerId, input.providerId);
  assert.equal(load(second).api.read(now)?.providerId, "other-tab");
});

test("draft defaults to Date.now, never renews on read, and expires at exactly its TTL", () => {
  const store = storage(), app = load(store);
  assert.equal(app.api.write(input), true);
  app.tick(now + ttlMs - 1);
  assert.equal(app.api.read()?.updatedAt, now);
  assert.equal(app.api.validate(record())?.updatedAt, now);
  assert.equal(store.calls.filter(call => call.op === "set").length, 1);
  app.tick(now + ttlMs);
  assert.equal(app.api.read(), null); assert.equal(store.values.has(key), false);
  assert.equal(app.api.validate(record()), null);
});

test("draft read and validation always return fresh copies without mutating records", () => {
  const store = storage(), { api } = load(store);
  const original = Object.freeze(record());
  const a = api.validate(original, now), b = api.validate(original, now);
  assert.ok(a); assert.ok(b); assert.notEqual(a, b); assert.notEqual(a, original);
  a.providerId = "changed"; assert.equal(b.providerId, input.providerId);
  assert.deepEqual(original, record());
  api.write(input, now);
  const c = api.read(now), d = api.read(now); assert.ok(c); assert.ok(d); assert.notEqual(c, d);
  c.model = "changed"; assert.equal(d.model, input.model); assert.equal(api.read(now)?.model, input.model);
});

test("draft allows empty unselected strings but later phases require a provider", () => {
  const { api } = load();
  for (const phase of ["source", "select", "launch-uncertain"]) {
    assert.ok(api.validate({ ...record(), phase }, now));
    assert.equal(api.write({ providerId: phase === "source" ? "" : "p", model: "", agent: "", phase }, now), true);
  }
  for (const phase of ["select", "launch-uncertain"]) {
    assert.equal(api.validate({ ...record(), providerId: "", phase }, now), null);
    assert.equal(api.write({ ...input, providerId: "", phase }, now), false);
  }
  for (const phase of ["done", "tested", "saved", "launch", "", null, 1]) {
    assert.equal(api.validate({ ...record(), phase }, now), null);
    assert.equal(api.write({ ...input, phase }, now), false);
  }
});

test("draft rejects incompatible schema, missing fields and invalid record shapes", () => {
  const { api } = load();
  for (const value of [null, undefined, [], "record", 1, true, new Date(now)]) assert.equal(api.validate(value, now), null);
  for (const schema of [0, 2, "1", null, true, NaN]) assert.equal(api.validate({ ...record(), schema }, now), null);
  for (const field of Object.keys(record())) {
    const candidate: Record<string, unknown> = record(); delete candidate[field];
    assert.equal(api.validate(candidate, now), null, field);
  }
  for (const field of Object.keys(input)) {
    const candidate: Record<string, unknown> = { ...input }; delete candidate[field];
    assert.equal(api.write(candidate, now), false, field);
  }
  for (const candidate of [null, undefined, [], "input", 1, true]) assert.equal(api.write(candidate, now), false);
});

test("draft rejects all unknown, non-enumerable and symbol fields rather than serializing secrets or success", () => {
  const store = storage(), { api } = load(store);
  for (const field of ["apiKey", "key", "token", "password", "tested", "saved", "done", "baseUrl", "accountId", "identity", "anything"]) {
    store.values.set(key, JSON.stringify(record()));
    assert.equal(api.write({ ...input, [field]: "fixture-secret-do-not-save" }, now), false, field);
    assert.equal(store.values.has(key), false, field);
    assert.equal(api.validate({ ...record(), [field]: "fixture-secret-do-not-save" }, now), null, field);
  }
  for (const field of ["schema", "updatedAt"]) assert.equal(api.write({ ...input, [field]: 1 }, now), false);
  for (const field of ["token", Symbol("token")]) {
    assert.equal(api.write(Object.defineProperty({ ...input }, field, { value: "fixture-secret" }), now), false);
    assert.equal(api.validate(Object.defineProperty(record(), field, { value: "fixture-secret" }), now), null);
  }
  assert.equal(store.calls.filter(call => call.op === "set").length, 0);
});

test("draft rejects inherited fields, accessors and toJSON without invoking them", () => {
  const store = storage(), { api } = load(store); let invoked = 0;
  const inheritedInput = Object.assign(Object.create({ token: "fixture-secret" }), input);
  const inheritedRecord = Object.assign(Object.create({ token: "fixture-secret" }), record());
  assert.equal(api.write(inheritedInput, now), false); assert.equal(api.validate(inheritedRecord, now), null);
  for (const field of Object.keys(input)) {
    const candidate = Object.defineProperty({ ...input }, field, { get() { invoked++; return input[field as keyof typeof input]; } });
    assert.equal(api.write(candidate, now), false);
  }
  for (const field of Object.keys(record())) {
    assert.equal(api.validate(Object.defineProperty(record(), field, { get() { invoked++; throw new Error("getter"); } }), now), null);
  }
  const secretSerializer = () => { invoked++; return "fixture-secret"; };
  assert.equal(api.write({ ...input, toJSON: secretSerializer }, now), false);
  assert.equal(api.validate({ ...record(), toJSON: secretSerializer }, now), null);
  assert.equal(invoked, 0); assert.equal(store.calls.filter(call => call.op === "set").length, 0);
});

test("draft safely rejects hostile shape inspection and accepts null-prototype data records", () => {
  const { api } = load();
  const hostile = new Proxy({}, { ownKeys() { throw new Error("shape unavailable"); } });
  assert.equal(api.validate(hostile, now), null); assert.equal(api.write(hostile, now), false);
  assert.ok(api.validate(Object.assign(Object.create(null), record()), now));
  assert.equal(api.write(Object.assign(Object.create(null), input), now), true);
});

test("draft rejects invalid timestamps and clocks including future values without preserving old markers", () => {
  const store = storage(), { api } = load(store);
  for (const value of [null, "1800000000000", NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(api.validate({ ...record(), updatedAt: value }, now), null);
    assert.equal(api.validate(record(), value), null);
    store.values.set(key, JSON.stringify(record()));
    assert.equal(api.write(input, value), false); assert.equal(store.values.has(key), false);
    store.values.set(key, JSON.stringify(record()));
    assert.equal(api.read(value), null); assert.equal(store.values.has(key), false);
  }
  for (const updatedAt of [now + 1, now - ttlMs, now - ttlMs - 1]) {
    const stale = { ...record(), updatedAt };
    assert.equal(api.validate(stale, now), null);
    store.values.set(key, JSON.stringify(stale));
    assert.equal(api.read(now), null); assert.equal(store.values.has(key), false);
  }
  assert.ok(api.validate({ ...record(), updatedAt: now - ttlMs + 1 }, now));
});

test("draft enforces each string type, maximum length, C0/DEL and whitespace boundary", () => {
  const { api } = load();
  for (const [field, limit] of [["providerId", 256], ["model", 512], ["agent", 128]] as const) {
    assert.ok(api.validate({ ...record(), [field]: "a".repeat(limit) }, now));
    assert.equal(api.write({ ...input, [field]: "a".repeat(limit) }, now), true);
    for (const value of ["a".repeat(limit + 1), 1, null, {}, [], false, " p", "p ", "\u00a0p", "p\u3000", "p\x7fq", ...Array.from({ length: 32 }, (_, n) => `p${String.fromCharCode(n)}q`)]) {
      assert.equal(api.validate({ ...record(), [field]: value }, now), null, field);
      assert.equal(api.write({ ...input, [field]: value }, now), false, field);
    }
  }
  assert.ok(api.validate({ ...record(), model: "模型 a" }, now));
});

test("draft limits serialized UTF-8 bytes, including Unicode, to exactly 2048", () => {
  const store = storage(), { api } = load(store);
  const choices = { providerId: "界".repeat(256), model: "界".repeat(350), agent: "", phase: "select" };
  while (new TextEncoder().encode(JSON.stringify({ schema: 1, updatedAt: now, ...choices })).length < 2048) choices.model += "a";
  const exact = { schema: 1, updatedAt: now, ...choices };
  assert.equal(new TextEncoder().encode(JSON.stringify(exact)).length, 2048);
  assert.ok(choices.model.length <= 512); assert.ok(api.validate(exact, now));
  assert.equal(api.write(choices, now), true); assert.ok(api.read(now));
  const over = { ...choices, model: `${choices.model}a` };
  assert.equal(api.validate({ schema: 1, updatedAt: now, ...over }, now), null);
  assert.equal(api.write(over, now), false); assert.equal(store.values.has(key), false);
  store.values.set(key, JSON.stringify(exact) + " ");
  assert.equal(api.read(now), null); assert.equal(store.values.has(key), false);
});

test("draft purges corrupt, incompatible, oversized and wrong-type stored records", () => {
  const store = storage(), { api } = load(store);
  const invalid: unknown[] = ["", "{", "null", "[]", "1", '"value"', JSON.stringify({ ...record(), schema: 2 }),
    JSON.stringify({ ...record(), token: "fixture-secret" }), JSON.stringify({ ...record(), model: "x".repeat(513) }),
    " ".repeat(2049), JSON.stringify(record()) + " ".repeat(2049), 4, {}, undefined];
  for (const value of invalid) {
    store.values.set(key, value as string);
    assert.equal(api.read(now), null); assert.equal(store.values.has(key), false);
  }
});

test("draft missing storage and throwing storage getters never prevent the main flow", () => {
  for (const getter of [() => undefined, () => null, () => { throw new Error("SecurityError"); }]) {
    const { api } = load(undefined, getter);
    assert.equal(api.read(now), null); assert.equal(api.write(input, now), false); assert.equal(api.clear(), false);
    assert.ok(api.validate(record(), now));
  }
});

test("draft getItem failures are contained and attempt to remove the unreadable marker", () => {
  const store = storage(); store.values.set(key, JSON.stringify(record()));
  store.getItem = () => { throw new Error("read denied"); };
  const { api } = load(store);
  assert.equal(api.read(now), null); assert.equal(store.values.has(key), false);
  assert.equal(store.calls.filter(call => call.op === "remove").length, 1);
});

test("draft setItem failures remove old or partially written markers where possible", () => {
  for (const partial of [false, true]) {
    const store = storage(); store.values.set(key, JSON.stringify(record()));
    store.setItem = (name, value) => { if (partial) store.values.set(name, value); throw new Error("QuotaExceededError"); };
    const { api } = load(store);
    assert.equal(api.write({ ...input, model: "new-model" }, now), false);
    assert.equal(store.values.has(key), false);
    assert.equal(store.calls.filter(call => call.op === "remove").length, 1);
  }
});

test("draft removeItem failures remain best-effort, never become successful clears or throws", () => {
  const store = storage(); store.values.set(key, "corrupt");
  store.removeItem = () => { throw new Error("remove denied"); };
  const { api } = load(store);
  assert.equal(api.clear(), false); assert.equal(api.read(now), null);
  assert.equal(api.write({ ...input, token: "fixture-secret" }, now), false);
  store.setItem = () => { throw new Error("write denied"); };
  assert.equal(api.write(input, now), false);
  store.getItem = () => { throw new Error("read denied"); };
  assert.equal(api.read(now), null);
});

test("draft catches throwing storage method getters as well as method calls", () => {
  for (const method of ["getItem", "setItem", "removeItem"]) {
    const store = storage();
    Object.defineProperty(store, method, { get() { throw new Error("method unavailable"); } });
    const { api } = load(store);
    if (method === "getItem") assert.equal(api.read(now), null);
    if (method === "setItem") assert.equal(api.write(input, now), false);
    if (method === "removeItem") { assert.equal(api.clear(), false); store.values.set(key, "corrupt"); assert.equal(api.read(now), null); }
  }
});

test("draft clears only its own marker and never touches other persistence or transports", () => {
  const store = storage(), { api, forbidden } = load(store);
  store.values.set("unrelated", "keep");
  assert.equal(api.read(now), null);
  assert.equal(api.write(input, now), true); assert.ok(api.read(now));
  assert.equal(api.clear(), true); assert.equal(api.clear(), true);
  assert.equal(api.read(now), null); assert.equal(store.values.get("unrelated"), "keep");
  assert.ok(store.calls.every(call => call.key === key));
  assert.deepEqual(forbidden, []);
});
