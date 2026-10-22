import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { test, type TestContext } from "node:test";
import vm from "node:vm";
import * as pools from "../src/pools.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { Pool, Provider } from "../src/types.ts";

// Synthetic providers, memory responses, VM scripts and loopback only. No
// discovery, credentials, model requests or real clients are used here.
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "es-pool-transparency-"));
  t.after(() => { pools.clearRest(); rmSync(dir, { recursive: true, force: true }); });
  const store = new Store(dir);
  const add = (id: string, extra: Partial<Provider> = {}) => {
    const p: Provider = { id, name: id, baseUrl: "http://127.0.0.1:1/v1", models: ["fixture"], route: "chat-translate", routePinned: false, streamUsage: true, createdAt: "2026-01-01T00:00:00Z", ...extra };
    store.upsertProvider(p); return p;
  };
  add("first"); add("second");
  const pool: Pool = { id: "fixture", name: "Fixture", strategy: "order", members: ["first/fixture", "second/fixture"], createdAt: "2026-01-01T00:00:00Z" };
  store.upsertPool(pool);
  return { dir, store, add, pool };
}

function browser() {
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#providers" }, window: { addEventListener() {} }, document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], activeElement: null }, history: { replaceState() {} }, setTimeout: () => 0, clearTimeout() {}, console });
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (source: string): any => vm.runInContext(source, context);
  run('state={providers:[],pools:[]};');
  return { context, run };
}

test("pool member diagnostics distinguish disabled, budget-blocked, unsupported and missing metadata without claiming health", t => {
  const { store, pool, add, dir } = fixture(t);
  add("off", { off: true }); add("budget"); add("removed-model", { models: ["different"] });
  add("droid", { cliTextBridge: { kind: "droid" } as Provider["cliTextBridge"] });
  pool.members.push("off/fixture", "budget/fixture", "removed-model/fixture", "droid/fixture", "gone/fixture");
  store.upsertPool(pool); store.setProviderBudgetChecker(p => p.id === "budget");
  const before = readFileSync(join(dir, "state.json"), "utf8");
  const report = pools.poolMemberStates(store, pool);
  assert.deepEqual(report.map(r => [r.member, r.reason]), [
    ["first/fixture", "catalog_eligible"], ["second/fixture", "catalog_eligible"], ["off/fixture", "source_disabled"],
    ["budget/fixture", "budget_blocked"], ["removed-model/fixture", "model_missing"], ["droid/fixture", "unsupported"], ["gone/fixture", "source_missing"],
  ]);
  assert.deepEqual(report.filter(r => r.selectable).map(r => r.member), pools.liveMembers(store, pool));
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
  assert.doesNotMatch(JSON.stringify(report), /healthy|remaining|apiKey|127\.0\.0\.1/);
});

test("pool cards do not call disabled or budget-paused sources deleted, and old snapshots stay uncertain", () => {
  const app = browser();
  app.run(`state.providers=[{id:"off",name:"Off",models:["fixture"]},{id:"budget",name:"Budget",models:["fixture"]}];
    state.pools=[{id:"p",name:"Fixture",strategy:"order",members:["off/fixture","budget/fixture"],live:[],memberStates:[
      {member:"off/fixture",selectable:false,reason:"source_disabled"},{member:"budget/fixture",selectable:false,reason:"budget_blocked"}]}];`);
  const html = app.run("poolsCard()");
  assert.match(html, /来源已关闭/); assert.match(html, /预算暂停/);
  assert.doesNotMatch(html, /来源已经不存在了/);
  assert.match(html, /不代表.*实际可用/);
  app.run("delete state.pools[0].memberStates");
  assert.match(app.run("poolsCard()"), /原因未提供/);
  assert.doesNotMatch(app.run("poolsCard()"), /来源已删除|来源已经不存在了/);
  app.run('state.pools[0].memberStates=[{member:"off/fixture",selectable:false,reason:"<img src=x onerror=alert(1)>"}]');
  assert.match(app.run("poolsCard()"), /原因未提供/);
  assert.doesNotMatch(app.run("poolsCard()"), /<img src=x/);
  app.run('state.pools[0].memberStates=[{member:"off/fixture",selectable:false,reason:"source_missing"},{member:"budget/fixture",selectable:false,reason:"model_missing"}]');
  assert.match(app.run("poolsCard()"), /找不到来源记录.*当前目录未列出此模型/);
});

