# 按来源选择出站适配器

2026-10-06，用户确认：按出站来源选择独立适配器，Chat 不作为所有请求必须经过的中间协议。

## 改动原因

EasySwitch 原本已有 Responses 和 Messages 原生出口、ChatGPT 的 Responses 出口、MiMo 专用鉴权，所以并非线上一律发送 Chat。问题在于大多数跨协议路径先转成有限的 ChatRequest；thinking、签名、原生工具信息可能在适配器收到请求前就丢失。

## 边界

1. 入口只负责识别调用方协议、选择来源/模型、会话权限、取消与日志。
2. 来源声明支持的协议（可按模型覆盖），专用来源固定选专用适配器。普通来源优先选与入站相同的协议，否则按来源列出的顺序选。
3. 适配器接收原始协议、原始 JSON、真实模型名、流模式及用户档位。同协议绕过转换；跨协议解析文本、图像、工具、推理及不透明续传数据，直接构造目标协议。
4. 适配器拥有地址、鉴权、出站请求和返回流解析。返回统一事件只用于必要的转换，原生返回直接透传。
5. 无法映射的内容和服务端工具明确报错；已知的参数裁剪记录转换损失。跨协议续传数据绑定来源和模型，只交还原来源。
6. `route` / `messagesRoute` 兼容旧状态；新配置以来源协议能力为准。新增来源不再向 `sendChat` 堆分支。

## 产品约束

原生 Claude 登录流量仍由 `claude-native.ts` 原样转发；上述路由只作用于用户选择的 EasySwitch 外接模型。运行时零依赖，不改 agent 配置，不重启现有代理。Kiro 只读本机 CLI 登录，令牌仅发往固定 Kiro 域名，不自动刷新原生登录。

## 实现地图

```text
Chat / Responses / Messages / Gemini 原始请求
                  ↓
gateway-route：模型解析、来源选择、Key 轮换、取消、日志
                  ↓
outbound：来源及模型协议能力 → 选择适配器
       ├─ 同协议：保留原始 JSON → 来源整形 → 原生回复直接透传
       └─ 跨协议：inbound → 中立内容 → outbound-format / Kiro
                                     ↓
                 来源响应 → 原生事件解码 → downstream → 客户端协议
```

- `protocol.ts` 定义文本、图像、工具调用/结果、推理、续传信息及输出事件，不采用 Chat 的消息结构。
- `inbound.ts` 独立解码四种入口；`outbound-format.ts` 直接构造四种目标请求。`upstream-events.ts` 和 `downstream.ts` 分别承担上游返回解码与客户端回复编码。
- `outbound.ts` 选择普通 API、ChatGPT/Codex 订阅、Copilot、MiMo Free 或 Kiro；专用来源拥有自己的鉴权和限制。ChatGPT/Codex 订阅固定使用 Responses，Copilot/MiMo 固定 Chat，Kiro 使用 AWS eventstream。
- `kiro-login.ts` 每次请求只读原生 SQLite 登录；`kiro.ts` 负责发现模型、构造请求和解释事件，`aws-eventstream.ts` / `kiro-schema.ts` 处理帧和工具 schema。
- `upstream-chat.ts` 中的旧函数仍供兼容测试使用，四个生成入口不再调用它。`route` 字段仅保留旧状态兼容，日志中的 `inboundProtocol` / `outboundProtocol` / `adapter` 才反映实际路径。

## 来源设置

来源详情可选择支持的 API 协议，也可以选某个模型单独设置。相同协议优先，否则按配置顺序选择第一个协议；不以一次运行时失败猜测并重试另一套协议。

`PUT /api/providers/:id/protocols` 接收 `{ "protocols": ["responses", "messages"] }`；加 `"model": "模型名"` 表示覆盖单个模型。`protocols: null` 清除该层覆盖。无显式配置时兼容旧的探测与线路设置。专用订阅来源不能改成普通 API 协议。

`POST /api/kiro/import` 从本机默认 Kiro CLI 登录读取模型，成功后才保存来源。重复操作更新同一来源；读取失败保留原记录。EasySwitch 仅保存登录库路径，不保存令牌；删除来源保留原生登录。

## 已知边界

- 同协议保留原生字段与回复字节，但会替换暴露给客户端的模型名、应用用户档位、已知来源怪癖和订阅必要的字段整形，并解开 EasySwitch 续传包装。原生 Claude 专用转发不经过这些步骤。
- 跨协议支持文本、图片、函数工具及结果、推理续传，支持 Responses namespace 函数工具和 custom 工具的压平/还原。服务端工具、无法映射的内容、`previous_response_id` 等服务器会话引用明确报错；不承诺任意厂商扩展都能无损转换。未知顶层扩展参数目前也没有完整的损失清单。
- 签名/加密推理通过 `es-state:` 包装回给客户端，只在来源、模型和目标协议吻合时还原。这个包装是路由标记，不是加密或身份认证。客户端必须保留相应字段（Chat 使用扩展字段 `provider_state`）；客户端主动删掉字段时无法保证续传。已有原生 Gemini 函数调用签名转成另一协议时，尚不能完整保留它与函数调用的关联；同协议不受影响。
- 跨协议 Chat 上游的工具 id、名称、参数先缓冲，直到 `finish_reason` 才发送完整调用。转为 Messages 时只有开头的文本块立即流式输出，后续文本、工具与签名块等到完整后按序输出。Gemini 工具、Responses custom 工具也在完整后输出；同协议仍直接透传原始流。
- 跨协议流缺少终止事件、工具参数损坏或上游失败时返回错误，不补造成功完成。token 上限结束保留为 `length` / `incomplete`。同协议透传仅旁路观察用量与显式错误，不重新验证原生流的完整性。
- Kiro 暂不支持强制调用工具、结构化输出；不支持的采样/输出上限等参数记入日志。登录过期需在 Kiro CLI 更新，下一次请求重新读取。工具名称用短序号别名，AWS CRC32 仅用于协议帧校验。

## 验证范围

2026-10-06 本地验证：`npm run typecheck` 通过，`node --check web/app.js` 通过。60 个既有相关用例与 18 个新用例通过，未跑包含真实 agent 的全套测试。

新用例使用临时 Store、内存 Key、空闲端口、假上游和临时 SQLite，覆盖四协议同协议保留、Responses-only/Messages-only 来源、namespace/custom 工具、Gemini 签名往返、流中断、模型协议覆盖、token 上限重试鉴权、Kiro 导入/登录更新/令牌不落盘、AWS 帧校验。不存在真实订阅调用或持久配置写入。

真实 Kiro 订阅、真实 agent 的新链路以及控制台浏览器交互尚未实测；Cursor、Antigravity 待实现。运行中的 EasySwitch/其他代理未重启，本轮改动只在本地工作区，未提交、未推送。
