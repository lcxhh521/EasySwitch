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
- Dot · B74–81分组开发：provider独占厂家中立适配与Vertex；流worker独占protocol/downstream/upstream-events；launcher独占dsh/文字桥；budget独占ledger/global-budget/budget；server/API由单一集成者接线。所有验证仅云端fake，不执行B85真机项（2026-10-06）
- Claude · 不做开发项（B72/B73）：负责产品定义、检查 Dot 的提交、完善、真机验证；需要改代码时（评审后的小修、完善）先登记再改，避开 Dot 正在改的文件

## 当前主线：把每个功能做到每个 agent（不能只做一两个）

- [~] B2 · CLI 启动与后台任务：代码补齐，真实程序验收未完成 — 来源：同上（10-06） · 进展：Kimi TS/旧CLI、OMP、AtomCode、CodeBuddy Code私有启动已补，保留B60全模型菜单；CodeBuddy的Messages地址覆盖已有官方依据，不再沿用不能重定向的旧猜测。新增实现仅经云端纯/假服务验证，真实参数和会话行为待验收；见 docs/agent-gaps-validation.md
- [~] B3 · 每个支持“按次指定 MCP”的 agent 都挂上 EasySwitch 的 MCP（已挂：Codex、Claude Code、Hermes、OpenCode、Gemini、Qwen、Copilot、Droid、Cline、Goose、Crush、Grok、Qoder、OpenClaw、dsh、Trae Agent 等，逐个见各启动器的 mcpCaveat），不支持的写明原因 — 来源：「agents calling agents」产品定义 + 同上（10-06） · 2026-10-06 云端进展：dsh 的已安装插件私有挂载、Kimi/OMP/AtomCode/CodeBuddy MCP 及 Trae stdio→HTTP 桥已实现，18 个 agent-config-gaps/mcp-stdio-bridge 纯/假服务测试通过；能力矩阵保持 documented，真实客户端和项目级配置覆盖行为未验收
- [ ] B5 · 把「按文档写的、没实测」的 Gemini CLI、Qwen Code、OpenCode、Copilot CLI、Aider 逐个实测（用独立目录临时安装，不动系统环境）；与 B57 的本机验证命令合并做 — 来源：盘点发现 Gemini CLI 被多报为已接入（10-06）

## 产品功能

- [~] B38 · Claude 桌面端：官方「第三方推理（网关）」模式的独立窗口，私有 HOME/数据目录、不拦截、不改平时的 Claude；按当前云端范围实现与验证 — 来源：「为什么claude桌面端做不了呢，opencodex都可以做来着，而且我记得在我们对话讨论产品定义的时候，你好像想出来过一个解决办法」（10-06） · 备注：隔离后端/API/UI、17个后台假程序与5个界面测试通过；已核验官方Linux beta 2.19675.1忽略CLAUDE_USER_DATA_DIR，生产启动在spawn前阻塞且experimental参数不能绕过。云端网络隔离预检被拒绝，真实应用未启动。当前只用获准云端，不把用户Mac当默认后备；真实隔离、消息链路与macOS兼容待验收；见 docs/claude-desktop-isolation.md

## 订阅适配与协议层（全部由 Dot 接手，见 B72）

