import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_LAUNCH_TTL, DEFAULT_MANUAL_TTL, GatewayIssuanceLimitError, GatewaySessionStoreError, GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { LAUNCHERS, runHeadless } from "../src/agent-launch.ts";

function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-auth-persistence-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, stateFile: join(dir, "gateway-sessions.jsonl") };
}
const headers = (token: string) => ({ authorization: `Bearer ${token}` });

test("persistent capabilities survive restart with identical scopes and fixed expiry, storing only token hashes", t => {
  const { stateFile } = fixture(t); let now = Date.parse("2026-10-06T00:00:00Z");
  const first = new GatewayTokenAuthority({ stateFile, now: () => now });
  const issued = first.issue("qwen-code", { allowMcp: true, depth: 2, ttlMs: 3 * 86400_000 });
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
  const saved = readFileSync(stateFile, "utf8");
  assert.ok(!saved.includes(issued.token)); assert.ok(!saved.includes("es-session-"));
  assert.ok(saved.includes(createHash("sha256").update(issued.token).digest("hex")));
  now += 2 * 86400_000;
  const restarted = new GatewayTokenAuthority({ stateFile, now: () => now });
  const session = restarted.authenticate(headers(issued.token), undefined, "mcp");
  assert.equal(session?.id, issued.id); assert.equal(session.depth, 2); assert.equal(session.expiresAt, issued.expiresAt);
  assert.equal(session.allowNativeClaude, false);
  assert.ok(!JSON.stringify(restarted.list()).includes(createHash("sha256").update(issued.token).digest("hex")));
  assert.equal(readFileSync(stateFile, "utf8"), saved, "authentication does not extend or rewrite the lease");
});

test("restart persistence preserves the 24-hour default; a longer bounded lifetime needs an explicit ttlMs", t => {
  const { stateFile } = fixture(t); let now = Date.parse("2026-10-06T00:00:00Z");
  const authority = new GatewayTokenAuthority({ stateFile, now: () => now });
  const launch = authority.issue("codex"), manual = authority.issueManual("claude");
  for (const session of [launch, manual]) assert.equal(Date.parse(session.expiresAt) - Date.parse(session.issuedAt), 86400_000);
  assert.equal(DEFAULT_LAUNCH_TTL, 86400_000); assert.equal(DEFAULT_MANUAL_TTL, 86400_000);
  now += 86400_000;
  const restarted = new GatewayTokenAuthority({ stateFile, now: () => now });
  assert.equal(restarted.authenticate(headers(launch.token)), undefined);
  assert.equal(restarted.authenticate(headers(manual.token)), undefined);
  assert.deepEqual(restarted.list(), []);
});

test("revocation and clear survive stale authorities and later restart without resurrecting old tokens", t => {
  const { stateFile } = fixture(t);
  const first = new GatewayTokenAuthority({ stateFile }); const a = first.issue("codex");
  const stale = new GatewayTokenAuthority({ stateFile }); assert.ok(stale.authenticate(headers(a.token)));
  assert.equal(first.revokeId(a.id), true); assert.equal(first.revokeId(a.id), false);
  const b = stale.issue("claude");
  assert.equal(stale.authenticate(headers(a.token)), undefined);
  const again = new GatewayTokenAuthority({ stateFile });
  assert.equal(again.authenticate(headers(a.token)), undefined); assert.ok(again.authenticate(headers(b.token)));
  first.clear(); assert.equal(again.authenticate(headers(b.token)), undefined);
  const c = again.issue("dsh");
  const final = new GatewayTokenAuthority({ stateFile });
  assert.equal(final.authenticate(headers(a.token)), undefined); assert.equal(final.authenticate(headers(b.token)), undefined);
  assert.ok(final.authenticate(headers(c.token)));
});

test("manual active caps reserve capacity for launchers and revoked manual sessions do not erase rate limits", t => {
  const { stateFile } = fixture(t); let now = Date.parse("2026-10-06T00:00:00Z");
  const options = { stateFile, now: () => now, maxSessions: 4, maxManualSessions: 2, maxManualPerAgent: 1, manualRateLimit: 2 };
  const authority = new GatewayTokenAuthority(options);
  const one = authority.issueManual("codex");
  assert.throws(() => authority.issueManual("codex"), GatewayIssuanceLimitError);
  authority.issueManual("claude");
  assert.throws(() => authority.issueManual("dsh"), GatewayIssuanceLimitError);
  assert.ok(authority.issue("hermes")); assert.ok(authority.issue("dsh"));
  authority.revoke(one.token);
  const two = authority.issueManual("codex"); authority.revoke(two.token);
  const restarted = new GatewayTokenAuthority(options);
  assert.throws(() => restarted.issueManual("codex"), (error: unknown) => error instanceof GatewayIssuanceLimitError && error.status === 429);
  now += 60_000;
  assert.ok(restarted.issueManual("codex"));
});

