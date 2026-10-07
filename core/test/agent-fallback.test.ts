import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentFallback } from "../src/agent-fallback.ts";

const now = Date.parse("2026-10-07T12:00:00Z");
function fixture() {
  const models = new Map([["primary/m", "primary"], ["backup/n", "backup"], ["primary/other", "primary"]]);
  const health = new Map<string, "healthy" | "unavailable" | "unknown">();
  const quota = new Map<string, number>();
  const input = { requestedModel: "primary/m", fallbackModel: "backup/n", now,
    resolveModel: (model: string) => models.has(model) ? { providerId: models.get(model)! } : undefined,
    healthOf: (id: string) => ({ status: health.get(id) ?? "unknown" }), exhaustedUntil: (id: string) => quota.get(id),
  };
  return { models, health, quota, input };
}

test("explicit backup replaces a known unavailable direct source and recovery returns the next request to its primary", () => {
  const { input, health } = fixture(); health.set("primary", "unavailable");
  assert.deepEqual(resolveAgentFallback(input), { model: "backup/n", change: { fromModel: "primary/m", toModel: "backup/n", reason: "source_unavailable", at: new Date(now).toISOString() } });
  health.set("primary", "healthy"); assert.deepEqual(resolveAgentFallback(input), { model: "primary/m" });
  assert.equal(input.requestedModel, "primary/m", "the configured binding is never overwritten");
});

test("confirmed quota exhaustion can switch an otherwise unknown source and its reset returns to primary", () => {
  const { input, quota } = fixture(); quota.set("primary", now + 1000);
  assert.equal(resolveAgentFallback(input).change?.reason, "quota_exhausted");
  assert.deepEqual(resolveAgentFallback({ ...input, now: now + 1000 }), { model: "primary/m" });
  quota.set("primary", NaN); assert.deepEqual(resolveAgentFallback(input), { model: "primary/m" });
});

test("unknown health and absent backup preserve the existing direct-request behavior", () => {
  const { input, health } = fixture();
  assert.deepEqual(resolveAgentFallback(input), { model: "primary/m" });
  health.set("primary", "unavailable");
  assert.deepEqual(resolveAgentFallback({ ...input, fallbackModel: undefined }), { model: "primary/m" });
  assert.deepEqual(resolveAgentFallback({ ...input, requestedModel: undefined }), { model: undefined });
});

test("pools keep their own routing and an already-started response can never be replayed", () => {
  const { input, health } = fixture(); health.set("primary", "unavailable");
  for (const requestedModel of ["pool/fleet", "claude-native"]) assert.deepEqual(resolveAgentFallback({ ...input, requestedModel }), { model: requestedModel });
  assert.deepEqual(resolveAgentFallback({ ...input, fallbackModel: "pool/fleet" }), { model: "primary/m" });
  assert.deepEqual(resolveAgentFallback({ ...input, responseStarted: true }), { model: "primary/m" });
});

test("missing, disabled, blocked, exhausted or identical backups cannot form a fallback loop", () => {
  const { input, health, quota, models } = fixture(); health.set("primary", "unavailable");
  assert.deepEqual(resolveAgentFallback({ ...input, fallbackModel: "primary/m" }), { model: "primary/m" });
  assert.deepEqual(resolveAgentFallback({ ...input, fallbackModel: "primary/other" }), { model: "primary/m" });
  health.set("backup", "unavailable"); assert.deepEqual(resolveAgentFallback(input), { model: "primary/m" });
  health.set("backup", "healthy"); quota.set("backup", now + 1000); assert.deepEqual(resolveAgentFallback(input), { model: "primary/m" });
  quota.clear(); models.delete("backup/n"); assert.deepEqual(resolveAgentFallback(input), { model: "primary/m" });
  models.set("backup/n", "backup"); models.delete("primary/m"); assert.deepEqual(resolveAgentFallback(input), { model: "primary/m" });
  for (const now of [NaN, Infinity, 1e30]) assert.deepEqual(resolveAgentFallback({ ...input, now }), { model: "primary/m" });
});

test("independent agents and concurrent decisions never mutate shared bindings or invent session attribution", async () => {
  const { input, health } = fixture(); health.set("primary", "unavailable");
  const results = await Promise.all(Array.from({ length: 50 }, (_, i) => Promise.resolve(resolveAgentFallback({ ...input, ...(i % 2 ? { fallbackModel: undefined } : {}) }))));
  assert.equal(results.filter(r => r.change).length, 25);
  assert.ok(results.every(r => !JSON.stringify(r).includes("session") && !JSON.stringify(r).includes("taskId")));
  assert.equal(input.requestedModel, "primary/m");
});
