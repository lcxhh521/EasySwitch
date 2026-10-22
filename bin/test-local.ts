/** A closed, audited whitelist. Never replace it with core/test/*.test.ts. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateLocalReport } from "./test-local-report.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "es-local-tests-home-"));
const files = [
  "accounts-auto",
  "anthropic", "translate", "responses-upstream", "quirks", "model-efforts", "thinking",
  "gateway-chat", "gateway-gemini", "source-adapters", "source-health", "source-health-ui", "agent-fallback", "source-health-api", "protocol-safety", "outbound-shape", "outbound-corrections", "upstream-error", "protocol-streaming", "custom-tool-input", "wire", "pool", "pool-suggestions", "pool-suggestions-api", "pool-suggestions-ui", "keypool",
  "plan-provider", "codex-plan", "copilot", "mimo-free", "subscription-support", "subscription-routes", "subscription-conversation",
  "claude-native", "capabilities", "claude-desktop-ui", "claude-desktop-auth", "protocol-ui", "console-controls", "console-shell", "dispatch-removal", "model-selection-api", "model-selection-ui", "onboarding-ui", "doctor", "endpoint-diagnostics", "doctor-api", "doctor-ui", "user-errors", "probe-cancellation", "session-stop-boundary", "gateway-usage-completeness",
  "core-supervisor", "user-cli-install", "macos-package", "local-only-guard", "test-local-report", "provider-import", "provider-import-ui", "provider-import-api", "import-parse", "opencodex-import", "pricing", "official-pricing", "official-pricing-facts", "pricing-migration", "pricing-provenance", "usage-display", "usage-ui", "usage-observation", "gateway-usage-observation", "profiles", "siwc", "ledger", "gateway-auth", "gateway-auth-persistence", "server-auth-persistence", "server-command", "es-cli-local", "gateway-upgrade", "chatgpt-boundary", "budget", "global-budget", "ledger-incremental", "secrets", "native-keychain", "secret-store-health", "server-security", "provider-presets", "provider-preset-availability", "provider-preset-provenance", "provider-gateway-presets", "provider-preset-subscription", "provider-icons", "provider-contract", "qoder-text-bridge", "codebuddy-text-bridge", "droid-text-bridge", "cli-text-source", "cli-text-process", "vertex", "vertex-gemini", "backlog", "verify-launchers", "setup-guides", "quota", "copilot-quota", "quota-routing", "aws-eventstream", "kiro", "antigravity", "antigravity-client", "cursor", "kimi", "plan-usage", "agent-config-gaps",
];
try {
  const env = { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, EASYSWITCH_HOME: join(home, "state"), EASYSWITCH_SECRETS: "memory",
    // Same fixture-only permission the Node runner supplies. Do not inherit it
    // from the caller or use child-v8 (which hardcodes a buffered stdout reporter).
    NODE_TEST_CONTEXT: "easyswitch-local",
  };
  const totals = { tests: 0, pass: 0, skipped: 0, todo: 0 };
  // Each file still gets its own process. Direct node:test execution avoids
  // Node's inner child-v8 pipe, whose tail can be lost during force-exit.
  for (const name of [...files, "claude-desktop"]) {
    const file = join(root, `core/test/${name}.test.ts`);
    const report = join(home, `${name}.report.json`);
    const result = spawnSync(process.execPath, [
      "--import", "./core/test/local-only-guard.ts", "--test-force-exit",
      "--test-reporter=spec", "--test-reporter-destination=stdout",
      "--test-reporter=./bin/test-local-report.ts", `--test-reporter-destination=${report}`,
      // These files also contain real-program tests; never enter those bodies.
      "--test-skip-pattern", "a REAL|a task sent to auto|a dry run says|the backlog hooks|the icon manifest is current",
      file,
    ], {
      cwd: root, stdio: "inherit", timeout: 120_000,
      env: name === "claude-desktop" ? { ...env, EASYSWITCH_TEST_DESKTOP_FIXTURES: "1" } : env,
    });
    try {
      if (result.error || result.status !== 0 || result.signal) throw result.error ?? new Error(`exit=${result.status}, signal=${result.signal}`);
      const counts = validateLocalReport(readFileSync(report, "utf8"), file);
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += counts[key];
    } catch (error) {
      console.error(`Local test file ${name} did not complete successfully: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  console.log(`Local test totals${process.exitCode ? " (INCOMPLETE; failed run)" : ""}: ${totals.tests} tests, ${totals.pass} pass, ${totals.skipped} skipped, ${totals.todo} todo`);
} finally { rmSync(home, { recursive: true, force: true }); }
