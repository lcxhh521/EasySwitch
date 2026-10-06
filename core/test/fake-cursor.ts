import { createHash } from "node:crypto";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import { connect as connectNet, createServer as createNet, type Server as NetServer } from "node:net";
import { createServer as createH2, type Http2Server } from "node:http2";
import { encodeFrame, FrameParser } from "../src/cursor/connect.ts";
import { bytesOf, readFields, stringOf, uintOf, Writer } from "../src/cursor/proto.ts";

/**
 * A stand-in for Cursor: its login endpoints over HTTP/1 and its agent service over plain-text HTTP/2, on one port.
 * It checks what a real client must send and records it, and it plays a scripted turn: it asks the client for a stored
 * conversation piece and for its context, then answers.
 */

export interface Reply { kind: "kv" | "exec" | "heartbeat"; id?: number; data?: Buffer; execId?: string }
export interface RunCall {
  headers: Record<string, string | string[] | undefined>;
  modelId: string; userText: string; conversationId: string; rootBlobIds: string[]; hasTools: boolean;
  replies: Reply[];
}
export interface Script {
  text?: string[]; thinking?: string[]; tokens?: number; checkpoint?: { used: number; max: number };
  /** An error in the end-of-stream frame, an HTTP status, a tool request, or silence. */
  error?: { code: string; message: string }; status?: number; tool?: boolean; silent?: boolean; compressed?: boolean;
  /** Skip asking the client for a stored piece and its context. */
  plain?: boolean;
}
export interface FakeCursor {
  base: string; port: number;
  runs: RunCall[]; modelCalls: Array<{ authorization?: string; bodyLength: number; contentType?: string }>;
  script: () => Script; models: string[];
  polls: number; refreshes: Array<string | undefined>; approved: Map<string, string>; accessExp: number; refreshToken: string;
  approve(loginUrl: string): void;
  close(): void;
}

