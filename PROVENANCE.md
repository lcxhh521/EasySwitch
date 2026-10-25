# Provenance

EasySwitch transplants code from other projects only deliberately, records every
transplant here, and rewrites what it takes. Each entry names the source project,
commit, license and how far the code was changed.

## Transplanted code

These are historical source records. Current replacement status is recorded in
the release-preparation table below; historical entries do not mean the original
assets or implementations are still present.

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
| Feeding a harness's own `/model` menu: a Codex catalog via `model_catalog_json`; Claude Code ids that contain `claude` but do not start with `claude-` | opencodex (MIT), `src/codex/catalog*`, `src/claude/alias.ts` | `core/src/catalog.ts`; our catalog is per launch (opencodex writes it into the global config), our id encoding is our own (`es-claude-<provider>--<model>`) |

## Behaviour observed, not copied

| What | Source | How it was used |
|---|---|---|
| The Responses request Codex sends to a custom provider | Captured from codex-cli 0.160.0 (bundled with the ChatGPT macOS app) against a local capture server | Shape summarised in `docs/codex-request-shape.md`; drives `core/src/translate.ts` and its tests |
| The Messages request Claude Code sends to a custom base URL | Captured from Claude Code 2.1.289 against a local capture server | Shape summarised in `docs/claude-code-request-shape.md`; drives `core/src/anthropic.ts` and its tests |
| `wire_api = "chat"` is no longer accepted by Codex | Error strings in the codex-cli 0.160.0 binary | Why the gateway must speak Responses to Codex |
| How existing tools wire Claude Code and Claude Desktop | Public documentation of opencodex (MIT) | Design input only: why EasySwitch does not replace a harness's gateway |
| Cost estimation: price table (USD per 1M tokens: input / output / cache read / cache write; 1,233 models, host → vendor index), precedence user price → table → unpriced, cache reads billed at the cache rate, display-time estimates never billing | opencodex (MIT): `scripts/model-metadata.source.json` (data), `src/usage/cost.ts` and `src/usage/expected-prices.ts` (method and precedence) | MIT | Historical legacy table retained with unchanged numbers and an explicit unverified label; runtime estimator remains `core/src/pricing/cost.ts`. New `scripts/build-prices.mjs` compiles a separate official-facts input into `official-prices.json`, not yet used for production budgets. See `docs/pricing-migration.md`; historical attribution and license remain. The upstream budget-ceiling ledger is not ported |
| Per-launch overrides of other agents (dsh `--patch` with an `llm-pi-ai` provider, qwen-code / aider / copilot env and flags, opencode inline config) and the headless "hand a task to an agent" forms | Run against the real DeepSeek Harness here; opencodex `src/clients/config-export/dsh.ts` (MIT) for the provider block shape; vendors' documented options for the others (marked unverified in the console) | MIT / vendor docs | `core/src/agent-launch.ts`, written fresh; patch text, session directories and tokens are per launch |
| Inbound OpenAI Chat Completions endpoint (pass-through with quirks, usage tap, per-launch agent token) | OpenAI's public API shape; quirks as above | n/a | `core/src/gateway-chat.ts` |
| Agent catalog (31 agents, support tiers, detection) | opencodex integrations docs and provider-icons, Magpie `internal/agent/*.go`, CC Switch's supported-app list, vendor docs | MIT; marks belong to their owners | `core/src/agents.ts`, hand-written per agent; per-launch hooks recorded in the note of each entry |
| ChatGPT desktop gateway (merged model list with an ETag over both lists; native requests forwarded with the app's own headers; raw WebSocket pipe; per-launch `openai_base_url`) | Magpie `internal/gateway/codex_backend.go` and `internal/codexcat` (MIT); opencodex catalog injection (MIT); `codex app-server` behaviour observed with a fake login | MIT | `core/src/chatgpt-gateway.ts`, written fresh; nothing is stored or logged from forwarded traffic |
| Provider brand marks (65 SVGs in `web/icons`: the lobe-icons set plus ~40 provider logos from opencodex's `gui/public/provider-icons`) and the preset → mark table | lobe-icons (MIT) via Magpie; opencodex (MIT), whose own sources are listed in `third_party/opencodex-provider-icons/SOURCES.md` | MIT; the marks themselves belong to their owners and are used only to identify the service | Files unmodified; `scripts/icon-manifest.mjs` classifies single-colour vs coloured marks by content so dark themes render correctly; presets without a mark get a letter avatar |
| Provider and model quirks a chat-translate gateway absorbs (reasoning_content replay, tool_choice shape, parallel_tool_calls, tool-call pairing repair, null content, `[1m]` suffix, locked sampling params, `$ref` flattening for Moonshot, cache-key and URL handling) | opencodex (MIT) `src/adapters/openai-chat/**`, `src/providers/registry/**`, `src/tool-schema.ts`; Magpie (MIT, yetone/magpie) `internal/gateway/chat*.go`, `presets.go` | MIT | Re-expressed as a small per-host/model profile and a shaping pass in `core/src/quirks.ts`; the Anthropic-compatible addresses of Kimi coding, Qwen and Volcengine coding come from Magpie's presets |
| Provider preset table (historical import; current public table has 67 entries) | opencodex (MIT), `src/providers/registry/entries-core.ts` and `entries-extended.ts`, recorded as read 2026-10-05; upstream commit not recorded | MIT | Historical attribution retained. `core/src/presets.ts` assembles 6 explicitly legacy rows and sixty-one fresh reconstructions from `preset-facts.ts` / `presets-official.ts`. Field-level facts retain official links, checkedAt and scope; stable identity/order/categories/icons and IPv4-loopback normalization are EasySwitch choices. Documentation checks are not live service verification. |
| Per-process account isolation: `CLAUDE_CONFIG_DIR` separates Claude Code's login, settings and history; `CODEX_HOME` separates Codex's auth.json, sessions and config; a refresh token belongs to one home only | Official Claude Code authentication docs; `codex doctor`, `codex login --help` and strings of codex-cli 0.160.0 | `core/src/accounts.ts`; deliberately not what opencodex or Magpie do (they swap auth files or proxy subscription traffic) |
| Fields Codex 0.160 requires in a catalog entry; newer GPT entries use `tool_mode = "code_mode_only"`, under which a non-GPT model never calls a tool | `codex debug models` and parse errors from codex-cli 0.160.0 | Entries start from a classic-tool model of the installed Codex at runtime; nothing from Codex is stored here |
| With `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`, Claude Code 2.1.289 sends `GET /v1/models?limit=1000` with `anthropic-version` and caches the answer in `<config dir>/cache/gateway-models.json`, keyed by the gateway address | Traced against a local logging proxy | `/v1/models` answers Anthropic's list shape to that header; the e2e test checks the cache |

## Rules

- Never copy leaked or proprietary source (for example the Claude Code source-map leak) or code derived from it.
- MIT / Apache-2.0 code keeps its notices; Apache-2.0 transplants also record what changed.
- Proprietary payloads (for example the Claude Code binaries) are never vendored.
| Per-model thinking levels; an agent offers the levels the model has that it can say; Codex catalog and Claude Code capability declaration per model | Magpie's per-model `Efforts`, `CLAUDE_CODE_MODEL_CAPABILITIES` handling and its `/v1/models` `supported_reasoning_levels`, read at @ `8b7c4ef` | MIT | Idea only; level sources, mapping and the capability string are our own (`core/src/model-efforts.ts`, `core/src/quirks.ts`, `core/src/launch.ts`, `core/src/catalog.ts`) |
| Claude's own models next to ours in Claude Code: the user's login kept, requests for Claude models forwarded unchanged to Anthropic, the model list merged | Anthropic's "LLM gateway" documentation (a gateway must forward `anthropic-beta`); opencodex's native passthrough design | Public documentation; opencodex MIT | `core/src/claude-native.ts` is our own code; only the headers the client sent are forwarded, to one fixed host |
| Agents' real thinking levels read from the installed program (`--help`, `codex debug models`) | Observed from the programs themselves | n/a | `core/src/efforts.ts` |
| Same agent, several models (sub-agent, small tasks) | Magpie's per-agent tiers (Claude Code `CLAUDE_CODE_SUBAGENT_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`; Codex `default_subagent_model`; OpenCode `small_model`) | MIT | Idea only; written per launch, never into the agent's config |
| `es` command | Own design | n/a | `bin/es.ts` |
| Agents calling agents over MCP | Own design; MCP specification | n/a | `core/src/mcp.ts` |


## 公开前待重写清单（私有期台账，不入库）

规则：私有期直接复用的代码在文件头声明来源，许可证原文放 `third_party/<项目>/LICENSE`；公开前下表逐项重写，然后用发布脚本生成干净快照、发布到新仓库（本仓库的历史不改写、不公开）。
重写 = 按功能和协议事实自己写（一人提取协议事实清单、另一人只看清单实现），不逐行改写；协议事实（端点、字段号、请求头、格式）可直接用。

| 项 | 来源 | 现状 | 公开前要做 | 状态 |
|---|---|---|---|---|
| `web/icons/` 中原 lobe-icons SVG | LobeHub lobe-icons（MIT，历史来源） | 当前80个服务/agent资产统一换成独立生成的字母头像；文件名与映射保留，历史许可记录不删 | 已替换当前图形，不代表其他公开前项完成 | 完成 |
| `web/icons/` 中原供应商图标集 | opencodex及其记录的其他来源（历史声明保留） | 当前全部服务图标为独立文本/圆角矩形字母头像，无原logo几何、字体包或外部资源 | 已替换当前图形，旧历史和第三方许可仍保持私有记录 | 完成 |
| `core/src/pricing/prices.json` | opencodex 模型元数据（MIT） | 旧1,233条数值暂保留，明确legacy未复核 | 新官方事实/生成器/并行表已独立实现，生产迁移尚未启用 | 部分：新表17价目/10标识，旧表仍待替换 |
| `core/src/presets.ts` 预设表 | opencodex 供应商注册表（MIT，历史出处保留） | 当前67条中61条按独立官方事实重建，6条明确legacy；国内新预设修正5个Messages拼接基础地址及DeepSeek规范Chat根地址，默认模型/分类/图标/顺序不变，已存来源不自动迁移；Together新预设采用现官方.ai主机，旧.xyz只保留图标识别 | 其余6条保留明确证据/退役/产品自定义边界；真实账号、能力与可用性未验收，历史许可证保留 | 部分：61重建 / 6保留legacy |
| `web/style.css` 设计变量 | （原先取自 Magpie） | 先于2026-10-06换成独立暖色板，2026-10-07再按已评审的本产品设计稿改为冷灰/蓝明暗色板 | 无需再处理 | 完成 |
| `core/src/quirks.ts` 怪癖表 | opencodex、Magpie 的知识 | 自己的结构重新表达 | 低风险；按各家官方行为文档复核 | 低 |
| Kiro 适配：`aws-eventstream.ts` 原有移植已整体替换；`kiro-schema.ts`、`kiro-login.ts`及高层来源构造历史记录仍保留 | opencodex（MIT，历史来源）；新帧模块依据公开Smithy/AWS/RFC1952事实独立实现 | 帧实现保留字符串调用API，验证CRC/类型/分片/取消/本地资源；没有读取旧实现后逐行改写，见 research/aws-eventstream-rewrite.md | 帧子项完成；登录库、厂商信封及专有协议仍须独立重写/核实；许可证继续保留 | 部分 |
| Cursor 适配（protobuf 定义、Run 端点） | opencodex（MIT）；protobuf 定义来自逆向的专有协议 | 未开始/进行中 | 手写 .proto 与编码；注意服务条款风险，独立于版权 | 待办 |
| Antigravity 适配：`antigravity-client.ts`（现为独立显式运行时配置/固定Google端点；历史版本曾含客户端身份）、`antigravity.ts`（登录流程、项目发现、信封照 opencodex）、`gemini-upstream.ts`（自写） | opencodex（MIT） | 登录模块的改编声明保留；当前源码已移除内置身份，独立读取器只读用户明确提供的私有文件；原生自动提取未实现 | 保持无内置凭据；登录/项目协议仍须按独立事实清单重写及核实许可；不得发布旧私有历史 | 待办 |
| `core/src/opencodex-import.ts` | 自写（读用户自己的 opencodex 配置） | 互操作功能，无拷贝 | 保留 | 无需 |
| git 历史与本仓库 | 含出处声明、台账、协议调研 | 本仓库永远私有，不改写历史 | 公开版用发布脚本生成清理过的快照，作为**新仓库**的首次提交；旧历史不进入公开仓库 | 待办 |

## 本仓库内的 WIP 复用（2026-10-06）

B21 的 `protocol.ts`、`inbound.ts`、`outbound-format.ts`、`outbound.ts`、`upstream-events.ts`、`downstream.ts`、`gateway-route.ts`、四入口精简以及 `source-adapters.test.ts` 按需取自本仓库 `gpt-wip` 提交 `8303a37`，再适配 `dev` 的 `eae6e21`。没有整支合并，也没有直接引入仓库外代码；既有厂商怪癖、图标等第三方出处仍按上表处理。

云端续接修改了原生错误/响应头透传、归一化能力查找、取消和模型池保护、签名块顺序、Gemini 可见文字及截断工具语义，并新增本地假上游回归。WIP 中的 Kiro 登录库/私有接口模块没有移入本次协议实现。本文只记录复用来源，不把未经真实客户端验证的行为写成实测。

### 独立官方价格输入与并行生成表（2026-10-07）

`core/src/pricing/official-facts.json`由官方公开定价文档独立整理，逐条链接和核查日期见该文件与`research/official-pricing-facts.md`。新`official-table.ts`、`official-estimate.ts`及`build-prices.mjs`按自定义事实合同编写，不读取第三方模型元数据补价；`official-prices.json`的SHA-256只绑定输入事实字节，不声称保存官网原始页面。当前事实覆盖10个精确模型ID的17种价目，只有2条普通文本条件可被纯估算器匹配。新表未切生产默认，旧表/旧运行时方法的历史归属与许可证继续保留，不能把这一批写成价格公开前重写全部完成。迁移影响和后续条件见`docs/pricing-migration.md`。


### B130 visual-system reference (2026-10-25)

| File | Source | Current use | Status |
|---|---|---|---|
| `web/style.css` | yetone/magpie `internal/gui/assets/app.css`, commit `4b3bdbe28c682ef178672883a4c9d6495dd4e7eb`, MIT, Copyright (c) 2026 yetone | Adapted neutral light/dark tokens, 212px navigation rail, compact list/control and usage KPI geometry. EasySwitch structure and branding retained. | Private candidate; public-release rewrite review required. |
