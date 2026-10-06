# EasySwitch 待办与开发计划

唯一的需求清单，所有在这个项目上干活的 agent（Claude、Dot、本地 GPT）共用。规则：

1. **用户在对话里提的每个需求、变更、决定，立刻写进这里**（一条一行，带用户原话和日期），再动手。
2. **收工前对照这份清单**：做完的标 `[x]` 并写“验证：”（提交号 / 测试名 / 实测结果）；没做完的保持原样；最后的回复里说清“做完几条、还剩几条、哪些是新增的”。
3. 做完的条目用 `npm run backlog -- --archive` 移到 BACKLOG-DONE.md 归档，主清单只留没做完的；归档里的编号不再用。
4. 标记：`[ ]` 待办　`[~]` 进行中　`[x]` 完成　`[-]` 不做/暂缓（写“原因：”）。
5. 检查：`npm run backlog`（看未完成）、`npm run backlog -- --check`（查格式和证据）。Claude Code 里有两个钩子自动提醒/拦截（见 `.claude/settings.json`）。
6. 编号只增不改。这份文件是私有的，发布公开版时被排除。

## 谁在改什么（防撞车，Claude 和 Dot 都在 `dev` 上开发）

规矩：
1. **开工前先 `git fetch && git log HEAD..origin/dev`**，看对方推了什么；改到同一个文件，先 `git pull --rebase` 再动手。
2. **小步提交，做完一件就推**（推之前 `git pull --rebase`）。不要攒一大堆改动，也不要对共享文件做重排、改名、格式化。
3. **碰共享文件之前，先在下面「正在改」登记**（`server.ts`、`types.ts`、`gateway*.ts`、`upstream*.ts`、`model-efforts.ts`、`web/app.js`、`agent-launch.ts`），推完就删掉登记。
4. 撞了，后推的人负责合并；合并不了就在这里写一行问用户，不要覆盖对方的改动。
5. 新功能尽量放新文件，共享文件里只留最少的接线。

正在改（谁 · 哪些文件 · 做什么 · 登记时间）：
- Claude · （没有，B30 已推完）
- Dot · （还没登记；B21 会碰 `gateway*.ts`、`types.ts`、`upstream*.ts`、`model-efforts.ts`，B45 是新文件为主）

## 当前主线：把每个功能做到每个 agent（不能只做一两个）

- [~] B2 · 所有 CLI 的启动方式和后台任务：代码都写好了（launchers-extra.ts 等），**剩下的是在真实程序上实测**（B57 给你命令；B5 是已有的那几个）— 来源：「前面让你实现的功能你也只是在一两个agent上实现了」（10-06）· 备注：事实表在 research/；每个启动器的 caveat 写明哪部分是猜的
- [ ] B3 · MCP 挂载还差的：Kimi / OMP / AtomCode（还没查到它们每次启动怎么指定 MCP，能力表里标「还没做」并写了原因）；已挂的有 Codex、Claude Code、Hermes、OpenCode、Gemini、Qwen、Copilot、Droid、Cline、Goose、Crush、Grok、Qoder、OpenClaw、dsh（真程序验证）、Trae Agent（经 bin/es-mcp-stdio.ts 这个 stdio 小桥，桥测过，包括对真 EasySwitch MCP；Trae 配置文件的写法凭记忆）— 来源：「agents calling agents」产品定义（10-05）
- [ ] B5 · 把「按文档写的、没实测」的 Gemini CLI、Qwen Code、OpenCode、Copilot CLI、Aider 逐个实测（用独立目录临时安装，不动系统环境）；与 B57 的本机验证命令合并做 — 来源：盘点发现 Gemini CLI 被多报为已接入（10-06）

## 产品功能

- [~] B38 · Claude 桌面端：用官方「第三方推理（网关）」配置 + CLAUDE_USER_DATA_DIR 独立数据目录，另开一个只含外接模型的独立窗口（不拦截、不改平时的 Claude）；先在本机实测能不能启动 — 来源：「为什么claude桌面端做不了呢，opencodex都可以做来着，而且我记得在我们对话讨论产品定义的时候，你好像想出来过一个解决办法」（10-06）· 备注：我之前写的「做不了」是把「官方网关配置」和「拦截流量」混为一谈，已更正；opencodex 的做法见 src/claude/desktop-3p*.ts

## 订阅适配与协议层（B20 Claude，B21 Dot）

