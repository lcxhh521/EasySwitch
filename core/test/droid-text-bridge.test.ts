import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareDroidTextBridge, type DroidTextSession, type DroidTextTransport } from "../src/droid-text-bridge.ts";
import type { InboundRequest } from "../src/protocol.ts";

const input: InboundRequest = { protocol: "chat", model: "fixture-model", stream: false, body: { messages: [{ role: "user", content: "hello" }] } };
function fixture(options: { toolsStayOn?: boolean; badCatalog?: boolean; toolEvent?: boolean; noResult?: boolean } = {}) {
  const calls: string[] = []; let disabled = false;
  const session: DroidTextSession = {
    async listTools() { calls.push("list"); return options.badCatalog ? [{ id: "Execute" }] as never : [{ id: "Execute", allowed: !disabled || !!options.toolsStayOn }, { id: "Read", allowed: !disabled || !!options.toolsStayOn }]; },
    async updateSettings(value) { calls.push("disable"); assert.deepEqual(value.disabledToolIds, ["Execute", "Read"]); disabled = true; },
    async *stream(prompt, opts) { calls.push("prompt"); assert.equal(prompt, "hello"); assert.ok(opts.abortSignal); if (options.toolEvent) yield { type: "tool_call" }; if (!options.noResult) yield { type: "result", success: true, subtype: "success", text: "answer" }; },
    async close() { calls.push("close"); },
  };
  const transport: DroidTextTransport = { capabilities: { isolatedHomeAndCwd: true, noAmbientMcpOrHooks: true, ephemeralSession: true, denyAllPermissions: true }, async open(value) { calls.push("open"); assert.equal(value.apiKey, "fixture-key"); assert.equal(value.autonomyLevel, "off"); assert.equal(value.autoRejectPermissionRequests, true); assert.equal(value.disableBuiltinSkills, true); assert.deepEqual(value.mcpServers, []); return session; } };
  return { transport, calls };
}

test("Droid production is explicitly unavailable rather than inventing no-tools flags or loading an SDK", async () => {
  const response = await prepareDroidTextBridge(input).send("fixture-key", new AbortController().signal);
  assert.ok(response instanceof Response); assert.equal(response.status, 501);
});

test("Droid discovers, disables and verifies every tool before it sends a prompt", async () => {
  const f = fixture();
  const response = await prepareDroidTextBridge(input, f.transport).send("fixture-key", new AbortController().signal);
  assert.ok(response instanceof Response); assert.equal(response.status, 200);
  assert.equal((await response.json() as any).choices[0].message.content, "answer");
  assert.deepEqual(f.calls, ["open", "list", "disable", "list", "prompt", "close"]);
});

test("Droid fails closed on missing host guarantees or unverifiable tool state", async () => {
  for (const mode of ["capability", "catalog", "enabled"] as const) {
    const f = fixture({ badCatalog: mode === "catalog", toolsStayOn: mode === "enabled" });
    if (mode === "capability") f.transport.capabilities.noAmbientMcpOrHooks = false;
    const response = await prepareDroidTextBridge(input, f.transport).send("fixture-key", new AbortController().signal);
    assert.ok(response instanceof Response); assert.equal(response.status, 501);
    assert.ok(!f.calls.includes("prompt"));
    if (mode === "capability") assert.deepEqual(f.calls, []); else assert.equal(f.calls.at(-1), "close");
  }
});

test("Droid rejects tool events and missing terminal success instead of inventing a completed answer", async () => {
  for (const mode of ["tool", "cut"] as const) {
    const f = fixture({ toolEvent: mode === "tool", noResult: mode === "cut" });
    const response = await prepareDroidTextBridge(input, f.transport).send("fixture-key", new AbortController().signal);
    assert.ok(response instanceof Response); assert.equal(response.status, mode === "tool" ? 501 : 502); assert.equal(f.calls.at(-1), "close");
  }
});

test("Droid missing keys, aborts and unsupported tools cannot open a transport", async () => {
  const f = fixture();
  const noKey = await prepareDroidTextBridge(input, f.transport).send(undefined, new AbortController().signal); assert.ok(noKey instanceof Response); assert.equal(noKey.status, 401);
  const abort = new AbortController(); abort.abort();
  const cancelled = await prepareDroidTextBridge(input, f.transport).send("fixture-key", abort.signal); assert.ok(cancelled instanceof Response); assert.equal(cancelled.status, 499);
  assert.deepEqual(f.calls, []);
  assert.throws(() => prepareDroidTextBridge({ ...input, body: { ...input.body, tools: [{ type: "function", function: { name: "f", parameters: {} } }] } }, f.transport));
});
