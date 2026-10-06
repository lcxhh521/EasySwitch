/** Bounded subprocess machinery shared by the two documented text bridges. No discovery. */
import { spawn } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { ProtocolError } from "./protocol.ts";

export interface CliTextProcessConfig { binary: string; timeoutMs?: number; maxOutputBytes?: number }
export interface CliTextProcessInput {
  binary: string; args: string[]; env: Record<string, string>; stdin: string; cwd: string;
  signal: AbortSignal; timeoutMs: number; maxOutputBytes: number;
}
export interface CliTextProcessResult { exitCode: number | null; stdout: string }
export type CliTextExecutor = (input: CliTextProcessInput) => Promise<CliTextProcessResult>;
export type CliTextLabel = "Qoder" | "CodeBuddy";
export const MAX_CLI_TEXT_CONCURRENT = 3;
/** After killing the child, inherited grandchild pipes may never emit close. */
export const CLI_TEXT_CLOSE_GRACE_MS = 250;
let running = 0;

function binaryNameIssue(binary: unknown, label: CliTextLabel): string | undefined {
  const names = label === "Qoder" ? ["qoder", "qodercli", "qoder.exe", "qodercli.exe"] : ["codebuddy", "codebuddy.exe"];
  if (typeof binary !== "string" || !isAbsolute(binary) || /[\r\n\0]/.test(binary) || !names.includes(basename(binary).toLowerCase())) return `请明确选择已安装 ${label} CLI 的绝对路径和官方可执行文件名。`;
  return undefined;
}
export function cliTextProcessIssue(value: unknown, label: CliTextLabel): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${label} 文字来源配置无效。`;
  const config = value as Record<string, unknown>;
  if (Object.keys(config).some(k => !["binary", "timeoutMs", "maxOutputBytes"].includes(k))) return `${label} 来源不接受额外命令、环境变量或凭据字段。`;
  const issue = binaryNameIssue(config.binary, label); if (issue) return issue;
  if (config.timeoutMs !== undefined && (!Number.isSafeInteger(config.timeoutMs) || Number(config.timeoutMs) < 100 || Number(config.timeoutMs) > 300_000)) return `${label} 超时应为 100–300000 毫秒。`;
  if (config.maxOutputBytes !== undefined && (!Number.isSafeInteger(config.maxOutputBytes) || Number(config.maxOutputBytes) < 1 || Number(config.maxOutputBytes) > 8 * 1024 * 1024)) return `${label} 输出上限无效。`;
  return undefined;
}

export interface CliTextBinaryInfo { realPath: string; isFile: boolean; mode: number; executable: boolean }
export type CliTextBinaryInspector = (binary: string) => Promise<CliTextBinaryInfo>;
const inspectBinary: CliTextBinaryInspector = async binary => {
  const realPath = await realpath(binary);
  const info = await stat(realPath);
  let executable = true;
  try { await access(realPath, constants.X_OK); } catch { executable = false; }
  return { realPath, isFile: info.isFile(), mode: info.mode, executable };
};
function metadataIssue(info: CliTextBinaryInfo, label: CliTextLabel): string | undefined {
  if (!isAbsolute(info.realPath) || !info.isFile || !info.executable || !Number.isSafeInteger(info.mode) || (info.mode & 0o002) !== 0) return `${label} CLI 必须是存在、可执行且非所有人可写的普通文件。`;
  return undefined;
}
/** Creation-time read-only check. Tests supply metadata instead of reading any binary. */
export async function cliTextBinaryIssue(binary: string, label: CliTextLabel, inspect: CliTextBinaryInspector = inspectBinary): Promise<string | undefined> {
  const issue = binaryNameIssue(binary, label); if (issue) return issue;
  try { return metadataIssue(await inspect(binary), label); }
  catch { return `${label} CLI 不存在或无法读取；不会自动安装。`; }
}

/** Only network routing settings cross the private-HOME boundary, never ambient auth/helpers. */
export function cliTextProxyEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
    .flatMap(name => typeof env[name] === "string" && env[name] && !/[\r\n\0]/.test(env[name]!) ? [[name, env[name]!]] : []));
}

/** Built-in production transport. Called only by an explicitly enabled source, never during discovery. */
export async function executeCliTextProcess(input: CliTextProcessInput, label: CliTextLabel, spawnChild: typeof spawn = spawn,
  killGroup?: (pid: number) => void): Promise<CliTextProcessResult> {
  if (input.signal.aborted) throw new ProtocolError(`${label} 请求已取消。`, 499);
  if (running >= MAX_CLI_TEXT_CONCURRENT) throw new ProtocolError(`已有 ${MAX_CLI_TEXT_CONCURRENT} 个文字桥请求运行，请稍后再试。`, 429);
  running++;
  try {
    let binary = input.binary;
    // A real launch is rechecked and pinned to the resolved target; injected fake children do no file access.
    if (spawnChild === spawn) {
      const nameIssue = binaryNameIssue(binary, label); if (nameIssue) throw new ProtocolError(nameIssue, 400);
      let info: CliTextBinaryInfo;
      try { info = await inspectBinary(binary); } catch { throw new ProtocolError(`${label} CLI 不存在或无法读取。`, 503); }
      const issue = metadataIssue(info, label); if (issue) throw new ProtocolError(issue, 400);
      binary = info.realPath;
    }
    if (input.signal.aborted) throw new ProtocolError(`${label} 请求已取消。`, 499);
    return await new Promise<CliTextProcessResult>((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try { child = spawnChild(binary, input.args, { shell: false, detached: process.platform !== "win32", cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] }); }
      catch { reject(new ProtocolError(`无法启动所选 ${label} CLI；未自动安装或登录。`, 503)); return; }
      const chunks: Buffer[] = [];
      let stdoutBytes = 0, stderrBytes = 0, settled = false;
      let failure: ProtocolError | undefined;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(closeTimer); input.signal.removeEventListener("abort", abort);
        child.stdout?.removeListener("data", onStdout); child.stderr?.removeListener("data", onStderr);
      };
      const finish = (code: number | null) => {
        if (settled) return; settled = true; cleanup();
        if (failure) reject(failure); else resolve({ exitCode: code, stdout: Buffer.concat(chunks).toString("utf8") });
      };
      const stop = (error: ProtocolError) => {
        if (settled || failure) return; failure = error;
        try {
          if (child.pid && process.platform !== "win32" && (killGroup || spawnChild === spawn)) {
            try { if (killGroup) killGroup(child.pid); else process.kill(-child.pid, "SIGKILL"); }
            catch { child.kill("SIGKILL"); }
          } else child.kill("SIGKILL");
        } catch { /* A disappeared process must not prevent pipe cleanup and rejection. */ }
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        // A grandchild holding inherited descriptors cannot keep the request/slot alive forever.
        if (!settled) closeTimer = setTimeout(() => { child.unref?.(); finish(null); }, CLI_TEXT_CLOSE_GRACE_MS);
      };
      const abort = () => stop(new ProtocolError(`${label} 请求已取消。`, 499));
      const timer = setTimeout(() => stop(new ProtocolError(`${label} 请求超时。`, 504)), input.timeoutMs);
      const onStdout = (chunk: Buffer | string) => {
        if (settled || failure) return;
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += data.length;
        if (stdoutBytes > input.maxOutputBytes) stop(new ProtocolError(`${label} 标准输出超过限制。`, 502)); else chunks.push(Buffer.from(data));
      };
      const onStderr = (chunk: Buffer | string) => {
        if (settled || failure) return;
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > input.maxOutputBytes) stop(new ProtocolError(`${label} 错误输出超过限制。`, 502));
      };
      input.signal.addEventListener("abort", abort, { once: true });
      child.stdout?.on("data", onStdout); child.stderr?.on("data", onStderr);
      child.once("error", () => { if (!failure) failure = new ProtocolError(`无法启动所选 ${label} CLI；未自动安装或登录。`, 503); finish(null); });
      child.once("close", code => finish(code));
      child.stdin?.on("error", () => stop(new ProtocolError(`${label} 输入通道已关闭。`, 502)));
      if (input.signal.aborted) abort(); else {
        try { child.stdin?.end(input.stdin); } catch { stop(new ProtocolError(`${label} 输入通道已关闭。`, 502)); }
      }
    });
  } finally { running--; }
}
