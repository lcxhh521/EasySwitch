/** Bounded subprocess machinery shared by the two documented text bridges. No discovery. */
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { ProtocolError } from "./protocol.ts";

export interface CliTextProcessConfig { binary: string; timeoutMs?: number; maxOutputBytes?: number }
export interface CliTextProcessInput {
  binary: string; args: string[]; env: Record<string, string>; stdin: string; cwd: string;
  signal: AbortSignal; timeoutMs: number; maxOutputBytes: number;
}
export interface CliTextProcessResult { exitCode: number | null; stdout: string }
export type CliTextExecutor = (input: CliTextProcessInput) => Promise<CliTextProcessResult>;

export function cliTextProcessIssue(value: unknown, label: "Qoder" | "CodeBuddy"): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${label} 文字来源配置无效。`;
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(k => !["binary", "timeoutMs", "maxOutputBytes"].includes(k))) return `${label} 来源不接受额外命令、环境变量或凭据字段。`;
  if (typeof config.binary !== "string" || !isAbsolute(config.binary) || /[\r\n\0]/.test(config.binary)) return `请明确选择已安装 ${label} CLI 的绝对路径。`;
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || Number(config.timeoutMs) < 100 || Number(config.timeoutMs) > 300_000)) return `${label} 超时应为 100–300000 毫秒。`;
  if (config.maxOutputBytes !== undefined && (!Number.isSafeInteger(config.maxOutputBytes) || Number(config.maxOutputBytes) < 1 || Number(config.maxOutputBytes) > 8 * 1024 * 1024)) return `${label} 输出上限无效。`;
  return undefined;
}
/** Built-in production transport. Called only by an explicitly enabled source, never during discovery. */
export function executeCliTextProcess(input: CliTextProcessInput, label: "Qoder" | "CodeBuddy", spawnChild: typeof spawn = spawn): Promise<CliTextProcessResult> {
  return new Promise((resolve, reject) => {
  if (input.signal.aborted) { reject(new ProtocolError(`${label} 请求已取消。`, 499)); return; }
  const child = spawnChild(input.binary, input.args, { shell: false, cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] });
  const chunks: Buffer[] = []; let bytes = 0; let failure: ProtocolError | undefined;
  const stop = (error: ProtocolError) => { if (!failure) { failure = error; child.kill("SIGKILL"); } };
  const abort = () => stop(new ProtocolError(`${label} 请求已取消。`, 499));
  const timer = setTimeout(() => stop(new ProtocolError(`${label} 请求超时。`, 504)), input.timeoutMs);
  input.signal.addEventListener("abort", abort, { once: true });
  const cleanup = () => { clearTimeout(timer); input.signal.removeEventListener("abort", abort); };
  child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > input.maxOutputBytes) stop(new ProtocolError(`${label} 输出超过限制。`, 502)); else chunks.push(Buffer.from(chunk)); });
  // Drain but never return/log stderr: a vendor error can include credentials or the prompt.
  child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > input.maxOutputBytes) stop(new ProtocolError(`${label} 输出超过限制。`, 502)); });
  child.once("error", () => { cleanup(); reject(new ProtocolError(`无法启动所选 ${label} CLI；未自动安装或登录。`, 503)); });
  child.once("close", code => { cleanup(); if (failure) reject(failure); else resolve({ exitCode: code, stdout: Buffer.concat(chunks).toString("utf8") }); });
  child.stdin.on("error", () => stop(new ProtocolError(`${label} 输入通道已关闭。`, 502)));
  child.stdin.end(input.stdin);
  });
}
