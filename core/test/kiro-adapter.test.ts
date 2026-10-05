import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { readKiroLogin } from "../src/kiro-login.ts";
import { kiroEvents, kiroRequest, listKiroModels } from "../src/kiro.ts";
import { crc32, decodeEventStream } from "../src/aws-eventstream.ts";
import { prepareOutbound } from "../src/outbound.ts";
import { decodeRequest } from "../src/inbound.ts";
import { Downstream } from "../src/downstream.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";
import type { Json, InboundRequest, OutputEvent } from "../src/protocol.ts";
import type { Provider } from "../src/types.ts";

process.env.EASYSWITCH_SECRETS = "memory";
const dir = mkdtempSync(join(tmpdir(), "es-kiro-test-"));
const path = join(dir, "native.sqlite3");
const db = new DatabaseSync(path);
db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)");
db.close();
function login(token = "test-token", extra: Json = {}) {
  const db = new DatabaseSync(path);
  db.prepare("INSERT OR REPLACE INTO auth_kv VALUES (?, ?)").run("kirocli:oidc:token", JSON.stringify({ accessToken: token, expiresAt: Date.now() + 60_000, region: "us-east-1", ...extra }));
  db.close();
}
after(() => rmSync(dir, { recursive: true, force: true }));
const provider: Provider = { id: "kiro", name: "Kiro", baseUrl: "https://unrelated.invalid", models: ["m"], kiro: { loginPath: path }, route: "chat-translate", routePinned: false, streamUsage: true, createdAt: "" };
const request: InboundRequest = { protocol: "chat", model: "m", source: "kiro", stream: false, body: { messages: [{ role: "user", content: "hello" }] } };

function frame(type: string, payload: Json): Buffer {
  const entries = Object.entries({ ":message-type": "event", ":event-type": type }).map(([k, v]) => {
    const name = Buffer.from(k); const value = Buffer.from(v); const h = Buffer.alloc(name.length + value.length + 4);
    h[0] = name.length; name.copy(h, 1); h[1 + name.length] = 7; h.writeUInt16BE(value.length, 2 + name.length); value.copy(h, 4 + name.length); return h;
  });
  const headers = Buffer.concat(entries); const data = Buffer.from(JSON.stringify(payload)); const out = Buffer.alloc(16 + headers.length + data.length);
  out.writeUInt32BE(out.length); out.writeUInt32BE(headers.length, 4); out.writeUInt32BE(crc32(out.subarray(0, 8)), 8);
  headers.copy(out, 12); data.copy(out, 12 + headers.length); out.writeUInt32BE(crc32(out.subarray(0, -4)), out.length - 4); return out;
}
const stream = (bytes: Buffer, split = 7) => new ReadableStream<Uint8Array>({ start(c) { for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.subarray(i, i + split)); c.close(); } });
const collect = async <T>(events: AsyncIterable<T>) => { const all: T[] = []; for await (const e of events) all.push(e); return all; };

test("native SQLite login is read-only, reread after renewal, and rejected after expiry", async () => {
  login(); const bytes = readFileSync(path);
  assert.equal((await readKiroLogin(path)).accessToken, "test-token"); assert.deepEqual(readFileSync(path), bytes);
  login("renewed"); assert.equal((await readKiroLogin(path)).accessToken, "renewed");
  login("expired-secret", { expiresAt: Date.now() - 1000 });
  await assert.rejects(readKiroLogin(path), e => e instanceof Error && /过期/.test(e.message) && !e.message.includes("expired-secret"));
  login("secret", { region: "example.com/path" }); await assert.rejects(readKiroLogin(path), /区域无效/);
  login();
});

test("Kiro uses fixed vendor endpoints and current login, never a provider key or redirect", async t => {
  login("first-token"); const seen: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), init });
    return String(url).includes("management.") ? Response.json({ models: [{ modelId: "m" }] }) : new Response(stream(frame("metadataEvent", { stopReason: "END_TURN" })));
  });
  assert.deepEqual((await listKiroModels(path)).models, ["m"]);
  const prepared = prepareOutbound(provider, request);
  await prepared.send("wrong-key", new AbortController().signal);
  login("second-token"); await prepared.send("wrong-key", new AbortController().signal);
  assert.equal(new URL(seen[0]!.url).hostname, "management.us-east-1.kiro.dev");
  assert.equal(seen[1]!.url, "https://runtime.us-east-1.kiro.dev/");
  assert.equal((seen[1]!.init.headers as Json).authorization, "Bearer first-token");
  assert.equal((seen[2]!.init.headers as Json).authorization, "Bearer second-token");
  assert.ok(seen.every(r => r.init.redirect === "error"));
  assert.ok(!JSON.stringify(seen.map(r => r.init.body)).includes("token"));
});

