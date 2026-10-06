import { randomUUID } from "node:crypto";
import { connect } from "node:http2";
import { readFields, stringOf } from "./proto.ts";
import { CursorError, fromHttpStatus } from "./errors.ts";

const MAX_BODY = 4 * 1024 * 1024;

/**
 * The models the account can use now: one unary call whose request body is empty (a framed or non-empty body is
 * refused) and whose answer lists ModelDetails (field 1, model_id = field 1 of each). Ids already carry the thinking
 * level where the model has one (for example "...-high"), so they are used as they come.
 */
export async function listCursorModels(baseUrl: string, token: string): Promise<string[]> {
  const body = await new Promise<Buffer>((resolve, reject) => {
    const session = connect(baseUrl);
    const finish = (fn: () => void) => { clearTimeout(timer); try { session.destroy(); } catch { /* closed */ } fn(); };
    const timer = setTimeout(() => finish(() => reject(new CursorError("取 Cursor 的模型列表超时。", 504))), 8000);
    session.on("error", e => finish(() => reject(new CursorError(`连不上 Cursor：${e.message}`))));
    const req = session.request({
      ":method": "POST", ":path": "/agent.v1.AgentService/GetUsableModels", "content-type": "application/proto", "connect-protocol-version": "1",
      authorization: `Bearer ${token}`, "x-ghost-mode": "true", "x-cursor-client-version": "cli-2026.02.13-41ac335", "x-cursor-client-type": "cli", "x-session-id": randomUUID(),
    });
    let status = 200; const chunks: Buffer[] = []; let size = 0;
    req.on("response", h => { status = Number(h[":status"] ?? 200); });
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { finish(() => reject(new CursorError("Cursor 的模型列表过大。"))); return; } chunks.push(c); });
    req.on("end", () => finish(() => (status === 200 ? resolve(Buffer.concat(chunks)) : reject(fromHttpStatus(status)))));
    req.on("error", e => finish(() => reject(new CursorError(`和 Cursor 的连接出错：${e.message}`))));
    req.end();
  });
  let ids: string[];
  try { ids = readFields(body).filter(f => f.field === 1 && f.wire === 2).map(f => stringOf(readFields(f.value as Buffer), 1) ?? "").filter(Boolean); }
  catch { throw new CursorError("读不懂 Cursor 返回的模型列表。"); }
  const unique = [...new Set(ids)];
  if (!unique.length) throw new CursorError("Cursor 没有返回可用模型，请检查账号的订阅。");
  return unique;
}
