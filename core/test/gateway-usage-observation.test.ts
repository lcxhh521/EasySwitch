import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Ledger, summarize, summarizeBudgetEntries } from "../src/ledger.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { OutputUsageTracker } from "../src/upstream-events.ts";
import type { ApiProtocol, GatewayLogEntry } from "../src/types.ts";
import type { Json } from "../src/protocol.ts";

const protocols = ["chat", "responses", "messages", "gemini"] as const;
const samples: Record<ApiProtocol, Json> = {
  chat: { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 2 } },
  responses: { input_tokens: 10, output_tokens: 4, input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
  messages: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  gemini: { promptTokenCount: 10, candidatesTokenCount: 4, cachedContentTokenCount: 3, thoughtsTokenCount: 2 },
};
const whole = (p: ApiProtocol, u?: Json): Json => p === "chat" ? { choices: [{ message: { content: "fixture" }, finish_reason: "stop" }], usage: u }
  : p === "responses" ? { status: "completed", output: [], usage: u }
  : p === "messages" ? { content: [], stop_reason: "end_turn", usage: u }
  : { candidates: [{ content: { parts: [{ text: "fixture" }] }, finishReason: "STOP" }], usageMetadata: u };
const sse = (...frames: Json[]) => frames.map(j => `data: ${JSON.stringify(j)}\n\n`).join("");
const final = (p: ApiProtocol, u: Json): string => p === "chat" ? sse({ choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage: u }) + "data: [DONE]\n\n"
  : p === "responses" ? sse({ type: "response.completed", response: whole(p, u) })
  : p === "messages" ? sse({ type: "message_start", message: { usage: { ...u, output_tokens: 0 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: u.output_tokens } }, { type: "message_stop" })
  : sse(whole(p, u));
const partial = (p: ApiProtocol): string => p === "chat" ? sse({ choices: [{ delta: { content: "fixture" } }], usage: samples[p] })
  : p === "responses" ? sse({ type: "response.output_text.delta", delta: "fixture", usage: samples[p] })
  : p === "messages" ? sse({ type: "message_start", message: { usage: samples[p] } })
  : sse({ candidates: [{ content: { parts: [{ text: "fixture" }] } }], usageMetadata: samples[p] });

async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function rig(t: TestContext, source: ApiProtocol, raw: string, streaming: boolean, broken = false) {
  const dir = mkdtempSync(join(tmpdir(), "es-observation-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const origin = await listen(t, createServer(async (req, res) => {
    for await (const _chunk of req) { /* Synthetic input only; not retained. */ }
    res.writeHead(200, { "content-type": streaming ? "text/event-stream" : "application/json" });
    if (broken) { res.write(raw); setTimeout(() => res.destroy(), 25); } else res.end(raw);
  }));
  const store = new Store(dir), ledger = new Ledger(dir), auth = new GatewayTokenAuthority();
  const logged: GatewayLogEntry[] = [], append = ledger.append;
  t.mock.method(ledger, "append", (row: GatewayLogEntry) => { logged.push(row); append.call(ledger, row); });
  store.upsertProvider({ id: "p", name: "fixture", baseUrl: origin, models: ["m"], protocols: [source], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "", prices: { m: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } });
  const base = await listen(t, createEasySwitchServer({ store, ledger, gatewayAuth: auth, secrets: { async get() { return "synthetic-fixture"; }, async set() {}, async delete() {} }, port: 0 }));
  const token = auth.issue("fixture", {}).token;
  const post = (target: ApiProtocol) => fetch(base + (target === "gemini" ? `/v1beta/models/p%2Fm:${streaming ? "streamGenerateContent" : "generateContent"}` : target === "chat" ? "/v1/chat/completions" : `/v1/${target}`), {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "p/m", stream: streaming, ...(target === "gemini" ? { contents: [{ role: "user", parts: [{ text: "fixture-request-never-log" }] }] } : target === "responses" ? { input: "fixture-request-never-log" } : { messages: [{ role: "user", content: "fixture-request-never-log" }], max_tokens: 20 }) }),
  });
  const entry = async (index: number): Promise<GatewayLogEntry> => {
    const expires = Date.now() + 2_000;
    while (Date.now() < expires) { const value = ledger.read()[index]; if (value) return value; await new Promise(resolve => setTimeout(resolve, 2)); }
    assert.fail("synthetic local usage entry did not settle");
  };
  return { post, entry, ledger, dir, logged };
}

