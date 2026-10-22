import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { OUTPUT_LIMITS } from "../src/protocol.ts";

// Synthetic in-memory raw upstream bytes only. No HTTP or real client claims.
const path = "../src/automatic-tool-output.ts";
const output = await import(path).catch(error => { if (error.code === "ERR_MODULE_NOT_FOUND") return {}; throw error; });
const toolNames = new Set(["read_file"]);
function chunk(delta: any, finish_reason: string | null = null): any {
  return { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] };
}
function frame(value: unknown, newline = "\n"): Buffer { return Buffer.from(`data: ${typeof value === "string" ? value : JSON.stringify(value)}${newline}${newline}`); }
function parts(): Buffer[] { return [frame(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_", arguments: '{"path":' } }] })), frame(chunk({ tool_calls: [{ index: 0, function: { name: "file", arguments: '"文件.txt"}' } }] })), frame(chunk({}, "tool_calls")), frame({ id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }), frame("[DONE]")]; }
const completeTool = (index = 0) => frame(chunk({ tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: "read_file", arguments: `{"path":"fixture_${index}.txt"}` } }] }));
// Deliberately eager, side-effect-free event counter: models a consumer that emits
// a tool call as soon as arguments parse. This is NOT an actual SDK/client run or
// tool execution, and it must never touch the filesystem or invoke a real tool.
function eagerConsumer(order: string[]) {
  const argumentsByIndex = new Map<number, string>(), emitted = new Set<number>();
  return { emitted, accept(raw: Buffer) {
    for (const record of raw.toString().split(/\r?\n\r?\n/)) {
      const data = record.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
      let value: any; try { value = JSON.parse(data); } catch { continue; }
      for (const call of value.choices?.[0]?.delta?.tool_calls ?? []) {
        const args = (argumentsByIndex.get(call.index) ?? "") + (call.function?.arguments ?? ""); argumentsByIndex.set(call.index, args);
        if (emitted.has(call.index)) continue;
        try { JSON.parse(args); } catch { continue; }
        emitted.add(call.index); order.push("simulated-tool-call");
      }
    }
  } };
}
function openGate(t: TestContext) {
  const wire: Buffer[] = [], order: string[] = [], consumer = eagerConsumer(order);
  let commits = 0, completions = 0, errors = 0;
  const transform = output.createAutomaticToolOutput({ stream: true, toolNames,
    commitCalls: () => { order.push("commit"); commits++; }, onComplete: () => { order.push("complete"); completions++; }, onError: () => { errors++; },
  });
  transform.on("data", (raw: Buffer) => { wire.push(Buffer.from(raw)); consumer.accept(raw); });
  const settled = finished(transform).then(() => undefined, error => error);
  t.after(() => { if (!transform.destroyed) transform.destroy(); });
  return { transform, wire, order, consumer, settled, get commits() { return commits; }, get completions() { return completions; }, get errors() { return errors; },
    write: (raw: Buffer) => new Promise<void>((resolve, reject) => transform.write(raw, (error?: Error | null) => error ? reject(error) : resolve())),
  };
}
async function run(input: Buffer[], stream = true, override: Record<string, unknown> = {}): Promise<any> {
  assert.equal(typeof output.createAutomaticToolOutput, "function", "the bounded raw-wire validator must exist");
  const calls: any[] = []; const wire: Buffer[] = []; const order: string[] = []; let complete = 0; let errors = 0;
  const consumer = eagerConsumer(order);
  const transform = output.createAutomaticToolOutput({ stream, toolNames, commitCalls: (value: any) => { order.push("commit"); calls.push(...value); }, onComplete: () => { order.push("complete"); complete++; }, onError: () => { errors++; }, ...override });
  transform.on("data", (value: Buffer) => { order.push(/"finish_reason"\s*:\s*"tool_calls"/.test(value.toString()) || value.toString().includes("[DONE]") ? "terminal" : "data"); wire.push(Buffer.from(value)); consumer.accept(value); });
  let error: unknown;
  try { await pipeline(Readable.from(input), transform); } catch (failure) { error = failure; }
  return { calls, wire: Buffer.concat(wire), order, complete, errors, error, simulatedCalls: consumer.emitted.size };
}

