/** Minimal HTTP helpers for talking to an OpenAI-compatible provider. */

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export function authHeaders(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
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
