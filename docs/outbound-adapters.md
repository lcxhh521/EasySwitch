# 按来源选择出站适配器

本文说明四协议路由、转换能力与安全限制。功能经过本地假服务测试，不代表所有真实模型或客户端均已验收。

## 路由规则

- 四个入口分别识别 Chat、Responses、Messages、Gemini 原始请求。原生 Claude 登录流量仍优先交给 `claude-native.ts`；普通外接来源不会收到客户端的登录令牌
- 先按来源、模型选择出站协议。模型配置 `modelProtocols` 优先于来源 `protocols`；模型查找会去掉 `[1m]` 等客户端上下文后缀
- 来源支持入站协议时优先直通；否则选择来源列出的第一个协议，通过中立的内容和事件结构直接转换到目标。Chat 不是中间协议
- 没有新配置时兼容既有 `route` / `messagesRoute` 和探测结果。一次失败不会触发临时猜测协议或回放请求
- 已有 ChatGPT/Codex、Copilot 保持各自协议和鉴权；旧 MiMo Free 的未核实身份路径生产阻塞，官方 API 使用普通出口。Kiro、Antigravity、Cursor、Kimi 专用来源通过 `subscription-compat.ts` 接回四入口；这些入口现直接接收中立Conversation，再各自构造厂商格式；Kimi的Chat是它的出站协议，不再作为Kiro/Antigravity/Cursor的中间格式。工具配对、developer指令、会话缓存键及已保存档位按来源合同处理。新订阅默认关闭，测试使用合成登录数据和本地假服务测试；真实协议、条款和账号验收另列。未知订阅配置仍在读 Key、联网前拒绝，见 `subscription-support.md`

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

对未知的兼容 Messages 来源保留 format、reasoning 和 context 语义，只清除账户标识 metadata.user_id；已知厂商的兼容清理限定在相应主机。

保留原始 JSON 字段，以及上游 JSON/SSE 的回复字节、HTTP 状态和必要响应头，包括非 JSON 错误及空响应。出站仍会替换暴露模型名、应用用户明确保存的档位、已知厂商怪癖、用量开关、专用来源所需整形和本系统续传包装还原。

保留的响应头采用白名单：内容类型、缓存策略、请求 ID、`retry-after`、`retry-after-ms`、`x-should-retry` 和支持的限流头。Cookie、私有头、逐跳头不转发；fetch 解压后不保留旧的压缩编码或长度。

用量观察不改变回复。Key 失败可在输出前按现有规则重试；模型池也只在输出前切换。连接中断会终止上游；已经开始输出后不能换模型重放，截断的原生流不会被包装成正常 EOF。

### Responses 原生续接（B126）

Responses 的非 null `previous_response_id`、非 null `conversation`（字符串或对象），以及 `input` 中的 `compaction` 属于来源相关的历史。带这些字段时，不应用逐 agent 备用模型，也不在失败后重试另一把 Key；已选 Key 的认证/限流失败仍记入原有休息状态，上游状态、回复字节和重试头照常返回。

这类请求须直接指定原来源的 `provider/model`，不能使用 `pool/*`（包括 order、rotate、automatic 和当前只剩一个可用成员的池）。普通 Key 来源必须只有一个启用的 Key；尚无 Key 池的旧单 Key 来源保留原路径。多个启用 Key 即使部分正在休息也不会被当成单一身份；所有 Key 已停用时也不会改读旧的单 Key。条件不满足返回 409 `continuation_source_required`（automatic 模式保留已有 400 不兼容检查），发生在读取凭据、消耗池轮次和发送之前。`/responses` 别名及 ChatGPT 桌面网关的外接模型 HTTP 路径遵循同一规则。原生厂商转发不变。

该限制只阻止 EasySwitch 自动改变目标，不证明当前来源/Key 是历史最初所属的账号。用户改写来源端点、Key 值、订阅登录，或导入外来历史后，最初身份仍无法核验；不能确认原账号时应新开会话。这三个标记之外的加密推理、`item_reference` 或其他 opaque 扩展不因此获得完整账号亲和保证。跨协议无法解释的续接仍在出站前拒绝；普通无状态请求（含两个引用字段为 null）保留已有备用、池和 Key 重试。

