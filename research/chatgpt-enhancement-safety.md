# B99：ChatGPT 桌面端增强鉴权研究

研究日期：2026-10-07。仓库基线：`dev` 的 `6246ad3`。本页是安全设计与验收要求，不是生产实现或真实客户端验收记录。

## 结论与当前状态

**把本地 bearer capability 放入 `openai_base_url` 路径的方案，生产仍被阻塞。** 当前官方 Codex 客户端会把完整 WebSocket URL 写入连接日志，也会把 URL 放入部分错误对象。只脱敏 EasySwitch 自己的请求日志、错误和账本，不能解决客户端的这些输出渠道，不能据此恢复增强启动并宣称“令牌不进日志”。

当前开源 Codex 的 URL 构造支持保留自定义路径前缀；这只证明源码层面的路径能力，不证明用户 Mac 上 ChatGPT 捆绑的 Codex 版本、`CODEX_CLI_PATH` 启动约定或桌面端历史兼容性。本次没有运行真实客户端，没有读取任何真实凭据或用户会话历史。

**请求头替代方案待定。** 没有完成“保留现有内置 provider 和用户原生登录，同时注入独立本地鉴权头”的完整官方客户端证据链及捆绑版本验证。存在通用自定义 provider 请求头字段，不足以证明它可以直接用于这个桌面启动路径；本页不把它列为已可用方案。

现有生产 WebSocket 拒绝边界应保留。当前 `handleChatgptUpgrade` 是原始字节透传辅助函数；仅在握手处增加路径令牌校验，仍不能满足持续撤销、逐次推理预算与费用完整性要求。不为绕过上述阻塞而新增生产路径令牌适配器。

## 官方证据与适用范围

以下只引用 OpenAI 官方仓库。链接指向本次读取的 `main`，内容可能继续变化；它们不是用户已安装版本的固定提交证明。

