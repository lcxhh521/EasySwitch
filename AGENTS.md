# AGENTS.md

给在这个仓库里干活的 agent 看的项目说明（Codex、Claude Code 等都会自动读它）。

EasySwitch：把从各处找来的模型来源（中转站、官方 API、订阅）用进任何 agent，不顶替它原生的网关。macOS 优先，当前是 demo。

## 硬性原则（改动前先读，违反就是产品事故）

1. **旁路，不顶替。** 原生线路永远保持原样；外接模型只在明确开启的「增强会话」里生效。增强会话里的原生请求（如 Claude 官方模型）只做**原样转发**，用用户自己的登录。
2. **不改别人的配置文件。** `~/.codex`、`~/.claude`、`~/.dsh` 等一个字节都不动。一切通过每次启动的参数/环境变量/私有 HOME 实现，用完即删。
3. **随时退回原生。** 用户停掉 EasySwitch 后，所有 agent 必须照常工作。
4. **令牌不外泄。** Key 存 macOS 钥匙串（`core/src/secrets.ts`）；订阅 OAuth 令牌只发给它所属的厂商（见 `core/src/siwc.ts`）；日志和 state.json 里永远没有令牌。
5. **按出站来源选择适配器**（用户已确认）：agent 决定入站协议，来源及模型能力决定出站协议。同协议优先直通，跨协议才转换；Chat 只是一个协议，不能作为统一中间格式。适配器接收原始入站请求，拥有厂商鉴权、协议和流解析。

## 技术约定

- **Node ≥ 22.18 直接跑 TypeScript**（type-stripping）：只能用可擦除语法——没有参数属性、没有 enum、没有 namespace。运行时零依赖，devDependencies 只有 TypeScript。
- **测试**：`npm test`（即 `node --test --test-force-exit core/test/*.test.ts`）。`--test-force-exit` 必须带（真实 agent 的句柄会挂住 runner）。macOS 没有 `timeout` 命令，需要限时用 `perl -e 'alarm N; exec @ARGV' -- cmd`。
- **类型检查**：`npm run typecheck`。
- 本地假中转站：`node core/test/mock-relay.ts`（端口 18790），只认 Chat 协议、严格校验。
- zsh 不做单词拆分：给 curl 传头不要存进变量再展开。
- 网关的 Host 守卫只接受 `127.0.0.1:PORT`/`localhost:PORT`（防 DNS rebinding）；控制台 API 要求 `x-easyswitch: 1` 头。
- 测试里 `createEasySwitchServer` 要传真实空闲端口；用 `port: 0` 时 Host 守卫会在 listen 后补上实际端口。

## 代码地图（core/src/）

