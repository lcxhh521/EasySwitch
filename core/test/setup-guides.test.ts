import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilityMatrix } from "../src/capabilities.ts";
import { AGENTS } from "../src/agents.ts";
import { GUIDE_IDS, manualToken, setupGuide } from "../src/setup-guides.ts";

const input = { port: 18765, models: ["prov/alpha-1", "other/beta-2"] };

test("every app with a guide gets the address, a token that says who is asking, the models and steps, and says what was not checked", () => {
  for (const id of GUIDE_IDS) {
    const g = setupGuide(id, input)!;
    assert.ok(g, id);
    assert.ok(g.steps.length >= 3, `${id}: steps`);
    assert.deepEqual(g.models, input.models);
    const token = g.fields.find(f => f.secret)!;
    assert.equal(token.value, manualToken(id), `${id}: a stable token, the same between runs`);
    assert.match(token.value, new RegExp(`^es-session-${id}-`), "the gateway reads the app from it");
    assert.ok(g.fields.some(f => f.value.startsWith("http://127.0.0.1:18765")), `${id}: the address is this machine's gateway`);
    assert.match(g.caveat, /没有在真实的|没有核对|没有在真实/, `${id}: says what was not checked against the real app`);
    assert.match(g.caveat, /不会改|不替你改|不改/, `${id}: and that nothing of the app's is edited`);
  }
  assert.equal(setupGuide("windsurf", input), undefined, "an app with no place to type a provider has no guide");
});

test("each app is given the kind of address it takes, and WorkBuddy's file is a valid list of every model", () => {
  assert.ok(setupGuide("trae", input)!.fields[0]!.value.endsWith("/v1"), "an OpenAI-style address");
  const zcode = setupGuide("zcode", input)!.fields[0]!;
  assert.equal(zcode.value, "http://127.0.0.1:18765", "Anthropic style: the app adds /v1/messages itself");
  const wb = setupGuide("workbuddy", input)!;
  const list = JSON.parse(wb.file!.content) as Array<Record<string, any>>;
  assert.deepEqual(list.map(e => e.id), input.models);
  assert.equal(list[0]!.url, "http://127.0.0.1:18765/v1/chat/completions");
  assert.equal(list[0]!.apiKey, manualToken("workbuddy"));
  assert.match(wb.file!.path, /\.workbuddy\/models\.json/);
  assert.match(wb.file!.warning, /EasySwitch 没在运行时它们就连不上/);
});

test("the capability table calls these three 'manual' and says the others cannot be done", () => {
  const m = capabilityMatrix();
  for (const id of ["trae", "zcode", "workbuddy"]) assert.equal(m[id]!.launch.state, "manual", id);
  for (const id of ["windsurf", "doubao", "codebuddy"]) assert.equal(m[id]!.launch.state, "impossible", id);
  assert.ok(AGENTS.some(a => a.id === "workbuddy") && AGENTS.some(a => a.id === "codebuddy"), "two products, two rows");
});
