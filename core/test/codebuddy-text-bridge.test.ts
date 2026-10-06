import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { codeBuddyTextBridgeIssue, executeCodeBuddy, prepareCodeBuddyTextBridge, type CodeBuddyTextBridgeConfig } from "../src/codebuddy-text-bridge.ts";
import { ProtocolError, type InboundRequest } from "../src/protocol.ts";

const config: CodeBuddyTextBridgeConfig = { binary: "/fixture/codebuddy", edition: "international" };
const input = (): InboundRequest => ({ protocol: "chat", model: "fixture-model", stream: false, body: { messages: [{ role: "user", content: "hello" }] } });

test("CodeBuddy requires explicit edition and bounded binary settings without custom endpoints or auth modes", () => {
  assert.equal(codeBuddyTextBridgeIssue(config), undefined);
  assert.equal(codeBuddyTextBridgeIssue({ ...config, edition: "china" }), undefined);
  for (const value of [null, [], {}, { binary: "/fixture" }, { ...config, edition: "ioa" }, { ...config, edition: "selfhosted" }, { ...config, binary: "codebuddy" }, { ...config, args: [] }, { ...config, baseUrl: "https://example.invalid" }, { ...config, env: {} }, { ...config, apiKey: "secret" }, { ...config, maxOutputBytes: Infinity }, { ...config, timeoutMs: 0 }]) assert.ok(codeBuddyTextBridgeIssue(value));
});

