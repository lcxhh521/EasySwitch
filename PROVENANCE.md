# Provenance

EasySwitch transplants code from other projects only deliberately, records every
transplant here, and rewrites what it takes. Each entry names the source project,
commit, license and how far the code was changed.

## Transplanted code

None yet. Everything in this repository was written for EasySwitch.

## Behaviour observed, not copied

| What | Source | How it was used |
|---|---|---|
| The Responses request Codex sends to a custom provider | Captured from codex-cli 0.160.0 (bundled with the ChatGPT macOS app) against a local capture server | Shape summarised in `docs/codex-request-shape.md`; drives `core/src/translate.ts` and its tests |
| `wire_api = "chat"` is no longer accepted by Codex | Error strings in the codex-cli 0.160.0 binary | Why the gateway must speak Responses to Codex |
| How existing tools wire Claude Code and Claude Desktop | Public documentation of opencodex (MIT) | Design input only: why EasySwitch does not replace a harness's gateway |

## Rules

- Never copy leaked or proprietary source (for example the Claude Code source-map leak) or code derived from it.
- MIT / Apache-2.0 code keeps its notices; Apache-2.0 transplants also record what changed.
- Proprietary payloads (for example the Claude Code binaries) are never vendored.
