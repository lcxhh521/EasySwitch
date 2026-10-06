import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { decodeRequest } from "../src/inbound.ts";
import { conversationToKiro } from "../src/kiro.ts";
import { conversationToGemini } from "../src/gemini-upstream.ts";
import { conversationToTurn } from "../src/cursor/adapter.ts";
import { conversationToKimi } from "../src/kimi-upstream.ts";
import { prepareExistingSubscription } from "../src/subscription-compat.ts";
import { repairConversation } from "../src/subscription-input.ts";
import type { Conversation, InboundRequest } from "../src/protocol.ts";
import type { Provider } from "../src/types.ts";

const request = (protocol: InboundRequest["protocol"], body: InboundRequest["body"], model = "fixture-model"): InboundRequest => ({ protocol, body, model, stream: false, source: "fixture-source" });
const provider = (kind: "kimi" | "cursor" | "antigravity" | "kiro", extra: Partial<Provider> = {}): Provider => ({ id: "fixture-source", name: "fixture", baseUrl: "https://untrusted.invalid", models: ["fixture-model"], streamUsage: true, route: "chat-translate", routePinned: true, createdAt: "", [kind]: kind === "kiro" ? {} : kind === "antigravity" ? { accountId: "fixture-account", email: "fake@example.invalid", projectId: "fixture-project" } : { accountId: "fixture-account" }, ...extra });
const conversation = (): Conversation => ({ tools: [{ name: "lookup", description: "fixture", parameters: { type: "object", properties: {} } }], dropped: [], turns: [
  { role: "developer", parts: [{ type: "text", text: "keep this instruction" }] },
  { role: "user", parts: [{ type: "text", text: "hello" }] },
  { role: "assistant", parts: [{ type: "call", id: "missing", name: "lookup", arguments: "{}" }] },
  { role: "user", parts: [{ type: "result", id: "orphan", content: [{ type: "text", text: "orphan data" }] }, { type: "text", text: "continue" }] },
] });

test("neutral tool-pair repair preserves missing-result markers, orphan text and the original input", () => {
  const original = conversation(); const copy = structuredClone(original); const repaired = repairConversation(original);
  assert.deepEqual(original, copy);
  assert.deepEqual(repaired.turns[3]!.parts, [{ type: "result", id: "missing", name: "lookup", content: "[no result]" }]);
  assert.match(JSON.stringify(repaired.turns[4]), /orphan data/);
  assert.ok(repaired.dropped.includes("tool_history:missing_result_placeholder"));
});

test("Kiro directly maps neutral developer instructions, repaired tools and structured tool-result errors", () => {
  const c = conversation(); c.turns.push({ role: "assistant", parts: [{ type: "call", id: "paired", name: "lookup", arguments: "{}" }] }, { role: "user", parts: [{ type: "result", id: "paired", content: [{ type: "text", text: "failed fixture" }], error: true }] });
  const built = conversationToKiro(c, request("messages", {}), { accessToken: "fixture-not-used", region: "us-east-1", builderId: true });
  const state = built.body.conversationState;
  assert.match(state.history[0].userInputMessage.content, /^keep this instruction/);
  assert.match(JSON.stringify(state.history), /\[no result\]/);
  assert.deepEqual(state.currentMessage.userInputMessage.userInputMessageContext.toolResults, [{ toolUseId: "paired", content: [{ text: "failed fixture" }], status: "error" }]);
  assert.ok(built.dropped.includes("tool_history:missing_result_placeholder"));
});

