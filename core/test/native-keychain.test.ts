import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createKeychainTransport, NativeKeychainStore, type KeychainRequest, type KeychainSpawn } from "../src/native-keychain.ts";

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
});
