import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SERVICE = "EasySwitch";

/** Provider API keys live in the macOS Keychain, never in our JSON files. */
export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

/**
 * Keychain through the `security` tool. Known demo limitation: `-w <value>`
 * puts the key on that one process's argv for a moment. A native helper
 * using the Keychain API replaces this before anything ships.
 */
class KeychainStore implements SecretStore {
  async get(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"]);
      return stdout.replace(/\n$/, "");
    } catch {
      return undefined;
    }
  }

  async set(account: string, value: string): Promise<void> {
    await run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value]);
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
