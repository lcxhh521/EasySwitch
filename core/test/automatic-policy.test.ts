import assert from "node:assert/strict";
import { test } from "node:test";
import type { ApiProtocol } from "../src/types.ts";

// Synthetic request strings and in-memory negative evidence only. No credentials,
// filesystem persistence, upstream requests, clients, probes, or model inference.
const modulePath = "../src/automatic-policy.ts";
const policy = await import(modulePath).catch(error => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return {};
  throw error;
});
const NOW = 1_000_000;
const bases: Record<ApiProtocol, Record<string, unknown>> = {
  chat: { model: "pool/approved", messages: [{ role: "user", content: "Hello" }] },
  responses: { model: "pool/approved", input: "Hello" },
  messages: { model: "pool/approved", max_tokens: 32, messages: [{ role: "user", content: "Hello" }] },
  gemini: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
};
function issue(protocol: ApiProtocol, value: unknown): string | undefined {
  assert.equal(typeof policy.automaticTextRequestIssue, "function", "the conservative request gate must exist");
  return policy.automaticTextRequestIssue(protocol, JSON.stringify(value));
}
function ledger(): { record(identity: string, protocol: ApiProtocol, status: number, observedAt?: number): void; waitUntil(identity: string, protocol: ApiProtocol, now?: number): number | undefined } {
  assert.equal(typeof policy.AutomaticFailureLedger, "function", "the isolated passive failure ledger must exist");
  return new policy.AutomaticFailureLedger();
}
for (const protocol of Object.keys(bases) as ApiProtocol[]) {
  test(`${protocol}: accepts stateless plain text and empty tool definitions`, () => {
    const base = bases[protocol];
    assert.equal(issue(protocol, base), undefined);
    assert.equal(issue(protocol, { ...base, tools: [] }), undefined);
    assert.equal(issue(protocol, { ...base, stream: true }), undefined);
    assert.equal(issue(protocol, { ...base, stream: false }), undefined);
  });
  test(`${protocol}: rejects unknown fields and malformed common controls without echoing values`, () => {
    for (const extra of [{ mystery: "do-not-echo-fixture" }, { metadata: null }, { model: null }, { stream: 1 }, { tools: null }, { tools: {} }, { tools: [{ type: "function" }] }, { previous_response_id: null }, { conversation: null }]) {
      const result = issue(protocol, { ...bases[protocol], ...extra });
      assert.equal(typeof result, "string");
      assert.match(result!, /固定来源/);
      assert.doesNotMatch(result!, /do-not-echo-fixture/);
    }
  });
}

test("malformed JSON, nonobject roots, and unknown protocols fail closed", () => {
  assert.equal(typeof policy.automaticTextRequestIssue, "function");
  for (const raw of ["", "{", "null", "[]", "1", '"Hello"']) assert.equal(typeof policy.automaticTextRequestIssue("chat", raw), "string");
  assert.equal(typeof policy.automaticTextRequestIssue("unknown", JSON.stringify(bases.chat)), "string");
});

test("Chat accepts only role plus text content and represented scalar generation knobs", () => {
  assert.equal(issue("chat", { ...bases.chat, messages: [
    { role: "system", content: "Instructions" }, { role: "developer", content: "More" },
    { role: "user", content: [{ type: "text", text: "Hello" }] }, { role: "assistant", content: "Hi" },
  ], temperature: 0, top_p: 1, max_completion_tokens: 40 }), undefined);
  assert.equal(issue("chat", { ...bases.chat, max_tokens: 12 }), undefined);
  for (const messages of [null, {}, [], [null], [{ role: "tool", content: "Result" }], [{ role: "unknown", content: "x" }], [{ role: "user" }], [{ role: "user", content: null }], [{ role: "user", content: [] }], [{ role: "user", content: ["text"] }], [{ role: "user", content: [{ type: "text", text: 3 }] }]]) {
    assert.equal(typeof issue("chat", { ...bases.chat, messages }), "string");
  }
  for (const extra of [{ tool_calls: [] }, { function_call: null }, { tool_call_id: "x" }, { provider_state: null }, { reasoning_content: "x" }, { reasoning_signature: "x" }, { name: "named-speaker" }]) {
    assert.equal(typeof issue("chat", { ...bases.chat, messages: [{ role: "assistant", content: "x", ...extra }] }), "string");
  }
});

