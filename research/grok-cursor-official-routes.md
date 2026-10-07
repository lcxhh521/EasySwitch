# Grok 订阅与 Cursor 工具：可落地的官方路线

核查：2026-10-07。范围为 B68、B71 的完整实施方案，依据公开的一手文档和当前仓库引用关系。没有读取真实登录文件、运行 CLI/SDK、创建 Key、调用模型或上传代码。本文件是设计与证据，不代表官方运行时已经接通。

## 建议先做什么

推荐增加独立的「官方 agent 任务」入口：Grok 先接 ACP，Cursor 先接 ACP；需要程序自定义工具时再接 Cursor 官方 SDK Bridge。核心继续零 npm 运行时依赖；CLI/Bridge 是用户明确选择的可选外部程序，不能静默安装或捆绑。

它解决的是「让官方 agent 带工具完成一个任务」。它不等于把原有 Cursor 私有订阅线路升级成通用 Chat `tool_calls`，也不等于原 B68 的原生 token 文件转发。若用户必须保持后两种产品语义，见下方单独方案与条件，不能偷偷换实现后把原待办勾完。

通用网关里需要 Grok 模型和函数调用时，优先使用已有 xAI API 来源。这个路线有正式模型接口；认证与计费需要按 API 来源确认，不能拿 Grok 登录凭据替代 API Key。

## 已核实的官方合同

