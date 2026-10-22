import { createHash } from "node:crypto";
import { ProtocolError } from "./protocol.ts";

/** Scope-local proofs only. Never persist raw tool arguments or dialogue here. */
export interface AutomaticToolCall { id: string; name: string; argumentsHash: string }
export interface AutomaticToolRequest {
  body: Record<string, unknown>; model: string; stream: boolean;
  toolNames: ReadonlySet<string>; outputToolNames: ReadonlySet<string>;
  requireToolCall: boolean; allowParallelToolCalls: boolean;
}
export const AUTOMATIC_TOOL_LIMITS = { requestBytes: 2 * 1024 * 1024, schemaBytes: 64 * 1024, schemasBytes: 256 * 1024, argumentsBytes: 256 * 1024, depth: 24, nodes: 16_384, tools: 128, messages: 4096 } as const;
type ObjectValue = Record<string, unknown>;
const unsupported = "固定工具会话仅支持已验证的普通 Chat function 工具合同；请求格式、工具历史或状态不受支持，请新开会话或选择固定来源。";
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const has = (value: ObjectValue, key: string): boolean => Object.hasOwn(value, key);
const only = (value: ObjectValue, keys: readonly string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const range = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const name = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value) && !value.startsWith("es-state:");
function requireValid(valid: unknown): asserts valid { if (!valid) throw new ProtocolError(unsupported); }
function text(value: unknown): boolean {
  return typeof value === "string" || (Array.isArray(value) && value.length > 0 && value.length <= AUTOMATIC_TOOL_LIMITS.messages && value.every(part => object(part) && only(part, ["type", "text"]) && part.type === "text" && typeof part.text === "string"));
}

