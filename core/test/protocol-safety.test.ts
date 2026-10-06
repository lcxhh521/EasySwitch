import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";
import { prepareOutbound, sourceProtocols } from "../src/outbound.ts";
import { keySecretId } from "../src/keypool.ts";
import type { ApiProtocol, Provider } from "../src/types.ts";

type Json = Record<string, any>;
const protocols: ApiProtocol[] = ["chat", "responses", "messages", "gemini"];
const bodyOf = (protocol: ApiProtocol): Json => protocol === "gemini" ? { contents: [{ role: "user", parts: [{ text: "hello" }] }] } : protocol === "responses" ? { input: "hello" } : { messages: [{ role: "user", content: "hello" }], ...(protocol === "messages" ? { max_tokens: 12 } : {}) };
const pathOf = (protocol: ApiProtocol, model: string, stream = false) => protocol === "gemini" ? `/v1beta/models/${encodeURIComponent(model)}:${stream ? "streamGenerateContent" : "generateContent"}` : protocol === "chat" ? "/v1/chat/completions" : `/v1/${protocol}`;
const listen = async (server: ReturnType<typeof createServer>) => { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
async function rig(t: TestContext, protocol: ApiProtocol, answer: (req: IncomingMessage, res: ServerResponse, body: Json) => void) {
  const dir = mkdtempSync(join(tmpdir(), "es-protocol-safety-"));
  const store = new Store(dir); const secrets = createSecretStore();
  const seen: Array<{ path: string; headers: IncomingMessage["headers"]; body: Json }> = [];
  const upstream = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw); seen.push({ path: req.url!, headers: req.headers, body }); answer(req, res, body);
  });
  const baseUrl = await listen(upstream);
  const p: Provider = { id: "source", name: "Source", baseUrl, models: ["m"], protocols: [protocol], route: "chat-translate", routePinned: false, streamUsage: false, createdAt: "" };
  store.upsertProvider(p); await secrets.set("source", "fake-source-key");
  const gateway = createEasySwitchServer({ store, secrets, port: 0 }); const origin = await listen(gateway);
  t.after(() => { for (const server of [upstream, gateway]) { server.closeAllConnections(); server.close(); } rmSync(dir, { recursive: true, force: true }); });
  const post = (body: Json = {}, model = "source/m", signal?: AbortSignal) => fetch(origin + pathOf(protocol, model, body.stream === true), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer fake-client-only", "x-api-key": "fake-client-only", "x-goog-api-key": "fake-client-only", "anthropic-version": "2023-06-01", "anthropic-beta": "test-beta" }, body: JSON.stringify({ ...bodyOf(protocol), ...body, ...(protocol === "gemini" ? {} : { model }) }), signal });
  return { store, secrets, p, seen, origin, post };
}

for (const protocol of protocols) {
  test(`${protocol}: native errors preserve bytes, status and safe retry headers`, async t => {
    const raw = ' {"error":{"message":"native failure","extra":[1,2]}}\n';
    const { post, seen } = await rig(t, protocol, (_req, res) => res.writeHead(429, { "content-type": "application/problem+json", "retry-after": "17", "retry-after-ms": "170", "x-should-retry": "false", "x-request-id": "request-fake", "x-ratelimit-remaining-tokens": "0", "anthropic-ratelimit-tokens-reset": "tomorrow", "set-cookie": "upstream-secret=hidden", "x-private": "hidden" }).end(raw));
    const response = await post({ vendor_unknown: { nested: [1, true] } });
    assert.equal(response.status, 429); assert.equal(await response.text(), raw);
    assert.equal(response.headers.get("retry-after"), "17"); assert.equal(response.headers.get("retry-after-ms"), "170"); assert.equal(response.headers.get("x-should-retry"), "false"); assert.equal(response.headers.get("x-request-id"), "request-fake");
    assert.equal(response.headers.get("x-ratelimit-remaining-tokens"), "0"); assert.equal(response.headers.get("anthropic-ratelimit-tokens-reset"), "tomorrow");
    assert.equal(response.headers.get("set-cookie"), null); assert.equal(response.headers.get("x-private"), null);
    assert.deepEqual(seen[0]!.body.vendor_unknown, { nested: [1, true] });
    assert.ok(!JSON.stringify(seen[0]!.headers).includes("fake-client-only"));
  });
  test(`${protocol}: native SSE retains CRLF, comments, event ids and unknown events`, async t => {
    const raw = ': ping\r\nid: 7\r\nevent: vendor.extension\r\ndata: {"extra":"你好"}\r\n\r\ndata: [DONE]\r\n\r\n';
    const { post } = await rig(t, protocol, (_req, res) => res.writeHead(201, { "content-type": "text/event-stream", "cache-control": "private" }).end(raw));
    const response = await post({ stream: true });
    assert.equal(response.status, 201); assert.equal(response.headers.get("cache-control"), "private"); assert.equal(await response.text(), raw);
  });
  test(`${protocol}: empty success and non-JSON errors are not rewritten`, async t => {
    let status = 204;
    const { post } = await rig(t, protocol, (_req, res) => res.writeHead(status, { "content-type": "text/plain" }).end(status === 204 ? undefined : "<native failure>\n"));
    const empty = await post(); assert.equal(empty.status, 204); assert.equal(await empty.text(), "");
    status = 503; const error = await post(); assert.equal(error.status, 503); assert.equal(await error.text(), "<native failure>\n");
  });
}

