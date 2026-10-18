import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { Downstream } from "../src/downstream.ts";
import { readOutput } from "../src/upstream-events.ts";
import { OUTPUT_LIMITS, ProtocolError, unpackState, type Json, type Tool } from "../src/protocol.ts";
import type { ApiProtocol } from "../src/types.ts";

/** Deliberately withhold the next frame: assertions below prove output arrives before EOF. */
function staged(source: ApiProtocol, target: ApiProtocol, tools: Tool[] = []) {
  let controller!: ReadableStreamDefaultController<Uint8Array>; let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, cancel() { cancelled = true; } });
  const chunks: string[] = [];
  const out = new Downstream(target, "m", "source", source, tools, chunk => chunks.push(chunk));
  const done = (async () => {
    for await (const e of readOutput(new Response(body, { headers: { "content-type": "text/event-stream" } }), source)) out.accept(e);
    out.finish();
  })().then(() => undefined, (error: unknown) => { out.fail("test upstream failure"); return error; });
  const push = async (j: Json) => { controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(j) + "\n\n")); await setImmediate(); };
  const events = (): Json[] => chunks.flatMap(c => c.split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]").map(l => JSON.parse(l.slice(6))));
  const parts = (): Json[] => events().flatMap(e => e.candidates?.[0]?.content?.parts ?? []);
  return { out, chunks, push, events, parts, done, controller, cancelled: () => cancelled, async end(j: Json) { await push(j); controller.close(); assert.equal(await done, undefined); } };
}

for (const target of ["messages", "gemini"] as const) test(`Responses -> ${target}: thinking, secondary text and tools arrive while upstream is paused`, async () => {
  const r = staged("responses", target);
  await r.push({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "consider " });
  assert.match(r.chunks.join(""), /consider /, "thinking must not wait for its signature or the rest of the response");
  await r.push({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "carefully" });
  await r.push({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", summary: [{ text: "consider carefully" }], encrypted_content: "fake-encrypted" } });
  if (target === "messages") {
    const events = r.events(); const stop = events.findIndex(e => e.type === "content_block_stop");
    assert.equal(events[stop - 1]?.delta?.type, "signature_delta");
    const saved = unpackState(events[stop - 1]!.delta.signature, "source", "m");
    assert.equal(saved?.text, "consider carefully"); assert.equal(saved?.encrypted, "fake-encrypted");
  } else {
    const saved = unpackState(r.parts().at(-1)!.thoughtSignature, "source", "m");
    assert.equal(saved?.text, "consider carefully");
  }
  await r.push({ type: "response.output_text.delta", output_index: 1, delta: "visible " });
  assert.match(r.chunks.join(""), /visible /, "text after thinking must arrive before any tool or terminal event");
  await r.push({ type: "response.output_text.delta", output_index: 1, delta: "answer" });
  await r.push({ type: "response.output_item.done", output_index: 1, item: { type: "message", content: [{ type: "output_text", text: "visible answer" }] } });
  await r.push({ type: "response.output_item.added", output_index: 2, item: { type: "function_call", call_id: "c1", name: "shell", arguments: "" } });
  await r.push({ type: "response.function_call_arguments.delta", output_index: 2, delta: '{"cmd":"' });
  if (target === "messages") {
    assert.ok(r.events().some(e => e.content_block?.type === "tool_use"));
    assert.ok(r.events().some(e => e.delta?.partial_json === '{"cmd":"'), "raw tool argument deltas stream before their JSON is complete");
  } else assert.equal(r.parts().filter(p => p.functionCall).length, 0, "ordinary Gemini args must remain a valid complete object");
  await r.push({ type: "response.function_call_arguments.delta", output_index: 2, delta: 'ls"}' });
  await r.push({ type: "response.output_item.done", output_index: 2, item: { type: "function_call", call_id: "c1", name: "shell", arguments: '{"cmd":"ls"}' } });
  if (target === "gemini") assert.deepEqual(r.parts().find(p => p.functionCall)?.functionCall.args, { cmd: "ls" }, "complete tool emits at block boundary, before response.completed");
  await r.end({ type: "response.completed", response: { output: [], usage: { input_tokens: 2, output_tokens: 3 } } });
  if (target === "messages") {
    assert.deepEqual(r.events().filter(e => e.type === "content_block_start").map(e => e.content_block.type), ["thinking", "text", "tool_use"]);
    assert.deepEqual(r.events().filter(e => e.type === "content_block_stop").map(e => e.index), [0, 1, 2]);
  } else assert.equal(r.parts().filter(p => p.functionCall).length, 1, "finish must not duplicate tools");
});

for (const target of ["messages", "gemini"] as const) test(`Chat -> ${target}: fragmented tool headers commit at arguments, without buffering the full call`, async () => {
  const r = staged("chat", target);
  await r.push({ choices: [{ delta: { reasoning_content: "think first" } }] });
  assert.match(r.chunks.join(""), /think first/);
  await r.push({ choices: [{ delta: { reasoning_signature: "fake-signature" } }] });
  await r.push({ choices: [{ delta: { content: "then text" } }] });
  assert.match(r.chunks.join(""), /then text/);
  await r.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_", function: { name: "sh", arguments: "" } }] } }] });
  await r.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "ell", arguments: '{"cmd":"' } }] } }] });
  if (target === "messages") {
    const start = r.events().find(e => e.content_block?.type === "tool_use");
    assert.equal(start?.content_block.id, "call_1"); assert.equal(start?.content_block.name, "shell");
    assert.ok(r.events().some(e => e.delta?.partial_json === '{"cmd":"'));
  }
  await r.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ls"}' } }] } }] });
  if (target === "gemini") assert.deepEqual(r.parts().find(p => p.functionCall)?.functionCall, { id: "call_1", name: "shell", args: { cmd: "ls" } });
  await r.end({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
});