test("Responses accepts complete text histories and instructions but no references or opaque items", () => {
  assert.equal(issue("responses", { ...bases.responses, instructions: "System", input: [
    { role: "developer", content: "Policy" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Hi" }] },
  ], max_output_tokens: 80, temperature: 1, top_p: 0.5 }), undefined);
  for (const input of [null, {}, [], [null], [{ type: "item_reference", id: "msg-x" }], [{ type: "reasoning", encrypted_content: "opaque" }], [{ type: "function_call", name: "run" }], [{ type: "function_call_output", call_id: "x", output: "text" }], [{ role: "user", content: "text", id: "msg-x" }], [{ role: "tool", content: "text" }], [{ role: "user", content: [{ type: "output_text", text: "x", annotations: [] }] }]]) {
    assert.equal(typeof issue("responses", { ...bases.responses, input }), "string");
  }
  for (const extra of [{ previous_response_id: "resp-x" }, { previous_response_id: null }, { conversation: { id: "conv-x" } }, { conversation: null }, { include: [] }, { background: false }, { reasoning: { effort: "low" } }, { text: { format: { type: "json_schema", schema: {} } } }, { instructions: [] }]) {
    assert.equal(typeof issue("responses", { ...bases.responses, ...extra }), "string");
  }
});

test("Messages accepts text messages and system blocks but rejects thinking, caching and capability demands", () => {
  assert.equal(issue("messages", { ...bases.messages, messages: [{ role: "assistant", content: [{ type: "text", text: "History" }] }, { role: "user", content: "Next" }], system: [{ type: "text", text: "System" }], temperature: 0.2, top_p: 0.9 }), undefined);
  assert.equal(issue("messages", { ...bases.messages, system: "System" }), undefined);
  for (const extra of [{ system: null }, { system: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }, { system: [{ type: "text", text: "x", citations: [] }] }, { thinking: { type: "disabled" } }, { output_config: { effort: "low" } }, { output_config: { format: { type: "json_schema", schema: {} } } }, { container: null }, { service_tier: "auto" }, { max_tokens: 0 }]) {
    assert.equal(typeof issue("messages", { ...bases.messages, ...extra }), "string");
  }
  for (const block of [{ type: "thinking", thinking: "text", signature: "opaque" }, { type: "redacted_thinking", data: "opaque" }, { type: "tool_use", id: "x", name: "run" }, { type: "tool_result", tool_use_id: "x", content: "text" }, { type: "text", text: "x", signature: null }]) {
    assert.equal(typeof issue("messages", { ...bases.messages, messages: [{ role: "assistant", content: [block] }] }), "string");
  }
  assert.equal(typeof issue("messages", { ...bases.messages, messages: [{ role: "system", content: "x" }] }), "string");
});

test("Gemini validates every part and generation field before the decoder can drop them", () => {
  assert.equal(issue("gemini", { contents: [{ parts: [{ text: "Hello" }] }, { role: "model", parts: [{ text: "Hi" }] }], systemInstruction: { parts: [{ text: "System" }] }, generationConfig: { maxOutputTokens: 80, temperature: 1, topP: 0.5 } }), undefined);
  assert.equal(issue("gemini", { ...bases.gemini, system_instruction: { parts: [{ text: "System" }] } }), undefined);
  for (const extra of [{ systemInstruction: null }, { systemInstruction: { parts: [{ text: "text", inlineData: {} }] } }, { systemInstruction: { parts: [{ text: "x" }], unexpected: null } }, { systemInstruction: { parts: [{ text: "x" }] }, system_instruction: { parts: [{ text: "y" }] } }, { generationConfig: null }, { generationConfig: { responseMimeType: "application/json" } }, { generationConfig: { responseSchema: {} } }, { generationConfig: { thinkingConfig: {} } }, { generationConfig: { candidateCount: 2 } }, { generationConfig: { topK: 1 } }, { generationConfig: { maxOutputTokens: -1 } }, { toolConfig: null }, { cachedContent: null }, { safetySettings: [] }]) {
    assert.equal(typeof issue("gemini", { ...bases.gemini, ...extra }), "string");
  }
  for (const part of [{ text: "x", thought: false }, { text: "x", thoughtSignature: null }, { text: "x", functionCall: {} }, { text: "x", fileData: {} }, { functionResponse: { response: "x" } }, { inlineData: {} }, { text: 3 }, null]) {
    assert.equal(typeof issue("gemini", { contents: [{ role: "user", parts: [part] }] }), "string");
  }
  for (const contents of [null, {}, [], [null], [{ role: "tool", parts: [{ text: "x" }] }], [{ parts: [] }], [{ parts: [{ text: "x" }], continuation: null }]]) assert.equal(typeof issue("gemini", { contents }), "string");
});

test("plain-text format declarations are accepted but unknown nested format fields are not", () => {
  assert.equal(issue("chat", { ...bases.chat, response_format: { type: "text" } }), undefined);
  assert.equal(issue("responses", { ...bases.responses, text: { format: { type: "text" } } }), undefined);
  assert.equal(typeof issue("chat", { ...bases.chat, response_format: { type: "text", unknown: true } }), "string");
  assert.equal(typeof issue("responses", { ...bases.responses, text: { format: { type: "text" }, verbosity: "high" } }), "string");
});

test("tools, media, structured output and unrepresented generation controls reject even with text alongside", () => {
  for (const extra of [{ tool_choice: "none" }, { parallel_tool_calls: false }, { functions: [] }, { stop: ["end"] }, { reasoning_effort: "none" }, { response_format: { type: "json_object" } }, { modalities: ["text"] }, { n: 2 }, { logprobs: false }, { temperature: null }, { temperature: -1 }, { top_p: 2 }, { max_tokens: 1.5 }, { max_tokens: 32, max_completion_tokens: 32 }]) {
    assert.equal(typeof issue("chat", { ...bases.chat, ...extra }), "string");
  }
  for (const part of [{ type: "image_url", image_url: { url: "https://example.invalid/image" } }, { type: "input_audio", input_audio: {} }, { type: "file", file: {} }, { type: "text", text: "Hello", audio: null }]) {
    assert.equal(typeof issue("chat", { ...bases.chat, messages: [{ role: "user", content: [{ type: "text", text: "Hello" }, part] }] }), "string");
  }
});

test("literal es-state and account-like words in ordinary text never imply opaque continuation", () => {
  const text = 'Explain es-state:abc, previous_response_id, provider_state and {"thoughtSignature":"x"}.';
  assert.equal(issue("chat", { ...bases.chat, messages: [{ role: "user", content: text }] }), undefined);
  assert.equal(issue("responses", { ...bases.responses, input: text, instructions: text }), undefined);
  assert.equal(issue("messages", { ...bases.messages, messages: [{ role: "user", content: [{ type: "text", text }] }], system: text }), undefined);
  assert.equal(issue("gemini", { contents: [{ parts: [{ text }] }], systemInstruction: { parts: [{ text }] } }), undefined);
});

test("all eligible HTTP failures create exactly a 60-second wait and expiry is only unknown", () => {
  const state = ledger();
  for (const status of [401, 403, 429, 500, 503, 599]) {
    const id = `snapshot:${status}`;
    state.record(id, "chat", status, NOW);
    assert.equal(state.waitUntil(id, "chat", NOW), NOW + 60_000);
    assert.equal(state.waitUntil(id, "chat", NOW + 59_999), NOW + 60_000);
    assert.equal(state.waitUntil(id, "chat", NOW + 60_000), undefined);
    assert.equal(state.waitUntil(id, "chat", NOW + 60_001), undefined);
  }
});

test("unknown, successful, local and noneligible statuses never mark or clear health", () => {
  const state = ledger();
  assert.equal(state.waitUntil("unseen", "chat", NOW), undefined);
  for (const status of [0, 200, 204, 400, 404, 408, 409, 499, 600, 503.5, NaN, Infinity]) {
    state.record(`ignored:${status}`, "chat", status, NOW);
    assert.equal(state.waitUntil(`ignored:${status}`, "chat", NOW), undefined);
  }
  state.record("observed", "chat", 429, NOW);
  state.record("observed", "chat", 200, NOW + 1);
  assert.equal(state.waitUntil("observed", "chat", NOW + 1), NOW + 60_000, "success is not a positive health or quota restoration estimate");
});

test("observations are bound to approval/member fingerprint and inbound protocol, not provider alone", () => {
  const state = ledger(); state.record("approval-a:member-a", "chat", 401, NOW);
  assert.equal(state.waitUntil("approval-a:member-a", "chat", NOW), NOW + 60_000);
  for (const id of ["approval-b:member-a", "approval-a:member-b", "provider-a"]) assert.equal(state.waitUntil(id, "chat", NOW), undefined);
  for (const protocol of ["responses", "messages", "gemini"] as ApiProtocol[]) assert.equal(state.waitUntil("approval-a:member-a", protocol, NOW), undefined);
  assert.equal(ledger().waitUntil("approval-a:member-a", "chat", NOW), undefined, "instances do not import old failure or quota maps");
});

test("invalid/future timestamps and clock rollback are unknown without changing the ledger", () => {
  const state = ledger();
  for (const at of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER, Date.now() + 60_000]) {
    state.record(`invalid:${at}`, "chat", 503, at);
    assert.equal(state.waitUntil(`invalid:${at}`, "chat", Number.isSafeInteger(at) ? at : NOW), undefined);
  }
  state.record("valid", "chat", 503, NOW);
  for (const now of [NOW - 1, NaN, Infinity, -1, 1.5]) assert.equal(state.waitUntil("valid", "chat", now), undefined);
  assert.equal(state.waitUntil("valid", "chat", NOW), NOW + 60_000);
  assert.equal(state.waitUntil("valid", "chat", NOW + 60_000), undefined);
  assert.equal(state.waitUntil("valid", "chat", NOW), NOW + 60_000, "a read does not prune, mark recovered, or change selection state");
});

