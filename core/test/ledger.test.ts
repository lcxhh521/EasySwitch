import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Ledger, summarize } from "../src/ledger.ts";
import { iconForBaseUrl } from "../src/presets.ts";
import type { GatewayLogEntry } from "../src/types.ts";

const NOW = new Date("2026-10-05T16:00:00+08:00");

function entry(at: string, over: Partial<GatewayLogEntry> = {}): GatewayLogEntry {
  return { at, model: "relay/m", providerId: "relay", route: "chat-translate", harness: "codex", status: 200, ms: 5, inputTokens: 100, outputTokens: 10, cachedTokens: 40, ...over };
}

test("the ledger appends numbers only and reads back by date", () => {
  const ledger = new Ledger(mkdtempSync(join(tmpdir(), "es-ledger-")));
  ledger.append(entry("2026-10-01T10:00:00+08:00"));
  ledger.append(entry("2026-10-05T10:00:00+08:00", { harness: "claude" }));
  assert.equal(ledger.read().length, 2);
  assert.equal(ledger.read(new Date("2026-10-03T00:00:00+08:00")).length, 1);
});

test("a 7-day summary has a slot for every day, quiet days included", () => {
  const summary = summarize([
    entry("2026-10-01T10:00:00+08:00"),
    entry("2026-10-05T09:00:00+08:00", { harness: "claude", providerId: "other", model: "other/m" }),
    entry("2026-10-05T09:30:00+08:00", { status: 502, inputTokens: undefined, outputTokens: undefined, cachedTokens: undefined }),
  ], "7d", NOW);
  assert.equal(summary.days.length, 7);
  assert.equal(summary.days[0]!.day, "2026-09-29");
  assert.equal(summary.days.at(-1)!.day, "2026-10-05");
  assert.equal(summary.days.at(-1)!.calls, 2);
  assert.deepEqual(
    { calls: summary.totals.calls, errors: summary.totals.errors, unmetered: summary.totals.unmetered, input: summary.totals.inputTokens },
    { calls: 3, errors: 1, unmetered: 1, input: 200 },
  );
  assert.equal(summary.cacheHitRate, 0.4);
  assert.deepEqual(Object.keys(summary.byProvider).sort(), ["other", "relay"]);
  assert.deepEqual(Object.keys(summary.byHarness).sort(), ["claude", "codex"]);
});

test("provider icons follow the host; only Ollama's port on localhost reads as Ollama", () => {
  assert.equal(iconForBaseUrl("https://api.deepseek.com/v1"), "deepseek-color");
  assert.equal(iconForBaseUrl("https://api.moonshot.cn/v1"), "kimi");
  assert.equal(iconForBaseUrl("http://127.0.0.1:11434/v1"), "ollama");
  assert.equal(iconForBaseUrl("http://127.0.0.1:10100/v1"), "newapi-color");
  assert.equal(iconForBaseUrl("https://relay.example.com/v1"), "newapi-color");
  assert.equal(iconForBaseUrl("not a url"), "newapi-color");
});