test("Messages -> Gemini: signature closes its thinking block before later text and tool output", async () => {
  const r = staged("messages", "gemini");
  await r.push({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  await r.push({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "thought" } });
  assert.equal(r.parts()[0]!.text, "thought");
  await r.push({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fake-sig" } });
  assert.ok(!r.parts().some(p => p.thoughtSignature), "signature is carried at the block boundary");
  await r.push({ type: "content_block_stop", index: 0 });
  assert.equal(unpackState(r.parts().at(-1)!.thoughtSignature, "source", "m")?.signature, "fake-sig");
  await r.push({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
  await r.push({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "visible" } });
  assert.equal(r.parts().at(-1)!.text, "visible");
  await r.push({ type: "content_block_stop", index: 1 });
  await r.push({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "c1", name: "shell", input: {} } });
  await r.push({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"cmd":"ls"}' } });
  await r.push({ type: "content_block_stop", index: 2 });
  assert.deepEqual(r.parts().at(-1)!.functionCall.args, { cmd: "ls" });
  await r.push({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } });
  await r.end({ type: "message_stop" });
});

for (const target of ["messages", "gemini"] as const) test(`${target}: incremental truncated tool input never becomes a successful executable call`, async () => {
  const r = staged("chat", target);
  await r.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "shell", arguments: '{"cmd":"unfinished' } }] } }] });
  await r.end({ choices: [{ delta: {}, finish_reason: "length" }] });
  if (target === "messages") {
    assert.equal(r.events().find(e => e.type === "message_delta")?.delta.stop_reason, "max_tokens");
    assert.equal(r.out.result().content.some((p: Json) => p.type === "tool_use"), false);
  } else {
    assert.equal(r.parts().some(p => p.functionCall), false);
    assert.equal(r.events().at(-1)?.candidates[0].finishReason, "MAX_TOKENS");
  }
});

test("an interrupted stream exposes partial progress and an error without a success terminal", async () => {
  const r = staged("responses", "messages");
  await r.push({ type: "response.reasoning_summary_text.delta", output_index: 0, delta: "already visible" });
  assert.match(r.chunks.join(""), /already visible/);
  r.controller.close();
  assert.ok(await r.done instanceof ProtocolError);
  assert.ok(r.events().some(e => e.type === "error")); assert.ok(!r.events().some(e => e.type === "message_stop"));
});

test("converted parsing bounds unterminated SSE frames and cancels the source", async () => {
  const r = staged("chat", "messages");
  r.controller.enqueue(new TextEncoder().encode("data: " + "x".repeat(OUTPUT_LIMITS.frameBytes + 1)));
  assert.ok(await r.done instanceof ProtocolError); assert.equal(r.cancelled(), true);
});

