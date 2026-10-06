import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { SecretStore } from "./secrets.ts";

export type KeychainRequest = { operation: "get" | "delete"; account: string } | { operation: "set"; account: string; value: string };
export type KeychainReply = { ok: true; found?: boolean; value?: string } | { ok: false; code: number };
export type KeychainTransport = (request: KeychainRequest) => Promise<KeychainReply>;
export type KeychainSpawn = (file: string, args: string[], options: { stdio: ["pipe", "pipe", "pipe"]; windowsHide: boolean }) => ChildProcessWithoutNullStreams;

const MAX_MESSAGE_BYTES = 1_048_576;
const bundledHelper = fileURLToPath(new URL("../native/build/easyswitch-keychain", import.meta.url));

/**
 * The native helper receives one bounded JSON message on stdin. Secrets never go
 * into argv, environment variables, shell commands or temporary files. stderr is
 * never copied into an exception, since an unexpected helper might echo its input.
 */
export function createKeychainTransport(helper = bundledHelper, spawnChild: KeychainSpawn = spawn, timeoutMs = 15_000): KeychainTransport {
  if (!isAbsolute(helper)) throw new TypeError("The Keychain helper path must be absolute");
  return request => new Promise<KeychainReply>((resolve, reject) => {
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
    const timer = setTimeout(() => finish(new Error("Native Keychain operation timed out")), timeoutMs);
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
  constructor(transport: KeychainTransport = createKeychainTransport()) { this.#transport = transport; }
  private async request(request: KeychainRequest): Promise<Extract<KeychainReply, { ok: true }>> {
    if (!request.account || request.account.length > 1024) throw new TypeError("Invalid Keychain account");
    const reply = await this.#transport(request);
    if (!reply.ok) throw new Error(`macOS Keychain operation failed (OSStatus ${reply.code})`);
    return reply;
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
