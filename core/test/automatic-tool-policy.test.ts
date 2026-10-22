import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolError } from "../src/protocol.ts";

// Pure synthetic Chat contract; no server, client, credentials or network.
const path = "../src/automatic-tool-policy.ts";
const policy = await import(path).catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const tool = { type: "function", function: { name: "read_file", description: "Read a fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } };
const base = { model: "pool/automatic", messages: [{ role: "user", content: "Read the fixture" }], tools: [tool] };
function parse(value: unknown, known = new Map(), history = false): any {
  assert.equal(typeof policy.parseAutomaticToolRequest, "function", "the strict Chat function request gate must exist");
  return policy.parseAutomaticToolRequest(JSON.stringify(value), known, history);
}
function rejected(value: unknown, known = new Map(), history = false): void {
  assert.throws(() => parse(value, known, history), ProtocolError);
}
function call(id = "call_1", args = '{"path":"fixture.txt"}'): any {
  return { id, type: "function", function: { name: "read_file", arguments: args } };
}
function known(): Map<string, any> {
  assert.equal(typeof policy.hashToolArguments, "function");
  return new Map([["call_1", { id: "call_1", name: "read_file", argumentsHash: policy.hashToolArguments('{"path":"fixture.txt"}') }]]);
}
function history(): any[] { return [...base.messages, { role: "assistant", content: null, tool_calls: [call()] }, { role: "tool", tool_call_id: "call_1", content: "fixture contents" }]; }

test("bootstrap accepts only standard declared function tools and represented Chat controls", () => {
  const request = { ...base, stream: true, stream_options: { include_usage: true }, tool_choice: { type: "function", function: { name: "read_file" } }, parallel_tool_calls: true, temperature: 0, top_p: 1, max_completion_tokens: 100 };
  const result = parse(request);
  assert.deepEqual(result.body, request);
  assert.equal(result.model, base.model);
  assert.equal(result.stream, true);
  assert.deepEqual([...result.toolNames], ["read_file"]);
  assert.equal(parse(base).stream, false);
  for (const choice of ["none", "auto", "required"]) parse({ ...base, tool_choice: choice });
  parse({ model: base.model, messages: base.messages });
  parse({ ...base, tools: [] });
});

test("raw unknown, opaque, native, hosted and malformed controls fail closed without values in errors", () => {
  for (const extra of [{ previous_response_id: null }, { conversation: null }, { metadata: {} }, { reasoning_effort: "low" }, { functions: [] }, { mystery: "never-echo-fixture" }, { tools: null }, { stream: 1 }, { model: "" }, { n: 2 }, { max_tokens: 1, max_completion_tokens: 1 }, { temperature: -1 }, { top_p: 2 }, { max_tokens: 1.5 }, { stream_options: { include_usage: true } }, { response_format: { type: "json_object" } }, { parallel_tool_calls: "yes" }]) rejected({ ...base, ...extra });
  for (const tools of [[{ type: "web_search" }], [{ type: "custom", custom: { name: "x" } }], [{ ...tool, unknown: null }], [{ type: "function", function: { ...tool.function, strict: true } }], [{ type: "function", function: { ...tool.function, name: "space not allowed" } }], [tool, tool]]) rejected({ ...base, tools });
  for (const tool_choice of ["bogus", { type: "function", function: { name: "unknown" } }, { type: "function", function: { name: "read_file", signature: null } }]) rejected({ ...base, tool_choice });
  assert.throws(() => parse({ ...base, mystery: "never-echo-fixture" }), error => error instanceof ProtocolError && !error.message.includes("never-echo-fixture"));
});

test("bootstrap cannot import tool history even when IDs appear in the provided map", () => {
  rejected({ ...base, messages: history() }, known());
  rejected({ ...base, messages: [{ role: "tool", tool_call_id: "call_1", content: "x" }] }, known());
  for (const field of [{ function_call: null }, { reasoning_content: "text" }, { reasoning_signature: null }, { name: "speaker" }, { provider_state: null }]) rejected({ ...base, messages: [{ role: "assistant", content: "hello", ...field }] });
});

test("history requires same-scope observed ID, function name, canonical arguments and preceding call", () => {
  parse({ ...base, messages: history() }, known(), true);
  const canonical = history(); canonical[1].tool_calls[0].function.arguments = '{ "path" : "fixture.txt" }';
  parse({ ...base, messages: canonical }, known(), true);
  rejected({ ...base, messages: history() }, new Map(), true);
  for (const replacement of [call("foreign"), call("call_1", '{"path":"changed"}'), { ...call(), function: { name: "other", arguments: '{"path":"fixture.txt"}' } }]) {
    const messages = history(); messages[1].tool_calls = [replacement]; rejected({ ...base, messages }, known(), true);
  }
  rejected({ ...base, messages: [...base.messages, history()[2]] }, known(), true);
  rejected({ ...base, messages: [...base.messages, history()[2], history()[1]] }, known(), true);
  const unknownResult = history(); unknownResult[2].tool_call_id = "foreign"; rejected({ ...base, messages: unknownResult }, known(), true);
});

test("complete old history can recur across requests without consuming or mutating proofs", () => {
  const proof = known(); const before = structuredClone([...proof]);
  for (let i = 0; i < 3; i++) parse({ ...base, messages: [...history(), { role: "user", content: "Continue" }] }, proof, true);
  assert.deepEqual([...proof], before);
  const duplicates = history(); duplicates.splice(2, 0, history()[1]); rejected({ ...base, messages: duplicates }, proof, true);
  rejected({ ...base, messages: [...history(), history()[2]] }, proof, true);
});

test("plain text and schema marker words are data, but structural opaque/media fields are not", () => {
  parse({ ...base, messages: [{ role: "user", content: [{ type: "text", text: "es-state: previous_response_id signature" }] }], tools: [{ type: "function", function: { name: "read_file", parameters: { properties: { signature: { type: "string" } } } } }] });
  for (const content of [null, [], [{ type: "image_url", image_url: { url: "data:x" } }], [{ type: "text", text: "x", signature: null }]]) rejected({ ...base, messages: [{ role: "user", content }] });
});

test("JSON parameter hashes are canonical, bounded and do not retain arguments", () => {
  assert.equal(typeof policy.hashToolArguments, "function");
  assert.equal(policy.hashToolArguments('{"z":[1,{"b":2,"a":3}],"a":true}'), policy.hashToolArguments('{ "a":true, "z":[1,{"a":3,"b":2}] }'));
  assert.notEqual(policy.hashToolArguments('[1,2]'), policy.hashToolArguments('[2,1]'));
  assert.equal(policy.hashToolArguments('{"n":100.00,"zero":0}'), policy.hashToolArguments('{"zero":0e10,"n":1e2}'));
  assert.equal(policy.hashToolArguments('{"zero":-0}'), policy.hashToolArguments('{"zero":-0.0}'));
  assert.equal(policy.hashToolArguments('{"zero":-0}'), policy.hashToolArguments('{"zero":-0e2}'));
  assert.notEqual(policy.hashToolArguments('{"zero":-0}'), policy.hashToolArguments('{"zero":0}'));
  assert.notEqual(policy.hashToolArguments('{"n":9007199254740992}'), policy.hashToolArguments('{"n":9007199254740993}'));
  assert.notEqual(policy.hashToolArguments('{"n":1.0000000000000001}'), policy.hashToolArguments('{"n":1}'));
  assert.notEqual(policy.hashToolArguments('{"n":1e-999}'), policy.hashToolArguments('{"n":0}'));
  assert.match(policy.hashToolArguments('{"password":"synthetic-secret"}'), /^[a-f0-9]{64}$/);
  for (const args of ["{", "", '{"n":1e999}', '{"same":1,"same":2}', '{"a":1,"\\u0061":2}', "[".repeat(40) + "0" + "]".repeat(40), JSON.stringify("x".repeat(300_000))]) assert.throws(() => policy.hashToolArguments(args), ProtocolError);
});

test("malformed roots and oversized requests, schemas, tool lists fail closed", () => {
  assert.equal(typeof policy.parseAutomaticToolRequest, "function");
  for (const raw of ["{", "null", "[]", '"text"', "1"]) assert.throws(() => policy.parseAutomaticToolRequest(raw, new Map(), false), ProtocolError);
  rejected({ ...base, messages: [] });
  rejected({ ...base, tools: Array.from({ length: 129 }, (_, i) => ({ type: "function", function: { name: `tool_${i}` } })) });
  let schema: any = {}; for (let i = 0; i < 40; i++) schema = { properties: { child: schema } };
  rejected({ ...base, tools: [{ type: "function", function: { name: "nested", parameters: schema } }] });
  rejected({ ...base, tools: [{ type: "function", function: { name: "large", parameters: { description: "x".repeat(70_000) } } }] });
  rejected({ ...base, messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024 + 1) }] });
});

test("request tool controls are explicit output constraints, not just syntax validation", () => {
  const none = parse({ ...base, tool_choice: "none" });
  assert.deepEqual([...none.toolNames], ["read_file"]); assert.deepEqual([...none.outputToolNames], []);
  assert.equal(none.requireToolCall, false); assert.equal(none.allowParallelToolCalls, true);
  const required = parse({ ...base, tool_choice: "required", parallel_tool_calls: false });
  assert.equal(required.requireToolCall, true); assert.equal(required.allowParallelToolCalls, false);
  const forced = parse({ ...base, tools: [tool, { type: "function", function: { name: "other" } }], tool_choice: { type: "function", function: { name: "read_file" } } });
  assert.deepEqual([...forced.toolNames], ["read_file", "other"]); assert.deepEqual([...forced.outputToolNames], ["read_file"]); assert.equal(forced.requireToolCall, true);
});
