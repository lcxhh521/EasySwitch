import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentLauncher } from "../src/agent-launch.ts";
import { launcherFlags, missingFlags, verifyLauncher } from "../src/verify-launchers.ts";

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

test("against a real executable: help on stdout or stderr is read, a flag that belongs to the program counts when only its top-level help has it, and a program with no help is reported as such", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-verify-"));
  try {
    const prog = join(dir, "fake-agent");
    writeFileSync(prog, `#!/bin/sh
case "$*" in
  "chat --help") echo "chat options: --reasoning LEVEL   how hard to think" >&2; exit 2 ;;
  "run --help") echo "run options: -q  quiet    --no-session  do not keep a session. Padding padding padding padding." ;;
  "--help") echo "global options: --patch FILE  overlay a configuration. Padding padding padding padding padding." ;;
  *) exit 1 ;;
esac
`);
    chmodSync(prog, 0o755);
    const verdicts = await verifyLauncher(prog, launcher);
    assert.deepEqual(verdicts.map(v => [v.form, v.helpOk, v.missing]), [["interactive", true, []], ["headless", true, []]], "stderr help, and --patch found in the top-level help");
    const broken = join(dir, "no-help");
    writeFileSync(broken, "#!/bin/sh\nexit 1\n"); chmodSync(broken, 0o755);
    const none = await verifyLauncher(broken, launcher);
    assert.ok(none.every(v => !v.helpOk && v.error), "no help text at all is said plainly, not guessed");
    const lacking = join(dir, "lacking");
    writeFileSync(lacking, "#!/bin/sh\necho \"only --reasoning exists here. Padding padding padding padding padding padding.\"\n"); chmodSync(lacking, 0o755);
    const found = await verifyLauncher(lacking, launcher);
    assert.deepEqual(found[1]!.missing.sort(), ["--no-session", "--patch", "-q"], "what is not in the help is listed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
