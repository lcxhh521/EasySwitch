import assert from "node:assert/strict";
import { test } from "node:test";
import { subscriptionSignInIssue, subscriptionSourceCapability, subscriptionSourceIssue, subscriptionSupport } from "../src/subscription-support.ts";

test("subscription research distinguishes documented agent routes from unavailable model sources", () => {
  const support = subscriptionSupport();
  assert.deepEqual(support.map(s => s.vendor), ["cursor", "kiro", "antigravity", "gemini-cli", "qoder", "codebuddy", "trae", "amp", "doubao", "grok", "minimax", "kimi", "droid"]);
  for (const s of support) {
    assert.equal(s.reviewedAt, "2026-10-06");
    assert.equal(s.modelSource.available, s.modelSource.state === "official-api-key");
    assert.ok(s.modelSource.reason.length > 20);
    assert.ok(s.agentRoutes.length || ["trae", "doubao"].includes(s.vendor));
    assert.ok(s.sources.length);
    for (const route of s.agentRoutes) {
      assert.equal(route.implementation, "not-implemented");
      assert.ok(route.auth && route.billing && route.docs.length);
    }
    for (const url of [...s.sources, ...s.agentRoutes.flatMap(r => r.docs)]) {
      assert.equal(new URL(url).protocol, "https:");
    }
  }
  assert.equal(support.find(s => s.vendor === "antigravity")!.modelSource.state, "blocked-terms");
  assert.equal(subscriptionSourceCapability("cursor").state, "todo");
  assert.equal(subscriptionSourceCapability("kiro").state, "todo");
  assert.equal(subscriptionSourceCapability("antigravity").state, "impossible");
});

test("public support metadata cannot change runtime restrictions", () => {
  const support = subscriptionSupport();
  support[0]!.modelSource.reason = "mutated";
  support[0]!.sources.length = 0;
  support[0]!.agentRoutes[0]!.implementation = "verified" as never;
  support.pop();
  assert.equal(subscriptionSupport().length, 13);
  assert.notEqual(subscriptionSourceCapability("cursor").note, "mutated");
  assert.ok(subscriptionSupport()[0]!.sources.length);
  assert.equal(subscriptionSupport()[0]!.agentRoutes[0]!.implementation, "not-implemented");
});

test("unsupported subscription metadata and WIP imports fail closed", () => {
  for (const { vendor } of subscriptionSupport()) {
    for (const provider of [
      { plan: { kind: vendor, accountId: "fake-account" } },
      { plan: { kind: ` ${vendor.toUpperCase()} ` } },
      { [vendor]: {} }, { [vendor]: null }, { [vendor]: false }, { [vendor]: undefined },
    ]) {
      const issue = subscriptionSourceIssue(provider);
      assert.equal(issue?.status, 501);
      assert.equal(issue?.vendor, vendor);
      assert.equal(issue?.code, "subscription_source_unavailable");
    }
  }
  // The actual WIP shape must not be reinterpreted as a normal API-key provider.
  const issue = subscriptionSourceIssue({ kiro: { loginPath: "/fake/native-login.sqlite3" }, route: "chat-translate" });
  assert.equal(issue?.vendor, "kiro");
  assert.ok(!JSON.stringify(issue).includes("/fake/"));
});

test("existing plan kinds and ordinary flat-rate APIs remain available", () => {
  for (const kind of ["chatgpt", "codex", "copilot"]) {
    assert.equal(subscriptionSourceIssue({ plan: { kind, accountId: "fake-account" } }), undefined);
  }
  for (const provider of [
    {}, { plan: undefined }, { billing: "subscription" },
    { id: "cursor", name: "Kiro", icon: "antigravity", baseUrl: "https://api.example.test/v1" },
  ]) assert.equal(subscriptionSourceIssue(provider), undefined);
});

test("malformed or unknown plan kinds return a secret-free validation error", () => {
  for (const plan of [null, [], "secret-value", 1, {}, { kind: "secret-value" }, { kind: "__proto__" }, { kind: "constructor" }, { kind: ["codex"] }]) {
    const issue = subscriptionSourceIssue({ plan });
    assert.equal(issue?.status, 400);
    assert.equal(issue?.code, "invalid_subscription_source");
    assert.ok(!JSON.stringify(issue).includes("secret-value"));
  }
});

test("an unsupported mode never falls through into a Codex or other sign-in", () => {
  for (const mode of [undefined, "open", "codex", "copilot"]) assert.equal(subscriptionSignInIssue(mode), undefined);
  for (const mode of ["cursor", "kiro", "antigravity", " KIRO "]) assert.equal(subscriptionSignInIssue(mode)?.status, 501);
  for (const mode of ["", "not-a-vendor", "__proto__", "constructor", "chatgpt", null, {}, [], true]) {
    assert.equal(subscriptionSignInIssue(mode)?.status, 400);
  }
});

test("source validation is pure and never mutates or stringifies supplied credential metadata", () => {
  const provider = Object.freeze({ kiro: Object.freeze({
    get loginPath(): never { throw new Error("must not inspect the login path"); },
    toJSON(): never { throw new Error("must not serialize auth metadata"); },
  }) });
  assert.equal(subscriptionSourceIssue(provider)?.vendor, "kiro");
  for (const value of [undefined, null, [], "text", 1]) assert.equal(subscriptionSourceIssue(value), undefined);
});


test("official coding-plan model keys are distinguished from unsupported native-login imports", () => {
  for (const vendor of ["kimi", "minimax"] as const) {
    const support = subscriptionSupport().find(s => s.vendor === vendor)!;
    assert.equal(support.modelSource.available, true);
    assert.equal(subscriptionSourceCapability(vendor).state, "documented");
    assert.equal(support.apiRoutes?.[0]?.implementation, "existing-api-transport");
    assert.equal(support.apiRoutes?.[0]?.verification, "documentation-only");
    assert.equal(subscriptionSourceIssue({ plan: { kind: vendor } })?.status, 501, "a supported coding Key is not native OAuth");
    assert.equal(subscriptionSourceIssue({ billing: "subscription", baseUrl: support.apiRoutes?.[0]?.docs[0] }), undefined);
  }
});

test("all reviewed API routes have explicit credential, billing and documentary boundaries", () => {
  for (const support of subscriptionSupport()) for (const route of support.apiRoutes ?? []) {
    assert.ok(route.presetIds.length && route.auth.length && route.billing.length);
    for (const url of route.docs) assert.equal(new URL(url).protocol, "https:");
  }
  const grok = subscriptionSupport().find(s => s.vendor === "grok")!;
  assert.match(grok.modelSource.reason, /共享周用量/);
  const doubao = subscriptionSupport().find(s => s.vendor === "doubao")!;
  assert.match(doubao.modelSource.reason, /仅限 AI 编程工具/);
});

test("Qoder and CodeBuddy metadata acknowledges experimental text bridges without claiming generic model or real verification", () => {
  for (const vendor of ["qoder", "codebuddy"]) {
    const support = subscriptionSupport().find(s => s.vendor === vendor)!;
    assert.equal(support.modelSource.state, "not-verified");
    assert.equal(support.modelSource.available, false);
    assert.match(support.modelSource.reason, /已接实验性.*纯文字桥/);
    assert.match(support.modelSource.reason, /真实 CLI 未验收/);
    assert.match(support.modelSource.reason, /通用模型 API/);
  }
});
