import { existingSubscriptionKind, prepareExistingSubscription } from "../src/subscription-compat.ts";
import { pickKey, setCursorToken } from "../src/keypool.ts";
import { fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chatToTurn, sendCursor } from "../src/cursor/adapter.ts";
import { clearCursorCache } from "../src/cursor/auth.ts";
import { encodeFrame, endStreamError, FrameParser } from "../src/cursor/connect.ts";
import { decodeServer, encodeRun } from "../src/cursor/messages.ts";
import { bytesOf, readFields, stringOf, uintOf, Writer } from "../src/cursor/proto.ts";
import { clearQuota, isExhausted } from "../src/quota.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { ChatRequest } from "../src/translate.ts";
import type { Provider } from "../src/types.ts";
import { startFakeCursor, type FakeCursor } from "./fake-cursor.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

// ---------------------------------------------------------------- the pieces

test("the protobuf writer and reader agree, including big numbers, empty messages and nested ones", () => {
  const bytes = new Writer().uint(1, 300).string(2, "héllo").message(3, new Writer().uint(1, 2 ** 31 + 5)).message(4, new Writer()).finish();
  const f = readFields(bytes);
  assert.equal(uintOf(f, 1), 300);
  assert.equal(stringOf(f, 2), "héllo");
  assert.equal(uintOf(readFields(bytesOf(f, 3)!), 1), 2 ** 31 + 5);
  assert.equal(bytesOf(f, 4)!.length, 0, "an empty message is still there");
  assert.throws(() => readFields(Buffer.from([0x0a, 0x05, 0x01])), /truncated/);
});

test("Connect frames are cut and joined at any chunk boundary, and an end frame says whether it failed", () => {
  const wire = Buffer.concat([encodeFrame(Buffer.from("one")), encodeFrame(Buffer.from("two!"), 0), encodeFrame(Buffer.from('{"error":{"code":"resource_exhausted","message":"x"}}'), 2)]);
  const parser = new FrameParser();
  const frames = [];
  for (let i = 0; i < wire.length; i += 3) frames.push(...parser.push(wire.subarray(i, i + 3)));
  assert.deepEqual(frames.map(x => x.payload.toString().slice(0, 4)), ["one", "two!", '{"er']);
  assert.equal(frames[2]!.flags, 2);
  assert.equal(endStreamError(frames[2]!.payload)?.code, "resource_exhausted");
  assert.equal(endStreamError(Buffer.from("{}")), undefined);
  assert.throws(() => new FrameParser().push(Buffer.from([0, 0xff, 0xff, 0xff, 0xff])), /过大/);
});

test("a Chat conversation becomes a turn: system apart, tool traffic as plain text, same-role messages joined, the last user message to answer", () => {
  const chat: ChatRequest = { model: "m", stream: false, messages: [
    { role: "system", content: "Be brief." }, { role: "system", content: "Be kind." },
    { role: "user", content: "first" }, { role: "user", content: [{ type: "text", text: "second" }] },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "ls", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "a.txt" },
    { role: "assistant", content: "one file" }, { role: "user", content: "and now?" },
  ] };
  const turn = chatToTurn(chat);
  assert.equal(turn.system, "Be brief.\n\nBe kind.");
  assert.equal(turn.user, "and now?");
  assert.deepEqual(turn.history.map(h => h.role), ["user", "assistant", "user", "assistant"]);
  assert.match(turn.history[1]!.text, /调用了工具 ls/);
  assert.match(turn.history[2]!.text, /a\.txt/);
  assert.equal(chatToTurn({ model: "m", stream: false, messages: [{ role: "assistant", content: "x" }] }).user, "请继续。");
});

