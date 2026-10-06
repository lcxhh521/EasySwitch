import assert from "node:assert/strict";
import { test } from "node:test";
import { quirksFor, ReasoningMemory, repairToolPairs, shapeChat, toolChoiceToChat, upstreamModelId } from "../src/quirks.ts";
import { endpointUrl } from "../src/upstream.ts";
import { outboundBody, convertOutput, sseResponse } from "./protocol-fixture.ts";
import type { ChatMessage, ChatRequest } from "../src/translate.ts";

test("a base URL that already names the endpoint is not doubled; bracket suffixes go", () => {
  const url = (baseUrl: string) => endpointUrl({ baseUrl }, "chat");
  assert.equal(url("https://relay.example.com/v1"), "https://relay.example.com/v1/chat/completions");
  assert.equal(url("https://relay.example.com/v1/chat/completions"), "https://relay.example.com/v1/chat/completions");
  assert.equal(url("https://copilot.tencent.com/v2/chat/completions/"), "https://copilot.tencent.com/v2/chat/completions");
  assert.equal(upstreamModelId("glm-5.3[1m]"), "glm-5.3");
  assert.equal(upstreamModelId("deepseek-chat"), "deepseek-chat");
});

test("tool_choice becomes Chat's shape; Kimi for Coding only gets auto/none", () => {
  const plain = quirksFor("https://api.deepseek.com/v1", "deepseek-chat");
  assert.deepEqual(toolChoiceToChat({ type: "function", name: "shell" }, plain), { type: "function", function: { name: "shell" } });
  assert.equal(toolChoiceToChat("required", plain), "required");
  const kimi = quirksFor("https://api.kimi.com/coding/v1", "kimi-for-coding");
  assert.equal(toolChoiceToChat("required", kimi), "auto");
  assert.equal(toolChoiceToChat("none", kimi), "none");
});

test("Codex's parallel_tool_calls:true is not forwarded; false is", async t => {
  const base = { model: "m", input: "x", tools: [{ type: "function", name: "t", parameters: {} }] };
  assert.equal((await outboundBody(t, "responses", { ...base, parallel_tool_calls: true })).body.parallel_tool_calls, undefined);
  assert.equal((await outboundBody(t, "responses", { ...base, parallel_tool_calls: false })).body.parallel_tool_calls, false);
});

test("tool pairs are repaired: late results move up, orphans become text, unanswered calls say so", () => {
  const call = (id: string) => ({ id, type: "function" as const, function: { name: "t", arguments: "{}" } });
  const messages: ChatMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    { role: "tool", tool_call_id: "b", content: "B" },
    { role: "user", content: "also" },
    { role: "tool", tool_call_id: "a", content: "A" },
    { role: "tool", tool_call_id: "zzz", content: "orphan" },
    { role: "assistant", content: "", tool_calls: [call("c")] },
  ];
  const out = repairToolPairs(messages);
  const shape = out.map(m => m.role === "tool" ? `tool:${m.tool_call_id}` : m.role);
  assert.deepEqual(shape.slice(0, 5), ["user", "assistant", "tool:a", "tool:b", "user"], "results follow their call, in call order");
  assert.ok(out.some(m => m.role === "tool" && m.tool_call_id === "c" && m.content === "[no result]"));
  assert.ok(out.some(m => m.role === "user" && String(m.content).includes("orphan")));
  assert.equal(out.filter(m => m.role === "tool" && m.tool_call_id === "zzz").length, 0);
});

test("reasoning is remembered by call id and replayed on the assistant tool turn", () => {
  const memory = new ReasoningMemory(3);
  memory.remember(["call_1"], "I should list the files first.");
  const chat: ChatRequest = {
    model: "deepseek-chat", stream: true,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "a b" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_gone", type: "function", function: { name: "ls", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_gone", content: "c" },
    ],
  };
  shapeChat(chat, { quirks: quirksFor("https://api.deepseek.com/v1", "deepseek-chat"), memory });
  const assistants = chat.messages.filter(m => m.role === "assistant") as Array<ChatMessage & { reasoning_content?: string }>;
  assert.equal(assistants[0]!.reasoning_content, "I should list the files first.");
  assert.equal(assistants[1]!.reasoning_content, " ", "forgotten reasoning is replaced by a blank the upstream accepts");
  assert.ok(assistants.every(a => a.content === ""), "null content becomes an empty string");
  // A provider that never asked for it gets nothing extra.
  const other: ChatRequest = { model: "gpt-x", stream: true, messages: [{ role: "assistant", content: null, tool_calls: [{ id: "x", type: "function", function: { name: "t", arguments: "{}" } }] }, { role: "tool", tool_call_id: "x", content: "r" }] };
  shapeChat(other, { quirks: quirksFor("https://api.openai.com/v1", "gpt-x"), memory });
  assert.equal("reasoning_content" in other.messages[0]!, false);
});

