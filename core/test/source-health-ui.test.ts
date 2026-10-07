import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const NOW = Date.parse("2026-10-07T13:00:00Z");
function fixture() {
  const forbidden = () => assert.fail("rendering health controls must never schedule work, register handlers or make requests");
  class Clock extends Date { static override now() { return NOW; } }
  const context = vm.createContext({ URL, Date: Clock, fetch: forbidden, call: forbidden, setTimeout: forbidden, setInterval: forbidden, requestAnimationFrame: forbidden, document: { addEventListener: forbidden } });
  vm.runInContext(readFileSync(new URL("../../web/source-health.js", import.meta.url), "utf8"), context);
  return (over: Record<string, unknown> = {}) => {
    context.provider = { id: "p", name: "来源", baseUrl: "https://relay.example.invalid/v1", ...over };
    return vm.runInContext("sourceHealthCard(provider)", context) as string;
  };
}
const checkbox = (html: string) => html.match(/<input[^>]*>/)?.[0] ?? "";
const button = (html: string) => html.match(/<button[^>]*>/)?.[0] ?? "";

test("health permission defaults off and merely rendering controls performs no background work", () => {
  const render = fixture(), html = render();
  assert.match(html, /data-source-health="p"/); assert.match(html, /data-source-health-check="p"/);
  assert.doesNotMatch(checkbox(html), /checked/); assert.match(button(html), /disabled/);
  assert.match(html, /默认关闭/); assert.match(html, /仅发送 GET 模型列表/); assert.match(html, /不验证推理或额度/); assert.match(html, /部分厂商可能限流或计费/);
});

test("explicit permission enables a first check without inventing verified or unavailable health", () => {
  const html = fixture()({ healthMonitor: { enabled: true }, sourceHealth: { eligible: true, verified: false, status: "unknown" } });
  assert.match(checkbox(html), /checked/); assert.doesNotMatch(button(html), /disabled/);
  assert.match(html, /状态未知/); assert.match(html, /首次验证尚未完成/); assert.doesNotMatch(html, /模型列表检查不可用/);
});

test("unknown, stale, limited, healthy and failed checks have fixed truthful labels", () => {
  const render = fixture(), base = { healthMonitor: { enabled: true } };
  for (const reason of ["stale", "rate_limited", "inconclusive", '<img src=x onerror="bad">']) {
    const html = render({ ...base, sourceHealth: { eligible: true, verified: true, status: "unknown", reason } });
    assert.match(html, /状态未知/); assert.doesNotMatch(html, /模型列表检查不可用|<img|onerror/);
  }
  assert.match(render({ ...base, sourceHealth: { eligible: true, verified: true, status: "healthy" } }), /模型列表检查正常/);
  assert.match(render({ ...base, sourceHealth: { eligible: true, verified: true, status: "unavailable" } }), /模型列表检查不可用/);
  assert.doesNotMatch(render({ ...base, sourceHealth: { eligible: true, verified: false, status: "unavailable" } }), /模型列表检查不可用/);
});

test("a cooldown disables explicit checks; only valid future timestamps render a waiting notice", () => {
  const render = fixture(), sourceHealth = { eligible: true, verified: true, status: "unknown", nextCheckAt: NOW + 3600_000 };
  const html = render({ healthMonitor: { enabled: true }, sourceHealth });
  assert.match(button(html), /disabled/); assert.match(html, /冷却中，下次可检查/);
  for (const nextCheckAt of [NOW - 1, NaN, Infinity, 1e30, '" onclick="bad']) {
    const next = render({ healthMonitor: { enabled: true }, sourceHealth: { ...sourceHealth, nextCheckAt } });
    assert.doesNotMatch(button(next), /disabled/); assert.doesNotMatch(next, /冷却中|Invalid Date|onclick/);
  }
});

test("disabled or unqualified sources cannot trigger a check and unsupported adapters have no controls", () => {
  const render = fixture();
  for (const over of [{ off: true }, { sourceHealth: { eligible: false, blockedReason: "permission_required" } }]) assert.match(button(render({ healthMonitor: { enabled: true }, ...over })), /disabled/);
  for (const over of [{ plan: {} }, { vertex: {} }, { cliTextBridge: {} }, { antigravity: {} }, { kimi: {} }, { cursor: {} }, { kiro: {} }, { mimoFree: true }, { baseUrl: "http://remote.example/v1" }, { baseUrl: "https://user:secret@relay.example/v1" }, { wire: { paths: { models: "chat/completions" } } }, { sourceHealth: { blockedReason: "unsupported" } }]) assert.equal(render(over), "");
  assert.match(render({ baseUrl: "http://127.0.0.1:9999/v1" }), /data-source-health/);
});

test("source identifiers and names are escaped and private provider fields are never copied into markup", () => {
  const html = fixture()({ id: 'p" autofocus onfocus="bad<', name: '<img src=x onerror="bad">', healthMonitor: { enabled: true, verifiedFingerprint: "private-proof" }, sourceHealth: { eligible: true, verified: true, status: "healthy" }, wire: { headers: { authorization: "Bearer fixture-private-key" } }, prompt: "private prompt", output: "private output" });
  assert.match(html, /data-source-health="p&quot;/); assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /<img|<script|private-proof|fixture-private-key|private prompt|private output| onfocus="bad/);
});