test("corrupt, truncated and foreign-format persistence fails closed without overwriting or reissuing", t => {
  const { dir } = fixture(t);
  for (const [index, content] of ["not json\n", '{"version":9}\n', '{"version":1}\n{"op":"issue"', '{"version":1}\n{"op":"clear","token":"must-not-be-loaded"}\n'].entries()) {
    const stateFile = join(dir, `bad-${index}.jsonl`); writeFileSync(stateFile, content, { mode: 0o600 });
    const authority = new GatewayTokenAuthority({ stateFile });
    assert.equal(authority.authenticate(headers("es-session-codex-" + "a".repeat(64))), undefined);
    assert.throws(() => authority.issue("codex"), GatewaySessionStoreError);
    assert.throws(() => authority.list(), GatewaySessionStoreError);
    assert.equal(readFileSync(stateFile, "utf8"), content);
  }
});

test("an issue record cannot be replayed after revoke or expiry as a migration shortcut", t => {
  const { stateFile } = fixture(t);
  const first = new GatewayTokenAuthority({ stateFile }); const issued = first.issue("codex");
  const issueLine = readFileSync(stateFile, "utf8").split("\n")[1]!;
  first.revoke(issued.token); appendFileSync(stateFile, issueLine + "\n");
  const reopened = new GatewayTokenAuthority({ stateFile });
  assert.equal(reopened.authenticate(headers(issued.token)), undefined);
  assert.throws(() => reopened.issue("claude"), GatewaySessionStoreError);
});

test("unsafe permissions, symlinks and replacement of a live journal are rejected", t => {
  const { dir, stateFile } = fixture(t);
  const authority = new GatewayTokenAuthority({ stateFile }); const issued = authority.issue("codex");
  const link = join(dir, "linked.jsonl"); symlinkSync(stateFile, link);
  assert.throws(() => new GatewayTokenAuthority({ stateFile: link }).issue("claude"), GatewaySessionStoreError);
  if (process.platform !== "win32") {
    chmodSync(stateFile, 0o644);
    assert.equal(authority.authenticate(headers(issued.token)), undefined);
    assert.throws(() => new GatewayTokenAuthority({ stateFile }).issue("claude"), GatewaySessionStoreError);
    chmodSync(stateFile, 0o600);
  }
  const live = new GatewayTokenAuthority({ stateFile }); const saved = join(dir, "replacement.jsonl"); copyFileSync(stateFile, saved);
  rmSync(stateFile); copyFileSync(saved, stateFile); chmodSync(stateFile, 0o600);
  assert.equal(live.authenticate(headers(issued.token)), undefined, "a live reader never trusts an unexplained inode replacement");
});

test("missing or truncated established journals never silently reset an authority", t => {
  const { stateFile } = fixture(t);
  const authority = new GatewayTokenAuthority({ stateFile }); const issued = authority.issue("codex");
  rmSync(stateFile);
  assert.equal(authority.authenticate(headers(issued.token)), undefined);
  assert.throws(() => authority.issue("claude"), GatewaySessionStoreError);
});

test("in-place edits of an already-read journal are not hidden by the incremental cache", t => {
  const { stateFile } = fixture(t); const authority = new GatewayTokenAuthority({ stateFile });
  const issued = authority.issue("codex");
  const old = readFileSync(stateFile, "utf8"); writeFileSync(stateFile, "!" + old.slice(1));
  assert.equal(authority.authenticate(headers(issued.token)), undefined);
  assert.throws(() => authority.issue("claude"), GatewaySessionStoreError);
});

test("headless private files are removed even when durable revocation fails", async () => {
  const authority = new GatewayTokenAuthority(); let dir = "";
  LAUNCHERS["fixture-auth-storage"] = { verified: false, headless: i => { dir = i.sessionDir; return { command: "/never-run", args: [], env: {} }; } };
  try {
    await assert.rejects(runHeadless("fixture-auth-storage", { bin: "/never-run", port: 1, model: "p/m" }, {
      signal: AbortSignal.abort(), gatewayAuth: { issue: (agent, options) => authority.issue(agent, options), revoke: () => { throw new GatewaySessionStoreError(); } },
    }), GatewaySessionStoreError);
    assert.ok(dir); assert.ok(!existsSync(dir));
  } finally { delete LAUNCHERS["fixture-auth-storage"]; }
});

test("storage write failure never returns an unpersisted token or falls back to memory issuance", t => {
  const { dir } = fixture(t); const parent = join(dir, "not-a-directory"); writeFileSync(parent, "fixture");
  const authority = new GatewayTokenAuthority({ stateFile: join(parent, "state.jsonl") });
  assert.throws(() => authority.issue("codex"), GatewaySessionStoreError);
  assert.throws(() => authority.issueManual("codex"), GatewaySessionStoreError);
});

test("legacy stable and signed tokens are never migrated into the persistent authority", t => {
  const { stateFile } = fixture(t); const authority = new GatewayTokenAuthority({ stateFile });
  authority.issue("claude");
  for (const token of ["es-session-codex-stable-" + "a".repeat(20), "es-session-codex-private", "es-session-codex-" + "a".repeat(64)]) {
    assert.equal(authority.authenticate(headers(token)), undefined);
    assert.equal(new GatewayTokenAuthority({ stateFile }).authenticate(headers(token)), undefined);
  }
});