test("Antigravity's native Gemini builder preserves neutral ordering, developer instructions and native call signatures", () => {
  const input = request("gemini", { systemInstruction: { parts: [{ text: "instruction" }] }, contents: [
    { role: "user", parts: [{ text: "hello" }] },
    { role: "model", parts: [{ text: "before" }, { functionCall: { id: "c", name: "lookup", args: {} }, thoughtSignature: "native-fixture-signature" }, { text: "after" }] },
  ] }, "gemini-2.5-flash"); input.effort = "low";
  const built = conversationToGemini(decodeRequest(input), input);
  assert.equal(built.body.contents[1].parts[1].thoughtSignature, "native-fixture-signature");
  assert.deepEqual(built.body.contents[1].parts.map((p: any) => p.text ?? "call"), ["before", "call", "after"]);
  assert.equal(built.body.contents[2].parts[0].functionResponse.response.output, "[no result]");
  assert.equal(built.body.generationConfig.thinkingConfig.thinkingBudget, 1024);
  const native = { ...input, effort: undefined, body: { ...input.body, generationConfig: { thinkingConfig: { thinkingBudget: 4096, includeThoughts: true }, seed: 7 } } };
  const preserved = conversationToGemini(decodeRequest(native), native).body.generationConfig;
  assert.deepEqual(preserved, { thinkingConfig: { thinkingBudget: 4096, includeThoughts: true }, seed: 7 });
  const developer = conversationToGemini(conversation(), request("responses", {}, "claude-fixture"));
  assert.equal(developer.body.systemInstruction.parts[0].text, "keep this instruction");
});

test("Cursor directly maps neutral instructions and explicitly records text-only losses", () => {
  const c = conversation(); c.turns[1]!.parts.push({ type: "image", url: "data:image/png;base64,AA==" });
  const built = conversationToTurn(c, "cursor-model");
  assert.equal(built.turn.system, "keep this instruction");
  assert.match(JSON.stringify(built.turn), /lookup/); assert.match(built.turn.user, /orphan data/);
  assert.ok(built.dropped.includes("media:cursor_text_only"));
  assert.ok(built.dropped.includes("tools:cursor_text_only"));
});

test("Kimi restores Messages session cache hash, streaming usage and saved effort at the actual Chat boundary", async t => {
  const input = request("messages", { metadata: { user_id: "fixture-session-private" }, max_tokens: 10, system: "instruction", messages: [
    { role: "user", content: "hello" }, { role: "assistant", content: [{ type: "tool_use", id: "missing", name: "lookup", input: {} }] },
  ], tools: [{ name: "lookup", input_schema: { type: "object" } }] }, "kimi-for-coding");
  input.stream = true; input.effort = "high";
  let seen: any;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => { seen = { url, ...init, body: JSON.parse(String(init?.body)) }; return Response.json({ choices: [{ message: { role: "assistant", content: "fixture" }, finish_reason: "stop" }] }); });
  const prepared = prepareExistingSubscription(provider("kimi", { reasoningEffort: true }), input);
  assert.equal(prepared.adapter, "kimi-conversation");
  await prepared.send("fixture-token", new AbortController().signal);
  assert.equal(seen.url, "https://api.kimi.com/coding/v1/chat/completions"); assert.equal(seen.redirect, "error");
  assert.equal(seen.body.prompt_cache_key, createHash("sha256").update("fixture-session-private").digest("hex").slice(0, 32));
  assert.deepEqual(seen.body.stream_options, { include_usage: true });
  assert.equal(seen.body.reasoning_effort, "high");
  assert.equal(seen.body.messages[0].role, "system");
  assert.equal(seen.body.messages.at(-1).content, "[no result]");
  assert.doesNotMatch(JSON.stringify(seen.body), /fixture-session-private/);
});

test("Kimi same-protocol native input repairs developer/tool history without activating unsupported effort", () => {
  const input = request("chat", { messages: [{ role: "developer", content: "instruction" }, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }], reasoning_effort: "high" }, "kimi-for-coding");
  const built = conversationToKimi(provider("kimi"), decodeRequest(input), input);
  assert.equal(built.body.messages[0].role, "system"); assert.equal(built.body.messages[1].content, "");
  assert.equal(built.body.messages[2].content, "[no result]"); assert.equal(built.body.reasoning_effort, undefined);
  assert.ok(built.dropped.includes("effort:unsupported_kimi"));
});

test("subscription dispatcher does not serialize Conversation through Chat before invoking proprietary builders", () => {
  const source = readFileSync(new URL("../src/subscription-compat.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /encodeRequest|as ChatRequest/);
  for (const name of ["sendKiroConversation", "sendAntigravityConversation", "sendCursorConversation", "sendKimiConversation"]) assert.match(source, new RegExp(name));
});