test("AWS binary frames tolerate chunk boundaries and reject CRC/truncation", async () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  const good = frame("assistantResponseEvent", { content: "hello" });
  const events = await collect(decodeEventStream(stream(good, 1)));
  assert.equal(events[0]!.headers[":event-type"], "assistantResponseEvent");
  const corrupt = Buffer.from(good); corrupt[corrupt.length - 5]! ^= 1;
  await assert.rejects(collect(decodeEventStream(stream(corrupt))), /CRC/i);
  await assert.rejects(collect(decodeEventStream(stream(good.subarray(0, -2)))), /truncat|incomplete/i);
});

test("Kiro tool stream carries usage and finish, and rejects missing completion", async () => {
  const frames = Buffer.concat([
    frame("reasoningContentEvent", { text: "thought", signature: ".KTR~~signed" }),
    frame("toolUseEvent", { toolUseId: "t1", name: "es_tool_0", input: '{"cmd":' }),
    frame("toolUseEvent", { input: '"ls"}', stop: true }),
    frame("metadataEvent", { stopReason: "TOOL_USE", tokenUsage: { uncachedInputTokens: 4, cacheReadInputTokens: 2, outputTokens: 3 } }),
  ]);
  const events = await collect(kiroEvents(stream(frames), name => name === "es_tool_0" ? "long.tool" : name));
  const output = new Downstream("messages", "m", "kiro", "kiro", []);
  for (const e of events) output.accept(e);
  const json = output.result(); assert.equal(json.stop_reason, "tool_use");
  assert.equal(json.content[1].name, "long.tool"); assert.deepEqual(json.content[1].input, { cmd: "ls" });
  assert.equal(json.usage.input_tokens, 4); assert.equal(json.usage.cache_read_input_tokens, 2);
  await assert.rejects(collect(kiroEvents(stream(frame("assistantResponseEvent", { content: "partial" })), n => n)), /结束状态/);
});

test("Kiro continuation retains signature versus redactedContent and aliases tools without hashes", async () => {
  login(); const auth = await readKiroLogin(path);
  for (const event of [{ type: "reasoning", text: "thought", signature: ".KTR~~signed" }, { type: "reasoning", encrypted: "base64redacted" }] as OutputEvent[]) {
    const output = new Downstream("messages", "m", "kiro", "kiro", []); output.accept(event);
    const native = output.result();
    const r: InboundRequest = { ...request, protocol: "messages", body: { messages: [{ role: "user", content: "hello" }, { role: "assistant", content: native.content }, { role: "user", content: "continue" }] } };
    const built = kiroRequest(decodeRequest(r), r, auth).body;
    const state = built.conversationState.history![1]!.assistantResponseMessage!.reasoningContent;
    assert.deepEqual(state, event.type === "reasoning" && event.signature ? { signature: ".KTR~~signed" } : { redactedContent: "base64redacted" });
  }
  const name = "tool." + "x".repeat(80);
  const r = { ...request, body: { messages: request.body.messages, tools: [{ type: "function", function: { name, parameters: { type: "object", additionalProperties: false } } }] } };
  const prepared = kiroRequest(decodeRequest(r), r, auth);
  const spec = (prepared.body.conversationState.currentMessage.userInputMessage.userInputMessageContext!.tools![0] as Json).toolSpecification;
  assert.equal(spec.name, "es_tool_0"); assert.equal(prepared.restoreName(spec.name), name); assert.equal(spec.inputSchema.json.additionalProperties, undefined);
});

test("Kiro import is idempotent, failures preserve the source, removal preserves native login", async t => {
  login("native-private-token"); const bytes = readFileSync(path); const nativeFetch = globalThis.fetch;
  let fail = false;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://management.")) return fail ? Response.json({}, { status: 401 }) : Response.json({ models: [{ modelId: "m" }] });
    return nativeFetch(url, init);
  });
  const store = new Store(join(dir, "store")); const server = createEasySwitchServer({ store, secrets: createSecretStore(), port: 0, kiroLoginPath: path });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const call = (method: string, path: string) => fetch(base + path, { method, headers: { "x-easyswitch": "1", "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
  assert.equal((await call("POST", "/api/kiro/import")).status, 201);
  assert.equal((await call("POST", "/api/kiro/import")).status, 200); assert.equal(store.providers().length, 1);
  assert.ok(!readFileSync(join(dir, "store/state.json"), "utf8").includes("native-private-token"));
  fail = true; assert.equal((await call("POST", "/api/kiro/import")).status, 401); assert.equal(store.providers().length, 1);
  await call("DELETE", "/api/providers/" + store.providers()[0]!.id);
  assert.equal(store.providers().length, 0); assert.deepEqual(readFileSync(path), bytes);
});