/** Canonical JSON is bounded and interpreted as data only, never schema execution. */
function canonical(value: unknown, depth = 0, budget = { nodes: 0 }): string {
  requireValid(depth <= AUTOMATIC_TOOL_LIMITS.depth && ++budget.nodes <= AUTOMATIC_TOOL_LIMITS.nodes);
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { requireValid(Number.isFinite(value)); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1, budget)).join(",")}]`;
  requireValid(object(value));
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1, budget)}`).join(",")}}`;
}

/** Stable for object-key reordering/whitespace, while preserving array order. */
export function hashToolArguments(raw: string): string {
  requireValid(typeof raw === "string" && Buffer.byteLength(raw) <= AUTOMATIC_TOOL_LIMITS.argumentsBytes);
  // Validate grammar first, but do not hash JSON.parse's rounded numbers:
  // 9007199254740992 and 9007199254740993 are not the same tool arguments.
  try { JSON.parse(raw); } catch { throw new ProtocolError(unsupported); }
  let cursor = 0; let nodes = 0;
  const whitespace = (): void => { while (/[\x20\x09\x0a\x0d]/.test(raw[cursor] ?? "x")) cursor++; };
  function stringToken(): string {
    requireValid(raw[cursor] === '"'); const start = cursor++;
    while (cursor < raw.length) {
      const character = raw[cursor++];
      if (character === "\\") cursor++;
      else if (character === '"') return JSON.parse(raw.slice(start, cursor)) as string;
    }
    throw new ProtocolError(unsupported);
  }
  function item(depth: number): string {
    requireValid(depth <= AUTOMATIC_TOOL_LIMITS.depth && ++nodes <= AUTOMATIC_TOOL_LIMITS.nodes);
    whitespace(); const character = raw[cursor];
    if (character === '"') return JSON.stringify(stringToken());
    if (character === "{") {
      cursor++; whitespace(); const entries = new Map<string, string>();
      if (raw[cursor] !== "}") while (true) {
        whitespace(); const key = stringToken(); requireValid(!entries.has(key)); whitespace(); requireValid(raw[cursor++] === ":");
        entries.set(key, item(depth + 1)); whitespace();
        if (raw[cursor] !== ",") break;
        cursor++;
      }
      requireValid(raw[cursor++] === "}");
      return `{${[...entries.keys()].sort().map(key => `${JSON.stringify(key)}:${entries.get(key)!}`).join(",")}}`;
    }
    if (character === "[") {
      cursor++; whitespace(); const values: string[] = [];
      if (raw[cursor] !== "]") while (true) {
        values.push(item(depth + 1)); whitespace();
        if (raw[cursor] !== ",") break;
        cursor++;
      }
      requireValid(raw[cursor++] === "]"); return `[${values.join(",")}]`;
    }
    for (const literal of ["true", "false", "null"]) if (raw.startsWith(literal, cursor)) { cursor += literal.length; return literal; }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(cursor))?.[0];
    requireValid(number && Number.isFinite(Number(number))); cursor += number.length;
    const [mantissa = "", exponent = "0"] = number.toLowerCase().split("e");
    const negative = mantissa.startsWith("-"); const unsigned = negative ? mantissa.slice(1) : mantissa;
    const [whole = "", fraction = ""] = unsigned.split(".");
    let digits = (whole + fraction).replace(/^0+/, "");
    let power = Number(exponent) - fraction.length;
    requireValid(Number.isSafeInteger(power) && Math.abs(power) <= 1_000_000);
    if (!digits) return negative ? "-0" : "0";
    const trimmed = digits.replace(/0+$/, ""); power += digits.length - trimmed.length; digits = trimmed;
    return `${negative ? "-" : ""}${digits}${power ? `e${power}` : ""}`;
  }
  const normalized = item(0); whitespace(); requireValid(cursor === raw.length);
  return createHash("sha256").update(normalized).digest("hex");
}

/** Raw capability gate, independent of decoding, global caches and source selection. */
export function parseAutomaticToolRequest(raw: string, knownCalls: ReadonlyMap<string, AutomaticToolCall>, allowHistory: boolean): AutomaticToolRequest {
  requireValid(typeof raw === "string" && Buffer.byteLength(raw) <= AUTOMATIC_TOOL_LIMITS.requestBytes);
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new ProtocolError(unsupported); }
  requireValid(object(value) && only(value, ["model", "messages", "stream", "tools", "tool_choice", "parallel_tool_calls", "stream_options", "temperature", "top_p", "max_tokens", "max_completion_tokens", "response_format"]));
  requireValid(typeof value.model === "string" && value.model.trim().length > 0 && value.model.length <= 4096);
  requireValid(!has(value, "stream") || typeof value.stream === "boolean");
  requireValid(!has(value, "temperature") || range(value.temperature, 0, 2));
  requireValid(!has(value, "top_p") || range(value.top_p, 0, 1));
  for (const key of ["max_tokens", "max_completion_tokens"]) requireValid(!has(value, key) || integer(value[key]));
  requireValid(!(has(value, "max_tokens") && has(value, "max_completion_tokens")));
  requireValid(!has(value, "response_format") || (object(value.response_format) && only(value.response_format, ["type"]) && value.response_format.type === "text"));
  requireValid(!has(value, "parallel_tool_calls") || typeof value.parallel_tool_calls === "boolean");
  requireValid(!has(value, "stream_options") || (value.stream === true && object(value.stream_options) && only(value.stream_options, ["include_usage"]) && typeof value.stream_options.include_usage === "boolean"));
  const toolNames = new Set<string>(); let schemaBytes = 0;
  if (has(value, "tools")) {
    requireValid(Array.isArray(value.tools) && value.tools.length <= AUTOMATIC_TOOL_LIMITS.tools);
    for (const tool of value.tools) {
      requireValid(object(tool) && only(tool, ["type", "function"]) && tool.type === "function" && object(tool.function));
      const definition = tool.function;
      requireValid(only(definition, ["name", "description", "parameters"]) && name(definition.name) && !toolNames.has(definition.name));
      requireValid(!has(definition, "description") || (typeof definition.description === "string" && Buffer.byteLength(definition.description) <= 16 * 1024));
      if (has(definition, "parameters")) {
        requireValid(object(definition.parameters));
        const bytes = Buffer.byteLength(canonical(definition.parameters)); schemaBytes += bytes;
        requireValid(bytes <= AUTOMATIC_TOOL_LIMITS.schemaBytes && schemaBytes <= AUTOMATIC_TOOL_LIMITS.schemasBytes);
      }
      toolNames.add(definition.name);
    }
  }
  if (has(value, "tool_choice")) {
    const choice = value.tool_choice;
    requireValid(choice === "none" || (toolNames.size > 0 && (choice === "auto" || choice === "required" || (object(choice) && only(choice, ["type", "function"]) && choice.type === "function" && object(choice.function) && only(choice.function, ["name"]) && typeof choice.function.name === "string" && toolNames.has(choice.function.name)))));
  }
  requireValid(Array.isArray(value.messages) && value.messages.length > 0 && value.messages.length <= AUTOMATIC_TOOL_LIMITS.messages);
  const seen = new Set<string>(); const pending = new Set<string>();
  for (const message of value.messages) {
    requireValid(object(message));
    if (message.role === "tool") {
      requireValid(allowHistory && only(message, ["role", "content", "tool_call_id"]) && id(message.tool_call_id) && pending.has(message.tool_call_id) && text(message.content));
      pending.delete(message.tool_call_id); continue;
    }
    requireValid(pending.size === 0 && ["system", "developer", "user", "assistant"].includes(String(message.role)));
    requireValid(only(message, message.role === "assistant" ? ["role", "content", "tool_calls"] : ["role", "content"]));
    if (has(message, "tool_calls")) {
      requireValid(allowHistory && message.role === "assistant" && (message.content === null || !has(message, "content") || text(message.content)) && Array.isArray(message.tool_calls) && message.tool_calls.length > 0 && message.tool_calls.length <= AUTOMATIC_TOOL_LIMITS.tools);
      for (const call of message.tool_calls) {
        requireValid(object(call) && only(call, ["id", "type", "function"]) && id(call.id) && call.type === "function" && object(call.function) && only(call.function, ["name", "arguments"]) && name(call.function.name) && typeof call.function.arguments === "string");
        const proof = knownCalls.get(call.id);
        requireValid(!seen.has(call.id) && proof && proof.id === call.id && proof.name === call.function.name && proof.argumentsHash === hashToolArguments(call.function.arguments));
        seen.add(call.id); pending.add(call.id);
      }
    } else requireValid(text(message.content));
  }
  requireValid(pending.size === 0);
  const outputToolNames = new Set(toolNames);
  if (value.tool_choice === "none") outputToolNames.clear();
  if (object(value.tool_choice)) {
    outputToolNames.clear();
    outputToolNames.add((value.tool_choice.function as ObjectValue).name as string);
  }
  return {
    body: value, model: value.model, stream: value.stream === true, toolNames, outputToolNames,
    requireToolCall: value.tool_choice === "required" || object(value.tool_choice),
    allowParallelToolCalls: value.parallel_tool_calls !== false,
  };
}
