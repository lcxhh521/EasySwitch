# 按来源选择出站适配器

2026-10-06，B21 的云端实现。开发基线是 `dev` 的 `eae6e21`，后保留快照并依次整合到 `103a2ab`、`0a9f8e2`，最终保留到`2045808`并行成果并在`bfefccc`推送；按需取用本仓库 `gpt-wip` 的 `8303a37`，没有整支合并。本文描述代码和本地假服务验证，不代表真实模型或真实 agent 已验证。

## 路由规则

- 四个入口分别识别 Chat、Responses、Messages、Gemini 原始请求。原生 Claude 登录流量仍优先交给 `claude-native.ts`；普通外接来源不会收到客户端的登录令牌
- 先按来源、模型选择出站协议。模型配置 `modelProtocols` 优先于来源 `protocols`；模型查找会去掉 `[1m]` 等客户端上下文后缀
- 来源支持入站协议时优先直通；否则选择来源列出的第一个协议，通过中立的内容和事件结构直接转换到目标。Chat 不是中间协议
- 没有新配置时兼容既有 `route` / `messagesRoute` 和探测结果。一次失败不会触发临时猜测协议或回放请求
- 已有 ChatGPT/Codex、Copilot 保持各自协议和鉴权；旧 MiMo Free 的未核实身份路径生产阻塞，官方 API 使用普通出口。按用户确认分工保留 Claude 已推的 Kiro/Antigravity/Cursor/Kimi 模块，通过 `subscription-compat.ts` 接回四入口；这些入口现直接接收中立Conversation，再各自构造厂商格式；Kimi的Chat是它的出站协议，不再作为Kiro/Antigravity/Cursor的中间格式。工具配对、developer指令、会话缓存键及已保存档位按来源合同处理。新订阅默认关闭，本轮只用合成登录数据和本地假服务测试；真实协议、条款和账号验收另列。未知订阅配置仍在读 Key、联网前拒绝，见 `subscription-support.md`

## 文件地图

- `protocol.ts`：原始请求、内容部件、工具、用量、输出事件和来源绑定的续传数据
- `inbound.ts`：四种入站解码；无法映射的原生内容或工具明确报错；跨协议未使用的顶层字段记入损失清单
- `outbound-format.ts`：直接构造四种出站格式，校验工具参数和续传来源
- `outbound.ts`：来源能力选择、厂商整形、地址、鉴权、请求；只对明确的输出上限拒绝进行一次同 Key、同地址重试
- `upstream-events.ts`：原生返回解码。流缺少终止事件会失败，不伪造正常完成
- `downstream.ts`：客户端 JSON/SSE 编码。长度上限保留为 `length`、`incomplete` 或 `MAX_TOKENS`；不会向必须使用对象参数的协议交付损坏的工具对象
- `gateway-route.ts`：模型解析、Key 轮换、取消、用量和日志；保留外层模型池
- `vertex-config.ts` / `vertex.ts` / `vertex-gemini.ts`：明确区分服务账号 Chat 与手动令牌/Express Gemini；旧服务账号配置兼容，不静默切换认证来源

## 同协议边界

保留原始 JSON 字段，以及上游 JSON/SSE 的回复字节、HTTP 状态和必要响应头，包括非 JSON 错误及空响应。出站仍会替换暴露模型名、应用用户明确保存的档位、已知厂商怪癖、用量开关、专用来源所需整形和本系统续传包装还原。

保留的响应头采用白名单：内容类型、缓存策略、请求 ID、`retry-after`、`retry-after-ms`、`x-should-retry` 和支持的限流头。Cookie、私有头、逐跳头不转发；fetch 解压后不保留旧的压缩编码或长度。

用量观察不改变回复。Key 失败可在输出前按现有规则重试；模型池也只在输出前切换。连接中断会终止上游；已经开始输出后不能换模型重放，截断的原生流不会被包装成正常 EOF。

## 跨协议边界

- 支持文本、base64 图片、函数工具/结果，以及 Responses namespace/custom 工具。Gemini 目标不替用户下载外部图片 URL，需要调用方提供 base64
- 服务端工具、不能解释的原生内容、Responses 服务端会话引用明确报错。未知厂商扩展不能保证无损；未使用的顶层字段只记录字段名，不记录值。复杂嵌套扩展仍应单独核实
- 签名和加密推理绑定原始来源、模型及协议。`es-state:` 是路由包装，不是加密或身份认证。客户端必须保留它；不能承诺客户端删掉扩展字段后仍能续传
- Chat 会把一个回复的思考、文本和工具分别存放，丢失原始块顺序。因此含签名的回复通过 `provider_state` 携带来源绑定的有序快照；可见文字或工具参数被修改后明确拒绝还原，避免重放错误的签名历史
- Gemini 的 `thoughtSignature` 本身不代表思考文本。带签名的可见文本仍是可见文本，签名独立保留。无法重新匹配的签名关联会记入损失清单
- 为保证签名与工具顺序，跨协议转 Messages/Gemini 时只有开头的普通文本块即时输出，后续内容在完成后按原顺序输出；同协议不受影响。Chat 工具片段先拼完整 ID/名称，Responses custom 工具也需完整后输出
- token 上限导致的残缺工具参数在 Chat/Responses 保留残缺字符串和截断状态；Messages/Gemini 省略无法执行的工具对象，并保留截断原因

## 来源设置

来源详情可设置整个来源或单个模型的协议，支持恢复继承/自动识别。

- `POST /api/providers` 可以携带 `protocols: ["responses", "messages"]`
- `PUT /api/providers/:id/protocols` 接收 `protocols` 数组；增加 `model` 设置单个模型，`protocols: null` 清除该层覆盖
- 空列表、未知协议、空模型名拒绝，不悄悄收窄配置；专用来源不允许被改成普通 API
- 日志的 `inboundProtocol` / `outboundProtocol` / `adapter` 表示实际路径；保留旧 `route` 字段用于兼容

## 可复现的安全验证

`npm run test:local` 使用明确的测试文件白名单、全新的临时 HOME、内存 Key，并阻止非 loopback HTTP、自动跳转和普通子进程。不会调用已安装的 agent、真实模型、真实账号或系统钥匙串。桌面隔离用例单独运行，仅放行已审计且内容哈希匹配的本地假程序；变更假程序必须重新审计并更新哈希。

`npm run typecheck`、`node --check web/app.js`、`npm run backlog -- --check` 和 `git diff --check` 是额外检查。原 `npm test` 包含真实 agent 用例，云端本次没有运行。

2026-10-06 整合后组合结果：386项通过（369个纯函数/本地假服务/UI，加17个桌面假程序），1项真实Keychain明确跳过，零失败。类型检查、前端语法、待办格式和 diff 检查通过。

覆盖四协议直通、12 个跨协议方向的 JSON/SSE、原生错误/空响应/重试头、签名续传与块顺序、namespace/custom 工具、长度上限、流截断、取消、Key 轮换和模型池，并回归已有订阅的本地假服务器。真实 agent、真实模型、真实订阅和厂商扩展不在这次验证范围；B21 保持进行中直到真实客户端兼容性完成核对。
