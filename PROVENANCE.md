# Provenance

EasySwitch transplants code from other projects only deliberately, records every
transplant here, and rewrites what it takes. Each entry names the source project,
commit, license and how far the code was changed.

## Transplanted code

| What | Source | License | How far it was changed |
|---|---|---|---|
| Console design tokens (grey ground, card, pill, segmented control, indigo accent, status colours, shadow, system font stack) | Magpie, [yetone/magpie](https://github.com/yetone/magpie) @ `8b7c4ef`, `internal/gui/assets/app.css` | MIT, notice in `third_party/magpie/LICENSE` | Values adapted (accent re-stepped and validated for chart contrast, a dark theme of our own); every rule rewritten for EasySwitch's layout in `web/style.css` |
| Brand icons in `web/icons/` (23 SVGs: Codex, Claude Code, DeepSeek, Kimi, Zhipu, Qwen, MiniMax, OpenRouter, …) | LobeHub icons, [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons), as vendored by Magpie @ `8b7c4ef` | MIT, notice in `third_party/lobe-icons/LICENSE` | Unmodified assets; brand marks identify third-party products and remain their owners' trademarks |

## Design borrowed, not copied

| Idea | Source | Where |
|---|---|---|
| One row per agent with a model pop-up; a searchable picker grouped by provider with a logo rail and the harness's own default as the first option | Magpie's Agents page and model picker | `web/app.js` Agents page and picker |
| Provider list rows: logo, host · model count, which agents use it, key status | Magpie's Providers page | `web/app.js` providers page |
| Live routing diagram with plain-language reasons for each decision | Magpie's Routing page | `web/app.js` sessions page |
| Usage tiles, per-day bars and range switch | Magpie's Usage page; opencodex dashboard figures | `web/app.js` usage page |
| Status chips in the header, compact menu-bar panel | opencodex dashboard; Magpie's tray panel | `web/index.html`, `menubar/main.swift` |

## Behaviour observed, not copied

| What | Source | How it was used |
|---|---|---|
| The Responses request Codex sends to a custom provider | Captured from codex-cli 0.160.0 (bundled with the ChatGPT macOS app) against a local capture server | Shape summarised in `docs/codex-request-shape.md`; drives `core/src/translate.ts` and its tests |
| The Messages request Claude Code sends to a custom base URL | Captured from Claude Code 2.1.289 against a local capture server | Shape summarised in `docs/claude-code-request-shape.md`; drives `core/src/anthropic.ts` and its tests |
| `wire_api = "chat"` is no longer accepted by Codex | Error strings in the codex-cli 0.160.0 binary | Why the gateway must speak Responses to Codex |
| How existing tools wire Claude Code and Claude Desktop | Public documentation of opencodex (MIT) | Design input only: why EasySwitch does not replace a harness's gateway |

## Rules

- Never copy leaked or proprietary source (for example the Claude Code source-map leak) or code derived from it.
- MIT / Apache-2.0 code keeps its notices; Apache-2.0 transplants also record what changed.
- Proprietary payloads (for example the Claude Code binaries) are never vendored.
