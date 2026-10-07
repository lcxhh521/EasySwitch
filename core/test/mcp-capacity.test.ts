import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { handleMcp, MAX_CONCURRENT, type McpDeps } from "../src/mcp.ts";
import { Store } from "../src/store.ts";

type Json = Record<string, any>;
const success = { exitCode: 0, output: "fixture answer", timedOut: false, model: "p/m" };
const agents = [{ id: "fixture", name: "Fixture agent", model: "p/m" }];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(t: { after(fn: () => void): void }, depth = 0) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-mcp-capacity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const auth = new GatewayTokenAuthority();
  const issued = auth.issue("qwen-code", { allowMcp: true, depth });
  const session = auth.authenticate({ authorization: `Bearer ${issued.token}` }, undefined, "mcp")!;
  const deps: McpDeps = {
    store: new Store(dir), log: () => {}, session,
    secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} },
    agents: async () => agents, run: async () => success,
  };
  const invoke = async (args: Json = { agent: "fixture", task: "safe fake task" }) => {
    let output = "";
    const req = { method: "POST", headers: { authorization: `Bearer ${issued.token}`, "x-easyswitch-depth": "0", "x-easyswitch-agent": "codex" } } as never;
    const res = { writeHead: () => res, end: (value?: string) => { output = value ?? ""; } } as never;
    await handleMcp(req, res, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_agent", arguments: args } }), deps);
    return (JSON.parse(output) as Json).result as { isError?: boolean; content: Array<{ text: string }> };
  };
  return { deps, invoke };
}

test("MCP reserves capacity before asynchronous discovery, so simultaneous callers never start a fourth run", async t => {
  const { deps, invoke } = fixture(t);
  const discovery = deferred<typeof agents>(), running = deferred<typeof success>();
  let discoveries = 0, active = 0, peak = 0;
  deps.agents = async () => { discoveries++; return discovery.promise; };
  deps.run = async () => { active++; peak = Math.max(peak, active); try { return await running.promise; } finally { active--; } };
  const calls = Array.from({ length: MAX_CONCURRENT + 1 }, () => invoke());
  try {
    await setImmediate();
    assert.equal(discoveries, MAX_CONCURRENT);
    const denied = await calls[MAX_CONCURRENT]!;
    assert.equal(denied.isError, true); assert.match(denied.content[0]!.text, /already in progress/);
    discovery.resolve(agents);
    await setImmediate();
    assert.equal(active, MAX_CONCURRENT); assert.equal(peak, MAX_CONCURRENT);
    running.resolve(success);
    const results = await Promise.all(calls);
    assert.equal(results.filter(result => result.isError).length, 1);
    assert.equal((await invoke()).isError, undefined, "completed work releases its reserved slot");
  } finally { discovery.resolve(agents); running.resolve(success); await Promise.allSettled(calls); }
});

test("discovery errors, unavailable agents and runner failures all release their reserved MCP slot", async t => {
  const { deps, invoke } = fixture(t);
  for (let i = 0; i < MAX_CONCURRENT + 1; i++) {
    deps.agents = async () => { throw new Error("fixture discovery error"); };
    const discoveryFailure=await invoke();assert.equal(discoveryFailure.isError,true);assert.match(discoveryFailure.content[0]!.text,/任务未能完成/);assert.doesNotMatch(discoveryFailure.content[0]!.text,/fixture discovery error/);
    deps.agents = async () => [];
    assert.match((await invoke()).content[0]!.text, /Unknown or unavailable/);
    deps.agents = async () => agents;
    deps.run = async () => { throw new Error("fixture runner error"); };
    const runnerFailure=await invoke();assert.equal(runnerFailure.isError,true);assert.match(runnerFailure.content[0]!.text,/任务未能完成/);assert.doesNotMatch(runnerFailure.content[0]!.text,/fixture runner error/);
  }
  deps.run = async () => success;
  assert.equal((await invoke()).isError, undefined);
});

test("MCP runner receives authority-derived caller and depth, never spoofed body or header values", async t => {
  const { deps, invoke } = fixture(t, 1);
  let received: Parameters<McpDeps["run"]>[1] | undefined;
  deps.run = async (_agent, input) => { received = input; return success; };
  const result = await invoke({ agent: "fixture", task: "safe fake task", depth: 0, from: "codex" });
  assert.equal(result.isError, undefined);
  assert.equal(received?.depth, 2);
  assert.equal(received?.from, "qwen-code");
});

test("maximum-depth MCP requests reject before reserving capacity or discovering installed agents", async t => {
  const { deps, invoke } = fixture(t, 2);
  let called = false;
  deps.agents = async () => { called = true; throw new Error("must not discover"); };
  const result = await invoke();
  assert.equal(result.isError, true); assert.match(result.content[0]!.text, /nest at most 2/);
  assert.equal(called, false);
});
