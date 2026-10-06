import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";
import { prepareOutbound, sourceProtocols } from "../src/outbound.ts";
import { Downstream } from "../src/downstream.ts";
import { readOutput } from "../src/upstream-events.ts";
import { packState, type Json, type InboundRequest } from "../src/protocol.ts";
import type { ApiProtocol, Provider } from "../src/types.ts";

process.env.EASYSWITCH_SECRETS = "memory";
const dir = mkdtempSync(join(tmpdir(), "es-adapters-"));
const store = new Store(dir);
const secrets = createSecretStore();
const received: Array<{ path: string; headers: Json; body: Json }> = [];
let upstream: Server; let gateway: Server; let origin = ""; let base = "";
let reply: Json = {}; let rawReply: string | undefined;
const sse = (...events: Json[]) => events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("");
const provider = (protocols: ApiProtocol[], extra: Partial<Provider> = {}): Provider => ({
  id: "source", name: "Source", baseUrl: base, models: ["m"], protocols,
  route: "chat-translate", routePinned: false, streamUsage: false, createdAt: new Date().toISOString(), ...extra,
});
const listen = async (s: Server) => { await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); return "http://127.0.0.1:" + (s.address() as { port: number }).port; };
before(async () => {
  upstream = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    received.push({ path: req.url!, headers: req.headers, body: JSON.parse(raw) });
    res.writeHead(200, { "content-type": rawReply === undefined ? "application/json" : "text/event-stream" });
    res.end(rawReply ?? JSON.stringify(reply));
  });
  base = await listen(upstream);
  gateway = createEasySwitchServer({ store, secrets, port: 0 }); origin = await listen(gateway);
  await secrets.set("source", "test-source-key");
});
after(() => { for (const s of [upstream, gateway]) { s.closeAllConnections(); s.close(); } rmSync(dir, { recursive: true, force: true }); });
const paths: Record<ApiProtocol, string> = { chat: "/v1/chat/completions", responses: "/v1/responses", messages: "/v1/messages", gemini: "/v1beta/models/source%2Fm:generateContent" };
async function post(protocol: ApiProtocol, body: Json) {
  return fetch(origin + paths[protocol], { method: "POST", headers: { "content-type": "application/json", ...(protocol === "messages" ? { "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta" } : {}) }, body: JSON.stringify({ ...body, ...(protocol === "gemini" ? {} : { model: "source/m" }) }) });
}
const asks: Record<ApiProtocol, Json> = {
  chat: { messages: [{ role: "user", content: "hello" }], response_format: { type: "json_object" }, vendor_option: "keep" },
  responses: { input: "hello", previous_response_id: "resp_native", tools: [{ type: "web_search" }], metadata: { keep: true } },
  messages: { messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }], max_tokens: 400, thinking: { type: "adaptive" }, metadata: { user_id: "keep" } },
  gemini: { contents: [{ role: "user", parts: [{ text: "hello" }] }], cachedContent: "cached/keep", safetySettings: [{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" }] },
};

for (const protocol of Object.keys(asks) as ApiProtocol[]) test(protocol + " same-protocol preserves native fields and response bytes", async () => {
  store.upsertProvider(provider([protocol])); rawReply = undefined; reply = { vendor_reply: "untouched" };
  const result = await post(protocol, asks[protocol]!);
  assert.equal(result.status, 200); assert.equal(await result.text(), JSON.stringify(reply));
  const sent = received.at(-1)!;
  assert.deepEqual(sent.body, { ...asks[protocol], ...(protocol === "gemini" ? {} : { model: "m" }) });
  if (protocol === "gemini") { assert.equal(sent.path, "/models/m:generateContent"); assert.equal(sent.headers["x-goog-api-key"], "test-source-key"); assert.equal(sent.headers.authorization, undefined); }
  else if (protocol === "messages") { assert.equal(sent.headers["x-api-key"], "test-source-key"); assert.equal(sent.headers["anthropic-beta"], "test-beta"); }
  else assert.equal(sent.headers.authorization, "Bearer test-source-key");
});

test("Chat reaches a Responses-only source and consumes completed-only streaming output", async () => {
  store.upsertProvider(provider(["responses"]));
  rawReply = sse({ type: "response.completed", response: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "from responses" }] }], usage: { input_tokens: 8, output_tokens: 3 } } });
  const result = await post("chat", { messages: [{ role: "user", content: "hello" }] });
  assert.equal(result.status, 200);
  const json = await result.json() as Json;
  assert.equal(json.choices[0].message.content, "from responses"); assert.equal(json.usage.prompt_tokens, 8);
  assert.equal(received.at(-1)!.path, "/responses");
  assert.deepEqual(received.at(-1)!.body.input[0].content, [{ type: "input_text", text: "hello" }]);
});