test("SSE decoding keeps split UTF-8, CRLF and multiline data intact", async () => {
  const data = 'data: {"choices":[\r\ndata: {"delta":{"content":"你好"},"finish_reason":"stop"}]}\r\n\r\n';
  const bytes = new TextEncoder().encode(data);
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const out = new Downstream("messages", "m", "source", "chat", []);
  for await (const e of readOutput(new Response(body, { headers: { "content-type": "text/event-stream" } }), "chat")) out.accept(e);
  assert.equal(out.result().content[0].text, "你好");
});

test("parallel fragmented Chat headers retain source order and then stream independent argument deltas", async () => {
  const r = staged("chat", "messages");
  await r.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "first", function: { name: "a", arguments: "" } }, { index: 1, id: "second", function: { name: "b", arguments: '{"x":2}' } }] } }] });
  assert.equal(r.events().filter(e => e.content_block?.type === "tool_use").length, 0, "a later call cannot overtake an ambiguous earlier header");
  await r.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"x":' } }] } }] });
  assert.deepEqual(r.events().filter(e => e.content_block?.type === "tool_use").map(e => e.content_block.id), ["first", "second"]);
  await r.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }] });
  assert.ok(r.events().some(e => e.index === 0 && e.delta?.partial_json === '1}'));
  await r.end({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
});

test("empty thinking blocks retain their type and late signature in stream and whole result", async () => {
  const r = staged("messages", "messages");
  await r.push({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
  assert.equal(r.events().at(-1)?.content_block?.type, "thinking");
  await r.push({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "empty-thought-sig" } });
  await r.push({ type: "content_block_stop", index: 0 });
  await r.push({ type: "message_delta", delta: { stop_reason: "end_turn" } });
  await r.end({ type: "message_stop" });
  const block = r.out.result().content[0];
  assert.equal(block.type, "thinking"); assert.equal(block.thinking, "");
  assert.equal(unpackState(block.signature, "source", "m")?.signature, "empty-thought-sig");
});

test("Gemini thinking signature closes before visible text while the source stays open", async () => {
  const r = staged("gemini", "messages");
  await r.push({ candidates: [{ content: { parts: [{ thought: true, text: "thought" }] } }] });
  assert.ok(r.events().some(e => e.delta?.thinking === "thought"));
  await r.push({ candidates: [{ content: { parts: [{ thought: true, text: "", thoughtSignature: "gemini-sig" }, { text: "answer" }] } }] });
  const events = r.events();
  const close = events.findIndex(e => e.type === "content_block_stop");
  const text = events.findIndex(e => e.content_block?.type === "text");
  assert.ok(close >= 0 && close < text);
  assert.equal(unpackState(events[close - 1]!.delta.signature, "source", "m")?.signature, "gemini-sig");
  await r.end({ candidates: [{ finishReason: "STOP" }] });
});

const customTools: Tool[] = [{ name: "patch", description: "", parameters: {}, custom: true }];
const customDeltas = (r: ReturnType<typeof staged>) => r.events().filter(e => e.type === "response.custom_tool_call_input.delta").map(e => e.delta).join("");
const toolFragment = (arguments_: string, first = false): Json => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...(first ? { id: "c1" } : {}), function: { ...(first ? { name: "patch" } : {}), arguments: arguments_ } }] } }] });

