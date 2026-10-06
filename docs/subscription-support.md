# 订阅来源与官方 agent 接入核对

核对日期：2026-10-06。对应 BACKLOG B20 / B7。本文区分官方公开支持依据、代码是否存在、本地假服务验证和真实账号验收。

2026-10-06 后续整合基于用户认可的 `dev` 提交 `103a2ab`：保留 Claude 已写的 Kiro / Antigravity B20 模块，并通过 `subscription-compat.ts` 接入四协议路由，没有另写一套或删除原实现。B7 的 13 家支持资料仍是官方依据调查，不能用其中的元数据状态否认这两个既有实现，也不能用保留实现证明厂商认可其私有协议用途。

最终交接基线 `d13a72c` 另包含 Claude 的 Cursor 纯文字来源、Kimi 设备码登录和套餐用量读取。本轮继续保留这些原模块，通过窄兼容层接入，不重复实现认证。专用来源都由用户另行登录并主动打开；本轮未激活真实账号。

本轮未登录任何真实账号、未读取真实登录文件、未创建真实 Key、未调用真实模型。

## 先区分两个方向

- **把订阅变成模型来源**：其他 harness 把原始 Chat / Responses / Messages / Gemini 请求交给 EasySwitch，由来源适配器发送并返回。工具调用、历史、取消、流、用量等必须保留协议语义。
- **调用厂商自己的 agent**：官方 SDK、CLI 或 ACP 负责它自己的 agent 循环和工具。可接入派活，但不能直接宣称上面的模型来源已经可用。

官方文档存在不等于 EasySwitch 已实现。纯假服务测试通过也不等于真实账号实测。

## Cursor