test("Chat uses Messages tools and replays signed thinking only to the same source/model", async () => {
  store.upsertProvider(provider(["messages"])); rawReply = undefined;
  reply = { content: [{ type: "thinking", thinking: "consider", signature: "native-signature" }, { type: "tool_use", id: "call1", name: "shell", input: { cmd: "ls" } }], stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 2 } };
  const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }];
  const message = ((await (await post("chat", { tools, messages: [{ role: "user", content: "ls" }] })).json()) as Json).choices[0].message;
  assert.equal(message.tool_calls[0].function.name, "shell");
  const request = { tools, messages: [{ role: "user", content: "ls" }, message, { role: "tool", tool_call_id: "call1", content: "files" }] };
  await (await post("chat", request)).text();
  const history = received.at(-1)!.body.messages;
  assert.deepEqual(history[1].content[0], { type: "thinking", thinking: "consider", signature: "native-signature" });
  assert.equal(history[2].content[0].tool_use_id, "call1");
  const foreign = prepareOutbound(provider(["messages"], { id: "other" }), { protocol: "chat", model: "m", stream: false, body: request });
  await foreign.send("key", new AbortController().signal);
  assert.ok(foreign.dropped.includes("reasoning:foreign_state"));
  assert.ok(!JSON.stringify(received.at(-1)!.body).includes("native-signature"));
});

test("same-protocol wrapped history does not rebuild other native fields", async () => {
  const saved = packState("source", "m", { protocol: "messages", signature: "unwrapped", text: "thought" });
  const body: Json = { ...asks.messages, messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "thought", signature: saved }, { type: "thinking", thinking: "native", signature: "leave-native" }, { type: "text", text: "hello", cache_control: { type: "ephemeral" } }] }] };
  const prepared = prepareOutbound(provider(["messages"]), { protocol: "messages", model: "m", stream: false, body });
  await prepared.send("key", new AbortController().signal);
  assert.equal(received.at(-1)!.body.messages[0].content[0].signature, "unwrapped");
  assert.deepEqual(received.at(-1)!.body.messages[0].content.slice(1), body.messages[0]!.content.slice(1));
  assert.deepEqual(received.at(-1)!.body.thinking, body.thinking);
});

test("Gemini tool signatures survive a Chat client round trip before tool calls", async () => {
  store.upsertProvider(provider(["gemini"])); rawReply = undefined;
  reply = { candidates: [{ content: { parts: [{ functionCall: { id: "g1", name: "shell", args: { cmd: "ls" } }, thoughtSignature: "gemini-sig" }] }, finishReason: "STOP" }] };
  const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }];
  const first = await (await post("chat", { tools, messages: [{ role: "user", content: "ls" }] })).json() as Json;
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  await (await post("chat", { tools, messages: [{ role: "user", content: "ls" }, first.choices[0].message, { role: "tool", tool_call_id: "g1", content: "files" }] })).text();
  assert.equal(received.at(-1)!.body.contents[1].parts[0].thoughtSignature, "gemini-sig");
});

