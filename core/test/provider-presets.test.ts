import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESETS } from "../src/presets.ts";
import { isMimoFree } from "../src/mimo-free.ts";
import { endpointUrl, upstreamHeaders } from "../src/upstream.ts";
import { subscriptionSourceIssue, subscriptionSupport } from "../src/subscription-support.ts";

const preset = (id: string) => { const result = PRESETS.find(p => p.id === id); assert.ok(result, id); return result; };

test("MiMo PAYG, Token Plan and historical Free are separate presets and credentials", () => {
  const official = preset("xiaomi"), plan = preset("mimo-token-plan"), free = preset("mimo-free");
  assert.equal(official.baseUrl, "https://api.xiaomimimo.com/v1");
  assert.equal(plan.baseUrl, "https://token-plan-cn.xiaomimimo.com/v1");
  assert.notEqual(free.baseUrl, official.baseUrl);
  assert.equal(isMimoFree(official), false); assert.equal(isMimoFree(plan), false);
  assert.equal(official.defaultModel, "mimo-v2.6-flash"); assert.equal(plan.defaultModel, "mimo-v2.6-pro");
  assert.ok(official.keyUrl && plan.keyUrl); assert.equal(free.keyUrl, undefined);
  assert.match(official.note!, /按量/); assert.match(plan.note!, /tp-\/ttp-/); assert.match(free.note!, /非官方开放 API/);
  assert.match(free.note!, /不保证.*免限额/);
});

test("official MiMo request destinations and fake credentials never select bootstrap or identify as MiMoCode", () => {
  for (const [id, fakeKey] of [["xiaomi", "sk-fake-only"], ["mimo-token-plan", "tp-fake-only"]] as const) {
    const p = preset(id);
    assert.equal(endpointUrl({ baseUrl: p.baseUrl, anthropicBaseUrl: p.anthropicBaseUrl, wire: p.wire }, "chat"), `${p.baseUrl}/chat/completions`);
    assert.equal(endpointUrl({ baseUrl: p.baseUrl, anthropicBaseUrl: p.anthropicBaseUrl, wire: p.wire }, "messages"), `${p.anthropicBaseUrl}/messages`);
    const headers = upstreamHeaders(p, fakeKey);
    assert.deepEqual(headers, { "api-key": fakeKey });
    assert.equal(Object.hasOwn(headers, "x-mimo-source"), false);
    assert.equal(subscriptionSourceIssue({ ...p, billing: id === "xiaomi" ? "usage" : "subscription" }), undefined);
    assert.ok(!JSON.stringify(p).includes(fakeKey));
  }
});

test("Vertex presets advertise their dedicated adapter and no invented account configuration", () => {
  assert.equal(preset("vertex").vertexMode, "standard");
  assert.equal(preset("vertex-express").vertexMode, "express");
  for (const id of ["vertex", "vertex-express"]) assert.deepEqual(preset(id).protocols, ["gemini"]);
});

test("all documented ordinary API routes reference available presets", () => {
  for (const support of subscriptionSupport()) for (const route of support.apiRoutes ?? []) {
    for (const id of route.presetIds) assert.ok(PRESETS.some(p => p.id === id), `${support.vendor}: ${id}`);
  }
});
