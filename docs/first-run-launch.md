# First-run launch contract (B120)

This is an incremental change to the existing first-run wizard, not a new account,
provider, routing or permission system. It is based on the frozen B117–B119 candidate.

## Short default path

1. The user selects an existing source preset and explicitly chooses **添加并检测**.
   The existing credential endpoint and existing billable inference probe are used.
   Their fee notice remains visible; no login, purchase, enablement or new probe is added.
2. The current recommended installed interactive program and configured model are
   shown together. **保存并启动增强会话** explicitly saves that exact binding and then
   submits the existing launch request with that exact `provider/model`.

Changing the program/model is in a collapsed native details element. Existing
recommendation ordering is unchanged. **只保存，复制命令** remains an explicit alternative;
there is no automatic launch after source detection and no forced third confirmation.
The save and launch are separate existing API operations, not a transaction.

## Recovery and safety invariants

- The binding PUT must succeed before launch. A failed save never launches.
- A successful save followed by a launch failure stays saved, so retry only launches;
  it never creates another source or re-saves the binding as a hidden retry.
- While either operation is pending, duplicate submit/launch/dismiss actions are blocked.
- Leaving the wizard, even leaving and returning, cancels a not-yet-sent follow-on
  launch. Leaving during source creation similarly suppresses the not-yet-sent probe.
  Already sent operations are not canceled or claimed to have rolled back.
- Before launch, the captured choice is checked against current provider status,
  budget/catalog/model eligibility and installed interactive program detection.
  Missing choices remain visible and disabled; they never silently become a different
  program, model, account or native default. Backend checks remain authoritative.
- Fixed error actions navigate to source details, installed programs, usage/budget,
  doctor or settings without enabling, signing in, changing budgets or running fixes.
  A return button preserves wizard choices, including when the agent list is displayed.
  A missing selected program can be explicitly re-detected in place, even if another
  program is still installed; no automatic discovery or replacement is added.
- A removed source may be explicitly reselected by clearing only the wizard's stale
  pointer. Stored sources, credentials, configuration and history are not deleted.
- A timeout, connection failure or unclassified launch error has an uncertain outcome.
  The warning to inspect already opened windows remains after copying a command;
  no automatic retry is performed. Successful response means launch request completed,
  not real model inference proved successful.
- The POSIX-terminal command pins the chosen model instead of relying on the mutable
  saved binding. The model argument is shell quoted. No signed `/command` capability,
  key or token is fetched or copied. The command is intended for bash/zsh, not cmd.exe.
- Wizard state is page-local. Reload persistence, installation, real client operation,
  account authorization and platform visual acceptance are outside this batch.

## Verification

`core/test/onboarding-launch.test.ts` executes the actual console scripts in a VM with
synthetic DOM/events, deferred injected API responses and fake source/program records.
`core/test/onboarding-ui.test.ts` preserves the earlier source, subscription, escaping,
secret-handling and skip/retry regressions with the shorter explicit primary path.
The audited `npm run test:local` whitelist includes both; no real client/model is run.
VM HTML/event tests are not browser layout, accessibility-tool or real launch acceptance.
