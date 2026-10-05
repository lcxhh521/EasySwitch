# CLAUDE.md

EasySwitch：把从各处找来的模型来源（中转站、官方 API、订阅）用进任何 agent，不顶替它原生的网关。macOS 优先，当前是 demo。

## 硬性原则（改动前先读，违反就是产品事故）

1. **旁路，不顶替。** 原生线路永远保持原样；外接模型只在明确开启的「增强会话」里生效。增强会话里的原生请求（如 Claude 官方模型）只做**原样转发**，用用户自己的登录。
2. **不改别人的配置文件。** `~/.codex`、`~/.claude`、`~/.dsh` 等一个字节都不动。一切通过每次启动的参数/环境变量/私有 HOME 实现，用完即删。
3. **随时退回原生。** 用户停掉 EasySwitch 后，所有 agent 必须照常工作。
4. **令牌不外泄。** Key 存 macOS 钥匙串（`core/src/secrets.ts`）；订阅 OAuth 令牌只发给它所属的厂商（见 `core/src/siwc.ts`）；日志和 state.json 里永远没有令牌。
5. **借鉴代码要移植魔改**，绝不原样当依赖；来源记进 `PROVENANCE.md`。

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
- `es` 命令（`bin/es.ts`）：终端里 `es claude`、`es codex` 直接以 EasySwitch 启动；`es shell-init` 出可选的 shell 函数。

## 进行中 / 计划

- **风险档适配**（用户已拍板，写到产品代码里；运行时只读用户本机自己的登录文件）：Cursor（connect+protobuf over HTTP/2，`agent.v1.AgentService/Run`，PKCE poll 登录）、Kiro（AWS CodeWhisperer eventstream，kiro-cli sqlite 导入）、Google Antigravity（Cloud Code Assist envelope，Google OAuth）。协议事实已从 opencodex（MIT）调研完毕，写在会话记录里；实现时**只借协议事实，代码全部重写**。
- Copilot CLI、Qoder、CodeBuddy 等的启动方式验证。
- 网关鉴权、原生 Keychain API（现在用 `security` 命令）。

## Git 约定

- 单分支直接推 `main`（私有仓库，个人项目）。提交信息用英文一行标题 + 要点正文，**不加任何署名行**（用户明确要求）。
- 提交前 `git status` 检查没有意外文件；不提交临时物。
