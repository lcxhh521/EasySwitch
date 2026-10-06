import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentLauncher } from "../src/agent-launch.ts";
import { launcherFlags, missingFlags, verifyLauncher, type HelpRunner } from "../src/verify-launchers.ts";

const launcher: AgentLauncher = {
  verified: false,
  interactive: i => ({ command: i.bin, args: ["chat", ...(i.effort ? ["--reasoning", i.effort] : [])], env: {} }),
  headless: i => ({ command: i.bin, args: ["run", "-q", "--patch", "p.yml", "--no-session", i.task ?? ""], env: {} }),
};

test("the sub-command and the flags a launcher uses are read off what it puts on the command line", () => {
  const [interactive, headless] = launcherFlags(launcher);
  assert.deepEqual(interactive, { subcommand: ["chat"], flags: ["--reasoning"] });
  assert.deepEqual(headless, { subcommand: ["run"], flags: ["-q", "--patch", "--no-session"] });
});

test("a flag is found only as a whole word in the help, not inside another flag", () => {
  const help = "Usage: x run\n  -q, --quiet      be quiet\n  --no-session-id  something else\n  --patch FILE     overlay\n";
  assert.deepEqual(missingFlags(help, ["-q", "--quiet", "--patch", "--no-session", "--session"]), ["--no-session", "--session"]);
});

test("injected help fixtures cover stdout, nonzero stderr, top-level fallback and missing help without executing a program", async () => {
  const calls: string[] = [];
  const fake: HelpRunner = async (bin, args, options) => {
    assert.equal(bin, "/never-run/fake-agent");
    assert.equal(options.timeout, 15_000); assert.equal(options.maxBuffer, 2_000_000); assert.equal(options.env.NO_COLOR, "1");
    const command = args.join(" "); calls.push(command);
    if (command === "chat --help") throw { stdout: "", stderr: "chat options: --reasoning LEVEL   how hard to think" };
    if (command === "run --help") return { stdout: "run options: -q quiet --no-session do not keep a session", stderr: "" };
    assert.equal(command, "--help");
    return { stdout: "global options: --patch FILE overlay a configuration", stderr: "" };
  };
  const verdicts = await verifyLauncher("/never-run/fake-agent", launcher, fake);
  assert.deepEqual(verdicts.map(v => [v.form, v.helpOk, v.missing]), [["interactive", true, []], ["headless", true, []]], "stderr help, and --patch found in the top-level help");
  assert.deepEqual(calls, ["chat --help", "--help", "run --help"], "top-level help is fetched once");
  const none = await verifyLauncher("/never-run/no-help", launcher, async () => { throw { stdout: "", stderr: "" }; });
  assert.ok(none.every(v => !v.helpOk && v.error), "no help text at all is said plainly, not guessed");
  const found = await verifyLauncher("/never-run/lacking", launcher, async () => ({ stdout: "only --reasoning exists here", stderr: "" }));
  assert.deepEqual(found[1]!.missing.sort(), ["--no-session", "--patch", "-q"], "what is not in the help is listed");
});