test("fragmented Chat tool headers restore Responses namespace and custom-tool output", async () => {
  const request: InboundRequest = { protocol: "responses", model: "m", stream: true, body: { input: "hello", tools: [{ type: "namespace", name: "fs", tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }, { type: "custom", name: "patch", format: { type: "text" } }] } };
  const prepared = prepareOutbound(provider(["chat"]), request);
  const stream = sse(
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_", function: { name: "fs__", arguments: "" } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "1", function: { name: "read", arguments: '{"path":"a"}' } }, { index: 1, id: "p1", function: { name: "patch", arguments: '{"input":"patch text"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  );
  const chunks: string[] = [];
  const output = new Downstream("responses", "m", "source", "chat", prepared.tools, c => chunks.push(c));
  for await (const e of readOutput(new Response(stream, { headers: { "content-type": "text/event-stream" } }), "chat")) output.accept(e);
  output.finish();
  const result = output.result();
  assert.equal(result.output[0].call_id, "call_1"); assert.equal(result.output[0].namespace, "fs"); assert.equal(result.output[0].name, "read");
  assert.equal(result.output[1].type, "custom_tool_call"); assert.equal(result.output[1].input, "patch text");
  assert.match(chunks.join(""), /response.custom_tool_call_input.done/);
});

test("truncated upstream streams fail, length limits remain incomplete, malformed history returns 400", async () => {
  store.upsertProvider(provider(["responses"]));
  rawReply = sse({ type: "response.output_text.delta", delta: "partial" });
  const truncated = await post("chat", { messages: [{ role: "user", content: "hello" }], stream: true });
  const text = await truncated.text(); assert.match(text, /"error"/); assert.doesNotMatch(text, /\[DONE\]/);
  const out = new Downstream("responses", "m", "source", "chat", []);
  for await (const e of readOutput(Response.json({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] }), "chat")) out.accept(e);
  assert.equal(out.result().status, "incomplete"); assert.equal(out.result().incomplete_details.reason, "max_output_tokens");
  store.upsertProvider(provider(["messages"]));
  const bad = await post("chat", { messages: [{ role: "assistant", tool_calls: [{ id: "x", function: { name: "shell", arguments: "{" } }] }] });
  assert.equal(bad.status, 400);
});

test("source/model capability settings persist and failed Chat probes do not force Chat", async () => {
  store.upsertProvider(provider(["responses"]));
  const res = await fetch(origin + "/api/providers/source/protocols", { method: "PUT", headers: { "x-easyswitch": "1", "content-type": "application/json" }, body: JSON.stringify({ model: "m", protocols: ["gemini"] }) });
  assert.equal(res.status, 200);
  const saved = new Store(dir).provider("source")!;
  assert.deepEqual(sourceProtocols(saved, "m"), ["gemini"]); assert.deepEqual(sourceProtocols(saved, "another"), ["responses"]);
  assert.equal(prepareOutbound(saved, { protocol: "chat", model: "m", stream: false, body: { messages: [] } }).protocol, "gemini");
  const native = provider(["responses", "messages"]);
  assert.equal(prepareOutbound(native, { protocol: "messages", model: "m", stream: false, body: asks.messages! }).protocol, "messages");
  const legacy = provider([], { route: "responses-native", probe: { at: "", model: "m", recommendedRoute: "responses-native", checks: [{ id: "chat", label: "chat", status: "fail", detail: "unsupported" }] } });
  assert.deepEqual(sourceProtocols(legacy, "m"), ["responses"]);
});

test("Messages to Chat retries an output-limit error with the same key, but leaves other errors intact", async t => {
  const sent: Array<{ url: string; init: RequestInit; body: Json }> = [];
  let error = "max_tokens exceeds the model output limit";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    return sent.length === 1 ? Response.json({ error: { message: error } }, { status: 400 }) : Response.json({ ok: true });
  });
  const request: InboundRequest = { protocol: "messages", model: "m", stream: false, body: { messages: [{ role: "user", content: "hello" }], max_tokens: 32000 } };
  const prepared = prepareOutbound(provider(["chat"]), request);
  const response = await prepared.send("retry-key", new AbortController().signal);
  assert.ok(response instanceof Response); assert.equal(response.status, 200); assert.equal(sent.length, 2);
  assert.equal(sent[0]!.body.max_tokens, 32000); assert.equal(sent[1]!.body.max_tokens, undefined);
  assert.deepEqual(sent[0]!.init.headers, sent[1]!.init.headers);
  assert.equal((sent[1]!.init.headers as Json).authorization, "Bearer retry-key");
  assert.equal(sent[0]!.url, sent[1]!.url); assert.ok(prepared.dropped.includes("max_tokens:upstream_limit"));
  sent.length = 0; error = "unsupported tool schema";
  const bad = await prepareOutbound(provider(["chat"]), request).send("retry-key", new AbortController().signal);
  assert.ok(bad instanceof Response); assert.equal(bad.status, 400); assert.equal(sent.length, 1);
  assert.match(await bad.text(), /unsupported tool schema/);
});

