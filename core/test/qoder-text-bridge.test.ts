import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { prepareQoderTextBridge, qoderTextBridgeIssue, executeQoder, type QoderProcessInput } from "../src/qoder-text-bridge.ts";
import { ProtocolError, type InboundRequest } from "../src/protocol.ts";

const input = (protocol: InboundRequest["protocol"] = "chat"): InboundRequest => ({ protocol, model: "auto", stream: false, body: protocol === "chat" ? { messages: [{ role: "user", content: "hello" }] } : protocol === "responses" ? { input: "hello" } : protocol === "messages" ? { max_tokens: 64, messages: [{ role: "user", content: "hello" }] } : { contents: [{ role: "user", parts: [{ text: "hello" }] }] } });
const config = { binary: "/fixture/qoder" };

test("Qoder validates only a bounded explicit executable configuration", () => {
  assert.equal(qoderTextBridgeIssue(config), undefined);
  for (const value of [null, [], {}, { binary: "qoder" }, { ...config, args: ["--yolo"] }, { ...config, env: {} }, { ...config, apiKey: "secret" }, { ...config, timeoutMs: 0 }, { ...config, maxOutputBytes: Infinity }]) assert.ok(qoderTextBridgeIssue(value));
});

test("Qoder isolates HOME/cwd/settings, sends PAT only in the child environment, and cleans up", async () => {
  let job: QoderProcessInput | undefined;
  const sentinel = process.env.QODER_TEST_AMBIENT_SECRET; process.env.QODER_TEST_AMBIENT_SECRET = "must-not-inherit";
  try {
    const prepared = prepareQoderTextBridge(config, input(), async request => {
      job = request;
      assert.equal(request.env.QODER_PERSONAL_ACCESS_TOKEN, "fixture-pat");
      assert.equal(request.env.QODER_TEST_AMBIENT_SECRET, undefined);
      assert.notEqual(request.env.HOME, process.env.HOME);
      assert.notEqual(request.cwd, process.cwd());
      assert.equal(request.stdin, "hello");
      assert.ok(!JSON.stringify(request.args).includes("fixture-pat"));
      assert.ok(!JSON.stringify(request.args).includes("hello"));
      for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--print"]) assert.ok(request.args.includes(flag));
      assert.equal(request.args[request.args.indexOf("--tools") + 1], "");
      assert.equal(request.args[request.args.indexOf("--max-turns") + 1], "1");
      assert.equal(request.args[request.args.indexOf("--max-model-request-retries") + 1], "0");
      assert.ok(!request.args.some(a => /yolo|bypass|dangerously/.test(a)));
      const settings = request.args[request.args.indexOf("--settings") + 1]!;
      assert.deepEqual(JSON.parse(await readFile(settings, "utf8")), { hooks: {}, mcpServers: {} });
      return { exitCode: 0, stdout: "fixture answer" };
    });
    const response = await prepared.send("fixture-pat", new AbortController().signal);
    assert.ok(response instanceof Response); assert.equal(response.status, 200);
    assert.equal((await response.json() as any).choices[0].message.content, "fixture answer");
    assert.equal(prepared.passthrough, false);
    await assert.rejects(access(dirname(job!.cwd)), "the entire owned temporary directory was removed");
  } finally { if (sentinel === undefined) delete process.env.QODER_TEST_AMBIENT_SECRET; else process.env.QODER_TEST_AMBIENT_SECRET = sentinel; }
});

test("Qoder handles all text protocol inputs without fabricating usage or streaming", async () => {
  for (const protocol of ["chat", "responses", "messages", "gemini"] as const) {
    const request = input(protocol); request.stream = true;
    const prepared = prepareQoderTextBridge(config, request, async job => { assert.equal(job.stdin, "hello"); return { exitCode: 0, stdout: "result" }; });
    assert.ok(prepared.dropped.includes("stream:buffered_cli_result"));
    const response = await prepared.send("fixture", new AbortController().signal); assert.ok(response instanceof Response);
    const body = await response.json() as any; assert.equal(body.usage, undefined);
    const events = []; for await (const event of prepared.events(Response.json(body))) events.push(event);
    assert.ok(events.some(e => e.type === "text" && e.text === "result"));
  }
});

