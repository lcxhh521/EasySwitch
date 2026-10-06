/** In-memory fake children only. No vendor application, executable, account or OS process is touched. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ClaudeDesktopSession, prepareClaudeDesktopSession } from "../src/claude-desktop.ts";
import { GatewaySessionStoreError, GatewayTokenAuthority } from "../src/gateway-auth.ts";

const options = { executable: "/never-run/Claude", port: 1234, models: [{ id: "mock/echo" }], platform: "linux" as const, parentEnv: {} };
function brokenAuth() {
  const auth = new GatewayTokenAuthority(); let failing = true, attempts = 0;
  return { auth, recover: () => { failing = false; }, attempts: () => attempts,
    dependency: { issue: auth.issue.bind(auth), revoke(token: string) { attempts++; if (failing) throw new GatewaySessionStoreError(); return auth.revoke(token); } } };
}

test("desktop preparation failure still removes private files when revocation storage is unavailable", () => {
  const baseDir = mkdtempSync(join(realpathSync(tmpdir()), "es-desktop-auth-")); const f = brokenAuth();
  try {
    const label = { toJSON() { throw new Error("fixture serialization failure"); } } as unknown as string;
    assert.throws(() => prepareClaudeDesktopSession({ ...options, baseDir, gatewayAuth: f.dependency, models: [{ id: "mock/echo", label }] }), /未能持久撤销/);
    assert.deepEqual(readdirSync(baseDir), []); assert.ok(f.attempts() > 0);
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});

test("desktop exit callbacks never throw on failed revocation and still settle wait after directory cleanup", async () => {
  const f = brokenAuth(); const child = new EventEmitter();
  const session = new ClaudeDesktopSession({ ...options, gatewayAuth: f.dependency }, (() => { queueMicrotask(() => child.emit("spawn")); return child; }) as never);
  await session.start();
  assert.doesNotThrow(() => child.emit("exit", 0));
  assert.doesNotThrow(() => child.emit("close", 0, null));
  const status = await session.wait();
  assert.equal(status.cleaned, true); assert.equal(status.state, "failed");
  assert.match(status.revocationError!, /未能持久撤销/); assert.match(status.error!, /未确认/);
  assert.ok(!existsSync(session.directory));
  await assert.rejects(session.stop(), /未能持久撤销/);
  f.recover(); await session.stop(); assert.equal(session.status().revocationError, undefined); assert.equal(f.auth.list().length, 0);
});

test("desktop stop still signals only its owned fake process and cleans files before reporting revoke failure", async t => {
  const f = brokenAuth(); const child = Object.assign(new EventEmitter(), { pid: 424_242 }); let alive = true;
  const signals: Array<number | string | undefined> = [];
  t.mock.method(process, "kill", (pid: number, signal?: number | string) => {
    assert.equal(pid, -child.pid); signals.push(signal);
    if (!alive) throw Object.assign(new Error("fake missing group"), { code: "ESRCH" });
    if (signal !== 0) { alive = false; queueMicrotask(() => { child.emit("exit", 0); child.emit("close", 0, null); }); }
    return true;
  });
  const session = new ClaudeDesktopSession({ ...options, gatewayAuth: f.dependency }, (() => { queueMicrotask(() => child.emit("spawn")); return child; }) as never);
  await session.start();
  await assert.rejects(session.stop(0), /未能持久撤销/);
  assert.ok(signals.includes("SIGTERM")); assert.equal(session.status().cleaned, true); assert.ok(!existsSync(session.directory));
  assert.equal((await session.wait()).state, "failed");
});

test("desktop spawn-error callbacks retain both failures without leaking a prepared directory", async () => {
  const f = brokenAuth(); const child = new EventEmitter();
  const session = new ClaudeDesktopSession({ ...options, gatewayAuth: f.dependency }, (() => { queueMicrotask(() => { child.emit("error", new Error("fake startup")); child.emit("close", -1, null); }); return child; }) as never);
  await assert.rejects(session.start(), /未能持久撤销/);
  const status = await session.wait(); assert.equal(status.cleaned, true); assert.equal(status.state, "failed");
  assert.ok(!existsSync(session.directory)); assert.match(status.error!, /未能启动.*未能持久撤销/);
});

test("revocation failure never unblocks production desktop startup", async () => {
  const f = brokenAuth(); const session = prepareClaudeDesktopSession({ ...options, gatewayAuth: f.dependency });
  await assert.rejects(session.start(), /签名版.*忽略 CLAUDE_USER_DATA_DIR/);
  assert.equal(session.status().pid, undefined); assert.equal(session.status().cleaned, true);
  assert.match(session.status().revocationError!, /未能持久撤销/); assert.ok(!existsSync(session.directory));
});
