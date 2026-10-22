import type { Json } from "./protocol.ts";

/** Native history references cannot be translated or safely moved to another credential. */
export function hasResponsesContinuation(body: Json): boolean {
  return body.previous_response_id != null || body.conversation != null
    || (Array.isArray(body.input) && body.input.some(item => item?.type === "compaction"));
}

export const CONTINUATION_SOURCE_REQUIRED = "这次请求含有原来源的会话引用或压缩状态，不能自动换来源或 Key。请使用原会话的固定来源和唯一启用的凭据；无法确认时请新开会话。";
