# EasySwitch

把从各处找来的模型来源（中转站、官方 API、本地模型），用进你自己顺手的那个 agent 里——**而且不顶替它原生的网关**。

> 当前是 demo（v0.0.1），只在 macOS 上运行，已接入 Codex 命令行和 Claude Code。

## 和同类工具不一样的地方

很多工具的做法，是把 agent 的网关地址整个改成自己的：原生模型从此也得经过它，界面里原生和外接的模型不能并存，想换回原生要改配置、重启。EasySwitch 的原则相反：

- **旁路，不顶替。** 原生线路保持原样；外接模型只在你明确开启的「增强会话」里生效。
- **不改别人的配置文件。** 增强会话靠启动参数临时指定模型来源：Codex 用 `-c`，Claude Code 用环境变量加一次性的 `--settings`。`~/.codex`、`~/.claude` 一个字节都不动，你平时直接打开的 Claude Code 照旧走官方。控制台实时显示原生配置文件的指纹，以及里面有没有出现 EasySwitch 的痕迹。
- **随时退回原生。** 关掉增强会话的窗口就回到原生；菜单栏的「全部退回原生」由独立的原生程序执行，核心服务坏了它照样能用。
- **加进来就先测一遍。** 添加模型来源时自动做一致性测试：能否列出模型、普通回答、流式输出、工具调用，以及是否原生支持 Responses 协议（Codex 用）和 Anthropic Messages 协议（Claude Code 用）。据此自动决定是原样转发，还是做协议转换。

## demo 包含什么

| 部分 | 内容 |
|---|---|
| 核心服务 `core/` | TypeScript，直接用 Node 22 运行，无运行时依赖。网关（`/v1/responses` 给 Codex，`/v1/messages` 给 Claude Code）、Responses ↔ Chat 与 Messages ↔ Chat 协议转换、一致性测试、模型来源管理（Key 存 macOS 钥匙串） |
| 控制台 `web/` | 由核心服务提供的本地网页，四个页面：**Agent**（每个 agent 一行，模型选择器第一项永远是「原生」）、**模型来源**（预设一键添加、一致性测试、线路）、**会话**（实时示意图 + 每次请求怎么走的人话解释）、**用量**（数字卡片 + 每日柱状图，按来源、按 agent）；页头常驻「原生配置未被改动」 |
| 订阅账号 | 一个人的多份订阅（两个 ChatGPT、两个 Claude 之类）：每个账号一个独立的登录目录（Codex 的 `CODEX_HOME`、Claude Code 的 `CLAUDE_CONFIG_DIR`），启动时选哪个就用哪个，不碰 `~/.codex` 和 `~/.claude`。可标记「撞限额了」，自动选号（默认关闭、开启前有条款提示）只在启动会话时挑最久没用且没撞限额的账号，不转发请求、不接触登录令牌、不在会话中途换号 |
| agent 自己的模型菜单 | 增强会话里输入 `/model`，Codex 和 Claude Code 各自的菜单里就是全部外接模型，会话中途随时换。Codex 用一份只给这次启动的模型目录（放在 EasySwitch 自己的数据目录），Claude Code 用官方的网关模型发现 |
| 菜单栏 `menubar/` | Swift 原生小程序：左键弹出小面板（每个 agent 一行，选模型、开增强会话）；右键或核心服务没运行时是原生菜单（启动/停止核心服务、全部退回原生）——退回原生永远不依赖核心服务 |
| 接口定义 `contracts/` | 跨语言的数据契约（JSON Schema） |

## 运行

```bash
# 核心服务（控制台：http://127.0.0.1:18765）
node core/src/main.ts

# 菜单栏程序
./scripts/build-menubar.sh && open menubar/build/EasySwitch.app

# 不想用真实 key 试玩：本地假中转站（http://127.0.0.1:18790/v1）
node core/test/mock-relay.ts
```

需要 Node ≥ 22.18（直接运行 TypeScript）、Xcode Command Line Tools（编译菜单栏程序）。

## 测试

```bash
npm install          # 只装类型检查用的 TypeScript
npm run typecheck
npm test             # 单元测试 + 端到端测试
```

端到端测试会调用**真实的 Codex 和 Claude Code 程序**：agent → EasySwitch 网关 → 只认 Chat 协议的严格假中转站，各走完一次「下令执行命令 → agent 执行 → 把输出带回去作答」的工具调用。agent 运行在临时的 `HOME` 和配置目录里，并检查你真实的配置里没有出现 EasySwitch 的痕迹。

## demo 的已知限制

- 走「协议转换」线路时，Codex 的 `namespace` 工具（子 agent）和 `web_search`、Claude Code 的服务端工具没有 Chat 协议的对应物，会被去掉并记在请求记录里；原生支持对应协议的中转站走「原样转发」，不受影响。
- Claude Code 默认要 32k 输出 token，超过模型上限时网关会去掉这个参数重试一次；外接模型的思考过程暂不显示。
- 写入钥匙串用的是系统自带的 `security` 命令，Key 会短暂出现在这个命令的参数里；正式版改用原生钥匙串接口。
- 网关只监听本机回环地址，控制台接口要求带自定义请求头并校验 Host，但网关本身还没有鉴权。
- 「原生模型和外接模型并排出现在 agent 的模型菜单里」还没做：这要让原生订阅请求经过我们转发，条款风险查清之前不做。增强会话的菜单里是全部外接模型，原生模型在平时打开的会话里用。
- 外接模型在 Codex 里一律按 128k 上下文、只收文字来登记；以后由一致性测试测出真实值。
- Claude Code 会把拿到的模型列表缓存在 `~/.claude/cache/gateway-models.json`（它自己写的缓存，按网关地址区分，不影响原生会话）。
- 桌面版（ChatGPT 里的 Codex、Claude 桌面端）的模型菜单还没接上，正在调研；订阅账号也暂不支持桌面版（Claude 桌面端不读环境变量，ChatGPT 桌面端用全局登录文件）。
- 「撞限额」目前由你手动标记；账号的真实用量读取还没做。

## 来源

界面借鉴了 Magpie 和 opencodex 的设计；从 Magpie 移植的设计变量和 LobeHub 图标都按 MIT 许可保留了声明。完整的借鉴和移植记录见 [PROVENANCE.md](PROVENANCE.md)。

## 许可证

[Apache-2.0](LICENSE)