test("a run request carries the model, the message, an empty tool list and the history as blobs addressed by their hash; server messages decode to events", () => {
  const prepared = encodeRun({ system: "S", history: [{ role: "user", text: "q" }, { role: "assistant", text: "a" }], user: "now", modelId: "fake-claude-high" });
  const run = readFields(bytesOf(readFields(prepared.first), 1)!);
  assert.equal(stringOf(readFields(bytesOf(run, 3)!), 1), "fake-claude-high");
  assert.ok(bytesOf(run, 4) !== undefined && bytesOf(run, 4)!.length === 0);
  assert.match(stringOf(run, 5)!, /^cursor_[0-9a-f]{32}$/);
  const roots = readFields(bytesOf(run, 1)!).filter(f => f.field === 1).map(f => (f.value as Buffer).toString("hex"));
  assert.equal(roots.length, 3);
  const json = roots.map(id => JSON.parse(prepared.blobs.get(id)!.toString()));
  assert.deepEqual(json[0], { role: "system", content: "S" });
  assert.deepEqual(json[1], { role: "user", content: [{ type: "text", text: "q" }] }, "history is a list of parts, not a bare string");
  assert.deepEqual(json[2], { role: "assistant", content: [{ type: "text", text: "a" }] });

  const msg = (field: number, inner: Writer) => new Writer().message(1, new Writer().message(field, inner)).finish();
  assert.deepEqual(decodeServer(msg(1, new Writer().string(1, "hi"))), { kind: "text", text: "hi" });
  assert.deepEqual(decodeServer(msg(4, new Writer().string(1, "hmm"))), { kind: "thinking", text: "hmm" });
  assert.deepEqual(decodeServer(msg(14, new Writer())), { kind: "turnEnded" });
  assert.deepEqual(decodeServer(msg(2, new Writer())), { kind: "needsTool" });
  assert.deepEqual(decodeServer(msg(13, new Writer())), { kind: "ignored" });
});

// ---------------------------------------------------------------- through the server

