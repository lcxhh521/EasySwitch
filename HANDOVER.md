# 交接单：EasySwitch（2026-10-06，Claude → Dot）

> 你是接手的 agent，**在云端仓库的 `dev` 分支上开发**（用户 2026-10-06 明确要求：从 dev 分支开发）。这份文件只在私有仓库里，发布公开版时会被排除。
> 先读完这一页，再读 `AGENTS.md`（项目说明和代码地图）和 `BACKLOG.md`（唯一的需求清单）。

## 0.5 2026-10-06 晚的变更（分工以这一节为准，覆盖下面第 4 节里「B20 归 Claude」「B21 归你」的说法）

用户决定：**剩下的开发待办都交给 Dot**（BACKLOG B72）；**Claude 的新角色**（B73）是产品定义、代码检查（会评审你的提交，评审意见写在 `BACKLOG.md` 或提交评论里，请当成必须回应的反馈）、完善，以及你做不了的真机验证（用户 Mac 上跑真实 agent、核对启动器和订阅）。开发项由你做；Claude 若要改代码会先在登记表里登记、避开你正在改的文件。避让本地 GPT 的 `main` 工作区。

交接单写完之后，Claude 又做完并推到 `dev` 的（你不要重做，要核对的才碰）：
- **订阅当模型来源**（每个订阅是 `core/src/` 下自己的模块，共享文件里只有一两行挂钩，做 B21 时按挂钩迁移）：Kiro（`kiro*.ts`）、Antigravity（`antigravity*.ts`、`gemini-upstream.ts`）、Vertex（`vertex.ts`）、Cursor（`cursor/*`，纯文字）、Kimi 会员登录（`kimi.ts`）、Kimi/MiniMax 套餐额度（`plan-usage.ts`）。都只用假服务验证过，没有用真账号测。
- **网关鉴权**（`gateway-auth.ts`）、**每月预算**（`budget.ts`）、**Keychain 写入走标准输入**（`secrets.ts`）、**stdio 小桥**（`bin/es-mcp-stdio.ts`，给只认 stdio MCP 的 agent）、Copilot/Gemini 档位、Trae Agent 的 MCP、README 重写、界面配色。
- **调研**：`research/subscription-sources-2.md`、`-3.md`（十个订阅的可行性）、`research/cursor-adapter.md`（Cursor 的事实、做了什么、没做什么、哪些没核实）。
- 交接前历史检查点：279个测试，278 通过、0 失败（1 个是默认跳过的真钥匙串测试，设 `EASYSWITCH_TEST_KEYCHAIN=1` 才跑）。

留给你的（`BACKLOG.md` 里都有，按这个顺序做比较顺）：
1. **B21 协议层重构**（先读 AGENTS.md 硬性原则 5，再看 `upstream-chat.ts` 的 `sendChat`：现在是 kiro / antigravity / cursor / mimoFree / plan 几个分支，要改成按出站来源选适配器）。
2. **B38/B45 Claude 桌面端**（第 4 节有完整做法；云端能测的先测，再给用户一条本机确认命令）。
3. **B68 Grok、B69 Qoder、B70 WorkBuddy/Droid 订阅、B71 Cursor 工具调用**：事实在 `research/` 里；Grok 的线上格式（Responses 还是 Chat）两个参考仓库说法不一致，先核实公开资料与假服务；真实账号和请求须另外满足授权，不自行读取用户登录文件。
4. **B58/B33** 公开前清单（Antigravity 的客户端密钥改成运行时读取并移出仓库）、**B34** dev 合入 main。
5. **B48 余下、B49–B51 远期**。
6. **需要用户 Mac 的**（B2/B5/B57/B60，以及各订阅的真账号核对）：你做不了，在交付说明里写成「需要用户在本机验证」并给命令（`npm run verify-launchers`）。

## 0. 先搞清楚三件事

