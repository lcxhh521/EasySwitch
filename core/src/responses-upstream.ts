/** Compatibility shaping for the selected native ChatGPT-plan Responses transport. */

type Json = Record<string, unknown>;

/** Fields this upstream rejects (from OpenAI's preview limitations for ChatGPT plan use). */
const UNSUPPORTED_FIELDS = [
  "background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt",
  "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id",
];
/** Tools it does not run (it runs function and custom tools, and web search subject to policy). */
const UNSUPPORTED_TOOLS = new Set(["image_generation", "file_search", "code_interpreter", "computer_use", "computer_use_preview", "mcp", "tool_search"]);

/** A request meant for the Responses API, made acceptable to the ChatGPT plan route. */
export function shapePlanRequest(body: Json): { body: Json; dropped: string[] } {
  const out: Json = { ...body };
  const dropped: string[] = [];
  for (const field of UNSUPPORTED_FIELDS) {
    if (field in out) { delete out[field]; dropped.push(field); }
  }
  out.store = false;
  out.stream = true;
  if (Array.isArray(out.tools)) {
    out.tools = (out.tools as Json[]).filter(t => {
      const bad = UNSUPPORTED_TOOLS.has(String(t.type));
      if (bad) dropped.push(`tool:${String(t.type)}`);
      return !bad;
    });
  }
  // Explicit system items are refused; developer is the same thing in this API.
  if (Array.isArray(out.input)) {
    out.input = (out.input as Json[]).map(item => (item.type === "message" || item.type === undefined) && item.role === "system" ? { ...item, role: "developer" } : item);
  }
  return { body: out, dropped };
}
