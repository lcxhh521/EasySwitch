import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createSecretStore, decodeSecret, encodeSecret, keychainSetCommand } from "../src/secrets.ts";

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