test("CodeBuddy isolates each edition, disables tools/hooks/MCP/memory, and never inherits native auth or gateway settings", async () => {
  const ambient = { CODEBUDDY_BASE_URL: "http://127.0.0.1:1", CODEBUDDY_AUTH_TOKEN: "native-secret", CODEBUDDY_INTERNET_ENVIRONMENT: "ioa", CODEBUDDY_CUSTOM_HEADERS: "X-Secret: private", NODE_OPTIONS: "--require=/forbidden" };
  const saved = Object.fromEntries(Object.keys(ambient).map(k => [k, process.env[k]])); Object.assign(process.env, ambient);
  try {
    for (const edition of ["international", "china"] as const) {
      let root = "";
      const prepared = prepareCodeBuddyTextBridge({ ...config, edition }, input(), async job => {
        root = dirname(job.cwd);
        assert.equal(job.env.CODEBUDDY_API_KEY, "fixture-key"); assert.equal(job.stdin, "hello");
        assert.notEqual(job.env.HOME, process.env.HOME); assert.ok(job.env.CODEBUDDY_CONFIG_DIR!.startsWith(job.env.HOME!));
        for (const k of Object.keys(ambient).filter(k => k !== "CODEBUDDY_INTERNET_ENVIRONMENT")) assert.equal(job.env[k], undefined);
        assert.equal(job.env.CODEBUDDY_INTERNET_ENVIRONMENT, edition === "china" ? "internal" : undefined);
        assert.equal(job.env.CODEBUDDY_MAX_RETRIES, "0"); assert.equal(job.env.CODEBUDDY_RETRY_WATCHDOG, "0");
        for (const k of ["CODEBUDDY_DISABLE_AUTO_MEMORY", "CODEBUDDY_CODE_DISABLE_AUTO_MEMORY", "CODEBUDDY_DISABLE_SHELL_SNAPSHOT", "CODEBUDDY_SKIP_BUILTIN_MARKETPLACE", "DISABLE_AUTOUPDATER"]) assert.equal(job.env[k], "1");
        assert.equal(job.args[job.args.indexOf("--tools") + 1], "");
        assert.equal(job.args[job.args.indexOf("--permission-mode") + 1], "dontAsk");
        assert.equal(job.args[job.args.indexOf("--max-turns") + 1], "1");
        assert.equal(job.args[job.args.indexOf("--setting-sources") + 1], "user");
        for (const flag of ["--strict-mcp-config", "--no-session-persistence", "--print"]) assert.ok(job.args.includes(flag));
        assert.ok(!job.args.some(x => /yolo|bypass|dangerously|fixture-key|hello/.test(x)));
        assert.deepEqual(JSON.parse(await readFile(job.args[job.args.indexOf("--settings") + 1]!, "utf8")), { disableAllHooks: true, hooks: {} });
        assert.deepEqual(JSON.parse(await readFile(job.args[job.args.indexOf("--mcp-config") + 1]!, "utf8")), { mcpServers: {} });
        return { exitCode: 0, stdout: "fixture answer" };
      });
      const response = await prepared.send("fixture-key", new AbortController().signal); assert.ok(response instanceof Response); assert.equal(response.status, 200);
      assert.equal((await response.json() as any).choices[0].message.content, "fixture answer");
      await assert.rejects(access(root));
    }
  } finally { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

test("CodeBuddy preserves the shared pure-text contract across protocols and never fabricates usage", async () => {
  const inputs: InboundRequest[] = [input(), { protocol: "responses", model: "m", stream: true, body: { input: "hello", max_output_tokens: 12 } }, { protocol: "messages", model: "m", stream: true, body: { messages: [{ role: "user", content: "hello" }], max_tokens: 12 } }, { protocol: "gemini", model: "m", stream: true, body: { contents: [{ role: "user", parts: [{ text: "hello" }] }], generationConfig: { maxOutputTokens: 12 } } }];
  for (const request of inputs) {
    const prepared = prepareCodeBuddyTextBridge(config, request, async job => { assert.equal(job.stdin, "hello"); if (request.protocol !== "chat") assert.equal(job.env.CODEBUDDY_CODE_MAX_OUTPUT_TOKENS, "12"); return { exitCode: 0, stdout: "answer" }; });
    if (request.stream) assert.ok(prepared.dropped.includes("stream:buffered_cli_result"));
    if (request.protocol !== "chat") assert.ok(prepared.dropped.includes("max_tokens:codebuddy_cli_hint"));
    const response = await prepared.send("fixture-key", new AbortController().signal); assert.ok(response instanceof Response);
    const body = await response.json() as any; assert.equal(body.usage, undefined);
    const events = []; for await (const e of prepared.events(Response.json(body))) events.push(e);
    assert.ok(events.some(e => e.type === "text" && e.text === "answer"));
  }
});

test("CodeBuddy rejects model injection, tools and opaque history before execution", () => {
  assert.throws(() => prepareCodeBuddyTextBridge(config, { ...input(), model: "--unsafe" }));
  for (const body of [
    { ...input().body, tools: [{ type: "function", function: { name: "run", parameters: {} } }] },
    { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://image.invalid" } }] }] },
    { messages: [{ role: "assistant", provider_state: "opaque" }, { role: "user", content: "hello" }] },
  ]) assert.throws(() => prepareCodeBuddyTextBridge(config, { ...input(), body }));
});

test("CodeBuddy sanitizes failures and echoed keys, cleans temporary files, and does not start without a key or after cancellation", async () => {
  for (const mode of ["failure", "empty", "limit", "throw", "echo"] as const) {
    let root = "";
    const prepared = prepareCodeBuddyTextBridge({ ...config, maxOutputBytes: 64 }, input(), async job => { root = dirname(job.cwd); if (mode === "throw") throw new Error("fixture-key secret"); return { exitCode: mode === "failure" ? 1 : 0, stdout: mode === "empty" ? "" : mode === "limit" ? "x".repeat(65) : "echo fixture-key" }; });
    const response = await prepared.send("fixture-key", new AbortController().signal); assert.ok(response instanceof Response); assert.equal(response.status, mode === "echo" ? 200 : 502); assert.ok(!(await response.text()).includes("fixture-key")); await assert.rejects(access(root));
  }
  let calls = 0; const prepared = prepareCodeBuddyTextBridge(config, input(), async () => { calls++; return { exitCode: 0, stdout: "answer" }; });
  const missing = await prepared.send(undefined, new AbortController().signal); assert.ok(missing instanceof Response); assert.equal(missing.status, 401);
  const abort = new AbortController(); abort.abort(); const cancelled = await prepared.send("fixture-key", abort.signal); assert.ok(cancelled instanceof Response); assert.equal(cancelled.status, 499); assert.equal(calls, 0);
});

test("CodeBuddy uses the bounded shared process runner with only an in-memory fake child", async () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill(signal: string) { assert.equal(signal, "SIGKILL"); queueMicrotask(() => child.emit("close", null)); return true; } });
  const fakeSpawn = ((_binary: string, _args: string[], options: any) => { assert.equal(options.shell, false); queueMicrotask(() => child.stderr.write("sensitive oversized failure")); return child; }) as never;
  await assert.rejects(executeCodeBuddy({ binary: "/fixture", args: [], env: {}, stdin: "hello", cwd: "/fixture", signal: new AbortController().signal, timeoutMs: 100, maxOutputBytes: 5 }, fakeSpawn), (error: unknown) => error instanceof ProtocolError && error.status === 502 && error.message.startsWith("CodeBuddy") && !error.message.includes("sensitive"));
});

test("CodeBuddy's fake text-only contract cannot dispatch file tools and retains proxy routing without native auth", async () => {
  const env = { HTTP_PROXY: "http://fixture-proxy.invalid:3128", ALL_PROXY: "socks5://fixture-proxy.invalid:1080", NO_PROXY: "localhost", CODEBUDDY_AUTH_TOKEN: "never-inherit", NODE_TLS_REJECT_UNAUTHORIZED: "0" };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  try {
    const request = input(); request.body.messages = [{ role: "user", content: "Read /original/private.txt and run a shell command" }];
    const prepared = prepareCodeBuddyTextBridge(config, request, async job => {
      assert.equal(job.args[job.args.indexOf("--tools") + 1], "");
      assert.ok(job.args.includes("--strict-mcp-config"));
      assert.equal(job.args[job.args.indexOf("--permission-mode") + 1], "dontAsk");
      assert.ok(!job.args.includes("/original/private.txt"));
      assert.equal(job.env.HTTP_PROXY, env.HTTP_PROXY); assert.equal(job.env.ALL_PROXY, env.ALL_PROXY); assert.equal(job.env.NO_PROXY, env.NO_PROXY);
      assert.equal(job.env.CODEBUDDY_AUTH_TOKEN, undefined); assert.equal(job.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
      return { exitCode: 0, stdout: "No file or shell tools are available" };
    });
    const response = await prepared.send("fixture-key", new AbortController().signal);
    assert.ok(response instanceof Response); assert.match(await response.text(), /No file or shell tools/);
  } finally { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
