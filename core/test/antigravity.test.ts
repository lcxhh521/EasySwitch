import { fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ANTIGRAVITY_CLIENT_ID } from "../src/antigravity-client.ts";
import { clearAntigravityCache } from "../src/antigravity.ts";
import { chatToGemini, geminiSchema, geminiToChatResponse, THOUGHT_SIGNATURE_BYPASS } from "../src/gemini-upstream.ts";
import { clearQuota, isExhausted } from "../src/quota.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { ChatRequest } from "../src/translate.ts";
import { authorizeUrl, startFakeGoogle, type FakeGoogle } from "./fake-google.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

const chat = (over: Partial<ChatRequest> & { messages: ChatRequest["messages"] }): ChatRequest => ({ model: "gemini-fake-pro", stream: false, ...over });

// ---------------------------------------------------------------- Chat <-> Gemini

test("a Chat conversation becomes Gemini contents: system apart, tool calls and results paired by name, same-role turns merged, the first call signed", () => {
  const { body, restoreName } = chatToGemini(chat({
    tools: [{ type: "function", function: { name: "ns__a_name_that_is_far_too_long_for_gemini_because_it_goes_on_and_on_over_sixty_four", description: "d", parameters: { type: "object", additionalProperties: false, properties: { x: { type: ["string", "null"] }, mode: { const: "fast" } } } } }],
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
      { role: "assistant", content: "ok", tool_calls: [
        { id: "call_1", type: "function", function: { name: "ns__a_name_that_is_far_too_long_for_gemini_because_it_goes_on_and_on_over_sixty_four", arguments: "{\"x\":\"1\"}" } },
        { id: "call_2", type: "function", function: { name: "ns__a_name_that_is_far_too_long_for_gemini_because_it_goes_on_and_on_over_sixty_four", arguments: "{\"x\":\"2\"}" } },
      ] },
      { role: "tool", tool_call_id: "call_1", content: "r1" },
      { role: "tool", tool_call_id: "call_2", content: "r2" },
    ],
  }));
  assert.deepEqual(body.systemInstruction.parts, [{ text: "Be brief." }]);
  assert.equal(body.contents.length, 3, "user turns merged, then the model turn, then one user turn holding both results");
  assert.deepEqual(body.contents[0].parts, [{ text: "hi" }, { text: "again" }]);
  const calls = body.contents[1].parts.filter((p: Json) => p.functionCall);
  assert.match(calls[0].functionCall.name, /^es_fn_\d+$/, "a name Gemini would refuse gets an alias");
  assert.equal(restoreName(calls[0].functionCall.name), "ns__a_name_that_is_far_too_long_for_gemini_because_it_goes_on_and_on_over_sixty_four");
  assert.equal(calls[0].thoughtSignature, THOUGHT_SIGNATURE_BYPASS, "the first call of a model turn carries the signature stand-in");
  assert.equal(calls[1].thoughtSignature, undefined, "and only the first");
  assert.equal(body.contents[2].parts.length, 2);
  assert.deepEqual(body.contents[2].parts[0].functionResponse, { name: calls[0].functionCall.name, response: { result: "r1" } });
  const decl = body.tools[0].functionDeclarations[0];
  assert.equal(decl.name, calls[0].functionCall.name);
  assert.deepEqual(decl.parameters.properties.x, { type: "string", nullable: true });
  assert.deepEqual(decl.parameters.properties.mode, { enum: ["fast"], type: "string" });
  assert.ok(!JSON.stringify(decl).includes("additionalProperties"), "schema keys Gemini rejects are removed");
});

