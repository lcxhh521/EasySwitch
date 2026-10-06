import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createKeychainTransport, keychainHelperHealth, keychainSigningRequirement, keychainOperationError, KEYCHAIN_RETRY_DELAY_MS, NativeKeychainError, NativeKeychainStore, type KeychainRequest, type KeychainSpawn } from "../src/native-keychain.ts";
import { EncodedSecretStore } from "../src/secrets.ts";

function fakeSpawn(response: string, code: number | null = 0, options: { error?: boolean; neverFinish?: boolean } = {}) {
  const captured: { file?: string; argv?: string[]; options?: unknown; input: string; killed: boolean } = { input: "", killed: false };
  const spawn: KeychainSpawn = (file, argv, spawnOptions) => {
    captured.file = file; captured.argv = argv; captured.options = spawnOptions;
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    child.stdin = stdin; child.stdout = stdout; child.stderr = stderr;
    child.kill = () => { captured.killed = true; return true; };
    child.stdin.on("data", chunk => { captured.input += chunk.toString(); });
    child.stdin.on("finish", () => queueMicrotask(() => {
      if (options.neverFinish) return;
      if (options.error) child.emit("error", new Error("must-not-leak-input"));
      else { stderr.write("must-not-leak-input"); stdout.write(response); stdout.end(); child.emit("close", code, null); }
    }));
    return child;
  };
  return { captured, spawn };
}

