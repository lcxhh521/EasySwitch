/**
 * Qoder official headless text bridge. Written from documented CLI facts, 2026-10-06.
 * No native-login discovery, package installation, shell command strings, or SDK dependency.
 * Tests inject QoderExecutor and never start the vendor executable. See docs/cli-text-bridges.md.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { PreparedOutbound } from "./outbound.ts";
import { ProtocolError, type InboundRequest } from "./protocol.ts";
import { readOutput } from "./upstream-events.ts";
import { cliTextRequest } from "./cli-text-request.ts";

export interface QoderTextBridgeConfig { binary: string; timeoutMs?: number; maxOutputBytes?: number }
export interface QoderProcessInput {
  binary: string; args: string[]; env: Record<string, string>; stdin: string; cwd: string;
  signal: AbortSignal; timeoutMs: number; maxOutputBytes: number;
}
export interface QoderProcessResult { exitCode: number | null; stdout: string }
export type QoderExecutor = (input: QoderProcessInput) => Promise<QoderProcessResult>;

export function qoderTextBridgeIssue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Qoder 文字来源配置无效。";
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(k => !["binary", "timeoutMs", "maxOutputBytes"].includes(k))) return "Qoder 来源不接受额外命令、环境变量或凭据字段。";
  if (typeof config.binary !== "string" || !isAbsolute(config.binary) || /[\r\n\0]/.test(config.binary)) return "请明确选择已安装 Qoder CLI 的绝对路径。";
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || Number(config.timeoutMs) < 100 || Number(config.timeoutMs) > 300_000)) return "Qoder 超时应为 100–300000 毫秒。";
  if (config.maxOutputBytes !== undefined && (!Number.isSafeInteger(config.maxOutputBytes) || Number(config.maxOutputBytes) < 1 || Number(config.maxOutputBytes) > 8 * 1024 * 1024)) return "Qoder 输出上限无效。";
  return undefined;
}

/** Built-in production transport. Called only by an explicitly enabled source, never during discovery. */
export function executeQoder(input: QoderProcessInput, spawnChild: typeof spawn = spawn): Promise<QoderProcessResult> {
  return new Promise((resolve, reject) => {
  if (input.signal.aborted) { reject(new ProtocolError("Qoder 请求已取消。", 499)); return; }
  const child = spawnChild(input.binary, input.args, { shell: false, cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = []; let bytes = 0; let failure: ProtocolError | undefined;
  const stop = (error: ProtocolError) => { if (!failure) { failure = error; child.kill("SIGKILL"); } };
  const abort = () => stop(new ProtocolError("Qoder 请求已取消。", 499));
  const timer = setTimeout(() => stop(new ProtocolError("Qoder 请求超时。", 504)), input.timeoutMs);
  input.signal.addEventListener("abort", abort, { once: true });
  const cleanup = () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); };
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > input.maxOutputBytes) stop(new ProtocolError("Qoder 输出超过限制。", 502)); else chunks.push(Buffer.from(chunk)); });
  // Drain but never return/log stderr: a vendor error can include credentials or the prompt.
  child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > input.maxOutputBytes) stop(new ProtocolError("Qoder 输出超过限制。", 502)); });
  child.once("error", () => { cleanup(); reject(new ProtocolError("无法启动所选 Qoder CLI；未自动安装或登录。", 503)); });
  child.once("close", code => { cleanup(); if (failure) reject(failure); else resolve({ exitCode: code, stdout: Buffer.concat(chunks).toString("utf8") }); });
  child.stdin.on("error", () => stop(new ProtocolError("Qoder 输入通道已关闭。", 502)));
  child.stdin.end(input.stdin);
  });
}

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
