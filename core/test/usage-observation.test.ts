import assert from "node:assert/strict";
import { test } from "node:test";
import { Downstream } from "../src/downstream.ts";
import { OutputUsageTracker, readOutput, usageOf } from "../src/upstream-events.ts";
import { observeUsage } from "../src/usage-observation.ts";
import type { ApiProtocol } from "../src/types.ts";
import type { Json, Usage } from "../src/protocol.ts";

const protocols = ["chat", "responses", "messages", "gemini"] as const;
const samples: Record<ApiProtocol, Json> = {
  chat: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
  responses: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
  messages: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  gemini: { promptTokenCount: 10, candidatesTokenCount: 4, cachedContentTokenCount: 3, thoughtsTokenCount: 2 },
};
const legacy: Record<ApiProtocol, Usage> = {
  chat: { input: 10, output: 4, cached: 3, reasoning: 2, complete: true },
  responses: { input: 10, output: 4, cached: 3, reasoning: 2, complete: true },
  messages: { input: 15, output: 4, cached: 3, cacheWrite: 2, complete: false },
  gemini: { input: 10, output: 4, cached: 3, reasoning: 2, complete: false },
};
const numeric = (u: Usage) => { const { observation: _, ...rest } = u; return rest; };
const whole = (p: ApiProtocol, u?: Json): Json => p === "chat" ? { choices: [{ message: { content: "fixture" }, finish_reason: "stop" }], usage: u }
  : p === "responses" ? { status: "completed", output: [], usage: u }
  : p === "messages" ? { content: [], stop_reason: "end_turn", usage: u }
  : { candidates: [{ content: { parts: [{ text: "fixture" }] }, finishReason: "STOP" }], usageMetadata: u };
