import { chatToResponses, responsesToChatResponse, shapePlanRequest } from "./responses-upstream.ts";
import { planTarget } from "./siwc.ts";
import type { ChatRequest } from "./translate.ts";
import type { Provider } from "./types.ts";
import { endpointUrl, upstreamHeaders } from "./upstream.ts";

/**
 * The one place a Chat Completions request leaves for its provider. For almost every provider that is
 * `POST <base>/chat/completions`. A provider that is a ChatGPT plan only has the Responses API, so
 * the request is turned into a Responses request and the event stream that comes back into Chat
 * chunks; the handlers above never need to know the difference.
 */
export function sendChat(provider: Provider, apiKey: string | undefined, payload: unknown, signal: AbortSignal): Promise<Response | Error> {
  const chat = payload as ChatRequest;
  if (provider.plan && provider.plan.kind !== "copilot") {
    const { body } = chatToResponses(chat);
    // The Codex backend refuses a request with no instructions.
    if (provider.plan.kind === "codex" && !body.instructions) body.instructions = "You are a helpful assistant.";
    const target = planTarget(provider.plan.kind, apiKey ?? "", "/responses");
    return fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream", ...target.headers },
      body: JSON.stringify(body),
      signal,
    }).then(upstream => (upstream.ok ? responsesToChatResponse(upstream, { stream: chat.stream, model: chat.model }) : upstream)).catch((error: Error) => error);
  }
  return fetch(endpointUrl(provider, "chat"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: chat.stream ? "text/event-stream" : "application/json", ...upstreamHeaders(provider, apiKey) },
    body: JSON.stringify(payload),
    signal,
  }).catch((error: Error) => error);
}

/** A Responses request forwarded as it is, to a provider that speaks Responses (the ChatGPT plan, or a relay). */
export function sendResponses(provider: Provider, apiKey: string | undefined, body: Record<string, unknown>, accept: string, signal: AbortSignal): Promise<Response | Error> {
  if (provider.plan && provider.plan.kind !== "copilot") {
    const shaped = shapePlanRequest(body).body;
    const target = planTarget(provider.plan.kind, apiKey ?? "", "/responses");
    return fetch(target.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept, ...target.headers },
      body: JSON.stringify(shaped),
      signal,
    }).catch((error: Error) => error);
  }
  return fetch(endpointUrl(provider, "responses"), {
    method: "POST",
    headers: { "content-type": "application/json", accept, ...upstreamHeaders(provider, apiKey) },
    body: JSON.stringify(body),
    signal,
  }).catch((error: Error) => error);
}
