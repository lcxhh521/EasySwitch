/**
 * Bounded Droid no-tools controller, using only the documented session API contract.
 * Production transport is deliberately absent until its isolation/wire contract is validated.
 * No SDK import, package install, CLI spawn, native login lookup or model call occurs here.
 */
import type { PreparedOutbound } from "./outbound.ts";
import { ProtocolError, type InboundRequest } from "./protocol.ts";
import { readOutput } from "./upstream-events.ts";
import { cliTextRequest } from "./cli-text-request.ts";

export interface DroidTextTool { id: string; allowed: boolean }
export interface DroidTextSession {
  listTools(): Promise<DroidTextTool[]>;
  updateSettings(settings: { disabledToolIds: string[] }): Promise<unknown>;
  stream(prompt: string, options: { abortSignal: AbortSignal }): AsyncIterable<{ type: string; text?: string; subtype?: string; success?: boolean }>;
  close(): Promise<void>;
}
export interface DroidTextTransport {
  /** These are host adapter guarantees, not invented Droid command-line flags. */
  capabilities: { isolatedHomeAndCwd: boolean; noAmbientMcpOrHooks: boolean; ephemeralSession: boolean; denyAllPermissions: boolean };
  open(options: { apiKey: string; modelId: string; autonomyLevel: "off"; autoRejectPermissionRequests: true; disableBuiltinSkills: true; mcpServers: []; abortSignal: AbortSignal }): Promise<DroidTextSession>;
}
export const DROID_TEXT_BRIDGE_BLOCKER = "Droid 纯文字来源尚未接通已验证的隔离传输；不会假定空工具列表等于禁用全部工具，也不会运行真实 CLI。";

function toolIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 4096 || value.some(t => !t || typeof t !== "object" || typeof t.id !== "string" || !t.id || t.id.length > 256 || typeof t.allowed !== "boolean")) throw new ProtocolError("Droid 工具能力响应不完整，未发送提示词。", 501);
  return [...new Set(value.map(t => t.id as string))];
}

export function prepareDroidTextBridge(input: InboundRequest, transport?: DroidTextTransport): PreparedOutbound {
  const request = cliTextRequest(input);
  if (request.maxTokens) request.dropped.push("max_tokens:droid_text_bridge");
  return {
    adapter: "droid-cli-text", protocol: "chat", passthrough: false, tools: [], dropped: request.dropped,
    events: response => readOutput(response, "chat"),
    async send(key, signal) {
      let session: DroidTextSession | undefined;
      try {
        signal.throwIfAborted();
        if (!transport || !Object.values(transport.capabilities).every(value => value === true) || !["isolatedHomeAndCwd", "noAmbientMcpOrHooks", "ephemeralSession", "denyAllPermissions"].every(name => Object.hasOwn(transport.capabilities, name))) throw new ProtocolError(DROID_TEXT_BRIDGE_BLOCKER, 501);
        if (!key || /[\r\n\0]/.test(key)) throw new ProtocolError("需要用户提供 Factory API Key；不会读取本机登录。", 401);
        session = await transport.open({ apiKey: key, modelId: input.model, autonomyLevel: "off", autoRejectPermissionRequests: true, disableBuiltinSkills: true, mcpServers: [], abortSignal: signal });
        const discovered = toolIds(await session.listTools());
        await session.updateSettings({ disabledToolIds: discovered });
        const verified = await session.listTools(); toolIds(verified);
        if (verified.some(tool => tool.allowed)) throw new ProtocolError("Droid 仍有启用的工具，未发送提示词。", 501);
        signal.throwIfAborted();
        let result: string | undefined;
        for await (const message of session.stream(request.prompt, { abortSignal: signal })) {
          signal.throwIfAborted();
          if (["tool_call", "tool_result", "hook"].includes(message.type)) throw new ProtocolError("Droid 发出了不允许的工具或 hook 事件，文字请求已停止。", 501);
          if (message.type === "error") throw new ProtocolError("Droid 文字请求失败。", 502);
          if (message.type === "result") {
            if (message.subtype !== "success" || message.success !== true || typeof message.text !== "string") throw new ProtocolError("Droid 未成功完成文字请求。", 502);
            if (Buffer.byteLength(message.text) > 2 * 1024 * 1024) throw new ProtocolError("Droid 输出超过限制。", 502);
            result = message.text.split(key).join("[redacted]");
          }
        }
        if (result === undefined) throw new ProtocolError("Droid 响应未正常结束。", 502);
        return Response.json({ id: "droid-text", object: "chat.completion", model: input.model, choices: [{ index: 0, message: { role: "assistant", content: result }, finish_reason: "stop" }] });
      } catch (error) {
        return Response.json({ error: { type: "cli_bridge_error", message: signal.aborted ? "Droid 请求已取消。" : error instanceof ProtocolError ? error.message : "Droid 文字桥未完成。" } }, { status: signal.aborted ? 499 : error instanceof ProtocolError ? error.status : 502 });
      } finally { await session?.close().catch(() => undefined); }
    },
  };
}
