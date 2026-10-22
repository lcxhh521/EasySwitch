import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { catalogModels, codexCatalog } from "../src/catalog.ts";
import { LAUNCHERS, type LaunchInput } from "../src/agent-launch.ts";
import { contextTokens, poolContext, providerContext } from "../src/model-context.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { Provider } from "../src/types.ts";

const provider = (id: string, windows?: Record<string, number>): Provider => ({
  id, name: id, baseUrl: "http://127.0.0.1:1", models: ["m", "large-1m"], route: "chat-translate", routePinned: true,
  streamUsage: false, createdAt: "", ...(windows ? { modelContextWindows: windows } : {}),
});
function storeFixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "es-context-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Store(dir);
}

test("context metadata belongs to the exact source/model; names and templates do not supply evidence", () => {
  const models = catalogModels([provider("a", { m: 16000 }), provider("b", { m: 512000 })]);
  const template = { context_window: 1000000, max_context_window: 1000000, auto_compact_token_limit: 900000, untouched: "native" };
  const result = codexCatalog(template, models).models as Record<string, any>[];
  assert.equal(result.find(m => m.slug === "a/m")!.context_window, 16000);
  assert.equal(result.find(m => m.slug === "b/m")!.context_window, 512000);
  assert.equal(result.find(m => m.slug === "b/m")!.max_context_window, 512000);
  assert.equal(result.find(m => m.slug === "a/m")!.auto_compact_token_limit, 14400);
  assert.equal(result.find(m => m.slug === "a/large-1m")!.context_window, 128000);
  assert.match(result.find(m => m.slug === "a/large-1m")!.description, /未知/);
  assert.match(result.find(m => m.slug === "b/m")!.description, /手动配置/);
  assert.equal(template.context_window, 1000000);
  assert.ok(result.every(m => m.untouched === "native"));
});

test("pools use every configured member including disabled members, with explicit unknown bounds", t => {
  const store = storeFixture(t);
  store.upsertProvider(provider("a", { m: 512000 }));
  store.upsertProvider({ ...provider("b", { m: 16000 }), off: true });
  store.upsertPool({ id: "mix", name: "mix", strategy: "rotate", members: ["a/m", "b/m"], createdAt: "" });
  const context = () => store.catalog().find(m => m.providerId === "pool")!.context;
  assert.deepEqual(context(), { tokens: 16000, source: "pool" });
  store.upsertProvider({ ...provider("b"), off: true });
  assert.deepEqual(context(), { tokens: 512000, source: "partial-pool" });
  assert.equal(contextTokens(context(), 128000), 128000);
  assert.equal(contextTokens(context(), 200000), 200000);
  store.upsertProvider(provider("a", { m: 8000 }));
  assert.equal(contextTokens(context(), 128000), 8000);
  assert.equal(poolContext([undefined, undefined]), undefined);
  assert.equal(contextTokens(undefined, 128000), 128000);
});

test("invalid imported context values remain unknown rather than creating broken catalogs", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "128000"]) {
    assert.equal(providerContext(provider("p", { m: value as number }), "m"), undefined);
  }
});

const input: LaunchInput = { bin: "/fixture/not-executed", port: 18765, token: "fixture", sessionDir: "/tmp/config-only",
  model: "p/m", models: ["p/unknown"], tiers: { small: "q/m", subagent: "q/m" },
  modelContexts: { "p/m": { tokens: 16000, source: "user" }, "q/m": { tokens: 64000, source: "user" } },
};

for (const [id, pattern, fallback] of [
  ["kimi-cli", /max_context_size = (\d+)/g, 128000], ["pi", /"contextWindow":(\d+)/g, 200000],
  ["omp", /contextWindow: (\d+)/g, 200000], ["cline", /"contextWindow":(\d+)/g, 200000],
  ["goose", /"context_limit":(\d+)/g, 200000], ["crush", /"context_window":(\d+)/g, 200000],
  ["grok-build", /context_window = (\d+)/g, 200000], ["minimax-code", /context: (\d+)/g, 200000],
  ["qoder-cli", /"contextWindow":(\d+)/g, 200000], ["openclaw", /"contextWindow":(\d+)/g, 200000],
  ["atomcode", /context_window = (\d+)/g, 128000],
] as const) test(`${id} writes distinct main/menu/tier windows and retains the unknown default`, () => {
  const spec = LAUNCHERS[id]!.interactive!(input);
  const files = Object.values(spec.files!).join("\n");
  assert.deepEqual([...files.matchAll(pattern)].map(m => Number(m[1])), [16000, fallback, 64000]);
  assert.doesNotMatch(files, /windowFor|outputFor/);
  if (id === "pi") {
    const models = JSON.parse(Object.entries(spec.files!).find(([path]) => path.endsWith("models.json"))![1]).providers.easyswitch.models;
    assert.equal(models[0].maxTokens, 16000);
    assert.equal(models[2].maxTokens, 32000);
  }
});

