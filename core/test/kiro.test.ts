import { fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encodeMessage } from "../src/aws-eventstream.ts";
import { conversationToKiro } from "../src/kiro.ts";
import { KiroError, readKiroLogin } from "../src/kiro-login.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { ChatRequest } from "../src/translate.ts";
import { decodeRequest } from "../src/inbound.ts";
const buildKiro = (chat: ChatRequest, login: Parameters<typeof conversationToKiro>[2]) => { const request = { protocol: "chat" as const, body: chat, model: chat.model, stream: chat.stream }; return conversationToKiro(decodeRequest(request), request, login); };

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

const TOKEN = "kiro-access-token-do-not-leak-0123456789";
const ARN = "arn:aws:codewhisperer:us-east-1:111122223333:profile/ABCDEF";

const dir = mkdtempSync(join(tmpdir(), "es-kiro-"));
const dbPath = join(dir, "data.sqlite3");

/** A Kiro CLI login database, as the CLI leaves it. */
function writeLogin(opts: { expiresAt?: string; token?: string } = {}): void {
  rmSync(dbPath, { force: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO auth_kv VALUES (?, ?)").run("kirocli:social:token", JSON.stringify({ accessToken: opts.token ?? TOKEN, expiresAt: opts.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString() }));
  db.prepare("INSERT INTO state VALUES (?, ?)").run("api.codewhisperer.profile", JSON.stringify({ arn: ARN }));
  db.close();
}

const frame = (type: string, payload: Json) => encodeMessage({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, new TextEncoder().encode(JSON.stringify(payload)));
const concat = (frames: Uint8Array[]) => Buffer.concat(frames.map(f => Buffer.from(f)));

// ---- a fake Kiro: the control plane that lists models, and the runtime that answers in an AWS event stream
interface Seen { target: string; authorization?: string; body: Json }
const seen: Seen[] = [];
let script: () => { status?: number; frames?: Uint8Array[] } = () => ({ frames: [] });
let kiro: Server;
let kiroBase: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => { let b = ""; req.on("data", c => (b += c)); req.on("end", () => resolve(b)); });
}

before(async () => {
  writeLogin();
  kiro = createServer(async (req, res) => {
    const raw = await readBody(req);
    const target = String(req.headers["x-amz-target"] ?? "");
    const entry: Seen = { target, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}), body: raw ? JSON.parse(raw) : {} };
    seen.push(entry);
    if (target.endsWith("ListAvailableModels")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ models: [{ modelId: "claude-sonnet-fake" }, { modelId: "auto" }, { modelId: "auto" }] }));
      return;
    }
    const answer = script();
    if (answer.status) { res.writeHead(answer.status, { "content-type": "application/json" }).end("{}"); return; }
    res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
    res.end(concat(answer.frames ?? []));
  });
  await new Promise<void>(r => kiro.listen(0, "127.0.0.1", r));
  kiroBase = `http://127.0.0.1:${(kiro.address() as { port: number }).port}/`;
  process.env.EASYSWITCH_KIRO_RUNTIME = kiroBase;
  process.env.EASYSWITCH_KIRO_MANAGEMENT = kiroBase;
});

after(() => { kiro.closeAllConnections(); kiro.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.EASYSWITCH_KIRO_RUNTIME; delete process.env.EASYSWITCH_KIRO_MANAGEMENT; });

// ---------------------------------------------------------------- the login

test("the Kiro CLI login is read from its own database, read-only, and a stale or missing one is refused with a plain reason", async () => {
  const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  const login = await readKiroLogin(dbPath);
  assert.equal(login.accessToken, TOKEN);
  assert.equal(login.region, "us-east-1");
  assert.equal(login.profileArn, ARN);
  assert.equal(createHash("sha256").update(readFileSync(dbPath)).digest("hex"), before, "the login database is not touched");

  writeLogin({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(readKiroLogin(dbPath), (e: KiroError) => e.status === 401 && /过期/.test(e.message) && !e.message.includes(TOKEN));
  await assert.rejects(readKiroLogin(join(dir, "nowhere.sqlite3")), (e: KiroError) => e.status === 401 && /没有找到/.test(e.message));
  writeLogin();
});

// ---------------------------------------------------------------- Chat -> Kiro

const login = { accessToken: "t", region: "us-east-1", profileArn: ARN, builderId: false };
const chat = (over: Partial<ChatRequest> & { messages: ChatRequest["messages"] }): ChatRequest => ({ model: "claude-sonnet-fake", stream: false, ...over });

test("a Chat conversation becomes Kiro's: the system text leads the first user turn, tool calls and results pair up, the last user turn is the current one", () => {
  const { body, restoreName } = buildKiro(chat({
    tools: [{ type: "function", function: { name: "ns__a_very_long_tool_name_that_kiro_would_not_accept_because_it_is_over_sixty_four_characters", description: "d", parameters: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } } } }],
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "list files" },
      { role: "assistant", content: "ok", tool_calls: [{ id: "call_1", type: "function", function: { name: "ns__a_very_long_tool_name_that_kiro_would_not_accept_because_it_is_over_sixty_four_characters", arguments: "{\"x\":\"1\"}" } }] },
      { role: "tool", tool_call_id: "call_1", content: "a.txt" },
    ],
  }), login);
  const state = body.conversationState;
  assert.equal(state.history.length, 2, "the first user turn and the assistant turn; the current turn is not in the history");
  assert.match(state.history[0].userInputMessage.content, /^Be brief\.\n\nlist files$/);
  const use = state.history[1].assistantResponseMessage.toolUses[0];
  assert.match(use.name, /^es_tool_\d+$/, "a name Kiro would refuse gets a short alias");
  assert.equal(restoreName(use.name), "ns__a_very_long_tool_name_that_kiro_would_not_accept_because_it_is_over_sixty_four_characters");
  assert.deepEqual(use.input, { x: "1" });
  const current = state.currentMessage.userInputMessage;
  assert.equal(current.content, "Continue.", "a turn with only a tool result gets a placeholder text");
  assert.equal(current.userInputMessageContext.toolResults[0].toolUseId, use.toolUseId);
  assert.equal(current.userInputMessageContext.toolResults[0].content[0].text, "a.txt");
  assert.equal(current.userInputMessageContext.tools[0].toolSpecification.name, use.name);
  assert.ok(!JSON.stringify(current.userInputMessageContext.tools).includes("additionalProperties"), "schema keys Kiro rejects are removed");
  assert.equal(body.profileArn, ARN);
});