- [~] B20 · Cursor、Kiro、Antigravity 的订阅适配 — 来源：「这几个我都交给gpt了」（10-05）→「是给gpt做的那个给dot做」（10-06）→「订阅这里dot说他不做，这个得我们自己做了」（10-06）· 备注：Dot 不做，现在由 Claude 做；起点是云端 `gpt-wip` 里的 Kiro 适配器和协议层草稿（GPT 的快照，用前要核对）；本地 GPT 不应再改这几项，免得撞车；协议事实在 AGENTS.md 私有段 · 进展：Kiro 已做（kiro.test.ts 8 个用例，假的 Kiro 服务 + 临时 SQLite 登录库验证，**没有用真账号测**，因为不能读你的真实登录）；Antigravity 已做（antigravity.test.ts 8 个用例，用假 Google 验证，**没有用真账号测**；模型列表的返回格式是按 opencodex 的写法宽松解析的，真实格式未核实）；Cursor 未做
- [ ] B21 · 协议层重构（按出站来源选适配器）— 来源：AGENTS.md 硬性原则 5；原本是 GPT 的，2026-10-06 改给 Dot · 备注：本地 GPT 在 main 工作区已有未提交的进展，要先推到云端分支（见 B44）
- [ ] B45 · Claude 桌面端（B38）的测试和实现交给 Dot — 来源：「claude桌面端那个也让dot做测试」（10-06）· 备注：用户建议 Dot 在自己的云电脑上下载 Claude 桌面端来测（Claude 桌面端只有 macOS / Windows 版，Linux 云电脑测不了，要说明）；测通后仍要在用户的 Mac 上跑一次短确认（macOS 路径）；详细步骤在 HANDOVER.md 的 B38 段
- [ ] B58 · 把 Antigravity 的客户端密钥从写死改成运行时读取，并从仓库里移除（公开前必做，B33 的一部分）— 来源：B56 的「后续再迭代」（10-06）
- [~] B60 · 每个 agent 启动后要能在它自己的模型菜单里选模型，不是都在 EasySwitch 界面里选死：把所有可用的模型写进每个 agent 的私有配置（EasySwitch 里选的只是默认），并把「能在它自己的界面里选模型」做成能力矩阵的一列，逐个 agent 定状态 — 来源：「我记得我们说过你要能在每个harness里面选模型的，而不是都在我们easyswitch界面选好」（10-06）· 备注：Codex 和 Claude Code 早就有（目录 / /model 并排）；今天写的 13 个新启动器和已有的 Hermes、OpenCode、dsh 只写了一个主模型，是漏的 · 进展：已做——启动器拿到全部可用模型（已关闭的订阅除外），Hermes、OpenCode、dsh 和 12 个新启动器都把它们全写进 agent 自己的私有配置，EasySwitch 里选的只是默认；能力矩阵新增一列，Codex 和 Claude Code 为已实测；真实 dsh 带两个模型跑通。未做/未知——Gemini CLI、Qwen Code、Copilot CLI 只能用环境变量指定一个模型，还没查它们的 /model 能不能列出；Aider 只能手动输入模型名；这 12 个新启动器的菜单是否真的列出来，要在真实程序上确认（B57 的命令里要加这一项）
- [ ] B66 · Kimi 订阅「登录即用」：设备码登录（auth.kimi.com，要带 KimiCLI 的 X-Msh-* 头），令牌存钥匙串，开关默认关，额度读 /coding/v1/usages — 来源：B7 调研结论（Kimi 明确允许会员在第三方工具里用）
- [ ] B67 · Kimi、MiniMax 编程套餐、Grok 的额度显示：读各自的用量接口（Kimi /coding/v1/usages，MiniMax coding_plan/remains，Grok /v1/billing），显示在来源卡片上，用完时池子跳过 — 来源：B7 调研、B48 的延伸
- [ ] B68 · Grok 订阅：只读 Grok CLI 本机的登录文件，转发到它的 cli-chat-proxy；令牌过期时让 Grok 自己刷新，不自己刷；开关默认关；风险是仿客户端标识，要在界面写明 — 来源：B7 调研结论
- [ ] B69 · Qoder 订阅：用户建个人访问令牌，通过 qodercli 子进程当桥（只有文字）— 来源：B7 调研结论
- [ ] B70 · WorkBuddy / CodeBuddy / Droid 订阅：WorkBuddy 要自己走腾讯登录和 /v2/chat/completions（会拒绝 Codex、Claude Code 的系统提示）；Droid 用 droid exec 做本地桥；两者条款都要先查清再做 — 来源：B7 调研结论
- [-] B64 · MiMo 的「工具调用以文字形式回显」修复（经 Chat 接口时 MiMo V2 把工具调用写成带 <parameter= 的文字）— 来源：B11 核对时发现（10-06）· 原因：这是 opencodex 记录的、只在特定路径（Codex 的自由格式工具 + MiMo V2 经 Chat 接口）上出现的问题；我没有 MiMo 账号，没法复现，凭文字描述写恢复逻辑是猜；等真用 MiMo 遇到再做，到时有真实的响应可以对着写

## 产品方向（2026-10-06 讨论，用户拍板）

- [~] B48 · 额度感知派活，第一版：①订阅撞限额后自动换到下一个可用来源；②界面显示每个订阅还剩多少、什么时候恢复（「按任务类型提前选来源」放后面）— 来源：产品讨论方向 3，「3是要做的」「额度感知先按你说的来」（10-06）· 进展：①订阅用完后池子自动跳过它直到恢复（已做，有端到端测试，用假 OpenAI 服务验证，没用真账号）；②订阅卡片显示用了多少、几点恢复（已做）。未做：非池子的直接请求自动换备用（等订阅开关 B54 的「仅备用」档）、Copilot 的额度读取、别的订阅的额度读取。备注：与订阅开关（B54）合并设计，「仅备用」档是切换的目标
- [ ] B49 · （远期）同一件事并行派给两三个 agent，再比较和交叉审查，给合并后的差异预览 — 来源：产品讨论方向 1，「1和2先做成远期待办」（10-06）
- [ ] B50 · （远期）派活规则从手写变成「建议」：用账本数据提示“这类任务交给谁更省/更好”，一键生成规则 — 来源：产品讨论方向 2，同上（10-06）
- [ ] B51 · （远期）想清楚第一个「拿得出手」的使用场景 — 来源：「虽然不一定是去开发拿得出手的场景后面考虑，也是远期待办」（10-06）

## 加固与发布

- [ ] B33 · 公开前清单：按 PROVENANCE.md 逐项重写、换第三方图标，`make-public-snapshot.sh` 检查到 0 发现，再作为新仓库首次提交发布 — 来源：「等公开的时候一次性重写」「同意」（10-06）· 备注：当前基线 63 条
- [ ] B34 · dev 合入 main：等本地 GPT 到停点（或它的进展已推到云端），先处理 main 里未跟踪的 AGENTS.md / CLAUDE.md / PROVENANCE.md — 来源：分支分工（10-06）
