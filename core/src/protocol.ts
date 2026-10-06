import type { ApiProtocol } from "./types.ts";

export type Json = Record<string, any>;

/** Original input survives until the chosen source decides whether conversion is needed. */
export interface InboundRequest {
  protocol: ApiProtocol;
  body: Json;
  model: string;
  stream: boolean;
  effort?: string;
  headers?: Record<string, string>;
  source?: string;
}

export type Part =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "call"; id: string; name: string; arguments: string }
  | { type: "result"; id: string; name?: string; content: unknown; error?: boolean }
  | { type: "reasoning"; text?: string; signature?: string; encrypted?: string; protocol: ApiProtocol }
  | { type: "native"; protocol: ApiProtocol; value: Json };

export interface Turn { role: "system" | "developer" | "user" | "assistant"; parts: Part[] }
export interface Tool { name: string; description: string; parameters: Json; namespace?: string; bareName?: string; custom?: boolean }
export interface Conversation {
  turns: Turn[]; tools: Tool[];
  choice?: "auto" | "none" | "required" | { name: string };
  maxTokens?: number; temperature?: number; topP?: number; stop?: string[];
  effort?: string; parallelTools?: boolean; format?: Json;
  dropped: string[];
}
export interface Usage { input: number; output: number; cached?: number; cacheWrite?: number; reasoning?: number }
export type Stop = "stop" | "tool" | "length" | "filter";
export const OUTPUT_LIMITS = { frameBytes: 2 * 1024 * 1024, responseBytes: 32 * 1024 * 1024, items: 4096, toolHeaderBytes: 64 * 1024 } as const;
export type OutputKind = "text" | "reasoning" | "call";
export type OutputEvent =
  | { type: "text"; text: string; index?: number }
  | { type: "reasoning"; text?: string; signature?: string; encrypted?: string; redacted?: boolean; index?: number }
  | { type: "call"; index: number; id: string; name: string; arguments: string }
  | { type: "arguments"; index: number; text: string }
  /** Explicit source block completion; metadata/signatures precede this event. */
  | { type: "block_end"; kind: OutputKind; index: number }
  | { type: "usage"; usage: Usage }
  | { type: "stop"; reason: Stop };

export class ProtocolError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Opaque continuation data travels back through the caller, bound to its original source/model. */
const STATE_PREFIX = "es-state:";
export function packState(source: string, model: string, value: Json): string {
  return STATE_PREFIX + Buffer.from(JSON.stringify({ source, model, value })).toString("base64url");
}
export function unpackState(value: string | undefined, source: string, model: string): Json | undefined {
  if (!value?.startsWith(STATE_PREFIX)) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(STATE_PREFIX.length), "base64url").toString());
    return decoded.source === source && decoded.model === model ? decoded.value : undefined;
  } catch { return undefined; }
}
