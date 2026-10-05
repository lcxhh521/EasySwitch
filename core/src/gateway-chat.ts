import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayDeps } from "./gateway.ts";
import { parseRequest, routeRequest } from "./gateway-route.ts";

export function agentOf(header: string | string[] | undefined, fallback: string): string {
  const id = agentFromAuth(header);
  return id === "chat" ? fallback : id;
}

export function agentFromAuth(header: string | string[] | undefined): string {
  const token = String(Array.isArray(header) ? header[0] : header ?? "").replace(/^Bearer\s+/i, "");
  const id = /^es-session-([a-z0-9]+)-/.exec(token)?.[1];
  // The older Claude Code token has no agent in it, only a UUID: that is not an agent id.
  return id && !/^[0-9a-f]{8}$/.test(id) ? id : "chat";
}

export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: GatewayDeps): Promise<void> {
  const body = parseRequest(res, "chat", rawBody);
  if (body) await routeRequest(req, res, { protocol: "chat", body, model: String(body.model ?? ""), stream: body.stream === true }, agentFromAuth(req.headers.authorization), deps);
}

/** A fresh per-launch gateway token for an agent: the agent id rides in it so the ledger can tell who called. */
export function sessionToken(agentId: string): string {
  return `es-session-${agentId.replace(/[^a-z0-9]/g, "")}-${randomUUID()}`;
}
