import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { discoverEfforts, parseHelpLevels, sortLevels } from "../src/efforts.ts";
import { findClaude, findCodex } from "../src/launch.ts";

const CLAUDE_HELP = `  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --environment <environment_id>        Create a new cloud session that runs on`;
const HERMES_HELP = `  --reasoning LEVEL     Reasoning effort for this session: none, minimal, low,
                        medium, high, xhigh, max, or ultra. Overrides
                        agent.reasoning_effort for this run only`;

test("levels are read from the program's own help, in the program's own words", () => {
  assert.deepEqual(parseHelpLevels(CLAUDE_HELP, "--effort"), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(parseHelpLevels(HERMES_HELP, "--reasoning"), ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(parseHelpLevels("--effort <level>  How hard to try, this run, or that", "--effort"), undefined, "prose is not a list of levels");
  assert.equal(parseHelpLevels("nothing here", "--effort"), undefined);
});

test("levels sort from weakest to strongest, unknown ones last", () => {
  assert.deepEqual(sortLevels(["ultra", "low", "ultracode", "high", "none"]), ["none", "low", "high", "ultra", "ultracode"]);
});

test("the installed Claude Code, Codex and Hermes each report their own levels", async t => {
  const claude = await findClaude();
  if (claude) assert.ok((await discoverEfforts("claude", claude))?.levels.includes("max"), "Claude Code");
  const codex = await findCodex();
  if (codex) {
    const found = await discoverEfforts("codex", codex);
    assert.ok(found && found.levels.includes("medium"), "Codex reports levels");
    assert.ok(Object.keys(found!.perModel ?? {}).length > 0, "and which model has which");
  }
  const hermes = `${process.env.HOME}/.local/bin/hermes`;
  if (existsSync(hermes)) assert.ok((await discoverEfforts("hermes", hermes))?.levels.includes("ultra"), "Hermes has ultra");
  if (!claude && !codex) t.skip("nothing installed");
});
