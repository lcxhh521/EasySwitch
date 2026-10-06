import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { cliTextBinaryIssue, cliTextProcessIssue, cliTextProxyEnv, executeCliTextProcess, MAX_CLI_TEXT_CONCURRENT, type CliTextProcessInput } from "../src/cli-text-process.ts";
import { executeQoder } from "../src/qoder-text-bridge.ts";
import { executeCodeBuddy } from "../src/codebuddy-text-bridge.ts";
import { ProtocolError } from "../src/protocol.ts";

const input = (over: Partial<CliTextProcessInput> = {}): CliTextProcessInput => ({ binary: "/not-read/qoder", args: [], env: {}, stdin: "hello", cwd: "/not-read", signal: new AbortController().signal, timeoutMs: 1_000, maxOutputBytes: 4, ...over });
function fakeChild(closeOnKill = true) {
  const kills: string[] = [];
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: 999_999,
    kill(signal: string) { kills.push(signal); if (closeOnKill) queueMicrotask(() => child.emit("close", null)); return true; }, unref() {} });
  return { child, kills, spawn: (() => child) as never };
}

test("binary creation validation is basename-bound and checks injected file metadata without reading or running files", async () => {
  let inspections = 0;
  const good = { realPath: "/installed/package/cli.js", isFile: true, executable: true, mode: 0o755 };
  const inspect = async () => { inspections++; return good; };
  assert.equal(await cliTextBinaryIssue("/chosen/qodercli", "Qoder", inspect), undefined);
  assert.equal(await cliTextBinaryIssue("/chosen/codebuddy", "CodeBuddy", inspect), undefined);
  for (const path of ["qoder", "/chosen/sh", "/chosen/codebuddy", "/chosen/qoder\n"]) assert.ok(await cliTextBinaryIssue(path, "Qoder", inspect));
  assert.equal(inspections, 2, "invalid names fail before metadata access");
  for (const over of [{ isFile: false }, { executable: false }, { mode: 0o777 }, { realPath: "relative" }]) {
    assert.ok(await cliTextBinaryIssue("/chosen/qoder", "Qoder", async () => ({ ...good, ...over })));
  }
  assert.ok(await cliTextBinaryIssue("/chosen/qoder", "Qoder", async () => { throw new Error("sensitive filesystem details"); }));
  assert.equal(cliTextProcessIssue({ binary: "/chosen/qoder" }, "Qoder"), undefined, "pure schema checks do not inspect an absent path");
});

test("proxy forwarding permits routing variables only and does not weaken TLS or inherit credentials", () => {
  assert.deepEqual(cliTextProxyEnv({ HTTP_PROXY: "http://proxy.invalid", https_proxy: "http://proxy.invalid", NO_PROXY: "localhost", ALL_PROXY: "socks5://proxy.invalid", http_proxy: "bad\nvalue", NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_OPTIONS: "--require=bad", CODEBUDDY_AUTH_TOKEN: "secret" }),
    { HTTP_PROXY: "http://proxy.invalid", ALL_PROXY: "socks5://proxy.invalid", NO_PROXY: "localhost", https_proxy: "http://proxy.invalid" });
});

test("one global cap bounds Qoder and CodeBuddy together and releases slots after exit", async () => {
  const children = Array.from({ length: MAX_CLI_TEXT_CONCURRENT }, () => fakeChild());
  const pending = children.map((fake, index) => (index % 2 ? executeCodeBuddy : executeQoder)(input(), fake.spawn));
  let spawned = false;
  await assert.rejects(executeCodeBuddy(input(), (() => { spawned = true; throw new Error(); }) as never), (e: unknown) => e instanceof ProtocolError && e.status === 429);
  assert.equal(spawned, false);
  for (const { child } of children) { child.stdout.write("ok"); child.emit("close", 0); }
  assert.deepEqual(await Promise.all(pending), children.map(() => ({ exitCode: 0, stdout: "ok" })));
  const next = fakeChild(); const done = executeQoder(input(), next.spawn); next.child.emit("close", 0); await done;
});

test("stdout and stderr have independent byte quotas and stderr is never returned", async () => {
  const fake = fakeChild(); const done = executeQoder(input(), fake.spawn);
  fake.child.stdout.write("abcd"); fake.child.stderr.write("wxyz"); fake.child.emit("close", 0);
  assert.deepEqual(await done, { exitCode: 0, stdout: "abcd" }); assert.deepEqual(fake.kills, []);
  for (const stream of ["stdout", "stderr"] as const) {
    const over = fakeChild(); const fail = executeQoder(input(), over.spawn); over.child[stream].write("secret too long");
    await assert.rejects(fail, (e: unknown) => e instanceof ProtocolError && e.status === 502 && !e.message.includes("secret"));
  }
});

test("a killed parent whose grandchild never closes pipes still reaches a bounded terminal result", { timeout: 2_000 }, async () => {
  const fake = fakeChild(false);
  await assert.rejects(executeQoder(input({ timeoutMs: 10 }), fake.spawn), (e: unknown) => e instanceof ProtocolError && e.status === 504);
  assert.deepEqual(fake.kills, ["SIGKILL"]);
  assert.ok(fake.child.stdin.destroyed && fake.child.stdout.destroyed && fake.child.stderr.destroyed);
  assert.equal(fake.child.stdout.listenerCount("data"), 0);
  const next = fakeChild(); const done = executeCodeBuddy(input(), next.spawn); next.child.emit("close", 0); await done;
});

test("owned process groups can be terminated through an injected signal function without any OS process access", { timeout: 2_000 }, async () => {
  if (process.platform === "win32") return;
  const fake = fakeChild(false); const groups: number[] = [];
  await assert.rejects(executeCliTextProcess(input({ timeoutMs: 10 }), "Qoder", fake.spawn, pid => groups.push(pid)), (e: unknown) => e instanceof ProtocolError && e.status === 504);
  assert.deepEqual(groups, [fake.child.pid]); assert.deepEqual(fake.kills, []);
});

test("spawn failures and pre-cancelled requests never leak global process slots", async () => {
  for (let index = 0; index < MAX_CLI_TEXT_CONCURRENT + 2; index++) {
    await assert.rejects(executeCodeBuddy(input(), (() => { throw new Error("sensitive spawn info"); }) as never), (e: unknown) => e instanceof ProtocolError && e.status === 503 && !e.message.includes("sensitive"));
  }
  await assert.rejects(executeQoder(input({ signal: AbortSignal.abort() }), (() => { assert.fail("must not spawn"); }) as never), (e: unknown) => e instanceof ProtocolError && e.status === 499);
});
