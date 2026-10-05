import type { IncomingMessage, ServerResponse } from "node:http";
import { agentFromAuth } from "./gateway-chat.ts";
import { catalogModels } from "./catalog.ts";
import type { GatewayDeps } from "./gateway.ts";
import type { RunResult } from "./agent-launch.ts";

/**
 * EasySwitch as an MCP server (streamable HTTP, JSON-RPC over POST /mcp), so that
 * any agent which can attach an MCP server can hand work to any other agent:
 *
 *   list_agents   which agents can be called, and on which model
 *   run_agent     give one agent a task, wait, get its answer back
 *   list_models   the models the gateway serves
 *
 * Guard rails, because an agent can now start agents: calls are authenticated by the
 * per-launch token, depth is limited (an agent started by run_agent can call one more
 * level, no further), at most a few run at once, every run has a timeout, and the
 * called agent starts with its harness' read-only defaults.
 */

type Json = Record<string, unknown>;

export const MCP_PROTOCOL = "2025-03-26";
export const MAX_DEPTH = 2;
export const MAX_CONCURRENT = 3;

export interface McpDeps extends GatewayDeps {
  /** Agents that can take a task right now: id, name, bound model. */
  agents(): Promise<Array<{ id: string; name: string; model?: string }>>;
  run(agentId: string, input: { task: string; model?: string; cwd?: string; effort?: string; depth: number; from: string }): Promise<RunResult & { model: string }>;
}

const TOOLS = [
  {
    name: "list_agents",
    description: "List the coding agents EasySwitch can hand a task to, with the model each one will use. Call this before run_agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "run_agent",
    description:
      "Hand one self-contained task to another coding agent and wait for its answer. The agent runs headlessly in `cwd` with its read-only defaults, " +
      "so it can read files, search and reason but will not edit files or run risky commands unless its own defaults allow it. Describe the task completely: " +
      "the other agent does not see this conversation. Use it for a second opinion, for a different model's strengths, or to split work.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent id from list_agents, e.g. claude, codex, dsh." },
        task: { type: "string", description: "The complete task, with all the context the agent needs." },
        model: { type: "string", description: "Optional <provider>/<model> from list_models; default is the agent's own model." },
        effort: { type: "string", description: "Optional reasoning level: minimal, low, medium, high, xhigh or max. Ignored by agents that do not support it. Higher is slower and costs more." },
        cwd: { type: "string", description: "Optional absolute working directory; default is a private empty directory." },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_models",
    description: "List the models EasySwitch serves, as <provider>/<model>.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

const text = (value: string, isError = false): Json => ({ content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) });
let running = 0;

async function callTool(name: string, args: Json, depth: number, caller: string, deps: McpDeps): Promise<Json> {
  if (name === "list_agents") {
    const agents = await deps.agents();
    return text(agents.length ? agents.map(a => `- ${a.id}: ${a.name}${a.model ? ` (model ${a.model})` : " (no model chosen yet)"}`).join("\n") : "No agent can take a task right now.");
  }
  if (name === "list_models") {
    const models = catalogModels(deps.store.providers());
    return text(models.length ? models.map(m => `${m.providerId}/${m.model}`).join("\n") : "No models are configured.");
  }
  if (name === "run_agent") {
    const agent = String(args.agent ?? "");
    const task = String(args.task ?? "").trim();
    if (!agent || !task) return text("run_agent needs `agent` and `task`.", true);
    if (depth >= MAX_DEPTH) return text(`Refused: agents started by agents may nest at most ${MAX_DEPTH} levels deep.`, true);
    if (running >= MAX_CONCURRENT) return text(`Refused: ${MAX_CONCURRENT} agent runs are already in progress. Try again shortly.`, true);
    const available = await deps.agents();
    if (!available.some(a => a.id === agent)) return text(`Unknown or unavailable agent "${agent}". Available: ${available.map(a => a.id).join(", ") || "none"}.`, true);
    running += 1;
    try {
      const result = await deps.run(agent, {
        task,
        ...(typeof args.model === "string" && args.model ? { model: args.model } : {}),
        ...(typeof args.effort === "string" && args.effort ? { effort: args.effort } : {}),
        ...(typeof args.cwd === "string" && args.cwd.startsWith("/") ? { cwd: args.cwd } : {}),
        depth: depth + 1,
        from: caller,
      });
      const head = `[${agent} on ${result.model}${result.timedOut ? ", stopped at the time limit" : ""}, exit ${result.exitCode ?? "?"}]`;
      return text(`${head}\n${result.output || "(no output)"}`, result.exitCode !== 0 || result.timedOut);
    } catch (error) {
      return text(String((error as Error).message ?? error), true);
    } finally {
      running -= 1;
    }
  }
  return text(`Unknown tool "${name}".`, true);
}

function rpcError(id: unknown, code: number, message: string): Json {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMessage(msg: Json, depth: number, caller: string, deps: McpDeps): Promise<Json | undefined> {
  const { id, method } = msg;
  const params = (msg.params ?? {}) as Json;
  if (id === undefined) return undefined; // a notification: nothing to answer
  switch (method) {
    case "initialize":
      return { jsonrpc: "2.0", id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "easyswitch", version: "0.0.1" }, instructions: "Use list_agents, then run_agent to hand a task to another coding agent." } };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call":
      return { jsonrpc: "2.0", id, result: await callTool(String(params.name ?? ""), (params.arguments ?? {}) as Json, depth, caller, deps) };
    default:
      return rpcError(id, -32601, `Method not found: ${String(method)}`);
  }
}

/** POST /mcp. The depth comes from the header the launch put in the MCP config, never from the body. */
export async function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: McpDeps): Promise<void> {
  if (req.method !== "POST") {
    // No server-initiated stream: this server only answers requests.
    res.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!token.startsWith("es-session-")) {
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify(rpcError(null, -32001, "A per-launch EasySwitch token is required")));
    return;
  }
  const depth = Math.max(0, Math.min(Number(req.headers["x-easyswitch-depth"] ?? 0) || 0, MAX_DEPTH));
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify(rpcError(null, -32700, "Parse error")));
    return;
  }
  const batch = Array.isArray(parsed);
  const out: Json[] = [];
  for (const msg of batch ? (parsed as Json[]) : [parsed as Json]) {
    const answer = await handleMessage(msg, depth, agentFromAuth(req.headers.authorization), deps);
    if (answer) out.push(answer);
  }
  if (!out.length) {
    res.writeHead(202).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(batch ? out : out[0]));
}

/** The MCP server entry a launch hands to an agent, for this launch only. */
export function mcpEndpoint(port: number, token: string, depth: number): { url: string; headers: Record<string, string> } {
  return { url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}`, "x-easyswitch-depth": String(depth) } };
}