test("a failed candidate log never claims a later retry without explicit attempt evidence", () => {
  const app = browser();
  for (const status of [400, 401, 429, 503]) {
    app.context.entry = { model: "first/fixture", route: "chat-translate", pool: "pool/p", attempt: 1, attempts: 2, status, ms: 1 };
    const why = app.run("explain(entry).why");
    assert.doesNotMatch(why, /已经换下一个|已改试|成功切换/);
  }
  app.context.entry = { model: "second/fixture", route: "chat-translate", pool: "pool/p", attempt: 2, attempts: 2, status: 200, ms: 1 };
  assert.doesNotMatch(app.run("explain(entry).why"), /已改试/, "old records are not backfilled by inference");
  app.context.entry.retryFrom = { attempt: 1, status: 400 };
  assert.doesNotMatch(app.run("explain(entry).why"), /已改试/, "an impossible retry reason is not presented as evidence");
});

class MemoryResponse extends Writable {
  headersSent = false;
  statusCode = 200;
  chunks: string[] = [];
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { this.chunks.push(chunk.toString()); done(); }
}

test("actual subsequent attempts carry immutable previous-failure evidence; ordinary errors and disconnects do not", async t => {
  const { store } = fixture(t);
  for (const statuses of [[503, 200], [429, 401], [400], [200]]) {
    pools.clearRest();
    const response = new MemoryResponse(), contexts: any[] = [];
    await pools.runWithPool(store, "pool/fixture", response as unknown as ServerResponse, async (res, _member, ctx) => {
      contexts.push(structuredClone(ctx)); res.writeHead(statuses[contexts.length - 1]!); res.end("fixture");
    });
    assert.equal(contexts.length, statuses.length);
    assert.equal(contexts[0].retryFrom, undefined);
    if (statuses.length > 1) assert.deepEqual(contexts[1].retryFrom, { member: "first/fixture", attempt: 1, status: statuses[0] });
  }
  pools.clearRest();
  const response = new MemoryResponse(), contexts: any[] = [];
  await pools.runWithPool(store, "pool/fixture", response as unknown as ServerResponse, async (res, _member, ctx) => {
    contexts.push(structuredClone(ctx)); res.writeHead(503); res.end("fixture"); response.destroy();
  });
  assert.equal(contexts.length, 1); assert.equal(contexts[0].retryFrom, undefined);
  pools.clearRest();
  const stream = new MemoryResponse(), streamed: any[] = [];
  await pools.runWithPool(store, "pool/fixture", stream as unknown as ServerResponse, async (res, _member, ctx) => {
    streamed.push(structuredClone(ctx)); res.writeHead(200); res.write("partial fixture"); res.destroy();
  });
  assert.equal(streamed.length, 1, "a partial reply cannot be replayed to another candidate");
  assert.equal(streamed[0].retryFrom, undefined);
});

test("retry explanation describes an attempt rather than success or guaranteed upstream transmission", () => {
  const app = browser();
  app.context.entry = { model: "second/fixture", route: "chat-translate", pool: "pool/p", attempt: 2, attempts: 2, retryFrom: { member: "first/fixture", attempt: 1, status: 503 }, status: 401, ms: 1 };
  const why = app.run("explain(entry).why");
  assert.match(why, /已改试.*不代表.*成功/);
  assert.doesNotMatch(why, /成功切换|保证|已经发送/);
});

test("pool status API reads metadata without credentials, discovery, rotation or persistent writes", async t => {
  const { store, pool, dir } = fixture(t); pool.strategy = "rotate"; store.upsertPool(pool);
  const server = createEasySwitchServer({ store, port: 0, secrets: { async get() { assert.fail("no credentials"); }, async set() { assert.fail("no credentials"); }, async delete() { assert.fail("no credentials"); } },
    interactiveRuntime: { async findBinary() { assert.fail("no discovery"); }, newSessionDir() { assert.fail("no private HOME"); }, async launchInTerminal() { assert.fail("no launch"); } },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const before = readFileSync(join(dir, "state.json"), "utf8");
  const get = () => new Promise<any>((resolve, reject) => { request(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/pools`, res => { let text = ""; res.on("data", b => text += b); res.on("end", () => resolve(JSON.parse(text))); }).on("error", reject).end(); });
  for (let i = 0; i < 3; i++) {
    const result = await get(); assert.equal(result.pools[0].memberStates[0].reason, "catalog_eligible");
  }
  assert.deepEqual(pools.poolMembers(store, "pool/fixture"), pool.members, "reading status never consumes a rotate turn");
  assert.equal(readFileSync(join(dir, "state.json"), "utf8"), before);
});
