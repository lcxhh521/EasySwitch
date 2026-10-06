import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * A deliberately narrow MCP transport adapter for EasySwitch's stateless POST /mcp.
 * It does not launch tools, negotiate a second session, or accept arbitrary remote URLs.
 * stdio framing: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */
export interface McpBridgeOptions {
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
}

type Rpc = Record<string, unknown>;
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

export function validateBridgeOptions(options: McpBridgeOptions): void {
  const url = new URL(options.url);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password) {
    throw new Error("MCP bridge only accepts the local EasySwitch /mcp endpoint");
  }
  // Validate header syntax before handling any client data. Never print credentials.
  new Headers(options.headers);
  if (!Number.isSafeInteger(options.maxBytes ?? 4_000_000) || (options.maxBytes ?? 4_000_000) < 128) throw new Error("Invalid MCP message limit");
  if (!Number.isFinite(options.timeoutMs ?? 310_000) || (options.timeoutMs ?? 310_000) <= 0) throw new Error("Invalid MCP timeout");
}

async function boundedBody(response: Response, max: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > max) { void reader.cancel().catch(() => undefined); throw new Error("MCP response exceeds limit"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Accept a finite SSE reply as well as JSON; both are already bounded by the same body limit. */
function responseMessage(body: string, contentType: string | null, id?: unknown): unknown {
  if (!contentType?.toLowerCase().includes("text/event-stream")) return JSON.parse(body);
  const messages: unknown[] = [];
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") continue;
    messages.push(JSON.parse(data));
  }
  // Progress notifications may come before the answer: take the message that answers this request.
  const answer = messages.filter(m => m && typeof m === "object" && (m as Rpc).id === id && ("result" in (m as Rpc) || "error" in (m as Rpc)));
  if (answer.length !== 1) throw new Error("Expected one MCP reply");
  return answer[0];
}

/** JSON-RPC output only, one object per line. Diagnostics never expose the endpoint or headers. */
export async function runMcpStdioBridge(input: Readable, output: Writable, options: McpBridgeOptions): Promise<void> {
  validateBridgeOptions(options);
  const max = options.maxBytes ?? 4_000_000;
  const controllers = new Set<AbortController>();
  let failure: Error | undefined;
  const fail = () => { failure ??= new Error("EasySwitch MCP stdio stream failed"); for (const controller of controllers) controller.abort(); input.destroy(); };
  output.on("error", fail);
  // Reserve a bounded control lane so slow tools cannot starve ping/cancellation.
  const active = { tool: 0, control: 0 };
  const limits = { tool: 3, control: 8 };
  // Requests run side by side (a long run_agent must not hold up a ping or a cancel); only the writing is one at a time.
  let writing: Promise<void> = Promise.resolve();
  const write = (value: unknown): Promise<void> => {
    const line = JSON.stringify(value) + "\n";
    const next = writing.then(() => new Promise<void>((done, reject) => output.write(line, error => error ? reject(error) : done())));
    writing = next.catch(() => undefined);
    return next;
  };
  const running = new Set<Promise<void>>();
  const start = async (line: string) => {
    // Backpressure also bounds queued error replies when a client floods a saturated bridge.
    while (running.size >= 12 && !failure) await Promise.race(running);
    if (failure) throw failure;
    const job: Promise<void> = handle(line).catch(fail).finally(() => running.delete(job));
    running.add(job);
  };
  const handle = async (line: string) => {
    if (!line.trim()) return;
    let msg: Rpc;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request");
      msg = parsed as Rpc;
    } catch { await write(rpcError(null, -32700, "Invalid JSON-RPC message")); return; }
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string" ||
      (msg.id !== undefined && msg.id !== null && typeof msg.id !== "string" && typeof msg.id !== "number")) {
      await write(rpcError(null, -32600, "Invalid JSON-RPC request")); return;
    }
    const notification = msg.id === undefined;
    const lane = msg.method === "tools/call" ? "tool" : "control";
    if (active[lane] >= limits[lane]) { if (!notification) await write(rpcError(msg.id, -32000, "EasySwitch MCP bridge is busy")); return; }
    active[lane]++;
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 310_000);
    try {
      const response = await fetch(options.url, { method: "POST", redirect: "error",
        headers: { ...options.headers, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: line, signal: controller.signal });
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error("MCP request rejected"); }
      const body = await boundedBody(response, max);
      if (notification) return;
      if (!body) throw new Error("Missing MCP response");
      const answer = responseMessage(body, response.headers.get("content-type"), msg.id);
      if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("Invalid MCP response");
      const rpc = answer as Rpc;
      if (rpc.jsonrpc !== "2.0" || rpc.id !== msg.id || (("result" in rpc) === ("error" in rpc))) throw new Error("Invalid MCP response");
      await write(rpc);
    } catch {
      if (!notification && !failure) await write(rpcError(msg.id, -32000, "EasySwitch MCP request failed or timed out"));
    } finally { clearTimeout(timer); controllers.delete(controller); active[lane]--; }
  };
  input.setEncoding("utf8");
  let buffer = "";
  let discarding = false;
  try {
  for await (const chunk of input) {
    // Walk each chunk so a single huge newline-delimited input never creates an unbounded buffer.
    for (const part of String(chunk).split(/(?<=\n)/)) {
      const ended = part.endsWith("\n");
      if (!discarding) {
        if (Buffer.byteLength(buffer) + Buffer.byteLength(part) > max) {
          buffer = ""; discarding = true;
          await write(rpcError(null, -32600, "MCP message exceeds limit"));
        } else buffer += part;
      }
      if (ended) {
        if (!discarding) await start(buffer.trimEnd());
        buffer = ""; discarding = false;
      }
    }
  }
  // A final non-newline JSON message is accepted when the client closes its input.
  if (buffer && !discarding) await start(buffer);
  } catch { fail(); }
  finally {
    await Promise.allSettled(running);
    output.off("error", fail);
  }
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const headers: unknown = JSON.parse(process.env.EASYSWITCH_MCP_HEADERS ?? "{}");
    if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== "string")) throw new Error("Invalid headers");
    await runMcpStdioBridge(process.stdin, process.stdout, { url: process.env.EASYSWITCH_MCP_URL ?? "", headers: headers as Record<string, string> });
  } catch {
    process.stderr.write("EasySwitch MCP bridge could not start or its stdio stream closed\n");
    process.exitCode = 1;
  }
}
