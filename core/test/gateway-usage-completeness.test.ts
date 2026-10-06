import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { Ledger } from "../src/ledger.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { OutputUsageTracker, readOutput, usageOf } from "../src/upstream-events.ts";
import type { ApiProtocol } from "../src/types.ts";

type Json = Record<string, any>;
const sse = (...values: Json[]) => values.map(v => `data: ${JSON.stringify(v)}\n\n`).join("");
const usage = { chat: { prompt_tokens: 10, completion_tokens: 4 }, responses: { input_tokens: 10, output_tokens: 4 }, messages: { input_tokens: 10, output_tokens: 4 }, gemini: { promptTokenCount: 10, candidatesTokenCount: 4 } };
const partial = (p: ApiProtocol) => p === "chat" ? sse({ choices: [{ delta: { content: "partial" } }], usage: usage.chat }) : p === "responses" ? sse({ type: "response.output_text.delta", delta: "partial", usage: usage.responses }) : p === "messages" ? sse({ type: "message_start", message: { usage: usage.messages } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } }) : sse({ candidates: [{ content: { parts: [{ text: "partial" }] } }], usageMetadata: usage.gemini });
const complete = (p: ApiProtocol, u: Json = usage[p]) => p === "chat" ? sse({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }, { choices: [], usage: u }) + "data: [DONE]\n\n" : p === "responses" ? sse({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }], usage: u } }) : p === "messages" ? sse({ type: "message_start", message: { usage: { input_tokens: u.input_tokens, output_tokens: 0 } } }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: u.output_tokens } }, { type: "message_stop" }) : sse({ candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }], usageMetadata: u });
async function rig(t: TestContext, p: ApiProtocol, answer: (res: ServerResponse) => void) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-usage-complete-")), store = new Store(dir), ledger = new Ledger(dir), auth = new GatewayTokenAuthority();
  const listen = async (s: ReturnType<typeof createServer>) => { await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}`; };
  const upstream = createServer(async (req, res) => { for await (const _ of req) {} answer(res); }); const origin = await listen(upstream);
  store.upsertProvider({ id: "p", name: "fixture", baseUrl: origin, models: ["m"], protocols: [p], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "", prices: { m: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } });
  const server = createEasySwitchServer({ store, ledger, gatewayAuth: auth, secrets: { async get() { return "fake"; }, async set() {}, async delete() {} }, port: 0 }); const base = await listen(server); const token = auth.issue("test", {}).token;
  t.after(() => { for (const s of [server, upstream]) { s.closeAllConnections(); s.close(); } rmSync(dir, { recursive: true, force: true }); });
  const post = () => fetch(base + (p === "gemini" ? "/v1beta/models/p%2Fm:streamGenerateContent" : p === "chat" ? "/v1/chat/completions" : `/v1/${p}`), { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "p/m", stream: true, ...(p === "gemini" ? { contents: [{ role: "user", parts: [{ text: "fake" }] }] } : p === "responses" ? { input: "fake" } : { messages: [{ role: "user", content: "fake" }], max_tokens: 20 }) }) });
  const entry = async () => { for (let i = 0; i < 100; i++) { if (ledger.read().length) return ledger.read()[0]!; await new Promise(r => setTimeout(r, 2)); } assert.fail("missing local usage record"); };
  const postMessages = () => fetch(base + "/v1/messages", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ model: "p/m", messages: [{ role: "user", content: "fake" }], max_tokens: 32000 }) });
  return { post, postMessages, entry, store };
}

for (const p of ["chat", "responses", "messages", "gemini"] as const) {
  test(`${p}: native usage followed by clean EOF preserves bytes but is not a complete cost`, async t => {
    const raw = partial(p); const r = await rig(t, p, res => res.writeHead(200, { "content-type": "text/event-stream" }).end(raw));
    const response = await r.post(); assert.equal(response.status, 200); assert.equal(await response.text(), raw);
    const entry = await r.entry(); assert.equal(entry.usageComplete, false); assert.equal(entry.inputTokens, 10);
  });
  test(`${p}: a native terminal plus genuine final counters can be complete`, async t => {
    const raw = complete(p); const r = await rig(t, p, res => res.writeHead(200, { "content-type": "text/event-stream" }).end(raw));
    assert.equal(await (await r.post()).text(), raw);
    const entry = await r.entry(); assert.equal(entry.usageComplete, true); assert.equal(entry.inputTokens, 10); assert.equal(entry.outputTokens, 4);
  });
  test(`${p}: missing raw output counters cannot become a known zero through defaults`, async t => {
    const inputOnly = p === "chat" ? { prompt_tokens: 10 } : p === "gemini" ? { promptTokenCount: 10 } : { input_tokens: 10 };
    const raw = complete(p, inputOnly); const r = await rig(t, p, res => res.writeHead(200, { "content-type": "text/event-stream" }).end(raw));
    await (await r.post()).text(); assert.equal((await r.entry()).usageComplete, false);
    let last: Json | undefined;
    for await (const event of readOutput(new Response(raw, { headers: { "content-type": "text/event-stream" } }), p)) if (event.type === "usage") last = event.usage;
    assert.equal(last?.complete, false);
  });
}

test("a broken native stream preserves its partial counters but never marks them complete", async t => {
  const r = await rig(t, "chat", res => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(partial("chat")); setTimeout(() => res.destroy(), 25); });
  await assert.rejects((await r.post()).text()); const entry = await r.entry();
  assert.equal(entry.status, 502); assert.equal(entry.usageComplete, false); assert.equal(entry.inputTokens, 10); assert.equal(entry.outputTokens, 4);
});

test("only terminal usage is complete, even when early usage contains valid nonzero counters", () => {
  const t = new OutputUsageTracker("chat", true);
  t.take({ choices: [{ delta: { content: "a" } }], usage: usage.chat }); t.take({ choices: [{ delta: {}, finish_reason: "stop" }] }); t.done();
  assert.equal(t.finish()?.complete, false);
  const realZero = usageOf("chat", { prompt_tokens: 0, completion_tokens: 0 }); assert.equal(realZero.complete, true);
  for (const value of [{ prompt_tokens: 1 }, { prompt_tokens: "1", completion_tokens: 1 }, { prompt_tokens: 1, completion_tokens: -1 }]) assert.equal(usageOf("chat", value).complete, false);
});

test("unmapped Gemini thought and Messages cache-write charges remain uncertain without guessing prices", () => {
  assert.equal(usageOf("gemini", { ...usage.gemini, thoughtsTokenCount: 2 }).complete, false);
  assert.equal(usageOf("messages", { ...usage.messages, cache_creation_input_tokens: 2 }).complete, false);
  assert.equal(usageOf("gemini", { ...usage.gemini, thoughtsTokenCount: 0 }).complete, true);
});

test("translated streams expose partial counters before final completion, then upgrade only at terminal", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  const seen: Json[] = [];
  const done = (async () => { for await (const e of readOutput(new Response(stream, { headers: { "content-type": "text/event-stream" } }), "messages")) if (e.type === "usage") seen.push(e.usage); })();
  controller.enqueue(new TextEncoder().encode(sse({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } })));
  await new Promise(r => setImmediate(r)); assert.equal(seen[0]?.complete, false);
  controller.enqueue(new TextEncoder().encode(sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } }, { type: "message_stop" })));
  controller.close(); await done; assert.equal(seen.at(-1)?.complete, true);
});


test("a successful final key-pool attempt stays incomplete because earlier retry usage is unobserved", async t => {
  let calls = 0;
  const r = await rig(t, "chat", res => {
    calls++;
    if (calls === 1) res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "fake limit" }, usage: { prompt_tokens: 999, completion_tokens: 1 } }));
    else res.writeHead(200, { "content-type": "text/event-stream" }).end(complete("chat"));
  });
  const p = r.store.provider("p")!; p.keys = ["a", "b"].map(id => ({ id, label: id, enabled: true, addedAt: "" })); r.store.upsertProvider(p);
  const response = await r.post(); assert.equal(response.status, 200); await response.text();
  const entry = await r.entry(); assert.equal(calls, 2); assert.equal(entry.usageComplete, false); assert.equal(entry.inputTokens, 10);
});

test("the max-token compatibility retry cannot label only its last attempt's fees complete", async t => {
  let calls = 0;
  const r = await rig(t, "chat", res => {
    calls++;
    if (calls === 1) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "max_tokens exceeds maximum limit" } }));
    else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: usage.chat }));
  });
  const response = await r.postMessages(); assert.equal(response.status, 200); await response.text();
  const entry = await r.entry(); assert.equal(calls, 2); assert.equal(entry.usageComplete, false); assert.ok(entry.dropped?.includes("max_tokens:upstream_limit"));
});
