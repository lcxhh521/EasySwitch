import assert from "node:assert/strict";
import { test } from "node:test";
import { ResponsesStream, responsesToChat } from "../src/translate.ts";

type Json = Record<string, unknown>;

/** The shape Codex 0.160 sends, trimmed: see docs/codex-request-shape.md. */
const CODEX_REQUEST: Json = {
  model: "relay/mock-coder",
  instructions: "You are Codex.",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "<skills_instructions>…</skills_instructions>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>…</environment_context>" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "list the files" }] },
    { type: "reasoning", id: "rs_1", encrypted_content: "opaque" },
    { type: "function_call", call_id: "call_a", name: "exec_command", arguments: "{\"cmd\":\"ls\"}" },
    { type: "function_call", call_id: "call_b", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
    { type: "function_call_output", call_id: "call_a", output: "a.txt" },
    { type: "function_call_output", call_id: "call_b", output: [{ type: "input_text", text: "/tmp" }] },
    { type: "custom_tool_call", call_id: "call_c", name: "apply_patch", input: "*** Begin Patch" },
    { type: "custom_tool_call_output", call_id: "call_c", output: "Done" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "Listed." }] },
  ],
  tools: [
    { type: "function", name: "exec_command", description: "Run a command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } },
    { type: "namespace", name: "multi_agent_v1", tools: [{ type: "function", name: "spawn_agent" }] },
    { type: "web_search", external_web_access: false },
    { type: "custom", name: "apply_patch", description: "Apply a patch", format: { type: "grammar", syntax: "lark", definition: "start: patch" } },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "thread-1",
};

test("instructions and developer turns become one leading system message", () => {
  const { chat } = responsesToChat(CODEX_REQUEST, "mock-coder", { streamUsage: true });
  assert.equal(chat.model, "mock-coder");
  assert.equal(chat.messages[0]?.role, "system");
  assert.match(String(chat.messages[0]?.content), /You are Codex\.[\s\S]*skills_instructions/);
  assert.equal(chat.messages.filter(m => m.role === "system").length, 1);
  assert.ok(chat.messages.every(m => ["system", "user", "assistant", "tool"].includes(m.role)));
});

test("parallel function calls share one assistant turn, outputs become tool messages", () => {
  const { chat } = responsesToChat(CODEX_REQUEST, "mock-coder", { streamUsage: true });
  const assistantWithCalls = chat.messages.filter(m => m.tool_calls);
  assert.equal(assistantWithCalls[0]?.tool_calls?.length, 2);
  const tools = chat.messages.filter(m => m.role === "tool");
  assert.deepEqual(tools.map(t => [t.tool_call_id, t.content]), [["call_a", "a.txt"], ["call_b", "/tmp"], ["call_c", "Done"]]);
});

test("custom tools become a one-string function and are remembered for the way back", () => {
  const { chat, customTools } = responsesToChat(CODEX_REQUEST, "mock-coder", { streamUsage: true });
  assert.ok(customTools.has("apply_patch"));
  const fn = chat.tools?.find(t => ((t.function ?? {}) as Json).name === "apply_patch")?.function as Json;
  assert.deepEqual((fn.parameters as Json).required, ["input"]);
  assert.match(String(fn.description), /lark grammar/);
  const replayed = chat.messages.flatMap(m => m.tool_calls ?? []).find(c => c.id === "call_c");
  assert.deepEqual(JSON.parse(replayed?.function.arguments ?? "{}"), { input: "*** Begin Patch" });
});

test("tools Chat cannot express are dropped and reported, Responses-only fields are not forwarded", () => {
  const { chat, dropped } = responsesToChat(CODEX_REQUEST, "mock-coder", { streamUsage: true });
  assert.deepEqual(dropped, ["tool:web_search"], "namespaces are flattened, not dropped");
  assert.equal(chat.tools?.length, 3);
  const raw = chat as unknown as Json;
  for (const key of ["include", "store", "reasoning", "prompt_cache_key", "instructions", "input"]) assert.equal(raw[key], undefined, key);
  assert.deepEqual(chat.stream_options, { include_usage: true });
});

function collect(feed: (s: ResponsesStream) => void, customTools: string[] = []): Json[] {
  let out = "";
  const stream = new ResponsesStream("mock-coder", new Set(customTools), chunk => (out += chunk));
  stream.start();
  feed(stream);
  stream.finish();
  return out.trim().split("\n\n").map(block => JSON.parse(block.split("\n")[1]!.slice(6)) as Json);
}

test("a streamed text answer yields the Responses event sequence Codex consumes", () => {
  const events = collect(s => {
    s.chunk({ choices: [{ delta: { role: "assistant" } }] });
    s.chunk({ choices: [{ delta: { content: "Hel" } }] });
    s.chunk({ choices: [{ delta: { content: "lo" } }] });
    s.chunk({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
  });
  assert.deepEqual(events.map(e => e.type), [
    "response.created", "response.in_progress", "response.output_item.added", "response.content_part.added",
    "response.output_text.delta", "response.output_text.delta", "response.output_text.done", "response.content_part.done",
    "response.output_item.done", "response.completed",
  ]);
  const completed = events.at(-1)!.response as Json;
  assert.equal(((completed.output as Json[])[0]!.content as Json[])[0]!.text, "Hello");
  assert.equal((completed.usage as Json).input_tokens, 10);
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
});

test("streamed tool-call fragments are reassembled into function_call and custom_tool_call items", () => {
  const events = collect(s => {
    s.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "exec_command", arguments: "" } }] } }] });
    s.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"cmd\":" } }] } }] });
    s.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"ls\"}" } }] } }] });
    s.chunk({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_y", function: { name: "apply_patch", arguments: "{\"input\":\"*** Begin Patch\"}" } }] } }] });
  }, ["apply_patch"]);
  const done = events.filter(e => e.type === "response.output_item.done").map(e => e.item as Json);
  assert.deepEqual(done[0], { id: done[0]!.id, type: "function_call", call_id: "call_x", name: "exec_command", arguments: "{\"cmd\":\"ls\"}", status: "completed" });
  assert.deepEqual(done[1], { id: done[1]!.id, type: "custom_tool_call", call_id: "call_y", name: "apply_patch", input: "*** Begin Patch", status: "completed" });
  assert.equal(((events.at(-1)!.response as Json).output as Json[]).length, 2);
});