test("tool choice, images and sampling are carried, and what cannot be is refused or listed", () => {
  const tool = { type: "function", function: { name: "f", parameters: {} } };
  assert.equal(chatToGemini(chat({ tool_choice: "none", tools: [tool], messages: [{ role: "user", content: "x" }] })).body.tools, undefined);
  assert.deepEqual(chatToGemini(chat({ tool_choice: "required", tools: [tool], messages: [{ role: "user", content: "x" }] })).body.toolConfig, { functionCallingConfig: { mode: "ANY" } });
  assert.deepEqual(chatToGemini(chat({ tool_choice: { type: "function", function: { name: "f" } }, tools: [tool], messages: [{ role: "user", content: "x" }] })).body.toolConfig, { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["f"] } });
  const img = chatToGemini(chat({ messages: [{ role: "user", content: [{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } }] }] }));
  assert.deepEqual(img.body.contents[0].parts[1], { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } });
  assert.throws(() => chatToGemini(chat({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] })), /data URL/);
  const tuned = chatToGemini(chat({ messages: [{ role: "user", content: "x" }], max_tokens: 5, temperature: 0.1, top_p: 0.9, parallel_tool_calls: false }));
  assert.deepEqual(tuned.body.generationConfig, { maxOutputTokens: 5, temperature: 0.1, topP: 0.9 });
  assert.deepEqual(tuned.dropped, ["parallel_tool_calls"]);
  assert.equal(chatToGemini(chat({ model: "claude-fake", tools: [tool], messages: [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }] })).body.contents[1].parts[0].thoughtSignature, undefined, "the stand-in is for Gemini models only");
  assert.deepEqual(geminiSchema(undefined), { type: "object", properties: {} });
});