- [~] B21 · 协议层重构（按出站来源选适配器）— 来源：AGENTS.md 硬性原则 5；原本是 GPT 的，2026-10-06 改给 Dot · 备注：按需复用gpt-wip 8303a37，保留并行来源、菜单和任务功能；四协议选择/直通/12向转换、签名顺序、取消与不重放已在bfefccc推送。审计白名单386项通过、1真实Keychain测试跳过，类型检查通过；真实客户端/厂商兼容性待验收；见 docs/outbound-adapters.md
- [~] B45 · Claude 桌面端（B38）的测试和实现交给 Dot — 来源：「claude桌面端那个也让dot做测试」（10-06） · 备注：隔离后端/API/UI、17个后台假程序与5个界面测试通过；已核验官方Linux beta 2.19675.1忽略CLAUDE_USER_DATA_DIR，生产启动在spawn前阻塞且experimental参数不能绕过。云端网络隔离预检被拒绝，真实应用未启动。当前只用获准云端，不把用户Mac当默认后备；真实隔离、消息链路与macOS兼容待验收；见 docs/claude-desktop-isolation.md
- [ ] B58 · 把 Antigravity 的客户端密钥从写死改成运行时读取，并从仓库里移除（公开前必做，B33 的一部分）— 来源：B56 的「后续再迭代」（10-06）
- [~] B60 · 每个 agent 启动后要能在它自己的模型菜单里选模型，不是都在 EasySwitch 界面里选死：把所有可用的模型写进每个 agent 的私有配置（EasySwitch 里选的只是默认），并把「能在它自己的界面里选模型」做成能力矩阵的一列，逐个 agent 定状态 — 来源：「我记得我们说过你要能在每个harness里面选模型的，而不是都在我们easyswitch界面选好」（10-06）· 备注：Codex 和 Claude Code 早就有（目录 / /model 并排）；今天写的 13 个新启动器和已有的 Hermes、OpenCode、dsh 只写了一个主模型，是漏的 · 进展：已做——启动器拿到全部可用模型（已关闭的订阅除外），Hermes、OpenCode、dsh 和 12 个新启动器都把它们全写进 agent 自己的私有配置，EasySwitch 里选的只是默认；能力矩阵新增一列，Codex 和 Claude Code 为已实测；真实 dsh 带两个模型跑通。未做/未知——Gemini CLI、Qwen Code、Copilot CLI 只能用环境变量指定一个模型，还没查它们的 /model 能不能列出；Aider 只能手动输入模型名；这 12 个新启动器的菜单是否真的列出来，要在真实程序上确认（B57 的命令里要加这一项）
- [ ] B71 · Cursor 的工具调用：现在它要执行工具就报错；要支持就得实现它的 exec 一族消息（读文件、改文件、跑命令的各种请求和结果字段），再映射成 Chat 的 tool_calls — 来源：B20 第一版的限制（10-06）
- [ ] B68 · Grok 订阅：只读 Grok CLI 本机的登录文件，转发到它的 cli-chat-proxy；令牌过期时让 Grok 自己刷新，不自己刷；开关默认关；风险是仿客户端标识，要在界面写明 — 来源：B7 调研结论
- [~] B69 · Qoder 订阅：用户建个人访问令牌，通过 qodercli 子进程当桥（只有文字）— 来源：B7 调研结论 · 进展：已接专用创建/默认关闭/显式开关、纯文字四入口和私有HOME/cwd；工具/图片提前拒绝，PAT不经argv，创建不执行程序。仅fake执行器和UI回归，真实CLI与账户/条款验收未完成（2026-10-06）
- [~] B70 · WorkBuddy / CodeBuddy / Droid 订阅：WorkBuddy 要自己走腾讯登录和 /v2/chat/completions（会拒绝 Codex、Claude Code 的系统提示）；Droid 用 droid exec 做本地桥；两者条款都要先查清再做 — 来源：B7 调研结论 · 进展：CodeBuddy官方CLI纯文字来源已接显式国际/国内区域与API Key、默认关闭/独立开关、四协议文字入口，私有会话不继承本地gateway地址；仅fake验证，真实CLI/账号/条款验收未完成。Droid仅无工具控制器fake握手，生产创建/调用501；WorkBuddy来源未完成（2026-10-06）
- [-] B64 · MiMo 的「工具调用以文字形式回显」修复（经 Chat 接口时 MiMo V2 把工具调用写成带 <parameter= 的文字）— 来源：B11 核对时发现（10-06）· 原因：这是 opencodex 记录的、只在特定路径（Codex 的自由格式工具 + MiMo V2 经 Chat 接口）上出现的问题；我没有 MiMo 账号，没法复现，凭文字描述写恢复逻辑是猜；等真用 MiMo 遇到再做，到时有真实的响应可以对着写