test("Gemini signed visible text stays visible in JSON and SSE, with native replay", async () => {
  store.upsertProvider(provider(["gemini"])); rawReply = undefined;
  reply = { candidates: [{ content: { parts: [{ text: "visible answer", thoughtSignature: "text-sig" }] }, finishReason: "STOP" }] };
  const first = await (await post("chat", { messages: [{ role: "user", content: "hello" }] })).json() as Json;
  assert.equal(first.choices[0].message.content, "visible answer");
  assert.ok(!first.choices[0].message.reasoning_content, "a signature does not make visible text into reasoning");
  await (await post("chat", { messages: [{ role: "user", content: "hello" }, first.choices[0].message] })).text();
  assert.deepEqual(received.at(-1)!.body.contents[1].parts, [{ text: "visible answer", thoughtSignature: "text-sig" }]);
  const wire = sse(
    { candidates: [{ content: { parts: [{ text: "visible " }] } }] },
    { candidates: [{ content: { parts: [{ text: "answer", thoughtSignature: "text-sig" }] }, finishReason: "STOP" }] },
  );
  for (const target of ["chat", "responses", "messages"] as ApiProtocol[]) {
    const output = new Downstream(target, "m", "source", "gemini", []);
    for await (const e of readOutput(new Response(wire, { headers: { "content-type": "text/event-stream" } }), "gemini")) output.accept(e);
    const result = output.result();
    if (target === "chat") assert.equal(result.choices[0].message.content, "visible answer");
    else if (target === "responses") assert.equal(result.output.find((i: Json) => i.type === "message").content[0].text, "visible answer");
    else assert.equal(result.content.find((i: Json) => i.type === "text").text, "visible answer");
  }
});

test("signed Messages blocks keep their original order through a Chat client", async () => {
  store.upsertProvider(provider(["messages"])); rawReply = undefined;
  const content = [
    { type: "thinking", thinking: "first thought", signature: "sig-first" },
    { type: "text", text: "first text" },
    { type: "thinking", thinking: "second thought", signature: "sig-second" },
    { type: "tool_use", id: "signed-call", name: "shell", input: { cmd: "ls" } },
    { type: "text", text: "last text" },
  ];
  reply = { content, stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 2 } };
  const tools = [{ type: "function", function: { name: "shell", parameters: { type: "object" } } }];
  const first = await (await post("chat", { tools, messages: [{ role: "user", content: "hello" }] })).json() as Json;
  const message = first.choices[0].message;
  assert.equal(message.content, "first textlast text");
  await (await post("chat", { tools, messages: [{ role: "user", content: "hello" }, message, { role: "tool", tool_call_id: "signed-call", content: "files" }] })).text();
  assert.deepEqual(received.at(-1)!.body.messages[1].content, content);
  const count = received.length;
  const changed = await post("chat", { tools, messages: [{ ...message, content: "changed" }] });
  assert.equal(changed.status, 400); assert.equal(received.length, count, "changed signed replay fails before upstream I/O");
});

test("Gemini converted SSE preserves the same signed block order as a whole response", () => {
  const chunks: string[] = [];
  const out = new Downstream("gemini", "m", "source", "messages", [], c => chunks.push(c));
  out.accept({ type: "reasoning", index: 0, text: "think", signature: "sig" });
  out.accept({ type: "block_end", kind: "reasoning", index: 0 });
  out.accept({ type: "call", index: 1, id: "c1", name: "shell", arguments: '{"cmd":"ls"}' });
  out.accept({ type: "block_end", kind: "call", index: 1 });
  out.accept({ type: "text", index: 2, text: "after tool" });
  out.accept({ type: "stop", reason: "tool" });
  out.finish();
  const parts: Json[] = [];
  for (const part of chunks.flatMap(chunk => JSON.parse(chunk.slice(6)).candidates[0].content.parts)) {
    const previous = parts.at(-1);
    if (part.thought && part.text === "" && part.thoughtSignature && previous?.thought) previous.thoughtSignature = part.thoughtSignature;
    else parts.push(part);
  }
  assert.deepEqual(parts, out.result().candidates[0].content.parts);
  assert.deepEqual(parts.map((p: Json) => p.thought ? "thought" : p.functionCall ? "call" : "text"), ["thought", "call", "text"]);
});

