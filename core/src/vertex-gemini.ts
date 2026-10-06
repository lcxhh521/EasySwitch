/**
 * Google Vertex Gemini adapter, implemented from official protocol documentation (2026-10-06).
 * See docs/vertex.md. No SDK, gcloud process, credential file, metadata server, or OAuth discovery.
 * Credentials are supplied by the caller's existing secret store, never embedded in configuration.
 */
import type { Provider } from "./types.ts";
import type { PreparedOutbound } from "./outbound.ts";
import { decodeRequest } from "./inbound.ts";
import { encodeRequest, restoreNativeState } from "./outbound-format.ts";
import { ProtocolError, type InboundRequest } from "./protocol.ts";
import { readOutput } from "./upstream-events.ts";
import { upstreamModelId } from "./quirks.ts";

import { vertexConfigIssue, vertexKind, type VertexGeminiConfig } from "./vertex-config.ts";
export { vertexConfigIssue, type VertexConfig } from "./vertex-config.ts";

/** Fixed Google hosts only; provider.baseUrl and wire overrides are deliberately not consulted. */
export function vertexEndpoint(config: VertexGeminiConfig, model: string, stream = false): string {
  const issue = vertexConfigIssue(config);
  if (issue) throw new ProtocolError(issue, 400);
  const kind = vertexKind(config);
  if (kind !== "standard" && kind !== "express") throw new ProtocolError("服务账号模式使用 Vertex Chat 出口。", 400);
  const normalized = upstreamModelId(model);
  // Publisher-scoped Claude/Grok/Model Garden models use other APIs and are not Gemini aliases.
  if (!/^gemini-[a-z0-9][a-z0-9._-]{0,126}$/i.test(normalized)) throw new ProtocolError("这个 Vertex 适配器仅支持 Google Gemini 模型 ID；合作伙伴模型需要各自的协议适配器。", 400);
  const host = config.mode === "standard" && config.location !== "global" ? `${config.location}-aiplatform.googleapis.com` : "aiplatform.googleapis.com";
  const scope = config.mode === "standard" ? `projects/${config.project}/locations/${config.location}/` : "";
  return `https://${host}/v1/${scope}publishers/google/models/${encodeURIComponent(normalized)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
}

/** Tests inject an in-memory fetcher; production always uses the standard fetch implementation. */
export function prepareVertex(provider: Provider, input: InboundRequest, fetcher: typeof fetch = fetch): PreparedOutbound {
  const issue = vertexConfigIssue(provider.vertex);
  if (issue) throw new ProtocolError(issue, 400);
  // Snapshot validated routing to prevent mutation between preparation and sending a credential.
  const kind = vertexKind(provider.vertex);
  if (kind !== "standard" && kind !== "express") throw new ProtocolError("服务账号模式使用 Vertex Chat 出口，不能改成手动令牌或 Express。", 400);
  const config = structuredClone(provider.vertex!) as VertexGeminiConfig;
  const request = { ...input, source: provider.id, model: upstreamModelId(input.model) };
  const url = vertexEndpoint(config, request.model, request.stream);
  const conversation = input.protocol === "gemini" ? undefined : decodeRequest(request);
  const body = conversation ? encodeRequest(conversation, request, "gemini") : structuredClone(input.body);
  const dropped = conversation?.dropped ?? [];
  if (!conversation) restoreNativeState(body, request, dropped);
  delete body.model; delete body.stream;
  if (request.effort) body.generationConfig = { ...body.generationConfig, thinkingConfig: { ...body.generationConfig?.thinkingConfig, thinkingLevel: request.effort.toUpperCase() } };
  return {
    adapter: `vertex-${config.mode}`, protocol: "gemini", passthrough: input.protocol === "gemini",
    tools: conversation?.tools ?? [], dropped,
    events: response => readOutput(response, "gemini"),
    async send(key, signal) {
      try {
        signal.throwIfAborted();
        if (!key || /[\r\n]/.test(key)) throw new ProtocolError(config.mode === "standard" ? "Vertex 需要用户提供的有效短期访问令牌；不会读取或刷新原生登录。" : "Vertex Express 需要用户提供的 Google Cloud API Key。", 401);
        const auth: Record<string, string> = config.auth === "access-token" ? { authorization: `Bearer ${key}` } : { "x-goog-api-key": key };
        return await fetcher(url, {
          method: "POST", redirect: "error", signal,
          headers: { "content-type": "application/json", accept: request.stream ? "text/event-stream" : "application/json", ...auth },
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (error instanceof ProtocolError) return error;
        // A transport error can embed the URL or credential; return a bounded secret-free reason.
        return new Error(signal.aborted ? "Vertex 请求已取消。" : "Vertex 请求失败；请检查来源配置、网络和凭据有效期。");
      }
    },
  };
}
