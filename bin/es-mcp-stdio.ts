#!/usr/bin/env node
// A bridge for agents that can only start an MCP server as a child process speaking JSON-RPC over stdio:
// each line on stdin is sent to EasySwitch's HTTP MCP endpoint, and the answer is written back as a line.
//
//   node bin/es-mcp-stdio.ts <url> [--header "Name: value"]...
//
// Notifications (messages without an id) are forwarded and need no answer. Nothing is kept or logged.
import { createInterface } from "node:readline";

const [url, ...rest] = process.argv.slice(2);
if (!url || !/^https?:\/\/127\.0\.0\.1[:/]/.test(url)) {
  process.stderr.write("usage: es-mcp-stdio <http://127.0.0.1:PORT/mcp> [--header \"Name: value\"]...\nonly this machine's own address is accepted\n");
  process.exit(2);
}
const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
for (let i = 0; i < rest.length; i++) {
  if (rest[i] !== "--header" || !rest[i + 1]) continue;
  const text = rest[++i]!;
  const at = text.indexOf(":");
  if (at > 0) headers[text.slice(0, at).trim().toLowerCase()] = text.slice(at + 1).trim();
}

const send = (line: string) => process.stdout.write(`${line}\n`);

async function handle(line: string): Promise<void> {
  let message: { id?: unknown };
  try { message = JSON.parse(line) as { id?: unknown }; } catch { return send(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })); }
  const wantsAnswer = message.id !== undefined && message.id !== null;
  try {
    const response = await fetch(url!, { method: "POST", headers, body: line, signal: AbortSignal.timeout(300_000) });
    const text = await response.text();
    if (!wantsAnswer) return;
    // An answer may come as plain JSON or as a one-event stream: take the JSON either way.
    const body = text.trimStart().startsWith("{") || text.trimStart().startsWith("[") ? text.trim() : (/^data:\s*(.+)$/m.exec(text)?.[1] ?? "");
    if (body) send(body.replace(/\r?\n/g, " ")); else send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `EasySwitch answered HTTP ${response.status} with nothing to read` } }));
  } catch (error) {
    if (wantsAnswer) send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `EasySwitch is not reachable: ${(error as Error).message}` } }));
  }
}

const pending = new Set<Promise<void>>();
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  if (!line.trim()) return;
  const job = handle(line).finally(() => pending.delete(job));
  pending.add(job);
});
lines.on("close", () => { void Promise.all(pending).then(() => process.exit(0)); });