| 事实 | 证据 | 对实现的影响 |
| --- | --- | --- |
| Grok 支持无界面模式、JSON 行流和 ACP；ACP 命令为 `grok agent stdio` | [Headless / Scripting](https://docs.x.ai/build/cli/headless-scripting) | 可以写独立 JSON-RPC 客户端，不必仿造私有代理请求 |
| Grok ACP 通过初始化公布认证方式；官方示例选择 `xai.api_key` 或 `cached_token` | 同上 | 只能选择本次握手实际公布的方式，登录与刷新交给官方客户端 |
| `GROK_HOME` 包含配置、认证、会话、插件和日志；有关闭自动更新及兼容扫描的设置 | [设置参考](https://docs.x.ai/build/settings/reference) | 使用私有目录；不能声称在原 HOME 运行时原文件绝不改变 |
| SuperGrok 官方 FAQ 把 Build 列入共享周额度体系 | [订阅 FAQ](https://docs.x.ai/grok/faq#how-do-supergroks-weekly-usage-limits-work) | 支持官方 Build 使用套餐的产品依据，不授权第三方冒充 Build 的私有 token/代理线路 |
| xAI API 的函数调用由调用方执行；内置搜索等工具由 xAI 执行 | [函数调用](https://docs.x.ai/developers/tools/function-calling)、[工具概览](https://docs.x.ai/developers/tools/overview) | 网关只转工具定义/调用/结果，不能自行执行任意本地函数 |
| API 消费有 API Console 余额与计费体系 | [API 计费](https://docs.x.ai/console/billing) | 不假设已有 Grok 登录自动提供同样 Key、计费或免费额度；账户实际抵扣另行确认 |
| Cursor 官方 ACP 使用 `agent acp`，stdio JSON-RPC 行帧；有 permission、cancel 和 Cursor 扩展交互 | [Cursor ACP](https://cursor.com/docs/cli/acp) | 可以使用公开会话协议；不能忽略会阻塞 agent 的提问/计划审批 |
| Cursor SDK 是 agent SDK，不是独立模型推理/Chat API；用户 Key 计入用户方案，服务账号 Key 计入所属团队 | [SDK 认证、计费与概念](https://cursor.com/docs/sdk/typescript) | 官方计费接入有依据，但产品应显示 agent 任务；不得把套餐说成不限量 |
| SDK 有自定义工具、运行取消、用量与可选成本查询；成本查询可能尚未对某账号开放 | 同上 | 未报告费用保持未知；只凭 token 数不能宣称已知账单 |
| Cursor 支持公开 `sdk.v1` Bridge，可用 HTTP/1.1 Connect 和 JSON POST；它包含官方 SDK | [SDK Bridge](https://cursor.com/docs/sdk/bridge) | 可避免核心 npm 依赖，但仍新增可选厂商二进制和版本管理责任 |

本次未找到官方支持的 `cli-chat-proxy` 原生凭据转发合同，也未找到旧 Cursor `agent.v1` 私有 `exec` 全族的官方公开字段合同。“没有找到”不等于接口不存在；它意味着本轮不能编造字段、复用身份冒称官方兼容。

## 路线比较

| 路线 | 提供的能力 | 工具执行者 | 主要代价/缺口 | 建议 |
| --- | --- | --- | --- | --- |
| Grok 官方 API 来源 | 通用模型请求、函数调用 | 外部调用方；服务端内置工具由 xAI | 需明确 API 凭据/计费，不能保证消耗原订阅 | 通用网关首选，沿用现有协议层 |
| Grok 官方 ACP | 有状态的 Build 任务 | 官方 CLI；明确宣告的客户端能力可由宿主实现 | 需要真实版本、私有目录认证、权限与隔离验收 | B68 推荐替代，先做纯状态机 |
| 原 B68 私有代理转发 | 想把原订阅当模型来源 | 调用方或私有服务，取决于未知协议 | token 文件读取授权、身份约定、条款与真实验收均不足 | 保留未实现，不能偷偷启用 |
| Cursor 官方 ACP | 有状态的 Cursor 任务和工具进度 | Cursor CLI；EasySwitch 负责权限回答和生命周期 | 无通用函数调用网关合同；项目配置可能自动加载 | 低依赖的第一阶段 |
| Cursor 官方 SDK | 程序化 agent 和自定义工具 | 本地 SDK 或显式宿主回调 | 带 npm/平台二进制依赖；默认工具自动执行 | 若允许可选运行时，可做专用任务执行器 |
| Cursor 官方 SDK Bridge | 同一 agent 能力，独立进程边界 | Bridge 内的 SDK；回调服务执行自定义工具 | 二进制固定版本、回调鉴权、进程退出和账单能力验收 | 自定义工具第二阶段推荐 |
| 旧 Cursor 私有 `exec` → Chat | 与旧订阅源保持相同认证/接口的网关工具循环 | 需把私有操作准确交还外部 caller | 无官方字段合同，复杂状态与权限无法靠字段猜测修补 | 不按“只是补 protobuf”推进 |
| Cursor agent 包装成新网关来源 | 把调用方函数注册为 custom tools，跨请求等待结果 | 外部 caller，Bridge 只等待回调 | 新来源类型、会话映射、等待/重试/取消和费用语义都需产品确认 | 可设计，不能宣称兼容旧 B71 |

## 为什么不能把 `exec` 直接改名成 `tool_calls`

普通函数调用的定义由调用方提供；模型返回名称、参数、调用 ID，调用方执行后带回同一 ID。Cursor agent 的读文件、编辑、Shell、MCP 等是 agent 运行环境的操作。名字相似不保证参数、权限、结果或错误一致。

若将 Cursor SDK 自定义工具包装为一个新网关来源，需要单独实现：

- 每个本地网关会话绑定唯一 Cursor agent/run，不按相似历史或模型名猜会话；隔离两个客户端的 callback。
- 用户提供的函数名和 schema 只进入明确的 custom tool allowlist；不因此开放 Cursor 自带 Shell、写文件、Task 或其他 MCP。
- 收到回调时发给原 caller 一个工具调用；原 SDK run 仍等待。后续工具结果必须绑定正确会话、run、call ID，限制大小、重复结果和过期结果。
- 中断、并行工具、重试和进程重启均不能导致工具执行两次。重启后旧等待必须终止，不能靠旧历史重新执行副作用。
- 有界等待到期就取消 run、结束 callback、撤销专属能力；不能把一个 HTTP 请求完成误认成厂商 run 已完成。
- 工具结果中的文本是数据；外部调用方的权限决定不能通过“允许全部工具”或 SDK 提示词代替。

这是新的会话式网关产品，不是对原 `cursor/messages.ts` 的小修。当前 `core/src/cursor/` 保持私有文字适配器；官方任务入口与它分开标识、认证与验收。

## 权限和运行环境设计

以下是本项目的建议约束，并非声称厂商默认已经提供全部保证。

1. 默认不开启执行。只从用户点击的任务动作进入；后台健康检查、来源扫描、首次打开页面均不启动 Grok/Cursor。
2. 私有 HOME/cwd/运行目录；显式传入必要环境，不继承所有 API Key、代理、MCP、插件与 hooks。Grok 使用官方 `GROK_HOME`，关闭更新与兼容扫描。Cursor 的 SDK 路线只加载明确配置来源；ACP 路线须额外核实私有 HOME 与项目配置隔离。
3. 初始客户端不宣告文件写入或终端执行能力，未知 RPC 返回受控不支持，权限请求默认拒绝；选项使用请求实际给出的 ID，不能自己编造 allow 字段。注意：不宣告客户端 fs/terminal 只能约束客户端回调，不能证明 CLI 内置工具无文件权限。
4. 真正的只读任务必须有操作系统或隔离工作区的保证，不能只设置 ask/plan 或发送“不要写文件”的提示。开启写/执行是下一阶段的显式选项，审批应说明动作与路径。
5. Grok 默认 sandbox 关闭；官方 read-only 可读取广泛路径，macOS 的子进程网络限制有平台差异。SDK sandbox 也不是“只能读取工作目录”的保证。必须验证敏感路径拒绝和所有子进程边界。[Grok sandbox](https://docs.x.ai/build/features/sandbox)、[Grok permissions](https://docs.x.ai/build/features/permissions)、[Cursor sandbox](https://cursor.com/docs/sdk/typescript#sandbox-options)
6. Cursor custom tools 的 annotations 是描述，不是强制权限。它们在宿主进程里运行，不能暴露一个不受限的“执行命令”函数。使用固定实现的少量只读工具，或独立受限回调服务；回调需绑定单次 run 的本地能力。SDK 默认自动执行与 auto-review 不足以替代这个边界。[Custom tools](https://cursor.com/docs/sdk/typescript#custom-tools)
7. 用户在独立官方客户端中完成登录，或明确提供用于该官方路线的 Key；不复制原生 auth/token 文件，不自动刷新外部文件里的令牌。新凭据保存/长期登录仍需用户操作和授权。使用官方客户端自身登录也会写它的私有目录，不能承诺零写入。

## 预算、用量与取消

复用现有 TaskBook、TaskAccounting、TaskRuntime、深度/并发额度，不能再造一套任务计数。官方会话 ID 仅是外部关联字段，本地任务 ID 和授权 token 是所有权依据。

启动前检查本地全局/来源预算和账户选择；记录 provider/runtime 的实际计费依据。SDK/CLI 内部多轮模型请求通常不经过 EasySwitch 模型网关，因此单次启动前检查不能伪称逐次请求硬预算。若没有可验证的每次模型调用前限额钩子，硬停止预算模式应拒绝此生产能力；若产品允许“任务级软限额”，必须明确显示可能超额并单独确认，不能静默降级。

用量有累计与分项区别：只按明确的运行/步骤 ID 去重，不把每个累计事件重复累加。缺账单、取消时缺尾包、内部重试或未报告工具费用都保持未知。订阅使用不等于零成本；Cursor 的已包含用量可能显示零附加收费，但不能据此声称消耗为零。

ACP 取消发送 `session/cancel` 通知；等待中的 permission 请求要回答 cancelled。取消后可能继续收到最后的工具状态，直到原 `session/prompt` 返回 cancelled；不能发出通知就报告进程已清理。[ACP prompt turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)、[tool permissions](https://agentclientprotocol.com/protocol/v1/tool-calls)

之后仍须等待自己启动的进程/Bridge 关闭以及回调结束，复用 B98 的 cleanupPending/cleanupFailed。卡住时只结束自有进程组，撤销自有能力；不按程序名查杀，不碰原生会话。SDK 的 `run.cancel()` 与最终 `wait()`/dispose 应分别验证。

## 现在能做的最小源码切片

以下为待接线负责人确认的实施边界，不是已经实现的功能。无需真实账号即可完成 A、B 的源码和 fake 验证；不应把纯模块测试标为真实兼容。

| 阶段 | 文件/交付 | 完成条件 | 生产状态 |
| --- | --- | --- | --- |
| A：ACP 控制核心 | 新 `core/src/acp-session.ts` 与纯测试；只做行帧、请求关联、协商、会话、permission/cancel 状态 | 分片/粘包、重复/未知 ID、越界帧、权限默认拒绝、取消后迟到响应、缺终止失败，均用内存传输 | 无默认 spawn/auth/网络；未接运行时 |
| B：任务生命周期接线 | 专用官方 agent 类型接既有 TaskRuntime；共享 API/UI 由集成负责人实现 | fake 控制器走真实 loopback API，展示运行/工具进度/取消/未知费用；老来源不改变 | 能力清楚标“控制器完成、真实程序未验收” |
| C：可选运行时 | 校验官方安装路径和固定版本，私有工作区/环境、已授权认证注入、权限 UI | 客户端发现本身无登录/模型调用；实际启动需要用户确认与 Mac 验收 | 验收前默认关闭，不自动探测 |
| D：Cursor custom tool | 优先官方 Bridge `sdk.v1` 的有限 JSON RPC/回调合同，固定版本 | 两种认证严格分开、callback只可数字环回且有单次能力、错误净化、重放/取消测试 | 独立官方任务来源，不伪称旧 `agent.v1` 工具支持 |
| E：新网关产品（可选） | 会话映射、tool ID/结果回送、并发与恢复策略 | 用户同意新来源语义和运行时依赖后，先fake跨请求完整闭环，再真实验收 | 未决，不进入本轮默认实现 |

A 的建议初始化只声明实际实现的能力。缺失能力即不支持；不要照抄官方演示中开启文件写入、终端等能力。[ACP initialization](https://agentclientprotocol.com/protocol/v1/initialization)

A/B 中不同厂商只提供已证实的命令名称、advertised auth 选择和扩展事件表；不读取自己的猜测配置、不自动接入已有账号。`cursor/ask_question`、`cursor/create_plan` 等阻塞扩展必须明确拒绝或返回取消，不能忽略造成悬挂。

## 需要用户决定的具体事项

- 是否接受 B68/B71 的第一阶段以「官方 agent 任务」交付，而原有“订阅转通用模型源/旧 exec 映射”继续单列未完成。推荐接受，因为这保留官方会话和工具语义。
- 是否允许显式可选的厂商 CLI/Bridge 运行时。推荐核心保持零 npm 依赖、运行时由用户选择；不默认打包或静默下载。
- 真实试用选择 API Key 还是独立官方登录目录、使用哪个项目/账号、可传给模型的代码范围，以及测试费用上限。当前没有这些真实调用授权。
- 若无法逐次拦截厂商内部模型请求，是否接受任务级软预算。默认不接受自动降级；硬预算开着时保持不可启动。
- 首次工具能力是否仅限读文件/搜索。推荐先只读；写文件/Shell 后续需要清楚的工作区权限与取消验收。

## Mac 与账户验收清单

用户自行完成对应运行时的安装/登录后，记录版本与方案归属。先在人工创建的无秘密测试目录验证：无自动更新/附带 MCP 启动；请求不会读取原生账户目录；拒绝操作确实未执行；跨目录、symlink、子进程和网络规则生效；取消后进程、回调、令牌均清理且费用未知不归零。

随后只在用户指定的小样本项目与费用限额内验证一次只读任务、一次被拒绝写操作、一次中途取消，并与官方控制台用量核对。任何额外权限、条款、费用或账户范围变化须重新确认。真实结果单独记录，不能用本次官方文档或 fake 成功替代。

## 当前结论

不是“没有办法”：两家都有可用的官方 agent 接入方向，Cursor 还有公开 Bridge/自定义工具合同。真正待确认的是产品是否接受这些会话语义、可选运行时以及预算保证的边界。可以先完成可审查的控制器和假执行闭环；原生凭据转发、私有 exec 字段和真实账户验收仍不能假完成。
