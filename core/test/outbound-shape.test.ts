import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeRequest } from "../src/inbound.ts";
import { encodeRequest } from "../src/outbound-format.ts";
import { prepareOutbound, sourceProtocols } from "../src/outbound.ts";
import type { Json } from "../src/protocol.ts";
import type { Provider } from "../src/types.ts";

const request = (protocol: "chat" | "responses" | "messages" | "gemini", body: Json) => ({ protocol, model: "m", stream: false, body, source: "src" });
const toChat = (protocol: "responses" | "messages", body: Json) => { const r = request(protocol, body); return encodeRequest(decodeRequest(r), r, "chat"); };
const relay = (baseUrl: string, extra: Partial<Provider> = {}): Provider => ({ id: "src", name: "src", baseUrl, models: ["m"], route: "chat-translate", streamUsage: false, protocols: ["messages"], ...extra }) as Provider;

test("every system and developer instruction, wherever the caller put it, becomes one leading Chat message", () => {
  const chat = toChat("responses", { input: [{ role: "developer", content: "Use tabs." }, { role: "user", content: "hi" }, { role: "developer", content: "Be brief." }], instructions: "You are Codex." });
  assert.deepEqual(chat.messages.map((m: Json) => m.role), ["system", "user"]);
  assert.equal(chat.messages[0].content, "You are Codex.\n\nUse tabs.\n\nBe brief.");
  const claude = toChat("messages", { system: "S", messages: [{ role: "user", content: "hi" }], max_tokens: 5 });
  assert.equal(claude.messages[0].role, "system");
});

test("a tool the vendor runs itself (web_search) is dropped and recorded, not a reason to refuse the request; only a real false reaches a Chat relay as parallel_tool_calls", () => {
  const r = request("responses", { input: "hi", tools: [{ type: "web_search" }, { type: "function", name: "shell", parameters: { type: "object" } }], parallel_tool_calls: true });
  const conversation = decodeRequest(r);
  assert.ok(conversation.dropped.includes("tool:web_search"));
  const chat = encodeRequest(conversation, r, "chat");
  assert.deepEqual(chat.tools.map((t: Json) => t.function.name), ["shell"]);
  assert.equal(chat.parallel_tool_calls, undefined, "Kimi/NIM-style relays refuse parallel_tool_calls: true");
  const noTools = toChat("responses", { input: "hi", tool_choice: "auto" });
  assert.equal(noTools.tool_choice, undefined);
  const serial = request("responses", { input: "hi", tools: [{ type: "function", name: "a", parameters: { type: "object" } }], parallel_tool_calls: false });
  assert.equal(encodeRequest(decodeRequest(serial), serial, "chat").parallel_tool_calls, false);
});

test("a tool result made of content blocks reaches a Chat relay as its text, not as JSON", () => {
  const chat = toChat("messages", { max_tokens: 5, messages: [
    { role: "user", content: "go" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "file body" }] }] },
  ] });
  assert.equal(chat.messages.find((m: Json) => m.role === "tool").content, "file body");
});

test("a source that takes both Chat and Messages is reached by Chat for a request from another protocol (no 4096 ceiling), while Claude Code's own Messages still goes straight through", () => {
  const both = relay("https://relay.example/v1", { protocols: undefined, messagesRoute: "anthropic-native", route: "chat-translate", routePinned: true });
  assert.deepEqual(sourceProtocols(both, "m"), ["chat", "messages"]);
  const r = request("responses", { input: "hi" });
  assert.equal(prepareOutbound(both, r as never).protocol, "chat");
  const claudeCode = prepareOutbound(both, request("messages", { max_tokens: 9, messages: [{ role: "user", content: "hi" }] }) as never);
  assert.equal(claudeCode.protocol, "messages");
  assert.equal(encodeRequest(decodeRequest(request("gemini", { contents: [{ role: "user", parts: [{ text: "x" }] }] })), request("gemini", {}), "messages").max_tokens, 16384);
});

test("Claude-only fields and the account identifier are not sent to a third-party Messages relay, but are kept for Anthropic and for a relay on this machine", () => {
  const body = { max_tokens: 9, messages: [{ role: "user", content: "hi" }], metadata: { user_id: "acct-uuid" }, context_management: { edits: [] }, thinking: { type: "adaptive" } };
  const sent = (baseUrl: string) => (prepareOutbound(relay(baseUrl), { ...request("messages", structuredClone(body)) } as never) as unknown as { dropped: string[] });
  assert.ok(sent("https://open.bigmodel.cn/api/anthropic").dropped.includes("field:metadata"));
  assert.ok(sent("https://open.bigmodel.cn/api/anthropic").dropped.includes("field:thinking"));
  assert.ok(!sent("https://api.anthropic.com").dropped.includes("field:metadata"));
  assert.ok(!sent("http://127.0.0.1:9").dropped.includes("field:metadata"));
});

test("a Responses tool output made of input_text blocks reaches a Chat relay as its text", () => {
  const chat = toChat("responses", { input: [{ role: "user", content: "go" }, { type: "function_call", call_id: "c1", name: "list_agents", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "- claude\n- codex" }] }], tools: [{ type: "function", name: "list_agents", parameters: { type: "object" } }] });
  assert.equal(chat.messages.find((m: Json) => m.role === "tool").content, "- claude\n- codex");
});
