import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPoolSuggestions, normalizePoolModel, poolSuggestionDismissKey } from "../src/pool-suggestions.ts";

const row = (providerId: string, model: string) => ({ providerId, providerName: providerId, model });

test("normalization folds case and only documented matching publisher families", () => {
  for (const name of ["deepseek-v4", "deepseek/deepseek-v4", " DeepSeek-V4 "]) assert.equal(normalizePoolModel(name), "deepseek-v4");
  for (const [name, canonical] of [["openai/GPT-4.1", "gpt-4.1"], ["anthropic/claude-sonnet-4-5", "claude-sonnet-4-5"], ["google/gemini-2.5-pro", "gemini-2.5-pro"], ["qwen/Qwen3-32B", "qwen3-32b"], ["meta-llama/Llama-3.3-70B", "llama-3.3-70b"]]) assert.equal(normalizePoolModel(name), canonical);
  for (const name of ["company/deepseek-v4", "openai/deepseek-v4", "deepseek/team/deepseek-v4", "custom/model"]) assert.equal(normalizePoolModel(name), name);
});

test("versions, sizes, context, speed, free tiers and quantization remain distinct", () => {
  const ids = ["deepseek-v4", "deepseek-v4-flash", "deepseek-v4-0324", "deepseek-v4:free", "deepseek-v4[1m]", "deepseek-v4-q4", "deepseek-v4-32b"];
  assert.equal(new Set(ids.map(normalizePoolModel)).size, ids.length);
  for (const value of ["", " ", null, 4, "model\nname", "a".repeat(257)]) assert.equal(normalizePoolModel(value), undefined);
});

test("suggestions require two distinct sources and preserve exact outbound model identifiers", () => {
  const models = [row("b", "deepseek/deepseek-v4"), row("a", "DeepSeek-V4"), row("a", "deepseek-v4"), row("c", "deepseek-v4-flash"), row("pool", "deepseek-v4")];
  const suggestions = buildPoolSuggestions({ models, pools: [] });
  assert.equal(suggestions.length, 1); assert.equal(suggestions[0]!.model, "deepseek-v4");
  assert.deepEqual(suggestions[0]!.members.map(m => m.providerId), ["a", "b"]);
  assert.ok(suggestions[0]!.members.some(m => m.modelId === "b/deepseek/deepseek-v4"));
  assert.deepEqual(buildPoolSuggestions({ models: [row("a", "DeepSeek-V4"), row("a", "deepseek-v4")], pools: [] }), []);
});

test("member order does not change suggestion identity; membership changes do", () => {
  const models = [row("a", "m"), row("b", "m")];
  const first = buildPoolSuggestions({ models, pools: [] });
  assert.deepEqual(first, buildPoolSuggestions({ models: [...models].reverse(), pools: [] }));
  assert.notEqual(first[0]!.id, buildPoolSuggestions({ models: [...models, row("c", "m")], pools: [] })[0]!.id);
  assert.equal(first[0]!.dismissKey, poolSuggestionDismissKey("m"));
});

test("existing pool membership and local dismissal suppress proposals without changing input", () => {
  const models = [row("a", "m"), row("b", "m"), row("c", "m")];
  const original = structuredClone(models);
  assert.deepEqual(buildPoolSuggestions({ models, pools: [{ members: ["a/m", "b/m"] }] }), []);
  assert.deepEqual(buildPoolSuggestions({ models, pools: [{ members: ["a/m"] }] }), [], "an existing pool for this model is edited rather than duplicated");
  assert.deepEqual(buildPoolSuggestions({ models, pools: [], dismissed: [poolSuggestionDismissKey("m")] }), []);
  assert.deepEqual(models, original);
});