test("what Kiro cannot do is refused or dropped on purpose, not guessed", () => {
  assert.throws(() => buildKiro(chat({ messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "f", parameters: {} } }], tool_choice: { type: "function", function: { name: "f" } } }), login), (e: KiroError) => e.status === 400 && /强制/.test(e.message));
  assert.throws(() => buildKiro(chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] }), login), (e: KiroError) => /data URL/.test(e.message));
  const none = buildKiro(chat({ tool_choice: "none", tools: [{ type: "function", function: { name: "f", parameters: {} } }], messages: [{ role: "user", content: "x" }] }), login);
  assert.equal(none.body.conversationState.currentMessage.userInputMessage.userInputMessageContext, undefined, "tool_choice none sends no tools");
  const tuned = buildKiro(chat({ messages: [{ role: "user", content: "x" }], max_tokens: 10, temperature: 0.2 }), login);
  assert.deepEqual(tuned.dropped, ["max_tokens", "temperature"]);
  const image = buildKiro(chat({ messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }] }), login);
  assert.deepEqual(image.body.conversationState.currentMessage.userInputMessage.images, [{ format: "png", source: { bytes: "iVBORw0KGgo=" } }]);
});

// ---------------------------------------------------------------- through the gateway

let server: Server;
let store: Store;
let port: number;
let kiroId: string;
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
const ask = (extra: Json = {}, path = "/v1/chat/completions", body?: Json) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken("aider")}` },
  body: JSON.stringify(body ?? { model: `${kiroId}/claude-sonnet-fake`, messages: [{ role: "user", content: "hi" }], ...extra }),
});

const sayHello = () => ({ frames: [frame("assistantResponseEvent", { content: "Hel" }), frame("assistantResponseEvent", { content: "lo" }), frame("metadataEvent", { stopReason: "END_TURN", tokenUsage: { uncachedInputTokens: 7, outputTokens: 2, cacheReadInputTokens: 3 } })] });

test("importing the Kiro login makes a source that starts switched off, lists the account's models, and stores no token", async () => {
  port = await new Promise<number>(resolve => { const p = createServer().listen(0, "127.0.0.1", () => { const n = (p.address() as { port: number }).port; p.close(() => resolve(n)); }); });
  store = new Store(join(dir, "store"));
  server = createEasySwitchServer({ store, secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));

  const made = await api("POST", "/api/kiro/import", { loginPath: dbPath });
  assert.equal(made.status, 200, await made.clone().text());
  const info = (await made.json()) as Json;
  kiroId = info.id;
  assert.equal(info.models, 2, "the models Kiro lists, once each");
  assert.equal(info.on, false, "a new subscription starts switched off");
  const provider = store.provider(kiroId)!;
  assert.deepEqual(provider.models, ["claude-sonnet-fake", "auto"]);
  assert.equal(provider.kiro?.loginPath, dbPath, "only where the login lives is kept");
  assert.equal(provider.billing, "subscription");
  assert.equal(seen[0]!.authorization, `Bearer ${TOKEN}`, "the CLI's token goes to Kiro");

  // The token is nowhere in what EasySwitch stores or shows.
  const files = readdirSync(join(dir, "store"), { recursive: true, withFileTypes: true }).filter(f => f.isFile()).map(f => readFileSync(join(f.parentPath, f.name), "utf8")).join("\n");
  assert.ok(!files.includes(TOKEN), "no token on disk");
  assert.ok(!(await (await api("GET", "/api/plan")).text()).includes(TOKEN) && !(await (await api("GET", "/api/state")).text()).includes(TOKEN));
  const listed = ((await (await api("GET", "/api/plan")).json()) as Json).accounts.find((a: Json) => a.kind === "kiro");
  assert.ok(listed && listed.on === false, "Kiro shows with the other subscriptions, with the same switch");
});

test("while it is switched off Kiro is asked for nothing; switched on, a Chat request is answered, streaming or not", async () => {
  const calls = seen.length;
  const off = await ask();
  assert.equal(off.status, 404);
  assert.match(((await off.json()) as Json).error.message, /switched off/);
  assert.equal(seen.length, calls, "nothing reached Kiro");

  assert.equal((await api("PUT", `/api/plan/${kiroId}/switch`, { on: true })).status, 200);
  script = sayHello;
  const plain = await ask();
  assert.equal(plain.status, 200);
  const answer = (await plain.json()) as Json;
  assert.equal(answer.choices[0].message.content, "Hello");
  assert.equal(answer.choices[0].finish_reason, "stop");
  assert.deepEqual(answer.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 3 } });
  const sent = seen.at(-1)!;
  assert.match(sent.target, /GenerateAssistantResponse$/);
  assert.equal(sent.authorization, `Bearer ${TOKEN}`);
  assert.equal(sent.body.conversationState.currentMessage.userInputMessage.modelId, "claude-sonnet-fake", "the model name as Kiro knows it");
  assert.equal(sent.body.profileArn, ARN);

  const streamed = await (await ask({ stream: true })).text();
  const chunks = streamed.split("\n\n").filter(l => l.startsWith("data: ") && !l.includes("[DONE]")).map(l => JSON.parse(l.slice(6)) as Json);
  assert.equal(chunks.map(c => c.choices[0].delta.content ?? "").join(""), "Hello");
  assert.equal(chunks.at(-1)!.choices[0].finish_reason, "stop");
  assert.ok(streamed.trimEnd().endsWith("data: [DONE]"));
  assert.ok(!plain.headers.get("authorization") && !JSON.stringify(answer).includes(TOKEN) && !streamed.includes(TOKEN), "the token never comes back");
});

test("a tool call from Kiro comes back as a Chat tool call, with the agent's own tool name restored", async () => {
  const long = "ns__a_very_long_tool_name_that_kiro_would_not_accept_because_it_is_over_sixty_four_characters";
  script = () => ({ frames: [
    frame("assistantResponseEvent", { content: "Looking." }),
    frame("toolUseEvent", { toolUseId: "tooluse_abc", name: "es_tool_0", input: "{\"x\":" }),
    frame("toolUseEvent", { toolUseId: "tooluse_abc", input: "\"1\"}" }),
    frame("toolUseEvent", { toolUseId: "tooluse_abc", stop: true }),
    frame("metadataEvent", { stopReason: "TOOL_USE" }),
  ] });
  const res = await ask({ tools: [{ type: "function", function: { name: long, description: "d", parameters: { type: "object", properties: { x: { type: "string" } } } } }] });
  const message = ((await res.json()) as Json).choices[0];
  assert.equal(message.finish_reason, "tool_calls");
  assert.equal(message.message.tool_calls[0].function.name, long);
  assert.equal(message.message.tool_calls[0].function.arguments, "{\"x\":\"1\"}");
  assert.equal(message.message.tool_calls[0].id, "tooluse_abc");

  // Claude Code's protocol reaches it too: the gateway translates Messages to Chat first.
  script = sayHello;
  const viaMessages = await ask({}, "/v1/messages", { model: `${kiroId}/claude-sonnet-fake`, max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
  assert.equal(viaMessages.status, 200, await viaMessages.clone().text());
  assert.equal(((await viaMessages.json()) as Json).content[0].text, "Hello");
});

test("failures reach the agent as plain, honest errors: a stream that never finishes, a refused login, a used-up plan", async () => {
  script = () => ({ frames: [frame("assistantResponseEvent", { content: "half" })] }); // no stop reason
  const cut = await ask();
  assert.equal(cut.status, 502, "an unfinished answer is an error, not a success");
  assert.match(((await cut.json()) as Json).error.message, /未收到有效结束状态/);
  const cutStream = await (await ask({ stream: true })).text();
  assert.match(cutStream, /未收到有效结束状态/);
  assert.ok(!/"finish_reason":"stop"/.test(cutStream), "an unfinished stream is never made to look finished");

  script = () => ({ status: 429 });
  const limited = await ask();
  assert.equal(limited.status, 429);
  assert.match(((await limited.json()) as Json).error.message, /额度不足或请求过于频繁/);

  writeLogin({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  const stale = await ask();
  assert.equal(stale.status, 401);
  assert.match(((await stale.json()) as Json).error.message, /过期/);
  writeLogin();
});

test("removing the Kiro source leaves the Kiro CLI's own login exactly as it was", async () => {
  const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
  assert.equal((await api("DELETE", `/api/kiro/${kiroId}`)).status, 200);
  assert.equal(store.provider(kiroId), undefined);
  assert.equal(createHash("sha256").update(readFileSync(dbPath)).digest("hex"), before);
  assert.equal((await api("DELETE", `/api/kiro/${kiroId}`)).status, 404);
  server.closeAllConnections(); server.close();
});
