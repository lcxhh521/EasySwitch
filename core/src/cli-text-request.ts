/** Shared, intentionally narrow input contract for text-only official CLI bridges. */
import { decodeRequest } from "./inbound.ts";
import { ProtocolError, type InboundRequest } from "./protocol.ts";

export function cliTextRequest(input: InboundRequest): { prompt: string; dropped: string[]; maxTokens?: number } {
  if (Array.isArray(input.body.tools) && input.body.tools.length) throw new ProtocolError("这个 CLI 来源仅支持纯文字，不能接收工具定义。", 400);
  // The general decoder accepts legacy Chat fields and Gemini system parts permissively.
  // A no-tools text bridge must not silently discard these richer inputs.
  if (input.protocol === "chat" && (input.body.functions?.length || input.body.function_call || input.body.messages?.some((m: Record<string, unknown>) => m.role === "function" || m.function_call || m.audio))) throw new ProtocolError("这个 CLI 来源不接受旧版工具调用或音频历史。", 400);
  const system = input.body.systemInstruction ?? input.body.system_instruction;
  if (input.protocol === "gemini" && system?.parts?.some((p: Record<string, unknown>) => typeof p.text !== "string" || Object.keys(p).some(k => k !== "text"))) throw new ProtocolError("这个 CLI 来源的系统指令只能包含纯文字。", 400);
  const conversation = decodeRequest(input);
  if (conversation.tools.length || (conversation.choice && conversation.choice !== "none" && conversation.choice !== "auto")) throw new ProtocolError("这个 CLI 来源仅支持纯文字；不能接收工具定义或强制工具调用。", 400);
  if (conversation.turns.some(t => t.parts.some(p => p.type !== "text" || typeof p.text !== "string"))) throw new ProtocolError("这个 CLI 来源不能接收图像、工具历史或不透明推理状态。", 400);
  if (conversation.maxTokens !== undefined && (!Number.isSafeInteger(conversation.maxTokens) || conversation.maxTokens < 1)) throw new ProtocolError("CLI 输出 token 上限必须是正整数。", 400);
  if (!conversation.turns.length || !conversation.turns.some(t => t.role === "user")) throw new ProtocolError("纯文字 CLI 请求需要用户消息。", 400);
  const turns = conversation.turns.map(t => ({ role: t.role, content: t.parts.map(p => p.type === "text" ? p.text : "").join("\n") }));
  // CLI agents own their system prompt. A transcript is explicit rather than pretending that
  // serializing roles into stdin reproduces a model API's system/developer priority semantics.
  const prompt = turns.length === 1 && turns[0]!.role === "user" ? turns[0]!.content : JSON.stringify({ conversation: turns });
  if (Buffer.byteLength(prompt) > 1024 * 1024) throw new ProtocolError("CLI 输入超过 1 MiB 限制。", 413);
  const dropped = [...conversation.dropped];
  if (turns.length !== 1 || turns[0]!.role !== "user") dropped.push("roles:cli_text_transcript");
  if (input.stream) dropped.push("stream:buffered_cli_result");
  if (input.effort || conversation.effort) dropped.push("effort:cli_text_bridge");
  for (const [field, value] of [["temperature", conversation.temperature], ["top_p", conversation.topP], ["stop", conversation.stop], ["response_format", conversation.format]] as const) if (value !== undefined) dropped.push(`${field}:cli_text_bridge`);
  return { prompt, dropped, ...(conversation.maxTokens ? { maxTokens: conversation.maxTokens } : {}) };
}
