import { join } from "node:path";
import { chatToResponses, responsesToChatResponse, shapePlanRequest } from "./responses-upstream.ts";
import { planTarget } from "./siwc.ts";
import { mimoChatUrl, mimoHeaders, mimoJwt, withMimoMarker } from "./mimo-free.ts";
import { dataDir } from "./paths.ts";
import type { ChatRequest } from "./translate.ts";
import type { Provider } from "./types.ts";
import { endpointUrl, upstreamHeaders } from "./upstream.ts";
import { sendAntigravity } from "./antigravity.ts";
import { sendCursor } from "./cursor/adapter.ts";
import { sendKiro } from "./kiro.ts";
import { isUsageLimit, recordLimitReached, recordQuotaHeaders } from "./quota.ts";

const mimoStateDir = (): string => join(dataDir(), "mimo");

/**
 * The one place a Chat Completions request leaves for its provider. For almost every provider that is
 * `POST <base>/chat/completions`. A provider that is a ChatGPT plan only has the Responses API, so
 * the request is turned into a Responses request and the event stream that comes back into Chat
 * chunks; the handlers above never need to know the difference.
 */
export async function sendChat(provider: Provider, apiKey: string | undefined, payload: unknown, signal: AbortSignal): Promise<Response | Error> {
  const chat = payload as ChatRequest;
  if (provider.kiro) return sendKiro(provider, chat, signal);
  if (provider.antigravity) return sendAntigravity(provider, apiKey, chat, signal);
  if (provider.cursor) return sendCursor(provider, apiKey, chat, signal);
  if (provider.mimoFree) {
    // The free tier wants its own marker and a bootstrapped JWT instead of a stored key.
    let jwt: string;
    try {
      jwt = await mimoJwt(mimoStateDir());
    } catch (error) {
      return new Response(JSON.stringify({ error: { message: `MiMo Free bootstrap failed: ${(error as Error).message}`, type: "api_error" } }), { status: 502, headers: { "content-type": "application/json" } });
    }
    return fetch(mimoChatUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", accept: chat.stream ? "text/event-stream" : "application/json", ...mimoHeaders(jwt) },
      body: JSON.stringify(withMimoMarker(payload)),
      signal,
    }).catch((error: Error) => error);
  }
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
    }).then(upstream => observePlan(provider.id, upstream)).then(upstream => (upstream.ok ? responsesToChatResponse(upstream, { stream: chat.stream, model: chat.model }) : upstream)).catch((error: Error) => error);
  }
  return fetch(endpointUrl(provider, "chat"), {
    method: "POST",
    headers: { "content-type": "application/json", accept: chat.stream ? "text/event-stream" : "application/json", ...upstreamHeaders(provider, apiKey) },
    body: JSON.stringify(payload),
    signal,
  }).catch((error: Error) => error);
}

/**
 * What a plan's answer says about its quota is remembered (see quota.ts): the usage headers on every
 * answer, and a "used up" refusal, which marks the plan as unavailable until it is back. The answer
 * itself passes on untouched.
 */
async function observePlan(providerId: string, upstream: Response): Promise<Response> {
  recordQuotaHeaders(providerId, upstream.headers);
  if (upstream.status === 429) {
    const text = await upstream.clone().text().catch(() => "");
    if (isUsageLimit(429, text)) recordLimitReached(providerId);
  }
  return upstream;
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
    }).then(upstream => observePlan(provider.id, upstream)).catch((error: Error) => error);
  }
  return fetch(endpointUrl(provider, "responses"), {
    method: "POST",
    headers: { "content-type": "application/json", accept, ...upstreamHeaders(provider, apiKey) },
    body: JSON.stringify(body),
    signal,
  }).catch((error: Error) => error);
}