async function apiFixture(t: TestContext) {
  const store = storeFixture(t); store.upsertProvider(provider("p"));
  let keyReads = 0, launches = 0;
  const server = createEasySwitchServer({ store, port: 0, secrets: {
    async get() { keyReads++; throw new Error("must not read credentials"); }, async set() {}, async delete() {},
  }, interactiveRuntime: {
    findBinary: async () => "/fixture/never-run-kimi", newSessionDir: () => mkdtempSync(join(store.dir, "session-")),
    launchInTerminal: async () => { launches++; assert.fail("must not launch a client"); },
  } });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, method: string, body: unknown, header = true) => fetch(base + path, {
    method, headers: { "content-type": "application/json", ...(header ? { "x-easyswitch": "1" } : {}) }, body: JSON.stringify(body),
  });
  return { store, request, reads: () => [keyReads, launches], save: (tokens: unknown, model = "m") => request("/api/providers/p/model-context", "PUT", { model, tokens }) };
}

test("console saves and clears source windows durably without reading credentials", async t => {
  const f = await apiFixture(t);
  assert.equal((await f.request("/api/providers/p/model-context", "PUT", { model: "m", tokens: 32000 }, false)).status, 403);
  const saved = await f.save(32000);
  assert.equal(saved.status, 200); assert.deepEqual(await saved.json(), { model: "m", context: { tokens: 32000, source: "user" } });
  assert.equal(new Store(f.store.dir).provider("p")!.modelContextWindows!.m, 32000);
  await f.save(512000, "large-1m"); await f.save(null);
  assert.deepEqual(new Store(f.store.dir).provider("p")!.modelContextWindows, { "large-1m": 512000 });
  await f.save(null, "large-1m"); assert.equal(f.store.provider("p")!.modelContextWindows, undefined);
  assert.deepEqual(f.reads(), [0, 0]);
});

test("bad windows and unknown models cannot replace a saved setting", async t => {
  const f = await apiFixture(t); await f.save(32000);
  for (const tokens of [0, -1, 1.5, "64000", Number.MAX_SAFE_INTEGER + 1, undefined, {}, true]) {
    assert.equal((await f.save(tokens)).status, 400);
    assert.equal(f.store.provider("p")!.modelContextWindows!.m, 32000);
  }
  assert.equal((await f.save(64000, "not-listed")).status, 400);
  assert.equal((await f.request("/api/providers/missing/model-context", "PUT", { model: "m", tokens: 32000 })).status, 404);
  assert.deepEqual(f.reads(), [0, 0]);
});

test("the command API carries saved main and pool windows into the next private launch", async t => {
  const f = await apiFixture(t); await f.save(32000);
  f.store.upsertProvider(provider("q", { m: 16000 }));
  f.store.upsertPool({ id: "mix", name: "mix", strategy: "order", members: ["p/m", "q/m"], createdAt: "" });
  const pools = await (await f.request("/api/pools", "GET", undefined)).json() as any;
  assert.deepEqual(pools.pools[0].context, { tokens: 16000, source: "pool" });
  const response = await f.request("/api/agents/kimi-cli/command", "POST", { model: "p/m" });
  assert.equal(response.status, 200);
  const command = await response.json() as any;
  const config = readFileSync(join(command.sessionDir, "kimi-home", "config.toml"), "utf8");
  assert.match(config, /model = "p\/m"\nmax_context_size = 32000/);
  assert.match(config, /model = "pool\/mix"\nmax_context_size = 16000/);
  await f.save(64000);
  assert.equal(readFileSync(join(command.sessionDir, "kimi-home", "config.toml"), "utf8"), config, "existing launch files are not rewritten");
  assert.deepEqual(f.reads(), [0, 0]);
});