1. **仓库永远私有**，绝不改成公开，也不要把它的历史推到任何公开仓库。公开版是以后用 `tools/release/` 从干净快照另建一个新仓库（见第 7 节）。所以在这个仓库里写出处、参照谁、复制了谁的代码都没问题，只要按第 5 节声明。
2. **本轮只在用户指定的dot云端工作，不使用用户Mac或Codex账户额度。** 真实客户端、厂商或系统验收需符合另行授权范围；未验证不代表产品不可能，也不自动改到用户电脑。
3. **待办就是授权，做完一件直接接下一件，不要做一件问一件**（用户明确说过）；只有真正被卡住（要用户的真机、密钥、决定）才停下来问，一次问清，其余能做的接着做。
4. **你和 Claude 都在 `dev` 上开发，别撞车**：开工前 `git fetch && git log HEAD..origin/dev`，碰共享文件先在 `BACKLOG.md` 开头的「正在改」登记，小步提交、做完就推（推前 `git pull --rebase`）。详细规矩在那里。
5. **需求清单只有 `BACKLOG.md`。** 用户在对话里提的每个需求、变更、决定，立刻写进去（带用户原话和日期）再动手；做完标 `[x]` 并写“验证：”；收工时说清做完几条、还剩几条、新增几条。`npm run backlog -- --check` 查格式。

## 1. 产品是什么（用户拍板的定义）

EasySwitch：**把从各处找来的模型来源（中转站、官方 API、订阅、本地模型）用进任何 agent，不顶替它原生的网关。** macOS 优先；本地运行（密钥存钥匙串，网关只听 127.0.0.1）。

要做到的几件事，范围都是用户明确说过的：

- **任意来源 → 任意 agent**：agent 经本地网关出站；来源协议不同就在网关里翻译（Responses / Messages / Chat / Gemini 四种入站）。
- **旁路，不顶替**：原生线路保持原样，外接模型只在明确开启的“增强会话”里生效；停掉 EasySwitch 后所有 agent 必须照常工作。
- **agent 调 agent**：EasySwitch 提供 MCP，agent 启动时挂上就能把活派给别的 agent（深度限 2、并发限 3）。
- **按规则派活**：任务选“自动”时按用户写的规则（关键词、字数、文件夹、来源）选 agent、模型、档位。
- **订阅额度借给别的 harness**：ChatGPT（用 Codex 客户端身份设备码登录，用户已决定“以后都用 Codex 身份，不自己登记身份”）、Copilot；**Claude 订阅绝不借出**（用户的决定）。
- **每个 agent 有自己的**：主模型、想得多深（档位是模型的属性，agent 只提供“模型有的 ∩ 它说得出的”）、后台小任务模型、子 agent 模型。都放在 agent 自己那一行。
- **模型池 / 方案 / 用量与估算花费**。
- **桌面端和 IDE**：能接的接，不能接的给手动配置向导，真做不了的写明原因。
- **专有协议的来源也做**（Cursor、Kiro、Antigravity、MiMo 免 key 等）。

## 1.5 差异化（用户强调的长期方向）

用户原话：「虽然我们借鉴了 magpie，但是我们一定要走出差异化的。」借鉴是为了少走弯路，**不是做成另一个 Magpie**。判断标准：一个功能、一个界面、一个命名，如果只是在别人那里见过才这么做，就要问“我们的用户为什么需要它长这样”。

我们已经和它们不同、要继续放大的地方：

- **不改任何 agent 的配置**，一切靠每次启动的私有目录/环境变量；Magpie 和 opencodex 的路线是写配置文件。
- **原生与外接并排、原生线路原样转发**，随时退回原生，停掉我们不影响任何 agent。
- **agent 调 agent**（MCP）和**按规则派活**（任务页选“自动”）：从“切换模型”走到“调度 agent”，这是产品重心。
- **订阅额度借给别的 harness**（ChatGPT、Copilot；Claude 例外），以及专有协议来源。
- **逐 agent 的能力矩阵**：每个 agent 每个功能都有诚实的状态和理由，界面可见。
- 每个 agent 自己的档位 / 子 agent / 小任务模型；模型池故障切换；用量和估算花费。

**需要你警惕的地方**：现在的 4 页界面和菜单栏面板是照 Magpie / opencodex 的样子做的（B41 要评审）。新做的任何界面和交互，先想清楚我们的差异点再动手，不要顺手抄它们的布局、命名和流程。