test("namespace tools (MCP servers) travel as flat functions and come back as namespace + name", () => {
  const { chat, namespaced } = responsesToChat({ model: "m", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }, { type: "function_call", call_id: "c1", namespace: "mcp__easyswitch", name: "list_agents", arguments: "{}" }, { type: "function_call_output", call_id: "c1", output: "ok" }], tools: [{ type: "namespace", name: "mcp__easyswitch", tools: [{ type: "function", name: "list_agents", description: "d", parameters: { type: "object", properties: {} } }] }] }, "m", { streamUsage: false });
  const flat = ((chat.tools![0] as unknown) as { function: { name: string } }).function.name;
  assert.equal(flat, "mcp__easyswitch__list_agents");
  assert.equal(chat.messages.find(m => m.tool_calls)!.tool_calls![0]!.function.name, flat, "earlier calls in the history use the flat name too");
  assert.deepEqual(namespaced.get(flat), { namespace: "mcp__easyswitch", name: "list_agents" });
  let out = "";
  const stream = new ResponsesStream("m", new Set(), c => (out += c), namespaced);
  stream.start();
  stream.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: flat, arguments: "{}" } }] } }] });
  stream.finish();
  const done = out.trim().split("\n\n").map(b => JSON.parse(b.split("\n")[1]!.slice(6)) as Json).find(e => e.type === "response.output_item.done");
  const item = done?.item as unknown as Json;
  assert.equal(item.namespace, "mcp__easyswitch");
  assert.equal(item.name, "list_agents");
});
