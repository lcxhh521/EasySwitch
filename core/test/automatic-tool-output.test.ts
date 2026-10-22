import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

// Synthetic in-memory raw upstream bytes only. No HTTP or real client claims.
const path = "../src/automatic-tool-output.ts";
const output = await import(path).catch(error => { if (error.code === "ERR_MODULE_NOT_FOUND") return {}; throw error; });
const toolNames = new Set(["read_file"]);
function chunk(delta: any, finish_reason: string | null = null): any {
  return { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] };
}
function frame(value: unknown, newline = "\n"): Buffer { return Buffer.from(`data: ${typeof value === "string" ? value : JSON.stringify(value)}${newline}${newline}`); }
function parts(): Buffer[] { return [frame(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_", arguments: '{"path":' } }] })), frame(chunk({ tool_calls: [{ index: 0, function: { name: "file", arguments: '"文件.txt"}' } }] })), frame(chunk({}, "tool_calls")), frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), frame("[DONE]")]; }
async function run(input: Buffer[], stream = true, override: Record<string, unknown> = {}): Promise<any> {
  assert.equal(typeof output.createAutomaticToolOutput, "function", "the bounded raw-wire validator must exist");
  const calls: any[] = []; const wire: Buffer[] = []; const order: string[] = []; let complete = 0; let errors = 0;
  const transform = output.createAutomaticToolOutput({ stream, toolNames, commitCalls: (value: any) => { order.push("commit"); calls.push(...value); }, onComplete: () => { order.push("complete"); complete++; }, onError: () => { errors++; }, ...override });
  transform.on("data", (value: Buffer) => { order.push(/"finish_reason"\s*:\s*"tool_calls"/.test(value.toString()) || value.toString().includes("[DONE]") ? "terminal" : "data"); wire.push(Buffer.from(value)); });
  let error: unknown;
  try { await pipeline(Readable.from(input), transform); } catch (failure) { error = failure; }
  return { calls, wire: Buffer.concat(wire), order, complete, errors, error };
}

test("fragmented tool output is byte exact and proofs commit synchronously before terminal visibility", async () => {
  const input = parts(); const result = await run(input);
  assert.equal(result.error, undefined); assert.equal(result.complete, 1); assert.equal(result.errors, 0);
  assert.deepEqual(result.wire, Buffer.concat(input));
  assert.equal(result.calls.length, 1); assert.equal(result.calls[0].id, "call_1"); assert.equal(result.calls[0].name, "read_file");
  assert.match(result.calls[0].argumentsHash, /^[a-f0-9]{64}$/); assert.equal(result.calls[0].arguments, undefined);
  assert.ok(result.order.indexOf("commit") < result.order.indexOf("terminal"));
  assert.ok(result.order.indexOf("complete") < result.order.indexOf("terminal"));
});

test("CRLF, arbitrary UTF-8 byte fragmentation, and SSE comments preserve exact wire", async () => {
  const bytes = Buffer.concat([Buffer.from(": keepalive\r\n\r\n"), ...parts().map(part => Buffer.from(part.toString().replaceAll("\n", "\r\n")))]);
  const result = await run(Array.from(bytes, byte => Buffer.from([byte])));
  assert.equal(result.error, undefined); assert.deepEqual(result.wire, bytes); assert.equal(result.calls.length, 1);
});

test("plain text stop and terminal usage are successful without inventing tool proofs", async () => {
  const input = [frame(chunk({ role: "assistant", content: "Hello" })), frame(chunk({}, "stop")), frame("[DONE]")];
  const result = await run(input); assert.equal(result.error, undefined); assert.deepEqual(result.calls, []); assert.equal(result.complete, 1);
});

test("JSON response validates before forwarding and preserves original formatting", async () => {
  const body = { id: "chatcmpl_fixture", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{ "path": "文件.txt" }' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } };
  const wire = Buffer.from(JSON.stringify(body, null, 2)); const result = await run([wire.subarray(0, 17), wire.subarray(17)], false);
  assert.equal(result.error, undefined); assert.deepEqual(result.wire, wire); assert.equal(result.calls.length, 1);
  assert.ok(result.order.indexOf("commit") < result.order.indexOf("terminal"));
});

test("EOF without DONE/finish, truncated frames, malformed JSON and invalid UTF-8 never succeed", async () => {
  const input = parts();
  for (const bytes of [input.slice(0, 2), input.slice(0, 4), [frame("[DONE]")], [input[0]!, frame("[DONE]")], [...input.slice(0, 4), Buffer.from("data: [DONE]")], [frame("{broken")], [Buffer.from([0xff, 10, 10])]]) {
    const result = await run(bytes); assert.ok(result.error); assert.equal(result.complete, 0); assert.deepEqual(result.calls, []); assert.equal(result.errors, 1);
    assert.doesNotMatch(result.wire.toString(), /\[DONE\]/);
  }
});

test("unknown/hosted tools, opaque fields, repeated IDs and incomplete parameters fail closed", async () => {
  for (const delta of [
    { tool_calls: [{ index: 0, id: "c", type: "web_search", function: { name: "read_file", arguments: "{}" } }] },
    { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "undeclared", arguments: "{}" } }] },
    { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "read_file", arguments: "{" } }] },
    { tool_calls: [{ index: 0, type: "function", function: { name: "read_file", arguments: "{}" } }] },
    { tool_calls: [0, 1].map(index => ({ index, id: "duplicate", type: "function", function: { name: "read_file", arguments: "{}" } })) },
    { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "read_file", arguments: "{}", signature: null } }] },
    { content: "hello", reasoning_content: "opaque" }, { content: "hello", provider_state: null },
  ]) { const result = await run([frame(chunk(delta)), frame(chunk({}, "tool_calls")), frame("[DONE]")]); assert.ok(result.error); assert.equal(result.complete, 0); assert.deepEqual(result.calls, []); }
});

