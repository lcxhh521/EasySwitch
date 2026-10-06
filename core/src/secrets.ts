import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SERVICE = "EasySwitch";

/** Provider API keys live in the macOS Keychain, never in our JSON files. */
export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const PREFIX = "b64:";

/** What is written to the Keychain: plain ASCII text, so `security -w` hands it back as it was (it prints anything else as hex). */
export function encodeSecret(value: string): string {
  return PREFIX + Buffer.from(value, "utf8").toString("base64");
}

/** What was read: our own encoding is undone; a value written by an older version has no prefix and is returned as it is. */
export function decodeSecret(stored: string): string {
  return stored.startsWith(PREFIX) ? Buffer.from(stored.slice(PREFIX.length), "base64").toString("utf8") : stored;
}

/** One line for `security -i`: names are double-quoted (only `\` and `"` need escaping inside), the value is base64 and needs no quoting. */
export function keychainSetCommand(service: string, account: string, value: string): string {
  const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${encodeSecret(value)}\n`;
}

/**
 * Keychain through the `security` tool. The value is sent on its standard input (`security -i`), never as a
 * command-line argument, so it is not in the process list while it is being written.
 */
class KeychainStore implements SecretStore {
  async get(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
      return decodeSecret(stdout.replace(/\n$/, ""));
    } catch {
      return undefined;
    }
  }

  async set(account: string, value: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("security", ["-i"], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", d => (output += d));
      child.stderr.on("data", d => (output += d));
      child.on("error", reject);
      child.on("close", code => (code === 0 && !/^security:|error/i.test(output.trim()) ? resolve() : reject(new Error("没能写入钥匙串"))));
      child.stdin.end(keychainSetCommand(SERVICE, account, value));
    });
  }

  async delete(account: string): Promise<void> {
    try {
      await run("security", ["delete-generic-password", "-s", SERVICE, "-a", account]);
    } catch {
      // Already absent.
    }
  }
}

/** Tests and CI: nothing touches the user's Keychain. */
class MemoryStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(account: string) { return this.values.get(account); }
  async set(account: string, value: string) { this.values.set(account, value); }
  async delete(account: string) { this.values.delete(account); }
}

export function createSecretStore(): SecretStore {
  return process.env.EASYSWITCH_SECRETS === "memory" ? new MemoryStore() : new KeychainStore();
}