test("normalized model capabilities choose Messages for a context-suffixed model", async t => {
  const r = await rig(t, "messages", (_req, res) => res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'));
  r.p.protocols = ["chat"]; r.p.modelProtocols = { m: ["messages"] }; r.store.upsertProvider(r.p);
  assert.deepEqual(sourceProtocols(r.p, "m[1m]"), ["messages"]);
  const response = await r.post({}, "source/m[1m]"); assert.equal(response.status, 200); await response.text();
  assert.equal(r.seen[0]!.path, "/messages"); assert.equal(r.seen[0]!.body.model, "m");
});

test("a native auth failure retries another fake source key before any output", async t => {
  const r = await rig(t, "responses", (req, res) => res.writeHead(req.headers.authorization === "Bearer second" ? 202 : 401, { "content-type": "application/json", "retry-after": "1" }).end('{"native":true}'));
  r.p.keys = ["a", "b"].map(id => ({ id, label: id, enabled: true, addedAt: "" })); r.store.upsertProvider(r.p);
  await r.secrets.set(keySecretId("source", "a"), "first"); await r.secrets.set(keySecretId("source", "b"), "second");
  const response = await r.post(); assert.equal(response.status, 202); assert.equal(await response.text(), '{"native":true}');
  assert.deepEqual(r.seen.map(s => s.headers.authorization), ["Bearer first", "Bearer second"]);
  assert.deepEqual(r.seen[0]!.body, r.seen[1]!.body);
});

test("native stream failure after output never retries another model pool member", async t => {
  const r = await rig(t, "chat", (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"partial":true}\n\n');
    setTimeout(() => res.destroy(), 25);
  });
  r.store.upsertProvider({ ...r.p, id: "second" }); r.store.upsertPool({ id: "stream-test", name: "Pool", strategy: "order", members: ["source/m", "second/m"], createdAt: "" });
  const response = await r.post({ stream: true }, "pool/stream-test");
  await assert.rejects(response.text()); assert.equal(r.seen.length, 1);
});

test("client disconnect cancels its local upstream and never starts another pool member", async t => {
  let closed!: () => void; const upstreamClosed = new Promise<void>(r => { closed = r; });
  const r = await rig(t, "responses", (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); res.write('data: {"partial":true}\n\n'); res.once("close", closed);
  });
  r.store.upsertProvider({ ...r.p, id: "second" }); r.store.upsertPool({ id: "cancel-test", name: "Pool", strategy: "order", members: ["source/m", "second/m"], createdAt: "" });
  const abort = new AbortController(); const response = await r.post({ stream: true }, "pool/cancel-test", abort.signal);
  const reader = response.body!.getReader(); await reader.read(); abort.abort();
  await Promise.race([upstreamClosed, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("upstream did not close")), 2000); timer.unref(); })]);
  assert.equal(r.seen.length, 1);
});

test("an already-cancelled request never reaches fetch or key retry", async t => {
  let calls = 0; t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  const p: Provider = { id: "unused", name: "Unused", baseUrl: "http://127.0.0.1:1", models: ["m"], protocols: ["chat"], route: "chat-translate", routePinned: false, streamUsage: false, createdAt: "" };
  const abort = new AbortController(); abort.abort();
  const result = await prepareOutbound(p, { protocol: "chat", model: "m", stream: false, body: bodyOf("chat") }).send("fake", abort.signal);
  assert.ok(result instanceof Error); assert.equal(calls, 0);
});

test("provider diagnostics reject redirects at the transport and never persist echoed upstream secrets", async t => {
  const { timedFetch, describeFailure } = await import("../src/upstream.ts");
  let observed: RequestInit | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { observed = init; return new Response("echoed-fixture-key and private prompt", { status: 401 }); });
  const abort = new AbortController();
  const { response } = await timedFetch("http://127.0.0.1:1/fixture", { headers: { "x-api-key": "echoed-fixture-key" }, signal: abort.signal });
  assert.equal(observed!.redirect, "error");
  assert.equal(await describeFailure(response), "HTTP 401");
  abort.abort();
  assert.equal(observed!.signal!.aborted, true);
});
