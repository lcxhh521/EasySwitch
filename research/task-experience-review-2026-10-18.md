# Existing task-result visibility repair and remaining acceptance gates

Date: 2026-10-18. Exact source baseline: `6639b6bc9f2a07837c3aef2561ef32b37179695d`.

## User-visible repair

A task can finish before its process/token cleanup is confirmed. The task page removes these retained tasks from history and displays them in the progress section. Previously that section showed only cleanup state, making the task's recorded output inaccessible for as long as cleanup remained unresolved.

The existing progress card now offers a keyboard-native disclosure with the recorded terminal outcome and output. Cleanup state, warnings and cancellation restrictions remain visible and unchanged. Output is escaped and capped at 65,536 characters; truncation is stated. Disclosure state uses the existing per-task `data-keep` mechanism. This does not add live streaming or claim that cleanup succeeded. Completed tasks return to the existing history view after cleanup resolves.

Verification: four added regressions failed against the unchanged baseline (9 passed, 4 failed), then passed after the repair. Independent review requested a prototype-status guard and a real-script disclosure-persistence regression; both were added. Final focused run: 14 passed, 0 failed. Typecheck, JavaScript syntax and diff checks passed. An earlier full controlled run reported 1,244 tests / 1,243 passed / 1 real Keychain skipped, but predates the last guard/test and is not the final fixed-tree aggregate. Final combined fixed-tree run on Node 24.19.0: 1,272 tests, 1,271 passed, 1 real Keychain skipped, zero failures/todos. All 396 code/script hashes remained unchanged through the run. Typecheck, JS syntax, backlog-format and diff checks passed. Independent review accepted the final UI patch.

Regression fixtures cover pending and failed cleanup, completion/failure/cancellation/timeout labels, HTML escaping, oversized output, and the actual task-page transition back to history. Existing cancellation and parent/child tests remain in place. No agent/client/account or paid model was invoked.

## B100 review gate

On 2026-10-18 at 21:03 UTC, the user explicitly said “视觉评审你也来做吧 目前claude做不了了”, accepting dot as the replacement reviewer and screenshots for user acceptance. Actual visual/browser review remains pending. This repair does not close B100 or begin B101–104. The older delivery plan's named-Claude requirement is superseded only as to the reviewer, not the evidence or acceptance gate.

No Claude executable or connected Claude review tool was available in this task; the user has now replaced that reviewer. Chromium exists but the prior delivery plan records platform socket denial; no retry, sandbox weakening or alternate transport was attempted. No supported cloud browser tool was exposed. Screenshot and visual acceptance remain unperformed.

Review packet for a supported browser environment, using only synthetic fixtures:

1. At 1440, 1024 and 390px widths, inspect light, dark and system themes. Confirm formal icon, navigation, narrow-screen navigation, text contrast and all existing page/action entries remain.
2. Exercise keyboard navigation, Back/Forward, settings/account deep links, ordinary button focus after polling, failed refresh, delayed responses after navigation, and modal Close/Cancel.
3. In tasks, render single running task; terminal task with pending cleanup; failed cleanup with output; completed parent with active child; empty output; escaped HTML-like output; long output.
4. Expand retained output, allow a refresh, and confirm the disclosure stays open with keyboard focus preserved on its summary. Close it and confirm subsequent refresh does not reopen it. Confirm other task disclosures remain independent.
5. Keep cleanup warnings visible; no failed/pending cleanup may be portrayed as safe completion. Once cleanup is confirmed, locate output in history; repeated cancellation remains single-flight.
6. Record screenshots and exact browser/version/source SHA. A source/VM pass does not substitute for these browser checks.

## Real single-agent acceptance remains separate

The approved cloud-only synthetic scope cannot establish a real-client task loop. Before that acceptance, select the specific fixed-version client, separately authorize its install/execution if required, and establish private HOME/config, no inherited credentials/plugins/hooks, local fake upstream, network restrictions, bounded tool/workspace permissions, and resource ownership/cancellation checks. Do not use a normal model request as evidence that an actual agent ran. The user must personally handle any Codex-account use on dot's cloud computer; none is needed for this patch.

This document asks for no architecture change. The three architecture choices in the delivery plan remain pending.
