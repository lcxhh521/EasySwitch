import { execFileSync, spawnSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { SecretStore, SecretStoreHealth } from "./secrets.ts";

export type KeychainRequest = { operation: "get" | "delete"; account: string } | { operation: "set"; account: string; value: string };
export type KeychainReply = { ok: true; found?: boolean; value?: string } | { ok: false; code: number };
export type KeychainTransport = (request: KeychainRequest) => Promise<KeychainReply>;
export type KeychainSpawn = (file: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean }) => ChildProcessWithoutNullStreams;

const MAX_MESSAGE_BYTES = 1_048_576;
const bundledHelper = fileURLToPath(new URL("../native/build/easyswitch-keychain", import.meta.url));

export const KEYCHAIN_CODE_IDENTIFIER = "com.easyswitch.keychain";
export const KEYCHAIN_RETRY_DELAY_MS = 30_000;

export class NativeKeychainError extends Error {
  readonly code: string;
  readonly osStatus?: number;
  constructor(code: string, message: string, osStatus?: number) {
    super(message); this.name = "NativeKeychainError"; this.code = code; this.osStatus = osStatus;
  }
}

export interface HelperInspection {
  platform?: string;
  file?: (helper: string) => { executable: boolean; stamp: string } | undefined;
  verify?: (helper: string) => boolean;
}
const verifiedFiles = new Map<string, { stamp: string; valid: boolean }>();
function inspectFile(helper: string): { executable: boolean; stamp: string } | undefined {
  try {
    const s = lstatSync(helper);
    if (!s.isFile()) return { executable: false, stamp: "not-regular" };
    try { accessSync(helper, constants.X_OK); } catch { return { executable: false, stamp: "not-executable" }; }
    return { executable: true, stamp: [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":") };
  } catch { return undefined; }
}

/** Parse only our fixed, certificate-backed identity; never accept a hash-only/ad-hoc identity. */
export function keychainSigningRequirement(displayed: string): string | undefined {
  const line = displayed.split(/\r?\n/).find(line => /designated\s*=>/.test(line));
  if (!line) return undefined;
  const id = 'identifier "com\\.easyswitch\\.keychain"';
  const certificate = 'certificate (?:leaf|0) = H"([a-f0-9]{40})"';
  const forward = new RegExp('designated\\s*=>\\s*' + id + '\\s+and\\s+' + certificate + '\\s*$', 'i').exec(line);
  const reverse = new RegExp('designated\\s*=>\\s*' + certificate + '\\s+and\\s+' + id + '\\s*$', 'i').exec(line);
  const fingerprint = forward?.[1] ?? reverse?.[1];
  return fingerprint ? `identifier "${KEYCHAIN_CODE_IDENTIFIER}" and certificate leaf = H"${fingerprint}"` : undefined;
}

