import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayDeps } from "./gateway.ts";
import { parseRequest, routeRequest } from "./gateway-route.ts";
import { agentFromAuth } from "./agent-identity.ts";
export { agentFromAuth } from "./agent-identity.ts";

export function agentOf(header: string | string[] | undefined, fallback: string): string {
  const id = agentFromAuth(header);
  return id === "chat" ? fallback : id;
}

/** An unrelated vendor auth header must not hide an EasySwitch per-launch identity. */
export function agentOfHeaders(headers: IncomingMessage["headers"], fallback: string): string {
  for (const name of ["x-easyswitch-session", "authorization", "x-api-key", "x-goog-api-key"]) {
    const id = agentFromAuth(headers[name]);
    if (id !== "chat") return id;
  }
  return fallback;
}

export async function handleChatCompletions(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: GatewayDeps): Promise<void> {
  const body = parseRequest(res, "chat", rawBody);
  if (body) await routeRequest(req, res, { protocol: "chat", body, model: String(body.model ?? ""), stream: body.stream === true }, agentOfHeaders(req.headers, "chat"), deps);
}

/** Issuance-based credentials; the readable label is only routing metadata. */
export { sessionToken } from "./gateway-auth.ts";
