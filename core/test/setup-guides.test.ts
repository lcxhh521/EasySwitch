import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityMatrix } from "../src/capabilities.ts";
import { AGENTS } from "../src/agents.ts";
import { GUIDE_IDS, setupGuide } from "../src/setup-guides.ts";

const input = { token: "fixture-issued-token", port: 18765, models: ["prov/alpha-1", "other/beta-2"] };

test("every app with a guide gets the address, a token that says who is asking, the models and steps, and says what was not checked", () => {
  for (const id of GUIDE_IDS) {
    const g = setupGuide(id, input)!;
    assert.ok(g, id);
    assert.ok(g.steps.length >= 3, `${id}: steps`);
    assert.deepEqual(g.models, input.models);
    const token = g.fields.find(f => f.secret)!;
    assert.equal(token.value, input.token, `${id}: the authority-issued token is passed through`);
    assert.ok(g.fields.some(f => f.value.startsWith("http://127.0.0.1:18765")), `${id}: the address is this machine's gateway`);
    assert.match(g.caveat, /没有在真实的|没有核对|没有在真实/, `${id}: says what was not checked against the real app`);
    assert.match(g.caveat, /不会改|不替你改|不改/, `${id}: and that nothing of the app's is edited`);
  }
  assert.equal(setupGuide("windsurf", input), undefined, "an app with no place to type a provider has no guide");
});

test("each app gets its documented address and WorkBuddy uses the current UI without invented model capacities", () => {
  assert.ok(setupGuide("trae", input)!.fields[0]!.value.endsWith("/v1"));
  assert.equal(setupGuide("zcode", input)!.fields[0]!.value, "http://127.0.0.1:18765");
  const wb = setupGuide("workbuddy", input)!;
  assert.equal(wb.fields[0]!.value, "http://127.0.0.1:18765/v1/chat/completions");
  assert.equal(wb.file, undefined);
  assert.match(wb.steps.join(" "), /Custom Protocol/);
  assert.equal(wb.fields.find(f => f.secret)!.value, input.token);
  assert.ok(wb.sources?.length);
  assert.doesNotMatch(JSON.stringify(wb), /200000|32000|contextWindow|toolUse/);
});

test("the capability table calls these three 'manual' and says the others cannot be done", () => {
  const m = capabilityMatrix();
  for (const id of ["trae", "zcode", "workbuddy"]) assert.equal(m[id]!.launch.state, "manual", id);
  assert.equal(m.codebuddy!.launch.state, "documented");
  for (const id of ["windsurf", "doubao"]) assert.equal(m[id]!.launch.state, "impossible", id);
  assert.ok(AGENTS.some(a => a.id === "workbuddy") && AGENTS.some(a => a.id === "codebuddy"), "two products, two rows");
});