| 文件 | 职责 |
|---|---|
| `server.ts` | 唯一的服务端：控制台 API + 网关路由 + 任务/池/方案/订阅接口。大文件，改动先 grep |
| `gateway.ts` | `/v1/responses`（Codex）；`resolveModel`、模型列表、`applyThinking` |
| `gateway-chat.ts` | `/v1/chat/completions`（通用 agent）；`agentOf`/`agentFromAuth` 从会话令牌识别调用方 |
| `gateway-messages.ts` | `/v1/messages`（Claude Code）；原生 Claude 请求经 `claude-native.ts` 原样转发 |
| `gateway-gemini.ts` + `gemini.ts` | Gemini 协议入口（Gemini CLI 等） |
| `translate.ts` | Responses ↔ Chat 翻译；Codex 的 namespace 工具压平/还原 |
| `anthropic.ts` | Messages ↔ Chat 翻译 |
| `quirks.ts` | 各厂商的怪癖与 `reasoning_effort`/`thinking` 开关的映射；`shapeChat` |
| `model-efforts.ts` | 档位是**模型的属性**；agent 只提供「模型有的 ∩ 它说得出的」 |
| `efforts.ts` | 从安装的程序读真实档位（`--help`、`codex debug models`） |
| `pools.ts` | 模型池：`pool/<id>` 多来源故障切换/轮流；`runWithPool` 包住四个协议入口 |
| `siwc.ts` | 订阅登录：ChatGPT（Codex 客户端设备码，默认）+ Copilot（GitHub 设备码）+ 官方开放通道 |
| `upstream-chat.ts` | `sendChat`：Chat 请求出站的唯一出口（plan/mimoFree/普通三分支） |
| `responses-upstream.ts` | Chat → Responses 请求与返回流的翻译（订阅通道用） |
| `mimo-free.ts` | 小米 MiMo Free 免 key 适配（bootstrap JWT + 系统标记） |
| `agent-launch.ts` | 各 agent 的启动方式（interactive/headless）、`runHeadless`、任务执行 |
| `launch.ts` | Codex/Claude Code 的参数与环境（含 MCP 附着、`claudeEnv` keepLogin） |
| `mcp.ts` | EasySwitch 自己的 MCP 服务（list_agents/run_agent/list_models），agent 互调 |
| `tasks.ts` | 任务簿：控制台和 agent 互调的任务都记在 `tasks.jsonl` |
| `dispatch.ts` | 派活规则：任务交给 `auto` 时按用户写的规则（关键词/正则/字数/文件夹/来源）选 agent、模型、档位；纯函数，规则存在 `store.ts` |
| `catalog.ts` | `es-claude-` 模型 id 编码、Codex 模型目录生成 |
| `keypool.ts` | Key 池轮换（401/403 歇 10 分钟，429 歇 1 分钟） |
| `accounts.ts` | 订阅账号隔离目录（CODEX_HOME/CLAUDE_CONFIG_DIR） |
| `chatgpt-gateway.ts` / `chatgpt.ts` | ChatGPT 桌面端接管（`/backend-api/codex/*` 原样转发 + 启动器） |
| `presets.ts` | 预设来源表（一键添加） |
| `pricing/` + `ledger.ts` | 用量与估算计费 |

前端 `web/`：无框架原生 JS（`app.js` 单文件，渲染函数按页面切）。菜单栏 `menubar/`：Swift。

## 产品现状（2026-10-06）

- 已接入：Codex/ChatGPT（命令行+桌面端）、Claude Code、Hermes（实测）、dsh（实测）、Gemini CLI、OpenCode、Aider、Copilot CLI（后四个按官方文档，未实测）。
- Claude Code 增强会话保留用户自己的 Claude 登录：`/model` 里原生模型和外接模型并排。
- 每个 agent 独立设置：主模型、想得多深（档位）、后台小任务/子 agent 模型（`prefs`，不依赖主模型绑定）。
- 模型池：同一模型多来源合成一个名字，挂了自动切（`order`/`rotate`）。
- 方案：一键保存/恢复所有 agent 的设置。
- 任务页：给 agent 派后台任务；agent 之间经 MCP 互相派活（深度限 2、并发限 3）。
- 派活规则：任务页选「自动」（或 `run_agent` 传 `auto`）时，按规则决定交给谁、用哪个模型、想多深；任务记录里写明哪条规则决定的。
- `es` 命令（`bin/es.ts`）：终端里 `es claude`、`es codex` 直接以 EasySwitch 启动；`es shell-init` 出可选的 shell 函数。

## 进行中 / 计划

- **其他厂商订阅的适配**（Cursor、Kiro、Google Antigravity）：进行中。运行时只读用户本机自己的登录文件，不改别的应用的任何配置；协议细节写在各适配器文件头。
- Copilot CLI、Qoder、CodeBuddy 等的启动方式验证。
- 网关鉴权、原生 Keychain API（现在用 `security` 命令）。

## Git 约定

- 提交信息用英文：一行标题 + 要点正文。提交前跑 `npm run typecheck` 和 `npm test`，用 `git status` 检查没有意外文件，不提交临时物。
- 开发在 `dev` 分支进行，合入 `main` 前保证测试全过。

## 第三方代码与密钥

- 如果复制或改编了别的项目的代码：保留它的许可证——在文件头注释里写明来源项目、许可证、来源提交和版权行，许可证原文放 `third_party/<项目>/LICENSE`；并在最后的说明里列出这些文件，方便维护者核对。
- 不要把任何密钥、令牌、OAuth client secret 写进仓库。