let fake: FakeCursor;
let server: Server;
let store: Store;
let port = 0;
let accountId = "";
let providerId = "";
const secrets = createSecretStore();
const dir = mkdtempSync(join(tmpdir(), "es-cursor-"));
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
const ask = (extra: Json = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken("aider")}` },
  body: JSON.stringify({ model: `${providerId}/fake-claude-high`, messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }], ...extra }),
});

before(async () => {
  process.env.EASYSWITCH_TEST_SUBSCRIPTION_FIXTURES = "1";
  fake = await startFakeCursor();
  process.env.EASYSWITCH_CURSOR_API = fake.base;
  process.env.EASYSWITCH_CURSOR_WEB = fake.base;
  process.env.EASYSWITCH_CURSOR_POLL_MS = "5";
  port = await new Promise<number>(resolve => { const p = createServer().listen(0, "127.0.0.1", () => { const n = (p.address() as { port: number }).port; p.close(() => resolve(n)); }); });
  store = new Store(join(dir, "store"));
  server = createEasySwitchServer({ store, secrets, port, openUrl: async url => { fake.approve(url); } });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
});
after(() => {
  delete process.env.EASYSWITCH_TEST_SUBSCRIPTION_FIXTURES;
  server.closeAllConnections(); server.close(); fake.close(); rmSync(dir, { recursive: true, force: true });
  for (const k of ["API", "WEB", "POLL_MS"]) delete process.env[`EASYSWITCH_CURSOR_${k}`];
});

async function signIn(): Promise<Json> {
  const start = await api("POST", "/api/cursor/signin", {});
  assert.equal(start.status, 200, await start.clone().text());
  const url = new URL(((await start.json()) as Json).url);
  assert.equal(url.pathname, "/loginDeepControl");
  assert.equal(url.searchParams.get("redirectTarget"), "cli");
  assert.ok(!url.search.includes("verifier"), "the verifier never leaves this machine except to the poll");
  let state: Json = {};
  for (let i = 0; i < 200 && !["done", "error"].includes(state.signIn?.status); i++) {
    state = (await (await api("GET", "/api/plan")).json()) as Json;
    if (!["done", "error"].includes(state.signIn?.status)) await new Promise(r => setTimeout(r, 20));
  }
  return state;
}

test("signing in makes a source that starts switched off, keeps the refresh token in the secret store only, and lists the account's models", async () => {
  const state = await signIn();
  assert.equal(state.signIn.status, "done", JSON.stringify(state.signIn));
  const account = state.accounts.find((a: Json) => a.kind === "cursor");
  assert.ok(account, "it shows with the other subscriptions");
  assert.equal(account.email, "person@example.com");
  assert.equal(account.on, false);
  accountId = account.id;
  const provider = store.providers().find(p => p.cursor)!;
  providerId = provider.id;
  assert.deepEqual(provider.models, ["fake-claude-high", "fake-gpt-medium"]);
  assert.equal(provider.off, true);
  assert.equal(await secrets.get(`cursor:${accountId}`), "refresh-1");
  assert.equal(fake.modelCalls.at(-1)!.bodyLength, 0, "the model list is asked for with an empty body");
  assert.equal(fake.modelCalls.at(-1)!.contentType, "application/proto");
  const files = readdirSync(join(dir, "store"), { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => readFileSync(join(f.parentPath, f.name), "utf8")).join("\n");
  assert.ok(!files.includes("refresh-1") && !files.includes(".sig"), "no token on disk");
  const shown = (await (await api("GET", "/api/plan")).text()) + (await (await api("GET", "/api/state")).text());
  assert.ok(!shown.includes("refresh-1") && !shown.includes(".sig"), "no token in anything the console is shown");
});

test("while it is off Cursor is asked for nothing; on, a request is answered streaming or not, and the server's questions are answered", async () => {
  const runs = fake.runs.length;
  const off = await ask();
  assert.equal(off.status, 404);
  assert.equal(fake.runs.length, runs);

  assert.equal((await api("PUT", `/api/plan/${accountId}/switch`, { on: true })).status, 200);
  fake.script = () => ({ thinking: ["let me see. "], text: ["Hel", "lo"], tokens: 2, checkpoint: { used: 40, max: 200000 } });
  const plain = await ask();
  assert.equal(plain.status, 200);
  const answer = (await plain.json()) as Json;
  assert.equal(answer.choices[0].message.content, "Hello");
  assert.equal(answer.choices[0].message.reasoning_content, "let me see. ");
  assert.deepEqual(answer.usage, { prompt_tokens: 38, completion_tokens: 2, total_tokens: 40 }, "the context size less what it wrote");

  const run = fake.runs.at(-1)!;
  assert.equal(run.headers[":path"], "/agent.v1.AgentService/Run");
  assert.equal(run.headers["content-type"], "application/connect+proto");
  assert.equal(run.headers["connect-protocol-version"], "1");
  assert.match(String(run.headers.authorization), /^Bearer .+\..+\.sig$/);
  assert.equal(run.headers["x-cursor-client-type"], "cli");
  assert.ok(run.headers["x-request-id"] && run.headers["x-session-id"]);
  assert.equal(run.modelId, "fake-claude-high");
  assert.equal(run.userText, "hi");
  assert.equal(run.hasTools, true, "the empty tool list is sent");
  assert.equal(run.rootBlobIds.length, 1, "only the system message is history");
  // The server asked for the stored piece by its id and got the system message back; it asked for the context and got an answer.
  const kv = run.replies.find(r => r.kind === "kv")!;
  assert.deepEqual(JSON.parse(kv.data!.toString()), { role: "system", content: "Be brief." });
  assert.equal(kv.id, 7);
  const exec = run.replies.find(r => r.kind === "exec")!;
  assert.deepEqual([exec.id, exec.execId], [9, "exec-1"], "ids are echoed back");

  const streamed = await (await ask({ stream: true })).text();
  assert.ok(streamed.includes('"content":"Hel"') && streamed.includes('"content":"lo"') && streamed.includes('"reasoning_content":"let me see. "'));
  assert.ok(streamed.includes('"finish_reason":"stop"') && streamed.includes('"total_tokens":40') && streamed.trimEnd().endsWith("data: [DONE]"));
  assert.ok(!JSON.stringify(answer).includes(".sig") && !streamed.includes(".sig"), "the token never comes back");
});

test("Cursor uses its configured endpoint rather than a persisted arbitrary source URL", async () => {
  const provider = store.provider(providerId)!;
  provider.baseUrl = "https://must-not-contact.invalid";
  provider.wire = { authHeader: "x-leak", headers: { "x-leak": "must-not-forward" } };
  store.upsertProvider(provider);
  assert.equal((await ask()).status, 200);
  assert.equal(fake.runs.at(-1)!.headers["x-leak"], undefined);
  const prepared = prepareExistingSubscription(provider, { protocol: "chat", model: "fake-claude-high", stream: false, body: { messages: [{ role: "assistant", tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{}" } }] }], tools: [{ type: "function", function: { name: "f", parameters: {} } }] } });
  assert.ok(prepared.dropped.includes("tools:cursor_text_only"));
  assert.ok(prepared.dropped.includes("tool_history:cursor_text_only"));
});

test("failures reach the agent as plain errors with the right status, and an exhausted account is marked so pools skip it", async () => {
  clearQuota();
  fake.script = () => ({ plain: true, error: { code: "resource_exhausted", message: "rate limit exceeded" } });
  const limited = await ask();
  assert.equal(limited.status, 429);
  assert.match(((await limited.json()) as Json).error.message, /额度用完了/);
  assert.equal(isExhausted(providerId), true);
  clearQuota();

  fake.script = () => ({ plain: true, error: { code: "unauthenticated", message: "bad token" } });
  const refused = await ask();
  assert.equal(refused.status, 401);
  assert.match(((await refused.json()) as Json).error.message, /重新登录/);

  fake.script = () => ({ plain: true, status: 401 });
  assert.equal((await ask()).status, 401, "an HTTP error status is read before any frame");

  fake.script = () => ({ plain: true, error: { code: "failed_precondition", message: "model unavailable for this plan" } });
  const plan = await ask();
  assert.equal(plan.status, 400);
  assert.match(((await plan.json()) as Json).error.message, /套餐/);

  fake.script = () => ({ plain: true, tool: true });
  const tool = await ask();
  assert.equal(tool.status, 501);
  assert.match(((await tool.json()) as Json).error.message, /纯文字/);

  fake.script = () => ({ plain: true, compressed: true });
  assert.equal((await ask()).status, 502);
});

test("an access token that has ended is renewed from the refresh token before the request goes out", async () => {
  clearCursorCache();
  fake.script = () => ({ plain: true, text: ["ok"] });
  const before = fake.refreshes.length;
  assert.equal((await ask()).status, 200);
  assert.equal(fake.refreshes.length, before + 1);
  assert.equal(fake.refreshes.at(-1), "Bearer refresh-1");
  // That token was the renewed one, and it is kept for the next request.
  const claim = JSON.parse(Buffer.from(String(fake.runs.at(-1)!.headers.authorization).split(".")[1]!, "base64url").toString());
  assert.ok(claim.n >= 2, "the request carried the renewed token, not the first one");
  assert.equal((await ask()).status, 200);
  assert.equal(fake.refreshes.length, before + 1, "not renewed again while it is still good");

  fake.refreshToken = "rotated"; clearCursorCache();
  const gone = await ask();
  assert.equal(gone.status, 401, "a refresh token Cursor no longer knows means sign in again");
  assert.match(((await gone.json()) as Json).error.message, /重新登录|过期/);
  fake.refreshToken = "refresh-1";
});

test("heartbeats go out while Cursor is quiet, and silence ends in a timeout", async () => {
  const provider = { id: "x", name: "x", baseUrl: fake.base, models: [], route: "chat-translate", streamUsage: false } as unknown as Provider;
  const chat: ChatRequest = { model: "m", stream: false, messages: [{ role: "user", content: "hi" }] };
  fake.script = () => ({ plain: true, silent: true });
  const timedOut = await sendCursor(provider, "tok", chat, new AbortController().signal, { heartbeatMs: 20, silenceMs: 150 });
  assert.equal(timedOut.status, 504);
  const beats = fake.runs.at(-1)!.replies.filter(r => r.kind === "heartbeat").length;
  assert.ok(beats >= 3, `heartbeats while waiting: ${beats}`);
  const none = await sendCursor(provider, undefined, chat, new AbortController().signal);
  assert.equal(none.status, 401);
});

test("removing the account forgets the login and the source", async () => {
  assert.equal((await api("DELETE", `/api/cursor/${accountId}`)).status, 200);
  assert.equal(store.providers().find(p => p.cursor), undefined);
  assert.equal(await secrets.get(`cursor:${accountId}`), undefined);
  assert.equal((await api("DELETE", `/api/cursor/${accountId}`)).status, 404);
});


test("Cursor metadata is validated and missing account resolver never falls back to an API key", async () => {
  const base = { id: "fixture", baseUrl: fake.base, cursor: { accountId: "fixture-user" } } as Provider;
  for (const metadata of [null, {}, [], { accountId: "" }, { accountId: "x", loginPath: "/must-not-read" }]) assert.throws(() => existingSubscriptionKind({ ...base, cursor: metadata } as Provider));
  assert.equal(existingSubscriptionKind(base), "cursor");
  let reads = 0;
  const empty = createSecretStore(); empty.get = async () => { reads++; return "must-not-fallback"; };
  setCursorToken(async () => "fixture-cursor-token");
  try { assert.equal((await pickKey(empty, base)).apiKey, "fixture-cursor-token"); assert.equal(reads, 0); }
  finally { setCursorToken(undefined); }
  await assert.rejects(pickKey(empty, base), /不会改用普通 API Key/);
  assert.equal(reads, 0);
});
