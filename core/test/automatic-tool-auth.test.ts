import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GatewaySessionStoreError, GatewayTokenAuthority, type GatewaySession, type GatewayTokenOptions } from "../src/gateway-auth.ts";

// Synthetic, private fixtures only. These tests never contact a running gateway or upstream.
const marker = () => ({ version: 1 as const, poolId: "tools-pool_1", approvalId: "a".repeat(64) });
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-automatic-tool-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, stateFile: join(dir, "gateway-sessions.jsonl") };
}
function journalSession(): GatewaySession {
  return {
    id: randomUUID(), agentId: "opencode", depth: 0, allowMcp: false, allowNativeClaude: false, kind: "launch",
    issuedAt: "2026-10-22T00:00:00.000Z", expiresAt: "2026-10-23T00:00:00.000Z",
  };
}
const fixedNow = () => Date.parse("2026-10-22T12:00:00.000Z");
function writeJournal(stateFile: string, session: unknown): { token: string; content: string } {
  const token = `es-session-opencode-${randomBytes(32).toString("hex")}`;
  const content = '{"version":1}\n' + JSON.stringify({ op: "issue", hash: createHash("sha256").update(token).digest("hex"), session }) + "\n";
  writeFileSync(stateFile, content, { mode: 0o600 });
  return { token, content };
}

test("automatic tool mode is an explicit launch marker, not inferred from a token, agent or request header", () => {
  const authority = new GatewayTokenAuthority();
  const issued = authority.issue("opencode", { automaticTools: marker() });
  assert.deepEqual(issued.automaticTools, marker());
  assert.deepEqual(authority.authenticate(headers(issued.token))?.automaticTools, marker());
  assert.deepEqual(authority.list()[0]?.automaticTools, marker());
  assert.equal(authority.authenticate(headers(issued.token), undefined, "mcp"), undefined);
  const ordinary = authority.issue("opencode");
  const manual = authority.issueManual("opencode");
  for (const issued of [ordinary, manual]) {
    const session = authority.authenticate({ ...headers(issued.token), "x-easyswitch-automatic-tools": "1" });
    assert.ok(session);
    assert.equal(Object.hasOwn(session, "automaticTools"), false);
  }
});

test("automatic tool issuance rejects manual, other-agent, nested, MCP and native capabilities without issuing", () => {
  const authority = new GatewayTokenAuthority();
  const invalid = [
    () => authority.issueManual("opencode", { automaticTools: marker() }),
    ...["codex", "claude", "chat", "gemini-cli"].map(agent => () => authority.issue(agent, { automaticTools: marker() })),
    ...[1, 2].map(depth => () => authority.issue("opencode", { automaticTools: marker(), depth })),
    () => authority.issue("opencode", { automaticTools: marker(), allowMcp: true }),
    () => authority.issue("opencode", { automaticTools: marker(), allowNativeClaude: true }),
  ];
  for (const issue of invalid) assert.throws(issue, { name: "TypeError", message: /automatic tool/i });
  assert.deepEqual(authority.list(), []);
  assert.deepEqual(authority.issue("opencode", { automaticTools: marker(), depth: 0, allowMcp: false, allowNativeClaude: false }).automaticTools, marker());
});