const sse = (events: Json[]) => new Response(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const restore = (n: string) => n;

test("Gemini's stream becomes Chat: thoughts as reasoning, calls as tool calls, usage and the finish reason; an unfinished stream is an error", async () => {
  const events = [
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "thinking", thought: true }, { text: "Hel" }] } }] } },
    { response: { candidates: [{ content: { role: "model", parts: [{ text: "lo" }, { functionCall: { name: "f", args: { a: 1 } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 1, totalTokenCount: 8, cachedContentTokenCount: 2 } } },
  ];
  const plain = (await (await geminiToChatResponse(sse(events), { stream: false, model: "m", restoreName: restore })).json()) as Json;
  assert.equal(plain.choices[0].message.content, "Hello");
  assert.equal(plain.choices[0].message.reasoning_content, "thinking");
  assert.equal(plain.choices[0].message.tool_calls[0].function.arguments, "{\"a\":1}");
  assert.equal(plain.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(plain.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8, prompt_tokens_details: { cached_tokens: 2 } });
  const streamed = await (await geminiToChatResponse(sse(events), { stream: true, model: "m", restoreName: restore })).text();
  assert.ok(streamed.includes("\"reasoning_content\":\"thinking\"") && streamed.trimEnd().endsWith("data: [DONE]"));
  const cut = await geminiToChatResponse(sse([events[0]!]), { stream: false, model: "m", restoreName: restore });
  assert.equal(cut.status, 502, "an unfinished answer is an error, not a success");
  assert.match(await cut.text(), /没有正常结束/);
  const length = (await (await geminiToChatResponse(sse([{ response: { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] } }]), { stream: false, model: "m", restoreName: restore })).json()) as Json;
  assert.equal(length.choices[0].finish_reason, "length");
});

// ---------------------------------------------------------------- sign in and use, through the gateway

let google: FakeGoogle;
let server: Server;
let store: Store;
let port: number;
let accountId = "";
let providerId = "";
const secrets = createSecretStore();
const dir = mkdtempSync(join(tmpdir(), "es-ag-"));
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });
const ask = (extra: Json = {}, model = () => `${providerId}/gemini-fake-pro`) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureToken("aider")}` },
  body: JSON.stringify({ model: model(), messages: [{ role: "user", content: "hi" }], ...extra }),
});
const hello = () => ({ events: [{ response: { candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, totalTokenCount: 5 } } }] });

before(async () => {
  google = await startFakeGoogle();
  process.env.EASYSWITCH_ANTIGRAVITY_AUTH = `${google.base}/auth`;
  process.env.EASYSWITCH_ANTIGRAVITY_TOKEN = `${google.base}/token`;
  process.env.EASYSWITCH_ANTIGRAVITY_USERINFO = `${google.base}/userinfo`;
  process.env.EASYSWITCH_ANTIGRAVITY_API = google.base;
  process.env.EASYSWITCH_ANTIGRAVITY_POLL_MS = "1";
  port = await new Promise<number>(resolve => { const p = createServer().listen(0, "127.0.0.1", () => { const n = (p.address() as { port: number }).port; p.close(() => resolve(n)); }); });
  store = new Store(join(dir, "store"));
  server = createEasySwitchServer({
    store, secrets, port,
    // The "browser": go to Google (the fake), approve, and come back to the page this machine opened.
    openUrl: async url => {
      const callback = new URL(authorizeUrl(google, url));
      assert.equal(callback.protocol, "http:");
      assert.equal(callback.hostname, "127.0.0.1", "only the fake local callback is opened");
      // The callback's redirect back to the UI is unnecessary for this fake browser step.
      // Never enable automatic redirect following under the local-only test guard.
      await fetch(callback, { redirect: "manual" }).then(r => r.text());
    },
  });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
});

after(() => {
  server.closeAllConnections(); server.close(); google.close(); rmSync(dir, { recursive: true, force: true });
  for (const k of ["AUTH", "TOKEN", "USERINFO", "API", "POLL_MS"]) delete process.env[`EASYSWITCH_ANTIGRAVITY_${k}`];
});

async function signIn(): Promise<Json> {
  const start = await api("POST", "/api/antigravity/signin", {});
  assert.equal(start.status, 200, await start.clone().text());
  const started = (await start.json()) as Json;
  assert.equal(new URL(started.url).searchParams.get("client_id"), ANTIGRAVITY_CLIENT_ID);
  assert.equal(new URL(started.url).searchParams.get("code_challenge_method"), "S256");
  let state: Json = {};
  for (let i = 0; i < 100 && !["done", "error"].includes(state.signIn?.status); i++) {
    state = (await (await api("GET", "/api/plan")).json()) as Json;
    if (!["done", "error"].includes(state.signIn?.status)) await new Promise(r => setTimeout(r, 30));
  }
  return state;
}

test("signing in with Google makes a source that starts switched off, keeps the refresh token in the secret store only, and lists the account's models", async () => {
  const state = await signIn();
  assert.equal(state.signIn.status, "done", JSON.stringify(state.signIn));
  const account = state.accounts.find((a: Json) => a.kind === "antigravity");
  assert.ok(account, "it shows with the other subscriptions");
  assert.equal(account.email, "person@example.com");
  assert.equal(account.on, false, "a new subscription starts switched off");
  accountId = account.id;
  const provider = store.providers().find(p => p.antigravity)!;
  providerId = provider.id;
  assert.equal(provider.antigravity!.projectId, "proj-fake");
  assert.deepEqual(provider.models, ["gemini-fake-pro", "claude-fake"], "the account's models, without the internal ones");
  assert.equal(provider.off, true);
  // PKCE and the client were checked by the fake Google; the refresh token is in the secret store and nowhere else.
  assert.equal(google.tokenCalls[0]!.grant_type, "authorization_code");
  assert.equal(await secrets.get(`antigravity:${accountId}`), "1//fake-refresh");
  const files = readdirSync(join(dir, "store")).map(f => readFileSync(join(dir, "store", f), "utf8")).join("\n");
  assert.ok(!files.includes("1//fake-refresh") && !files.includes("ya29."), "no token on disk");
  const shown = (await (await api("GET", "/api/plan")).text()) + (await (await api("GET", "/api/state")).text());
  assert.ok(!shown.includes("1//fake-refresh") && !shown.includes("ya29."), "no token in anything the console is shown");
});

test("while it is off Google is asked for nothing; on, an agent's request goes out in the Cloud Code Assist envelope and is answered, streaming or not", async () => {
  const before = google.api.length;
  const off = await ask();
  assert.equal(off.status, 404);
  assert.match(((await off.json()) as Json).error.message, /switched off/);
  assert.equal(google.api.length, before);

  assert.equal((await api("PUT", `/api/plan/${accountId}/switch`, { on: true })).status, 200);
  google.script = hello;
  const plain = await ask({ max_tokens: 20 });
  assert.equal(plain.status, 200);
  const answer = (await plain.json()) as Json;
  assert.equal(answer.choices[0].message.content, "Hello");
  assert.deepEqual(answer.usage, { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 });
  const call = google.api.at(-1)!;
  assert.match(call.path, /^\/v1internal:streamGenerateContent\?alt=sse$/);
  assert.match(call.authorization!, /^Bearer ya29\.fake-access-\d+$/);
  assert.match(call.userAgent!, /^antigravity\/ide\//, "the client family the backend expects");
  assert.equal(call.body.model, "gemini-fake-pro");
  assert.equal(call.body.project, "proj-fake");
  assert.equal(call.body.userAgent, "antigravity");
  assert.equal(call.body.requestType, "agent");
  assert.match(call.body.requestId, /^agent-/);
  assert.deepEqual(call.body.request.contents, [{ role: "user", parts: [{ text: "hi" }] }]);
  assert.equal(call.body.request.generationConfig.maxOutputTokens, 20);

  const streamed = await (await ask({ stream: true })).text();
  assert.ok(streamed.includes("\"content\":\"Hello\"") && streamed.trimEnd().endsWith("data: [DONE]"));
  assert.ok(!JSON.stringify(answer).includes("ya29.") && !streamed.includes("ya29."), "the token never comes back");
});

test("an expired access token is renewed from the refresh token before the request goes out", async () => {
  clearAntigravityCache();
  google.expiresIn = 3600;
  const before = google.tokenCalls.length;
  google.script = hello;
  assert.equal((await ask()).status, 200);
  assert.equal(google.tokenCalls.length, before + 1, "the cache was empty, so one refresh");
  assert.equal(google.tokenCalls.at(-1)!.grant_type, "refresh_token");
  assert.equal((await ask()).status, 200);
  assert.equal(google.tokenCalls.length, before + 1, "and the new token is reused while it lasts");
});

test("failures reach the agent as plain errors, and an exhausted account is marked so pools skip it", async () => {
  clearQuota();
  google.script = () => ({ events: [{ response: { candidates: [{ content: { parts: [{ text: "half" }] } }] } }] });
  const cut = await ask();
  assert.equal(cut.status, 502);
  assert.match(((await cut.json()) as Json).error.message, /没有正常结束/);

  google.script = () => ({ status: 429, text: "Resource has been exhausted (e.g. check quota)." });
  const limited = await ask();
  assert.equal(limited.status, 429);
  assert.match(((await limited.json()) as Json).error.message, /额度不足或请求过于频繁/);
  assert.equal(isExhausted(providerId), true, "the account is used up until it is back");
  clearQuota();

  google.script = () => ({ status: 403 });
  const refused = await ask();
  assert.equal(refused.status, 403);
  assert.match(((await refused.json()) as Json).error.message, /重新登录/);
});

test("an account with no Cloud Code Assist project is onboarded, and removing the account forgets the token and the source", async () => {
  assert.equal((await api("DELETE", `/api/antigravity/${accountId}`)).status, 200);
  assert.equal(store.providers().find(p => p.antigravity), undefined);
  assert.equal(await secrets.get(`antigravity:${accountId}`), undefined, "the refresh token is gone from the secret store");
  assert.equal((await api("DELETE", `/api/antigravity/${accountId}`)).status, 404);

  google.hasProject = false;
  const state = await signIn();
  assert.equal(state.signIn.status, "done", JSON.stringify(state.signIn));
  assert.equal(store.providers().find(p => p.antigravity)!.antigravity!.projectId, "proj-onboarded");
  assert.ok(google.api.some(c => c.path.includes(":onboardUser")));
});
