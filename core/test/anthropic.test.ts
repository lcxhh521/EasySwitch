import assert from "node:assert/strict";
import { test } from "node:test";
import { outboundBody, convertOutput, sseResponse } from "./protocol-fixture.ts";

type Json = Record<string, unknown>;

/** The shape Claude Code 2.1.289 sends, trimmed: see docs/claude-code-request-shape.md. */
const CLAUDE_REQUEST: Json = {
  model: "relay/mock-coder",
  system: [
    { type: "text", text: "You are Claude Code." },
    { type: "text", text: "Tool rules.", cache_control: { type: "ephemeral" } },
  ],
  messages: [
    { role: "user", content: [{ type: "text", text: "<system-reminder>…</system-reminder>" }, { type: "text", text: "run it" }] },
    { role: "system", content: [{ type: "text", text: "Late system context.", cache_control: { type: "ephemeral" } }] },
    { role: "assistant", content: [
      { type: "thinking", thinking: "…", signature: "sig" },
      { type: "text", text: "Running." },
      { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/a" } },
    ] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" },
      { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "contents" }], is_error: true },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "text", text: "and this screenshot" },
    ] },
  ],
  tools: [
    { name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    { type: "web_search_20250305", name: "web_search" },
  ],
  metadata: { user_id: "device" },
  max_tokens: 32000,
  thinking: { type: "adaptive" },
  context_management: { edits: [] },
  safeguards: [{ type: "dangerous_tool_use" }],
  output_config: { effort: "high" },
  stream: true,
};

test("real Messages-to-Chat egress keeps all leading and late system instructions", async t => {
  const { body } = await outboundBody(t, "messages", CLAUDE_REQUEST);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, "You are Claude Code.\n\nTool rules.\n\nLate system context.");
});

test("real egress flattens tool-result text arrays, preserves errors/media and repairs missing tool results", async t => {
  const { body } = await outboundBody(t, "messages", CLAUDE_REQUEST);
  const results = body.messages.filter((m: any) => m.role === "tool");
  assert.deepEqual(results.map((m: any) => [m.tool_call_id, m.content]), [["toolu_1", "a.txt"], ["toolu_2", "Error: contents"]]);
  assert.ok(body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.image_url?.url === "data:image/png;base64,AAAA")));
  const orphan = await outboundBody(t, "messages", { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "lost", name: "Read", input: {} }] }], max_tokens: 10 });
  assert.equal(orphan.body.messages.at(-1).content, "[no result]");
});

test("real egress strips Messages-only private metadata and reports unsupported optional tools", async t => {
  const { body, dropped } = await outboundBody(t, "messages", CLAUDE_REQUEST);
  for (const key of ["thinking", "context_management", "safeguards", "output_config", "metadata", "system"]) assert.equal(body[key], undefined);
  assert.ok(dropped.includes("tool:web_search_20250305")); assert.equal(body.tools.length, 1); assert.equal(body.max_tokens, 32000);
});

test("real Chat event decoder renders Messages text then fragmented tool blocks and usage", async () => {
  const { result, events } = await convertOutput(sseResponse([
    { choices: [{ delta: { content: "Let me check." } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "Bash", arguments: '{"command":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 12 } },
  ]), "chat", "messages");
  assert.deepEqual(result.content.map((x: any) => x.type), ["text", "tool_use"]);
  assert.deepEqual(result.content[1].input, { command: "ls" }); assert.equal(result.stop_reason, "tool_use");
  assert.equal(result.usage.input_tokens, 100);
  assert.equal(events.filter(e => e.type === "content_block_stop").length, 2);
});

test("real non-stream Chat result becomes a Messages answer without the legacy converter", async () => {
  const { result } = await convertOutput(Response.json({ choices: [{ message: { content: "Done.", tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"file_path":"/x"}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), "chat", "messages");
  assert.deepEqual(result.content, [{ type: "text", text: "Done." }, { type: "tool_use", id: "c1", name: "Read", input: { file_path: "/x" } }]);
  assert.equal(result.stop_reason, "tool_use");
});