官方 [TypeScript SDK](https://cursor.com/docs/sdk/typescript) 接受用户 API Key，支持本地或云端 agent。用户 Key 计入用户套餐；SDK 遵循相同的价格、请求池和 Privacy Mode。它没有自动从 Cursor 应用提取登录凭据。

SDK 支持自定义工具、限制内置工具、系统提示和本地会话存储。这些是 agent 接口；本次没有核实到一个将个人订阅直接提供为 OpenAI / Responses / Messages 模型 API 的官方合同。不要把“可调用 agent”标成“通用模型来源可用”。

[服务条款](https://cursor.com/terms-of-service) 对逆向、提取服务等另有限制。后续应基于官方 SDK 合同设计，而不是移植私有 `agent.v1.AgentService/Run` 的客户端身份或读取本机登录。

交接中的 `cursor/` 专用实现现已保留：独立 PKCE 登录、secret store 刷新令牌、HTTP/2 Connect 纯文字推理，新增来源默认关闭。它不是上述官方 SDK 接入；私有接口用途与适用条款仍未核实。工具列表不转发，历史工具消息仅作为文本，图像等媒体不能完整保留；兼容层明确记录这些损失，不能称为完整通用多模态/工具来源。

官方 SDK agent 任务适配仍是另一个未实现的方向。本轮只有合成账号和环回 HTTP/2 假服务验证，未使用真实 Cursor 账号或接口。

## Kiro

官方 [认证文档](https://kiro.dev/docs/getting-started/authentication/)（页面更新于 2026-10-02）支持 CLI 用 `KIRO_API_KEY` 进行 CI / 无界面调用。适用于文档列出的付费套餐，消耗同一订阅的 credits。已有浏览器会话优先于环境变量，不能假定设置 Key 就切换了账号。

[无界面模式](https://kiro.dev/docs/cli/headless/) 支持 `kiro-cli chat --no-interactive`，以及模型、思考档位、JSON Lines 输出。工具授权应按任务收窄，不能因无需交互就默认信任全部工具。

[ACP](https://kiro.dev/docs/cli/acp/) 是官方编辑器接入途径：通过标准输入输出传递 JSON-RPC，由 Kiro 处理会话和 agent 行为。V2 / V3 在模型配置、通知和结束信号方面不同，接入要按能力协商和所支持版本测试。

本次没有核实到原生登录令牌可用于第三方通用模型 API 的官方接口说明。这是“缺少支持依据”，不是断言任何第三方集成都被禁止。[Kiro 许可证](https://kiro.dev/license/) 指向 AWS 协议；[AWS Customer Agreement 第 6.4 节](https://aws.amazon.com/agreement/) 限制逆向、规避收费或用量限制等行为。

### 历史 WIP 与当前保留实现

较早的参考快照 `8303a37` 曾包含：

- `kiro-login.ts` 从官方客户端 SQLite `auth_kv` 取访问令牌和注册信息
- `kiro.ts` 将令牌重放到没有在上述官方文档中核实的运行时 / 管理接口，并设置 AmazonQ / KiroIDE 客户端身份
- 只读、固定厂商域名、不输出令牌是有益防护，但不能证明这种接口用途得到厂商支持

早期调查没有导入该 WIP。后续 `103a2ab` 中 Claude 独立完成的现有实现现已按用户要求保留：专用 Kiro 导入入口创建来源，新来源默认关闭，有效配置由兼容层交回既有 Kiro 模块。没有通过真实账号触发这一路径；测试仅创建临时 SQLite 和合成令牌，并把管理/推理目的地指向环回假服务。

AWS eventstream 及本地协议测试通过，不代表 Kiro 私有接口用途获得官方支持，也不代表真实账号或套餐验收完成。官方 CLI / ACP agent 路径仍是另一个尚未实现的方向，不能与当前保留的模型来源混称。

## Google Antigravity

先前核对的[个人服务附加条款第 6 节](https://antigravity.google/terms) 对第三方使用 Antigravity OAuth 列有限制，并提示停用账号风险。该官方支持风险不能因用户要求保留已有代码而消失；当前保留实现的适用条款、许可与真实使用条件尚未完成验收。

用户认可的 `103a2ab` 已含 Claude 的 Antigravity 专用实现，本轮保留并经兼容层调用，不另建重复实现。专用登录入口产生的新来源默认关闭。本次 OAuth/刷新流程只经过 fake-google 环回夹具，未打开真实登录、未读取或输出 `antigravity-client.ts` 的凭据值，也未向任何真实端点发送凭据。

条款开头为部分企业 / Google Cloud 使用列出不同合同范围；不能把个人服务限制推成所有企业 API 都不可用，也不能据此假定用户已有企业授权。

官方 [Python SDK](https://www.antigravity.google/docs/sdk/overview) 支持 Gemini API Key 和企业 Cloud 配置。这是另一条认证与计费途径，仍然提供 agent runtime，不是借用个人订阅 OAuth。

另一个相反方向：[Antigravity CLI 安装与认证文档](https://www.antigravity.google/docs/cli/install) 支持 `modelProvider=gemini`、`GEMINI_API_KEY` 和 `GOOGLE_GEMINI_BASE_URL`。这可用于研究“外接模型进入 Antigravity CLI”，并不证明“Antigravity 订阅借给别的 harness”。需要私有配置目录及真实请求的独立验证，不可直接据此改桌面 IDE 的能力状态。

## 本次运行时接口

`core/src/subscription-support.ts` 为同一份可供控制台展示的纯数据提供：

- `subscriptionSupport()`：返回副本，包含核对日期、官方 agent 路径、认证 / 计费说明、来源链接；agentRoutes 记录尚未实现的订阅 agent 适配；apiRoutes 记录已有通用 Key 通道，均没有真实账号验收
- `subscriptionSourceCapability(vendor)`：描述已核实的官方支持依据；不等于所有既有实验代码的开关或运行时总表
- `subscriptionSourceIssue(provider)`：通用新增来源入口仍拒绝订阅预留字段与未知 `plan.kind`，避免把不支持的通用订阅当普通 API 或误落入 ChatGPT
- `subscriptionSignInIssue(mode)`：通用登录入口拒绝未知模式，避免错误触发 Codex；Kiro/Antigravity/Cursor/Kimi 有各自保留的专用入口
- `existingSubscriptionKind()` / `prepareExistingSubscription()`：先校验并路由已登记、形状有效的专用 Kiro/Antigravity/Cursor/Kimi 配置，随后才应用普通来源保护；禁止一个来源同时声明多种专用鉴权。兼容层把其他入口经中立转换送到既有 Chat 适配边界，没有取代原模块的登录/协议实现

普通 API 来源即使按月收费、名字叫 Cursor 或 Kiro，也不因为名称或 `billing: subscription` 被阻止。已有 ChatGPT / Codex / Copilot 路径保持原有语义；本次审查不为它们额外背书。

集成点应在创建来源、来源出站选择、登录分支和控制台能力说明。错误不能包含输入的路径、Key 或未知模式原文；拒绝前不能开始网络 I/O，也不能取消另一个正在进行的有效登录。

## 后续适配器验收要求

保留既有 B20 实现与后续开发建议分开：以下原则不表示本轮已经重写或禁用了 Claude 的原模块。

1. 后续新接入优先采用厂商明确支持的 SDK / CLI / ACP，核实凭据来源、账号权限与条款；当前私有协议路径不能因假服务通过而称为厂商支持
2. 区分 agent 任务与模型请求，不静默压平工具历史或把工具结果伪装成普通文本
3. 禁止自动安装依赖、登录、创建持久凭据或开启额外收费；这些需要明确的用户操作或授权
4. mock 覆盖流终止、取消、超时、额度错误、无权限、工具授权、版本不兼容和重复提交
5. 获得明确许可后再验证真实官方客户端，核实原生配置前后不变；没有完成前不标“已实测”

Kiro/Antigravity/Cursor 及 Kimi 专用来源实现已保留并接入；真实厂商/账号验收与适用条款仍未完成，Cursor 仍限纯文字，不能宣称工具/多模态完整。官方 agent 接入是独立的后续方向，不能用它替代原始通用模型来源需求。


## B7：其余十家逐项结论

这里的“未核实”指本次官方公开资料未建立可供 EasySwitch 使用的接口，不是断言厂商永远不存在接口。“官方 agent”表示厂商自己的完整 agent，不能当作可任意替换 harness 的模型服务。

| 厂商 | 已核实的官方路径 | 通用模型来源结论 |
|---|---|---|
| Gemini CLI | Google 登录的 CLI/无界面模式，使用相应 AI Pro/Ultra 或 Code Assist 配额 | 不导出 OAuth；AI Studio Key / Vertex 单独计费 |
| Qoder | CLI、Agent SDK，原生登录或 PAT/组织服务账号；消耗 Qoder Credits | SDK 执行本地 agent；未核实订阅 OpenAI-compatible 推理接口 |
| CodeBuddy | Code CLI/SDK，官方登录或分区域 CodeBuddy Key | BASE_URL 自定义是 BYOK 输入，不能证明反向导出订阅 |
| TRAE | 产品订阅；企业 TraeCode CLI 页面仍为 coming soon | 未核实订阅导出；开源 trae-agent 是单独 BYOK 工具 |
| Amp | CLI/SDK，Amp 登录或 AMP_API_KEY；Amp credits 或配置的外部来源 | External API 主要管理工作区，未核实通用模型导出 |
| 豆包 | 火山方舟 Ark API 与 SDK，另行提供 ARK_API_KEY | 豆包 App 登录/会员未核实可导出；Ark API 预设是独立来源 |
| Grok | Grok Build CLI、headless、ACP；账号登录或 XAI_API_KEY | SuperGrok FAQ 已提 API 共享周用量，但 EasySwitch 通用订阅 OAuth 合同仍未核实；保留官方 API Key 预设 |
| MiniMax | M Plan（旧称 Token/Coding Plan）专用 Subscription Key，用于兼容 AI 工具 | 可走已有套餐 API 预设；普通 Key 扣 PAYG，套餐 Key 扣套餐/加油包，不能交换计费身份 |
| Kimi | Kimi Code CLI/ACP，以及提供给第三方工具的 coding Key | 国内 coding 预设可用；按区域和账号权益计费，不等于 Moonshot 开放平台余额 |
| Droid | 官方 CLI/SDK，Factory 登录或 FACTORY_API_KEY；套餐 rate limits/额外用量 | Key 是 agent/平台凭据，不宣称通用模型导出；BYOK 另算 |

### 必须保留的限制

- Ark Coding Plan 官方规定仅限 AI 编程工具，不能用于通用 API 服务或其他非编程场景。套餐预设已加醒目说明；运行时无法从任意模型请求证明用途，不能宣称所有 harness/任务自动符合套餐条款
- Kimi 中国会员材料说明部分权益共享，国际文档把 Membership/Code/Open Platform 分开；应以相应区域的实际 Key 与端点为准。当前 `kimi-coding` 预设是国内端点，不擅自换到国际账号
- Kimi 官方 Key 接入指南提示不要篡改 User-Agent 绕过工具识别。交接已有的设备码实现携带 KimiCLI/X-Msh 头，本轮原样保留其身份机制，不另写/扩展；其适用许可与真实验收单独待核实，不能由 API Key 支持范围推导
- MiniMax 旧套餐名仍保留预设 ID 兼容已存配置，但文案解释最新 M Plan 与专用 Subscription Key。生产/批量服务与个人交互式开发的许可、价格和额度不能混为一谈
- Grok 的共享用量新说明意味着不能写“SuperGrok 永不覆盖 API”；也不能从该事实推导未公开的 OAuth 接法已受支持
- 本次没有实现上述厂商官方 agent SDK 的任务适配。已有 BYOK 启动器与此是两个方向，不改变其原生配置或登录

### B7 官方来源（2026-10-06 核对）

- Gemini：[认证](https://geminicli.com/docs/get-started/authentication/)、[配额与计费](https://geminicli.com/docs/resources/quota-and-pricing/)
- Qoder：[SDK 认证](https://docs.qoder.com/cli/sdk/authentication)、[SDK 架构](https://docs.qoder.com/cli/sdk/how-it-works)、[用量](https://docs.qoder.com/cli/usage)
- CodeBuddy：[SDK](https://www.codebuddy.ai/docs/cli/sdk)、[环境变量](https://www.codebuddy.ai/docs/cli/env-vars)、[套餐](https://www.codebuddy.ai/pricing/)
- TRAE：[企业页面](https://www.trae.ai/enterprise)、[官方开源 trae-agent](https://github.com/bytedance/trae-agent)、[套餐](https://www.trae.ai/pricing)
- Amp：[SDK](https://ampcode.com/docs/sdk)、[计费](https://ampcode.com/docs/pricing)、[模型路由](https://ampcode.com/docs/customize/model-routing)、[External API](https://ampcode.com/api/external)
- 豆包：[Ark 快速开始](https://docs.volcengine.com/docs/ark/quick-start?lang=zh)、[豆包助手 API](https://docs.volcengine.com/docs/ark/doubao-assistant?lang=zh)、[Coding Plan 范围](https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh)
- Grok：[Build](https://docs.x.ai/build/overview)、[无界面/ACP](https://docs.x.ai/build/cli/headless-scripting)、[API 快速开始](https://docs.x.ai/developers/quickstart)、[订阅 FAQ](https://docs.x.ai/grok/faq)
- MiniMax：[M Plan FAQ](https://platform.minimax.io/docs/m-plan/faq)、[旧 Token Plan FAQ](https://platform.minimax.io/docs/token-plan/faq)、[CLI](https://platform.minimax.io/docs/m-plan/minimax-cli)
- Kimi：[会员/接入指南](https://www.kimi.com/en/help/kimi-code/membership-guide)、[区域与 API FAQ](https://www.kimi.com/code/docs/en/kimi-code/faq.html)、[国际 API 产品区别](https://www.kimi.ai/help/kimi-api/api-troubleshooting)
- Droid：[个人套餐](https://docs.factory.ai/pricing/individuals)、[Python SDK](https://docs.factory.com/sdk/python)、[Headless](https://docs.factory.com/droid-exec/overview)、[BYOK](https://docs.factory.com/model-independence/byok)

测试 `subscription-support.test.ts` 校验 13 家完整覆盖、元数据副本、未支持原生凭据 fail-closed、官方 Key 通道与 OAuth 区分；`provider-presets.test.ts` 校验 API 路由指向实际预设。用 `npm run test:local` 运行，不使用含真实 agent 的全量旧入口。


## 保留 B20 模块的本地回归

`kiro.test.ts`、`antigravity.test.ts` 与 `fake-google.ts` 已审计：全部上游地址指向数字环回，Kiro 登录库在临时目录内由测试写入，Google access/refresh token 均为合成 fixture；不启动真实浏览器或 agent。网关请求改用本次进程签发的 fixtureToken，不通过测试助手“修复”伪造/失效令牌。假浏览器只请求环回 OAuth callback，使用 manual redirect，不能自动离开环回。

2026-10-06 隔离 HOME、内存 secret store 与 local-only-guard 下两文件 16/16 通过。测试涵盖默认关闭、假登录/刷新、工具/消息/流、用量、401/403/429、截断、删除来源不修改原临时登录库。证据只属于假服务，不能写成真实 Google/Kiro 登录或模型验证。当前 checkout 没有独立 `aws-eventstream.test.ts`，不要把不存在的文件加入白名单；Kiro 测试已使用它的 frame encoder。


## 最终交接的 Cursor / Kimi / 用量回归

`cursor.test.ts` 与 `fake-cursor.ts` 使用临时环回 HTTP/1 + HTTP/2 假服务器，`kimi.test.ts` / `fake-kimi.ts` 使用合成设备码、JWT 和 refresh token，`plan-usage.test.ts` 注入内存 fetch，不联系真实用量端点。执行器 guard 同时限制 fetch 与 HTTP/2 connect 的目的地，禁止真实程序。

新增兼容层只接受 `{accountId,email?}` 的 Cursor/Kimi 元数据，拒绝混合鉴权和未知字段；使用对应厂商固定配置端点，忽略持久化 source URL、鉴权头/路径/query 的覆盖。Kimi 保留原模块创建的 allowlist 客户端头，明确 Bearer token 并禁止重定向。缺少原账号 token resolver 时失败，不回退到普通 API Key。Cursor 的文本化工具历史、遗漏媒体与不转发工具列表写进 dropped 信息。

以上回归检查默认关闭、模拟登录/刷新/删除、目的地固定、元数据验证、resolver 缺失与工具损失说明。结果只证明本地兼容集成，不证明私有接口得到官方支持，也不构成自动启动用户账号的许可。
