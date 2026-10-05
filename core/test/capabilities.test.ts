import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "../src/agents.ts";
import { LAUNCHERS, type AgentLauncher } from "../src/agent-launch.ts";
import { capabilityMatrix, coverage, FEATURES, launcherCarriesMcp, launcherHasOwnEffort, type CapState } from "../src/capabilities.ts";

const STATES: CapState[] = ["verified", "documented", "manual", "impossible", "todo", "na"];
const matrix = capabilityMatrix();

test("every agent has an explicit state for every feature: nothing is left unsaid", () => {
  for (const a of AGENTS) {
    for (const f of FEATURES) {
      const cap = matrix[a.id]?.[f.id];
      assert.ok(cap, `${a.id} has no entry for ${f.id}`);
      assert.ok(STATES.includes(cap.state), `${a.id}.${f.id}: ${String(cap.state)}`);
    }
  }
  assert.equal(Object.keys(matrix).length, AGENTS.length);
});

test("something impossible always says why, and something not done always says what is missing", () => {
  for (const a of AGENTS) {
    for (const f of FEATURES) {
      const cap = matrix[a.id]![f.id];
      if (cap.state === "impossible") assert.ok(cap.note && cap.note.length >= 6, `${a.id}.${f.id} is impossible without a reason`);
      if (cap.state === "todo") assert.ok(cap.note, `${a.id}.${f.id} is not done and does not say what is missing`);
    }
  }
});

test("'ready' means the launch was tried against the real program, and 'verified' is never claimed without a launcher that says so", () => {
  for (const a of AGENTS) {
    if (a.support === "ready") assert.equal(LAUNCHERS[a.id]?.verified, true, `${a.id} is listed as ready but its launcher was never run against the real program`);
    for (const f of ["launch", "task"] as const) {
      if (matrix[a.id]![f].state === "verified") assert.equal(LAUNCHERS[a.id]?.verified, true, `${a.id}.${f}`);
    }
  }
});

test("closed apps are never claimed to launch, and a launcher implies launch or task is at least written", () => {
  for (const a of AGENTS) {
    const l = LAUNCHERS[a.id];
    const { launch, task } = matrix[a.id]!;
    if (a.support === "open") {
      assert.ok(launch.state !== "verified" && launch.state !== "documented", `${a.id} is open (no endpoint) yet launch says ${launch.state}`);
    }
    if (l?.interactive) assert.ok(["verified", "documented"].includes(launch.state), a.id);
    if (l?.headless) assert.ok(["verified", "documented"].includes(task.state), a.id);
  }
});

test("MCP and thinking-level support are read off what the launchers really do", () => {
  // Codex and Claude Code carry the MCP server today; nobody else yet.
  const carrying = AGENTS.filter(a => launcherCarriesMcp(LAUNCHERS[a.id])).map(a => a.id).sort();
  assert.deepEqual(carrying, ["claude", "codex"], "update the matrix expectation when another launcher learns to carry MCP");
  assert.equal(matrix.codex!.mcp.state, "verified");
  assert.equal(matrix.claude!.mcp.state, "verified");
  assert.equal(matrix.hermes!.mcp.state, "todo");
  // A launcher that grows an MCP argument is noticed without anyone editing a table.
  const fake: AgentLauncher = { verified: false, headless: i => ({ command: i.bin, args: i.mcp ? ["--mcp", i.mcp.url] : [], env: {} }) };
  assert.equal(launcherCarriesMcp(fake), true);
  assert.equal(launcherCarriesMcp({ verified: false, headless: i => ({ command: i.bin, args: [], env: {} }) }), false);
  assert.equal(launcherHasOwnEffort({ verified: false, headless: i => ({ command: i.bin, args: i.effort ? ["--effort", i.effort] : [], env: {} }) }), true);
  assert.equal(launcherHasOwnEffort({ verified: false, headless: i => ({ command: i.bin, args: [], env: {} }) }), false);
  for (const id of ["claude", "codex", "hermes"]) assert.match(matrix[id]!.effort.note ?? "", /自己的档位/, `${id} has its own flag`);
});

test("Claude's subscription is never offered to other harnesses, and Claude's desktop app is not touched", () => {
  assert.equal(matrix.claude!.source.state, "impossible");
  assert.match(matrix.claude!.source.note!, /不借给别的 harness/);
  assert.ok(AGENTS.some(a => a.id === "claude-desktop"), "the Claude desktop app is in the catalog");
  assert.equal(matrix["claude-desktop"]!.launch.state, "impossible");
  assert.match(matrix["claude-desktop"]!.launch.note!, /拦截/);
});

test("the coverage summary adds up, and says plainly how much is still to do", t => {
  const rows = coverage(matrix);
  for (const row of rows) {
    const total = Object.values(row.counts).reduce((a, b) => a + b, 0);
    assert.equal(total, AGENTS.length, row.feature);
    assert.equal(row.applies, AGENTS.length - row.counts.na);
    assert.equal(row.settled, row.applies - row.counts.todo);
  }
  // Printed in the test run, so every run shows where things stand.
  for (const row of rows) t.diagnostic(`${row.label}: 已定 ${row.settled}/${row.applies}（实测 ${row.counts.verified}，按文档 ${row.counts.documented}，手动 ${row.counts.manual}，做不了 ${row.counts.impossible}，没做 ${row.counts.todo}）`);
});