test("Chat -> Responses custom input streams before wrapper completion without exposing JSON escapes", async () => {
  const r = staged("chat", "responses", customTools);
  await r.push(toolFragment('{"input":"first', true));
  assert.equal(customDeltas(r), "first");
  assert.ok(!r.events().some(e => e.type.endsWith(".done")));
  await r.push(toolFragment(' second"}'));
  assert.equal(customDeltas(r), "first second");
  await r.end({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  assert.equal(customDeltas(r), "first second", "finish must not duplicate the streamed input");
  assert.equal(r.out.result().output[0].input, "first second");
});

test("custom input decodes fragmented escapes and emits Unicode surrogate pairs together", async () => {
  const r = staged("chat", "responses", customTools);
  await r.push(toolFragment('{"input":"', true));
  const encoded = JSON.stringify('你好😀\n"\\end').slice(1, -1).replace('😀', '\\uD83D\\uDE00');
  for (const char of encoded) await r.push(toolFragment(char));
  assert.equal(customDeltas(r), '你好😀\n"\\end');
  for (const e of r.events().filter(e => e.type === "response.custom_tool_call_input.delta")) assert.equal(e.delta.isWellFormed(), true);
  await r.push(toolFragment('"}'));
  await r.end({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  assert.equal(customDeltas(r), r.out.result().output[0].input);
});

for (const tail of ['","input":"changed"}', '","input":"first plus"}', '"}garbage']) test(`custom input refuses inconsistent or malformed completion: ${tail}`, async () => {
  const r = staged("chat", "responses", customTools);
  await r.push(toolFragment('{"input":"first', true));
  assert.equal(customDeltas(r), "first");
  await r.push(toolFragment(tail));
  if (!r.cancelled()) {
    await r.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
    if (!r.cancelled()) r.controller.close();
  }
  assert.ok(await r.done instanceof Error);
  assert.ok(!r.events().some(e => e.type === "response.completed" || e.type === "response.output_item.done"));
});

test("truncated custom input reports incomplete and never a completed executable item", async () => {
  const r = staged("chat", "responses", customTools);
  await r.push(toolFragment('{"input":"partial', true));
  await r.end({ choices: [{ delta: {}, finish_reason: "length" }] });
  assert.equal(r.out.result().status, "incomplete");
  assert.equal(r.out.result().output[0].input, "");
  assert.ok(!r.events().some(e => e.type === "response.completed" || e.type === "response.output_item.done" && e.item.status === "completed"));
});

for (const source of ["responses", "messages"] as const) test(`${source} -> Responses: custom wrapper emits input while upstream is paused`, async () => {
  const r = staged(source, "responses", customTools);
  await r.push(source === "responses"
    ? { type: "response.output_item.added", output_index: 0, item: { type: "function_call", call_id: "c1", name: "patch", arguments: "" } }
    : { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "patch", input: {} } });
  const push = async (delta: string) => r.push(source === "responses"
    ? { type: "response.function_call_arguments.delta", output_index: 0, delta }
    : { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: delta } });
  await push('{"input":"visible'); assert.equal(customDeltas(r), "visible");
  await push('"}');
  if (source === "responses") await r.end({ type: "response.completed", response: { output: [{ type: "function_call", call_id: "c1", name: "patch", arguments: '{"input":"visible"}' }] } });
  else { await r.push({ type: "message_delta", delta: { stop_reason: "tool_use" } }); await r.end({ type: "message_stop" }); }
  assert.equal(customDeltas(r), "visible");
});

test("noncanonical custom wrapper keeps the safe buffered fallback", async () => {
  const r = staged("chat", "responses", customTools);
  await r.push(toolFragment('{"extra":true,"input":"safe"}', true));
  assert.equal(customDeltas(r), "");
  await r.end({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  assert.equal(customDeltas(r), "safe");
});

test("ordinary function arguments reach Responses before completion and preserve split UTF-16", async () => {
  const r = staged("chat", "responses");
  await r.push(toolFragment('{"cmd":"', true));
  assert.equal(r.events().find(e => e.type === "response.function_call_arguments.delta")?.delta, '{"cmd":"');
  await r.push(toolFragment('\ud83d')); await r.push(toolFragment('\ude00"}'));
  await r.end({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  const args = r.events().filter(e => e.type === "response.function_call_arguments.delta").map(e => e.delta).join("");
  assert.equal(JSON.parse(args).cmd, "😀");
  assert.equal(args, r.out.result().output[0].arguments);
});

for (const raw of [
  '{"extra":true,"input":"first","input":"second"}',
  '{"\\u0069nput":"first","input":"second"}',
  '{"extra":true,"extra":false,"input":"second"}',
]) test(`custom wrapper rejects duplicate fields even when progress decoding is buffered: ${raw}`, async () => {
  const r = staged("chat", "responses", customTools);
  await r.push(toolFragment(raw, true));
  await r.push({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
  if (!r.cancelled()) r.controller.close();
  assert.ok(await r.done instanceof Error);
  assert.ok(!r.events().some(e => e.type === "response.completed" || e.type === "response.output_item.done"));
});
