# B49 / B81：真实只读 Agent 的可实施路线

调研日期：2026-10-07。仓库核对基线：`69ecd10`。本文是实现方案和验收门槛，不是已完成的隔离证明。本轮只读源码、公开官方资料和命令路径元数据；没有启动厂商 CLI、SDK 会话、模型、隔离器或容器，也没有读取原生账号、改变系统安全设置。

## 1. 建议与当前缺口

建议把真正的首批执行资格限定为 **Claude Agent SDK + CodeBuddy CLI**，共同使用“过滤后的独立快照、受限工具代理、覆盖整个客户端进程的系统隔离、任务专用模型代理”。先实现通用快照/代理/策略编译器及负向 fixture；在对应平台通过隔离验收、客户端固定版本通过假上游验收之前，生产注册表继续关闭。

这条路线运行的是两个真实厂商的 Agent 实现，不是把两次模型 HTTP 请求改名成两个 Agent。SDK 自建 Agent 可以作为另一个明确命名的产品能力，但不能冒充 Claude Code、CodeBuddy 或 Codex 已通过验收。

最短交付分两级：

1. **固定材料审查**：用户选择文件形成快照，宿主把有限文字交给客户端；客户端没有工具，也没有仓库挂载。这是最小的真实厂商 Agent 路线，适合解释、方案、审查少量文件。
2. **可检索快照审查**：只开放 `list_files`、`read_file`、`search_text` 三个自建工具；工具代理读不可变快照，客户端仍不获得原仓库路径。适合较大代码库。

两级都必须隔离客户端自身的启动、插件、原生文件读取和网络行为。只禁模型工具不能覆盖客户端实现本身。

当前实现的准确范围：

- `parallel-tasks.ts` 的执行注册表只接受测试进程创建的 loopback relay；真实注册表为空。它已提供编排、共享并发名额、独立任务与费用，但不是生产只读执行器。
- `qoder-text-bridge.ts` / `codebuddy-text-bridge.ts` 使用私有 HOME/cwd、空工具和独立配置。它们没有系统文件访问边界，且 PAT/API Key 仍进入客户端环境；不能自动升级为安全代码审查器。
- `cli-text-process.ts` 的超时、输出上限、并发与进程清理解决的是资源管理。`runHeadless` 的进程组也不是文件、网络或内核隔离；能自行创建新会话的程序可能离开原进程组。
- 历史 `agent-facts-3.md` 写过 CodeBuddy 没有已知 base URL。该结论已过时；当前启动器和官方环境变量文档已支持自定义来源。此处区分“CodeBuddy 作为 Agent 使用 EasySwitch 模型”和“CodeBuddy 作为订阅文字来源”。

## 2. “只读”必须逐项说明

| 边界 | 首批承诺 | 不应混同的能力 |
| --- | --- | --- |
| 读取仓库 | 只读用户明确选入快照的文件；工具返回文件 ID 和行号 | 整个 HOME、原仓库的任意路径、Git 凭据、其他工程 |
| 修改仓库 | 原仓库根本不交给客户端；快照也不可写 | 复制到普通目录、`chmod 444`、只读提示词均不是进程隔离 |
| 执行命令 | 模型没有 Shell、Bash、代码解释器、任意工具注册入口 | 客户端自己的已固定程序仍会执行；不能声称进程完全不执行代码 |
| 临时写入 | 仅本次运行的 HOME/cache/tmp 可写，限额并清理 | 禁止一切写入会让许多真实客户端无法启动；这是“仓库只读”，不是零磁盘写入 |
| 网络 | 仅任务专用代理；允许所选模型推理所需请求 | 推理是出站 POST，会上传已选材料并可能计费；不能称为“零网络写” |
| 外部副作用 | 禁止任意 URL、Shell 网络工具、WebFetch、第三方 MCP、上传/发布/Git push 等 | 域名白名单仍可能允许向同一服务写入或上传，因此不能代替路径/方法/请求体策略 |
| 凭据 | 上游 Key 留在宿主代理；客户端只持单任务、短期、可撤销的本地能力 | 私有 HOME 不阻止读取继承环境；SDK 内无工具也不意味着客户端看不到其环境里的 Key |
| 子任务与退出 | 只由宿主编排；取消整个任务树，先撤销能力，再等待隔离实例结束 | MCP `readOnlyHint`、客户端自己标记的 readonly、退出一个父 PID 都不是证明 |

