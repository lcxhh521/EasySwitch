import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Readable, Writable } from "node:stream";
import { test } from "node:test";
import { runMcpStdioBridge, validateBridgeOptions, type McpBridgeOptions } from "../src/mcp-stdio-bridge.ts";

async function fixture(handler: (req: IncomingMessage, res: ServerResponse, msg: Record<string, unknown>) => void) {
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    handler(req, res, JSON.parse(body));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}

async function bridge(chunks: string[], options: McpBridgeOptions) {
  let out = "";
  const output = new Writable({ write(chunk, _encoding, done) { out += chunk.toString(); done(); } });
  await runMcpStdioBridge(Readable.from(chunks), output, options);
  return out.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("the stdio bridge carries initialization, notifications and tool calls over loopback with exact auth/depth", async () => {
  const received: Record<string, unknown>[] = [];
  const server = await fixture((req, res, msg) => {
    assert.equal(req.method, "POST"); assert.equal(req.url, "/mcp");
    assert.equal(req.headers.authorization, "Bearer fixture-token");
    assert.equal(req.headers["x-easyswitch-depth"], "2");
    received.push(msg);
    if (msg.id === undefined) { res.writeHead(202).end(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.method === "tools/call" ? { content: [{ type: "text", text: "fixture result" }] } : {} }));
  });
  try {
    const lines = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: "call", method: "tools/call", params: { name: "run_agent", arguments: { agent: "fixture", task: "你好" } } },
    ];
    const data = lines.map(x => JSON.stringify(x)).join("\n") + "\n";
    const replies = await bridge([data.slice(0, 17), data.slice(17, 61), data.slice(61)], { url: server.url, headers: { Authorization: "Bearer fixture-token", "x-easyswitch-depth": "2" } });
    assert.deepEqual(received, lines);
    assert.deepEqual(replies.map(x => x.id), [1, "call"]);
    assert.equal(replies[1].result.content[0].text, "fixture result");
  } finally { await server.close(); }
});

test("the bridge validates destinations before sending credentials anywhere", () => {
  for (const url of ["https://127.0.0.1/mcp", "http://example.com/mcp", "http://127.0.0.1.evil.test/mcp", "http://u:p@127.0.0.1/mcp", "http://127.0.0.1/other", "http://127.0.0.1/mcp?token=x", "http://127.0.0.1/mcp#x"]) {
    assert.throws(() => validateBridgeOptions({ url, headers: {} }), /only accepts/);
  }
  assert.doesNotThrow(() => validateBridgeOptions({ url: "http://127.0.0.1:1234/mcp", headers: {} }));
  assert.throws(() => validateBridgeOptions({ url: "http://127.0.0.1/mcp", headers: {}, maxBytes: -1 }), /limit/);
});

test("malformed and oversized input is bounded, then the next valid message still works", async () => {
  let calls = 0;
  const server = await fixture((_req, res, msg) => { calls++; res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} })); });
  try {
    const replies = await bridge(["no json\n", "[]\n", "x".repeat(200), "x\n", '{"jsonrpc":"2.0","id":4,"method":"ping"}'], { url: server.url, headers: {}, maxBytes: 128 });
    assert.deepEqual(replies.map(x => x.error?.code ?? "ok"), [-32700, -32700, -32600, "ok"]);
    assert.equal(replies[3].id, 4); assert.equal(calls, 1);
  } finally { await server.close(); }
});

test("HTTP failures, redirects and mismatched JSON-RPC IDs give safe errors without leaking body/token", async () => {
  const server = await fixture((_req, res, msg) => {
    if (msg.id === 1) { res.writeHead(401).end("SECRET-BODY"); return; }
    if (msg.id === 2) { res.writeHead(302, { location: "http://example.com/mcp" }).end(); return; }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 999, result: "SECRET-BODY" }));
  });
  try {
    const replies = await bridge([...[1, 2, 3].map(id => JSON.stringify({ jsonrpc: "2.0", id, method: "ping" }) + "\n")], { url: server.url, headers: { Authorization: "Bearer PRIVATE-TOKEN" } });
    assert.deepEqual(replies.map(x => x.id), [1, 2, 3]);
    assert.ok(replies.every(x => x.error.code === -32000));
    assert.doesNotMatch(JSON.stringify(replies), /SECRET-BODY|PRIVATE-TOKEN|example\.com/);
  } finally { await server.close(); }
});

test("oversized and timed-out server responses are bounded and notifications never get responses", async () => {
  const server = await fixture((_req, res, msg) => {
    if (msg.id === "large") res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "x".repeat(2000) }));
    else if (msg.id === "wait") { /* the bridge timeout ends this request */ }
    else res.writeHead(500).end("not a response to a notification");
  });
  try {
    const replies = await bridge([
      '{"jsonrpc":"2.0","id":"large","method":"ping"}\n',
      '{"jsonrpc":"2.0","id":"wait","method":"ping"}\n',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
    ], { url: server.url, headers: {}, maxBytes: 128, timeoutMs: 50 });
    assert.deepEqual(replies.map(x => x.id), ["large", "wait"]);
    assert.ok(replies.every(x => x.error.code === -32000));
  } finally { await server.close(); }
});