| 核实事项 | 官方源码 | 本次可以得出的结论 |
| --- | --- | --- |
| HTTP 保留完整 base URL 前缀 | [codex-client/provider.rs，50–70 行](https://github.com/openai/codex/blob/main/codex-rs/codex-client/src/provider.rs#L50) | `url_for_path` 去掉首尾多余斜线后拼接子路径，不主动丢弃已有前缀 |
| WS 使用相同路径构造 | [codex-client/provider.rs，84–93 行](https://github.com/openai/codex/blob/main/codex-rs/codex-client/src/provider.rs#L84) | 先构造完整 URL，再把 HTTP scheme 换为 WS scheme，路径保留 |
| Codex backend 路由识别 | [model-provider-info/src/lib.rs，580–586 行](https://github.com/openai/codex/blob/main/codex-rs/model-provider-info/src/lib.rs#L580) | 该判断允许前置路径，只要求 base URL 末尾为 `/backend-api/codex`；不能外推为所有桌面功能都兼容 |
| 客户端输出完整 WS URL | [responses_websocket.rs，460–482 行](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L460) | 连接、连接成功和连接失败日志包含完整 URL；成功连接也不能避免此泄漏渠道 |
| 部分错误携带 URL | [responses_websocket.rs，520–539 行](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L520) | WS HTTP 错误对象保存完整 URL，不能靠过滤服务端响应正文消除 |
| 当前客户端中断事件 | [responses_websocket.rs，645–666 行](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L645) | 当前代码发送 `response.interrupt`，协议守卫不能未经核实就假定只有 `response.cancel` |
| 当前 rollout 对错误事件的处理 | [rollout/src/policy.rs，149–213 行](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/policy.rs#L149) | `Error`、`StreamError` 属于不持久化的事件；不能据此声称 URL 一定进入当前聊天 rollout，也不能证明客户端诊断日志、旧版本或桌面存储均不含它 |

路径支持与日志泄漏是两件独立的事实。路径可以送达服务端，并不等于适合作为秘密的传输位置。

## 解决阻塞后才可进入的最小安全合同

以下是实现必须证明的要求，不表示当前已实现，也不授权真实登录、账户访问或模型请求。

1. **独立处理两类凭据。** 本地 capability 只授权外接来源和本地合并目录；用户自己的厂商 Authorization 只授权固定官方目的地的原生 HTTP。外接请求必须在读取来源 Key 或调用上游之前校验本地权限。普通、无本地 capability 的原生 HTTP 仍可凭调用方自己的厂商登录转发。错误的本地凭据不得换来任何外接权限。
2. **使用严格的路径边界。** 如果路径方案的客户端输出问题得到解决，入口须先限长、验证原始请求目标，再生成不含凭据的 canonical path。编码斜线、重复鉴权前缀、路径穿越与冲突本地凭据必须明确拒绝。转发、错误、诊断、指标与账本都不能继续引用含秘密的原始 URL。原生出口维持固定官方 HTTPS 目标和拒绝重定向；会复制本地 URL 的转发头也须剥离。
3. **保持每次启动的精确所有权。** 使用独立的私有启动目录和包装文件，目录及可执行包装文件为 `0700`。不能直接沿用现有固定名称、`0755` 的包装脚本写入 capability。服务端沿用 B80 的摘要、固定到期时间和撤销语义；持久化桌面启动所属的会话 ID 元数据，退回原生或启动失败只撤销这些会话。不能按整个 agent 名撤销其他窗口或任务。argv 与客户端本地日志的暴露仍须单独解决，文件权限不能替代它们。
4. **WS 必须能识别完整应用消息。** 需要有界的帧/消息解析，处理碎片、控制帧、UTF-8、掩码和长度限制；未实现受限解压时不得协商压缩。一个模型生成请求可能横跨多个帧，预算应在完整 `response.create` 校验完成、任何该请求的出站字节发出之前检查。不能把 ping 或握手当成推理计费单位，也不能相信模型目录里的 WS 能力标记来替代实际消息检查。最小实现可明确限制一个在途 response，超出已支持事件或并发形态时拒绝。
5. **每个 response 单独结算。** 连接复用后的每次生成都要重新检查预算，并与自己的终止事件和 usage 配对。只有真实最终计数、已验证终止和覆盖完整的计价规则同时成立，才能报告费用完整。中断、缺终止、撤销、未知价格或无法关联的事件保留未知；已知部分计数可保留，不能把订阅成本写成零。预算仍是已记录估算费用的限制，不是供应商账单硬封顶。
6. **撤销必须作用于活连接。** 以可信 session ID 登记客户端连接、上游连接和未结束的记账句柄。到期计时器、明确撤销、退回原生和停机都应关闭所属连接，包括空闲连接。每条应用消息重新认证只是兜底，不能等下一帧才处理到期。若支持其他进程更新持久撤销记录，还须有明确、有界的同步延迟与测试。

## 安全验收矩阵

先使用合成身份、内存假密钥和 loopback 假服务。日志检查中的匹配值只能是测试生成的合成 capability。

| 场景 | 必须证明的结果 | 验证范围 |
| --- | --- | --- |
| 外接请求缺失、伪造、撤销或过期 capability | 在读 Key、列本地目录或联网之前拒绝 | fake HTTP |
| 合法 capability 与厂商 Authorization 并存 | 外接与原生 HTTP 分别走正确来源，两类凭据不互漏 | fake HTTP |
| 普通原生 HTTP | 只使用调用方厂商凭据；不借用本地 Key；只发往固定官方目标 | fake HTTP |
| 编码路径、重复前缀、冲突凭据 | 不因 URL 规范化或凭据回退绕过鉴权 | 原始 loopback 请求 |
| 第一次 WS 请求后预算被停用或用尽 | 同一连接的下一次生成在发出前被拒绝 | fake WS |
| 空闲或生成中的 WS 被撤销、到期 | 对应上下游连接关闭，其他启动会话不受影响 | 假时钟、fake WS |
| 分片、超限消息、压缩协商与未知事件 | 有界处理或明确拒绝，不能绕过模型/预算检查 | fake WS |
| 正常终止、断流、缺 usage、重复终止 | 每个 response 只计一次；不完整费用保持未知 | fake WS、内存账本 |
| 启动失败、重复增强、退回原生 | 仅清理所属启动文件与会话，不能重用旧 capability 或撤销无关会话 | 注入假启动器 |
| 自有输出检查 | 自有日志、错误、状态接口、账本和非秘密文件中无合成 capability | 捕获输出与临时目录检查 |
| 官方客户端输出检查 | 成功与失败连接、重连、诊断输出均不暴露 capability；不能仅检查 EasySwitch | 阻塞项；先解决官方源码已证实的日志渠道 |
| 用户 Mac 捆绑版本与桌面行为 | 启动变量、前缀传递、模型并排、退原生、旧会话恢复和客户端存储符合约定 | 待 Claude 在 Mac 上验收，需用户在场 |

本次已独立运行现有 `chatgpt-boundary`、`gateway-upgrade`、`gateway-auth` 共 **15 项**本地假测试，全部通过。它们验证的是当前 HTTP 权限和 WS 拒绝基线，**不是新路径方案或 WS 生产支持通过验收**。没有执行 `chatgpt-e2e`，该文件会运行真实 Codex 程序，不能因其使用假登录就纳入本次验证。

在客户端 URL 秘密输出问题解决、上述生产必需边界落地并完成相应假测试前，B99 保持未完成；真实桌面与账户兼容继续单列 Mac 验收。