- [x] B73 · Claude 的新角色：负责产品定义、代码检查（评审 Dot 的提交）和完善，以及 Dot 做不了的事（需要用户 Mac 的真机验证：跑真实的 agent、验证启动器、界面截图、钥匙串、真账号核对）；不再自己接清单上的开发项，除非用户点名 — 来源：「后续我觉得你就负责产品定义和代码检查以及完善，然后做dot不能做的事情」（10-06）· 验证：HANDOVER.md 第 0.5 节、AGENTS.md「分工与分支」、本文件登记表已按此改写；修正 B72 里「Claude 不再开发」的说法（开发归 Dot，Claude 做定义、检查、完善和真机验证）

## Claude 评审 Dot 的 01577f2 后派给 Dot 的新活（2026-10-06；Claude 已直接修了测试里暴露的回归）

- [x] B86 · Claude 评审 01577f2 并直接修了回归：ChatGPT 桌面端的 /backend-api/codex 和 WebSocket 不该要我们的会话令牌（桌面端带的是它自己的登录），已恢复并重开增强启动；Codex 的 web_search 等厂商自带工具跨协议改回「丢弃并记录」而不是整个请求 400；system/developer 指令合并成开头一条；工具结果的内容块转文字；parallel_tool_calls 只在 false 时发给 Chat；有 chat 和 messages 两种来源时优先 chat、Messages 默认 token 上限 4096 改 16384；Claude 专属字段和账号标识不发给第三方 Messages 中转站；上游 4xx 的原因文字转给 agent；MCP 桥恢复并发；钥匙串小程序启动时自动编译、/api/state 不再因读 Key 失败而整页 500；测试运行时默认用内存密钥库（之前会在用户 Mac 上弹钥匙串窗口）；两个旧的 GET 启动测试改成 POST；macOS 的 /private 路径测试；公开快照排除 docs/；界面里的开发话术改成人话 — 来源：用户「有错误就直接改，然后给 dot 派新活」（10-06）· 验证：本次提交；新增 core/test/outbound-shape.test.ts 5 例和 mcp-stdio-bridge 并发例；真实 Claude Code、Codex、dsh 的端到端测试在这台 Mac 上恢复通过
- [x] B74 · 【Dot】订阅适配器（Kiro、Antigravity、Cursor、Kimi）直接吃中立的 Conversation，去掉 subscription-compat.ts 里「先转 Chat 再交给适配器」的中转（硬性原则 5）；顺带补回丢掉的：孤儿 tool_use 修复（repairToolPairs）、Kimi 流式用量（include_usage）、Messages 入站的缓存键、已保存的档位、developer 角色处理 — 来源：Claude 评审 B21 的发现 · 验证：中立来源构造器与subscription-conversation、四厂家/Vertex假服务57项通过；厂商鉴权和默认关闭保留，无真实账号调用（2026-10-06）
- [x] B75 · 【Dot】Messages 和 Gemini 入站的流式输出：上游先输出 thinking 再输出文本时，现在几乎全部缓冲到结束才一次给出（downstream.ts 只即时流出 index 0 的文本块），Claude Code 和 Gemini CLI 看不到实时进展；改成按块即时流出 thinking、text、tool_use，签名在块末补发 — 来源：Claude 评审 B21 的发现 · 验证：protocol-streaming的13项暂停上游fixture证明思考、后续文字及工具边界在EOF前输出；签名顺序/截断/资源上限均保留，标准Gemini对象参数在工具块完成时发送，真实客户端另验收（2026-10-06）
- [x] B76 · 【Dot】小项一批：Chat→Chat 直通也做 repairToolPairs 与 null 转空串的修复；agent 自带的 effort 在没保存档位时不应开启 DeepSeek/GLM/Qwen 的 thinking；流中途失败也要把已用的 token 写进账本；dsh 缺插件时派活降级成不挂 MCP 并说明原因，而不是整次失败；vertex-gemini 的 thinkingLevel 按模型代际映射（2.5 用 thinkingBudget，不认识的档位不发）；launchers-extra 里 --api-key 的 argv 冗余参数删掉 — 来源：Claude 评审 · 验证：启动器/Vertex已分别小批推送，通用Chat真实出口修配对与null、只按已保存档位启用thinking、保留中断前usage；隔离候选typecheck和84项协议/来源fake通过（2026-10-06）
- [x] B77 · 【Dot】删死代码并更新文档：sendChat、sendResponses、translate.ts 的 responsesToChat 和 ResponsesStream、anthropic.ts 的 messagesToChat、AnthropicStream、chatToMessage、gemini.ts 的 geminiToChat 和 GeminiStream、gateway.ts 的 applyThinking（现在没有生产调用，却有测试给人覆盖的错觉）；这些测试要改成测真实路径（reasoning 优先的流式、tool_result 数组、web_search 和 developer 发往 Chat、Messages 中转字段清理、跨协议错误文字、孤儿 tool_use）；AGENTS.md 代码地图里 sendChat「唯一出口」改成现状 — 来源：Claude 评审 · 验证：生产引用图清理死出口和旧转换器，测试迁到prepareOutbound/readOutput/Downstream真实路径；保留仍用类型/估算/schema/请求整形，AGENTS代码地图同步，未删生产厂家输出解析（2026-10-06）
- [~] B78 · 【Dot】钥匙串：helper 用稳定身份签名；既有条目（旧版 security 命令创建的）读写和更新是否会弹授权、launchd 后台无人点击会不会 15 秒超时，用一次性测试条目在 macOS 上验证（EASYSWITCH_TEST_KEYCHAIN=1，不碰真 key），并把回退路径写进文档；helper 缺失要在 /health 报告；native-keychain.test 的「不回退 argv」要扫 native-keychain.ts 而不只是 secrets.ts；helper 在没有默认钥匙串的环境（用户 Mac 上曾弹「找不到用于储存的钥匙串」）要有可读的失败，而不是弹窗循环 — 来源：Claude 评审与用户 Mac 上的弹窗 · 进展：稳定签名检查、无交互helper、失败冷却/恢复及脱敏health已实现，旧unsigned/ad-hoc helper拒绝；只通过fake与脚本语法，已有签名身份的前台重建及旧ACL/无默认Keychain/launchd验收仍归B85，未运行Mac工具；隔离候选typecheck、脚本语法、36项fake/HTTP测试通过，1真实Keychain明确跳过（2026-10-06）
- [x] B79 · 【Dot】预算性能与可靠：global-budget 每次请求都全量解析账本（20 万行约 376 毫秒，会阻塞事件循环），改成内存累计加文件偏移增量读取；账本末尾半行要容忍，accountingFailed 一次短暂写盘失败就永久置位要能自愈；没有 providerId 的旧账本条目不应把本月所有 stop 来源一起封掉；monthlyUsd 为 0 的旧语义（等于没有预算）要迁移而不是 fail-closed；budget.json 损坏且预算关着时不应阻断推理 — 来源：Claude 评审 · 验证：ledger-incremental与预算假测试验证20万行预热后不再读取/解析历史、半行续接、恢复去重、旧0与已关闭设置迁移；真实账单硬限额不在保证范围（2026-10-06）
- [x] B80 · 【Dot】会话令牌只在内存、24 小时：任何重启（崩溃、launchd、部署）会让所有运行中的 agent 会话永久 401，交互窗口超过 24 小时会中途失效；把令牌的 sha256 和过期时间存进权限 0600 的文件使重启后仍有效；手动签发的令牌设数量上限和每 agent 限频（现在能占满 2048 个会话让正常启动失败）；revoke 找不到时回 404 的 body 别写 ok:true — 来源：Claude 评审 · 验证：哈希/权限/固定expiry的0600追加记录、重启/撤销/过期/安全文件检查、手动限额和API回归；默认仍24h，显式ttlMs才可更长且最多30天，不自动延寿；故障仍清理自有目录并报告未确认撤销；隔离候选typecheck及62项受控测试通过（45项纯/HTTP+17桌面假程序），无真实持久凭据签发（2026-10-06）
- [~] B81 · 【Dot】文字桥（Qoder、CodeBuddy）：加全局并发上限（2 到 3 个）；孙进程握着管道时 close 不触发的兜底超时；stderr 与 stdout 分开计字节；控制台创建时 binary 要限制 basename、存在、可执行且不是所有人可写；子进程要带代理环境变量；首次真机验证要在无网或假上游下确认「让它读文件，它读不了」；Qoder 用的 --config-dir 与 research 里记的 QODER_CONFIG_DIR 对账 — 来源：Claude 评审
- [ ] B82 · 【Dot】docs/ 改成面向用户的公开文档：去掉 B 编号、提交号、人名和「用户明确批准」这类内部话，differentiation-review.md 挪进 research/；README 里指向 docs 的链接要保持有效（公开快照现在整体排除 docs/，要么发布脚本把清理后的 docs 带上，要么 README 去掉这些链接）；release-check 加一条：公开内容里不得出现 B 编号、dot、gpt-wip — 来源：Claude 评审
- [ ] B83 · 【Dot】界面：协议多选默认折叠并写「通常不用动」，加「检测一下」；Claude 桌面端永久禁用的卡片折叠进「实验功能」；controls.js 里 b.unknownCostCalls 转义；native-keychain.md 与 gateway-budget-keychain.md 重复的合并 — 来源：Claude 评审
- [ ] B84 · 【Dot】`npm test` 和 `test:local` 白名单的关系写清楚；白名单漏掉的文件（chatgpt-e2e、claude-e2e、codex-e2e、es-cli、agent-launch 等）这次在 macOS 上暴露了 16 个失败，今后改了 gateway-auth、路径、启动接口就要同步改这些测试（Claude 会在 macOS 上定期跑完整 `npm test`）；mac 路径敏感的新测试用 realpathSync(tmpdir()) — 来源：Claude 评审与测试结果
- [ ] B85 · 【Claude】需要用户 Mac 的验收：B2/B5/B57/B60 的真机核对、B38 在 macOS 上验证 --user-data-dir 开关和文件系统审计（HANDOVER 第 9 节）、ChatGPT 桌面端增强启动回归验证、各订阅的真账号核对（要用户在场）；Dot 不做 — 来源：用户 10-06「做dot不能做的事情」

