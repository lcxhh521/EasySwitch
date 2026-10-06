/** Official CodeBuddy Code print-mode text source, not the inbound CodeBuddy launcher.
 * Uses only explicit API Key/edition and private per-request state. No native login reads.
 * Written against 2026-10-06 official CLI/IAM/env/settings docs; real CLI unverified.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreparedOutbound } from "./outbound.ts";
import { ProtocolError, type InboundRequest } from "./protocol.ts";
import { readOutput } from "./upstream-events.ts";
import { cliTextRequest } from "./cli-text-request.ts";
import { cliTextProcessIssue, executeCliTextProcess, type CliTextProcessConfig, type CliTextProcessInput, type CliTextProcessResult, type CliTextExecutor } from "./cli-text-process.ts";

export interface CodeBuddyTextBridgeConfig extends CliTextProcessConfig { edition: "international" | "china" }
export type CodeBuddyExecutor = CliTextExecutor;
export function codeBuddyTextBridgeIssue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "CodeBuddy 文字来源配置无效。";
  const { edition, ...config } = value as Record<string, unknown>;
  if (edition !== "international" && edition !== "china") return "请明确选择与 API Key 对应的 CodeBuddy 国际版或国内版；企业/iOA 来源暂不支持。";
  return cliTextProcessIssue(config, "CodeBuddy");
}
export function executeCodeBuddy(input: CliTextProcessInput, spawnChild: typeof spawn = spawn): Promise<CliTextProcessResult> { return executeCliTextProcess(input, "CodeBuddy", spawnChild); }

export function prepareCodeBuddyTextBridge(config: CodeBuddyTextBridgeConfig, input: InboundRequest, execute: CodeBuddyExecutor = executeCodeBuddy): PreparedOutbound {
  const issue = codeBuddyTextBridgeIssue(config); if (issue) throw new ProtocolError(issue, 400);
  if (!/^[a-z0-9][a-z0-9._:/-]{0,191}$/i.test(input.model)) throw new ProtocolError("CodeBuddy 模型名无效。", 400);
  const request = cliTextRequest(input), options = { ...config };
  // The documented env option applies to "most requests", not a hard vendor billing cap.
  if (request.maxTokens) request.dropped.push("max_tokens:codebuddy_cli_hint");
  return {
    adapter: "codebuddy-cli-text", protocol: "chat", passthrough: false, tools: [], dropped: request.dropped,
    events: response => readOutput(response, "chat"),
    async send(key, signal) {
      let root: string | undefined;
      try {
        signal.throwIfAborted();
        if (!key || /[\r\n\0]/.test(key)) throw new ProtocolError("CodeBuddy 文字来源需要用户提供区域匹配的 API Key；不会读取本机登录。", 401);
        root = await mkdtemp(join(tmpdir(), "es-codebuddy-text-"));
        const home = join(root, "home"), cwd = join(root, "work"), configDir = join(home, ".codebuddy");
        await mkdir(configDir, { recursive: true, mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
        const settings = join(configDir, "settings.json"), mcp = join(root, "mcp.json");
        await writeFile(settings, JSON.stringify({ disableAllHooks: true, hooks: {} }), { mode: 0o600 });
        await writeFile(mcp, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
        const args = ["--tools", "", "--strict-mcp-config", "--mcp-config", mcp, "--no-session-persistence", "--permission-mode", "dontAsk", "--settings", settings, "--setting-sources", "user", "--max-turns", "1", "--model", input.model, "--output-format", "text", "--input-format", "text", "--print"];
        const env: Record<string, string> = {
          HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), TMPDIR: root,
          CODEBUDDY_CONFIG_DIR: configDir, CODEBUDDY_CODE_DEBUG_LOGS_DIR: join(root, "logs"), CODEBUDDY_API_KEY: key,
          CODEBUDDY_MAX_RETRIES: "0", CODEBUDDY_RETRY_WATCHDOG: "0", DISABLE_AUTOUPDATER: "1",
          CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: "1", CODEBUDDY_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_DISABLE_SHELL_SNAPSHOT: "1",
        };
        // Official IAM: international is unset; China uses internal. Never use a guessed endpoint.
        if (options.edition === "china") env.CODEBUDDY_INTERNET_ENVIRONMENT = "internal";
        if (request.maxTokens) env.CODEBUDDY_CODE_MAX_OUTPUT_TOKENS = String(request.maxTokens);
        if (process.env.PATH) env.PATH = process.env.PATH;
        if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
        const result = await execute({ binary: options.binary, args, env, stdin: request.prompt, cwd, signal, timeoutMs: options.timeoutMs ?? 120_000, maxOutputBytes: options.maxOutputBytes ?? 2 * 1024 * 1024 });
        signal.throwIfAborted();
        if (result.exitCode !== 0) throw new ProtocolError("CodeBuddy 未成功结束，请检查官方 CLI、账户区域和 API Key；不会自动重试登录。", 502);
        if (Buffer.byteLength(result.stdout) > (options.maxOutputBytes ?? 2 * 1024 * 1024)) throw new ProtocolError("CodeBuddy 输出超过限制。", 502);
        const text = result.stdout.trim().split(key).join("[redacted]");
        if (!text) throw new ProtocolError("CodeBuddy 没有返回文字结果。", 502);
        return Response.json({ id: "codebuddy-text", object: "chat.completion", model: input.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
      } catch (error) {
        return Response.json({ error: { type: "cli_bridge_error", message: signal.aborted ? "CodeBuddy 请求已取消。" : error instanceof ProtocolError ? error.message : "CodeBuddy 文字桥未完成。" } }, { status: signal.aborted ? 499 : error instanceof ProtocolError ? error.status : 502 });
      } finally { if (root) await rm(root, { recursive: true, force: true }); }
    },
  };
}