const sse = (...frames: Json[]) => frames.map(j => `data: ${JSON.stringify(j)}\n\n`).join("");
const terminal = (p: ApiProtocol, u?: Json): string => p === "chat" ? sse({ choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: u }) + "data: [DONE]\n\n"
  : p === "responses" ? sse({ type: "response.completed", response: whole(p, u) })
  : p === "messages" ? sse({ type: "message_start", message: { usage: u && { ...u, output_tokens: 0 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: u && { output_tokens: u.output_tokens } }, { type: "message_stop" })
  : sse(whole(p, u));

for (const p of protocols) {
  test(`${p}: metadata distinguishes missing, invalid and explicit zero counters`, () => {
    const missing = observeUsage(p, {}, false);
    assert.equal(missing.counters.input.state, "missing");
    assert.equal(missing.counters.cacheRead.state, "missing");
    const inputField = missing.counters.input.field;
    for (const value of [null, "0", false, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, { secret: "never-retain" }]) {
      const result = observeUsage(p, { [inputField]: value }, false);
      assert.equal(result.counters.input.state, "invalid");
      assert.doesNotMatch(JSON.stringify(result), /never-retain/);
    }
    assert.deepEqual(observeUsage(p, { [inputField]: 0 }, false).counters.input, { state: "observed", field: inputField, value: 0 });
    assert.equal(observeUsage(p, [], false).counters.input.state, "invalid");
    assert.equal(observeUsage(p, null, false).counters.input.state, "invalid");
  });

  for (const streaming of [false, true]) test(`${p} ${streaming ? "SSE" : "JSON"}: final sidecar leaves legacy numeric usage exactly unchanged`, async () => {
    assert.deepEqual(usageOf(p, samples[p]), legacy[p]);
    const response = streaming ? new Response(terminal(p, samples[p]), { headers: { "content-type": "text/event-stream" } }) : Response.json(whole(p, samples[p]));
    let result: Usage | undefined;
    for await (const event of readOutput(response, p)) if (event.type === "usage") result = event.usage;
    assert.ok(result); assert.deepEqual(numeric(result), legacy[p]);
    assert.deepEqual({ ...result.observation, counters: undefined }, { version: 1, protocol: p, stage: "decoder-input", scope: "selected-attempt", streaming, counters: undefined, terminalObserved: true, finalUsageObserved: true, decoderFailed: false, decoderInvalid: false });
    assert.equal(result.observation!.counters.input.state, "observed");
    assert.equal(result.observation!.counters.cacheRead.state, "observed");
    assert.deepEqual(result.observation!.counters.cacheWrite, p === "messages" ? { state: "observed", field: "cache_creation_input_tokens", value: 2 } : { state: "unmapped" });
    assert.deepEqual(result.observation!.counters.reasoning, p === "messages" ? { state: "unmapped" } : { state: "observed", field: p === "chat" ? "completion_tokens_details.reasoning_tokens" : p === "responses" ? "output_tokens_details.reasoning_tokens" : "thoughtsTokenCount", value: 2 });
    if (p === "messages") assert.deepEqual(result.observation!.counters.input, { state: "observed", field: "input_tokens", value: 10 });
  });

  test(`${p}: every downstream protocol omits sidecars and preserves exact wire usage`, () => {
    for (const target of protocols) {
      const u = legacy[p];
      const control = new Downstream(target, "fixture", "fixture", p, []);
      control.accept({ type: "usage", usage: u });
      const changed = new Downstream(target, "fixture", "fixture", p, []);
      changed.accept({ type: "usage", usage: { ...u, observation: observeUsage(p, samples[p], false) } });
      const a = control.result(), b = changed.result();
      assert.deepEqual(b.usage ?? b.usageMetadata, a.usage ?? a.usageMetadata);
      assert.doesNotMatch(JSON.stringify(b), /observation|decoder-input|selected-attempt|terminalObserved/);
    }
  });
}

test("Chat cache aliases retain their chosen field and absent cache remains distinct from zero", () => {
  const raw = { prompt_tokens: 10, completion_tokens: 4 };
  assert.equal(usageOf("chat", raw).cached, 0);
  assert.equal(observeUsage("chat", raw, false).counters.cacheRead.state, "missing");
  assert.deepEqual(observeUsage("chat", { ...raw, prompt_cache_hit_tokens: 0 }, false).counters.cacheRead, { state: "observed", field: "prompt_cache_hit_tokens", value: 0 });
  assert.deepEqual(observeUsage("chat", { prompt_tokens_details: { cached_tokens: 2 }, prompt_cache_hit_tokens: 9 }, false).counters.cacheRead, { state: "observed", field: "prompt_tokens_details.cached_tokens", value: 2 });
  assert.equal(observeUsage("chat", { prompt_tokens_details: null }, false).counters.cacheRead.state, "invalid");
});

test("Messages initial fields and final output are retained without turning a cache-write into complete billing", () => {
  const meter = new OutputUsageTracker("messages", true);
  const early = meter.take({ type: "message_start", message: { usage: { ...samples.messages, output_tokens: 0 } } })!;
  assert.equal(early.observation!.finalUsageObserved, false);
  meter.take({ type: "message_delta", usage: { output_tokens: 4 } }); meter.take({ type: "message_stop" });
  const result = meter.finish()!;
  assert.deepEqual(numeric(result), legacy.messages);
  assert.equal(result.observation!.finalUsageObserved, true);
  assert.deepEqual(result.observation!.counters.cacheWrite, { state: "observed", field: "cache_creation_input_tokens", value: 2 });
});

test("earlier usage plus terminal alone never supplies final usage; later content invalidates final placement", () => {
  const meter = new OutputUsageTracker("chat", true);
  meter.take({ choices: [{ delta: { content: "fixture" } }], usage: samples.chat });
  meter.take({ choices: [{ delta: {}, finish_reason: "stop" }] }); meter.done();
  assert.equal(meter.finish()!.observation!.terminalObserved, true);
  assert.equal(meter.finish()!.observation!.finalUsageObserved, false);
  assert.equal(meter.finish()!.complete, false);
  meter.take({ choices: [], usage: samples.chat });
  meter.take({ choices: [{ delta: { content: "fixture" } }] });
  assert.equal(meter.finish()!.observation!.finalUsageObserved, false);
});

test("Responses incomplete is a terminal observation, not a whole-bill completeness promise", async () => {
  const raw = sse({ type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: samples.responses } });
  let result: Usage | undefined;
  for await (const e of readOutput(new Response(raw, { headers: { "content-type": "text/event-stream" } }), "responses")) if (e.type === "usage") result = e.usage;
  assert.equal(result!.complete, true); // Existing semantics must not change.
  assert.equal(result!.observation!.terminalObserved, true); assert.equal(result!.observation!.finalUsageObserved, true);
  assert.equal(Object.hasOwn(result!.observation!, "complete"), false);
});

test("decoder exceptions update retained sidecar evidence without changing interim numeric counters", async () => {
  for (const suffix of ["", "data: invalid JSON\n\n", sse({ error: { message: "private-upstream-text" } })]) {
    let result: Usage | undefined;
    const raw = sse({ choices: [{ delta: { content: "fixture" } }], usage: samples.chat }) + suffix;
    await assert.rejects(async () => { for await (const e of readOutput(new Response(raw, { headers: { "content-type": "text/event-stream" } }), "chat")) if (e.type === "usage") result = e.usage; });
    assert.deepEqual(numeric(result!), { ...legacy.chat, complete: false });
    assert.equal(result!.observation!.finalUsageObserved, false); assert.equal(result!.observation!.decoderFailed, true);
    assert.doesNotMatch(JSON.stringify(result!.observation), /private-upstream-text/);
  }
});

test("unmetered replies do not manufacture usage or sidecars", async () => {
  for (const p of protocols) {
    const events = [];
    for await (const event of readOutput(Response.json(whole(p)), p)) events.push(event);
    assert.equal(events.some(e => e.type === "usage"), false);
    const meter = new OutputUsageTracker(p, false); meter.take(whole(p)); assert.equal(meter.finish(), undefined);
  }
});

test("whitelisted metadata never retains arbitrary values, URLs, headers or tool arguments", () => {
  const raw = { ...samples.chat, request: "private-request", url: "https://private.example/path", authorization: "secret-key", tool_arguments: "private-args", region: "guessed-region" };
  const value = JSON.stringify(observeUsage("chat", raw, false));
  assert.doesNotMatch(value, /private-|secret-|https:|guessed-|authorization|tool_arguments/);
});