const jwt = (claims: object) => `${Buffer.from("{}").toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const server = (...fields: Array<[number, Writer]>) => { const w = new Writer(); for (const [f, m] of fields) w.message(f, m); return w.finish(); };
const update = (field: number, inner: Writer) => server([1, new Writer().message(field, inner)]);

export async function startFakeCursor(): Promise<FakeCursor> {
  const fake: FakeCursor = {
    base: "", port: 0, runs: [], modelCalls: [], script: () => ({ text: ["Hello"] }), models: ["fake-claude-high", "fake-gpt-medium"],
    polls: 0, refreshes: [], approved: new Map(), accessExp: Math.floor(Date.now() / 1000) + 3600, refreshToken: "refresh-1",
    approve(loginUrl) { const u = new URL(loginUrl); fake.approved.set(u.searchParams.get("uuid")!, u.searchParams.get("challenge")!); },
    close() { net.close(); http.closeAllConnections(); http.close(); h2.close(); for (const s of open) s.destroy(); },
  };
  const access = (n = 1) => jwt({ sub: "auth0|user_01", email: "Person@Example.com", exp: fake.accessExp, n });

  const http: HttpServer = createHttp((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/auth/poll") {
      fake.polls++;
      const challenge = fake.approved.get(url.searchParams.get("uuid") ?? "");
      if (!challenge) { res.writeHead(404).end(); return; }
      if (createHash("sha256").update(url.searchParams.get("verifier") ?? "").digest("base64url") !== challenge) { res.writeHead(403).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accessToken: access(), refreshToken: fake.refreshToken })); return;
    }
    if (url.pathname === "/auth/exchange_user_api_key" && req.method === "POST") {
      fake.refreshes.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${fake.refreshToken}`) { res.writeHead(401).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ accessToken: access(fake.refreshes.length + 1) })); return;
    }
    res.writeHead(404).end();
  });

  const h2: Http2Server = createH2();
  h2.on("sessionError", e => console.log("fake h2 sessionError", e));
  h2.on("stream", (stream, headers) => {
    stream.on("error", e => console.log("fake stream error", e));
    const path = String(headers[":path"]);
    if (path === "/agent.v1.AgentService/GetUsableModels") {
      let length = 0;
      stream.on("data", (c: Buffer) => { length += c.length; });
      stream.on("end", () => {
        fake.modelCalls.push({ authorization: String(headers.authorization), bodyLength: length, contentType: String(headers["content-type"]) });
        const body = Buffer.concat(fake.models.map(id => new Writer().message(1, new Writer().string(1, id).string(3, id)).finish()));
        stream.respond({ ":status": 200, "content-type": "application/proto" }); stream.end(body);
      });
      return;
    }
    if (path !== "/agent.v1.AgentService/Run") { stream.respond({ ":status": 404 }); stream.end(); return; }
    const script = fake.script();
    if (script.status) { stream.respond({ ":status": script.status, "content-type": "application/json" }); stream.end('{"error":"nope"}'); return; }
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const parser = new FrameParser();
    let call: RunCall | undefined;
    let waiting: ((r: Reply) => void) | undefined;
    const send = (payload: Buffer, flags = 0) => { if (!stream.destroyed) stream.write(encodeFrame(payload, flags)); };
    const ask = (message: Buffer, kind: Reply["kind"]) => new Promise<Reply>(resolve => { waiting = r => { if (r.kind === kind) { waiting = undefined; resolve(r); } }; send(message); });
    stream.on("data", async (chunk: Buffer) => {
      for (const frame of parser.push(chunk)) {
        const top = readFields(frame.payload);
        const run = bytesOf(top, 1);
        if (run) {
          const r = readFields(run);
          const state = readFields(bytesOf(r, 1) ?? Buffer.alloc(0));
          const action = readFields(bytesOf(readFields(bytesOf(readFields(bytesOf(r, 2)!)!, 1)!)!, 1)!);
          call = {
            headers, modelId: stringOf(readFields(bytesOf(r, 3)!), 1)!, userText: stringOf(action, 1)!, conversationId: stringOf(r, 5)!,
            rootBlobIds: state.filter(f => f.field === 1).map(f => (f.value as Buffer).toString("hex")), hasTools: bytesOf(r, 4) !== undefined, replies: [],
          };
          fake.runs.push(call);
          if (script.silent) return;
          if (!script.plain) {
            await ask(server([4, new Writer().uint(1, 7).message(2, new Writer().bytes(1, Buffer.from(call.rootBlobIds[0]!, "hex")))]), "kv");
            await ask(server([2, new Writer().uint(1, 9).string(15, "exec-1").message(10, new Writer())]), "exec");
          }
          if (script.tool) { send(update(2, new Writer())); return; }
          for (const t of script.thinking ?? []) send(update(4, new Writer().string(1, t)));
          for (const t of script.text ?? []) send(update(1, new Writer().string(1, t)));
          if (script.tokens) send(update(8, new Writer().uint(1, script.tokens)));
          if (script.checkpoint) send(server([3, new Writer().message(5, new Writer().uint(1, script.checkpoint.used).uint(2, script.checkpoint.max))]));
          if (script.error) { send(Buffer.from(JSON.stringify({ error: script.error })), 2); stream.end(); return; }
          send(update(14, new Writer()), script.compressed ? 1 : 0);
          send(Buffer.from("{}"), 2);
          stream.end();
          continue;
        }
        const kv = bytesOf(top, 3);
        if (kv) { const k = readFields(kv); const get = bytesOf(k, 2); const reply: Reply = { kind: "kv", id: uintOf(k, 1)!, ...(get ? { data: bytesOf(readFields(get), 1) ?? Buffer.alloc(0) } : {}) }; call?.replies.push(reply); waiting?.(reply); continue; }
        const exec = bytesOf(top, 2);
        if (exec) { const e = readFields(exec); const reply: Reply = { kind: "exec", id: uintOf(e, 1)!, execId: stringOf(e, 15)! }; call?.replies.push(reply); waiting?.(reply); continue; }
        if (bytesOf(top, 7) !== undefined) call?.replies.push({ kind: "heartbeat" });
      }
    });
  });

  // One port for both: a plain HTTP/2 connection starts with a fixed preface, anything else is the login endpoints.
  // (HTTP/2 reads the socket's handle directly, so those connections are passed on by copying their bytes.)
  await new Promise<void>(r => h2.listen(0, "127.0.0.1", r));
  const h2Port = (h2.address() as { port: number }).port;
  const open = new Set<import("node:net").Socket>();
  const net: NetServer = createNet(socket => {
    open.add(socket); socket.on("close", () => open.delete(socket));
    socket.once("data", first => {
      socket.pause();
      if (first.subarray(0, 3).toString() === "PRI") {
        const inner = connectNet(h2Port, "127.0.0.1", () => { inner.write(first); socket.pipe(inner); inner.pipe(socket); socket.resume(); });
        inner.on("error", () => socket.destroy()); socket.on("error", () => inner.destroy()); socket.on("close", () => inner.destroy());
      } else { socket.unshift(first); http.emit("connection", socket); socket.resume(); }
    });
  });
  await new Promise<void>(r => net.listen(0, "127.0.0.1", r));
  fake.port = (net.address() as { port: number }).port;
  fake.base = `http://127.0.0.1:${fake.port}`;
  return fake;
}
