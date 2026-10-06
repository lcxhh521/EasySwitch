import assert from "node:assert/strict";
import { test } from "node:test";
import { safeUpstreamReason } from "../src/upstream-error.ts";

test("translated error reasons preserve useful categories without echoing any upstream text", async () => {
  for (const [message, expected] of [["prompt too long", "input exceeds"], ["model not found", "model is unavailable"], ["invalid api key", "authentication failed"], ["quota exhausted", "quota or rate"], ["permission denied", "permission denied"]]) {
    const reason = await safeUpstreamReason(Response.json({ error: { message: `${message}; Bearer opaque-secret JWT eyJsecret.opaque.sig ya29.secret-value prompt=PRIVATE` } }));
    assert.ok(reason.includes(expected!)); assert.doesNotMatch(reason, /opaque|eyJ|ya29|PRIVATE|Bearer/);
  }
  assert.equal(await safeUpstreamReason(Response.json({ error: { message: "PRIVATE arbitrary exception" } })), "");
});

test("error body reads stop at the byte cap and do not echo content hidden after it", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(Buffer.from("x".repeat(4096))); c.enqueue(Buffer.from("invalid api key and PRIVATE")); }, cancel() { cancelled = true; } });
  assert.equal(await safeUpstreamReason(new Response(body)), "");
  assert.equal(cancelled, true);
});

test("a stalled error body or cancellation promise cannot hang diagnostic handling", { timeout: 2000 }, async () => {
  const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
  const started = performance.now(); assert.equal(await safeUpstreamReason(new Response(body)), "");
  assert.ok(performance.now() - started < 1000);
});

test("invalid JSON, read failures and successful cancellation never expose raw provider errors", async () => {
  assert.equal(await safeUpstreamReason(new Response("Bearer secret-only-payload")), "");
  assert.equal(await safeUpstreamReason(new Response(new ReadableStream({ start(c) { c.error(new Error("PRIVATE")); } }))), "");
});
