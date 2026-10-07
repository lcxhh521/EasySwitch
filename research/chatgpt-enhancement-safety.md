# B99：恢复 ChatGPT 增强启动的完整安全方案

更新：2026-10-07。当前工作树参考 `69ecd10`；首轮假测试基线为 `6246ad3`。本页是方案与源码证据，不是生产实现、真实客户端或账户验收记录。

## 给用户的建议

**推荐“独立请求头鉴权、保留原生 provider 身份、每次启动独立会话”。** 用户仍在同一个模型列表里选择原生或外接模型；退回原生时只撤销这次增强权限，用正常入口启动原应用，不迁移登录或历史文件。

要完整保留这种体验，现阶段不能只改一项客户端配置。已核实的官方发布版支持自定义 provider 附加请求头，却禁止覆盖内置 `openai` provider；改用另一个 provider ID 会影响历史筛选和恢复。推荐的完整路线是：**维护一个版本固定、补丁范围很小的 EasySwitch 专用 Codex app-server 适配版，仅在这次增强启动中使用它，保留 `openai` ID，并补齐本地会话头与日志保护。** 原应用包、用户配置和登录方式保持原样；官方以后提供等价接口时，可撤掉这部分适配。

这是建议的新实施路线，尚未制作、安装或执行，也不代表闭源桌面端已经验证接受它。它有明确的补丁维护、构建签名和版本验收成本；不能靠隐藏历史、改写用户配置或放松鉴权省略。若不选择维护适配版，则等待官方提供等价接口；现成自定义 provider 可用于隔离的兼容研究，不能冒充无损增强。

## 结论与当前状态

**把本地 bearer capability 放入 `openai_base_url` 路径的方案，生产仍被阻塞。** 当前官方 Codex 客户端会把完整 WebSocket URL 写入连接日志，也会把 URL 放入部分错误对象。只脱敏 EasySwitch 自己的请求日志、错误和账本，不能解决客户端的这些输出渠道，不能据此恢复增强启动并宣称“令牌不进日志”。

当前开源 Codex 的 URL 构造支持保留自定义路径前缀；这只证明源码层面的路径能力，不证明用户 Mac 上 ChatGPT 捆绑的 Codex 版本、`CODEX_CLI_PATH` 启动约定或桌面端历史兼容性。本次没有运行真实客户端，没有读取任何真实凭据或用户会话历史。

**请求头方案已推进到“官方发布版证实运输能力”，完整产品放行仍待定。** HTTP 与 WS 可以同时携带独立的本地头和原生认证，但内置 provider 的配置限制、历史兼容、TRACE 日志及用户 Mac 捆绑版本仍须逐项解决。不能仅凭 header 字段存在恢复生产按钮。

现有生产 WebSocket 拒绝边界应保留。当前 `handleChatgptUpgrade` 是原始字节透传辅助函数；仅在握手处增加路径令牌校验，仍不能满足持续撤销、逐次推理预算与费用完整性要求。不为绕过上述阻塞而新增生产路径令牌适配器。

## 威胁模型与信任边界

| 对手或故障 | 必须守住的边界 |
| --- | --- |
| 恶意网页探测本地端口、伪造路径和模型名 | 不能读取本地目录、使用存储的外部 Key 或建立有推理权限的 WS |
| 猜到端口或公开会话 ID、拿到已过期或撤销令牌 | 不能获得本地 capability；随机端口和公开 ID 都不是密码 |
| 连接复用、分片、重连、并发和预算变化 | 每次生成重新鉴权与检查预算，不能只查握手 |
| 日志、错误、诊断、上游回显和子进程继承 | 本地秘密不进入普通可分享输出，也不送往模型厂商 |
| 启动失败、退出、退原生和服务重启 | 仅回收本次所属进程、连接与会话，不误伤其他窗口、不复活旧权限 |