## 产品方向（2026-10-06 讨论，用户拍板）

- [~] B48 · 额度感知派活，第一版：①订阅撞限额后自动换到下一个可用来源；②界面显示每个订阅还剩多少、什么时候恢复（「按任务类型提前选来源」放后面）— 来源：产品讨论方向 3，「3是要做的」「额度感知先按你说的来」（10-06）· 进展：①订阅用完后池子自动跳过它直到恢复（已做，有端到端测试，用假 OpenAI 服务验证，没用真账号）；②订阅卡片显示用了多少、几点恢复（已做）。未做：非池子的直接请求自动换备用（备用选择规则尚未明确）、Copilot 的额度读取、别的订阅的额度读取。备注：B54 已明确采用开/关二态，旧“仅备用”三态方案被取代，不据此自动选择直连请求的备用来源
- [ ] B49 · （远期）同一件事并行派给两三个 agent，再比较和交叉审查，给合并后的差异预览 — 来源：产品讨论方向 1，「1和2先做成远期待办」（10-06）
- [ ] B50 · （远期）派活规则从手写变成「建议」：用账本数据提示“这类任务交给谁更省/更好”，一键生成规则 — 来源：产品讨论方向 2，同上（10-06）
- [ ] B51 · （远期）想清楚第一个「拿得出手」的使用场景 — 来源：「虽然不一定是去开发拿得出手的场景后面考虑，也是远期待办」（10-06）

