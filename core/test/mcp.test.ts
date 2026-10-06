import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { claudeArgs, claudeEnv, codexArgs, findClaude, findCodex } from "../src/launch.ts";
import { handleMcp, MAX_DEPTH, mcpEndpoint, type McpDeps } from "../src/mcp.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { gatewayTokens, sessionToken } from "../src/gateway-auth.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
const run = promisify(execFile);
type Json = Record<string, any>;

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let pid: string;
let TOKEN: string;

before(async () => {
  TOKEN = sessionToken("fixture", { allowMcp: true, depth: 0, allowNativeClaude: false });
  relay = await startMockRelay(0, { apiKey: "relay-key" });
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  server = createEasySwitchServer({ store: new Store(mkdtempSync(join(tmpdir(), "es-mcp-"))), secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  pid = ((await fetch(`http://127.0.0.1:${port}/api/providers`, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" },
    body: JSON.stringify({ name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "relay-key" }),
  }).then(r => r.json())) as { id: string }).id;
});

after(() => { gatewayTokens.revoke(TOKEN); server.closeAllConnections(); server.close(); relay.server.closeAllConnections(); relay.server.close(); });

const rpc = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) =>
  fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });

test("the MCP server speaks the handshake and lists its three tools", async () => {
  const init = (await (await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } })).json()) as Json;
  assert.equal(init.result.serverInfo.name, "easyswitch");
  assert.ok(init.result.capabilities.tools);
  const note = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(note.status, 202, "a notification gets no body");
  const tools = (await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as Json;
  assert.deepEqual(tools.result.tools.map((t: Json) => t.name), ["list_agents", "run_agent", "list_models"]);
  assert.deepEqual(tools.result.tools[1].inputSchema.required, ["agent", "task"]);
});

