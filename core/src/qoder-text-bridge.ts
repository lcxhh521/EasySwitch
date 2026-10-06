/**
 * Qoder official headless text bridge. Written from documented CLI facts, 2026-10-06.
 * No native-login discovery, package installation, shell command strings, or SDK dependency.
 * Tests inject QoderExecutor and never start the vendor executable. See docs/cli-text-bridges.md.
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

export type QoderTextBridgeConfig = CliTextProcessConfig;
export type QoderProcessInput = CliTextProcessInput;
export type QoderProcessResult = CliTextProcessResult;
export type QoderExecutor = CliTextExecutor;
export function qoderTextBridgeIssue(value: unknown): string | undefined { return cliTextProcessIssue(value, "Qoder"); }
export function executeQoder(input: QoderProcessInput, spawnChild: typeof spawn = spawn): Promise<QoderProcessResult> { return executeCliTextProcess(input, "Qoder", spawnChild); }

export function prepareQoderTextBridge(config: QoderTextBridgeConfig, input: InboundRequest, execute: QoderExecutor = executeQoder): PreparedOutbound {
  const issue = qoderTextBridgeIssue(config); if (issue) throw new ProtocolError(issue, 400);
  if (!/^[a-z0-9][a-z0-9._:/-]{0,191}$/i.test(input.model)) throw new ProtocolError("Qoder 模型名无效。", 400);
  const request = cliTextRequest(input);
  const options = { ...config };
  return {
    adapter: "qoder-cli-text", protocol: "chat", passthrough: false, tools: [], dropped: request.dropped,
    events: response => readOutput(response, "chat"),
    async send(key, signal) {
      let root: string | undefined;
      try {
        signal.throwIfAborted();
        if (!key || /[\r\n\0]/.test(key)) throw new ProtocolError("Qoder 文字来源需要用户提供的 PAT；不会读取本机登录。", 401);
        root = await mkdtemp(join(tmpdir(), "es-qoder-text-"));
        const home = join(root, "home"), cwd = join(root, "work"), configDir = join(home, ".qoder");
        await mkdir(configDir, { recursive: true, mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
        const settings = join(root, "settings.json");
        await writeFile(settings, JSON.stringify({ hooks: {}, mcpServers: {} }), { mode: 0o600 });
        const args = ["--config-dir", configDir, "--cwd", cwd, "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--permission-mode", "default", "--settings", settings, "--setting-sources", "", "--max-turns", "1", "--max-model-request-retries", "0", "--model", input.model, "--output-format", "text", "--input-format", "text", "--print"];
        if (request.maxTokens) args.push("--max-output-tokens", String(request.maxTokens));
        const env: Record<string, string> = { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), TMPDIR: root, QODER_PERSONAL_ACCESS_TOKEN: key };
        if (process.env.PATH) env.PATH = process.env.PATH;
        if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
        const result = await execute({ binary: options.binary, args, env, stdin: request.prompt, cwd, signal, timeoutMs: options.timeoutMs ?? 120_000, maxOutputBytes: options.maxOutputBytes ?? 2 * 1024 * 1024 });
        signal.throwIfAborted();
        if (result.exitCode !== 0) throw new ProtocolError("Qoder 未成功结束，请检查官方 CLI 和 PAT；不会自动重试登录。", 502);
        if (Buffer.byteLength(result.stdout) > (options.maxOutputBytes ?? 2 * 1024 * 1024)) throw new ProtocolError("Qoder 输出超过限制。", 502);
        const text = result.stdout.trim().split(key).join("[redacted]");
        if (!text) throw new ProtocolError("Qoder 没有返回文字结果。", 502);
        return Response.json({ id: "qoder-text", object: "chat.completion", model: input.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] });
      } catch (error) {
        const status = signal.aborted ? 499 : error instanceof ProtocolError ? error.status : 502;
        return Response.json({ error: { type: "cli_bridge_error", message: signal.aborted ? "Qoder 请求已取消。" : error instanceof ProtocolError ? error.message : "Qoder 文字桥未完成。" } }, { status });
      } finally { if (root) await rm(root, { recursive: true, force: true }); }
    },
  };
}