## 1.6 便捷是设计原则（用户拍板）

典型用户有两类：同时养着好几个 agent 的重度开发者，和普通用户。用户的判断：**现在阻碍普通用户用多个 agent 的本质是不便捷，足够便捷他们就会用。** 所以新功能先问“普通用户一键能不能做到、要不要看懂术语”；界面写人话。远期想法（先不做）：并行派活 + 交叉审查（B49）、规则建议（B50）、拿得出手的第一个场景（B51）。要做的下一个产品功能：额度感知派活（B48）。

## 2. 不可违反的规则

用户明确定下的，违反就是事故：

1. **不改别人的配置文件。** `~/.codex`、`~/.claude`、`~/.dsh` 等一个字节都不动。一切通过每次启动的环境变量 / 命令行参数 / **私有目录**实现，用完即删。
2. **不拦截任何流量、不往官方界面里注入东西。** Claude 桌面端的“第一方模式”（本地证书拦截 claude.ai）明确不做（账号有被封风险）；见第 4 节关于 Claude 桌面端的正确做法。
3. **Claude 订阅不借给别的 harness。** Claude Code 里原生 Claude 模型和外接模型并排（保留用户自己的登录，原生请求只做原样转发）是允许的。
4. **令牌不外泄、不入库。** 钥匙串存 Key；订阅 OAuth 令牌只发给所属厂商；日志和 state.json 里不能有令牌；**任何密钥、令牌、OAuth client secret 都不能写进仓库**（Antigravity 桌面端的 secret 尤其要注意，运行时从用户本机读）。
5. **不要说“已验证”，除非真的在真实程序上跑过。** 能力矩阵（`core/src/capabilities.ts`）有五种状态：已实测 / 按文档做了未实测 / 手动配置 / 做不了（必填理由）/ 没做。测试会拦住虚报：`ready` 必须有实测过的启动器；`impossible` 必须写理由。**不要为了让测试过而改状态**。
6. **功能要做到每个 agent，不是一两个。** 用户专门为此批评过。每做一个功能，要给每个相关 agent 一个明确状态（见能力矩阵），不能只做手边能测的那个就算完。
7. 界面文字用人话句子；提交信息用英文，一行标题 + 要点正文，**不加任何 AI 署名行**；对用户用中文。

## 3. Claude交接前的历史基线（不代表当前新版验收）

- 279 个测试（278 通过、1 个默认跳过），`npm test` 全过；`npm run typecheck` 干净。Node ≥ 22.18 直接跑 TypeScript，运行时零依赖。
- **已实测**（用真实程序跑过）：ChatGPT/Codex（命令行和桌面端）、Claude Code、Hermes、DeepSeek Harness（dsh）。
- **按文档写了启动方式，没实测**：Gemini CLI、Qwen Code、OpenCode、Aider、Copilot CLI，以及 `core/src/launchers-extra.ts` 里新写的 Kimi、Pi、OMP、Droid、Cline、Goose、Crush、Grok、MiniMax Code、Qoder、OpenClaw、Trae Agent、AtomCode。每个启动器的 `caveat` 字段写明了哪部分是照厂商文件格式写的（可信）、哪部分是凭记忆猜的（要用 `--help` 核实）。
- 能力矩阵和界面：`/api/agents` 返回每个 agent 的各功能状态；Agent 页每行下有一排小点，底部有“覆盖情况”表。**历史覆盖计数（2026-10-06）**：启动 27/32 已定、后台任务 31/32、能调其他 agent 21/32、档位 25/32、子 agent/小模型 11/32、订阅当来源 4/18。“已定”= 已做或明确做不了；缺口就是 `todo`。
- 派活规则、任务页、`es` 命令（终端里 `es claude`）、模型池、方案、订阅登录（ChatGPT / Copilot）、MiMo 免 key、用量计费都在。

## 4. 待办与做法（编号对应 `BACKLOG.md`）

建议顺序：B2 → B3/B4 → B38 → B6 → B7 → B41（差异化评审）→ 其余。**先读 `research/` 里四份事实表**，里面有每个 agent 的私有目录变量、配置文件内容、MCP 写法、档位参数，凡标 `(inferred)` 的都是没核实的。