test("calls need a per-launch token; unknown methods are JSON-RPC errors; GET is refused", async () => {
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, {})).status, 401);
  assert.equal((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { authorization: "Bearer sk-someone-elses" })).status, 401);
  const bad = (await (await rpc({ jsonrpc: "2.0", id: 9, method: "nope" })).json()) as Json;
  assert.equal(bad.error.code, -32601);
  assert.equal((await fetch(`http://127.0.0.1:${port}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
});

test("list_models and list_agents answer; run_agent refuses what it should", async t => {
  const call = async (name: string, args: Json, headers?: Record<string, string>) =>
    ((await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, headers)).json()) as Json).result;
  assert.match((await call("list_models", {})).content[0].text, new RegExp(`${pid}/mock-coder`));
  assert.match((await call("list_agents", {})).content[0].text, /claude|codex|No agent can take a task/, "built-in agents are listed when installed");
  assert.equal((await call("run_agent", { agent: "claude" })).isError, true, "a task is required");
  assert.match((await call("run_agent", { agent: "no-such-agent", task: "x" })).content[0].text, /Unknown or unavailable agent/);
  const deepToken = sessionToken("fixture", { allowMcp: true, depth: MAX_DEPTH, allowNativeClaude: false });
  t.after(() => gatewayTokens.revoke(deepToken));
  const deep = await call("run_agent", { agent: "claude", task: "x" }, { authorization: `Bearer ${deepToken}`, "x-easyswitch-depth": "0" });
  assert.match(deep.content[0].text, /nest at most/, "agents started by agents cannot start agents without end");
});

test("run_agent hands a task to an agent and returns what it answered (fake runner)", async () => {
  const seen: Json[] = [];
  const deps: McpDeps = {
    store: new Store(mkdtempSync(join(tmpdir(), "es-mcp2-"))), secrets: createSecretStore(), log: () => {},
    agents: async () => [{ id: "dsh", name: "DeepSeek Harness", model: "p/m" }],
    run: async (id, input) => { seen.push({ id, ...input }); return { exitCode: 0, output: "the answer", timedOut: false, model: input.model ?? "p/m" }; },
  };
  const req = { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-easyswitch-depth": "0" } } as never;
  let out = "";
  const res = { writeHead: () => res, end: (b?: string) => { out = b ?? ""; } } as never;
  await handleMcp(req, res, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_agent", arguments: { agent: "dsh", task: "summarise", cwd: "/tmp" } } }), deps);
  const result = (JSON.parse(out) as Json).result;
  assert.match(result.content[0].text, /\[dsh on p\/m, exit 0\]\nthe answer/);
  assert.deepEqual({ task: seen[0]!.task, cwd: seen[0]!.cwd, depth: seen[0]!.depth }, { task: "summarise", cwd: "/tmp", depth: 1 });
});

test("a REAL Claude Code, launched on the gateway with the MCP attached, calls list_agents", async t => {
  const claude = await findClaude();
  if (!claude) { t.skip("claude not installed"); return; }
  const home = mkdtempSync(join(tmpdir(), "es-claude-home-"));
  const work = mkdtempSync(join(tmpdir(), "es-claude-work-"));
  const token = sessionToken("claude", { allowMcp: true, depth: 0, allowNativeClaude: false });
  t.after(() => { gatewayTokens.revoke(token); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  const env = claudeEnv(port, `${pid}/mock-coder`, token);
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude") };
  for (const k of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) delete childEnv[k];
  const before = relay.requests.length;
  const pending = run(claude, ["-p", "Please list the agents you can hand work to.", "--permission-mode", "default", "--allowedTools", "mcp__easyswitch__list_agents", ...claudeArgs(env, mcpEndpoint(port, token, 0))], { cwd: work, env: childEnv, timeout: 120_000 });
  pending.child.stdin?.end();
  const result = await pending.catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
  const turns = relay.requests.slice(before) as Json[];
  const toolNames = turns.flatMap(r => (r.tools ?? []).map((x: Json) => x.function?.name));
  assert.ok(toolNames.includes("mcp__easyswitch__list_agents"), `Claude Code offered the MCP tool to the model: ${toolNames.slice(0, 12).join(",")}`);
  const answered = turns.some(r => (r.messages as Json[]).some(m => m.role === "tool" && /- (claude|codex|dsh)/.test(String(m.content))));
  assert.ok(answered, `the tool result from EasySwitch came back to the model: ${String(result.stdout).slice(0, 300)}`);
});

test("a REAL Codex, launched on the gateway with the MCP attached, sees and calls list_agents", async t => {
  const codex = await findCodex();
  if (!codex) { t.skip("codex not installed"); return; }
  const home = mkdtempSync(join(tmpdir(), "es-codex-mcp-"));
  const work = mkdtempSync(join(tmpdir(), "es-codex-work-"));
  const token = sessionToken("codex", { allowMcp: true, depth: 0, allowNativeClaude: false });
  t.after(() => { gatewayTokens.revoke(token); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true }); });
  const before = relay.requests.length;
  const pending = run(codex, ["exec", "--skip-git-repo-check", ...codexArgs(port, `${pid}/mock-coder`, undefined, mcpEndpoint(port, token, 0)), "Please list the agents you can hand work to."],
    { cwd: work, env: { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: home, OPENAI_API_KEY: "", EASYSWITCH_GATEWAY_TOKEN: token }, timeout: 120_000 });
  pending.child.stdin?.end();
  const result = await pending.catch((e: { stdout?: string; stderr?: string }) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
  const turns = relay.requests.slice(before) as Json[];
  const toolNames = turns.flatMap(r => (r.tools ?? []).map((x: Json) => x.function?.name));
  assert.ok(toolNames.some((n: string) => /list_agents$/.test(n)), `Codex offered the MCP tool to the model: ${toolNames.join(",").slice(0, 400)} | ${String(result.stderr).slice(-300)}`);
  const answered = turns.some(r => (r.messages as Json[]).some(m => m.role === "tool" && /- (claude|codex|dsh)/.test(String(m.content))));
  const seenTools = turns.flatMap(r => (r.messages as Json[]).filter(m => m.role === "tool").map(m => String(m.content).slice(0, 200)));
  assert.ok(answered, `the tool result from EasySwitch came back to the model: ${JSON.stringify(seenTools)} | roles ${JSON.stringify(turns.map(r => (r.messages as Json[]).map(m => m.role)))} | ${String(result.stderr).slice(-400)}`);
});
