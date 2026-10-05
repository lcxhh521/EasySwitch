import assert from "node:assert/strict";
import { test } from "node:test";
import { AnthropicStream, chatToMessage, messagesToChat } from "../src/anthropic.ts";

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

test("system blocks and mid-conversation system turns become one leading system message", () => {
  const { chat } = messagesToChat(CLAUDE_REQUEST, "mock-coder", { streamUsage: true });
  assert.equal(chat.messages[0]?.role, "system");
  assert.equal(chat.messages[0]?.content, "You are Claude Code.\n\nTool rules.\n\nLate system context.");
  assert.equal(chat.messages.filter(m => m.role === "system").length, 1);
});

test("tool_use and tool_result map to tool_calls and tool messages, in Chat's required order", () => {
  const { chat } = messagesToChat(CLAUDE_REQUEST, "mock-coder", { streamUsage: true });
  const roles = chat.messages.map(m => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "tool", "tool", "user"]);
  const assistant = chat.messages[2]!;
  assert.equal(assistant.content, "Running.");
  assert.deepEqual(assistant.tool_calls?.map(c => [c.id, c.function.name, JSON.parse(c.function.arguments)]), [
    ["toolu_1", "Bash", { command: "ls" }], ["toolu_2", "Read", { file_path: "/a" }],
  ]);
  assert.deepEqual(chat.messages.slice(3, 5).map(m => [m.tool_call_id, m.content]), [["toolu_1", "a.txt"], ["toolu_2", "Error: contents"]]);
  const last = chat.messages[5]!;
  assert.ok(Array.isArray(last.content));
  assert.deepEqual(last.content, [
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    { type: "text", text: "and this screenshot" },
  ]);
});

test("Claude-only fields and server tools stay behind", () => {
  const { chat, dropped } = messagesToChat(CLAUDE_REQUEST, "mock-coder", { streamUsage: true });
  const raw = chat as unknown as Json;
  for (const key of ["thinking", "context_management", "safeguards", "output_config", "metadata", "system"]) assert.equal(raw[key], undefined, key);
  assert.deepEqual(dropped, ["tool:web_search_20250305:web_search"]);
  assert.equal(chat.tools?.length, 1);
  assert.equal(chat.max_tokens, 32000);
});

function events(feed: (s: AnthropicStream) => void): Json[] {
  let out = "";
  const stream = new AnthropicStream("mock-coder", chunk => (out += chunk));
  stream.start();
  feed(stream);
  stream.finishStream();
  return out.trim().split("\n\n").map(block => JSON.parse(block.split("\n")[1]!.slice(6)) as Json);
}

test("a streamed answer with a tool call becomes Anthropic's block-by-block event stream", () => {
  const evs = events(s => {
    s.chunk({ choices: [{ delta: { content: "Let me " } }] });
    s.chunk({ choices: [{ delta: { content: "check." } }] });
    s.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "Bash", arguments: "" } }] } }] });
    s.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"command\":\"ls\"}" } }] }, finish_reason: "tool_calls" }] });
    s.chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 } });
  });
  assert.deepEqual(evs.map(e => e.type), [
    "message_start",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  assert.deepEqual(evs[5]!.content_block, { type: "tool_use", id: "call_9", name: "Bash", input: {} });
  assert.deepEqual(evs[6]!.delta, { type: "input_json_delta", partial_json: "{\"command\":\"ls\"}" });
  assert.equal((evs[8]!.delta as Json).stop_reason, "tool_use");
  assert.equal((evs[8]!.usage as Json).input_tokens, 100);
});

test("a complete Chat answer converts to one Anthropic message", () => {
  const message = chatToMessage({
    choices: [{ message: { content: "Done.", tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{\"file_path\":\"/x\"}" } }] }, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 5, completion_tokens: 3 },
  }, "mock-coder");
  assert.deepEqual(message.content, [
    { type: "text", text: "Done." },
    { type: "tool_use", id: "c1", name: "Read", input: { file_path: "/x" } },
  ]);
  assert.equal(message.stop_reason, "tool_use");
});
