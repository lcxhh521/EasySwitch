# 订阅来源与官方 agent 接入

2026-10-18 更新。唯一需求清单为 BACKLOG.md。B115已取消任务派发、规则/评价/建议、并行互审、EasySwitch MCP互调与自动注册，以及专用后台执行器；不再规划替代调度路线。历史设计只保留在Git历史，用户已有记录和规则文件不删除、不迁移、不自动执行。


核对日期：2026-10-06。官方 API Key、官方 agent 接口和原生订阅登录复用是不同能力；下面分别说明实现范围、认证方式和真实验收限制。

Kiro、Antigravity、Cursor、Kimi 有专用来源入口，默认关闭，需使用者明确登录或导入后主动开启。测试只使用临时目录、合成登录数据与本地假服务，没有使用真实账号或调用真实模型。私有协议实现存在，不等于其用途已获厂商认可。

## 先区分两个方向

- **把订阅变成模型来源**：其他 harness 把原始 Chat / Responses / Messages / Gemini 请求交给 EasySwitch，由来源适配器发送并返回。工具调用、历史、取消、流、用量等必须保留协议语义。
- **调用厂商自己的 agent**：官方 SDK、CLI 或 ACP 负责它自己的 agent 循环和工具。不属于EasySwitch当前交付范围，不能作为模型来源可用的证据。

官方文档存在不等于 EasySwitch 已实现。纯假服务测试通过也不等于真实账号实测。

已实现 Qoder 与 CodeBuddy 的实验性 CLI 纯文字来源，见 [CLI 文字桥边界](cli-text-bridges.md)。它们默认关闭，只使用用户显式提供的 PAT/API Key，不接收工具/媒体，真实 CLI 尚未验收；不能将其认定为通用模型 API 或完整 agent 会话集成。注册表的 `not-verified` 仍指通用模型 API，`agentRoutes` 的未实现仍指完整 agent 接入，不否认这些受限文字桥。

## Cursor

