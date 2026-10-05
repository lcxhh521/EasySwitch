# EasySwitch

把从各处找来的模型来源（中转站、官方 API、本地模型），用进你自己顺手的那个 agent 里——**而且不顶替它原生的网关**。

> 当前是 demo（v0.0.1），只在 macOS 上运行，先接入 Codex 命令行。

## 和同类工具不一样的地方

很多工具的做法，是把 agent 的网关地址整个改成自己的：原生模型从此也得经过它，界面里原生和外接的模型不能并存，想换回原生要改配置、重启。EasySwitch 的原则相反：

- **旁路，不顶替。** 原生线路保持原样；外接模型只在你明确开启的「增强会话」里生效。
- **不改别人的配置文件。** 增强会话靠启动参数临时指定模型来源，`~/.codex/config.toml` 一个字节都不动。控制台实时显示原生配置文件的指纹，以及里面有没有出现 EasySwitch 的痕迹。
- **随时退回原生。** 关掉增强会话的窗口就回到原生；菜单栏的「全部退回原生」由独立的原生程序执行，核心服务坏了它照样能用。
- **加进来就先测一遍。** 添加模型来源时自动做一致性测试：能否列出模型、普通回答、流式输出、工具调用，以及是否原生支持 Responses 协议。据此自动决定是原样转发，还是做协议转换。

## demo 包含什么

| 部分 | 内容 |
|---|---|
| 核心服务 `core/` | TypeScript，直接用 Node 22 运行，无运行时依赖。网关（`/v1/responses`）、Responses ↔ Chat 协议转换、一致性测试、模型来源管理（Key 存 macOS 钥匙串） |
| 控制台 `web/` | 由核心服务提供的本地网页：添加来源、看测试结果、绑定 Codex、启动增强会话、查看原生配置指纹和请求记录 |
| 菜单栏 `menubar/` | Swift 原生小程序：状态灯、启动/停止核心服务、打开控制台、启动 Codex 增强会话、全部退回原生 |
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

端到端测试会调用**真实的 Codex 程序**：Codex → EasySwitch 网关 → 只认 Chat 协议的严格假中转站，走完一次「下令执行命令 → Codex 执行 → 把输出带回去作答」的工具调用。Codex 运行在临时的 `HOME` 和 `CODEX_HOME` 里，并检查你真实的 Codex 配置里没有出现 EasySwitch 的痕迹。

## demo 的已知限制

- 走「协议转换」线路时，Codex 的 `namespace` 工具（子 agent）和 `web_search` 没有 Chat 协议的对应物，会被去掉并记在请求记录里；原生支持 Responses 的中转站走「原样转发」，不受影响。
- 写入钥匙串用的是系统自带的 `security` 命令，Key 会短暂出现在这个命令的参数里；正式版改用原生钥匙串接口。
- 网关只监听本机回环地址，控制台接口要求带自定义请求头并校验 Host，但网关本身还没有鉴权。
- 「原生模型和外接模型并排出现在 agent 的模型菜单里」还没做：这要让原生订阅请求经过我们转发，条款风险查清之前不做。

## 来源

本仓库的代码均为原创，借鉴记录见 [PROVENANCE.md](PROVENANCE.md)。

## 许可证

[Apache-2.0](LICENSE)
