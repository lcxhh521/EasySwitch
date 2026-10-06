import assert from "node:assert/strict";
import { test } from "node:test";
import { codexCatalog } from "../src/catalog.ts";
import { claudeCapabilities } from "../src/launch.ts";
import { levelsForAgentAndModel, modelEfforts, resolveModelEffort } from "../src/model-efforts.ts";
import { applyOfficialProtocolEffort, applyEffort, officialThinkingProfile, quirksFor } from "../src/quirks.ts";
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


test("DeepSeek current official model levels include off plus the documented three strengths", () => {
  for (const model of ["deepseek-flash", "deepseek-v4-pro", "deepseek-v4-flash", "deepseek-flash[1m]"]) {
    assert.deepEqual(modelEfforts(provider("https://api.deepseek.com/v1"), model), ["none", "low", "high", "max"]);
    assert.equal(quirksFor("https://api.deepseek.com/v1", model).reasoning, "thinking-effort");
  }
  assert.equal(officialThinkingProfile("https://api.deepseek.com.evil.test/v1", "deepseek-flash"), undefined);
  assert.equal(officialThinkingProfile("https://relay.example/v1", "deepseek-flash"), undefined);
});

test("DeepSeek maps legacy agent words without conflating minimal with thinking off", () => {
  for (const [input, enabled, expected] of [["none", false, undefined], ["minimal", true, "low"], ["low", true, "low"], ["medium", true, "high"], ["high", true, "high"], ["xhigh", true, "high"], ["max", true, "max"], ["ultra", true, "max"]] as const) {
    const body: any = { model: "deepseek-flash", messages: [], stream: false, reasoning_effort: "stale" };
    applyEffort(body, input, "thinking-effort", ["none", "low", "high", "max"]);
    assert.deepEqual(body.thinking, { type: enabled ? "enabled" : "disabled" });
    assert.equal(body.reasoning_effort, expected);
  }
});

test("Kimi controls are model-specific and limited to the official API hosts", () => {
  for (const host of ["https://api.moonshot.cn/v1", "https://api.moonshot.ai/v1"]) {
    assert.deepEqual(modelEfforts(provider(host), "kimi-k3"), ["low", "high", "max"]);
    assert.deepEqual(modelEfforts(provider(host), "kimi-k2.6"), ["none", "high"]);
    assert.deepEqual(modelEfforts(provider(host), "kimi-k2.7-code"), []);
    assert.deepEqual(modelEfforts(provider(host), "kimi-k2.7-code-highspeed"), []);
    assert.deepEqual(modelEfforts(provider(host), "kimi-unknown"), []);
  }
  assert.equal(officialThinkingProfile("https://api.kimi.com/coding/v1", "kimi-for-coding"), undefined, "do not guess which model the coding alias currently points at");
  assert.deepEqual(modelEfforts(provider("https://relay.example/v1"), "kimi-k3"), []);
});

test("Kimi binary switch preserves keep and clears conflicting effort; always-on model ignores stale switches", () => {
  const binary: any = { model: "kimi-k2.6", messages: [], stream: false, thinking: { keep: "all" }, reasoning_effort: "max" };
  applyEffort(binary, "none", "thinking");
  assert.deepEqual(binary.thinking, { type: "disabled", keep: "all" });
  assert.equal(binary.reasoning_effort, undefined);
  const always: any = { model: "kimi-k2.7-code", messages: [], stream: false, thinking: { type: "disabled" }, reasoning_effort: "low" };
  applyEffort(always, "none", "always-thinking");
  assert.equal(always.thinking, undefined); assert.equal(always.reasoning_effort, undefined);
  const k3: any = { model: "kimi-k3", messages: [], stream: false };
  applyEffort(k3, "none", "effort", ["low", "high", "max"]);
  assert.equal(k3.reasoning_effort, "low", "always-on models do not receive an invented minimal level");
  applyEffort(k3, "max", "effort", ["low", "high", "max"]);
  assert.equal(k3.reasoning_effort, "max");
});

test("explicit provider level overrides are copied and take precedence over official defaults", () => {
  const p = provider("https://api.deepseek.com/v1", { modelEfforts: { "deepseek-flash": ["high"] } });
  const levels = modelEfforts(p, "deepseek-flash[1m]"); levels.push("fake");
  assert.deepEqual(modelEfforts(p, "deepseek-flash"), ["high"]);
  assert.deepEqual(modelEfforts(provider("https://api.moonshot.cn/v1", { reasoningEffort: false }), "kimi-k3"), []);
});


test("DeepSeek native Messages and Responses express off and intensity using their own fields", () => {
  for (const protocol of ["messages", "responses"] as const) {
    for (const [input, expected] of [["none", "none"], ["minimal", "low"], ["medium", "high"], ["max", "max"], ["ultra", "max"]]) {
      const body: any = protocol === "messages" ? { output_config: { effort: "stale", format: "preserve" } } : { reasoning: { summary: "auto" } };
      assert.equal(applyOfficialProtocolEffort(body, protocol, "https://api.deepseek.com/v1", "deepseek-flash", input), true);
      if (protocol === "responses") assert.deepEqual(body.reasoning, { summary: "auto", effort: expected });
      else {
        assert.equal(body.thinking.type, expected === "none" ? "disabled" : "enabled");
        assert.equal(body.output_config.effort, expected === "none" ? undefined : expected);
        assert.equal(body.output_config.format, "preserve");
      }
    }
  }
  assert.equal(applyOfficialProtocolEffort({}, "messages", "https://relay.example", "deepseek-flash", "high"), false);
  assert.equal(applyOfficialProtocolEffort({}, "gemini", "https://api.deepseek.com", "deepseek-flash", "high"), false);
});


test("agent off and model none intersect without changing either side's vocabulary", () => {
  assert.deepEqual(levelsForAgentAndModel(["off", "low", "medium", "high"], ["none", "high"]), ["off", "high"]);
  assert.deepEqual(levelsForAgentAndModel(["none", "high"], ["off", "high"]), ["none", "high"]);
  assert.deepEqual(levelsForAgentAndModel(["off", "minimal", "high"], ["low", "high"]), ["high"], "minimal/low do not mean off");
  assert.equal(resolveModelEffort("off", ["none", "high"]), "none");
  assert.equal(resolveModelEffort("none", ["off", "high"]), "off");
  assert.equal(resolveModelEffort("none", ["off", "none"]), "none", "an exact declared model value wins");
  assert.equal(resolveModelEffort("off", ["low", "high", "max"]), undefined, "always-on Kimi K3 cannot offer off");
  assert.equal(resolveModelEffort("minimal", ["none", "high"]), undefined);
});
