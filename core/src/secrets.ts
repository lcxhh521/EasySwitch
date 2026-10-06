import { NativeKeychainStore } from "./native-keychain.ts";

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

/** Pure compatibility formatter for older clients; production never runs the security CLI. */
export function keychainSetCommand(service: string, account: string, value: string): string {
  const quote = (text: string) => `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${encodeSecret(value)}\n`;
}

/**
 * Decode existing EasySwitch values at the storage boundary, leaving the native
 * bridge byte-preserving. New values retain the b64: format so earlier versions
 * can still read them; unprefixed legacy values need no migration.
 * A failed lookup is never confused with a missing key.
 */
export class EncodedSecretStore implements SecretStore {
  #raw: SecretStore;
  constructor(raw: SecretStore) { this.#raw = raw; }
  async get(account: string): Promise<string | undefined> {
    const stored = await this.#raw.get(account);
    return stored === undefined ? undefined : decodeSecret(stored);
  }
  async set(account: string, value: string): Promise<void> { await this.#raw.set(account, encodeSecret(value)); }
  async delete(account: string): Promise<void> { await this.#raw.delete(account); }
}

/** Tests and CI: nothing touches the user's Keychain. */
class MemoryStore implements SecretStore {
  private readonly values = new Map<string, string>();
  async get(account: string) { return this.values.get(account); }
  async set(account: string, value: string) { this.values.set(account, value); }
  async delete(account: string) { this.values.delete(account); }
}

export function createSecretStore(): SecretStore {
  // A test run never reaches the person's real Keychain (which can raise system prompts and leave entries behind) unless that test says so with EASYSWITCH_TEST_KEYCHAIN=1.
  const underTest = process.env.NODE_TEST_CONTEXT !== undefined && process.env.EASYSWITCH_TEST_KEYCHAIN !== "1";
  return process.env.EASYSWITCH_SECRETS === "memory" || underTest ? new MemoryStore() : new EncodedSecretStore(new NativeKeychainStore());
}
