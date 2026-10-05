import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { geminiToChat, lowerSchema } from "../src/gemini.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let pid: string;

before(async () => {
  relay = await startMockRelay(0, { apiKey: "relay-key" });
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  server = createEasySwitchServer({ store: new Store(mkdtempSync(join(tmpdir(), "es-gemini-"))), secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  pid = ((await fetch(`http://127.0.0.1:${port}/api/providers`, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" },
    body: JSON.stringify({ name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "relay-key" }),
  }).then(r => r.json())) as { id: string }).id;
});

after(() => { server.closeAllConnections(); server.close(); relay.server.closeAllConnections(); relay.server.close(); });

const call = (model: string, method: string, body: Json, query = "") =>
  fetch(`http://127.0.0.1:${port}/v1beta/models/${model}:${method}${query}`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": "es-session-geminicli-abc" }, body: JSON.stringify(body) });

test("schemas lose Gemini's capitals and extras", () => {
  assert.deepEqual(lowerSchema({ type: "OBJECT", properties: { a: { type: "STRING", nullable: true } }, required: ["a"] }), { type: "object", properties: { a: { type: "string" } }, required: ["a"] });
});

test("a Gemini request becomes a Chat request: system, roles, calls matched to responses by name", () => {
  const { chat } = geminiToChat({
    systemInstruction: { parts: [{ text: "be brief" }] },
    contents: [
      { role: "user", parts: [{ text: "ls" }] },
      { role: "model", parts: [{ functionCall: { name: "shell", args: { cmd: "ls" } } }] },
      { role: "user", parts: [{ functionResponse: { name: "shell", response: { output: "a b" } } }] },
    ],
    generationConfig: { maxOutputTokens: 100, temperature: 0.2, stopSequences: ["END"] },
    toolConfig: { functionCallingConfig: { mode: "ANY" } },
    tools: [{ functionDeclarations: [{ name: "shell", parameters: { type: "OBJECT", properties: {} } }] }],
  }, "m", { stream: false, streamUsage: true });
  assert.deepEqual(chat.messages.map(m => m.role), ["system", "user", "assistant", "tool"]);
  const call = chat.messages[2]!.tool_calls![0]!;
  assert.equal(chat.messages[3]!.tool_call_id, call.id, "the response answers the call of the same name");
  assert.equal(chat.max_tokens, 100);
  assert.equal(chat.tool_choice, "required");
});

test("generateContent is answered by the provider the model names", async () => {
  const before = relay.requests.length;
  const res = await call(`${pid}/mock-coder`, "generateContent", { contents: [{ role: "user", parts: [{ text: "Reply with exactly the word: pong" }] }] });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Json;
  assert.match(json.candidates[0].content.parts[0].text, /pong|Hello/i);
  assert.equal(json.candidates[0].finishReason, "STOP");
  assert.equal(json.usageMetadata.promptTokenCount, 42);
  assert.equal(relay.requests[before]!.model, "mock-coder");
});

test("the model name may arrive with its slash URL-encoded", async () => {
  const res = await call(`${pid}%2Fmock-coder`, "generateContent", { contents: [{ role: "user", parts: [{ text: "Reply with exactly the word: pong" }] }] });
  assert.equal(res.status, 200);
});

test("streaming sends Gemini SSE chunks with text first and usage at the end", async () => {
  const res = await call(`${pid}/mock-coder`, "streamGenerateContent", { contents: [{ role: "user", parts: [{ text: "Count from 1 to 5." }] }] }, "?alt=sse");
  assert.equal(res.status, 200);
  const chunks = (await res.text()).split(/\r?\n\r?\n/).filter(Boolean).map(b => JSON.parse(b.replace(/^data: /, "")) as Json);
  const text = chunks.flatMap(c => c.candidates[0].content.parts.map((p: Json) => p.text ?? "")).join("");
  assert.equal(text.replace(/\s+/g, " ").trim(), "1 2 3 4 5");
  assert.equal(chunks.at(-1)!.candidates[0].finishReason, "STOP");
  assert.equal(chunks.at(-1)!.usageMetadata.candidatesTokenCount, 7);
});

test("a tool round trip: the model's call comes back as functionCall, and the response is understood next turn", async () => {
  const tools = [{ functionDeclarations: [{ name: "exec_command", description: "run", parameters: { type: "OBJECT", properties: { cmd: { type: "STRING" } } } }] }];
  const ask = { role: "user", parts: [{ text: "Run the shell command you are given and report what it printed." }] };
  const first = (await (await call(`${pid}/mock-coder`, "generateContent", { contents: [ask], tools })).json()) as Json;
  const fc = first.candidates[0].content.parts.find((p: Json) => p.functionCall)?.functionCall;
  assert.equal(fc?.name, "exec_command");
  assert.match(String(fc.args.cmd), /echo/);
  const second = (await (await call(`${pid}/mock-coder`, "generateContent", {
    tools,
    contents: [ask, { role: "model", parts: [{ functionCall: fc }] }, { role: "user", parts: [{ functionResponse: { name: "exec_command", response: { output: "easyswitch-roundtrip-ok" } } }] }],
  })).json()) as Json;
  assert.match(JSON.stringify(second), /easyswitch-roundtrip-ok/);
});

test("models can be listed and tokens counted; unknown models get a Gemini-shaped error", async () => {
  const list = (await (await fetch(`http://127.0.0.1:${port}/v1beta/models`)).json()) as Json;
  assert.ok(list.models.some((m: Json) => m.name === `models/${pid}/mock-coder`));
  const count = (await (await call("x", "countTokens", { contents: [{ role: "user", parts: [{ text: "hello world" }] }] })).json()) as Json;
  assert.ok(count.totalTokens > 0);
  const missing = await call("nope/x", "generateContent", { contents: [] });
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as Json).error.status, "NOT_FOUND");
});
