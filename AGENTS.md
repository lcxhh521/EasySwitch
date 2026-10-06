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
| `kiro.ts` + `kiro-login.ts` / `kiro-schema.ts` / `aws-eventstream.ts` | Kiro 订阅：每次请求只读 Kiro CLI 的本机登录库，Chat → Kiro 对话状态，AWS 事件流 → Chat 分片；新来源默认关 |
| `antigravity.ts` + `antigravity-client.ts` + `gemini-upstream.ts` | Antigravity 订阅：浏览器里 Google 登录（刷新令牌存钥匙串）、Cloud Code Assist 信封、Chat ↔ Gemini 互转；客户端密钥暂时写在 `antigravity-client.ts`（见私有段） |
| `cursor/*.ts` | Cursor 订阅（纯文字）：`proto.ts` 手写 protobuf、`connect.ts` 帧、`messages.ts` 一轮对话的消息和字段号、`transport.ts` HTTP/2 流（心跳、服务端追问）、`auth.ts` 浏览器登录轮询和续期、`models.ts`、`adapter.ts` Chat ↔ Cursor；新来源默认关 |
| `quota.ts` | 订阅额度：读响应头和「用完了」的 429，池子据此跳过用完的订阅，控制台显示还剩多少 |
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

## 待办（必须遵守）

- 需求清单只有一份：`BACKLOG.md`。用户在对话里提的每个需求、变更、决定，**立刻**写进去（一条一行，带用户原话和日期），再动手。
- 收工前对照清单：做完的标 `[x]` 并写“验证：”（提交号/测试/实测）；最后的回复里说清做完几条、还剩几条、新增几条。做完的条目隔一阵用 `npm run backlog -- --archive` 移到 `BACKLOG-DONE.md`（证据和原话都留着，编号不再用），主清单只留没做完的。
- `npm run backlog` 看未完成项，`npm run backlog -- --check` 查格式。Claude Code 有钩子自动提醒和拦截（`.claude/settings.json`）。

## Git 约定

- 提交信息用英文：一行标题 + 要点正文。提交前跑 `npm run typecheck` 和 `npm test`，用 `git status` 检查没有意外文件，不提交临时物。
- 开发在 `dev` 分支进行，合入 `main` 前保证测试全过。

## 第三方代码与密钥

- 如果复制或改编了别的项目的代码：保留它的许可证——在文件头注释里写明来源项目、许可证、来源提交和版权行，许可证原文放 `third_party/<项目>/LICENSE`；并在最后的说明里列出这些文件，方便维护者核对。
- 不要把任何密钥、令牌、OAuth client secret 写进仓库。

<!-- private:start -->
## 出处、分工与发布（私有仓库内；发布公开版时由发布脚本整段剥离）

**这个仓库永远是私有的，绝不改成公开。** 公开时用 `~/workspace/easyswitch-private/` 里的发布脚本：从最终文件树生成一份清理过的快照，作为**新仓库的首次提交**发布；这个仓库的历史不会进入公开仓库。仓库有本地 `pre-push` 钩子，推送前会向 GitHub 查可见性，是公开仓库就拦。

### 借鉴代码

- **走出差异化（用户强调）**：借鉴是为了少走弯路，不是做成另一个 Magpie 或 opencodex。新功能、新界面、新命名先想“我们的用户为什么需要它长这样”；我们的差异点（不改配置的私有启动、原生并排、agent 调度、订阅借用、逐 agent 能力矩阵）见 `HANDOVER.md` 第 1.5 节，评审任务见 `BACKLOG.md` B41。

- 可以直接复制别人的代码再适配迭代（用户已确认），也可以在文档、注释、提交信息里写明参照了谁，不用避讳。
- **复制或改编必须在文件头声明**：来源项目、许可证、来源提交、版权行；许可证原文放 `third_party/<项目>/LICENSE`。这样公开前用搜索就能把它们全部找出来。
- 每复制或改编一个文件，就在 `PROVENANCE.md` 末尾的「公开前待重写清单」加一行（文件、来源、现状、状态）。
- **公开之前**：台账里逐项按功能和协议事实重写（不逐行改写；一人提取协议事实清单、另一人照清单实现）、换掉第三方图标，然后跑发布脚本的检查，全部通过才发布。
- 来源（opencodex、Magpie、CC Switch、lobe-icons 等）核实过都是 MIT：只要求带版权声明；协议事实（端点、字段、格式）不受版权保护。

### 其他厂商订阅的适配（B20：Dot 说不做，用户 2026-10-06 定为 Claude 自己做；起点是云端 `gpt-wip` 分支里 GPT 的快照）

- Cursor 是 connect+protobuf over HTTP/2（`agent.v1.AgentService/Run`，PKCE poll 登录）；Kiro 是 AWS CodeWhisperer eventstream（kiro-cli sqlite 导入）；Antigravity 是 Cloud Code Assist envelope（Google OAuth）。协议事实已从 opencodex 调研完毕，可以直接移植它的代码再按 EasySwitch 的接口适配（保留许可证、文件头声明、台账记一行）。
- **唯一例外（用户 2026-10-06 明确决定，BACKLOG B56）**：Antigravity 桌面端的公开 OAuth 客户端 ID 和密钥，照 opencodex 的做法暂时写在 `core/src/antigravity-client.ts` 一个文件里，为了先跑通；后续改成运行时读取。公开前必须移除，发布检查的密钥扫描会一直报它，**不要加进放行清单**。除此之外，任何密钥、令牌都不得写进仓库。

### 分工与分支

- `main`（`~/workspace/EasySwitch`）：本地 GPT 的工作区，风险档适配和协议层重构的进展在这里（未提交，待推到云端分支，见 B44）；协议层重构（B21）由 Dot 做，订阅适配（B20）由 Claude 做。
- `dev`（`~/workspace/EasySwitch-dev`，独立 worktree）：Claude 的工作区。避开 GPT 正在改的文件（`gateway*.ts`、`types.ts`、`upstream.ts`、`model-efforts.ts` 和新的协议层）。合入前保证测试全过。
- 提交信息不加署名行（沿用用户的 PR 工作规则）。
<!-- private:end -->
