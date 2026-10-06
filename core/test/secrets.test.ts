import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSecretStore, decodeSecret, encodeSecret, EncodedSecretStore, keychainSetCommand, type SecretStore } from "../src/secrets.ts";

const AWKWARD = '{"k":"line1\nline2","q":"quote\\" and backslash \\\\ and 中文 and $dollar `tick` and \'single\'"}';

test("a secret is stored as plain ASCII text and comes back exactly, whatever characters it has; an old unprefixed value is read as it is", () => {
  const stored = encodeSecret(AWKWARD);
  assert.match(stored, /^b64:[A-Za-z0-9+/=]+$/, "nothing the Keychain tool would print as hex or a shell would mangle");
  assert.equal(decodeSecret(stored), AWKWARD);
  assert.equal(decodeSecret(encodeSecret("")), "");
  assert.equal(decodeSecret("sk-an-old-key-written-before"), "sk-an-old-key-written-before", "values written by an earlier version still read");
  assert.equal(decodeSecret("0123456789abcdef".repeat(4)), "0123456789abcdef".repeat(4), "an old value that only looks like hex is not touched");
});

test("the Keychain command carries the value only inside the text sent on standard input, with the names quoted", () => {
  const line = keychainSetCommand("EasySwitch", 'acct:with#odd"chars\\', "sk-secret-value");
  assert.ok(line.endsWith("\n") && line.split("\n").length === 2, "one command, one line");
  assert.match(line, /^add-generic-password -U -s "EasySwitch" -a "acct:with#odd\\"chars\\\\" -w b64:[A-Za-z0-9+/=]+\n$/);
  assert.ok(!line.includes("sk-secret-value"), "the value is not in the line in the clear");
  assert.equal(decodeSecret(line.trim().split(" -w ")[1]!), "sk-secret-value");
});


test("the codec reads raw legacy and b64 values without modifying stored bytes", async () => {
  const values = new Map([
    ["legacy", "sk-legacy-\n\u0000密钥"],
    ["remote", encodeSecret(AWKWARD)],
    ["empty-raw", ""],
    ["empty-encoded", encodeSecret("")],
  ]);
  const before = [...values];
  const raw: SecretStore = {
    async get(account) { return values.get(account); },
    async set(account, value) { values.set(account, value); },
    async delete(account) { values.delete(account); },
  };
  const store = new EncodedSecretStore(raw);
  assert.equal(await store.get("legacy"), "sk-legacy-\n\u0000密钥");
  assert.equal(await store.get("remote"), AWKWARD);
  assert.equal(await store.get("empty-raw"), "");
  assert.equal(await store.get("empty-encoded"), "");
  assert.equal(await store.get("missing"), undefined);
  assert.deepEqual([...values], before, "reads do not rewrite legacy records");
});

test("codec writes remain readable by the existing b64 decoder and delete uses the original account", async () => {
  const values = new Map<string, string>();
  const deleted: string[] = [];
  const raw: SecretStore = {
    async get(account) { return values.get(account); },
    async set(account, value) { values.set(account, value); },
    async delete(account) { deleted.push(account); values.delete(account); },
  };
  const store = new EncodedSecretStore(raw);
  const account = 'acct:with#odd"chars\\';
  for (const value of [AWKWARD, "", "fake\n\u0000密钥", "b64:literal-user-secret"]) {
    await store.set(account, value);
    assert.equal(values.get(account), encodeSecret(value));
    assert.equal(decodeSecret(values.get(account)!), value, "previous versions read new stored values");
    assert.equal(await store.get(account), value);
  }
  await store.delete(account);
  assert.deepEqual(deleted, [account]);
  assert.equal(await store.get(account), undefined);
});

test("codec preserves unavailable and denied errors instead of treating them as missing", async () => {
  const unavailable = new Error("Native Keychain helper is unavailable; build it on macOS first");
  const denied = new Error("macOS Keychain operation failed (OSStatus -25308)");
  const raw: SecretStore = {
    async get(account) { if (account === "missing") return undefined; throw account === "unavailable" ? unavailable : denied; },
    async set() { throw denied; },
    async delete() { throw denied; },
  };
  const store = new EncodedSecretStore(raw);
  assert.equal(await store.get("missing"), undefined);
  await assert.rejects(store.get("unavailable"), error => error === unavailable);
  await assert.rejects(store.get("denied"), error => error === denied);
  await assert.rejects(store.set("denied", "fake-secret"), error => error === denied);
  await assert.rejects(store.delete("denied"), error => error === denied);
});

// The real Keychain is only touched when asked for: it is the person's own.
test("the real macOS Keychain keeps a secret exactly, updates it in place and forgets it", { skip: process.env.EASYSWITCH_TEST_KEYCHAIN !== "1" || process.platform !== "darwin" }, async () => {
  const saved = process.env.EASYSWITCH_SECRETS;
  delete process.env.EASYSWITCH_SECRETS;
  const store = createSecretStore();
  process.env.EASYSWITCH_SECRETS = saved ?? "memory";
  const account = `selftest-${randomUUID()}`;
  try {
    await store.set(account, AWKWARD);
    assert.equal(await store.get(account), AWKWARD);
    await store.set(account, "x".repeat(2400));
    assert.equal(await store.get(account), "x".repeat(2400), "updated in place, a long value too");
  } finally { await store.delete(account); }
  assert.equal(await store.get(account), undefined, "gone");
});
