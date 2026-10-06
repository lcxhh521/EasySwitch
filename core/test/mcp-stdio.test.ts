import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

type Json = Record<string, any>;
const seen: Array<{ headers: Record<string, string | string[] | undefined>; body: Json }> = [];
let server: Server;
let url: string;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as Json;
      seen.push({ headers: req.headers, body });
      if (body.id === undefined) { res.writeHead(202).end(); return; }
      if (body.method === "sse") { res.writeHead(200, { "content-type": "text/event-stream" }).end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { via: "sse" } })}\n\n`); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { echo: body.method } }));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
});
after(() => { server.closeAllConnections(); server.close(); });

/** Runs the bridge, writes these lines to it, and returns what it printed once its input is closed. */
function bridge(args: string[], input: string[]): Promise<{ out: string[]; code: number | null }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ["bin/es-mcp-stdio.ts", ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.on("close", code => resolve({ out: out.split("\n").filter(Boolean), code }));
    child.stdin.end(input.join("\n") + "\n");
  });
}

test("each request line is sent to the HTTP endpoint with the given headers and its answer comes back as one line; a notification is forwarded and gets no answer", async () => {
  seen.length = 0;
  const run = await bridge([url, "--header", "Authorization: Bearer es-session-trae-x", "--header", "x-easyswitch-depth: 1"], [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "sse" }),
  ]);
  assert.equal(run.code, 0);
  const answers = run.out.map(l => JSON.parse(l) as Json).sort((a, b) => a.id - b.id);
  assert.deepEqual(answers.map(a => a.id), [1, 2, 3], "one answer per request, none for the notification");
  assert.deepEqual(answers[0]!.result, { echo: "initialize" });
  assert.deepEqual(answers[2]!.result, { via: "sse" }, "an answer that comes as an event is unwrapped");
  assert.equal(seen.length, 4, "the notification was forwarded too");
  assert.ok(seen.every(s => s.headers.authorization === "Bearer es-session-trae-x" && s.headers["x-easyswitch-depth"] === "1"));
});

test("a message that is not JSON, an unreachable server and a foreign address are each said plainly", async () => {
  const bad = await bridge([url], ["this is not json"]);
  assert.equal(JSON.parse(bad.out[0]!).error.code, -32700);
  const down = await bridge(["http://127.0.0.1:1/mcp"], [JSON.stringify({ jsonrpc: "2.0", id: 7, method: "x" })]);
  assert.equal(JSON.parse(down.out[0]!).id, 7);
  assert.match(JSON.parse(down.out[0]!).error.message, /not reachable/);
  const foreign = await bridge(["http://example.com/mcp"], [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" })]);
  assert.equal(foreign.code, 2, "only this machine's own address is accepted: the token goes nowhere else");
  assert.deepEqual(foreign.out, []);
});

test("with EasySwitch's real MCP server behind it, an agent that only speaks stdio can list and call the other agents' tools", async () => {
  const { createEasySwitchServer } = await import("../src/server.ts");
  const { createSecretStore } = await import("../src/secrets.ts");
  const { Store } = await import("../src/store.ts");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  process.env.EASYSWITCH_SECRETS = "memory";
  const dir = mkdtempSync(join(tmpdir(), "es-stdio-"));
  const port = await new Promise<number>(resolve => { const p = createServer().listen(0, "127.0.0.1", () => { const n = (p.address() as { port: number }).port; p.close(() => resolve(n)); }); });
  const real = createEasySwitchServer({ store: new Store(dir), secrets: createSecretStore(), port });
  await new Promise<void>(r => real.listen(port, "127.0.0.1", r));
  try {
    const run = await bridge([`http://127.0.0.1:${port}/mcp`, "--header", "Authorization: Bearer es-session-trae-x"], [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ]);
    const answers = run.out.map(l => JSON.parse(l) as Json).sort((a, b) => a.id - b.id);
    assert.equal(answers.length, 2);
    const names = (answers[1]!.result.tools as Array<{ name: string }>).map(t => t.name);
    assert.ok(names.includes("run_agent") && names.includes("list_agents") && names.includes("list_models"), names.join(","));
    const without = await bridge([`http://127.0.0.1:${port}/mcp`], [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })]);
    assert.match(JSON.parse(without.out[0]!).error.message ?? "", /token|令牌|per-launch/i, "no token, no tools");
  } finally { real.closeAllConnections(); real.close(); rmSync(dir, { recursive: true, force: true }); }
});