test("errors or extra output after finish or DONE cannot expose a successful terminal", async () => {
  for (const input of [
    [...parts().slice(0, 3), frame({ error: { message: "private-upstream-error" } }), frame("[DONE]")],
    [...parts(), frame(chunk({ content: "late" }))],
    [...parts().slice(0, 3), frame(chunk({ content: "late" })), frame("[DONE]")],
    [...parts(), frame("[DONE]")],
  ]) { const result = await run(input); assert.ok(result.error); assert.equal(result.complete, 0); assert.deepEqual(result.calls, []); assert.doesNotMatch(result.wire.toString(), /\[DONE\]|private-upstream-error/); }
});

test("non-success finish reasons, mismatched finish reasons and unsupported choices fail closed", async () => {
  for (const reason of ["length", "content_filter", "function_call", "bogus", "stop"]) { const result = await run([...parts().slice(0, 2), frame(chunk({}, reason)), frame("[DONE]")]); assert.ok(result.error); assert.equal(result.complete, 0); }
  for (const malformed of [{ ...chunk({}), choices: [] }, { ...chunk({}), choices: [{ index: 1, delta: {}, finish_reason: "stop" }] }, { ...chunk({}), choices: [{ index: 0, delta: {}, finish_reason: "stop" }, { index: 1, delta: {}, finish_reason: "stop" }] }]) { const result = await run([frame(malformed), frame("[DONE]")]); assert.ok(result.error); }
});

test("bounded frames and argument accumulation terminate without successful proofs", async () => {
  const large = await run([frame(chunk({ content: "x".repeat(2 * 1024 * 1024 + 1) }))]); assert.ok(large.error); assert.equal(large.complete, 0);
  const args = await run([frame(chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "read_file", arguments: JSON.stringify("x".repeat(300_000)) } }] })), frame(chunk({}, "tool_calls")), frame("[DONE]")]); assert.ok(args.error); assert.deepEqual(args.calls, []);
});

test("commit failure aborts terminal delivery and does not call onComplete", async () => {
  const result = await run(parts(), true, { commitCalls: () => { throw new Error("synthetic commit rejection"); } });
  assert.ok(result.error); assert.equal(result.complete, 0); assert.equal(result.errors, 1); assert.doesNotMatch(result.wire.toString(), /\[DONE\]/);
});

test("source failure after tool fragments is not normal EOF or completion", async () => {
  assert.equal(typeof output.createAutomaticToolOutput, "function"); let complete = 0; let committed = 0; let failed = 0;
  const transform = output.createAutomaticToolOutput({ stream: true, toolNames, commitCalls: () => { committed++; }, onComplete: () => { complete++; }, onError: () => { failed++; } }); transform.resume();
  const source = Readable.from((async function* () { yield parts()[0]; throw new Error("synthetic reset"); })());
  await assert.rejects(pipeline(source, transform)); assert.equal(complete, 0); assert.equal(committed, 0); assert.equal(failed, 1);
});

