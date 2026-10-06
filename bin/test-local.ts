/** A closed, audited whitelist. Never replace it with core/test/*.test.ts. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "es-local-tests-home-"));
const files = [
  "anthropic", "translate", "responses-upstream", "quirks", "model-efforts", "thinking",
  "gateway-chat", "gateway-gemini", "source-adapters", "protocol-safety", "protocol-streaming", "wire", "pool", "keypool",
  "plan-provider", "codex-plan", "copilot", "mimo-free", "subscription-support", "subscription-routes", "subscription-conversation",
  "claude-native", "capabilities", "dispatch", "claude-desktop-ui", "protocol-ui", "console-controls",
  "gateway-auth", "gateway-upgrade", "chatgpt-boundary", "budget", "global-budget", "ledger-incremental", "secrets", "native-keychain", "server-security", "provider-presets", "provider-contract", "qoder-text-bridge", "codebuddy-text-bridge", "droid-text-bridge", "cli-text-source", "cli-text-process", "vertex", "vertex-gemini", "backlog", "verify-launchers", "setup-guides", "quota", "kiro", "antigravity", "cursor", "kimi", "plan-usage", "agent-config-gaps", "mcp-stdio-bridge", "mcp-stdio",
];
try {
  const env = { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, EASYSWITCH_HOME: join(home, "state"), EASYSWITCH_SECRETS: "memory" };
  const result = spawnSync(process.execPath, [
    "--import", "./core/test/local-only-guard.ts", "--test", "--test-force-exit",
    // These files also contain real-program tests; never even enter those test bodies.
    "--test-skip-pattern", "a REAL|a task sent to auto|a dry run says|the backlog hooks",
    ...files.map(name => `core/test/${name}.test.ts`),
  ], {
    cwd: root, stdio: "inherit",
    env,
  });
  if (result.error) { console.error(result.error.message); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
  const desktop = spawnSync(process.execPath, ["--import", "./core/test/local-only-guard.ts", "--test", "--test-force-exit", "core/test/claude-desktop.test.ts"], {
    cwd: root, stdio: "inherit", env: { ...env, EASYSWITCH_TEST_DESKTOP_FIXTURES: "1" },
  });
  if (desktop.error) console.error(desktop.error.message);
  if (desktop.error || desktop.status !== 0) process.exitCode = 1;
} finally { rmSync(home, { recursive: true, force: true }); }
