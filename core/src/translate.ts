/** Chat wire types retained for native Chat adapters and provider-specific shaping. */

type Json = Record<string, unknown>;

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  stream_options?: { include_usage: boolean };
  tools?: Json[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
}