test("the memory is bounded", () => {
  const memory = new ReasoningMemory(2);
  memory.remember(["a"], "1"); memory.remember(["b"], "2"); memory.remember(["c"], "3");
  assert.equal(memory.recall("a"), undefined);
  assert.equal(memory.recall("c"), "3");
});

test("Kimi: locked sampling params go, $ref with siblings is flattened, a cache key is sent", () => {
  const chat: ChatRequest = {
    model: "kimi-k2.7", stream: true, temperature: 0.2, top_p: 0.9,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", function: { name: "t", description: "", parameters: { type: "object", properties: { p: { $ref: "#/$defs/P", description: "sibling" } }, $defs: { P: { type: "string" } } } } }],
  };
  shapeChat(chat, { quirks: quirksFor("https://api.kimi.com/coding/v1", "kimi-k2.7"), cacheKey: "sess-1" });
  assert.equal(chat.temperature, undefined);
  assert.equal(chat.top_p, undefined);
  assert.equal((chat as unknown as Record<string, unknown>).prompt_cache_key, "sess-1");
  const params = ((chat.tools![0] as Record<string, any>).function.parameters) as Record<string, any>;
  assert.deepEqual(params.properties.p, { type: "string" });
  assert.equal("$defs" in params, false);
});

test("xAI reasoning models lose `stop`", () => {
  const chat = { model: "grok-4", stream: true, messages: [{ role: "user", content: "x" }], stop: ["END"] } as unknown as ChatRequest;
  shapeChat(chat, { quirks: quirksFor("https://api.x.ai/v1", "grok-4") });
  assert.equal("stop" in chat, false);
});

test("real source events capture reasoning and tool ids for both response renderers", async () => {
  const chunks = [{ choices: [{ delta: { reasoning_content: "think " } }] }, { choices: [{ delta: { reasoning: "more" } }] }, { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "ls", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }];
  for (const target of ["responses", "messages"] as const) {
    const { downstream } = await convertOutput(sseResponse(chunks), "chat", target);
    assert.equal(downstream.items.filter(i => i.kind === "reasoning").map(i => i.text).join(""), "think more");
    assert.deepEqual(downstream.items.filter(i => i.kind === "call").map(i => i.callId), ["call_9"]);
  }
});

test("the thinking level is said the way each upstream wants it, and never to one that would not understand", async () => {
  const { applyEffort } = await import("../src/quirks.ts");
  const chat = () => ({ model: "m", messages: [], stream: false }) as never;
  const raw = (c: unknown) => c as Record<string, unknown>;
  const a = chat(); applyEffort(a, "medium", "effort");
  assert.equal(raw(a).reasoning_effort, "medium");
  const b = chat(); applyEffort(b, "max", "effort");
  assert.equal(raw(b).reasoning_effort, "high", "Chat stops at high");
  const c = chat(); applyEffort(c, "high", "none");
  assert.equal(raw(c).reasoning_effort, undefined, "an upstream that would 400 never sees it");
  const d = chat(); applyEffort(d, "Not A Level!", "effort");
  assert.equal(raw(d).reasoning_effort, undefined, "garbage is never sent");
  const d2 = chat(); applyEffort(d2, "ultra", "effort");
  assert.equal(raw(d2).reasoning_effort, "high", "an agent's own top level means as much as the scale goes");
  const d3 = chat(); applyEffort(d3, "none", "thinking");
  assert.deepEqual(raw(d3).thinking, { type: "disabled" }, "none turns thinking off where it is a switch");
  const e = chat(); applyEffort(e, "high", "thinking");
  assert.deepEqual(raw(e).thinking, { type: "enabled" });
  const f = chat(); applyEffort(f, "minimal", "thinking");
  assert.deepEqual(raw(f).thinking, { type: "disabled" }, "the lowest level is off on an on/off upstream");
  const g = chat(); applyEffort(g, "low", "enable_thinking");
  assert.equal(raw(g).enable_thinking, true);
  assert.equal(quirksFor("https://api.openai.com/v1", "gpt-5").reasoning, "effort");
  assert.equal(quirksFor("https://api.deepseek.com/v1", "deepseek-chat").reasoning, "thinking");
  assert.equal(quirksFor("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3").reasoning, "enable_thinking");
  assert.equal(quirksFor("https://example-relay.com/v1", "whatever").reasoning, "none");
});
