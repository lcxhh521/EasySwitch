import type { IncomingMessage, ServerResponse } from "node:http";
import { estimateTokens } from "./anthropic.ts";
import { resolveModel, type GatewayDeps } from "./gateway.ts";
import { fromClaudeModelId } from "./catalog.ts";
import { forwardNative, isNativeClaude } from "./claude-native.ts";
import { agentOfHeaders } from "./gateway-chat.ts";
import { parseRequest, routeRequest } from "./gateway-route.ts";
import type { Json } from "./protocol.ts";

export async function handleCountTokens(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: GatewayDeps): Promise<void> {
  let body: Json = {};
  try { body = JSON.parse(rawBody) as Json; } catch { /* estimate from nothing */ }
  const asked = String(body.model ?? "");
  if (isNativeClaude(asked) && !resolveModel(deps.store, fromClaudeModelId(asked) ?? asked)) {
    await forwardNative(req, res, req.url ?? "/v1/messages/count_tokens", rawBody, asked, () => {});
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ input_tokens: estimateTokens(body) }));
}

export async function handleMessages(req: IncomingMessage, res: ServerResponse, rawBody: string, deps: GatewayDeps): Promise<void> {
  const body = parseRequest(res, "messages", rawBody);
  if (!body) return;
  const asked = String(body.model ?? "");
  const exposed = fromClaudeModelId(asked) ?? asked;
  if (!resolveModel(deps.store, exposed) && isNativeClaude(asked)) {
    await forwardNative(req, res, req.url ?? "/v1/messages", rawBody, asked, deps.log); return;
  }
  const headers: Record<string, string> = {};
  for (const name of ["anthropic-version", "anthropic-beta"]) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
  await routeRequest(req, res, { protocol: "messages", body, model: exposed, stream: body.stream === true, headers }, agentOfHeaders(req.headers, "claude"), deps);
}
