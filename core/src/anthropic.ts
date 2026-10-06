/** Local estimate used only by the Messages count_tokens gateway; no legacy conversion path. */
type Json = Record<string, unknown>;

export function estimateTokens(body: Json): number {
  return Math.ceil(JSON.stringify({ s: body.system, m: body.messages, t: body.tools }).length / 3.5);
}
