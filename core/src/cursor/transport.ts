import { randomUUID } from "node:crypto";
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { encodeFrame, endStreamError, FLAG_COMPRESSED, FLAG_END_STREAM, FrameParser } from "./connect.ts";
import { classify, CursorError, fromHttpStatus } from "./errors.ts";
import { decodeServer, encodeRun, heartbeat, kvGetReply, kvSetReply, requestContextReply, type TurnInput } from "./messages.ts";

/**
 * One turn with Cursor's agent service: a Connect stream over HTTP/2 that stays open, with a first frame carrying the
 * request, a heartbeat every few seconds, and replies to the server's questions (it asks the client for stored
 * conversation pieces, and for the client's context) until the turn ends. Text only: a request for a tool is an error.
 */

export const CURSOR_API = "https://api2.cursor.sh";
// The version the service expects from a client of this kind; it is a label, not a secret.
const CLIENT_VERSION = "cli-2026.07.08-0c04a8a";

export type TurnEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "done"; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } };

export interface TurnOptions {
  baseUrl: string;
  token: string;
  input: TurnInput;
  sessionId?: string;
  signal?: AbortSignal;
  heartbeatMs?: number;
  /** How long to wait for the first frame, and for each one after it. */
  silenceMs?: number;
}

type Item = { ev: TurnEvent } | { error: CursorError } | { end: true };

export async function* runTurn(opts: TurnOptions): AsyncGenerator<TurnEvent> {
  const queue: Item[] = [];
  let wake: (() => void) | undefined;
  const push = (item: Item) => { queue.push(item); wake?.(); };

  const prepared = encodeRun(opts.input);
  const blobs = prepared.blobs;
  const parser = new FrameParser();
  let session: ClientHttp2Session | undefined;
  let stream: ClientHttp2Stream | undefined;
  let outputTokens = 0;
  let checkpoint: { used: number; max: number } | undefined;
  let finished = false;
  let produced = false;
  let httpStatus = 200;
  let errorBody = "";
  let silence: ReturnType<typeof setTimeout> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  const silenceMs = opts.silenceMs ?? 30_000;

  const fail = (error: CursorError) => { if (!finished) { finished = true; push({ error }); } };
  const done = () => {
    if (finished) return;
    finished = true;
    const completion = outputTokens || Math.ceil(0);
    const total = checkpoint?.used ?? (completion + Math.ceil((opts.input.user.length + opts.input.system.length + opts.input.history.reduce((n, m) => n + m.text.length, 0)) / 4));
    push({ ev: { kind: "done", usage: { prompt_tokens: Math.max(0, total - completion), completion_tokens: completion, total_tokens: total } } });
    push({ end: true });
  };
  const armSilence = () => { clearTimeout(silence); silence = setTimeout(() => fail(new CursorError("Cursor 太久没有响应。", 504)), silenceMs); };
  const send = (payload: Buffer) => { if (stream && !stream.destroyed && !stream.closed) stream.write(encodeFrame(payload)); };

  const onFrame = (flags: number, payload: Buffer) => {
    armSilence();
    if (flags & FLAG_COMPRESSED) { fail(new CursorError("Cursor 返回了压缩的数据帧，暂不支持。")); return; }
    if (flags & FLAG_END_STREAM) {
      const error = endStreamError(payload);
      if (error) fail(classify(error)); else done();
      return;
    }
    const event = decodeServer(payload);
    switch (event.kind) {
      case "text": produced = true; push({ ev: { kind: "text", text: event.text } }); break;
      case "thinking": push({ ev: { kind: "thinking", text: event.text } }); break;
      case "tokens": outputTokens += event.count; break;
      case "checkpoint": checkpoint = { used: event.used, max: event.max }; break;
      case "kvGet": send(kvGetReply(event.id, blobs.get(event.blobId))); break;
      case "kvSet": blobs.set(event.blobId, event.data); send(kvSetReply(event.id)); break;
      case "requestContext": send(requestContextReply(event.id, event.execId)); break;
      case "needsTool": fail(new CursorError("Cursor 想执行工具，但 EasySwitch 的 Cursor 来源目前只支持纯文字对话。", 501)); break;
      case "needsAnswer": fail(new CursorError("Cursor 在等一个确认，目前的纯文字对话无法回答它。", 501)); break;
      case "turnEnded": done(); break;
      default: break;
    }
  };

  try {
    session = connect(opts.baseUrl);
    session.on("error", error => fail(new CursorError(`连不上 Cursor：${(error as Error).message}`, 502)));
    stream = session.request({
      ":method": "POST", ":path": "/agent.v1.AgentService/Run",
      "content-type": "application/connect+proto", "connect-protocol-version": "1", te: "trailers",
      authorization: `Bearer ${opts.token}`, "x-ghost-mode": "true", "x-cursor-client-version": CLIENT_VERSION, "x-cursor-client-type": "cli",
      "x-request-id": randomUUID(), "x-session-id": opts.sessionId ?? randomUUID(),
    });
    stream.on("response", headers => { httpStatus = Number(headers[":status"] ?? 200); });
    stream.on("data", (chunk: Buffer) => {
      if (httpStatus !== 200) { errorBody += chunk.toString("utf8").slice(0, 2000); return; }
      try { for (const f of parser.push(chunk)) onFrame(f.flags, f.payload); } catch (error) { fail(new CursorError(String((error as Error).message))); }
    });
    stream.on("trailers", trailers => { const code = Number(trailers["grpc-status"] ?? 0); if (code) fail(new CursorError(`Cursor 结束时报告了错误（${code}）。`)); });
    stream.on("error", error => fail(new CursorError(`和 Cursor 的连接出错：${(error as Error).message}`, 502)));
    stream.on("close", () => {
      if (finished) return;
      if (httpStatus !== 200) fail(fromHttpStatus(httpStatus));
      else if (produced) done();
      else fail(new CursorError("Cursor 在回答之前就断开了连接。"));
    });
    opts.signal?.addEventListener("abort", () => { finished = true; push({ end: true }); }, { once: true });
    armSilence();
    send(prepared.first);
    beat = setInterval(() => send(heartbeat()), opts.heartbeatMs ?? 5000);

    for (;;) {
      while (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
      const item = queue.shift()!;
      if ("error" in item) throw item.error;
      if ("end" in item) return;
      yield item.ev;
      if (item.ev.kind === "done") return;
    }
  } finally {
    finished = true;
    clearTimeout(silence);
    clearInterval(beat);
    try { stream?.close(); } catch { /* already closed */ }
    try { session?.destroy(); } catch { /* already closed */ }
  }
}