test("token-limited partial tool arguments keep truncation semantics without executable malformed objects", async () => {
  for (const protocol of ["responses", "chat", "messages", "gemini"] as ApiProtocol[]) {
    const chunks: string[] = [];
    const out = new Downstream(protocol, "m", "source", "chat", [], c => chunks.push(c));
    for await (const event of readOutput(Response.json({ choices: [{ message: { content: "partial", tool_calls: [{ id: "partial-call", type: "function", function: { name: "shell", arguments: '{"cmd":' } }] }, finish_reason: "length" }] }), "chat")) out.accept(event);
    out.finish(); const result = out.result();
    if (protocol === "responses") {
      assert.equal(result.status, "incomplete"); assert.equal(result.output[1].status, "incomplete"); assert.equal(result.output[1].arguments, '{"cmd":');
      assert.match(chunks.join(""), /response.incomplete/);
    } else if (protocol === "chat") { assert.equal(result.choices[0].finish_reason, "length"); assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"cmd":'); }
    else if (protocol === "messages") { assert.equal(result.stop_reason, "max_tokens"); assert.ok(result.content.every((p: Json) => p.type !== "tool_use")); }
    else { assert.equal(result.candidates[0].finishReason, "MAX_TOKENS"); assert.ok(result.candidates[0].content.parts.every((p: Json) => !p.functionCall)); }
  }
});

const matrixAsks: Record<ApiProtocol, Json> = {
  chat: { messages: [{ role: "user", content: "matrix input" }], tools: [{ type: "function", function: { name: "echo", parameters: { type: "object" } } }] },
  responses: { input: "matrix input", tools: [{ type: "function", name: "echo", parameters: { type: "object" } }] },
  messages: { messages: [{ role: "user", content: "matrix input" }], max_tokens: 32, tools: [{ name: "echo", input_schema: { type: "object" } }] },
  gemini: { contents: [{ role: "user", parts: [{ text: "matrix input" }] }], tools: [{ functionDeclarations: [{ name: "echo", parameters: { type: "OBJECT" } }] }] },
};
const matrixReplies: Record<ApiProtocol, Json> = {
  chat: { choices: [{ message: { content: "matrix output" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } },
  responses: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "matrix output" }] }], usage: { input_tokens: 2, output_tokens: 3 } },
  messages: { content: [{ type: "text", text: "matrix output" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 3 } },
  gemini: { candidates: [{ content: { parts: [{ text: "matrix output" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 } },
};
const matrixStreams: Record<ApiProtocol, string> = {
  chat: sse({ choices: [{ delta: { content: "matrix output" }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } }),
  responses: sse({ type: "response.completed", response: matrixReplies.responses }),
  messages: sse({ type: "message_start", message: { usage: { input_tokens: 2, output_tokens: 0 } } }, { type: "content_block_start", index: 0, content_block: { type: "text", text: "matrix output" } }, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }),
  gemini: sse(matrixReplies.gemini!),
};
for (const from of Object.keys(matrixAsks) as ApiProtocol[]) for (const to of Object.keys(matrixAsks) as ApiProtocol[]) {
  if (from === to) continue;
  test(`${from} -> ${to}: direct request construction and JSON/SSE response conversion`, async () => {
    store.upsertProvider(provider([to])); rawReply = undefined; reply = matrixReplies[to]!;
    const result = await post(from, matrixAsks[from]!);
    assert.equal(result.status, 200); assert.match(await result.text(), /matrix output/);
    const request = received.at(-1)!;
    assert.match(JSON.stringify(request.body), /matrix input/); assert.match(JSON.stringify(request.body.tools), /echo/);
    if (to === "responses") { assert.equal(request.path, "/responses"); assert.ok(Array.isArray(request.body.input)); assert.equal(request.body.messages, undefined); }
    if (to === "gemini") { assert.equal(request.path, "/models/m:generateContent"); assert.ok(Array.isArray(request.body.contents)); assert.equal(request.body.messages, undefined); }
    if (to === "messages") { assert.equal(request.path, "/messages"); assert.equal(request.body.tools[0].input_schema.type, "object"); }
    if (to === "chat") { assert.equal(request.path, "/chat/completions"); assert.equal(request.body.tools[0].function.name, "echo"); }
    rawReply = matrixStreams[to];
    const streamPath = from === "gemini" ? paths.gemini.replace(":generateContent", ":streamGenerateContent") : paths[from];
    const streaming = await fetch(origin + streamPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...matrixAsks[from], stream: true, ...(from === "gemini" ? {} : { model: "source/m" }) }) });
    assert.equal(streaming.status, 200); assert.match(streaming.headers.get("content-type")!, /text\/event-stream/); assert.match(await streaming.text(), /matrix output/);
  });
}

test("cross-protocol loss reports field names only and rejects ambiguous flattened tools", () => {
  const prepared = prepareOutbound(provider(["messages"]), { protocol: "chat", model: "m", stream: false, body: { messages: [{ role: "user", content: "hi" }], vendor_option: "private value", metadata: { private: "value" } } });
  assert.deepEqual(prepared.dropped, ["field:vendor_option", "field:metadata"]);
  assert.ok(!JSON.stringify(prepared.dropped).includes("private"));
  assert.throws(() => prepareOutbound(provider(["chat"]), { protocol: "responses", model: "m", stream: false, body: { input: "hi", tools: [{ type: "function", name: "fs__read" }, { type: "namespace", name: "fs", tools: [{ type: "function", name: "read" }] }] } }), /冲突/);
});

test("protocol setting rejects empty normalized models and preserves prototype-like model names", async () => {
  store.upsertProvider(provider(["chat"]));
  const update = (body: Json) => fetch(origin + "/api/providers/source/protocols", { method: "PUT", headers: { "x-easyswitch": "1", "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await update({ model: "[1m]", protocols: ["messages"] })).status, 400);
  assert.deepEqual(store.provider("source")!.protocols, ["chat"]);
  assert.equal((await update({ model: "__proto__", protocols: ["responses"] })).status, 200);
  assert.deepEqual(sourceProtocols(new Store(dir).provider("source")!, "__proto__"), ["responses"]);
  assert.deepEqual(sourceProtocols(store.provider("source")!, "toString"), ["chat"]);
});

test("Gemini uses an explicitly configured key header without adding the default key header", async () => {
  const prepared = prepareOutbound(provider(["gemini"], { wire: { authHeader: "api-key", authScheme: "raw" } }), { protocol: "gemini", model: "m", stream: false, body: matrixAsks.gemini! });
  await prepared.send("fake-custom-key", new AbortController().signal);
  assert.equal(received.at(-1)!.headers["api-key"], "fake-custom-key");
  assert.equal(received.at(-1)!.headers["x-goog-api-key"], undefined);
  assert.equal(received.at(-1)!.headers.authorization, undefined);
});

test("an agent's saved off switch reaches the source as its model-owned none spelling", async () => {
  store.upsertProvider(provider(["chat"], { reasoningEffort: true, modelEfforts: { m: ["none", "high"] } }));
  store.setPrefs("pi", { effort: "off" });
  rawReply = undefined; reply = { choices: [{ message: { role: "assistant", content: "okay" }, finish_reason: "stop" }] };
  try {
    const response = await fetch(origin + paths.chat, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken("pi")}` }, body: JSON.stringify({ model: "source/m", messages: [{ role: "user", content: "fixture" }] }) });
    assert.equal(response.status, 200); await response.text();
    assert.equal(received.at(-1)!.body.reasoning_effort, "none");
  } finally { store.setPrefs("pi", { effort: "" }); }
});
