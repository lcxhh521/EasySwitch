# 官方 CLI 纯文字来源：Qoder / CodeBuddy / Droid

核验日期：2026-10-06。这里区分**适配器实现**、**假传输验证**和**真实服务验收**。本次没有安装或执行真实厂商 CLI，没有读取原生登录、创建令牌或调用模型。

## Qoder：适配器已实现，真实 CLI 未验收

`core/src/qoder-text-bridge.ts` 提供官方 headless CLI 的纯文字桥，运行时不增加 SDK 依赖。控制台的专用来源入口只接收用户明确提供的 CLI 绝对路径、模型 ID 和 PAT；创建时默认关闭，不自动探测程序、模型或账户。PAT 仍由已有 SecretStore 保存，不进入来源配置、命令参数、提示词或日志。需要实际使用时，由用户自行准备官方 CLI 和 PAT，再明确开启来源。

官方依据：

- [CLI reference](https://docs.qoder.com/cli/cli-reference)：`--config-dir`、`--cwd`、`--tools ""`（禁用全部内置工具）、`--strict-mcp-config`、`--no-session-persistence`、`--max-turns`、`--max-model-request-retries`、`--max-output-tokens`、`--settings`、`--setting-sources` 和 text 输入/输出模式
- [Run in scripts](https://docs.qoder.com/cli/run-in-scripts)：stdin 提示词、print 模式和 headless 权限行为
- [SDK authentication](https://docs.qoder.com/cli/sdk/authentication)：显式 `QODER_PERSONAL_ACCESS_TOKEN`；这不等于读取或导出原生登录

每次请求：

1. 校验来源配置和模型字符串；模型可用性由厂商决定，EasySwitch 不捏造已知模型目录
2. 建立私有临时 HOME、cwd、配置目录及空 hooks/MCP settings；不加载用户项目或原生配置
3. 用 `shell:false` 启动明确选择的程序；提示词经 stdin，PAT 只进入最小化子进程环境
4. 禁用内置工具和外部 MCP，关闭会话持久化；单轮、零模型自动重试，不使用 yolo/权限绕过参数
5. 缓冲文字结果；超时、取消或输出超限终止子进程，结束后删除本次拥有的临时目录

边界：这属于 CLI 配置隔离，不是操作系统级沙箱。来源管理员选择的可执行文件必须可信；配置校验只检查路径字符串，不代表程序签名、版本或身份已经核验。官方文档当前称可执行文件为 `qoder`，用户旧版本可能不同，不能据此声称任意 `qodercli` 版本兼容。

### 请求和响应的限制

- 只接受纯文字；工具定义、工具历史、图像、音频、原生/不透明推理状态在发送前拒绝。自动附带工具列表的编码 agent 不能据此当作完整模型来源
- CLI agent 自有系统行为；多角色历史序列化为文字 transcript，并报告 `roles:cli_text_transcript`，不冒充模型 API 的 system/developer 优先级
- 请求流式输出时，收到完整 CLI 结果后再转换，报告 `stream:buffered_cli_result`；不是逐 token 的真实上游流
- effort、采样及结构化输出参数不作虚假映射，记录被丢弃的能力；Qoder 的正整数 token 输出限制只映射到有文档的对应参数
- text 输出未提供可信 token usage，所以不生成虚假用量或账单；用户仍需查厂商余额和计费
- 错误消息不回传 CLI stderr 或厂商异常详情，防止提示词/PAT 泄漏；没有自动登录或刷新账户流程

## CodeBuddy：独立文字来源已实现，真实 CLI 未验收

`core/src/codebuddy-text-bridge.ts` 使用官方 CodeBuddy Code，而不是 WorkBuddy 私有接口。现有 `launchers-extra.ts` 的 CodeBuddy 启动器是把外部模型接入 CodeBuddy，不能拿它的 EasySwitch `BASE_URL`/会话令牌反向当模型来源。两种方向只复用通用基础设施：文字请求守卫，以及 `cli-text-process.ts` 的受限子进程逻辑；Qoder 的既有导出和行为保持兼容。

官方依据：

- [CLI reference](https://www.codebuddy.ai/docs/cli/cli-reference)和[headless mode](https://www.codebuddy.ai/docs/cli/headless)：print、stdin、text 输出、`--tools ""`、strict MCP、无会话持久化及单轮限制
- [IAM](https://www.codebuddy.cn/docs/cli/iam)：API Key 必须匹配区域；国际版不设置 `CODEBUDDY_INTERNET_ENVIRONMENT`，国内版明确设 `internal`
- [环境变量](https://www.codebuddy.ai/docs/cli/env-vars)：私有 `CODEBUDDY_CONFIG_DIR`、API Key、最大重试数、关闭更新/记忆/内置市场/环境快照等开关
- [Settings](https://www.codebuddy.ai/docs/cli/settings)：`disableAllHooks:true`；[IAM 权限模式](https://www.codebuddy.ai/docs/cli/iam)的 `dontAsk` 拒绝未经允许的动作

配置要求明确提供 `edition: international | china`，不从 Key 格式或本机登录猜区域。iOA、专享和私有部署缺少本切片的专用支持，配置阶段拒绝。与 Qoder 一样，来源创建默认关闭，创建/开启不执行程序；明确的请求才会调用选择的可信可执行文件。

每个请求创建临时 HOME/cwd/CodeBuddy 配置，加载自己的 user settings，禁用所有 hooks；内置工具为空，MCP 只接收显式空配置。提示词走 stdin，Key 仅注入 `CODEBUDDY_API_KEY`；不继承 `CODEBUDDY_AUTH_TOKEN`、`CODEBUDDY_BASE_URL`、自定义头、插件目录、shell 环境脚本、重放文件或其他进程凭据。不使用权限绕过、自动登录或自动安装。重试数设为零，禁用无限重试、自动更新、自动记忆和内置市场加载；超时/取消/输出上限由共享 runner 处理。

同样存在前述纯文字、角色 transcript、缓冲流式和无可信用量限制。`CODEBUDDY_CODE_MAX_OUTPUT_TOKENS` 的官方说明仅覆盖大多数请求，故映射为提示并报告 `max_tokens:codebuddy_cli_hint`，不把它或本地输出字节上限当作厂商账单硬上限。

## Droid：只有可注入控制器，生产保持 501

`core/src/droid-text-bridge.ts` 是可用 fake transport 验证的控制器，不包含已验收的生产 CLI/SDK transport。生产路径和来源创建入口应明确返回 501；不得用环境变量、空工具数组或实验开关绕过。

官方依据：

- [Droid exec](https://docs.factory.com/droid-exec/overview)：headless、输出模式、显式 Factory API Key、工具限制参数和 JSON-RPC 入口
- [TypeScript SDK](https://docs.factory.com/sdk/typescript)：`listTools`、`disabledToolIds`、`updateSettings`、关闭自主执行和权限自动拒绝的会话配置

已实现的顺序：注入可信 transport → 验证其隔离 HOME/cwd、无环境 MCP/hooks、临时会话、拒绝权限等宿主保证 → 创建会话 → 枚举真实工具 ID → 禁用所有已发现工具 → 再次枚举确认全部禁用 → 才发送文字 → 检查成功终止事件 → 关闭会话。若工具状态缺失、仍启用，或者出现工具/hook 事件，立即拒绝。保证字段是 EasySwitch 自己的 transport 合同，不是捏造的 Droid 命令行开关或网络字段。

尚缺的确切条件：验证一个零运行时依赖的官方 transport，能够完成上述宿主隔离并处理权限回调、工具枚举和会话销毁。官方 exec 默认只读仍可能读文件和环境，不能视为纯文字。当前没有以官方证据确认空 `--restrict-tools` 等于禁用全部工具，也没有确认与 Qoder 相同的 strict MCP/无持久化开关。因此不猜参数，不把 fake controller 报为已接通的 Droid 来源。

## 其他剩余来源的结论

| 条目 | 可行路线与当前缺口 |
| --- | --- |
| B68 Grok | [官方 headless 文档](https://docs.x.ai/build/cli/headless-scripting)和[CLI reference](https://docs.x.ai/build/cli/reference)提供 agent CLI 路线，但不证明 `cli-chat-proxy` 的私有身份字段或本机登录导出获得支持。当前没有读取真实原生凭据的授权；不能借实现源码进行读取或仿客户端调用。已有 xAI API Key 来源与订阅来源分开 |
| B70 CodeBuddy | 官方文字桥已有实现与 fake 验证，真实 CLI、版本和区域账户尚未验收；不能沿用旧 reference 页面互相冲突的示例或认定任意区域账户兼容 |
| B70 WorkBuddy | [国内定价说明](https://www.codebuddy.cn/docs/ide/Account/pricing)称 CodeBuddy 与 WorkBuddy 同一账号积分共享，所以官方 CodeBuddy 路线可能覆盖该账号的共同权益，仍需实际套餐确认；这不证明原生登录和私有 `/v2/chat/completions` 作为第三方来源获支持。不实施身份仿冒或绕过系统提示限制 |
| B71 Cursor | [官方 TypeScript SDK](https://cursor.com/docs/sdk/typescript)支持 customTools；[官方 SDK bridge](https://prod.cursor.com/docs/sdk/bridge)和[公开协议](https://github.com/cursor/sdk-bridge/blob/main/docs/protocol.md)属于 `sdk.v1` 的独立 agent 会话接口，不是现有私有 `agent.v1` exec 字段的证据。使用官方路线须明确 API Key、会话/工具回调语义与零运行时依赖取舍；不能悄悄加 SDK、复用原生 OAuth，或捏造原始 exec 消息字段 |

本切片没有确认上述服务的全部条款或第三方订阅转用许可；公开 CLI/SDK 文档支持某功能，不等于服务条款或真实账户兼容已通过验收。

## 本地可重复验证

`qoder-text-bridge.test.ts` 用注入 executor 和内存 EventEmitter/PassThrough 模拟子进程，覆盖私有配置、参数、PAT 处理、四协议文字输入、能力拒绝、失败、取消、超时、输出限制和清理。`codebuddy-text-bridge.test.ts` 额外覆盖显式区域、网关/原生环境不继承、hooks/记忆禁用和 token 提示的能力标注。`droid-text-bridge.test.ts` 只注入内存会话，验证生产 501、先禁用后提示、权限合同、错误/中断终止。

测试必须使用新建 HOME、`EASYSWITCH_SECRETS=memory` 和 `core/test/local-only-guard.ts`；不使用会运行真实 agent 的原始全量测试入口。守卫禁止公网请求和真实子进程。相关测试加入审计白名单后才由 `npm run test:local` 执行。

## 已接入的来源流程

- 控制台来源页可显式创建 Qoder/CodeBuddy 文字来源：用户填写已安装 CLI 的绝对路径、已确认可用的模型 ID 和 PAT/API Key；CodeBuddy 另需明确区域，并确认实验限制。创建只验证/保存配置，默认关闭，不探测、不读程序、不运行 CLI。
- 来源行有独立开关；开启本身不发请求。四种已鉴权入口的纯文字请求会使用同一适配器；工具/媒体/不透明历史在读取 Key 或执行程序前拒绝。
- `cli://qoder` / `cli://codebuddy` 是本地来源类型标识，不是虚构的 HTTP API。协议设置和普通 API 探测不可用于这类来源。
- Droid 的状态、创建和来源调用均保持明确501，假传输仅用于模块测试，不存在 HTTP 参数解锁生产传输的开关。
- 所有集成回归注入内存执行器；没有运行真实 Qoder、CodeBuddy 或 Droid。真实 CLI 隔离、条款/平台行为和账号验收仍需独立确认。

官方自动化入口不等于订阅转售或账号共享许可。发布/真实使用前须核对 [Qoder Terms](https://qoder.com/product-service)、[CodeBuddy 国际版协议](https://www.codebuddy.ai/document/term)、[CodeBuddy 国内站协议](https://www.codebuddy.cn/document/term)与 [Factory Terms](https://factory.com/legal/terms) 的适用范围；本次没有接受新协议或执行真实账号操作。
