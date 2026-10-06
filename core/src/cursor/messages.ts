import { createHash, randomUUID } from "node:crypto";
import { bytesOf, readFields, stringOf, uintOf, Writer, type Field } from "./proto.ts";

/**
 * The messages of one text-only turn with Cursor's agent service (package agent.v1), with the field numbers used.
 *
 * Client -> server (AgentClientMessage): run_request=1, exec_client_message=2, kv_client_message=3, client_heartbeat=7.
 * Server -> client (AgentServerMessage): interaction_update=1, exec_server_message=2, conversation_checkpoint_update=3,
 * kv_server_message=4, interaction_query=7. The facts come from reading opencodex's Cursor adapter (MIT); the encoding
 * here is our own and covers only what a turn without tools needs.
 */

export interface TurnInput {
  system: string;
  /** Earlier turns of the conversation, oldest first. */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** The message to answer now. */
  user: string;
  modelId: string;
  conversationId?: string;
}

export interface Prepared {
  /** The first frame's payload: an AgentClientMessage holding the run request. */
  first: Buffer;
  /** Blobs the server may ask for during the turn, by hex id (the SHA-256 of the content). */
  blobs: Map<string, Buffer>;
}

/** Each blob is JSON, and the conversation refers to it by the SHA-256 of its content. */
function blob(blobs: Map<string, Buffer>, json: unknown): Buffer {
  const content = Buffer.from(JSON.stringify(json), "utf8");
  const id = createHash("sha256").update(content).digest();
  blobs.set(id.toString("hex"), content);
  return id;
}

const parts = (text: string) => [{ type: "text", text }];

export function encodeRun(input: TurnInput): Prepared {
  const blobs = new Map<string, Buffer>();
  const state = new Writer();
  // Cursor builds the model's prompt from the root messages, so the whole history goes there.
  state.bytes(1, blob(blobs, { role: "system", content: input.system || "You are a helpful assistant." }));
  for (const m of input.history) state.bytes(1, blob(blobs, { role: m.role, content: parts(m.text) }));

  const userMessage = new Writer().string(1, input.user).string(2, randomUUID()).uint(4, 1);
  const env = new Writer().string(10, Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const action = new Writer().message(1, new Writer().message(1, userMessage).message(2, new Writer().message(4, env)));
  const model = new Writer().string(1, input.modelId).string(3, input.modelId).string(4, input.modelId).string(5, input.modelId);

  const run = new Writer()
    .message(1, state)
    .message(2, action)
    .message(3, model)
    // An empty tool list: without it Cursor adds its own native tools (ten thousand tokens or more).
    .message(4, new Writer())
    .string(5, input.conversationId ?? `cursor_${randomUUID().replace(/-/g, "")}`);
  return { first: new Writer().message(1, run).finish(), blobs };
}

export const heartbeat = (): Buffer => new Writer().message(7, new Writer()).finish();

export function kvGetReply(id: number, data: Buffer | undefined): Buffer {
  return new Writer().message(3, new Writer().uint(1, id).message(2, new Writer().bytes(1, data ?? Buffer.alloc(0)))).finish();
}

export function kvSetReply(id: number): Buffer {
  return new Writer().message(3, new Writer().uint(1, id).message(3, new Writer())).finish();
}

/** An answer to the server's request for the client's context: an empty one (no tools, no files). */
export function requestContextReply(id: number, execId: string | undefined): Buffer {
  const result = new Writer().message(1, new Writer().message(1, new Writer()));
  const exec = new Writer().uint(1, id);
  if (execId !== undefined) exec.string(15, execId);
  return new Writer().message(2, exec.message(10, result)).finish();
}

export type ServerEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tokens"; count: number }
  | { kind: "checkpoint"; used: number; max: number }
  | { kind: "turnEnded" }
  | { kind: "kvGet"; id: number; blobId: string }
  | { kind: "kvSet"; id: number; blobId: string; data: Buffer }
  | { kind: "requestContext"; id: number; execId: string | undefined }
  | { kind: "needsTool" }
  | { kind: "needsAnswer" }
  | { kind: "ignored" };

const IGNORED: ServerEvent = { kind: "ignored" };

/** One AgentServerMessage as an event. Anything not needed for a text turn is "ignored". */
export function decodeServer(payload: Uint8Array): ServerEvent {
  const top = readFields(payload);
  const update = bytesOf(top, 1);
  if (update) return decodeUpdate(readFields(update));
  const checkpoint = bytesOf(top, 3);
  if (checkpoint) {
    const details = bytesOf(readFields(checkpoint), 5);
    if (!details) return IGNORED;
    const d = readFields(details);
    return { kind: "checkpoint", used: uintOf(d, 1) ?? 0, max: uintOf(d, 2) ?? 0 };
  }
  const kv = bytesOf(top, 4);
  if (kv) {
    const k = readFields(kv);
    const id = uintOf(k, 1) ?? 0;
    const get = bytesOf(k, 2);
    if (get) return { kind: "kvGet", id, blobId: Buffer.from(bytesOf(readFields(get), 1) ?? Buffer.alloc(0)).toString("hex") };
    const set = bytesOf(k, 3);
    if (set) { const s = readFields(set); return { kind: "kvSet", id, blobId: (bytesOf(s, 1) ?? Buffer.alloc(0)).toString("hex"), data: bytesOf(s, 2) ?? Buffer.alloc(0) }; }
    return IGNORED;
  }
  const exec = bytesOf(top, 2);
  if (exec) {
    const e = readFields(exec);
    if (bytesOf(e, 10) !== undefined) return { kind: "requestContext", id: uintOf(e, 1) ?? 0, execId: stringOf(e, 15) };
    return { kind: "needsTool" };
  }
  if (bytesOf(top, 7) !== undefined) return { kind: "needsAnswer" };
  return IGNORED;
}

function decodeUpdate(fields: Field[]): ServerEvent {
  const text = bytesOf(fields, 1);
  if (text) return { kind: "text", text: stringOf(readFields(text), 1) ?? "" };
  const thinking = bytesOf(fields, 4);
  if (thinking) return { kind: "thinking", text: stringOf(readFields(thinking), 1) ?? "" };
  const tokens = bytesOf(fields, 8);
  if (tokens) return { kind: "tokens", count: uintOf(readFields(tokens), 1) ?? 0 };
  if (bytesOf(fields, 14) !== undefined) return { kind: "turnEnded" };
  // tool_call_started=2, tool_call_completed=3, partial_tool_call=7, tool_call_delta=15
  if ([2, 3, 7, 15].some(f => bytesOf(fields, f) !== undefined)) return { kind: "needsTool" };
  return IGNORED;
}