test("native Keychain transport sends credentials only through stdin, never argv/env or files", async () => {
  const { captured, spawn } = fakeSpawn('{"ok":true}');
  const transport = createKeychainTransport("/fixture/easyswitch-keychain", spawn);
  const value = "fake-secret-with-quote-\"\n-nul-\u0000-unicode-密钥";
  await transport({ operation: "set", account: "provider-1", value });
  assert.deepEqual(JSON.parse(captured.input), { operation: "set", account: "provider-1", value });
  assert.deepEqual(captured.argv, []);
  assert.equal(captured.file, "/fixture/easyswitch-keychain");
  assert.equal(JSON.stringify(captured.options).includes(value), false);
  assert.deepEqual(captured.options, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  assert.equal(captured.killed, false);
});

test("native Keychain store preserves exact secret bytes and distinguishes missing from denial", async () => {
  const calls: KeychainRequest[] = [];
  const value = "fake-secret\n\u0000密钥";
  const store = new NativeKeychainStore(async request => {
    calls.push(request);
    return request.operation === "get" ? { ok: true, found: true, value } : { ok: true };
  });
  assert.equal(await store.get("source"), value);
  await store.set("source", value);
  await store.delete("source");
  assert.deepEqual(calls, [{ operation: "get", account: "source" }, { operation: "set", account: "source", value }, { operation: "delete", account: "source" }]);
  assert.equal(await new NativeKeychainStore(async () => ({ ok: true, found: false })).get("absent"), undefined);
  await assert.rejects(new NativeKeychainStore(async () => ({ ok: false, code: -25308 })).get("locked"), /OSStatus -25308/);
  await assert.rejects(new NativeKeychainStore(async () => ({ ok: true })).get("bad-response"), /invalid lookup/);
});

test("native helper failures are sanitized and never include stderr or credentials", async () => {
  for (const mock of [fakeSpawn("must-not-leak-input"), fakeSpawn('{"ok":true}', 1), fakeSpawn("", 0, { error: true }), fakeSpawn('{"ok":true,"value":42}'), fakeSpawn('{"ok":false,"code":"secret"}')]) {
    await assert.rejects(createKeychainTransport("/fixture/helper", mock.spawn)({ operation: "set", account: "test", value: "must-not-leak-input" }), error => {
      assert.equal(String(error).includes("must-not-leak-input"), false);
      return true;
    });
    assert.equal(mock.captured.killed, true);
  }
});

test("native helper I/O is bounded and stalled helpers are terminated", async () => {
  const large = fakeSpawn("x".repeat(1_048_577));
  await assert.rejects(createKeychainTransport("/fixture/helper", large.spawn)({ operation: "get", account: "x" }), /too large/);
  assert.equal(large.captured.killed, true);
  const request = fakeSpawn('{"ok":true}');
  await assert.rejects(createKeychainTransport("/fixture/helper", request.spawn)({ operation: "set", account: "x", value: "x".repeat(1_048_577) }), /too large/);
  assert.equal(request.captured.file, undefined, "oversized input does not spawn a helper");
  const stalled = fakeSpawn("", 0, { neverFinish: true });
  await assert.rejects(createKeychainTransport("/fixture/helper", stalled.spawn, 5)({ operation: "get", account: "x" }), /timed out/);
  assert.equal(stalled.captured.killed, true);
});

test("native helper source uses Security.framework and production never falls back to argv secrets", () => {
  const source = readFileSync(new URL("../native/keychain.swift", import.meta.url), "utf8");
  for (const api of ["import Security", "SecItemCopyMatching", "SecItemUpdate", "SecItemAdd", "SecItemDelete", '"EasySwitch"']) assert.ok(source.includes(api));
  const bridge = readFileSync(new URL("../src/secrets.ts", import.meta.url), "utf8");
  assert.match(bridge, /new NativeKeychainStore/);
  assert.doesNotMatch(bridge, /node:child_process|\b(?:execFile|exec|spawn)(?:Sync)?\s*\(|find-generic-password/);
  const transport = readFileSync(new URL("../src/native-keychain.ts", import.meta.url), "utf8");
  assert.doesNotMatch(transport, /find-generic-password|add-generic-password|delete-generic-password|["']-w["']/);
  assert.doesNotMatch(transport, /(?:execFile|spawn)(?:Sync)?\s*\(\s*["'](?:\/usr\/bin\/)?security["']/);
  assert.match(transport, /spawnChild\(helper, \[\],/);
  assert.match(transport, /child\.stdin\.end\(input\)/);
});

test("health reports helper absence, permissions and signing without touching Keychain", () => {
  let verified = 0;
  const file = () => ({ executable: true, stamp: "fixture" });
  const verify = () => { verified++; return true; };
  const absent = keychainHelperHealth("/fixture/helper", { platform: "darwin", file: () => undefined, verify });
  assert.equal(absent.status, "helper_missing"); assert.equal(absent.ready, false); assert.equal(verified, 0);
  assert.equal(keychainHelperHealth("/fixture/helper", { platform: "darwin", file: () => ({ executable: false, stamp: "fixture" }), verify }).status, "helper_not_executable");
  assert.equal(verified, 0);
  assert.equal(keychainHelperHealth("/fixture/helper", { platform: "darwin", file, verify: () => false }).status, "helper_signature_invalid");
  const ready = keychainHelperHealth("/fixture/helper", { platform: "darwin", file, verify });
  assert.equal(ready.ready, true); assert.equal(ready.status, "helper_ready"); assert.equal(ready.keychainChecked, false);
  assert.equal(verified, 1);
  assert.equal(keychainHelperHealth("/fixture/helper", { platform: "linux", file: () => { throw new Error("must not read filesystem"); } }).status, "unsupported_platform");
});

test("passive helper health uses only unchanged cached verification and never invokes a verifier", () => {
  let stamp = "cold", verified = 0, valid = true;
  const inspection = { platform: "darwin", file: () => ({ executable: true, stamp }), verify: () => { verified++; return valid; } };
  const read = (passive: boolean) => keychainHelperHealth("/fixture/passive-helper", { ...inspection, passive });
  assert.equal(read(true).status, "helper_signature_unchecked");
  assert.equal(read(true).ready, false);
  assert.equal(verified, 0, "cold cache does not verify even with an injected verifier");
  assert.equal(read(false).status, "helper_ready");
  assert.equal(read(true).ready, true);
  assert.equal(verified, 1, "warm passive health reuses the matching file stamp");
  stamp = "changed";
  assert.equal(read(true).status, "helper_signature_unchecked");
  assert.equal(read(true).ready, false);
  assert.equal(verified, 1, "changed files cannot reuse trust or trigger automatic verification");
  valid = false;
  assert.equal(read(false).status, "helper_signature_invalid");
  assert.equal(read(true).status, "helper_signature_invalid");
  assert.equal(verified, 2, "a cached rejection remains a rejection without another process");
});

test("encoded and native stores pass passive health through without touching credentials", () => {
  let verified = 0, transported = 0;
  const raw = new NativeKeychainStore(async () => { transported++; return { ok: true, found: false }; }, {
    inspect: options => keychainHelperHealth("/fixture/passive-store", { ...options, platform: "darwin", file: () => ({ executable: true, stamp: "fixture" }), verify: () => { verified++; return true; } }),
  });
  const store = new EncodedSecretStore(raw);
  assert.equal(store.health({ passive: true }).status, "helper_signature_unchecked");
  assert.equal(verified, 0);
  assert.equal(store.health().ready, true, "an explicit ordinary check still verifies the signature");
  assert.equal(verified, 1);
  assert.equal(store.health({ passive: true }).ready, true);
  assert.equal(verified, 1);
  assert.equal(transported, 0, "status reads never invoke the credential transport");
});

test("missing default Keychain and denied legacy access have actionable secret-free failures", async () => {
  for (const [status, expected] of [[-25307, "no_default_keychain"], [-25294, "keychain_unavailable"], [-25291, "keychain_unavailable"], [-25308, "keychain_access_required"], [-25293, "keychain_access_required"], [-128, "keychain_access_required"]] as const) {
    const failure = keychainOperationError(status);
    assert.equal(failure.code, expected); assert.equal(failure.osStatus, status);
    assert.match(failure.message, new RegExp(`OSStatus ${status}`));
    const store = new NativeKeychainStore(async () => ({ ok: false, code: status }));
    await assert.rejects(store.get("private-account-name"), e => e instanceof NativeKeychainError && e.code === expected && !e.message.includes("private-account-name"));
  }
});

test("failed background operations cool down once, including concurrent reads, and recover after retry", async () => {
  let now = 0, calls = 0, blocked = true;
  const inspect = () => ({ backend: "native-keychain" as const, ready: true, status: "helper_ready", keychainChecked: false });
  const store = new NativeKeychainStore(async () => {
    calls++;
    return blocked ? { ok: false, code: -25307 } : { ok: true, found: true, value: "fake-recovered" };
  }, { now: () => now, inspect });
  const failures = await Promise.allSettled([store.get("a"), store.get("b"), store.set("c", "fake-secret")]);
  assert.ok(failures.every(f => f.status === "rejected")); assert.equal(calls, 1, "one failure must not spawn a helper for every catalog entry");
  const health = store.health();
  assert.equal(health.ready, false); assert.equal(health.status, "no_default_keychain"); assert.equal(health.keychainChecked, true);
  assert.ok(!JSON.stringify(health).includes("fake-secret"));
  blocked = false;
  await assert.rejects(store.get("a")); assert.equal(calls, 1);
  now = KEYCHAIN_RETRY_DELAY_MS;
  assert.equal(await store.get("a"), "fake-recovered"); assert.equal(calls, 2);
  assert.equal(store.health().ready, true); assert.equal(store.health().osStatus, undefined);
});

test("timeouts and unexpected transport failures are sanitized, cooled down and visible in health", async () => {
  let calls = 0;
  const inspect = () => ({ backend: "native-keychain" as const, ready: true, status: "helper_ready", keychainChecked: false });
  const store = new NativeKeychainStore(async () => { calls++; throw new Error("fake-secret-echo"); }, { inspect });
  for (let i = 0; i < 2; i++) await assert.rejects(store.get("sensitive-account"), e => e instanceof NativeKeychainError && e.code === "helper_failed" && !e.message.includes("fake-secret-echo"));
  assert.equal(calls, 1); assert.equal(store.health().keychainChecked, false);
  assert.equal(JSON.stringify(store.health()).includes("sensitive-account"), false);
  const stalled = fakeSpawn("", 0, { neverFinish: true });
  const timed = new NativeKeychainStore(createKeychainTransport("/fixture/helper", stalled.spawn, 5), { inspect });
  await assert.rejects(timed.get("x"), e => e instanceof NativeKeychainError && e.code === "helper_timeout");
  assert.equal(timed.health().status, "helper_timeout");
});

test("native source fails noninteractively before accessing absent default Keychains", () => {
  const source = readFileSync(new URL("../native/keychain.swift", import.meta.url), "utf8");
  assert.match(source, /SecKeychainSetUserInteractionAllowed\(false\)/);
  assert.match(source, /SecKeychainCopyDefault\(&defaultKeychain\)/);
  assert.ok(source.indexOf("SecKeychainSetUserInteractionAllowed(false)") < source.indexOf("SecKeychainCopyDefault(&defaultKeychain)"));
  assert.ok(source.indexOf("SecKeychainCopyDefault(&defaultKeychain)") < source.indexOf("SecItemCopyMatching("));
  assert.doesNotMatch(source, /SecKeychain(?:Create|Unlock|SetDefault)|SecKeychainItemSetAccess|SecAccessCreate/);
});

test("helper build pins an existing certificate identity and never signs at background startup", () => {
  const script = readFileSync(new URL("../../scripts/build-keychain.sh", import.meta.url), "utf8");
  assert.match(script, /EASYSWITCH_KEYCHAIN_SIGN_IDENTITY/);
  assert.match(script, /IDENTIFIER=com\.easyswitch\.keychain/);
  assert.match(script, /certificate leaf = H/);
  assert.match(script, /codesign --force --sign "\$IDENTITY"/);
  assert.match(script, /codesign --verify --strict -R "\$REQUIREMENT"/);
  assert.doesNotMatch(script, /--sign\s+(?:-\s|["']-["'])|\|\|\s*true|security\s+(?:import|create-keychain|set-key-partition-list)/);
  assert.ok(script.indexOf("codesign --verify") < script.indexOf('mv -f "$HELPER"'), "a failed signature must not replace the working helper");
  const bridge = readFileSync(new URL("../src/native-keychain.ts", import.meta.url), "utf8");
  const ensure = bridge.slice(bridge.indexOf("export function ensureKeychainHelper"), bridge.indexOf("export function keychainOperationError"));
  assert.doesNotMatch(ensure, /exec|spawn|build-keychain/);
});


test("stable signing requirement parsing rejects ad-hoc, wrong identifiers and weakened alternatives", () => {
  const fingerprint = "a".repeat(40);
  const expected = `identifier "com.easyswitch.keychain" and certificate leaf = H"${fingerprint}"`;
  assert.equal(keychainSigningRequirement(`Executable=/fixture/helper\ndesignated => ${expected}\n`), expected);
  assert.equal(keychainSigningRequirement(`designated => certificate 0 = H"${fingerprint}" and identifier "com.easyswitch.keychain"`), expected);
  for (const text of [
    `designated => cdhash H"${fingerprint}"`,
    `designated => identifier "other.app" and certificate leaf = H"${fingerprint}"`,
    `designated => ${expected} or always`,
    `designated => identifier "com.easyswitch.keychain"`,
  ]) assert.equal(keychainSigningRequirement(text), undefined);
});
