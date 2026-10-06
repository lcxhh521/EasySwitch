/** Bounded diagnostics for translated errors. Never echo arbitrary upstream content. */
const MAX_BYTES = 4096;
const DEADLINE_MS = 250;
const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/context[_ -]?(?:length|window)|prompt.{0,24}(?:too long|too large)|maximum.{0,20}context|input.{0,20}too (?:long|large)/i, "input exceeds the upstream context limit"],
  [/model[_ -]?(?:not[_ -]?found|unavailable)|unknown model|model.{0,40}(?:does not exist|not found|not available)/i, "upstream model is unavailable"],
  [/invalid[_ -]?(?:api[_ -]?)?key|authentication|unauthori[sz]ed|invalid.{0,12}(?:credential|token)/i, "upstream authentication failed"],
  [/permission|forbidden|access denied|not allowed/i, "upstream permission denied"],
  [/rate[_ -]?limit|quota|insufficient.{0,12}(?:credit|balance)|too many requests/i, "upstream quota or rate limit reached"],
  [/content[_ -]?(?:filter|policy)|safety|moderation/i, "upstream content policy rejected the request"],
  [/unsupported.{0,24}(?:parameter|field|tool)|unknown.{0,24}(?:parameter|field)|invalid.{0,24}(?:parameter|request)/i, "upstream rejected a request field"],
];

export async function boundedUpstreamErrorText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), DEADLINE_MS); });
  try {
    while (bytes < MAX_BYTES) {
      const next = await Promise.race([reader.read(), deadline]);
      if (!next || next.done) break;
      const part = next.value.subarray(0, MAX_BYTES - bytes);
      chunks.push(part); bytes += part.byteLength;
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } catch { return ""; }
  finally {
    clearTimeout(timer);
    // A stalled source may never acknowledge cancellation. Do not await it or a tee branch.
    void reader.cancel().catch(() => undefined);
    try { reader.releaseLock(); } catch { /* A timed-out read can still be pending. */ }
  }
}

export async function safeUpstreamReason(response: Response): Promise<string> {
  const text = await boundedUpstreamErrorText(response);
    let candidate = text;
    try {
      const body: unknown = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body)) return "";
      const value = body as Record<string, unknown>;
      const error = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : value;
      candidate = [error.code, error.type, error.message].filter(v => typeof v === "string").join(" ");
    } catch { /* Bounded plain-text errors may still have a recognizable error class. */ }
    // Only constant descriptions cross this boundary: JWTs, opaque Bearers, API keys,
    // prompts and vendor identifiers can never be returned, regardless of their shape.
    return REASONS.find(([pattern]) => pattern.test(candidate))?.[1] ?? "";
}