## 加固与发布

- [ ] B33 · 公开前清单：按 PROVENANCE.md 逐项重写、换第三方图标，`make-public-snapshot.sh` 检查到 0 发现，再作为新仓库首次提交发布 — 来源：「等公开的时候一次性重写」「同意」（10-06）· 备注：当前基线 63 条
- [ ] B34 · dev 合入 main：等本地 GPT 到停点（或它的进展已推到云端），先处理 main 里未跟踪的 AGENTS.md / CLAUDE.md / PROVENANCE.md — 来源：分支分工（10-06）

## 当前云端验收记录

旧335快照仅对应0a9f8e2。当前bfefccc（保留2045808与d13a72c）安全白名单386项通过：369项纯/本地假服务/UI、17项桌面假程序；1项真实Keychain明确跳过、零失败。类型、语法、待办及差异检查通过；两个源码提交均已推私有dev，没有真实agent、账户或付费模型调用。生产 Claude Desktop 和未经验证的原生 ChatGPT WebSocket 仍明确拒绝；真实账号/平台验收不因源码存在而完成。B64 保持等待真实复现，远期和公开发布任务不自动启动。

### Qoder / Droid 文字来源切片（2026-10-06）

B69、B70各推进一个部分切片，未新增或整体关闭待办：Qoder专用创建/默认关闭/显式开关和四协议纯文字来源已接入，Droid生产保持501。12项模块fake、4项来源/API和3项界面回归通过；完整审计白名单405项通过（388项纯/本地假服务/UI +17项桌面假程序）、1项真实Keychain跳过、零失败；类型、语法、待办和差异检查通过。没有运行真实Qoder/Droid或使用真实账户，条款与平台验收未完成；见 docs/cli-text-bridges.md。

