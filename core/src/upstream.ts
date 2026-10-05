/** Minimal HTTP helpers for talking to an OpenAI-compatible provider. */

import type { Provider, WireConfig } from "./types.ts";

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function authHeaders(apiKey: string | undefined, wire?: WireConfig): Record<string, string> {
  if (!apiKey) return {};
  const name = (wire?.authHeader ?? "authorization").toLowerCase();
  return { [name]: wire?.authScheme === "raw" ? apiKey : `Bearer ${apiKey}` };
}

/** Everything a provider sends on each call besides the body: its key header and its fixed extras. */
export function upstreamHeaders(provider: Pick<Provider, "wire">, apiKey: string | undefined): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(provider.wire?.headers ?? {})) extra[k.toLowerCase()] = v;
  return { ...extra, ...authHeaders(apiKey, provider.wire) };
}

/** Thrown when an address still contains a `{placeholder}` the user has not filled in. */
export class UnresolvedPlaceholder extends Error {
  readonly names: string[];
  constructor(names: string[]) {
    super(`地址里还有没填的部分：${names.join("、")}`);
    this.names = names;
  }
}

/** Replaces `{name}` with the user's values; refuses to guess when one is missing. */
export function expandUrl(url: string, params?: Record<string, string>): string {
  const missing: string[] = [];
  const out = url.replace(/\{([A-Za-z0-9_-]+)\}/g, (_, name: string) => {
    const value = params?.[name]?.trim();
    if (!value) missing.push(name);
    return value ? encodeURIComponent(value) : "";
  });
  if (missing.length) throw new UnresolvedPlaceholder([...new Set(missing)]);
  return out;
}

export type CallKind = "chat" | "responses" | "messages" | "gemini" | "models";

const DEFAULT_PATH: Record<CallKind, string> = {
  chat: "chat/completions", responses: "responses", messages: "messages", gemini: "models", models: "models",
};

/** The full URL for one kind of call, with placeholders filled and extra query parameters added. */
export function endpointUrl(provider: Pick<Provider, "baseUrl" | "anthropicBaseUrl" | "urlParams" | "wire">, kind: CallKind, model?: string, stream = false): string {
  const base = expandUrl(kind === "messages" ? provider.anthropicBaseUrl ?? provider.baseUrl : provider.baseUrl, provider.urlParams);
  const path = provider.wire?.paths?.[kind] ?? DEFAULT_PATH[kind];
  // A base that already names the chat endpoint (some relays) must not get it twice.
  const trimmed = kind === "chat" ? base.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") : base;
  // An explicitly empty path override means "the base address is the whole endpoint".
  if (provider.wire?.paths?.[kind] === "") return trimmed;
  const url = new URL(joinUrl(trimmed, path));
  if (kind === "gemini") {
    url.pathname = url.pathname.replace(/\/$/, "") + "/" + encodeURIComponent(model ?? "") + (stream ? ":streamGenerateContent" : ":generateContent");
    if (stream) url.searchParams.set("alt", "sse");
  }
  for (const [k, v] of Object.entries(provider.wire?.query ?? {})) url.searchParams.set(k, v);
  return url.toString();
}

export interface TimedResponse {
  response: Response;
  ms: number;
}

export async function timedFetch(url: string, init: RequestInit, timeoutMs = 30_000): Promise<TimedResponse> {
  const started = performance.now();
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  return { response, ms: Math.round(performance.now() - started) };
}

/** A short, secret-free description of a failed upstream response. */
export async function describeFailure(response: Response): Promise<string> {
  let text = "";
  try {
    text = (await response.text()).slice(0, 300);
  } catch {
    // Body unreadable; the status alone has to do.
  }
  return `HTTP ${response.status}${text ? `: ${text.replace(/\s+/g, " ")}` : ""}`;
}

/**
 * Parse an SSE byte stream into `data:` payloads. Tolerates `data:` without
 * a space and CRLF line endings, which several relays emit.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "");
      const data = block
        .split(/\r?\n/)
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) yield data;
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) yield tail.slice(5).replace(/^ /, "");
}