test("complete parseable tool arguments are invisible before finish, DONE and normal EOF", async t => {
  const gate = openGate(t), tool = completeTool(), finish = frame(chunk({}, "tool_calls")), done = frame("[DONE]");
  for (const raw of [tool, finish, done]) {
    await gate.write(raw);
    assert.equal(Buffer.concat(gate.wire).length, 0); assert.equal(gate.consumer.emitted.size, 0);
    assert.equal(gate.commits, 0); assert.equal(gate.completions, 0);
  }
  gate.transform.end(); assert.equal(await gate.settled, undefined);
  assert.deepEqual(Buffer.concat(gate.wire), Buffer.concat([tool, finish, done])); assert.equal(gate.consumer.emitted.size, 1);
  assert.deepEqual(gate.order, ["commit", "complete", "simulated-tool-call"]);
});

test("pre-tool text streams immediately, then tools, comments and following text remain ordered behind EOF", async t => {
  const gate = openGate(t);
  const prefix = Buffer.concat([Buffer.from(": before\r\n\r\n"), frame(chunk({ role: "assistant", content: "before工具" }), "\r\n")]);
  await gate.write(prefix); assert.deepEqual(Buffer.concat(gate.wire), prefix);
  const held = [completeTool(), Buffer.from(": during\r\n\r\n"), frame(chunk({ content: "between" })), completeTool(1), frame(chunk({ content: "after工具" }), "\r\n"), frame(chunk({}, "tool_calls")), frame("[DONE]"), Buffer.from(": final comment\n\n")];
  for (const raw of held) { await gate.write(raw); assert.deepEqual(Buffer.concat(gate.wire), prefix); }
  gate.transform.end(); assert.equal(await gate.settled, undefined);
  assert.deepEqual(Buffer.concat(gate.wire), Buffer.concat([prefix, ...held])); assert.equal(gate.consumer.emitted.size, 2);
  assert.deepEqual(gate.order, ["commit", "complete", "simulated-tool-call", "simulated-tool-call"]);
});

test("split CRLF and UTF-8 tool frames remain entirely hidden even when arguments become parseable", async t => {
  const gate = openGate(t), prefix = frame(chunk({ content: "prior" }), "\r\n"); await gate.write(prefix);
  const held = Buffer.concat([...parts().map(raw => Buffer.from(raw.toString().replaceAll("\n", "\r\n"))), Buffer.from(": 尾\r\n\r\n")]);
  for (const byte of held) { await gate.write(Buffer.from([byte])); assert.deepEqual(Buffer.concat(gate.wire), prefix); }
  gate.transform.end(); assert.equal(await gate.settled, undefined);
  assert.deepEqual(Buffer.concat(gate.wire), Buffer.concat([prefix, held])); assert.equal(gate.consumer.emitted.size, 1);
});

test("malformed or missing tails discard every held tool byte, retaining only pre-tool text", async () => {
  const prefix = frame(chunk({ content: "already-visible" })), finish = frame(chunk({}, "tool_calls")), done = frame("[DONE]");
  for (const tail of [[], [finish], [done], [finish, Buffer.from("data: [DONE]")], [finish, frame("{broken"), done], [finish, done, frame(chunk({ content: "too late" }))], [finish, done, Buffer.from([0xff, 10, 10])], [finish, done, Buffer.from(": hidden\rdata: {}\n\n")]]) {
    const result = await run([prefix, completeTool(), ...tail]);
    assert.ok(result.error); assert.equal(result.complete, 0); assert.equal(result.simulatedCalls, 0); assert.deepEqual(result.calls, []); assert.deepEqual(result.wire, prefix);
  }
});

test("source reset and consumer cancellation before EOF expose no tool arguments", async t => {
  for (const cancelled of [false, true]) {
    const gate = openGate(t), prefix = frame(chunk({ content: "already-visible" }));
    await gate.write(prefix); await gate.write(completeTool()); await gate.write(frame(chunk({}, "tool_calls"))); await gate.write(frame("[DONE]"));
    gate.transform.destroy(cancelled ? undefined : new Error("synthetic upstream reset"));
    assert.ok(await gate.settled); assert.deepEqual(Buffer.concat(gate.wire), prefix); assert.equal(gate.consumer.emitted.size, 0);
    assert.equal(gate.commits, 0); assert.equal(gate.completions, 0); assert.equal(gate.errors, 1);
  }
});