test("out-of-order observations cannot shorten newer evidence and invalid records cannot clear it", () => {
  const state = ledger(); state.record("member", "chat", 429, NOW + 20);
  state.record("member", "chat", 503, NOW);
  state.record("member", "chat", 503, NaN);
  assert.equal(state.waitUntil("member", "chat", NOW + 20), NOW + 60_020);
  state.record("member", "chat", 401, NOW + 30);
  assert.equal(state.waitUntil("member", "chat", NOW + 30), NOW + 60_030);
});

test("bounded evidence evicts oldest written entries and reads never promote them", () => {
  const state = ledger();
  state.record("first", "chat", 503, NOW);
  for (let i = 0; i < 1_023; i++) state.record(`item:${i}`, "chat", 503, NOW);
  assert.equal(state.waitUntil("first", "chat", NOW), NOW + 60_000);
  state.record("newest", "chat", 503, NOW);
  assert.equal(state.waitUntil("first", "chat", NOW), undefined);
  assert.equal(state.waitUntil("newest", "chat", NOW), NOW + 60_000);
  state.record("", "chat", 503, NOW);
  state.record("x".repeat(4_097), "chat", 503, NOW);
  assert.equal(state.waitUntil("", "chat", NOW), undefined);
  assert.equal(state.waitUntil("x".repeat(4_097), "chat", NOW), undefined);
});