- **B2 补全 CLI 的启动和后台任务**：大部分已写在 `launchers-extra.ts`，**剩的是实测**。本轮仅做获准云端纯/假服务检查，真实程序验收未完成。`minimax-code` 没查到无界面参数，只有交互形态；**CodeBuddy（命令行）和 WorkBuddy（桌面应用）是两个产品，用户明确要求分开，不要再混成一个**：`codebuddy` 已按官方Messages配置补私有启动；`workbuddy` 归B6，按当前官方UI给出完整地址、临时令牌和模型，不写原生文件；`amp` 只能检测并打开。
- **B3 MCP挂载历史清单（dsh、Trae桥、Kimi/OMP/AtomCode/CodeBuddy本轮已补，见当前验收与专题文档）**：已挂的：Codex、Claude Code、Hermes、OpenCode、Gemini/Qwen、Copilot、Droid、Cline、Goose、Crush、Grok、Qoder、OpenClaw（后面几个的 MCP 写法大多是推测，见各自 `mcpCaveat`）。还缺：**dsh**（做得了，见 `research/agent-facts-4.md` 的更正段：在 patch 里加 `dsh-mcp-client` 插件，但要先给私有 `DSH_HOME` 预置那个插件的符号链接）、**Trae Agent**（只认 stdio，要一个 HTTP 转 stdio 的小桥）、Kimi、OMP、AtomCode（没查到）。
- **B4 档位与子 agent/小模型模型**：dsh 的补法在 `research/agent-facts-4.md`（注意 patch 是整条替换，要带回原键）；Gemini 的档位只能写 `thinkingConfig`，把握不大；Copilot 的 `effortLevel`；其余见事实表。
- **B38 / B45 Claude 桌面端**：官方第三方网关模式与拦截流量是两件事，后者仍明确不做。旧交接单“没有官方 Linux 版”已过时：[官方安装页](https://support.claude.com/en/articles/10065433-install-claude-desktop) 已列 Linux beta。当前按用户要求只在 dot 云端工作，不把用户 Mac 作为替代执行目标；macOS 兼容性保持未实测。

  已实现隔离后端、模拟生命周期、模型限制及明确的阻塞界面。官方 Linux 2.19675.1 amd64 包已核验签名链和 SHA-256 并私有解包，但签名版 bootstrap 会忽略 CLAUDE_USER_DATA_DIR；旧环境变量方案不能证明隔离。云端独立网络命名空间预检被拒绝，未绕过，也未启动真实应用/helper。生产 API 和默认 start 在 spawn 前拒绝，experimental:true 不能解锁。详见 docs/claude-desktop-isolation.md。

  后续验收应关注持久用户数据、配置、缓存与日志的实际路径，不能要求系统库和应用文件也全部位于临时目录。必须使用获准环境；用户已指定仅云端，不把用户 Mac 作为默认后备。未获得明确授权不运行真实账号、模型或修改安全设置。

- **B6 桌面端 / IDE 的手动配置向导**：Trae、Z Code、WorkBuddy（Windsurf/豆包未核实受支持自定义端点，不编造接入）。统一做法：界面里给出地址、令牌、模型一键复制和该应用的操作步骤，**不碰它的配置文件**。
- **B7 其余 agent 的订阅当来源**：逐个调研，能接就接，不能接写明原因。
- **B10/B11/B12/B13/B30/B31/B32** 已整合：Vertex三模式、官方MiMo预设、模型档位、全局/来源预算、限时可撤销鉴权、原生Keychain桥和README。MiMo Free及未经验证桌面路径明确阻塞，详见专题文档与当前验收。
- **B33 公开前清单**：见第 7 节。
- **B20/B21当前分工**：剩余开发已按B72/B73交给dot，保留Claude已推的登录/来源模块，不另写重复实现。B21经`subscription-compat.ts`兼容其Chat结构，普通API走中立四协议层。`gpt-wip`的8303a37只作按需参考，未整支合并；真实账号、条款和厂商接口验收仍独立保留。

## 5. 借鉴别人代码的规矩

可以直接复制别人的代码再迭代，**但必须在文件头声明**：来源项目、许可证、来源提交、版权行；许可证原文放 `third_party/<项目>/LICENSE`；并在 `PROVENANCE.md` 末尾的“公开前待重写清单”加一行。来源（opencodex、Magpie、CC Switch、lobe-icons）都核实过是 MIT，只要求带版权声明；协议事实（端点、字段、格式）不受版权保护。公开前这些要逐项重写（见第 7 节），所以**声明不能漏**，漏了公开前就搜不出来。你看不到用户本机的 opencodex / Magpie 源码；需要参照时让用户贴相关文件，或者按 `research/` 里已经整理好的事实实现。

## 6. 工作方式

- **分支**：开发在 `dev`；`main` 是本地 GPT 在用户 Mac 上的工作区（它的进展见 B44）。合 `dev` → `main` 要等 GPT 到停点或进展已推到云端，`main` 里有它未提交的改动和未跟踪的 `AGENTS.md`/`CLAUDE.md`/`PROVENANCE.md`，会撞名。
- **提交前**：`npm run typecheck && npm test`；测试需要 `--test-force-exit`（已写在 `npm test` 里）；macOS 没有 `timeout`，限时用 `perl -e 'alarm N; exec @ARGV' -- cmd`。有些测试会起真实的 Hermes / dsh / Claude Code，云端没有这些程序时会自动跳过。
- **改启动器就改测试**：`core/test/capabilities.test.ts` 会检查每个私有目录启动器：路径都在会话目录内、不碰用户主目录、JSON 合法、没有 MCP 时不写 MCP 条目。新增一个会挂 MCP 的启动器，要把它的 id 加进那个测试里的期望清单（这是故意的，防止悄悄多报）。
- **档位语义**：agent 没有自己的档位参数时，不要在启动器里写死 `efforts`（会把“模型有 ultra 就能设 ultra”限死，`plan-provider.test.ts` 专门测这个）；agent 有自己的档位（有 flag）才在 `efforts` 里写它自己的词。
- **踩过的坑**：项目的 `.claude/settings.json` 里有两个 Claude Code 钩子（待办提醒和收工核对），**只对人和 agent 在这个仓库里用 Claude Code 干活生效**；曾经因为它们把测试里运行的真实 Claude Code 拦住（无界面时 stdout 为空）。现在钩子会跳过 EasySwitch 自己启动的会话，有测试。你（Dot）不用 Claude Code，可忽略，但待办纪律照样要守；Node 的类型剥离只支持可擦除语法（没有 enum、参数属性、namespace）；zsh 不做单词拆分；网关 Host 守卫只认 `127.0.0.1:PORT`，测试里 `createEasySwitchServer` 要传真实空闲端口（或 port 0）；控制台 API 要求 `x-easyswitch: 1` 头；YAML 里 Hermes 的 `delegation`/`mcp_servers` 必须在顶层，不能落在 `auxiliary:` 下（有测试）；Qoder 自定义模型只对登录且含自带模型套餐的账号开放，空私有目录可能要先登录。
- **本机的运行方式**（给用户看界面时）：`EASYSWITCH_PORT=18766 EASYSWITCH_HOME=<临时目录> EASYSWITCH_SECRETS=memory node core/src/main.ts`，然后打开 `http://127.0.0.1:18766/`。

## 7. 公开发布（以后的事，现在别动手）

仓库保持私有；公开时：台账逐项按功能和协议事实重写（一人提取事实清单、另一人照清单实现，不逐行改写）、换掉第三方图标，然后跑 `tools/release/make-public-snapshot.sh dev <空目录>`（导出无历史快照、剥离私有段和私有文件、跑检查），**检查到 0 发现**才可以作为**新仓库的首次提交**发布。2026-10-06 基线 63 条发现。**不要执行任何改写历史的操作，不要把这个仓库推到公开仓库。**

## 8. 请你在第一次交付时回报

1. 做完了 BACKLOG 的哪几条（编号）、还剩哪几条、新增了哪几条。
2. 哪些结论是“云端写的、需要用户在本机验证”，每条给出可直接复制的验证命令。
3. 任何你没把握的地方，直接写“不确定”，不要写成已验证。

## Dot 当前整合状态（2026-10-06）

已获用户确认：保留 Claude 的 B20，不重复其适配器开发。Dot 的 B21、鉴权、预算、启动器补缺与文档在云端 dev 实现；原 103a2ab 组合受保护测试 314/314，通过类型检查，无真实 agent/模型调用。当前固定 0a9f8e2 再整合 Vertex 不同鉴权/协议模式、dsh、B55/B57 及待办归档；这些新组合须重新验证。B30 与 Claude 的最新登记重叠已向用户请求协调，尚不能把待确认分工写成已确认。

不得把旧“无 Linux Claude”或 CLAUDE_USER_DATA_DIR 覆盖当可用方案：已核验官方签名 2.19675.1 包会忽略该变量；真实启动阻塞，详见 docs/claude-desktop-isolation.md。本轮只使用 npm run test:local 的审计白名单、临时 HOME、内存凭据和 loopback 假服务；不直接运行 npm test 或 verify-launchers 的真实客户端路径。README 与各专题文档记录实际支持和未验收边界。

### 固定 0a9f8e2 的最终云端组合检查

2026-10-06：335/335 通过（318 项纯函数/本地假服务/UI，17 项内容哈希限定的桌面假程序），零失败；类型检查、前端/脚本语法、待办格式与暂存/未暂存差异检查通过。Vertex 保留服务账号 JWT→Chat、手动短期令牌→Gemini、Express Key→Gemini 三种明确模式；B55 面板、B57 只读工具/注入测试、待办归档、dsh/B60 菜单与 Claude 的 B20 均已保留。没有运行真实 agent、使用真实模型账户或推送远端。

当前结果固定于该远端基线；后续远端推进不自动包含在测试结论中。生产 Claude Desktop 仍拒绝启动；原生 ChatGPT WebSocket 因无法证明持续会话/预算约束而拒绝。Keychain Swift 只经过源码与桥模拟检查，macOS 编译和系统行为未验收。普通交互窗口的关闭不保证即时撤销令牌，可显式撤销/到期失效。停止预算开启时拒绝未完整记账的探测；不是厂商账单硬上限。B20真实授权与条款验收归其负责人，不能把保留代码等同于已批准运行。

### a2741c9 去重整合

固定该远端版本保留 Claude 的已推实现和产品设计；两套鉴权/预算不能整文件选边。鉴权以实际签发、过期、撤销、权限范围及安全转发为边界；全局 UTC 日/月预算与来源月预算分开显示和验证，不能表单混用。钥匙串兼容远端 b64 编码，但原生 helper 的 macOS 编译行为仍未验收。335 是前一快照测试数，新组合必须复跑。用户已明确授权有验证进展就小步提交推送私有 dev；先检查远端，不强推、不覆盖并行成果。

### 最新所有权与推送（2026-10-06）

用户已确认剩余当前开发待办全部归 Dot（B72/B73），Claude 转为产品定义、审查和独立验收；旧 B20 分工仅属历史。远端 2045808 的 Cursor/Kimi/余量实现保留，不重复创建。首个独立安全提交 d13a72c 已推送 dev，精确树类型检查与10项假测试通过、1真实Keychain跳过。主整合bfefccc已推送并重新验收，不将先前335数字套到新树。新的剩余研究条目不授权读取真实登录、创建凭据或付费调用。

### 当前已推送代码验收：bfefccc（2026-10-06）

安全白名单386项通过（369项纯函数/本地假服务/UI +17项桌面假程序），1项真实Keychain明确跳过，零失败；类型、前端语法、待办和差异检查通过。包括完整页面、off/none交集、双预算表单隔离、别名鉴权，以及最后保留的Cursor/Kimi/余量回归。

已正常推送d13a72c（独立Keychain/b64兼容）和bfefccc（协议/鉴权/预算/控制台整合）。仓库核实为private，未强推或改写远端历史。没有真实agent、账户或付费模型调用。真实客户端/平台限制仍保留，不能把本轮通过等同于所有剩余待办已完成。当前源码冻结，后续按新登记小步推进。

### Qoder / Droid 文字来源切片（2026-10-06）

Qoder已接专用创建/默认关闭/显式开关和四协议纯文字入口；必须由用户明确提供可信CLI绝对路径、可用模型ID与PAT，创建/开启不执行程序。工具、媒体和不透明历史在Key读取前拒绝，普通HTTP出口不能接管该来源。仅fake验证，真实CLI及账户/条款验收未完成；Droid只有假会话控制器，生产创建/调用保持501。

完整审计白名单405项通过（388项纯/本地假服务/UI +17项桌面假程序），1真实Keychain跳过，零失败；类型、语法、待办与差异检查通过。B69/B70保持部分完成，未将其余CodeBuddy/WorkBuddy或Cursor工具适配视为完成。详细合同、官方依据与限制见 docs/cli-text-bridges.md。

### CodeBuddy 文字来源切片（2026-10-06）

CodeBuddy官方CLI来源独立于原有反向启动器：专用表单要求显式国际/国内区域、可信程序路径、模型与API Key，默认关闭，开启不发请求；纯文字四入口使用私有配置与最小环境，不继承本地gateway地址/登录或自动加载工具、MCP、hooks。Qoder复用受限runner但保留原接口和行为；Droid仍生产501。

完整审计白名单416项通过（399项纯/本地假服务/UI +17项桌面假程序），1真实Keychain跳过、零失败；类型、语法、待办与差异检查通过。没有运行真实CodeBuddy/Qoder/Droid或使用账户。B70保持部分完成，WorkBuddy、Droid生产传输和真实平台验收不能据此标为完成；详见 docs/cli-text-bridges.md。

## 9. Claude 的真机验收清单（Dot 不执行；由 Claude 在用户 Mac 上做，Dot 不要删）

用户 2026-10-06 定的分工（B73）：Dot 做开发，Claude 做产品定义、审查、完善和需要用户 Mac 的验收。下面是原来写在 B38 里的 Mac 验收做法，Dot 改写 B38 时被删掉了，这里恢复；Claude 开工前先看 `docs/claude-desktop-isolation.md` 里 Dot 查到的事实（签名版会忽略 `CLAUDE_USER_DATA_DIR`，所以第 1 步要先验证 `--user-data-dir` 开关和文件系统审计，不能默认旧变量有效）。

- **B38 Claude 桌面端**：**之前的“做不了”是我错了**，把两件事混为一谈。官方有“第三方推理（网关）”配置：配置库在 `<userData>/configLibrary/`（默认 `Application Support/Claude-3p`），里面一个 profile JSON `{inferenceProvider:"gateway", inferenceCredentialKind:"static", inferenceGatewayBaseUrl, inferenceGatewayApiKey, modelDiscoveryEnabled, inferenceModels:[...]}` 加 `_meta.json {appliedId, entries:[{id,name}]}`；并且环境变量 **`CLAUDE_USER_DATA_DIR`** 可以让这个应用用任意目录当数据目录。所以做法是：**另开一个独立的 Claude 窗口**，数据目录指向一个私有临时目录、里面写好网关 profile，指向 EasySwitch——不碰用户平时的 Claude，不拦截流量，用完删目录。代价：这个窗口是纯第三方模式，没有 claude.ai 账号功能，只有外接模型；原生 Claude 在平时的窗口里用，两个实例可以同时开。细节和字段含义看 `research/agent-facts-4.md` 末段；opencodex 是怎么写的在它的 `src/claude/desktop-3p*.ts`（用户本机 `~/workspace/opencodex`，你看不到，需要时让用户贴）。**这一项的测试用户 2026-10-06 明确交给你（Dot）做（B45）。** 要在用户的 Mac 上跑（本机装了 `/Applications/Claude.app`，版本 2.19675.0；opencodex 移植的是 1.18286.0 的代码，**行为可能已经变了，别照抄，要实测**）。**用户 2026-10-06 的建议：你在自己的云电脑上下载安装 Claude 桌面端来测**，EasySwitch 也装在那台云电脑上（`npm test` 同款环境，网关不用跨机器）。前提是它的系统要能装：**Claude 桌面端只有 macOS 和 Windows 版，没有官方 Linux 版**；Linux 云电脑装不了就测不了这一项，请直接告诉用户，改成“写好一条能直接跑的脚本加核对步骤，让用户在 Mac 上运行并把输出贴回来”。云电脑上测通以后，**仍要让用户在他的 Mac 上跑一次很短的确认**（macOS 的数据目录是 `~/Library/Application Support/...`，Windows 在 `%LOCALAPPDATA%\Claude-3p`，路径只能在 Mac 上最终验证）。不要把没跑过的东西写成“已验证”。我（Claude）没有启动过它，没改过任何 Claude 数据，只做了准备，下面是我摸到的（第 1、2 条是为用户的 Mac 写的；在你自己的云电脑上，实例是你自己的，不涉及用户的真实数据，但“私有数据目录确实生效”这一点照样要证明）：

1. **用户平时用的 Claude 桌面端经常正开着**，那是他的真实数据（`~/Library/Application Support/Claude`），绝对不能碰。测试只能开**第二个独立实例**：`open -n -a Claude --env CLAUDE_USER_DATA_DIR=<私有临时目录>`（`open` 支持 `-n` 新实例和 `--env`，已确认）。
2. **证明没碰真实数据**：新实例启动后用 `lsof -p <新进程pid>` 看它打开的文件全在私有目录里；`~/Library/Application Support/Claude-3p` 如果测试前不存在，测试后也不能出现。（真实目录自己会被正在运行的那个实例不断改动，所以不能用“目录没变”来证明。）
3. **私有目录里写配置库**：`<目录>/configLibrary/_meta.json` 和一个 profile JSON（字段见上）；`inferenceGatewayBaseUrl` 指向 EasySwitch 网关，`inferenceGatewayApiKey` 用一个 `es-session-claude-desktop-…` 令牌（网关靠令牌前缀认出是哪个 agent）。模型列表先用 `modelDiscoveryEnabled: true` 让它读我们网关的 `/v1/models`（Claude Code 已经在用的 `es-claude-<来源>--<模型>` 编码），看它认不认；不认再退回静态 `inferenceModels`（opencodex 的做法是把模型映射成 `claude-opus-4-8-…` 这种 Claude 形状的别名，网关再解码，见它的 `desktop-profile.ts`）。
4. **本地假环境**：`node core/test/mock-relay.ts`（端口 18790，假中转站）+ 起一个 dev 实例（`EASYSWITCH_PORT=18766 EASYSWITCH_HOME=<临时目录> EASYSWITCH_SECRETS=memory node core/src/main.ts`），再 `POST /api/providers`（头要带 `x-easyswitch: 1`，体 `{"name":"Mock Relay","baseUrl":"http://127.0.0.1:18790/v1","apiKey":"mock"}`）。
5. **看窗口**：我确认过 `screencapture -x <文件>.png` 在这台 Mac 上能用；如果它的 Electron 支持，也可以带 `--remote-debugging-port` 启动后用 CDP 看界面（ChatGPT 桌面端支持，Claude 没试过）。
6. 要回答的问题：私有数据目录真的生效吗？应用有没有自己进入第三方模式（还是需要在界面里手动选）？模型菜单里出现的是什么？发一条消息，请求是否到了网关、模型对不对？用完删私有目录后，用户的 Claude 是否毫发无损？

### 966a5de 安全复查后的边界（2026-10-06）

保留B86的兼容性与Mac路径修复及原作者测试说明，但外部模型不能沿原生登录旁路消费本地保存的Key。ChatGPT原生HTTP仅将调用方凭据送固定官方目标，且不读取本地secret；外部模型与合并本地目录另需已签发capability。WS持续预算/会话处理尚未验证，生产409；未经验证的增强启动也409。18项纯/loopback安全测试通过；真实Mac、Codex、ChatGPT与Keychain路径没有由Dot执行。第9节旧变量和“无Linux版”文字不改变已核验的Linux隔离证据。