过滤不能证明所有源代码都不含秘密。默认排除凭据候选、配置和隐藏目录；提交快照前显示文件清单、总字节数与接收材料的模型来源。仅把用户选入的内容发送给已批准的来源。发现疑似秘密时不自动扩大共享范围。

## 3. 官方能力与候选名单

以下是文档事实，不能代替特定版本实测。启用前必须固定客户端版本和包哈希，并确认该版本的实际参数/SDK 类型。

| Agent / 入口 | 已有官方依据 | 首批资格与剩余条件 |
| --- | --- | --- |
| Claude Agent SDK | `tools: []` 移除内置工具；自定义 MCP 可独立注册。`allowedTools` 是批准规则，不是工具全集限制；`dontAsk` 也会放行无需批准的工具 | **首批候选**：固定材料模式先用零工具；检索模式仅接三个受控工具。仍需全进程隔离与假上游真实客户端验收 |
| CodeBuddy CLI | 当前 CLI 文档支持 `--tools ""`、`--strict-mcp-config`、`dontAsk`；settings 支持 `disableAllHooks` | **首批候选**：从现有启动器衍生专用执行器，不复用裸 headless 路径作为隔离证明。自定义 base URL 指向任务代理 |
| CodeBuddy SDK | 有 `canUseTool`、`disallowedTools`、MCP 和 settingSources；公开 SDK/CLI 对 allowedTools 的描述不一致，当前 SDK Options 未明确列出顶层 tools | **暂不注册**：先核对固定 SDK 包类型与真实可用工具集合，不能猜与 CLI 完全相同 |
| Qoder CLI / SDK | CLI `--tools` 限制内置工具，SDK 也有 `tools`、`strictMcpConfig`、`plugins: []`、`skills: []`、`settingSources: []`；MCP 需要另外收紧 | **下一批候选**：工具层可做，但 PAT 认证/模型流量的精确代理合同与启动隔离仍缺。发布记录说明插件 hooks 可绕过 setting-sources 过滤 |
| Codex / ChatGPT | 本路线不依赖它们的账户、额度、原生登录或 CLI | **本批排除**：不以更换目录、SDK 名称或代理方式绕过账号使用边界 |
| Gemini、Qwen、dsh、OpenCode、OMP 等 | 当前仓库有启动配置，不等于完整只读保证 | **暂不注册**：逐个固定版本、启动扩展面、模型端点和负向验收；不能凭“支持 MCP”统一放开 |

Claude 的三个容易误判点：

- 用 `tools: []` 限制内置工具；只设置 `allowedTools: ["Read"]` 不够。若需要拦截每次工具调用，应使用 `PreToolUse` 等真正每次运行的检查，不能假设 `canUseTool` 总会被调用。
- 显式 `settingSources: []`；官方当前默认会加载 CLI 的配置来源。空数组也不覆盖 global config、managed policy、auto memory 和云端连接器的全部入口。使用新 HOME/配置目录、禁自动记忆、严格 MCP，并通过隔离阻断宿主文件访问；不能修改或删除宿主管理策略来让检查通过。
- 自建 MCP 的 `readOnlyHint` 只是元数据。只读性质由工具处理器实际可执行的操作保证。