2026-10-23 本地验证：17 项新增 pure/loopback 用例，加 94 项相关协议、Key/池、备用、automatic 和桌面边界回归通过；类型检查通过。未跑全量套件、真实客户端/账号/模型，也未重启服务、提交或推送。

## 跨协议边界

- 支持文本、base64 图片、函数工具/结果，以及 Responses namespace/custom 工具。Gemini 目标不替用户下载外部图片 URL，需要调用方提供 base64
- 不能解释的原生内容和 Responses 服务端会话引用明确报错；目标无法运行的可选服务端工具记入损失清单，强制选择这类工具则明确拒绝。未知厂商扩展不能保证无损；未使用的顶层字段只记录字段名，不记录值。复杂嵌套扩展仍应单独核实
- 签名和加密推理绑定原始来源、模型及协议。`es-state:` 是路由包装，不是加密或身份认证。客户端必须保留它；不能承诺客户端删掉扩展字段后仍能续传
- Chat 会把一个回复的思考、文本和工具分别存放，丢失原始块顺序。因此含签名的回复通过 `provider_state` 携带来源绑定的有序快照；可见文字或工具参数被修改后明确拒绝还原，避免重放错误的签名历史
- Gemini 的 `thoughtSignature` 本身不代表思考文本。带签名的可见文本仍是可见文本，签名独立保留。无法重新匹配的签名关联会记入损失清单
- 跨协议转 Messages/Gemini 时，thinking及各文本块按源事件即时输出，签名在块结束补发，并保留原始顺序。Messages工具参数按delta输出；标准Gemini的工具args必须是完整对象，故在该工具块完成时输出，而非等待整条回复。Chat工具片段先拼完整ID/名称；Responses custom工具仍需完整包装后输出
- token 上限导致的残缺工具参数在 Chat/Responses 保留残缺字符串和截断状态；Messages/Gemini 省略无法执行的工具对象，并保留截断原因

## 来源设置

来源详情可设置整个来源或单个模型的协议，支持恢复继承/自动识别。

- `POST /api/providers` 可以携带 `protocols: ["responses", "messages"]`
- `PUT /api/providers/:id/protocols` 接收 `protocols` 数组；增加 `model` 设置单个模型，`protocols: null` 清除该层覆盖
- 空列表、未知协议、空模型名拒绝，不悄悄收窄配置；专用来源不允许被改成普通 API
- 日志的 `inboundProtocol` / `outboundProtocol` / `adapter` 表示实际路径；保留旧 `route` 字段用于兼容

## 可复现的安全验证

`npm run test:local` 使用明确的测试文件白名单、全新的临时 HOME、内存 Key，并阻止非 loopback HTTP、自动跳转和普通子进程。不会调用已安装的 agent、真实模型、真实账号或系统钥匙串。桌面隔离用例单独运行，仅放行已审计且内容哈希匹配的本地假程序；变更假程序必须重新审计并更新哈希。

`npm run typecheck`、`node --check web/app.js`、`git diff --check` 是额外检查。原 `npm test` 包含真实 agent 用例，云端安全测试不运行。

当前测试范围和运行方法见 [测试说明](testing.md)。

覆盖四协议直通、12 个跨协议方向的 JSON/SSE、原生错误/空响应/重试头、签名续传与块顺序、namespace/custom 工具、长度上限、流截断、取消、Key 轮换和模型池，并回归已有订阅的本地假服务器。真实 agent、真实模型、真实订阅和厂商扩展不在这次验证范围；真实客户端兼容性仍需单独核对。

转换流的解析资源有界：单SSE帧2MiB、单回复32MiB、4096块及Chat工具头64KiB；超限取消并返回失败，不产生成功终止事件。验证用刻意暂停在下一帧之前的内存流，证明输出早于EOF；不代表真实厂商/客户端验收。

跨协议 HTTP 错误只在有界读取后给出固定的安全类别（如模型不存在、上下文过长或额度不足），不原样回显任意上游文本、凭据或提示词。
