import assert from "node:assert/strict";
import { test } from "node:test";
import { copilotQuotaCapability, describeCopilotQuota, parseCopilotQuota } from "../src/copilot-quota.ts";

test("Copilot quota remains explicitly disconnected without SDK execution or inferred numbers", () => {
  const capability = copilotQuotaCapability();
  assert.equal(capability.state, "not-connected"); assert.equal(capability.canRefresh, false);
  assert.match(capability.text, /未知/); assert.equal(describeCopilotQuota([]), undefined);
  assert.ok(!("remainingPercentage" in capability));
});
test("official SDK snapshots preserve independent limited and unlimited categories", () => {
  const parsed = parseCopilotQuota({ quotaSnapshots: {
    premium_interactions: { entitlementRequests: 300, usedRequests: 12.5, remainingPercentage: 95.83, resetDate: "2026-11-01T00:00:00Z" },
    chat: { entitlementRequests: -1, usedRequests: 80, remainingPercentage: 0 },
    completions: { entitlementRequests: 0, usedRequests: 0, remainingPercentage: 0 },
    unknown: { entitlementRequests: 1, usedRequests: 1, remainingPercentage: 0, secret: "must-not-show" },
  } });
  assert.deepEqual(parsed, [
    { kind: "premium_interactions", entitlementRequests: 300, usedRequests: 12.5, unlimited: false, remainingPercentage: 95.83, resetAt: "2026-11-01T00:00:00.000Z" },
    { kind: "chat", entitlementRequests: -1, usedRequests: 80, unlimited: true },
    { kind: "completions", entitlementRequests: 0, usedRequests: 0, unlimited: false, remainingPercentage: 0 },
  ]);
  const text = describeCopilotQuota(parsed)!;
  assert.match(text, /高级请求：已用 12.5 \/ 300 次，剩余 95.83%/);
  assert.match(text, /聊天：已用 80，此项不限次数，重置时间未知/);
  assert.match(text, /代码补全：已用 0 \/ 0 次，剩余 0%/);
  assert.doesNotMatch(text, /must-not-show|unknown/);
});
test("invalid or missing fields never turn into free quota or invented resets", () => {
  for (const value of [null, [], 1, "private text", {}, { quotaSnapshots: [] }]) assert.deepEqual(parseCopilotQuota(value), []);
  for (const invalid of [null, "100", NaN, Infinity, -2, Number.MAX_VALUE]) {
    assert.deepEqual(parseCopilotQuota({quotaSnapshots:{chat:{entitlementRequests:invalid,usedRequests:0}}}), []);
    assert.deepEqual(parseCopilotQuota({quotaSnapshots:{chat:{entitlementRequests:100,usedRequests:invalid}}}), []);
  }
  for (const date of ["2026-02-30T00:00:00Z", "2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T25:00:00Z"]) {
    assert.equal(parseCopilotQuota({quotaSnapshots:{chat:{entitlementRequests:100,usedRequests:0,resetDate:date}}})[0]!.resetAt, undefined, "invalid calendar dates are not normalized into invented resets");
  }
  for (const remaining of [undefined, -1, 101, NaN, "50"]) {
    const [row] = parseCopilotQuota({quotaSnapshots:{chat:{entitlementRequests:100,usedRequests:120,remainingPercentage:remaining,resetDate:"secret-or-non-ISO-date"}}});
    assert.ok(row); assert.equal(row.remainingPercentage, undefined); assert.equal(row.resetAt, undefined);
    assert.match(describeCopilotQuota([row])!, /剩余比例未知.*重置时间未知/);
  }
});
test("quota parser does not invoke accessors and strips arbitrary account or credential fields", () => {
  let touched = 0; const getter = {get(){touched++;throw new Error("must-not-run")}};
  assert.deepEqual(parseCopilotQuota(Object.defineProperty({}, "quotaSnapshots", getter)), []);
  assert.deepEqual(parseCopilotQuota({quotaSnapshots:Object.defineProperty({}, "chat", getter)}), []);
  assert.deepEqual(parseCopilotQuota({quotaSnapshots:{chat:Object.defineProperty({}, "entitlementRequests", getter)}}), []);
  assert.equal(touched, 0);
  const text = JSON.stringify(parseCopilotQuota({ account:"private-account", token:"sk-fake-secret", quotaSnapshots:{chat:{entitlementRequests:100,usedRequests:10,remainingPercentage:90,resetDate:"private-date",error:"private-body"}} }));
  assert.doesNotMatch(text, /private|sk-fake/);
});
