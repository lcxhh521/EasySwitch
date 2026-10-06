import type { IncomingMessage, ServerResponse } from "node:http";
import { agentOfHeaders } from "./gateway-chat.ts";
import type { GatewayDeps } from "./gateway.ts";
import { parseRequest, routeRequest } from "./gateway-route.ts";
import type { Json } from "./protocol.ts";

export const GEMINI_PATH = /^\/(v1beta|v1)\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;

export function listGeminiModels(deps: GatewayDeps): Json {
  return {
    models: deps.store.catalog().map(m => ({
      name: `models/${m.providerId}/${m.model}`,
      displayName: m.model,
      description: `${m.providerName} · 经 EasySwitch`,
      supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
    })),
  };
}

/** A rough token count for countTokens; coding agents only use it to budget context. */
function estimate(body: Json): number {
  return Math.ceil(JSON.stringify(body.contents ?? []).length / 4);
}

export async function handleGemini(req: IncomingMessage, res: ServerResponse, match: RegExpExecArray, rawBody: string, deps: GatewayDeps): Promise<void> {
  const exposed = decodeURIComponent(match[2] ?? "").replace(/^models\//, "");
  const body = parseRequest(res, "gemini", rawBody);
  if (!body) return;
  if (match[3] === "countTokens") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ totalTokens: estimate(body.generateContentRequest ?? body) })); return;
  }
  await routeRequest(req, res, { protocol: "gemini", body, model: exposed, stream: match[3] === "streamGenerateContent" }, agentOfHeaders(req.headers, "gemini-cli"), deps);
}
