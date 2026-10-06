import assert from "node:assert/strict";
import { test } from "node:test";
import { shapePlanRequest } from "../src/responses-upstream.ts";
import { outboundBody, convertOutput, sseResponse } from "./protocol-fixture.ts";

const textResponse = () => sseResponse([
  { type: "response.output_text.delta", output_index: 0, delta: "Hel" },
  { type: "response.output_text.delta", output_index: 0, delta: "lo" },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } } } },
]);
const toolResponse = () => sseResponse([
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "get_weather" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"city":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"Paris"}' },
  { type: "response.completed", response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } } },
]);

test("actual selected plan adapter builds Responses directly and applies its required constraints", async t => {
  const { body, dropped } = await outboundBody(t, "chat", {
    stream: false, max_tokens: 100, temperature: 0.3,
    messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }, { role: "assistant", content: "calling", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: '{"a":1}' } }] }, { role: "tool", tool_call_id: "c1", content: "file.txt" }],
    tools: [{ type: "function", function: { name: "ls", parameters: { type: "object", properties: {} } } }], reasoning_effort: "high",
  }, "responses", { plan: { kind: "codex", accountId: "fixture-account" } });
  assert.equal(body.store, false); assert.equal(body.stream, true);
  for (const key of ["max_output_tokens", "temperature", "messages", "max_tokens"]) assert.equal(body[key], undefined);
  assert.equal(body.instructions, "be brief"); assert.equal(body.input[0].role, "user");
  assert.equal(body.input.find((x: any) => x.type === "function_call").call_id, "c1");
  assert.equal(body.input.find((x: any) => x.type === "function_call_output").output, "file.txt");
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.ok(dropped.includes("max_output_tokens") && dropped.includes("temperature"));
});

test("actual Chat-to-Responses source carries image blocks without Chat intermediate re-encoding", async t => {
  const { body } = await outboundBody(t, "chat", { messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] }, "responses");
  assert.deepEqual(body.input[0].content.map((p: any) => p.type), ["input_text", "input_image"]);
});

test("production plan shaping retains supported tools and uses developer instructions", () => {
  const { body, dropped } = shapePlanRequest({ model: "m", store: true, stream: false, temperature: 0.2, metadata: { a: 1 }, previous_response_id: "x", max_output_tokens: 10, input: [{ type: "message", role: "system", content: "s" }], tools: [{ type: "function", name: "f" }, { type: "image_generation" }, { type: "tool_search" }] });
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.equal(body.temperature, undefined);
  assert.equal((body.input as any[])[0].role, "developer"); assert.deepEqual((body.tools as any[]).map(t => t.type), ["function"]);
  assert.ok(dropped.includes("temperature") && dropped.includes("tool:image_generation") && dropped.includes("previous_response_id"));
});

test("real Responses decoder to Chat renderer preserves streamed text and usage", async () => {
  const { result, events } = await convertOutput(textResponse(), "responses", "chat");
  assert.equal(result.choices[0].message.content, "Hello"); assert.equal(result.usage.prompt_tokens, 10);
  assert.equal(result.usage.prompt_tokens_details.cached_tokens, 4);
  assert.equal(events.map(e => e.choices?.[0]?.delta?.content ?? "").join(""), "Hello");
});

test("real Responses decoder to Chat renderer preserves fragmented call identity and arguments", async () => {
  const { result } = await convertOutput(toolResponse(), "responses", "chat");
  assert.deepEqual(result.choices[0].message.tool_calls[0], { id: "call_9", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } });
  assert.equal(result.choices[0].finish_reason, "tool_calls");
});

test("real pipeline renders complete Responses JSON without the removed conversion wrapper", async () => {
  const { result } = await convertOutput(Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "complete" }] }], usage: { input_tokens: 2, output_tokens: 1 } }), "responses", "chat");
  assert.equal(result.choices[0].message.content, "complete"); assert.equal(result.usage.completion_tokens, 1);
});

test("failed and interrupted Responses streams never become successful Chat answers", async () => {
  await assert.rejects(convertOutput(sseResponse([{ type: "response.failed", response: { error: { code: "fixture_limit", message: "fixture failure" } } }]), "responses", "chat"));
  await assert.rejects(convertOutput(sseResponse([{ type: "response.output_text.delta", output_index: 0, delta: "unfinished" }]), "responses", "chat"));
});
