import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { clearQuota, describeQuota, exhaustedUntil, isExhausted, isUsageLimit, parseQuotaHeaders, quotaOf, recordLimitReached, recordQuotaHeaders, toMs } from "../src/quota.ts";

beforeEach(() => clearQuota());

const NOW = Date.UTC(2026, 9, 6, 6, 0, 0);
const headers = (h: Record<string, string>) => new Headers(h);

test("usage headers become windows, with reset moments in seconds, in milliseconds, or as a wait", () => {
  const w = parseQuotaHeaders(headers({
    "x-codex-primary-used-percent": "62", "x-codex-primary-window-minutes": "300", "x-codex-primary-reset-at": String(Math.floor(NOW / 1000) + 3600),
    "x-codex-secondary-used-percent": "10.5", "x-codex-secondary-reset-after-seconds": "7200", "x-codex-secondary-window-minutes": "10080",
  }), NOW);
  assert.equal(w.length, 2);
  assert.deepEqual(w[0], { id: "primary", usedPercent: 62, resetAt: NOW + 3_600_000, windowMinutes: 300 });
  assert.deepEqual(w[1], { id: "secondary", usedPercent: 10.5, resetAt: NOW + 7_200_000, windowMinutes: 10080 });
  assert.equal(toMs(1_700_000_000), 1_700_000_000_000, "epoch seconds become ms");
  assert.equal(toMs(1_700_000_000_000), 1_700_000_000_000, "ms stay as they are");
  assert.deepEqual(parseQuotaHeaders(headers({ "content-type": "x" }), NOW), [], "an answer without usage headers says nothing");
});

test("a full window marks the plan as used up until it resets, and it is free again once the usage drops", () => {
  recordQuotaHeaders("plan", headers({ "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(Math.floor(NOW / 1000) + 1800) }), NOW);
  assert.equal(isExhausted("plan", NOW + 1000), true);
  assert.equal(exhaustedUntil("plan", NOW + 1000), NOW + 1_800_000);
  assert.equal(isExhausted("plan", NOW + 1_900_000), false, "after the reset it is free again");
  recordQuotaHeaders("plan", headers({ "x-codex-primary-used-percent": "5" }), NOW + 2_000_000);
  assert.equal(isExhausted("plan", NOW + 2_000_001), false);
  assert.equal(isExhausted("other", NOW), false, "other plans are not affected");
});

test("a 'used up' refusal waits for the plan's own reset, or half an hour when it never said", () => {
  recordQuotaHeaders("a", headers({ "x-codex-primary-used-percent": "80", "x-codex-primary-reset-at": String(Math.floor(NOW / 1000) + 600) }), NOW);
  recordLimitReached("a", NOW);
  assert.equal(exhaustedUntil("a", NOW), NOW + 600_000, "uses the reset the plan mentioned");
  recordLimitReached("b", NOW);
  assert.equal(exhaustedUntil("b", NOW), NOW + 30 * 60_000, "no reset known: a default wait");
  assert.ok(quotaOf("b"));
});

test("only a plan being used up counts, not a per-minute rate limit or another error", () => {
  assert.equal(isUsageLimit(429, JSON.stringify({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit reached" } })), true);
  assert.equal(isUsageLimit(429, "You've hit your usage limit. Try again later."), true);
  assert.equal(isUsageLimit(429, JSON.stringify({ error: { code: "insufficient_quota" } })), true);
  assert.equal(isUsageLimit(429, JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit reached for requests per min" } })), false);
  assert.equal(isUsageLimit(500, "usage limit"), false);
  assert.equal(isUsageLimit(429, "slow down"), false);
});

test("the one-line summary reads like a person would say it", () => {
  recordQuotaHeaders("p", headers({ "x-codex-primary-used-percent": "62", "x-codex-primary-window-minutes": "300", "x-codex-secondary-used-percent": "10" }), NOW);
  assert.match(describeQuota(quotaOf("p"), NOW)!, /^已用 62%（5 小时窗口）$/);
  recordQuotaHeaders("q", headers({ "x-codex-primary-used-percent": "100", "x-codex-primary-reset-at": String(Math.floor(NOW / 1000) + 3600) }), NOW);
  assert.match(describeQuota(quotaOf("q"), NOW)!, /^已用完，(?:\d{1,2}\/\d{1,2} )?\d\d:\d\d 恢复$/);
  assert.equal(describeQuota(undefined), undefined);
});
