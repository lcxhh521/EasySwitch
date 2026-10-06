#!/usr/bin/env node
/** Compatibility entry point; all transport/security behavior lives in the shared bridge. */
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runMcpStdioBridge, validateBridgeOptions, type McpBridgeOptions } from "../core/src/mcp-stdio-bridge.ts";

/** Prefer environment credentials; the historical URL/--header arguments remain accepted. */
export function parseMcpStdioArgs(args: string[], env: NodeJS.ProcessEnv = process.env): McpBridgeOptions {
  const url = args[0] ?? env.EASYSWITCH_MCP_URL ?? "";
  const fromEnv: unknown = JSON.parse(env.EASYSWITCH_MCP_HEADERS ?? "{}");
  if (!fromEnv || typeof fromEnv !== "object" || Array.isArray(fromEnv) || Object.values(fromEnv).some(value => typeof value !== "string")) throw new Error("Invalid MCP headers");
  const headers = new Headers(fromEnv as Record<string, string>);
  for (let index = 1; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] !== "--header" || !value) throw new Error("Invalid MCP bridge arguments");
    const colon = value.indexOf(":");
    if (colon < 1) throw new Error("Invalid MCP header");
    headers.set(value.slice(0, colon).trim(), value.slice(colon + 1).trim());
  }
  const options = { url, headers: Object.fromEntries(headers) };
  validateBridgeOptions(options);
  return options;
}

/** Injectable streams make the actual entry contract testable without a child process. */
export async function runMcpStdioCli(args: string[], input: Readable, output: Writable, diagnostic: Writable, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let options: McpBridgeOptions;
  try { options = parseMcpStdioArgs(args, env); }
  catch {
    diagnostic.write("usage: es-mcp-stdio <http://127.0.0.1:PORT/mcp> [--header \"Name: value\"]...\nOnly the local EasySwitch MCP endpoint and valid headers are accepted\n");
    return 2;
  }
  try { await runMcpStdioBridge(input, output, options); return 0; }
  catch { diagnostic.write("EasySwitch MCP bridge stream closed or failed\n"); return 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runMcpStdioCli(process.argv.slice(2), process.stdin, process.stdout, process.stderr);
}
