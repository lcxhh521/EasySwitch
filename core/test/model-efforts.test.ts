import assert from "node:assert/strict";
import { test } from "node:test";
import { codexCatalog } from "../src/catalog.ts";
import { claudeCapabilities } from "../src/launch.ts";
import { levelsForAgentAndModel, modelEfforts } from "../src/model-efforts.ts";
import { applyEffort } from "../src/quirks.ts";
import type { Provider } from "../src/types.ts";

const provider = (baseUrl: string, extra: Partial<Provider> = {}): Provider => ({ id: "p", name: "P", baseUrl, models: [], route: "chat-translate", routePinned: false, streamUsage: true, ...extra }) as Provider;

test("a model's levels follow how its provider takes a level", () => {
  assert.deepEqual(modelEfforts(provider("https://api.openai.com/v1"), "gpt-5.5"), ["minimal", "low", "medium", "high"]);
  assert.deepEqual(modelEfforts(provider("https://openrouter.ai/api/v1"), "some/model"), ["low", "medium", "high"]);
  assert.deepEqual(modelEfforts(provider("https://api.deepseek.com/v1"), "deepseek-chat"), ["none", "high"], "an on/off switch has two states");
  assert.deepEqual(modelEfforts(provider("https://relay.example/v1"), "x"), [], "a provider that takes none leaves nothing to set");
});

test("the user's own word for a model's levels wins", () => {
  const p = provider("https://relay.example/v1", { modelEfforts: { "big-model": ["low", "high", "xhigh", "max"] } });
  assert.deepEqual(modelEfforts(p, "big-model"), ["low", "high", "xhigh", "max"]);
  assert.deepEqual(modelEfforts(p, "other"), []);
});

test("an agent offers only the levels it can say that the model also has, in its own order", () => {
  assert.deepEqual(levelsForAgentAndModel(["low", "medium", "high", "xhigh", "max"], ["none", "high"]), ["high"]);
  assert.deepEqual(levelsForAgentAndModel(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], ["low", "high", "max"]), ["low", "high", "max"]);
  assert.deepEqual(levelsForAgentAndModel(["low", "high"], undefined), ["low", "high"], "no model, the agent's own list");
  assert.deepEqual(levelsForAgentAndModel(["low", "high"], []), []);
});

test("a level the model is known to have goes through as it is; one it lacks becomes the closest the scale holds", () => {
  const sent = (level: string, has: string[]) => { const c = { model: "m", messages: [], stream: false } as never; applyEffort(c, level, "effort", has); return (c as { reasoning_effort?: string }).reasoning_effort; };
  assert.equal(sent("xhigh", ["low", "high", "xhigh"]), "xhigh", "the relay takes xhigh, the user said so");
  assert.equal(sent("xhigh", ["low", "high"]), "high");
  assert.equal(sent("ultra", []), "high");
});

test("Codex is shown each model's own levels, with a default it can point at", () => {
  const template = { slug: "t", supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" };
  const out = codexCatalog(template, [
    { providerId: "a", providerName: "A", model: "m1", efforts: ["low", "high", "max"] },
    { providerId: "b", providerName: "B", model: "m2", efforts: ["none", "high"] },
    { providerId: "c", providerName: "C", model: "m3", efforts: [] },
  ]).models as Array<{ slug: string; supported_reasoning_levels: Array<{ effort: string }>; default_reasoning_level: string }>;
  assert.deepEqual(out[0]!.supported_reasoning_levels.map(l => l.effort), ["low", "high", "max"]);
  assert.equal(out[0]!.default_reasoning_level, "high");
  assert.equal(out[1]!.default_reasoning_level, "high");
  assert.equal(out[2]!.supported_reasoning_levels.length, 1, "a model with none still has an entry, since Codex wants a default");
});

test("Claude Code is told which of our models have an effort setting, and which top levels", () => {
  const caps = claudeCapabilities([
    { providerId: "a", model: "m1", efforts: ["low", "high", "xhigh", "max"] },
    { providerId: "b", model: "m2", efforts: ["low", "medium", "high"] },
    { providerId: "c", model: "m3", efforts: [] },
    { providerId: "d", model: "m4", efforts: ["none", "high"] },
  ]);
  const segs = caps.split(";");
  assert.equal(segs.length, 3, "a model with no levels is not named");
  assert.match(segs[0]!, /^es-claude-a--m1=effort,xhigh_effort,max_effort$/);
  assert.match(segs[1]!, /^es-claude-b--m2=effort$/);
  assert.match(segs[2]!, /^es-claude-d--m4=effort$/);
});
