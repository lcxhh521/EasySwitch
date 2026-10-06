import assert from "node:assert/strict";
import { test } from "node:test";
import { outboundBody, convertOutput, sseResponse } from "./protocol-fixture.ts";

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

test("real Responses-to-Chat egress merges instructions/developer turns and preserves paired result text", async t => {
  const { body } = await outboundBody(t, "responses", CODEX_REQUEST);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /You are Codex\.[\s\S]*skills_instructions/);
  assert.equal(body.messages.filter((m: any) => m.role === "system").length, 1);
  assert.deepEqual(body.messages.filter((m: any) => m.role === "tool").map((m: any) => [m.tool_call_id, m.content]), [["call_a", "a.txt"], ["call_b", "/tmp"], ["call_c", "Done"]]);
});

test("real egress preserves namespace/custom tool metadata for downstream restoration", async t => {
  const { body, tools } = await outboundBody(t, "responses", CODEX_REQUEST);
  assert.ok(tools.find(x => x.name === "apply_patch")?.custom);
  const custom = body.tools.find((x: any) => x.function.name === "apply_patch").function;
  assert.deepEqual(custom.parameters.required, ["input"]); assert.match(custom.description, /lark/);
  const replay = body.messages.flatMap((m: any) => m.tool_calls ?? []).find((x: any) => x.id === "call_c");
  assert.deepEqual(JSON.parse(replay.function.arguments), { input: "*** Begin Patch" });
});

test("real egress reports optional server tools and removes Responses-only fields", async t => {
  const { body, dropped } = await outboundBody(t, "responses", CODEX_REQUEST);
  assert.ok(dropped.includes("tool:web_search")); assert.equal(body.tools.length, 3);
  for (const key of ["include", "store", "instructions", "input", "metadata"]) assert.equal(body[key], undefined);
  assert.deepEqual(body.stream_options, { include_usage: true });
});

test("real Chat decoder and Responses renderer stream text with usage and monotonic sequence numbers", async () => {
  const { events, result } = await convertOutput(sseResponse([
    { choices: [{ delta: { content: "Hel" } }] }, { choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } },
  ]), "chat", "responses");
  assert.equal(events.filter(e => e.type === "response.output_text.delta").map(e => e.delta).join(""), "Hello");
  assert.equal(result.output[0].content[0].text, "Hello"); assert.equal(result.usage.input_tokens, 10);
  assert.deepEqual(events.map(e => e.sequence_number), events.map((_, i) => i));
});

test("real pipeline restores fragmented functions and custom-tool calls", async t => {
  const { tools } = await outboundBody(t, "responses", CODEX_REQUEST);
  const { result } = await convertOutput(sseResponse([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "exec_command", arguments: '{"cmd":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }, { index: 1, id: "call_y", function: { name: "apply_patch", arguments: '{"input":"*** Begin Patch"}' } }] }, finish_reason: "tool_calls" }] },
  ]), "chat", "responses", tools);
  assert.deepEqual(result.output.map((x: any) => [x.type, x.name, x.arguments ?? x.input]), [["function_call", "exec_command", '{"cmd":"ls"}'], ["custom_tool_call", "apply_patch", "*** Begin Patch"]]);
});

test("real pipeline restores namespace and bare tool names", async t => {
  const { tools } = await outboundBody(t, "responses", { input: "x", tools: [{ type: "namespace", name: "mcp__easyswitch", tools: [{ type: "function", name: "list_agents", parameters: {} }] }] });
  const { result } = await convertOutput(sseResponse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "mcp__easyswitch__list_agents", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }]), "chat", "responses", tools);
  assert.equal(result.output[0].namespace, "mcp__easyswitch"); assert.equal(result.output[0].name, "list_agents");
});

test("real stream keeps reasoning before visible text instead of treating text as the first block", async () => {
  const { result, events } = await convertOutput(sseResponse([{ choices: [{ delta: { reasoning_content: "thinking" } }] }, { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }]), "chat", "responses");
  assert.deepEqual(result.output.map((x: any) => x.type), ["reasoning", "message"]);
  assert.ok(events.findIndex(e => e.type === "response.reasoning_summary_text.delta") < events.findIndex(e => e.type === "response.output_text.delta"));
});
