import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summarize } from "../src/ledger.ts";
import { costOf, ratesFor, vendorFor, PRICE_SOURCES } from "../src/pricing/cost.ts";
import { priceEntry } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { GatewayLogEntry, Provider } from "../src/types.ts";

const provider = (over: Partial<Provider> = {}): Provider => ({
  id: "p", name: "P", baseUrl: "https://api.deepseek.com/v1", models: [], route: "chat-translate", routePinned: false, streamUsage: true, createdAt: new Date().toISOString(), ...over,
});

test("legacy reference rates preserve prior estimates during the staged official-table migration", () => {
  assert.equal(PRICE_SOURCES.status, "legacy-unverified");
  assert.equal(PRICE_SOURCES.officialRuntimeEnabled, false);
  assert.equal(ratesFor({ baseUrl: "https://api.deepseek.com/v1" }, "deepseek-v4-flash")?.source, "legacy");
  assert.equal(vendorFor("https://api.deepseek.com/v1"), "deepseek");
  assert.deepEqual(ratesFor({ baseUrl: "https://api.deepseek.com/v1" }, "deepseek-v4-flash")?.rates, { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 });
  assert.equal(ratesFor({ baseUrl: "https://relay.example.com/v1" }, "deepseek-v4-flash")?.rates.input, 0.14, "a relay's copy is priced at the maker's rate");
  assert.equal(ratesFor({ baseUrl: "https://openrouter.ai/api/v1" }, "deepseek/deepseek-v4-flash") !== undefined, true, "vendor/model ids resolve");
  assert.equal(ratesFor({ baseUrl: "https://relay.example.com/v1" }, "glm-5.3[1m]")?.rates === undefined, ratesFor({ baseUrl: "https://relay.example.com/v1" }, "glm-5.3") === undefined, "the context suffix does not change the answer");
  assert.equal(ratesFor({ baseUrl: "https://relay.example.com/v1" }, "my-secret-model"), undefined);
});

test("the user's own price beats the table", () => {
  const mine = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 };
  const priced = ratesFor({ baseUrl: "https://api.deepseek.com/v1", prices: { "deepseek-v4-flash": mine } }, "deepseek-v4-flash")!;
  assert.equal(priced.source, "user");
  assert.deepEqual(priced.rates, mine);
});

test("cost: cached tokens bill at the cache rate, the rest of the prompt at the input rate", () => {
  const rates = { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 0 };
  // 1M prompt tokens of which 400k cached, 100k output: 0.6M*2 + 0.4M*0.5 + 0.1M*10 = 1.2 + 0.2 + 1.0
  assert.equal(Math.round(costOf(rates, { input: 1_000_000, cached: 400_000, output: 100_000 }) * 1e6) / 1e6, 2.4);
  assert.equal(costOf(rates, { input: 100, cached: 500, output: 0 }), (100 * 0.5) / 1e6, "cached can never exceed the prompt");
});

test("a finished call is priced at log time; subscriptions and unknown models say so instead of showing zero", () => {
  const store = new Store(mkdtempSync(join(tmpdir(), "es-price-")));
  store.upsertProvider(provider({ id: "ds" }));
  store.upsertProvider(provider({ id: "plan", billing: "subscription" }));
  store.upsertProvider(provider({ id: "relay", baseUrl: "https://relay.example.com/v1" }));
  const entry = (providerId: string, model: string): GatewayLogEntry => ({
    at: new Date().toISOString(), model: `${providerId}/${model}`, providerId, route: "chat-translate", harness: "codex", status: 200, ms: 1,
    inputTokens: 1_000_000, outputTokens: 1_000_000, cachedTokens: 0,
  });
  const a = entry("ds", "deepseek-v4-flash"); priceEntry(store, a);
  assert.equal(Math.round(a.costUsd! * 1e6) / 1e6, 0.42);
  const b = entry("plan", "deepseek-v4-flash"); priceEntry(store, b);
  assert.equal(b.costUsd, undefined);
  assert.equal(b.costNote, "subscription");
  const c = entry("relay", "my-secret-model"); priceEntry(store, c);
  assert.equal(c.costUsd, undefined);
  assert.equal(c.costNote, "unpriced");
  const noUsage: GatewayLogEntry = { ...entry("ds", "deepseek-v4-flash") };
  delete noUsage.inputTokens; delete noUsage.outputTokens;
  priceEntry(store, noUsage);
  assert.equal(noUsage.costUsd, undefined, "a passthrough call without usage is not priced");
  assert.equal(noUsage.costNote, undefined);

  const summary = summarize([a, b, c], "all");
  assert.equal(Math.round(summary.totals.costUsd * 1e6) / 1e6, 0.42);
  assert.equal(summary.totals.unpriced, 1);
  assert.equal(summary.totals.subscription, 1);
});