官方 [TypeScript SDK](https://cursor.com/docs/sdk/typescript) 接受用户 API Key，支持本地或云端 agent。用户 Key 计入用户套餐；SDK 遵循相同的价格、请求池和 Privacy Mode。它没有自动从 Cursor 应用提取登录凭据。

SDK 支持自定义工具、限制内置工具、系统提示和本地会话存储。这些是 agent 接口；当前没有核实到一个将个人订阅直接提供为 OpenAI / Responses / Messages 模型 API 的官方合同。不要把“可调用 agent”标成“通用模型来源可用”。

[服务条款](https://cursor.com/terms-of-service) 对逆向、提取服务等另有限制。后续仅核查官方支持的模型来源合同；不设计SDK任务接入，不移植私有客户端身份或读取本机登录来冒称官方兼容。

当前 `cursor/` 专用实现提供：独立 PKCE 登录、secret store 刷新令牌、HTTP/2 Connect 纯文字推理，新增来源默认关闭。它不是上述官方 SDK 接入；私有接口用途与适用条款仍未核实。工具列表不转发，历史工具消息仅作为文本，图像等媒体不能完整保留；兼容层明确记录这些损失，不能称为完整通用多模态/工具来源。

官方 SDK agent 任务适配路线已取消。当前验证只有合成账号和环回 HTTP/2 假服务验证，未使用真实 Cursor 账号或接口。

## Kiro

官方 [认证文档](https://kiro.dev/docs/getting-started/authentication/)（页面更新于 2026-10-02）支持 CLI 用 `KIRO_API_KEY` 进行 CI / 无界面调用。适用于文档列出的付费套餐，消耗同一订阅的 credits。已有浏览器会话优先于环境变量，不能假定设置 Key 就切换了账号。

[无界面模式](https://kiro.dev/docs/cli/headless/) 支持 `kiro-cli chat --no-interactive`，以及模型、思考档位、JSON Lines 输出。工具授权应按任务收窄，不能因无需交互就默认信任全部工具。

[ACP](https://kiro.dev/docs/cli/acp/) 是官方编辑器接入途径：通过标准输入输出传递 JSON-RPC，由 Kiro 处理会话和 agent 行为。V2 / V3 在模型配置、通知和结束信号方面不同；这些事实不构成本项目的ACP实施计划。

当前没有核实到原生登录令牌可用于第三方通用模型 API 的官方接口说明。这是“缺少支持依据”，不是断言任何第三方集成都被禁止。[Kiro 许可证](https://kiro.dev/license/) 指向 AWS 协议；[AWS Customer Agreement 第 6.4 节](https://aws.amazon.com/agreement/) 限制逆向、规避收费或用量限制等行为。

### Kiro 来源的实现边界

专用适配器按请求只读用户选择的 Kiro CLI 登录库，构造其对话状态并解析 AWS eventstream。它不复制或刷新原生登录，来源删除不修改客户端登录库。底层私有运行时协议和客户端标识的适用许可仍需核实；固定目的地和令牌保护不能替代厂商支持依据。

本地测试使用临时 SQLite、合成令牌和环回管理/推理服务，覆盖默认关闭、消息/工具、截断及错误。官方 CLI / ACP agent 路线仍是不同的集成方式；不能把模拟结果写成真实账号验收。

## Google Antigravity

先前核对的[个人服务附加条款第 6 节](https://antigravity.google/terms) 对第三方使用 Antigravity OAuth 列有限制，并提示停用账号风险。代码存在不会消除这些官方支持风险；实现的适用条款、许可与真实使用条件尚未完成验收。

Antigravity 专用登录入口创建的来源默认关闭。OAuth 与刷新流程只经环回假服务验证；真实登录、账户权限、模型兼容与适用条款尚未验收。

条款开头为部分企业 / Google Cloud 使用列出不同合同范围；不能把个人服务限制推成所有企业 API 都不可用，也不能据此假定用户已有企业授权。

官方 [Python SDK](https://www.antigravity.google/docs/sdk/overview) 支持 Gemini API Key 和企业 Cloud 配置。这是另一条认证与计费途径，仍然提供 agent runtime，不是借用个人订阅 OAuth。

另一个相反方向：[Antigravity CLI 安装与认证文档](https://www.antigravity.google/docs/cli/install) 支持 `modelProvider=gemini`、`GEMINI_API_KEY` 和 `GOOGLE_GEMINI_BASE_URL`。这可用于研究“外接模型进入 Antigravity CLI”，并不证明“Antigravity 订阅借给别的 harness”。需要私有配置目录及真实请求的独立验证，不可直接据此改桌面 IDE 的能力状态。

## 当前运行时接口

`core/src/subscription-support.ts` 为同一份可供控制台展示的纯数据提供：

- `subscriptionSupport()`：返回副本，包含核对日期、官方 agent 路径、认证 / 计费说明、来源链接；agentRoutes仅记录厂商agent接口资料及未实现状态，不表示本项目待开发适配；apiRoutes 记录已有通用 Key 通道，均没有真实账号验收
- `subscriptionSourceCapability(vendor)`：描述已核实的官方支持依据；不等于所有既有实验代码的开关或运行时总表
- `subscriptionSourceIssue(provider)`：通用新增来源入口仍拒绝订阅预留字段与未知 `plan.kind`，避免把不支持的通用订阅当普通 API 或误落入 ChatGPT
- `subscriptionSignInIssue(mode)`：通用登录入口拒绝未知模式，避免错误触发 Codex；Kiro/Antigravity/Cursor/Kimi 有各自保留的专用入口
- `existingSubscriptionKind()` / `prepareExistingSubscription()`：先校验并路由已登记、形状有效的专用 Kiro/Antigravity/Cursor/Kimi 配置，随后才应用普通来源保护；禁止一个来源同时声明多种专用鉴权。分发层把原始请求解码为中立 Conversation，各适配器直接构造厂商格式；Kimi 的 Chat 是其实际出站协议，其他厂商不经过 Chat 请求中转，登录和输出解析边界保持独立

普通 API 来源即使按月收费、名字叫 Cursor 或 Kiro，也不因为名称或 `billing: subscription` 被阻止。已有 ChatGPT / Codex / Copilot 路径保持原有语义；当前审查不为它们额外背书。

集成点应在创建来源、来源出站选择、登录分支和控制台能力说明。错误不能包含输入的路径、Key 或未知模式原文；拒绝前不能开始网络 I/O，也不能取消另一个正在进行的有效登录。

## 后续适配器验收要求

现有专用模型来源与仍有效的模型协议核查需要遵循以下边界；不包含官方agent任务接入。

1. 仅在厂商明确支持的模型来源合同下核实凭据、账号权限、协议与条款；SDK/CLI/ACP的agent能力不能替代模型协议证据，私有路径不能因假服务通过而称为厂商支持
2. 区分 agent 任务与模型请求，不静默压平工具历史或把工具结果伪装成普通文本
3. 禁止自动安装依赖、登录、创建持久凭据或开启额外收费；这些需要明确的用户操作或授权
4. mock 覆盖流终止、取消、超时、额度错误、无权限、工具授权、版本不兼容和重复提交
5. 获得明确许可后再验证真实官方客户端，核实原生配置前后不变；没有完成前不标“已实测”

Kiro/Antigravity/Cursor 及 Kimi 专用来源已接入；真实厂商/账号验收与适用条款仍未完成，Cursor 仍限纯文字，不能宣称工具/多模态完整。官方agent任务接入已取消，不能用它替代原始通用模型来源需求。


## 其余十家逐项结论

这里的“未核实”指当前官方公开资料未建立可供 EasySwitch 使用的接口，不是断言厂商永远不存在接口。“官方 agent”表示厂商自己的完整 agent，不能当作可任意替换 harness 的模型服务。

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
- Kimi 官方 Key 接入指南提示不要篡改 User-Agent 绕过工具识别。现有设备码实现携带 KimiCLI/X-Msh 头；其适用许可与真实验收单独待核实，不能由 API Key 支持范围推导
- MiniMax 旧套餐名仍保留预设 ID 兼容已存配置，但文案解释最新 M Plan 与专用 Subscription Key。生产/批量服务与个人交互式开发的许可、价格和额度不能混为一谈
- Grok 的共享用量新说明意味着不能写“SuperGrok 永不覆盖 API”；也不能从该事实推导未公开的 OAuth 接法已受支持
- 本项目不再规划上述厂商官方 agent SDK 的任务适配。已有 BYOK 启动器与此是两个方向，不改变其原生配置或登录

### 官方来源（2026-10-06 核对）

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


## 订阅来源的本地验证

`kiro.test.ts`、`antigravity.test.ts` 与 `fake-google.ts` 已审计：全部上游地址指向数字环回，Kiro 登录库在临时目录内由测试写入，Google access/refresh token 均为合成 fixture；不启动真实浏览器或 agent。网关请求改用当前进程签发的 fixtureToken，不通过测试助手“修复”伪造/失效令牌。假浏览器只请求环回 OAuth callback，使用 manual redirect，不能自动离开环回。

本地验证在隔离 HOME、内存凭据与网络守卫下运行。测试涵盖默认关闭、假登录/刷新、工具/消息/流、用量、401/403/429、截断、删除来源不修改原临时登录库。证据只属于假服务，不能写成真实 Google/Kiro 登录或模型验证。Kiro 测试同时覆盖 eventstream 帧编码。


## Cursor、Kimi 与用量验证

`cursor.test.ts` 与 `fake-cursor.ts` 使用临时环回 HTTP/1 + HTTP/2 假服务器，`kimi.test.ts` / `fake-kimi.ts` 使用合成设备码、JWT 和 refresh token，`plan-usage.test.ts` 注入内存 fetch，不联系真实用量端点。执行器 guard 同时限制 fetch 与 HTTP/2 connect 的目的地，禁止真实程序。

新增兼容层只接受 `{accountId,email?}` 的 Cursor/Kimi 元数据，拒绝混合鉴权和未知字段；使用对应厂商固定配置端点，忽略持久化 source URL、鉴权头/路径/query 的覆盖。Kimi 保留原模块创建的 allowlist 客户端头，明确 Bearer token 并禁止重定向。缺少原账号 token resolver 时失败，不回退到普通 API Key。Cursor 的文本化工具历史、遗漏媒体与不转发工具列表写进 dropped 信息。

以上回归检查默认关闭、模拟登录/刷新/删除、目的地固定、元数据验证、resolver 缺失与工具损失说明。结果只证明本地兼容集成，不证明私有接口得到官方支持，也不构成自动启动用户账号的许可。