来源：[Claude 自定义工具](https://code.claude.com/docs/en/agent-sdk/custom-tools)、[权限顺序](https://code.claude.com/docs/en/agent-sdk/permissions)、[配置来源与例外](https://code.claude.com/docs/en/agent-sdk/claude-code-features)、[CodeBuddy CLI](https://www.codebuddy.ai/docs/cli/cli-reference)、[CodeBuddy settings](https://www.codebuddy.ai/docs/cli/settings)、[CodeBuddy SDK](https://www.codebuddy.ai/docs/cli/sdk)、[SDK 类型](https://www.codebuddy.ai/docs/cli/sdk-typescript)、[环境变量](https://www.codebuddy.ai/docs/cli/env-vars)、[Qoder CLI](https://docs.qoder.com/cli/cli-reference)、[Qoder SDK 类型](https://docs.qoder.com/cli/sdk/references-typescript)、[Qoder hooks](https://docs.qoder.com/cli/hooks)、[Qoder 发布记录](https://docs.qoder.com/release-notes/qoder-cli)。

## 4. 四种路线的取舍

| 路线 | 能建立的边界 | 单独采用的缺口 | 决定 |
| --- | --- | --- | --- |
| SDK 只注册受限工具 | 模型请求只进入自有处理器；易限制参数、次数、字节 | SDK/客户端仍是有宿主权限的程序；启动代码、环境和自身网络另算 | 作为工具层，优先用于 Claude SDK |
| 独立快照 + 文件系统隔离 | 原仓库不暴露；快照只读；宿主私密路径不可见 | 快照本身不限制网络；系统隔离仍需完整策略 | 所有真实执行器的基础 |
| 云端容器 / VM | mount、PID、网络与资源限制可统一验收；VM 另隔离内核 | 安装/管理成本、镜像供应链、代码上传和平台权限；容器共享内核 | 已有可信运行环境时采用；不以 privileged 容器临时绕过限制 |
| 受控只读工具代理 | 客户端不接触文件路径与 Key；只得到快照片段和模型响应 | 若进程能绕过代理访问宿主/公网，代理没有强制力 | 与全进程隔离一起用，不能单独宣称安全 |

### 推荐的最小平台实现

**首选轻量路线**：官方 `@anthropic-ai/sandbox-runtime` 的固定版本包装整个客户端，而不是只包装 Bash 工具。它支持 Linux bubblewrap、macOS sandbox-exec；不要求先部署 Docker。EasySwitch 新增自己的固定策略编译器，不能直接接受模型或项目提供的隔离配置。

策略设计要求：默认拒绝宿主数据读取，只允许固定 runtime、自己的空 HOME/tmp，以及有需要时的快照；快照不写。仅放行精确的任务代理地址和端口；代理外的直接 TCP、UDP、DNS、Unix socket、Apple Events 和其他程序启动通道均要由平台测试证实被阻断。禁用弱化隔离和自动回退。代理进程本身也不继承任意 HTTP_PROXY、NODE_OPTIONS、启动钩子或用户可改可执行目录。

SRT 不能按“有 allowRead 就已经只读”使用：官方说明读取默认允许，需要 deny-then-allow；Linux 某些 glob 在启动时展开，Unix socket 路径白名单与 macOS 行为不同，降级警告也不能作为通过。固定策略必须把这些限制转成拒绝启动条件。不要照抄示例中的 Docker socket 放行项。来源：[SRT 官方 README](https://github.com/anthropics/sandbox-runtime)、[配置定义](https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/sandbox-config.ts)。

**强隔离替代路线**：已有可信 Docker/rootless 或独立 VM 时，把固定客户端镜像、只读快照、空 HOME/tmp 交给独立实例。容器使用非 root、只读根、明确只读 bind、无外网、最小 capabilities、no-new-privileges、seccomp、PID/内存/CPU 限额。唯一跨边界通道是任务专用代理 socket/受控 IPC；不挂载 Docker socket、SSH agent 或宿主 HOME。容器镜像按 digest 固定，不使用 latest。实例所有权来自创建 API 返回的句柄/ID，不能按名字或端口猜测。

Docker 的 `--read-only` 不会自动让所有可写卷只读；只读 bind 还要处理子挂载的递归语义。`--network none` 仍有隔离的 loopback，模型通信需单独代理通道。Bubblewrap 是策略构建工具，本身不是预配置的完整安全沙箱。来源：[Docker 运行参数](https://docs.docker.com/reference/cli/docker/container/run/)、[bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)、[none network](https://docs.docker.com/engine/network/drivers/none/)、[rootless](https://docs.docker.com/engine/security/rootless/)、[seccomp](https://docs.docker.com/engine/security/seccomp/)、[Bubblewrap 官方说明](https://github.com/containers/bubblewrap)。

Anthropic 官方部署指南也区分权限规则、文件系统、网络和凭据，并给出隔离环境外的凭据代理方案。本文采用这种分层结构，但具体路径和平台策略仍需独立验收；没有把官方示例当成 EasySwitch 已部署的能力。[官方安全部署指南](https://code.claude.com/docs/en/agent-sdk/secure-deployment)

SRT/SDK 会增加可选执行组件及其依赖；不能悄悄破坏当前 core 零运行时依赖约定。建议独立、固定版本的 worker bundle，附许可证和完整依赖清单；核心只保留小型协议和策略编译器。若供应链或平台前置条件不满足，保留文字任务/模拟展示，真实只读入口明确不可用。

## 5. 可直接拆分实施的模块合同

以下文件名和 API 是拟议合同，本轮未创建这些源码，也未放开生产注册表。

### A. 快照构建器：`readonly-snapshot.ts`

`prepareSnapshot(selection, fileReader) -> SnapshotHandle`，只接宿主已批准的文件选择，不接受模型给定的绝对路径。第一版可直接接文件字节与逻辑相对路径，避免把活的宿主目录暴露给 worker。

- 文件按 `fileId + 相对显示路径 + SHA-256 + 字节数` 建清单；限制文件数、单文件和总字节数，拒绝重复/大小写折叠冲突、NUL、绝对路径、`..`。
- 源文件只取普通文件；拒绝符号链接、设备、socket、FIFO、可疑硬链接。生产目录读取器必须考虑目录祖先替换、读取期间变化和 TOCTOU；做不到可靠持有路径/描述符时，改用明确选择的输入字节，不声称检查一次 realpath 就万无一失。
- 不运行 Git hooks、smudge/filter、包管理脚本或项目程序。不要用未经隔离的 checkout 命令生成快照。复制字节，不共享 writable hardlink；不用 chmod 原文件。
- 默认排除 `.git`、`.env*`、凭据候选、agent/hooks/plugin 配置、构建输出和依赖目录；选择文件清单可预览。配置与指令文件若确有审查需要，只作为改名后的普通内容片段，不能按自动加载位置落盘。
- 私有快照只由宿主持有；worker 默认只通过代理获取片段。取消、重启、过期时销毁，缓存不能跨用户/任务静默复用。

### B. 三个只读工具：`readonly-tools.ts`

`createSnapshotTools(handle, limits)` 只生成 `list_files(cursor)`、`read_file(fileId,startLine,lineCount)`、`search_text(query,cursor)`。处理器的闭包里仅有快照清单/字节；没有任意 fs、exec、fetch、动态 import 或外部 MCP 客户端。

- 工具参数严格 schema，未知字段拒绝；读取由 fileId 查表，绝不将输入拼成宿主路径。
- 搜索初版只做有界字面量搜索，不执行外部 rg，也不接受任意正则造成 ReDoS。分页、总返回字节、单次/累计调用数受任务预算控制。
- 错误只返回固定分类；不给模型原始异常、环境、绝对路径或代理内部标识。
- 工具调用与模型请求在每次执行前检查取消状态；迟到响应丢弃。关闭能力后不能再创建子调用。

### C. 任务专用代理：`readonly-broker.ts`

单任务代理只接受指定模型列表、固定推理协议路由和上述工具，不是通用 HTTP/CONNECT/SOCKS 代理。不开放控制台 `/api/*`、任意 URL、第三方 MCP 或原生账号转发。

- 客户端 base URL 指向专用端口/隔离内 shim；上游 endpoint 来自服务端来源记录，客户端不能改 Host、地址、模型来源或实际鉴权头。
- 解析方法、路径和请求体后再调用现有 gateway/outbound；拒绝绝对 URL、重定向、CONNECT、协议升级、未知路径、工具定义扩权及不属于本任务的模型。
- 上游 Key 在宿主注入。给客户端的仅是任务能力，限制任务 ID、模型、剩余请求数/令牌数/费用、到期与撤销；不拥有原生 Claude 或用户 Codex 通路。
- 来源/预算每次请求重新检查。记录 session→task 的精确账本关联，复用 B49/B98 的取消树和并发上限；不能按时间窗口猜费用。
- 任务取消时先失效能力并中止在途上游，再请求 worker 停止；直到拥有的实例清理确认才释放名额。清理失败保留明确状态，不能切回裸 CLI 重试。

### D. 隔离策略与运行器：`readonly-policy.ts` / `readonly-worker.ts`

`compileReadonlyPolicy({platform,runtimeManifest,snapshot,broker,limits}) -> plan | unsupported` 是纯函数；runtimeManifest 来自可信安装/校验流程，不由 HTTP 请求提供。`launchReadonlyWorker(plan, backend)` 使用独立进程句柄/实例 ID。

- 只接受固定 Agent ID 与经过哈希验证的已安装执行组件，固定 argv；不接受任意 binary、shell 字符串、附加挂载、环境或任意 SDK 插件。
- runtime、策略、客户端版本、平台版本及验收版本共同构成资格键。升级后失效；`enabled:true`、自报 readonly 或旧的 `verified` 字段都不能伪造资格。
- 没有后端、权限不足、过滤能力不可用、seccomp/namespace 退化、未知参数、额外工具或未批准网络请求时关闭此运行。不自动安装、不执行建议的 sysctl/AppArmor 修复、不放宽策略。
- 首批关闭原生子 Agent、skills、hooks、额外 MCP 和持久会话；多 Agent 与互审由 EasySwitch 宿主安排。若后续开放委派，子任务必须重新通过相同入口，不能继承更宽权限。
- 生命周期清理覆盖整个隔离实例。进程组用于管理已知普通子进程，不能作为防止任意后代逃逸的唯一安全边界。

### E. 首批客户端配置适配器

**Claude SDK**：固定 SDK/CLI 组合；显式 `tools: []`、`settingSources: []`、`strictMcpConfig: true`，仅程序内注册需要的三个工具或完全无 MCP；显式拒绝未批准工具，限制轮数/输出。空私有 HOME/CLAUDE_CONFIG_DIR，关闭自动记忆与云连接器；通过任务代理调用模型。不得用 bypassPermissions 代替配置工作。

**CodeBuddy CLI**：固定当前文档对应的 binary；固定材料模式 `--tools ""`，空且严格的 MCP；配置 `disableAllHooks: true`、禁持久会话、禁自动更新/记忆/marketplace，使用私有配置目录。可检索模式单独提供固定三个工具的 MCP 文件。`CODEBUDDY_BASE_URL` 指向专用代理；API Key 字段只放本地能力，不放上游 Key。必须观察假上游下客户端实际请求/工具集，确认没有隐含的默认来源或认证回退。

**Qoder 和 CodeBuddy 作为订阅文字来源**：另设独立资格，不能因为入站 Agent 已通过就自动通过。若厂商协议只接受客户端内 PAT/API Key，应先证明官方支持的外部注入/限定接口方案；不能默默加 TLS 解密 CA、读取原生登录或让用户提供更多账号权限。本阶段保持文档中的工具限制和资源限制，真实文件访问/认证隔离仍待验收。

## 6. 现在能做什么，需要什么输入

本轮只用 shell 内建的 `command -v` 观察到 `/usr/bin/bwrap`；当前 PATH 未发现 `docker`、`podman`。没有运行 `bwrap --version`、namespace 探针或容器检查，因此**不能推断**内核权限、seccomp 支持、可用 daemon、隔离强度或版本资格。没有用户 Mac 环境的运行结果。

| 阶段 | 当前可推进的交付 | 执行前还缺什么 |
| --- | --- | --- |
| 1：纯模块 | 快照路径/限额验证、内存只读工具、代理路由策略、平台计划编译器、固定 Agent 清单、UI 状态与取消合同 | 文件归属协调；不需要账号、安装、系统设置或真实模型 |
| 2：fixture 集成 | 临时文件/symlink/竞争读取注入、loopback 假模型、fake worker、代理取消/预算/跨任务隔离、退出顺序测试 | 可在当前审计白名单内完成；不把 fake pass 标成 OS 验证 |
| 3：隔离器验收 | 用自己编写且审阅过的探针程序验证文件/网络/进程边界 | 明确授权的执行环境、可信已安装隔离器及版本、平台允许的 namespace/Seatbelt；若需安装或更改安全设置则另行审阅与授权，失败不放宽 |
| 4：真实客户端 + 假上游 | 固定 Claude/CodeBuddy 启动，恶意工具请求/启动钩子/文件访问尝试，零真实账号和模型流量 | 用户 Mac 或明确提供的可信测试环境、官方客户端固定输入；所有出站先由隔离器拒绝，仅允许假上游。当前任务不执行此阶段 |
| 5：真实模型兼容 | 用专门选定来源执行小型公开 fixture，核对用量/结果/取消 | 用户明确选择来源、材料、预算和认证方式；不使用用户 Codex 登录或额度。本轮没有此授权输入，也不需要现在索取 |

对普通 Mac 用户的最终交付：通过验收的可选执行组件跟随 .app 版本固定；首次使用只读并行时说明材料范围和模型来源。若该 Mac 无可用后端，则给出两条完整替代方案：使用固定材料的受限服务端/独立云执行环境，或由维护者完成相应 Mac 平台验收。不能要求用户关闭系统保护，也不能在不知情时上传整仓库。

## 7. 分步验收与完成标准

1. **快照**：正常文件可读取；路径穿越、大小写别名、符号/硬链接、FIFO、超限、读时替换和跨任务 ID 被拒绝；原文件哈希前后相同。记录的是 fixture 证据。
2. **工具**：模型要求执行 shell、写文件、读绝对路径、调用 WebFetch 或注册 MCP 时均拒绝；无副作用；返回仍可用于解释原因。材料中的提示注入不改变权限。
3. **代理**：只允许约定推理和三个工具；测试 CONNECT/重定向/Host 改写/encoded path/其他模型/其他任务/预算耗尽/过期令牌/取消后重放；实际上游目标与来源记录一致；Key 不进入 worker、argv、日志或错误。
4. **隔离器实际探针**：读取快照成功，写快照和原目录失败，读取宿主 HOME/SSH/云凭据/环境标记失败；TCP/UDP/DNS/其他 loopback/Unix socket/Apple Events/脱离父进程尝试被限制；只允许自有临时目录及专用代理。此项需要真实 OS 执行，纯 fake 不可代替。
5. **真实客户端假上游**：启动配置不会运行项目 hooks/plugins/apiKeyHelper；所有可用工具与名单一致；未知版本/新增参数或默认工具导致拒绝。正常审查、拒绝恶意要求、失败和取消都能完成；没有真实 Key、账号或模型请求。
6. **B49 端到端**：两个不同真实实现各建任务、快照范围一致、输出并排、选定成功结果互审；单个失败不影响其他任务；共享三个名额；费用未知时明示，取消父任务使子任务能力全部失效；不改原仓库。
7. **资格与回归**：保存经过脱敏的版本/策略哈希/平台/验收用例编号，升级后重新验证。只有第 4–6 步通过才能注册对应真实执行器；第 5 步通过的“假上游真实客户端”仍不能写成真实厂商/模型兼容已验收。

B49 可在首批两个真实实现满足上述标准后收口；更多 Agent 按相同门槛逐个增加。B81 除已有资源管理外，还需各文字来源在对应平台的真实客户端负向文件访问测试；入站 Agent 的通过记录不能替代出站订阅桥验证。本文未把两项标记完成。
