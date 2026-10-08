import assert from "node:assert/strict";
import { test } from "node:test";
import { hasPlanUsage, refreshPlanUsage } from "../src/plan-usage.ts";
import { clearQuota, describeQuota, exhaustedUntil, isExhausted, quotaOf } from "../src/quota.ts";
import type { Provider } from "../src/types.ts";

const provider = (id: string, baseUrl: string, extra: Partial<Provider> = {}): Provider => ({ id, name: id, baseUrl, models: [], route: "chat-translate", streamUsage: false, ...extra }) as Provider;
const answering = (body: unknown, seen: Array<{ url: string; auth: string | null }> = []): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") }); return Response.json(body); }) as typeof fetch;

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

test("Kimi's plan: the shorter window and the weekly total are read, and the key goes only to Kimi's own host", async () => {
  clearQuota();
  const seen: Array<{ url: string; auth: string | null }> = [];
  const body = {
    usage: { limit: "1000", remaining: "400", resetTime: new Date(NOW + 3 * 86400_000).toISOString() },
    limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", remaining: "85", resetTime: new Date(NOW + 3600_000).toISOString() } }],
  };
  const windows = await refreshPlanUsage(provider("kimi", "https://api.kimi.com/coding/v1"), "sk-kimi", NOW, answering(body, seen));
  assert.deepEqual(seen, [{ url: "https://api.kimi.com/coding/v1/usages", auth: "Bearer sk-kimi" }]);
  assert.equal(windows!.length, 2);
  assert.equal(Math.round(windows![0]!.usedPercent), 15);
  assert.equal(windows![0]!.windowMinutes, 300);
  assert.equal(Math.round(windows![1]!.usedPercent), 60);
  assert.match(describeQuota(quotaOf("kimi"), NOW)!, /已用 60%/);
  assert.equal(isExhausted("kimi", NOW), false);
  // Anything that is not the vendor's own host is never asked, whatever the key.
  const lookalike = provider("evil", "https://api.kimi.com.evil.example/coding/v1");
  assert.equal(hasPlanUsage(lookalike), false);
  assert.equal(await refreshPlanUsage(lookalike, "sk-kimi", NOW, answering(body, seen)), undefined);
  assert.equal(seen.length, 1);
});

test("MiniMax's plan: remaining percents become used percents, and a full window marks the plan used up until it resets", async () => {
  clearQuota();
  const reset = NOW + 2 * 3600_000;
  const body = { base_resp: { status_code: 0 }, model_remains: [
    { model_name: "other", current_interval_remaining_percent: 5 },
    { model_name: "general", current_interval_remaining_percent: 0, end_time: reset, current_weekly_status: 1, current_weekly_remaining_percent: 70, weekly_end_time: NOW + 5 * 86400_000 },
  ] };
  const seen: Array<{ url: string; auth: string | null }> = [];
  const windows = await refreshPlanUsage(provider("mm", "https://api.minimax.io/v1"), "sk-mm", NOW, answering(body, seen));
  assert.equal(seen[0]!.url, "https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
  assert.deepEqual(windows!.map(w => [w.id, Math.round(w.usedPercent), w.windowMinutes]), [["primary", 100, 300], ["secondary", 30, 10080]]);
  assert.equal(isExhausted("mm", NOW), true, "the pools skip it");
  assert.equal(exhaustedUntil("mm", NOW), reset);
  assert.match(describeQuota(quotaOf("mm"), NOW)!, /已用完/);
  // Back in the clear once the vendor says there is room again.
  await refreshPlanUsage(provider("mm", "https://api.minimaxi.com/v1"), "sk-mm", NOW + 1, answering({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: 80 }] }));
  assert.equal(isExhausted("mm", NOW + 1), false);
});

test("invalid quota numbers remain unknown instead of reporting an empty plan", async () => {
  const invalid = [undefined, null, "", " ", "\t\r\n", "not-a-number", "NaN", "Infinity", "-Infinity", "1e999", true, false, [], {}];
  for (const value of invalid) {
    clearQuota();
    const label = JSON.stringify(value);
    const reset = NOW + 3_600_000;
    const kimi = provider("invalid-kimi", "https://api.kimi.com/coding/v1");
    for (const usage of [{ limit: 100, remaining: value }, { limit: 100, used: value }, { limit: value, remaining: 0 }]) {
      assert.equal(await refreshPlanUsage(kimi, "fixture-key", NOW, answering({ usage: { ...usage, resetTime: reset } })), undefined, `Kimi: ${label}`);
      assert.equal(quotaOf(kimi.id), undefined, `Kimi: ${label}`);
      assert.equal(isExhausted(kimi.id, NOW), false, `Kimi: ${label}`);
    }
    const minimax = provider("invalid-mm", "https://api.minimax.io/v1");
    const body = { base_resp: { status_code: 0 }, model_remains: [{
      model_name: "general", current_interval_remaining_percent: value, end_time: reset,
      current_weekly_status: 1, current_weekly_remaining_percent: value, weekly_end_time: reset,
    }] };
    assert.equal(await refreshPlanUsage(minimax, "fixture-key", NOW, answering(body)), undefined, `MiniMax: ${label}`);
    assert.equal(quotaOf(minimax.id), undefined, `MiniMax: ${label}`);
    assert.equal(isExhausted(minimax.id, NOW), false, `MiniMax: ${label}`);
  }
});

