# EasySwitch 待办与开发计划

唯一的需求清单，Claude 和 GPT 共用。规则：

1. **用户在对话里提的每个需求、变更、决定，立刻写进这里**（一条一行，带用户原话和日期），再动手。
2. **收工前对照这份清单**：做完的标 `[x]` 并写“验证：”（提交号 / 测试名 / 实测结果）；没做完的保持原样；最后的回复里说清“做完几条、还剩几条、哪些是新增的”。
3. 标记：`[ ]` 待办　`[~]` 进行中　`[x]` 完成　`[-]` 不做/暂缓（写“原因：”）。
4. 检查：`npm run backlog`（看未完成）、`npm run backlog -- --check`（查格式和证据）。Claude Code 里有两个钩子自动提醒/拦截（见 `.claude/settings.json`）。
5. 编号只增不改。这份文件是私有的，发布公开版时被排除。

## 当前主线：把每个功能做到每个 agent（不能只做一两个）

- [x] B1 · 能力矩阵：每个 agent × 每个功能都有明确状态，界面可见 — 来源：「前面让你实现的功能你也只是在一两个agent上实现了，好像没有扩展到对应模块的全部agent」（10-06）· 验证：提交 d040764，capabilities.test.ts，Agent 页覆盖表
- [~] B2 · 补全 CLI 的启动方式和后台任务（现有 19 个没写，Kimi/Pi/OMP/Droid/Cline/Goose/Crush/Grok/MiniMax/Qoder/CodeBuddy/OpenClaw/Trae Agent/AtomCode 等）— 来源：同上（10-06）· 备注：事实表放在 research/（第 3 批已到：atomcode、openclaw 可做；trae-agent 部分可行；CodeBuddy CLI 疑似不能重定向；Amp 只能检测打开），第 2 批已到（goose、crush、grok、minimax、qoder：配置格式齐，启动命令多为推测；Qoder 自定义模型需登录账号含 BYOK）；第 1 批（Kimi、Pi、OMP、Droid、Cline）也到了：五个都能用私有目录启动，Droid 可能仍要求登录；补充批在路上；之后按表实现并用独立目录装来实测
- [ ] B3 · 每个支持“按次指定 MCP”的 agent 都挂上 EasySwitch 的 MCP（现在只有 Codex、Claude Code），不支持的写明原因 — 来源：「agents calling agents」产品定义 + 同上（10-06）
- [ ] B4 · 每个 agent 的思考档位和子 agent/小任务模型：能设的都设，不能设的写明原因 — 来源：「每个agent都应该有自己的推理程度、子模型、小任务模型」（10-05）+ 同上（10-06）
- [ ] B5 · 把“按文档写的、没实测”的启动方式逐个实测（Gemini CLI、Qwen Code、OpenCode、Copilot CLI、Aider）：用独立目录临时安装，不动系统环境 — 来源：盘点发现 Gemini CLI 被多报为已接入（10-06）
- [ ] B6 · 桌面端 / IDE 逐个定方案：有官方口子的像 ChatGPT 那样启动；没有的（Trae、Windsurf、Z Code、豆包）做“手动配置向导”（地址/令牌/模型一键复制 + 操作步骤，不碰它的配置）— 来源：「我们的桌面版app，你就实现了chatgpt，其余的都没实现」（10-06）
- [ ] B7 · 其余各 agent 的订阅当模型来源（Gemini CLI、Qoder、CodeBuddy、Trae、Amp、豆包、Grok、MiniMax、Kimi、Droid）逐个调研：能接就接，不能接写明原因 — 来源：「订阅额度给其他harness用」产品定义（10-05）
- [x] B8 · Claude 桌面端放进目录，标明做不了及原因（不拦截）— 来源：「Claude 订阅不借给别的 harness」（10-05）· 验证：提交 d040764，capabilities.test.ts 的 Claude 用例

## 产品功能

- [ ] B10 · Vertex 来源（Google 的专有协议）— 来源：「专有协议的来源也做」（10-05）
- [ ] B11 · 核对 MiMo：免 key 版（MiMo Free）和官方 MiMo API 两种都要，确认官方 API 预设在不在、能不能用 — 来源：「MiMo 绕过限额和 api 两种都要」（10-05）
- [ ] B12 · DeepSeek / Kimi 的思考档位界面 — 来源：我在上轮列的缺口（10-05）
- [ ] B13 · 花费预算（超额提醒或停用）— 来源：我在上轮列的缺口（10-05）
- [x] B14 · 派活规则（任务页选“自动”，按关键词/字数/文件夹/来源选 agent、模型、档位）— 来源：「agents calling agents + 按规则派活」（10-05）· 验证：dispatch.test.ts 9 个用例，提交 898ff15 之前
- [x] B15 · 任务页独立、表单一键化 — 来源：「这里不够傻瓜化，不够一键化」（10-05）· 验证：Agent 页与任务页已分离，已在界面里确认
- [x] B16 · Agent 页只分“已安装 / 未安装”，每个 agent 的档位和子模型和它放同一行 — 来源：「应该是已安装和未安装两个分类就够了」（10-05）· 验证：界面已确认
- [x] B17 · 订阅登录用 Codex 身份（设备码），不自己登记身份 — 来源：「以后都选择用codex身份，而不是自己创建一个身份」（10-05）· 验证：siwc.ts 默认通道，siwc 测试

## 委托 GPT（Claude 不碰）

- [~] B20 · Cursor、Kiro、Antigravity 的订阅适配 — 来源：「这几个我都交给gpt了」（10-05）· 备注：在 main 工作区进行
- [ ] B21 · GPT 的协议层重构（按出站来源选适配器）— 来源：AGENTS.md 硬性原则 5 · 备注：在 main 进行

## 加固与发布

- [ ] B30 · 网关鉴权令牌 — 来源：第一版 demo 后我列的公开前加固项（10-05）
- [ ] B31 · 原生 Keychain API（现在用 `security` 命令）— 来源：同上（10-05）
- [ ] B32 · README 刷新（还有借鉴描述）— 来源：同上（10-06）
- [ ] B33 · 公开前清单：按 PROVENANCE.md 逐项重写、换第三方图标，`make-public-snapshot.sh` 检查到 0 发现，再作为新仓库首次提交发布 — 来源：「等公开的时候一次性重写」「同意」（10-06）· 备注：当前基线 63 条
- [ ] B34 · dev 合入 main：等 GPT 到停点，先处理 main 里未跟踪的 AGENTS.md / CLAUDE.md / PROVENANCE.md — 来源：分支分工（10-06）
- [x] B35 · 两仓库发布策略、推送拦截钩子、发布检查脚本 — 来源：「同意」（10-06）· 验证：提交 898ff15，钩子 5 种情况实测，release-check 基线
- [x] B36 · 待办机制：本文件 + 检查脚本 + 两个钩子 — 来源：「后面我们的待办和开发计划还是要列起来，每次收工前要自动检查…每次提的需求也全部都立刻写入待办」（10-06）· 验证：npm run backlog -- --check 通过；钩子见 .claude/settings.json