### CodeBuddy 文字来源切片（2026-10-06）

B70推进独立于入站启动器的官方CLI文字来源，没有关闭整个B70。新增6项模块fake、2项来源/API、2项界面和1项能力说明回归；完整审计白名单416项通过（399项纯/本地假服务/UI +17项桌面假程序）、1项真实Keychain跳过、零失败，类型/语法/待办/差异检查通过。国内/国际凭据区域由用户明确选择，不自动探测/登录/执行；真实CLI、计费及条款验收仍未完成。

### 966a5de 后的 ChatGPT 权限修正（2026-10-06）

B86的Mac端结果保留为原作者验收记录，不等于Dot在Mac复验。云端静态复查确认ChatGPT前缀可匿名调用已存外部Key，现改为外部模型/合并本地目录必须有有效本地capability；调用方厂商凭据只授权固定官方目标的原生HTTP转发。原生WS因持续预算/会话约束未建立而返回409，增强启动也保持待验收。18项原始HTTP/loopback安全回归通过，类型与差异检查通过；chatgpt-e2e测试源码已同步新权限边界但没有执行真实Codex路径。其他B74–84独立推进，不把416历史白名单数字套到本次并行工作树。

### B76 / B81 启动器与文字桥加固（2026-10-06）

已补dsh缺少未安装插件时显式降级、Trae令牌不经argv，以及文字桥全局3并发、管道不关闭兜底、分离输出配额、代理变量白名单与创建前文件元数据校验。错误插件覆盖/不安全链接仍拒绝。隔离候选基于8c9886d加本批文件，类型检查及71项受控测试通过。全部只使用注入元数据与fake进程；真实CLI文件访问隔离、代理行为和平台验收仍未完成，因此B81保持部分完成。

### B86 后续兼容与错误边界修正（2026-10-06）

保留可用的形状修复，缩窄Messages字段清理：第三方不接账户user_id，未知兼容中转保留format/reasoning/context，已知GLM兼容调整仍限其对应主机。可选厂商工具记损失，强制已丢弃/未知工具明确拒绝。跨协议错误读取限4KiB/250ms，仅输出固定类别，不回显任意文本、Bearer或JWT；重试/额度检测也用同一有界读法。84项隔离候选受控测试和类型检查通过，没有真实上游调用。