test("parallel tool indices are assembled independently, but missing indices are invalid", async () => {
  const initial = chunk({ tool_calls: [1, 0].map(index => ({ index, id: `call_${index}`, type: "function", function: { name: "read_file", arguments: '{"path":' } })) });
  const rest = chunk({ tool_calls: [0, 1].map(index => ({ index, function: { arguments: `"fixture_${index}"}` } })) });
  const result = await run([frame(initial), frame(rest), frame(chunk({}, "tool_calls")), frame("[DONE]")]);
  assert.equal(result.error, undefined); assert.deepEqual(result.calls.map((call: any) => call.id), ["call_0", "call_1"]);
  const sparse = await run([frame(chunk({ tool_calls: [{ index: 1, id: "call", type: "function", function: { name: "read_file", arguments: "{}" } }] })), frame(chunk({}, "tool_calls")), frame("[DONE]")]);
  assert.ok(sparse.error); assert.equal(sparse.complete, 0);
});

test("malformed usage, changing response identity, oversized item counts and duplicate JSON keys reject", async () => {
  for (const tail of [
    { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 99 } },
    { ...chunk({}, "tool_calls"), id: "another_response" },
  ]) { const result = await run([...parts().slice(0, 2), frame(tail), frame("[DONE]")]); assert.ok(result.error); assert.equal(result.complete, 0); }
  const excessive = await run([Buffer.from(":\n\n".repeat(4097)), ...parts()]); assert.ok(excessive.error); assert.equal(excessive.complete, 0);
  const duplicate = await run([frame(chunk({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read_file", arguments: '{"path":"one","path":"two"}' } }] })), frame(chunk({}, "tool_calls")), frame("[DONE]")]);
  assert.ok(duplicate.error); assert.deepEqual(duplicate.calls, []);
});

test("JSON errors or opaque content are never released before validation", async () => {
  for (const body of [
    { error: { message: "private-error-fixture" } },
    { id: "chatcmpl_fixture", object: "chat.completion", created: 1, model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: "text", reasoning_signature: "opaque" }, finish_reason: "stop" }] },
  ]) { const result = await run([Buffer.from(JSON.stringify(body))], false); assert.ok(result.error); assert.equal(result.wire.length, 0); assert.equal(result.complete, 0); }
});

test("an async commit is not proof registration and cannot expose a success terminal", async () => {
  const result = await run(parts(), true, { commitCalls: () => Promise.resolve() });
  assert.ok(result.error); assert.equal(result.complete, 0); assert.equal(result.errors, 1); assert.doesNotMatch(result.wire.toString(), /\[DONE\]/);
});

test("none, forced/required, and no-parallel controls are enforced on completed output", async () => {
  const none = await run(parts(), true, { toolNames: new Set() }); assert.ok(none.error); assert.equal(none.wire.length, 0);
  const forced = await run(parts(), true, { toolNames: new Set(["other"]) }); assert.ok(forced.error); assert.equal(forced.wire.length, 0);
  const stop = [frame(chunk({ role: "assistant", content: "No tool" })), frame(chunk({}, "stop")), frame("[DONE]")];
  const required = await run(stop, true, { requireToolCall: true }); assert.ok(required.error); assert.equal(required.complete, 0);
  const parallel = await run([frame(chunk({ tool_calls: [0, 1].map(index => ({ index, id: `call_${index}`, type: "function", function: { name: "read_file", arguments: "{}" } })) })), frame(chunk({}, "tool_calls")), frame("[DONE]")], true, { allowParallelToolCalls: false });
  assert.ok(parallel.error); assert.deepEqual(parallel.calls, []);
  const single = await run(parts(), true, { allowParallelToolCalls: false, requireToolCall: true }); assert.equal(single.error, undefined);
});

test("SSE bare-CR comment injection and ambiguous empty/BOM fields cannot bypass validation", async () => {
  const hidden = JSON.stringify(chunk({ tool_calls: [{ index: 0, id: "hidden", type: "function", function: { name: "undeclared", arguments: "{}" } }] }));
  const ending = [frame(chunk({ role: "assistant", content: "text" })), frame(chunk({}, "stop")), frame("[DONE]")];
  for (const prefix of [
    `: ignored\rdata: ${hidden}\n\n`,
    `: ignored\r\rdata: ${hidden}\n\n`,
    `: ignored\r\rdata: ${hidden}\r\r`,
    "\uFEFF: comment\n\n",
    "data:\n\n",
    "data\n\n",
    "data: \t\n\n",
    "event: message\n\n",
    "id: continuation\n\n",
    " \n\n",
  ]) {
    for (const split of [[Buffer.from(prefix)], Array.from(Buffer.from(prefix), byte => Buffer.from([byte]))]) {
      const result = await run([...split, ...ending]); assert.ok(result.error, JSON.stringify(prefix)); assert.equal(result.complete, 0); assert.deepEqual(result.calls, []); assert.equal(result.wire.length, 0);
    }
  }
});