test("failed or asynchronous proof/completion callbacks release no tool bytes", async () => {
  const prefix = frame(chunk({ content: "already-visible" }));
  for (const override of [
    { commitCalls: () => { throw new Error("synthetic commit failure"); } }, { commitCalls: () => Promise.resolve() },
    { onComplete: () => { throw new Error("synthetic completion failure"); } }, { onComplete: () => Promise.resolve() },
  ]) {
    const result = await run([prefix, completeTool(), frame(chunk({}, "tool_calls")), frame("[DONE]")], true, override);
    assert.ok(result.error); assert.deepEqual(result.wire, prefix); assert.equal(result.simulatedCalls, 0); assert.equal(result.complete, 0); assert.equal(result.errors, 1);
  }
});

test("the unchanged total 32 MiB limit includes all held comments and discards tools on overflow", async () => {
  const prefix = frame(chunk({ content: "already-visible" }));
  const padding = Buffer.from(`:${" ".repeat(1024 * 1024)}\n\n`);
  assert.equal(OUTPUT_LIMITS.responseBytes, 32 * 1024 * 1024);
  const result = await run([prefix, completeTool(), ...Array.from({ length: 32 }, () => padding), frame(chunk({}, "tool_calls")), frame("[DONE]")]);
  assert.ok(result.error); assert.equal(result.complete, 0); assert.deepEqual(result.calls, []); assert.equal(result.simulatedCalls, 0); assert.deepEqual(result.wire, prefix);
});

test("a valid tool response exactly at the existing 32 MiB limit is still accepted byte for byte", async () => {
  const input = [completeTool()], ending = [frame(chunk({}, "tool_calls")), frame("[DONE]")];
  let remaining = OUTPUT_LIMITS.responseBytes - Buffer.concat([...input, ...ending]).length;
  while (remaining > 0) {
    const length = Math.min(remaining, 1024 * 1024);
    assert.ok(length >= 3); input.push(Buffer.from(`:${" ".repeat(length - 3)}\n\n`)); remaining -= length;
  }
  input.push(...ending);
  const result = await run(input);
  assert.equal(result.error, undefined); assert.equal(result.wire.length, OUTPUT_LIMITS.responseBytes);
  assert.deepEqual(result.wire, Buffer.concat(input)); assert.equal(result.complete, 1); assert.equal(result.simulatedCalls, 1);
});

test("held tool output remains byte exact under a backpressured consumer", async () => {
  const input = [frame(chunk({ content: "prior" })), completeTool(), ...Array.from({ length: 40 }, () => Buffer.from(`:${" ".repeat(4096)}\r\n\r\n`)), completeTool(1), frame(chunk({ content: "after" })), frame(chunk({}, "tool_calls")), frame("[DONE]")];
  const wire: Buffer[] = [], order: string[] = [], consumer = eagerConsumer(order);
  let committed = false, completed = false;
  const transform = output.createAutomaticToolOutput({ stream: true, toolNames, commitCalls: () => { committed = true; }, onComplete: () => { completed = true; } });
  const sink = new Writable({ highWaterMark: 1, write(raw: Buffer, _encoding, callback) {
    if (raw.includes(Buffer.from("tool_calls"))) { assert.equal(committed, true); assert.equal(completed, true); }
    wire.push(Buffer.from(raw)); consumer.accept(raw); setImmediate(callback);
  } });
  await pipeline(Readable.from(input), transform, sink);
  assert.deepEqual(Buffer.concat(wire), Buffer.concat(input)); assert.equal(consumer.emitted.size, 2); assert.equal(sink.writableFinished, true);
});

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

test("source failure after complete tool arguments is not normal EOF and exposes no tool bytes", async () => {
  assert.equal(typeof output.createAutomaticToolOutput, "function"); let complete = 0; let committed = 0; let failed = 0;
  const wire: Buffer[] = [], consumer = eagerConsumer([]);
  const transform = output.createAutomaticToolOutput({ stream: true, toolNames, commitCalls: () => { committed++; }, onComplete: () => { complete++; }, onError: () => { failed++; } });
  transform.on("data", (raw: Buffer) => { wire.push(raw); consumer.accept(raw); });
  const source = Readable.from((async function* () { yield completeTool(); throw new Error("synthetic reset"); })());
  await assert.rejects(pipeline(source, transform)); assert.equal(complete, 0); assert.equal(committed, 0); assert.equal(failed, 1);
  assert.equal(Buffer.concat(wire).length, 0); assert.equal(consumer.emitted.size, 0);
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
