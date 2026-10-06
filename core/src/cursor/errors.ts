import type { ConnectError } from "./connect.ts";

export class CursorError extends Error {
  status: number;
  /** The login is no longer good: ask the person to sign in again. */
  auth: boolean;
  constructor(message: string, status = 502, auth = false) { super(message); this.status = status; this.auth = auth; }
}

/**
 * What an error from Cursor means for the person, by the words in it (Connect error codes arrive in lower case).
 * Order matters: a missing permission on the plan must not be mistaken for a passing overload.
 */
export function classify(error: ConnectError): CursorError {
  const text = `${error.code} ${error.message}`.toLowerCase();
  const has = (...words: string[]) => words.some(w => text.includes(w));
  if (has("unauthenticated", "unauthorized", "invalid token", "expired token", "authentication", "access denied", "permission_denied", "forbidden"))
    return new CursorError("Cursor 拒绝了登录，请回到 EasySwitch 重新登录。", 401, true);
  if (has("rate limit", "too many requests", "throttl") || (error.code === "resource_exhausted"))
    return new CursorError("Cursor 的额度用完了，或请求过于频繁，请稍后重试。", 429);
  if (has("failed_precondition")) return new CursorError(`Cursor 不接受这个请求（可能是这个套餐不能用这个模型）：${error.message || error.code}`, 400);
  if (has("unavailable", "overloaded", "temporarily", "server is busy")) return new CursorError("Cursor 暂时繁忙，请稍后重试。", 503);
  if (has("invalid", "not found", "unsupported", "malformed", "unimplemented")) return new CursorError(`Cursor 不接受这个请求：${error.message || error.code}`, 400);
  if (has("timed out", "deadline")) return new CursorError("Cursor 响应超时。", 504);
  return new CursorError(`Cursor 返回了错误（${error.code}）。`, 502);
}

export function fromHttpStatus(status: number): CursorError {
  if (status === 401 || status === 403) return new CursorError("Cursor 拒绝了登录，请回到 EasySwitch 重新登录。", 401, true);
  if (status === 429) return new CursorError("Cursor 的额度用完了，或请求过于频繁，请稍后重试。", 429);
  return new CursorError(`Cursor 返回 HTTP ${status}。`, status >= 500 ? 502 : 400);
}