/** Verify internal consistency and the fixed identity. Package provenance is a separate trust boundary. */
function verifyHelper(helper: string): boolean {
  try {
    const displayed = spawnSync("/usr/bin/codesign", ["--display", "--requirements", "-", helper], { encoding: "utf8", timeout: 2000, maxBuffer: MAX_MESSAGE_BYTES });
    if (displayed.error || displayed.status !== 0) return false;
    const requirement = keychainSigningRequirement(`${displayed.stdout}\n${displayed.stderr}`);
    if (!requirement) return false;
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", requirement, helper], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch { return false; }
}

/** Secret-free health: metadata/signature checks only, never invoke the helper or query Keychain. */
export function keychainHelperHealth(helper = bundledHelper, inspection: HelperInspection = {}): SecretStoreHealth {
  const base = { backend: "native-keychain" as const, ready: false, keychainChecked: false };
  if ((inspection.platform ?? process.platform) !== "darwin") return { ...base, status: "unsupported_platform", message: "原生钥匙串只支持 macOS；测试请明确使用内存存储。" };
  const file = (inspection.file ?? inspectFile)(helper);
  if (!file) return { ...base, status: "helper_missing", message: "缺少钥匙串 helper，请在 Mac 前台使用已有代码签名身份运行 scripts/build-keychain.sh。" };
  if (!file.executable) return { ...base, status: "helper_not_executable", message: "钥匙串 helper 不是可执行的常规文件，请重新构建。" };
  let valid: boolean;
  if (inspection.verify) valid = inspection.verify(helper);
  else {
    const cached = verifiedFiles.get(helper);
    if (cached?.stamp === file.stamp) valid = cached.valid;
    else { valid = verifyHelper(helper); verifiedFiles.set(helper, { stamp: file.stamp, valid }); }
  }
  return valid ? { ...base, ready: true, status: "helper_ready" } : { ...base, status: "helper_signature_invalid", message: "钥匙串 helper 缺少有效的稳定签名，请用同一已有签名身份重新构建；不会使用未签名或 ad-hoc 版本。" };
}

/** Do not compile/sign at launchd startup: signing can itself require a user's foreground approval. */
export function ensureKeychainHelper(helper = bundledHelper): boolean { return keychainHelperHealth(helper).ready; }

export function keychainOperationError(code: number): NativeKeychainError {
  const suffix = ` (OSStatus ${code})`;
  if (code === -25307) return new NativeKeychainError("no_default_keychain", "没有默认钥匙串。请在 Mac 的钥匙串访问中检查登录钥匙串；EasySwitch 不会自动创建、重置或反复弹窗。" + suffix, code);
  if (code === -25294 || code === -25291) return new NativeKeychainError("keychain_unavailable", "钥匙串不存在或当前不可用，请在 Mac 前台检查登录钥匙串后重试。" + suffix, code);
  if (code === -25308 || code === -25293 || code === -128) return new NativeKeychainError("keychain_access_required", "钥匙串已锁定或旧条目需要用户授权。请在 Mac 前台解锁并检查该 helper 的访问权限；后台请求不会打开授权弹窗。" + suffix, code);
  return new NativeKeychainError("keychain_error", "macOS Keychain operation failed" + suffix, code);
}

/**
 * The native helper receives one bounded JSON message on stdin. Secrets never go
 * into argv, environment variables, shell commands or temporary files. stderr is
 * never copied into an exception, since an unexpected helper might echo its input.
 */
export function createKeychainTransport(helper = bundledHelper, spawnChild: KeychainSpawn = spawn, timeoutMs = 15_000): KeychainTransport {
  if (!isAbsolute(helper)) throw new TypeError("The Keychain helper path must be absolute");
  return request => new Promise<KeychainReply>((resolve, reject) => {
    if (spawnChild === spawn) {
      const health = keychainHelperHealth(helper);
      if (!health.ready) { reject(new NativeKeychainError(health.status, health.message ?? "Native Keychain helper is unavailable")); return; }
    }
    const input = JSON.stringify(request);
    if (Buffer.byteLength(input) > MAX_MESSAGE_BYTES) { reject(new Error("Keychain request is too large")); return; }
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnChild(helper, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }); }
    catch { reject(new Error("Native Keychain helper is unavailable; build it on macOS first")); return; }
    let done = false, bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error, reply?: KeychainReply) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); }
      else resolve(reply!);
    };
    const timer = setTimeout(() => finish(new NativeKeychainError("helper_timeout", "Native Keychain operation timed out; check the Mac foreground session before retrying")), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_MESSAGE_BYTES) { finish(new Error("Native Keychain response is too large")); return; }
      chunks.push(Buffer.from(chunk));
    });
    child.stderr.resume();
    child.on("error", () => finish(new Error("Native Keychain helper is unavailable; build it on macOS first")));
    child.stdin.on("error", () => finish(new Error("Native Keychain helper could not receive the request")));
    child.on("close", code => {
      if (done) return;
      if (code !== 0) { finish(new Error("Native Keychain helper failed")); return; }
      try {
        const reply: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!reply || typeof reply !== "object" || Array.isArray(reply)) throw new Error();
        const r = reply as Record<string, unknown>;
        if (r.ok !== true && !(r.ok === false && Number.isInteger(r.code))) throw new Error();
        if (r.ok === true && ((r.value !== undefined && typeof r.value !== "string") || (r.found !== undefined && typeof r.found !== "boolean"))) throw new Error();
        finish(undefined, reply as KeychainReply);
      } catch { finish(new Error("Native Keychain helper returned an invalid response")); }
    });
    child.stdin.end(input);
  });
}

/** No fallback to `security -w`: a missing native build is explicit and never exposes a key on argv. */
export class NativeKeychainStore implements SecretStore {
  #transport: KeychainTransport;
  #now: () => number;
  #failure?: { error: NativeKeychainError; retryAt: number };
  #checked = false;
  #tail: Promise<void> = Promise.resolve();
  #inspect: () => SecretStoreHealth;
  constructor(transport?: KeychainTransport, options: { now?: () => number; inspect?: () => SecretStoreHealth } = {}) {
    this.#transport = transport ?? createKeychainTransport(); this.#now = options.now ?? Date.now;
    this.#inspect = options.inspect ?? (() => keychainHelperHealth());
  }
  health(): SecretStoreHealth {
    const helper = this.#inspect();
    if (!helper.ready) return helper;
    if (this.#failure) return { ...helper, ready: false, status: this.#failure.error.code, keychainChecked: this.#checked, message: this.#failure.error.message, ...(this.#failure.error.osStatus !== undefined ? { osStatus: this.#failure.error.osStatus } : {}) };
    return { ...helper, keychainChecked: this.#checked };
  }
  private request(request: KeychainRequest): Promise<Extract<KeychainReply, { ok: true }>> {
    const pending = this.#tail.then(() => this.perform(request));
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending;
  }
  private async perform(request: KeychainRequest): Promise<Extract<KeychainReply, { ok: true }>> {
    if (!request.account || request.account.length > 1024) throw new TypeError("Invalid Keychain account");
    if (this.#failure && this.#now() < this.#failure.retryAt) throw this.#failure.error;
    try {
      const reply = await this.#transport(request); this.#checked = true;
      if (!reply.ok) throw keychainOperationError(reply.code);
      this.#failure = undefined;
      return reply;
    } catch (error) {
      const safe = error instanceof NativeKeychainError ? error : new NativeKeychainError("helper_failed", "Native Keychain helper is unavailable or failed; check the signed helper on the Mac");
      // Avoid a catalog refresh spawning dozens of failed helpers/prompts or 15-second waits.
      this.#failure = { error: safe, retryAt: this.#now() + KEYCHAIN_RETRY_DELAY_MS };
      throw safe;
    }
  }
  async get(account: string): Promise<string | undefined> {
    const reply = await this.request({ operation: "get", account });
    if (reply.found === false && reply.value === undefined) return undefined;
    if (reply.found !== true || typeof reply.value !== "string") throw new Error("Native Keychain helper returned an invalid lookup");
    return reply.value;
  }
  async set(account: string, value: string): Promise<void> { await this.request({ operation: "set", account, value }); }
  async delete(account: string): Promise<void> { await this.request({ operation: "delete", account }); }
}