for (const source of protocols) for (const streaming of [false, true]) test(`${source} ${streaming ? "SSE" : "JSON"}: all four inbound routes persist sidecar only, retaining numeric cost`, async t => {
  const rawUsage = { ...samples[source], arbitrary: "private-field-never-log" };
  const raw = streaming ? final(source, rawUsage) : JSON.stringify(whole(source, rawUsage));
  const r = await rig(t, source, raw, streaming);
  for (const [index, target] of protocols.entries()) {
    const response = await r.post(target), wire = await response.text(); assert.equal(response.status, 200);
    if (target === source) assert.equal(wire, raw, "same-protocol bytes remain untouched");
    else assert.doesNotMatch(wire, /usageObservation|observation|decoder-input|selected-attempt|terminalObserved/);
    const row = await r.entry(index);
    const input = source === "messages" ? 15 : 10;
    assert.deepEqual({ input: row.inputTokens, output: row.outputTokens, cached: row.cachedTokens, complete: row.usageComplete, cost: row.costUsd }, { input, output: 4, cached: 3, complete: source === "chat" || source === "responses", cost: (input + 4) / 1_000_000 });
    assert.equal(row.inboundProtocol, target); assert.equal(row.outboundProtocol, source);
    const evidence = row.usageObservation!;
    assert.equal(evidence.protocol, source); assert.equal(evidence.streaming, streaming);
    assert.equal(evidence.stage, "decoder-input"); assert.equal(evidence.scope, "selected-attempt");
    assert.equal(evidence.terminalObserved, true); assert.equal(evidence.finalUsageObserved, true);
    assert.equal(evidence.decoderFailed, false); assert.equal(evidence.decoderInvalid, false);
    if (source === "messages") assert.deepEqual(evidence.counters.cacheWrite, { state: "observed", field: "cache_creation_input_tokens", value: 2 });
    else assert.equal(evidence.counters.reasoning.state, "observed");
    const { usageObservation: _, ...old } = row;
    const now = new Date(Date.now() + 1000);
    assert.deepEqual(summarize([row], "all", now), summarize([old], "all", now));
    assert.deepEqual(summarizeBudgetEntries([row], new Date(0), now, now), summarizeBudgetEntries([old], new Date(0), now, now));
    assert.doesNotMatch(JSON.stringify(row), /private-field-never-log|fixture-request-never-log|synthetic-fixture/);
  }
  assert.equal(new Ledger(r.dir).read().length, 4, "metadata survives a fresh ledger read");
  assert.doesNotMatch(readFileSync(join(r.dir, "usage.jsonl"), "utf8"), /private-field-never-log|fixture-request-never-log|synthetic-fixture/);
});

for (const source of protocols) test(`${source}: incomplete SSE remains incomplete across all inbound protocols`, async t => {
  const raw = partial(source), r = await rig(t, source, raw, true);
  for (const [index, target] of protocols.entries()) {
    const wire = await (await r.post(target)).text(); if (source === target) assert.equal(wire, raw);
    const row = await r.entry(index);
    assert.equal(row.status, source === target ? 200 : 502); assert.equal(row.usageComplete, false);
    assert.equal(row.inputTokens, source === "messages" ? 15 : 10); assert.equal(row.outputTokens, 4); assert.equal(row.cachedTokens, 3);
    assert.equal(row.usageObservation!.terminalObserved, false); assert.equal(row.usageObservation!.finalUsageObserved, false);
    assert.equal(row.usageObservation!.decoderFailed, source !== target);
  }
});

for (const source of protocols) test(`${source}: missing cache is recorded as missing while historical cachedTokens remains zero`, async t => {
  const u = source === "chat" ? { prompt_tokens: 10, completion_tokens: 4 } : source === "gemini" ? { promptTokenCount: 10, candidatesTokenCount: 4 } : { input_tokens: 10, output_tokens: 4 };
  const r = await rig(t, source, JSON.stringify(whole(source, u)), false);
  await (await r.post(source)).text(); const row = await r.entry(0);
  assert.equal(row.cachedTokens, 0); assert.equal(row.usageComplete, true); assert.equal(row.costUsd, 14 / 1_000_000);
  assert.equal(row.usageObservation!.counters.cacheRead.state, "missing");
});

test("unmetered gateway entries retain unknown observation instead of invented zero evidence", async t => {
  const r = await rig(t, "chat", JSON.stringify(whole("chat")), false);
  for (const [index, target] of protocols.entries()) {
    await (await r.post(target)).text(); const row = await r.entry(index);
    assert.equal(row.inputTokens, undefined); assert.equal(row.outputTokens, undefined); assert.equal(row.usageComplete, false); assert.equal(row.usageObservation, undefined);
  }
});

test("native broken-pipeline log is a stable snapshot even if the observer reports failure later", async t => {
  const late: Array<() => void> = [], failed = OutputUsageTracker.prototype.decoderFailed;
  // Deterministically pause only the side observer's metadata update after the
  // real loopback socket failure. Routing, pipeline and legacy counters are real.
  t.mock.method(OutputUsageTracker.prototype, "decoderFailed", function(this: OutputUsageTracker) { late.push(() => failed.call(this)); });
  const r = await rig(t, "chat", partial("chat"), true, true);
  await assert.rejects((await r.post("chat")).text());
  const persisted = await r.entry(0);
  const expires = Date.now() + 2_000;
  while (!late.length && Date.now() < expires) await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(late.length, "the native observer saw the same real socket failure");
  const snapshot = structuredClone(r.logged[0]!.usageObservation);
  assert.equal(persisted.status, 502); assert.equal(persisted.usageComplete, false);
  assert.equal(persisted.inputTokens, 10); assert.equal(persisted.outputTokens, 4);
  assert.equal(snapshot!.finalUsageObserved, false); assert.equal(snapshot!.decoderFailed, false);
  for (const update of late) update();
  assert.deepEqual(r.logged[0]!.usageObservation, snapshot, "later decoder activity cannot mutate the logged object");
  assert.deepEqual(persisted.usageObservation, snapshot);
  assert.deepEqual(new Ledger(r.dir).read()[0]!.usageObservation, snapshot);
});
