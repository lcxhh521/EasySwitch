import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { prepareOutbound } from "../src/outbound.ts";
import { decodeRequest } from "../src/inbound.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { createSecretStore } from "../src/secrets.ts";
import { Store } from "../src/store.ts";
import { fixtureFetch } from "./gateway-client.ts";
import type { Provider, ApiProtocol } from "../src/types.ts";
import type { InboundRequest } from "../src/protocol.ts";
const provider = (baseUrl = "https://relay.invalid/v1", protocol: ApiProtocol = "chat"): Provider => ({ id: "p", name: "Fixture", baseUrl, models: ["m"], protocols: [protocol], route: "chat-translate", streamUsage: false, routePinned: true, createdAt: "" });
async function capture(t: TestContext, p: Provider, input: InboundRequest) {
  let sent: any;
  const original = globalThis.fetch;
  globalThis.fetch = async (_url: unknown, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return Response.json({}); };
  try { const prepared = prepareOutbound(p, input); await prepared.send("fixture-key", new AbortController().signal); return { sent, prepared }; }
  finally { globalThis.fetch = original; }
}

test("same-protocol Chat egress repairs missing tool results and null assistant content", async t => {
  const body = { messages: [{ role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read", arguments: "{}" } }] }, { role: "user", content: "continue" }], vendor_extension: { retain: true } };
  const { sent } = await capture(t, provider(), { protocol: "chat", model: "m", stream: false, body });
  assert.equal(sent.messages[0].content, ""); assert.deepEqual(sent.messages[1], { role: "tool", tool_call_id: "c", content: "[no result]" });
  assert.deepEqual(sent.vendor_extension, { retain: true }); assert.equal(body.messages[0]!.content, null);
});

test("agent-supplied effort cannot enable vendor thinking without a saved explicit override", async t => {
  for (const [base, model] of [["https://api.deepseek.com", "deepseek-v4-flash"], ["https://open.bigmodel.cn/api/paas/v4", "glm-5.3"], ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3"]]) {
    const input: InboundRequest = { protocol: "responses", model: model!, stream: false, body: { input: "hello", reasoning: { effort: "high" } } };
    const { sent } = await capture(t, provider(base), input);
    assert.equal(sent.thinking, undefined); assert.equal(sent.enable_thinking, undefined);
    const override = await capture(t, provider(base), { ...input, effort: "high" });
    assert.ok(override.sent.thinking?.type === "enabled" || override.sent.enable_thinking === true);
  }
});

test("valid native thinking settings and third-party Messages schema remain intact without account identity", async t => {
  const body = { messages: [{ role: "user", content: "hello" }], max_tokens: 20, metadata: { user_id: "private-account", tag: "keep" }, output_config: { format: { type: "json_schema", schema: { type: "object" } } }, thinking: { type: "adaptive" }, context_management: { edits: [] }, safeguards: { value: true } };
  const { sent, prepared } = await capture(t, provider("https://compatible.invalid/messages", "messages"), { protocol: "messages", model: "m", stream: false, body });
  assert.deepEqual(sent.output_config, body.output_config); assert.deepEqual(sent.thinking, body.thinking);
  assert.deepEqual(sent.context_management, body.context_management); assert.deepEqual(sent.safeguards, body.safeguards);
  assert.deepEqual(sent.metadata, { tag: "keep" }); assert.ok(prepared.dropped.includes("field:metadata.user_id"));
  const glm = await capture(t, provider("https://open.bigmodel.cn/api/anthropic", "messages"), { protocol: "messages", model: "glm-5.3", stream: false, body });
  assert.deepEqual(glm.sent.output_config.format, body.output_config.format); assert.equal(glm.sent.thinking, undefined);
  const native = await capture(t, provider("https://api.deepseek.com"), { protocol: "chat", model: "deepseek-v4-flash", stream: false, body: { messages: [{ role: "user", content: "x" }], thinking: { type: "enabled" }, reasoning_effort: "low" } });
  assert.deepEqual(native.sent.thinking, { type: "enabled" }); assert.equal(native.sent.reasoning_effort, "low");
});

test("Messages session cache identity is hashed at the ordinary Kimi Chat boundary", async t => {
  const { sent } = await capture(t, provider("https://api.kimi.com/coding/v1"), { protocol: "messages", model: "kimi-for-coding", stream: false, body: { metadata: { user_id: "fixture-private-session" }, messages: [{ role: "user", content: "x" }], max_tokens: 20 } });
  assert.equal(sent.prompt_cache_key, createHash("sha256").update("fixture-private-session").digest("hex").slice(0, 32));
  assert.ok(!JSON.stringify(sent).includes("fixture-private-session"));
});

test("optional built-in tools are recorded, but forcing a dropped or unknown tool fails explicitly", () => {
  const body = { input: "hello", tools: [{ type: "web_search" }, { type: "function", name: "read", parameters: {} }] };
  assert.ok(decodeRequest({ protocol: "responses", model: "m", stream: false, body }).dropped.includes("tool:web_search"));
  for (const tool_choice of [{ type: "web_search" }, { type: "function", name: "missing" }, { type: "function" }]) assert.throws(() => decodeRequest({ protocol: "responses", model: "m", stream: false, body: { ...body, tool_choice } }), /指定/);
  const valid = decodeRequest({ protocol: "responses", model: "m", stream: false, body: { ...body, tool_choice: { type: "function", name: "read" } } });
  assert.deepEqual(valid.choice, { name: "read" });
  assert.throws(() => decodeRequest({ protocol: "messages", model: "m", stream: false, body: { messages: [{ role: "user", content: "hello" }], tools: [{ type: "web_search_20250305", name: "web_search" }], tool_choice: { type: "tool", name: "web_search" } } }), /指定/);
  assert.throws(() => decodeRequest({ protocol: "gemini", model: "m", stream: false, body: { contents: [{ role: "user", parts: [{ text: "hello" }] }], tools: [{ googleSearch: {} }], toolConfig: { functionCallingConfig: { mode: "ANY" } } } }), /指定/);
});

for (const inbound of ["chat", "responses"] as const) test(`${inbound}: interrupted output keeps already reported usage without a success terminal`, async t => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-partial-usage-"));
  const upstream = createServer((req, res) => { req.resume(); res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":7,"completion_tokens":3}}\n\n'); setTimeout(() => res.destroy(), 25); });
  await new Promise<void>(r => upstream.listen(0, "127.0.0.1", r));
  const store = new Store(dir); store.upsertProvider(provider(`http://127.0.0.1:${(upstream.address() as { port: number }).port}`));
  const secrets = createSecretStore(); await secrets.set("p", "fixture-key");
  const server = createEasySwitchServer({ store, secrets, port: 0 }); await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { for (const s of [server, upstream]) { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())); } rmSync(dir, { recursive: true, force: true }); });
  const response = await fixtureFetch(base + (inbound === "chat" ? "/v1/chat/completions" : "/v1/responses"), { method: "POST", body: JSON.stringify({ model: "p/m", stream: true, ...(inbound === "chat" ? { messages: [{ role: "user", content: "hi" }] } : { input: "hi" }) }) });
  if (inbound === "chat") await assert.rejects(response.text()); else assert.doesNotMatch(await response.text(), /response\.completed/);
  await new Promise(r => setTimeout(r, 10));
  const state = await (await fixtureFetch(base + "/api/state")).json() as any;
  assert.equal(state.log[0].inputTokens, 7); assert.equal(state.log[0].outputTokens, 3); assert.notEqual(state.log[0].status, 200);
});