const invalidMarkers: Array<{ label: string; value: unknown }> = [
  { label: "null", value: null },
  { label: "boolean", value: true },
  { label: "string", value: "automatic" },
  { label: "array", value: [marker()] },
  { label: "missing version", value: { poolId: "p", approvalId: "a".repeat(64) } },
  { label: "wrong version", value: { ...marker(), version: 2 } },
  { label: "coerced version", value: { ...marker(), version: "1" } },
  { label: "missing pool", value: { version: 1, approvalId: "a".repeat(64) } },
  ...["", " ", "../pool", "pool/name", "pool?x=y", "pool\n", "工具池", "a".repeat(129), 123].map(poolId => ({ label: `invalid pool ${typeof poolId}-${String(poolId).length}`, value: { ...marker(), poolId } })),
  { label: "missing approval", value: { version: 1, poolId: "p" } },
  ...["", "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), "a".repeat(63) + "\n", 123].map(approvalId => ({ label: `invalid approval ${typeof approvalId}-${String(approvalId).length}`, value: { ...marker(), approvalId } })),
  { label: "unexpected token field", value: { ...marker(), token: "synthetic-unwanted-value" } },
  { label: "unexpected key field", value: { ...marker(), key: "synthetic-unwanted-value" } },
  { label: "unexpected nested pin", value: { ...marker(), pin: {} } },
];
for (const [index, { label, value }] of invalidMarkers.entries()) {
  test(`automatic tool issuance strictly rejects marker ${index}: ${label}`, () => {
    const authority = new GatewayTokenAuthority();
    assert.throws(() => authority.issue("opencode", { automaticTools: value } as GatewayTokenOptions), { name: "TypeError", message: /automatic tool/i });
    assert.deepEqual(authority.list(), []);
  });
}

test("automatic tool markers reject accessor, inherited, hidden and symbol fields instead of running serialization hooks", () => {
  let accessed = false;
  const accessor = { ...marker() };
  Object.defineProperty(accessor, "approvalId", { enumerable: true, get() { accessed = true; return "a".repeat(64); } });
  const inherited = Object.create(marker());
  const hidden = Object.defineProperty(marker(), "secret", { value: "synthetic-only", enumerable: false });
  const symbol = { ...marker(), [Symbol("secret")]: "synthetic-only" };
  const hook = { ...marker(), toJSON() { accessed = true; return marker(); } };
  for (const value of [accessor, inherited, hidden, symbol, hook]) {
    assert.throws(() => new GatewayTokenAuthority().issue("opencode", { automaticTools: value }), { name: "TypeError", message: /automatic tool/i });
  }
  assert.equal(accessed, false);
});

test("automatic tool pool IDs accept bounded ASCII safe IDs without normalization", () => {
  const authority = new GatewayTokenAuthority();
  for (const poolId of ["a", "P0.z_1-2", "a".repeat(128)]) {
    const issued = authority.issue("opencode", { automaticTools: { ...marker(), poolId } });
    assert.equal(issued.automaticTools?.poolId, poolId);
  }
});

test("automatic tool issue input and every returned session are independent snapshots", () => {
  const original = marker();
  const options = { automaticTools: original };
  const authority = new GatewayTokenAuthority();
  const issued = authority.issue("opencode", options);
  original.poolId = "mutated-input";
  original.approvalId = "b".repeat(64);
  assert.deepEqual(issued.automaticTools, marker());
  issued.automaticTools!.poolId = "mutated-issue-return";
  const authenticated = authority.authenticate(headers(issued.token))!;
  assert.deepEqual(authenticated.automaticTools, marker());
  authenticated.automaticTools!.approvalId = "c".repeat(64);
  delete authenticated.automaticTools;
  const listed = authority.list();
  assert.deepEqual(listed[0]!.automaticTools, marker());
  listed[0]!.automaticTools!.poolId = "mutated-list-return";
  assert.deepEqual(authority.authenticate(headers(issued.token))?.automaticTools, marker());
});

test("automatic tool issuance snapshots options before callbacks can mutate caller-owned objects", () => {
  const options = { automaticTools: marker(), allowMcp: false, allowNativeClaude: false };
  let mutate = false;
  const authority = new GatewayTokenAuthority({ now() {
    if (mutate) {
      options.automaticTools.poolId = "mutated-during-issue";
      options.allowMcp = true;
      options.allowNativeClaude = true;
    }
    return fixedNow();
  } });
  mutate = true;
  const issued = authority.issue("opencode", options);
  assert.deepEqual(issued.automaticTools, marker());
  assert.equal(issued.allowMcp, false);
  assert.equal(issued.allowNativeClaude, false);
});

test("automatic tool journal survives restart with its marker and cannot silently become a P0 session", t => {
  const { stateFile } = fixture(t);
  const first = new GatewayTokenAuthority({ stateFile, now: fixedNow });
  const issued = first.issue("opencode", { automaticTools: marker() });
  const saved = readFileSync(stateFile, "utf8");
  const persisted = JSON.parse(saved.split("\n")[1]!).session;
  assert.deepEqual(persisted.automaticTools, marker());
  assert.deepEqual(Object.keys(persisted.automaticTools).sort(), ["approvalId", "poolId", "version"]);
  assert.equal(saved.includes(issued.token), false);
  assert.equal(saved.includes("es-session-"), false);
  assert.equal(saved.includes('"token"'), false);
  assert.equal(saved.includes('"key"'), false);
  const restarted = new GatewayTokenAuthority({ stateFile, now: fixedNow });
  const session = restarted.authenticate(headers(issued.token));
  assert.ok(session);
  assert.deepEqual(session.automaticTools, marker(), "the runner can reject restored marked sessions without an in-memory pin");
  assert.equal(session.id, issued.id);
  session.automaticTools.poolId = "mutated-after-restart";
  assert.deepEqual(restarted.list()[0]?.automaticTools, marker());
  assert.equal(readFileSync(stateFile, "utf8"), saved);
});

test("legacy no-marker journal entries remain compatible and are never automatically upgraded", t => {
  const { stateFile } = fixture(t);
  const session = journalSession();
  const { token, content } = writeJournal(stateFile, session);
  const authority = new GatewayTokenAuthority({ stateFile, now: fixedNow });
  assert.deepEqual(authority.authenticate(headers(token)), session);
  assert.equal(Object.hasOwn(authority.list()[0]!, "automaticTools"), false);
  assert.equal(readFileSync(stateFile, "utf8"), content);
});

test("invalid persisted tool marker or capability fails the whole authority closed without removing or rewriting the marker", t => {
  const { dir } = fixture(t);
  const sessions = [
    ...invalidMarkers.map(({ value }) => ({ ...journalSession(), automaticTools: value })),
    ...[
      { kind: "manual" }, { agentId: "codex" }, { depth: 1 }, { depth: 2 }, { allowMcp: true }, { allowNativeClaude: true },
      { automaticTool: marker() },
    ].map(change => ({ ...journalSession(), automaticTools: marker(), ...change })),
  ];
  for (const [index, session] of sessions.entries()) {
    const stateFile = join(dir, `invalid-${index}.jsonl`);
    const { token, content } = writeJournal(stateFile, session);
    const authority = new GatewayTokenAuthority({ stateFile, now: fixedNow });
    assert.equal(authority.authenticate(headers(token)), undefined, `journal ${index}`);
    assert.throws(() => authority.list(), GatewaySessionStoreError);
    assert.throws(() => authority.issue("opencode"), GatewaySessionStoreError);
    assert.equal(readFileSync(stateFile, "utf8"), content);
  }
});

test("marked sessions retain ordinary fixed expiry and revocation after restart", t => {
  const { stateFile } = fixture(t);
  let now = fixedNow();
  const authority = new GatewayTokenAuthority({ stateFile, now: () => now });
  const expired = authority.issue("opencode", { automaticTools: marker(), ttlMs: 100 });
  const revoked = authority.issue("opencode", { automaticTools: marker() });
  authority.revokeId(revoked.id);
  now += 100;
  const restarted = new GatewayTokenAuthority({ stateFile, now: () => now });
  assert.equal(restarted.authenticate(headers(expired.token)), undefined);
  assert.equal(restarted.authenticate(headers(revoked.token)), undefined);
  assert.deepEqual(restarted.list(), []);
});