test("Qoder rejects tools, media and invalid model flags before starting a child", () => {
  assert.throws(() => prepareQoderTextBridge(config, { ...input(), model: "--yolo" }));
  for (const body of [
    { messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "f", parameters: {} } }] },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://image.invalid/a" } }] }] },
    { messages: [{ role: "assistant", tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "{}" } }] }, { role: "tool", tool_call_id: "x", content: "result" }] },
    { messages: [{ role: "assistant", function_call: { name: "f", arguments: "{}" } }, { role: "user", content: "continue" }] },
    { messages: [{ role: "user", content: "x" }], functions: [{ name: "f" }] },
    { messages: [{ role: "user", content: "x" }], max_tokens: "--yolo" },
  ]) assert.throws(() => prepareQoderTextBridge(config, { ...input(), body }));
  const gemini = input("gemini"); gemini.body.systemInstruction = { parts: [{ inlineData: { mimeType: "image/png", data: "fixture" } }] };
  assert.throws(() => prepareQoderTextBridge(config, gemini));
});

test("Qoder errors, cancellation and limits never expose PAT/stderr and always remove temporary data", async () => {
  for (const mode of ["failure", "empty", "limit", "throw"] as const) {
    let root = "";
    const prepared = prepareQoderTextBridge({ ...config, maxOutputBytes: 64 }, input(), async job => {
      root = dirname(job.cwd);
      if (mode === "throw") throw new Error("fixture-pat in a vendor exception");
      return { exitCode: mode === "failure" ? 1 : 0, stdout: mode === "empty" ? "" : mode === "limit" ? "x".repeat(65) : "fixture-pat" };
    });
    const response = await prepared.send("fixture-pat", new AbortController().signal); assert.ok(response instanceof Response);
    assert.equal(response.status, 502); assert.ok(!(await response.text()).includes("fixture-pat"));
    await assert.rejects(access(root));
  }
  let started = false;
  const prepared = prepareQoderTextBridge(config, input(), async () => { started = true; throw new ProtocolError("timeout", 504); });
  const noKey = await prepared.send(undefined, new AbortController().signal); assert.ok(noKey instanceof Response); assert.equal(noKey.status, 401); assert.equal(started, false);
  const abort = new AbortController(); abort.abort();
  const cancelled = await prepared.send("fixture-pat", abort.signal); assert.ok(cancelled instanceof Response); assert.equal(cancelled.status, 499); assert.equal(started, false);
});

test("Qoder marks transcript role loss and redacts accidentally echoed credentials", async () => {
  const request = input(); request.body.messages.unshift({ role: "system", content: "short" });
  const prepared = prepareQoderTextBridge(config, request, async job => {
    assert.equal(JSON.parse(job.stdin).conversation[0].role, "system");
    return { exitCode: 0, stdout: "credential fixture-pat must be hidden" };
  });
  assert.ok(prepared.dropped.includes("roles:cli_text_transcript"));
  const response = await prepared.send("fixture-pat", new AbortController().signal); assert.ok(response instanceof Response);
  assert.ok(!(await response.text()).includes("fixture-pat"));
});


test("Qoder subprocess runner uses no shell and kills on abort, timeout or bounded output overflow", async () => {
  for (const mode of ["success", "abort", "timeout", "overflow"] as const) {
    const abort = new AbortController(); const kills: string[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill(signal: string) { kills.push(signal); queueMicrotask(() => child.emit("close", null)); return true; } });
    const spawnFake = ((_bin: string, _args: string[], options: any) => {
      assert.equal(options.shell, false); assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      queueMicrotask(() => {
        if (mode === "success") { child.stdout.write("ok"); child.emit("close", 0); }
        else if (mode === "abort") abort.abort();
        else if (mode === "overflow") child.stderr.write("do-not-echo-vendor-secret");
      });
      return child;
    }) as never;
    const pending = executeQoder({ binary: "/fake/qoder", args: [], env: {}, stdin: "hello", cwd: "/fake", signal: abort.signal, timeoutMs: 10, maxOutputBytes: 8 }, spawnFake);
    if (mode === "success") { assert.deepEqual(await pending, { exitCode: 0, stdout: "ok" }); assert.deepEqual(kills, []); }
    else { await assert.rejects(pending, (error: unknown) => error instanceof ProtocolError && error.status === (mode === "abort" ? 499 : mode === "timeout" ? 504 : 502)); assert.deepEqual(kills, ["SIGKILL"]); }
  }
});
