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
  "gateway-chat", "gateway-gemini", "source-adapters", "source-health", "source-health-ui", "agent-fallback", "source-health-api", "protocol-safety", "outbound-shape", "outbound-corrections", "upstream-error", "protocol-streaming", "wire", "pool", "pool-suggestions", "pool-suggestions-api", "pool-suggestions-ui", "keypool",
  "plan-provider", "codex-plan", "copilot", "mimo-free", "subscription-support", "subscription-routes", "subscription-conversation",
  "claude-native", "capabilities", "dispatch", "claude-desktop-ui", "claude-desktop-auth", "protocol-ui", "console-controls", "console-shell", "model-selection-api", "model-selection-ui", "onboarding-ui", "doctor", "endpoint-diagnostics", "doctor-api", "doctor-ui", "user-errors", "probe-cancellation", "session-stop-boundary", "task-runtime", "task-progress-ui", "task-submission-ui", "task-process", "task-runtime-api", "parallel-tasks", "parallel-api", "parallel-ui", "feedback", "suggestions", "task-accounting", "task-feedback-api", "task-feedback-ui", "gateway-usage-completeness",
  "core-supervisor", "user-cli-install", "macos-package", "local-only-guard", "provider-import", "provider-import-ui", "provider-import-api", "import-parse", "opencodex-import", "pricing", "official-pricing", "official-pricing-facts", "pricing-migration", "pricing-provenance", "usage-display", "usage-ui", "usage-observation", "gateway-usage-observation", "profiles", "siwc", "ledger", "gateway-auth", "gateway-auth-persistence", "server-auth-persistence", "server-command", "es-cli-local", "gateway-upgrade", "chatgpt-boundary", "budget", "global-budget", "ledger-incremental", "secrets", "native-keychain", "secret-store-health", "server-security", "provider-presets", "provider-preset-availability", "provider-preset-provenance", "provider-gateway-presets", "provider-preset-subscription", "provider-icons", "provider-contract", "qoder-text-bridge", "codebuddy-text-bridge", "droid-text-bridge", "cli-text-source", "cli-text-process", "vertex", "vertex-gemini", "backlog", "verify-launchers", "setup-guides", "quota", "copilot-quota", "quota-routing", "aws-eventstream", "kiro", "antigravity", "antigravity-client", "cursor", "kimi", "plan-usage", "agent-config-gaps", "mcp-stdio-bridge", "mcp-capacity", "mcp-stdio",
];
try {
  const env = { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, EASYSWITCH_HOME: join(home, "state"), EASYSWITCH_SECRETS: "memory" };
  const result = spawnSync(process.execPath, [
    "--import", "./core/test/local-only-guard.ts", "--test", "--test-force-exit",
    // These files also contain real-program tests; never even enter those test bodies.
    "--test-skip-pattern", "a REAL|a task sent to auto|a dry run says|the backlog hooks|the icon manifest is current",
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
