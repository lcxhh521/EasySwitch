import assert from "node:assert/strict";
import { test } from "node:test";
import { chatToResponses, responsesToChatResponse, shapePlanRequest } from "../src/responses-upstream.ts";

type Json = Record<string, any>;

const sse = (events: Array<[string, Json]>) =>
  new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });

const TEXT: Array<[string, Json]> = [
  ["response.created", { type: "response.created", response: { id: "r" } }],
  ["response.output_text.delta", { delta: "Hel" }],
  ["response.output_text.delta", { delta: "lo" }],
  ["response.completed", { response: { status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4 } } } }],
];

const TOOL: Array<[string, Json]> = [
  ["response.output_item.added", { item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "get_weather" } }],
  ["response.function_call_arguments.delta", { item_id: "fc_1", delta: '{"city":' }],
  ["response.function_call_arguments.delta", { item_id: "fc_1", delta: '"Paris"}' }],
  ["response.completed", { response: { status: "completed", usage: { input_tokens: 5, output_tokens: 3 } } }],
];

test("a Chat request becomes a Responses request the plan route accepts: system as instructions, no refused fields, store false, stream true", () => {
  const { body, dropped } = chatToResponses({
    model: "gpt-fake", stream: false, max_tokens: 100, temperature: 0.3,
    messages: [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "calling", tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: '{"a":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "file.txt" },
    ],
    tools: [{ type: "function", function: { name: "ls", description: "list", parameters: { type: "object", properties: {} } } }],
    tool_choice: "auto", reasoning_effort: "high",
  } as never);
  assert.equal(body.instructions, "be brief");
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  for (const k of ["max_output_tokens", "temperature", "top_p", "messages", "max_tokens"]) assert.equal(body[k], undefined, k);
  assert.ok(!JSON.stringify(body.input).includes('"role":"system"'));
  const input = body.input as Json[];
  assert.deepEqual(input.map(i => i.type), ["message", "message", "function_call", "function_call_output"]);
  assert.equal(input[2]!.call_id, "c1");
  assert.equal(input[3]!.output, "file.txt");
  assert.equal((body.tools as Json[])[0]!.name, "ls");
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.deepEqual(dropped.sort(), ["max_tokens", "temperature"]);
});

test("images in a user message travel as input_image", () => {
  const { body } = chatToResponses({ model: "m", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] } as never);
  assert.deepEqual((body.input as Json[])[0]!.content.map((p: Json) => p.type), ["input_text", "input_image"]);
});

test("a Responses request from Codex is made acceptable: refused fields and tools go, system becomes developer", () => {
  const { body, dropped } = shapePlanRequest({
    model: "m", store: true, stream: false, temperature: 0.2, metadata: { a: 1 }, previous_response_id: "x", max_output_tokens: 10,
    input: [{ type: "message", role: "system", content: "s" }, { type: "message", role: "user", content: "u" }],
    tools: [{ type: "function", name: "f" }, { type: "image_generation" }, { type: "tool_search" }],
  });
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.temperature, undefined);
  assert.equal((body.input as Json[])[0]!.role, "developer");
  assert.deepEqual((body.tools as Json[]).map(t => t.type), ["function"]);
  assert.ok(dropped.includes("temperature") && dropped.includes("tool:image_generation") && dropped.includes("previous_response_id"));
});

test("a Responses text stream becomes Chat chunks, with usage and a stop reason at the end", async () => {
  const out = await responsesToChatResponse(sse(TEXT), { stream: true, model: "gpt-fake" }).text();
  const events = out.split("\n\n").filter(Boolean).map(b => b.replace(/^data: /, ""));
  assert.equal(events.at(-1), "[DONE]");
  const chunks = events.slice(0, -1).map(e => JSON.parse(e) as Json);
  assert.equal(chunks.map(c => c.choices[0].delta.content ?? "").join(""), "Hello");
  const last = chunks.at(-1)!;
  assert.equal(last.choices[0].finish_reason, "stop");
  assert.deepEqual(last.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4 } });
});

test("a function call keeps its id and name and its arguments arrive in pieces; the stop reason says tool_calls", async () => {
  const out = await responsesToChatResponse(sse(TOOL), { stream: true, model: "m" }).text();
  const chunks = out.split("\n\n").filter(Boolean).map(b => b.replace(/^data: /, "")).filter(e => e !== "[DONE]").map(e => JSON.parse(e) as Json);
  const calls = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []);
  assert.equal(calls[0].id, "call_9");
  assert.equal(calls[0].function.name, "get_weather");
  assert.equal(calls.map((c: Json) => c.function.arguments).join(""), '{"city":"Paris"}');
  assert.equal(chunks.at(-1)!.choices[0].finish_reason, "tool_calls");
});

test("without streaming, one Chat answer comes back, with tool calls and usage", async () => {
  const text = JSON.parse(await responsesToChatResponse(sse(TEXT), { stream: false, model: "m" }).text()) as Json;
  assert.equal(text.object, "chat.completion");
  assert.equal(text.choices[0].message.content, "Hello");
  assert.equal(text.usage.completion_tokens, 2);
  const tool = JSON.parse(await responsesToChatResponse(sse(TOOL), { stream: false, model: "m" }).text()) as Json;
  assert.equal(tool.choices[0].message.tool_calls[0].function.arguments, '{"city":"Paris"}');
  assert.equal(tool.choices[0].finish_reason, "tool_calls");
});

test("a failed response is passed on as an error, and a stream that just stops is reported as interrupted", async () => {
  const failed = await responsesToChatResponse(sse([["response.failed", { response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } } }]]), { stream: true, model: "m" }).text();
  assert.match(failed, /subscription_sharing_usage_limit_exceeded/);
  const cut = await responsesToChatResponse(sse([["response.output_text.delta", { delta: "x" }]]), { stream: true, model: "m" }).text();
  assert.match(cut, /stream_interrupted/);
});