test("unknown fields leave valid usage usable and an unknown refresh preserves the last observation", async () => {
  clearQuota();
  const kimi = provider("fallback-kimi", "https://api.kimi.com/coding/v1");
  const windows = await refreshPlanUsage(kimi, "fixture-key", NOW, answering({ usage: { limit: "100", remaining: " ", used: "25" } }));
  assert.equal(windows?.[0]?.usedPercent, 25, "unknown remaining falls back to valid used");
  const before = quotaOf(kimi.id);
  assert.equal(await refreshPlanUsage(kimi, "fixture-key", NOW + 1, answering({ usage: { limit: 100, remaining: "\t", resetTime: NOW + 3_600_000 } })), undefined);
  assert.equal(quotaOf(kimi.id), before, "no fresh quota fact means no state replacement");
  assert.equal(isExhausted(kimi.id, NOW + 1), false);
  const minimax = provider("partial-mm", "https://api.minimax.io/v1");
  const partial = await refreshPlanUsage(minimax, "fixture-key", NOW, answering({ base_resp: { status_code: "0" }, model_remains: [{
    model_name: "general", current_interval_remaining_percent: "", current_weekly_status: "1", current_weekly_remaining_percent: "75",
  }] }));
  assert.deepEqual(partial, [{ id: "secondary", usedPercent: 25, windowMinutes: 10080 }]);
});

test("real zero and nonempty numeric strings retain their quota meaning", async () => {
  const reset = NOW + 3_600_000;
  for (const remaining of [0, "0", " 0 ", "0.0"]) {
    clearQuota();
    const kimi = provider("zero-kimi", "https://api.kimi.com/coding/v1");
    const windows = await refreshPlanUsage(kimi, "fixture-key", NOW, answering({ usage: { limit: "100", remaining, resetTime: reset } }));
    assert.equal(windows?.[0]?.usedPercent, 100);
    assert.equal(exhaustedUntil(kimi.id, NOW), reset);
    const minimax = provider("zero-mm", "https://api.minimax.io/v1");
    const mmWindows = await refreshPlanUsage(minimax, "fixture-key", NOW, answering({ base_resp: { status_code: "0" }, model_remains: [{
      model_name: "general", current_interval_remaining_percent: remaining, end_time: reset,
      current_weekly_status: "1", current_weekly_remaining_percent: remaining, weekly_end_time: reset,
    }] }));
    assert.deepEqual(mmWindows?.map(w => w.usedPercent), [100, 100]);
    assert.equal(exhaustedUntil(minimax.id, NOW), reset);
  }
  for (const remaining of [25.5, "25.5", " 25.5 ", "2.55e1"]) {
    clearQuota();
    const windows = await refreshPlanUsage(provider("numeric-kimi", "https://api.kimi.com/coding/v1"), "fixture-key", NOW, answering({ usage: { limit: "100", remaining } }));
    assert.equal(windows?.[0]?.usedPercent, 74.5);
    const mmWindows = await refreshPlanUsage(provider("numeric-mm", "https://api.minimax.io/v1"), "fixture-key", NOW, answering({ base_resp: { status_code: 0 }, model_remains: [{ model_name: "general", current_interval_remaining_percent: remaining }] }));
    assert.equal(mmWindows?.[0]?.usedPercent, 74.5);
  }
});

test("a vendor that answers with something unrecognised, an error, or no key shows nothing and breaks nothing; subscriptions with their own channels are left alone", async () => {
  clearQuota();
  const p = provider("kimi2", "https://api.kimi.ai/coding/v1");
  assert.equal(await refreshPlanUsage(p, "k", NOW, answering({ hello: "world" })), undefined);
  assert.equal(await refreshPlanUsage(p, "k", NOW, (async () => new Response("no", { status: 500 })) as typeof fetch), undefined);
  assert.equal(await refreshPlanUsage(p, "k", NOW, (async () => { throw new Error("offline"); }) as typeof fetch), undefined);
  assert.equal(await refreshPlanUsage(p, undefined, NOW, answering({})), undefined);
  assert.equal(quotaOf("kimi2"), undefined);
  assert.equal(hasPlanUsage(provider("c", "https://api.kimi.com/coding/v1", { cursor: { accountId: "x" } })), false);
  assert.equal(hasPlanUsage(provider("o", "https://api.openai.com/v1")), false);
});


test("plan usage rejects insecure, ambiguous and cross-account destinations before invoking transport", async () => {
  const invalid = [
    "http://api.kimi.com/coding/v1", "https://api.kimi.com:8443/coding/v1", "https://user:pass@api.kimi.com/coding/v1",
    "https://api.kimi.com/coding/v1?redirect=elsewhere", "https://api.kimi.com/coding/v1#fragment",
    "https://api.kimi.com.evil.example/coding/v1", "https://api.minimax.com/v1", "https://api.minimaxi.io/v1",
  ];
  let calls = 0;
  const transport: typeof fetch = async (_url, init) => { calls++; assert.equal(init?.redirect, "error"); return Response.json({}); };
  for (const base of invalid) {
    const p = provider("invalid", base);
    assert.equal(hasPlanUsage(p), false, base);
    assert.equal(await refreshPlanUsage(p, "fixture-key", NOW, transport), undefined);
  }
  const cross = provider("cross", "https://api.minimax.io/v1", { kimi: { accountId: "fixture-kimi" } });
  assert.equal(hasPlanUsage(cross), false);
  assert.equal(await refreshPlanUsage(cross, "fixture-kimi-token", NOW, transport), undefined);
  assert.equal(calls, 0, "invalid destinations never receive a key");
  for (const base of ["https://api.kimi.com/coding/v1", "https://api.kimi.ai/coding/v1", "https://api.minimax.io/v1", "https://api.minimaxi.com/v1"]) {
    await refreshPlanUsage(provider("valid", base), "fixture-key", NOW, transport);
  }
  assert.equal(calls, 4);
});
