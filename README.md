# EasySwitch

把从各处找来的模型来源（中转站、官方 API、订阅、本地模型），用进你自己顺手的那个 agent 里——**而且不顶替它原生的网关，也不改它的任何配置文件。**

> 当前是 demo（v0.0.1），只在 macOS 上运行。哪些是真的在真实程序上跑通过、哪些只是按文档写了，下面和控制台里的「覆盖情况」表都写明了，不会混在一起说。

## 和同类工具不一样的地方

- **旁路，不顶替。** 原生线路保持原样；外接模型只在你明确开启的「增强会话」里生效。停掉 EasySwitch，你的 agent 照常工作。
- **不改别人的配置文件。** 每次启动靠命令行参数、环境变量或一个用完就删的私有目录把 agent 指向本机网关。`~/.codex`、`~/.claude`、`~/.dsh` 这些一个字节都不动。控制台实时显示原生配置有没有出现 EasySwitch 的痕迹。
- **从「切换模型」走到「调度 agent」。** agent 之间可以互相派活（它们启动时挂着 EasySwitch 的 MCP），任务页里可以按你写的规则把活分给不同的 agent、模型和思考档位。
- **订阅也是模型来源，由你开关。** ChatGPT、Copilot、Kiro、Antigravity 的订阅都能当来源；每个订阅一个开关，新登录的默认关，开不开你说了算；额度用完了自动换下一个。
- **每个功能逐个 agent 交代清楚。** 控制台的「覆盖情况」表把每个 agent 的每项能力标成：已实测 / 按文档做了未实测 / 手动配置 / 做不了（附原因）/ 还没做。

## 能做什么

**模型来源**
- 中转站、各家官方 API、本地模型、Google Vertex AI（服务账号）、小米 MiMo 免 key 档位：预设一键添加，加进来先自动测一遍（能否列出模型、普通回答、流式、工具调用、走哪种协议）。
- 订阅：ChatGPT（用 Codex 客户端的登录）、GitHub Copilot、Kiro（读你本机 Kiro CLI 的登录）、Google Antigravity（浏览器里 Google 登录）。每个订阅一个开关，新的默认关；用量和重置时间显示在卡片上，用完了模型池自动跳过它。
- 模型池：同一个模型多个来源合成一个名字，一个挂了自动换下一个。
- 每月预算：给按量计费的来源设一个估算预算，可以只提醒，也可以用完就停用到下个月。
- Key 存在 macOS 钥匙串；订阅的令牌只发给它所属的厂商。

**agent**
- 已在真实程序上跑通：ChatGPT / Codex（命令行和桌面端）、Claude Code、Hermes、DeepSeek Harness。
- 按各家文档写了启动方式，**还没在真实程序上跑过**：Gemini CLI、Qwen Code、OpenCode、Aider、Copilot CLI，以及 Kimi、Pi、Oh My Pi、Droid、Cline、Goose、Crush、Grok、MiniMax Code、Qoder、OpenClaw、Trae Agent、AtomCode。每个启动器都标了哪些参数是猜的。`npm run verify-launchers` 会在你机器上对已装的那几个做一次只读检查。
- 没有每次启动单独指定的办法、但有地方填自定义模型的应用（Trae、Z Code、WorkBuddy）：给你「配置向导」，地址、令牌、模型一键复制，不替你改它们的文件。
- 做不了的（Windsurf、豆包、CodeBuddy 命令行、Amp 等）在表里写明了原因。
- 每个 agent 各有自己的主模型、想得多深、后台小任务模型和子 agent 模型，都在它自己那一行；启动后可以在它自己的模型菜单里换到别的来源的模型（Codex 和 Claude Code 已实测，Claude Code 里原生模型和外接模型并排）。
- 终端里 `es claude`、`es codex` 直接以 EasySwitch 启动。

**控制台和菜单栏**
- 控制台（本地网页）：Agent、任务、模型来源、订阅账号、会话、用量六页；用量按估算花费，不是账单。
- 菜单栏小程序（Swift）：面板里选模型、开关每个订阅；右键或核心服务没运行时是原生菜单，「全部退回原生」永远不依赖核心服务。

## 运行

```bash
# 核心服务（控制台：http://127.0.0.1:18765）
node core/src/main.ts

# 菜单栏程序
./scripts/build-menubar.sh && open menubar/build/EasySwitch.app

# 不想用真实 key 试玩：本地假中转站（http://127.0.0.1:18790/v1）
node core/test/mock-relay.ts

# 看看你装了的 agent，EasySwitch 的启动参数它们认不认（只读，不跑任务、不读任何凭据）
npm run verify-launchers
```

需要 Node ≥ 22.18（直接运行 TypeScript，运行时零依赖）、Xcode Command Line Tools（编译菜单栏程序）。

## 测试

```bash
npm install          # 只装类型检查用的 TypeScript
npm run typecheck
npm test             # 单元测试 + 端到端测试
```

端到端测试会调用**真实的 Codex、Claude Code、Hermes 和 DeepSeek Harness**：agent → EasySwitch 网关 → 严格的假中转站，走完「下令执行命令 → agent 执行 → 带回输出作答」；这些测试在开着网关鉴权的情况下跑。agent 运行在临时的目录里，并检查你真实的配置里没有出现 EasySwitch 的痕迹。各家订阅（Kiro、Antigravity、Vertex、ChatGPT、Copilot）只用本地的假服务验证过，没有用真账号测。

## 安全

- 网关只监听本机回环地址，并校验 Host；**只接受 EasySwitch 自己签发的令牌**（用本机密钥签名，每次启动一个），没有令牌的请求——比如浏览器里某个网页——花不了你的 key 和订阅。
- 控制台的修改类接口要求自定义请求头，别的网页驱动不了。
- 日志和状态文件里没有令牌；订阅的刷新令牌和服务账号密钥在钥匙串里。

## 已知限制

- 写入钥匙串用的是系统自带的 `security` 命令，Key 会短暂出现在这个命令的参数里；正式版改用原生钥匙串接口。
- 走「协议转换」线路时，没有 Chat 协议对应物的东西（Codex 的 `namespace` 工具、服务端的网页搜索等）会被去掉并记在请求记录里；原生支持对应协议的中转站走「原样转发」，不受影响。
- 外接模型在 Codex 里一律按 128k 上下文、只收文字来登记。
- Claude 桌面端、Cursor 的订阅适配还没做；Claude 订阅不会借给别的 agent。
- 升级前启动、还在跑的旧会话用的是没签名的令牌，网关会拒绝，重启一次就好。
- 订阅类来源（尤其是 Kiro 和 Antigravity）是用第三方工具使用厂商的订阅，**账号有被限制的风险**，新登录的默认关闭，打开前请自己决定。

## 许可证

[Apache-2.0](LICENSE)
