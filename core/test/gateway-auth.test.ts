import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayTokenAuthority, requestToken } from "../src/gateway-auth.ts";

test("gateway tokens require exact issuance, cannot be forged by agent name, and contain 256 random bits", () => {
  const authority = new GatewayTokenAuthority();
  const first = authority.issue("claude-desktop");
  const second = authority.issue("claude-desktop");
  assert.match(first.token, /^es-session-claude-desktop-[a-f0-9]{64}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(authority.authenticate({ authorization: `Bearer ${first.token}` })?.agentId, "claude-desktop");
  for (const token of ["es-session-claude-anything", first.token.replace(/.$/, first.token.endsWith("0") ? "1" : "0"), first.token.replace("claude-desktop", "codex")]) {
    assert.equal(authority.authenticate({ authorization: `Bearer ${token}` }), undefined);
  }
  assert.equal(new GatewayTokenAuthority().authenticate({ authorization: `Bearer ${first.token}` }), undefined, "process restart has no issuance history");
  assert.equal(authority.issue("qwencode").agentId, "qwen-code");
});

test("gateway sessions expire, revoke by token or public id, and do not expose retained secrets", () => {
  let now = Date.parse("2026-10-06T00:00:00Z");
  const authority = new GatewayTokenAuthority({ now: () => now });
  const issued = authority.issue("claude", { ttlMs: 100 });
  const auth = { authorization: `Bearer ${issued.token}` };
  const listed = authority.list();
  assert.equal(JSON.stringify(listed).includes(issued.token), false);
  assert.equal(JSON.stringify(authority).includes(issued.token), false);
  listed[0]!.agentId = "tampered";
  assert.equal(authority.authenticate(auth)?.agentId, "claude");
  now += 99;
  assert.ok(authority.authenticate(auth));
  now++;
  assert.equal(authority.authenticate(auth), undefined);
  assert.equal(authority.list().length, 0);
  const next = authority.issue("codex");
  assert.equal(authority.revokeId(next.id), true);
  assert.equal(authority.authenticate({ authorization: `Bearer ${next.token}` }), undefined);
  const last = authority.issue("codex");
  assert.equal(authority.revoke(last.token), true);
  assert.equal(authority.revoke(last.token), false);
});

test("MCP permissions and nesting depth are bound to the issued capability", () => {
  const authority = new GatewayTokenAuthority();
  const ordinary = authority.issue("claude");
  assert.equal(authority.authenticate({ authorization: `Bearer ${ordinary.token}` }, undefined, "mcp"), undefined);
  const nested = authority.issue("qwen-code", { allowMcp: true, depth: 2 });
  const session = authority.authenticate({ authorization: `Bearer ${nested.token}`, "x-easyswitch-depth": "0" }, undefined, "mcp");
  assert.equal(session?.depth, 2);
  assert.equal(session?.allowNativeClaude, false);
  assert.equal(authority.issue("claude", { allowNativeClaude: true }).allowNativeClaude, true);
});

test("all four protocol credential forms work without modifying native Claude credentials", () => {
  const authority = new GatewayTokenAuthority();
  const { token } = authority.issue("gemini-cli");
  for (const headers of [{ authorization: `Bearer ${token}` }, { "x-api-key": token }, { "x-goog-api-key": token }]) {
    assert.equal(authority.authenticate(headers)?.agentId, "gemini-cli");
  }
  const native = { authorization: "Bearer native-test-login", "x-easyswitch-session": token, "x-api-key": "native-test-key" };
  assert.equal(authority.authenticate(native)?.agentId, "gemini-cli");
  assert.deepEqual(native, { authorization: "Bearer native-test-login", "x-easyswitch-session": token, "x-api-key": "native-test-key" });
  assert.ok(authority.authenticate({}, new URL(`http://localhost/v1beta/models/x:generateContent?key=${token}`)));
  assert.ok(authority.authenticate({}, new URL(`http://localhost/v1beta/models?key=${token}`), "models"));
  assert.equal(authority.authenticate({}, new URL(`http://localhost/v1/chat/completions?key=${token}`)), undefined);
});

test("ambiguous and malformed credentials never fall back to a valid alternative", () => {
  const authority = new GatewayTokenAuthority();
  const a = authority.issue("claude"), b = authority.issue("codex");
  const cases = [
    { authorization: `Bearer ${a.token}`, "x-easyswitch-session": "invalid" },
    { authorization: `Bearer ${a.token}`, "x-api-key": b.token },
    { authorization: `Bearer ${a.token}, Bearer ${b.token}` },
    { "x-easyswitch-session": [a.token] },
    { "x-api-key": [a.token] },
    { authorization: a.token },
    { authorization: `Bearer ${a.token} ` },
  ];
  for (const headers of cases) assert.equal(authority.authenticate(headers), undefined);
  assert.equal(requestToken({}, new URL(`http://localhost/v1beta/models?key=${a.token}&key=${a.token}`)), undefined);
  assert.equal(authority.authenticate({ authorization: `Bearer ${a.token}` }, new URL(`http://localhost/v1beta/models?key=${b.token}`)), undefined);
  assert.ok(authority.authenticate({ authorization: `Bearer ${a.token}`, "x-api-key": a.token }));
});

test("invalid issuance options and capacity exhaustion fail without evicting a live session", () => {
  const authority = new GatewayTokenAuthority({ maxSessions: 1 });
  for (const ttlMs of [0, -1, Infinity, 1.5, 31 * 86400000]) assert.throws(() => authority.issue("claude", { ttlMs }));
  for (const depth of [-1, 0.5, 3, Infinity]) assert.throws(() => authority.issue("claude", { depth }));
  for (const agent of ["", "with space", "../claude", "a".repeat(65)]) assert.throws(() => authority.issue(agent));
  const issued = authority.issue("claude");
  assert.throws(() => authority.issue("codex"), /Too many active/);
  assert.ok(authority.authenticate({ authorization: `Bearer ${issued.token}` }));
  authority.clear();
  assert.equal(authority.list().length, 0);
});

test("legacy signed, stable, unsigned and syntactically valid unissued credentials all require reissue", () => {
  const authority = new GatewayTokenAuthority();
  const issued = authority.issue("codex");
  const tokens = [
    "es-session-codex-stable-" + "a".repeat(20),
    "es-session-codex-00000000-0000-4000-8000-000000000000-" + "a".repeat(20),
    "es-session-codex-private",
    "es-session-codex-stable",
    "es-session-codex-" + "a".repeat(64),
  ];
  for (const token of tokens) {
    for (const headers of [{ authorization: `Bearer ${token}` }, { "x-api-key": token }, { "x-goog-api-key": token }, { "x-easyswitch-session": token }]) {
      assert.equal(authority.authenticate(headers), undefined);
    }
    assert.equal(authority.authenticate({}, new URL(`http://localhost/v1beta/models?key=${token}`)), undefined);
  }
  assert.ok(authority.authenticate({ authorization: `Bearer ${issued.token}` }));
});

test("default sessions last exactly 24 hours and cannot be kept alive by repeated authentication", () => {
  let now = Date.parse("2026-10-06T00:00:00Z");
  const authority = new GatewayTokenAuthority({ now: () => now });
  const issued = authority.issue("codex");
  assert.equal(Date.parse(issued.expiresAt) - Date.parse(issued.issuedAt), 24 * 60 * 60_000);
  const headers = { authorization: `Bearer ${issued.token}` };
  now += 24 * 60 * 60_000 - 1;
  assert.ok(authority.authenticate(headers));
  now++;
  assert.equal(authority.authenticate(headers), undefined);
});