沿用 B80 的本机信任边界：这不是针对已控制同一 OS 用户或 root 的恶意程序的多用户隔离。该限制不允许主动把秘密写进常规日志，也不允许把无鉴权 localhost 代理视作可信客户端。源码研究与 fake 测试不需要真实账户；真实 Codex/ChatGPT/模型、登录和用户历史均未读取或运行，不使用 Codex 账户额度。

## 新证据：固定官方发布版的 header 与兼容边界

本次核实 [rust-v0.160.1](https://github.com/openai/codex/releases/tag/rust-v0.160.1)，发布于 2026-10-05，对应提交 `d27764b82f7118f674371e6d6e76271d9d606edb`。这是本轮证实的一个版本，不是声称功能最早在这里出现。以下链接固定到该提交。

| 已核实事实 | 官方证据 | 不能外推的结论 |
| --- | --- | --- |
| 自定义 provider 从命名环境变量生成附加 header | [build_header_map](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/model-provider-info/src/lib.rs#L391) | 变量缺失会省略头，所以服务端必须拒绝无凭据外接请求 |
| 满足条件时继续使用原生认证 | [provider_uses_first_party_auth_path](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/model-provider/src/provider.rs#L360)、[BearerAuthProvider](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/model-provider/src/bearer_auth_provider.rs#L31) | `requires_openai_auth` 的正确组合不等于所有新认证模式或桌面行为都兼容 |
| HTTP 同时携带 provider 头与原生认证 | [build_request](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/codex-client/src/provider.rs#L79)、[EndpointSession](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/codex-api/src/endpoint/session.rs#L122) | 运输源码成立，不是本轮真实调用通过 |
| Responses WS 也合并两类头 | [ResponsesWebsocketClient::connect](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/codex-api/src/endpoint/responses_websocket.rs#L393) | header 不替换用户原生 Authorization |
| 内置 `openai` 配置覆盖被拒绝 | [validate_reserved_model_provider_ids](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/config/src/config_toml.rs#L901) | 不能声称配置 `model_providers.openai.env_http_headers` 就能注入头 |
| provider ID 影响历史与恢复 | [thread/list 默认过滤](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server/src/request_processors/thread_processor.rs#L5244)、[恢复持久 provider](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server/src/request_processors/thread_processor.rs#L218) | 此版本默认按当前 provider 列表；恢复会取持久 provider，不能只验证新建对话 |

当前[官方 app-server 文档](https://developers.openai.com/codex/app-server)已描述省略/null/空 provider 过滤可列全部来源，不能把最新文档行为套到上述固定版本。文档公开的 stdio JSONL、Unix socket 和 WS 是**桌面到 app-server 的控制通道**，不证明 app-server 到模型 API 的运输也支持 Unix socket。

### Header 还需要日志保护

该发布版的 [Cargo 依赖](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/Cargo.toml#L640)固定了 OpenAI 的 tungstenite 分支，其[握手生成函数](https://github.com/openai-oss-forks/tungstenite-rs/blob/4fffad30fe373adbdcffab9545e9e9bf4f2fc19f/src/handshake/client.rs#L190)在 TRACE 级别输出已经序列化的完整握手，包含请求头。**这是启用相应 TRACE 时的风险，不是说默认日志也打印 header。** 标记 HeaderValue 为 sensitive 不能保护已经序列化的字节。

[app-server 日志初始化](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/app-server/src/lib.rs#L708)接受基于 `RUST_LOG` 的过滤；限制级别可以减少暴露，但尚未证明单个环境设置能约束所有日志和导出层。推荐适配版直接移除原始握手输出并验证诊断模式。网关也不能在响应头中反射本地秘密，因为[HTTP 响应调试日志](https://github.com/openai/codex/blob/d27764b82f7118f674371e6d6e76271d9d606edb/codex-rs/http-client/src/client.rs#L172)记录响应头。

## 路线取舍

| 路线 | 收益 | 不能省略的问题 | 选择 |
| --- | --- | --- | --- |
| URL 中放 bearer capability | stock 客户端可传路径前缀 | 完整 URL 日志、错误和诊断复制；服务端无法事后抹除客户端输出 | 不作生产方案 |
| stock 客户端 + 自定义 provider + 环境请求头 | HTTP/WS 运输与原生认证共存有证据 | 新 provider ID 的历史/恢复/退原生；TRACE 握手；子进程环境 | 仅隔离兼容研究，不能无损默认切换 |
| 内置 `openai` + 纯配置附加 header | 理想的配置方案 | 已核实版本拒绝内置覆盖，无等价配置证据 | 等官方支持，不编造参数 |
| 自有、版本固定的小补丁 app-server | 保留 ID，可控制附加头和日志 | 维护补丁、许可/构建/签名与桌面协议兼容成本 | 推荐完整路线，待制作和验收 |
| 随机端口或专用本地代理自动补 header | 可集中路由与连接管理 | 网页若能匿名访问代理，代理就在替攻击者加秘密；随机端口/Origin/CORS 不是 capability | 只能放在已有鉴权之后 |
| 私有 Unix socket 或继承 FD | 双方支持时可建立本地边界 | 当前仅核实控制通道，不是 stock 模型 API 运输 | 适配版内部可用，不冒充 stock 支持 |
| 每次换 `CODEX_HOME` 或复制原生登录 | 隔离部分状态 | 改变原登录/历史，复制凭据或重新登录不是默认授权 | 不作恢复原生并排体验的默认方案 |
| 读取/截获厂商 token 并自动映射本地权限 | 理论上可辨认一个原生客户端 | 缺可信注册/轮换协议，扩大凭据接触面，把厂商登录当本地授权 | 不采用 |

不借 `OpenAI-Organization` 或 `OpenAI-Project` 偷运本地秘密：它们有原生业务含义，可能被其他官方请求使用或记录。也不改写用户的 provider 历史来掩盖 custom-provider 差异。

## 推荐架构和用户操作

1. **先验版本。** 检查应用、内置客户端与已验收适配版的组合，记录公开版本、构建摘要和兼容规则。未知组合不给推理权限，说明具体待验证项；HTTP body 自报“支持 header”不能放行。
2. **每次启动独立凭据。** 在 EasySwitch 的 `0700` 目录准备本次资源，以继承 FD 或 `0600` 私有文件把 capability 交给适配进程。参数只含非秘密文件位置，不含 bearer 值。优先避免通用环境变量；若研究使用 `EASYSWITCH_SESSION_TOKEN`，必须测试不向 shell/MCP 子进程继承，默认 TOKEN 名称过滤不是唯一保护。
3. **只换本次入口。** 本次使用自有适配程序，不覆盖应用包和用户配置。provider ID 仍为 `openai`，网关 URL 无秘密，原生认证逻辑不变。
4. **受限附加头。** 适配版仅向这次登记的精确 loopback 网关附加 `x-easyswitch-session`，官方直连或任意来源不附加。令牌缺失、文件变化或目标不匹配时，外接请求在出站前失败，不能静默省略头。该头不替换用户自己的厂商 Authorization。
5. **权限分开。** 外接请求先校验本地 capability，再进入现有来源/预算链路。原生请求只发固定官方 HTTPS 目标，使用调用方自己的厂商认证；本地头出站前删除，拒绝重定向，不向供应商复制本地请求 URL。
6. **精确退原生。** 先撤销本次会话、关闭所属连接，再停止本次适配进程、清理私有文件，以正常入口启动原应用。退出或删除失败不能跳过撤销，未确认清理要报失败。普通原生启动不再附加本地头。

适配版补丁范围锁定为：**附加本地 header 的受限运输钩子、私有 capability 输入、秘密输出保护**。不改变模型授权、原生登录选择、用户权限策略、provider ID、历史 schema 或模型行为。保留官方源码许可和修改出处，不说成未经修改的官方客户端。旧对话恢复、原生历史显示、外接对话退原生后的模型重选仍是发布门禁；保留 ID 是减少变化的设计，不是已经验证成功。

## 首轮路径方案证据与适用范围

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

## HTTP、WS、预算与撤销的共同合同

以下是实现必须证明的要求，不表示已实现，也不授权真实登录、账户访问或模型请求。第 2 条只用于解释废弃路径方案原本需要的保护；推荐 header 架构不再新增路径秘密。

1. **独立处理两类凭据。** 本地 capability 只授权外接来源和本地合并目录；用户自己的厂商 Authorization 只授权固定官方目的地的原生 HTTP。外接请求必须在读取来源 Key 或调用上游之前校验本地权限。普通、无本地 capability 的原生 HTTP 仍可凭调用方自己的厂商登录转发。错误的本地凭据不得换来任何外接权限。
2. **使用严格的路径边界。** 如果路径方案的客户端输出问题得到解决，入口须先限长、验证原始请求目标，再生成不含凭据的 canonical path。编码斜线、重复鉴权前缀、路径穿越与冲突本地凭据必须明确拒绝。转发、错误、诊断、指标与账本都不能继续引用含秘密的原始 URL。原生出口维持固定官方 HTTPS 目标和拒绝重定向；会复制本地 URL 的转发头也须剥离。
3. **保持每次启动的精确所有权。** 使用独立的私有启动目录和包装文件，目录及可执行包装文件为 `0700`。不能直接沿用现有固定名称、`0755` 的包装脚本写入 capability。服务端沿用 B80 的摘要、固定到期时间和撤销语义；持久化桌面启动所属的会话 ID 元数据，退回原生或启动失败只撤销这些会话。不能按整个 agent 名撤销其他窗口或任务。argv 与客户端本地日志的暴露仍须单独解决，文件权限不能替代它们。
4. **WS 必须能识别完整应用消息。** 需要有界的帧/消息解析，处理碎片、控制帧、UTF-8、掩码和长度限制；未实现受限解压时不得协商压缩。一个模型生成请求可能横跨多个帧，预算应在完整 `response.create` 校验完成、任何该请求的出站字节发出之前检查。不能把 ping 或握手当成推理计费单位，也不能相信模型目录里的 WS 能力标记来替代实际消息检查。最小实现可明确限制一个在途 response，超出已支持事件或并发形态时拒绝。
5. **每个 response 单独结算。** 连接复用后的每次生成都要重新检查预算，并与自己的终止事件和 usage 配对。只有真实最终计数、已验证终止和覆盖完整的计价规则同时成立，才能报告费用完整。中断、缺终止、撤销、未知价格或无法关联的事件保留未知；已知部分计数可保留，不能把订阅成本写成零。预算仍是已记录估算费用的限制，不是供应商账单硬封顶。
6. **撤销必须作用于活连接。** 以可信 session ID 登记客户端连接、上游连接和未结束的记账句柄。到期计时器、明确撤销、退回原生和停机都应关闭所属连接，包括空闲连接。每条应用消息重新认证只是兜底，不能等下一帧才处理到期。若支持其他进程更新持久撤销记录，还须有明确、有界的同步延迟与测试。

HTTP 权限矩阵要固定下来：外接推理/本地合并目录必须有有效本地 capability，厂商认证不能补齐；普通原生 HTTP 只凭调用方厂商认证到固定官方目标，不混入本地目录。错误或冲突的本地凭据不能换取另一种有效的本地凭据。协议解析无法可靠分辨用途时拒绝，不猜目标。

首版 WS 可仅支持一条在途原生 response，明确拒绝未支持的多 lane、未知事件和外接 WS，外接 HTTP 继续用现有转换链路。客户端是否正确选用 HTTP 或回退，必须另测，不假定失败自然兼容。预算保持 B80 的已记录估算语义，不因本功能悄悄改成供应商硬封顶或强制中断所有既有请求。

启动归属为 `sessionId → 自有进程、活连接、资源、expiresAt`；公共接口仅提供元数据，持久化摘要和原到期时间，不重启延寿。启动/退出/重启串行且幂等，撤销的旧 launcher 不能重新签发复活。正常原生启动始终可用，但不能把失败的外接请求偷偷转投原生额度。

## 实施切片

| 切片 | 可审查交付 | 放行条件 |
| --- | --- | --- |
| 0. 架构/版本合同 | 本文、版本支持组合、补丁范围和维护方案 | 先确认推荐路线，不制作看似可用的 URL secret 功能 |
| 1. 运输无关基础 | 会话归属/连接关闭注册表、公开元数据与秘密输出边界的纯模块和 fake 测试 | 先由集成人批准独占文件；不接生产路由，不虚构客户端支持 |
| 2. 适配版源码/构建方案 | 固定官方提交、最小补丁、许可清单、可重现构建和签名说明 | 评审原生 auth/provider/history 不变；没有隐含真实 CLI 或账户执行授权 |
| 3. HTTP/启动接线 | 专属头、固定原生出口、失败/退原生精确撤销 | 合成凭据、loopback 和输出泄漏矩阵通过 |
| 4. WS 受限支持 | 有界消息守卫、每 response 预算/usage、活连接撤销 | 分片、断流、重连、预算变化和取消通过；不是仅握手成功 |
| 5. Mac 无账户验收 | 应用/客户端/适配版版本、入口、签名和假服务 | Claude/用户在 Mac 明确执行；云端 fake 不能替代 |
| 6. 用户在场真实验收 | 原生/外接并排、旧历史恢复、退原生、实际日志 | 单独满足真实账户/模型调用授权，之后仅按已验证组合开放按钮 |

当前只完成切片 0 的研究。切片 1 可以先提出，但须服务于已选路线，不能为增加完成数量堆无调用方适配器。适配版构建、安装、真实执行和账户测试均未发生。

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
| header 与原生认证共存 | 缺头/错头不能外接，两类秘密不互送，也不反射到响应 | fake HTTP/WS |
| 普通及 TRACE 日志、诊断导出、重连与失败握手 | 适配版及依赖层都不输出合成秘密；不能只检查自有日志 | 版本专项与日志捕获 |
| 未知客户端、伪造兼容声明 | 请求体或不匹配版本不能开启生产能力 | 纯版本门禁 |
| 环境/文件缺失变化、shell/MCP 子进程 | 拒绝匿名外接，秘密不流入通用子进程环境 | 假文件、假进程契约 |
| custom provider 与原生旧历史 | 旧会话、新会话、归档、恢复和退原生行为不损失；不改历史文件掩盖差异 | 先官方协议 fixture，后 Mac |
| 应用升级、签名或适配版失配 | 回到明确待验收状态，不凭宽泛版本范围自动放行 | Mac 无账户验收 |

本次已独立运行现有 `chatgpt-boundary`、`gateway-upgrade`、`gateway-auth` 共 **15 项**本地假测试，全部通过。它们验证的是当前 HTTP 权限和 WS 拒绝基线，**不是新路径方案或 WS 生产支持通过验收**。没有执行 `chatgpt-e2e`，该文件会运行真实 Codex 程序，不能因其使用假登录就纳入本次验证。

本轮新增的是固定发布版证据和完整替代架构，未把新增矩阵标为通过。

## 确实缺失的条件

- 尚未选择并制作推荐的自有适配版；运输源码有证据，不代表适配版已经存在
- 尚未证明用户当前闭源桌面接受对应替代 app-server，并保留历史/恢复/退原生行为
- 尚未移除或全面约束原始握手 TRACE 输出，也未完成所有诊断/导出层的合成秘密扫描
- 尚未实现 WS 消息守卫、逐 response 记账及空闲活连接撤销
- 尚未完成 Mac 的版本、入口、签名和真实账户验收

这些缺口分别对应上面的实施切片，不能只留一句“安全原因关闭”。通过门禁前维持生产拒绝；通过后只开放已验证客户端组合，并保留明确退原生入口。
