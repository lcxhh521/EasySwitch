# Vertex AI 三种明确模式

Vertex 支持服务账号 Chat、手动访问令牌 Gemini 和 Express API Key 三种模式。认证来源与协议分别配置，不会静默互换凭据。

## 认证与协议合同

| 模式 | 凭据来源 | 出站协议/模型名 | 生命周期 |
|---|---|---|---|
| 服务账号 | 用户通过专用 `/api/vertex` 表单提供的服务账号 JSON，保存在 `vertex:<providerId>` secret namespace | OpenAI-compatible Chat；`google/gemini-*` 等原模型名不改写；项目/区域 `/endpoints/openapi` | 服务账号签名 JWT 换短期 Bearer，缓存并在到期前刷新 |
| 手动令牌（`standard`） | 来源普通密钥入口/Key 池里的用户访问令牌 | 原生 Gemini；`gemini-*`；项目/区域 `/publishers/google/models` | 不读取或刷新原生登录；到期后用户提供新令牌 |
| Express | 来源普通密钥入口/Key 池里的 Google Cloud API Key | 原生 Gemini；无项目/区域段的 `/publishers/google/models` | `x-goog-api-key` HTTP 头，不进 URL |

新记录明确保存 `mode/auth`。既有配置的精确旧形状 `{project, location, clientEmail}` 只解释为服务账号，保留其 credential namespace、模型名和 Chat 端点。未知、混合或含凭据的元数据会被拒绝；不能凭模型前缀或“哪个 Key 恰好存在”猜认证模式。

服务账号新增继续保留“验证并添加”的明确 token 验证步骤；手动令牌/Express 创建只做本地配置检查，不自动 mint 或模型探测。通用 `/api/providers` 不能提交服务账号 JSON；服务账号不能通过普通 Key 池界面换成另一种认证。

## 实现边界

- `vertex-config.ts`：纯数据联合类型、严格验证、旧配置兼容与模式识别，不读取任何凭据
- `vertex.ts`：保留服务账号 JWT、token 缓存、独立 secret namespace、Chat base URL；不是自动发现 ADC
- `vertex-gemini.ts`：原生 Gemini adapter，4 类客户端请求经中立转换进入 Gemini；原生 Gemini 请求保留字段
- keypool 只在服务账号模式调用 token resolver，其他两种模式只读其普通 Key；服务账号 resolver 缺失时直接失败，不回退到普通 Key
- 一个来源不能同时声明 Vertex 与 plan/Kiro/Antigravity/MiMo Free 鉴权

程序不会发现或读取 gcloud/ADC、启动 gcloud、向 metadata server 请求凭据、创建服务账号或生成真实 API Key。Google 推荐生产使用认证库/ADC；本项目没有实现原生 ADC 生命周期。服务账号是用户主动提供的独立凭据，与 Gemini CLI 登录及个人订阅不同。

## 目的地与缓存防护

服务账号 Chat 和原生 Gemini 都从已校验配置构造固定 Google 域名。持久化 `baseUrl`、`wire`、`anthropicBaseUrl` 不能给服务账号 token 换接收方；Gemini 原生适配器同样不接受任意地址覆盖。

服务账号 token audience 使用限定 Google HTTPS token URL，并在缓存命中之前验证。测试环境变量必须同时有显式 fixture flag 且为 HTTP 数字环回，不能指向任何真实非 Google 地址；API fixture 仅接受 origin。token exchange、推理均不自动跟随重定向。Key、私钥、JWT、token 不进入状态、查询参数或错误文案。

token 缓存绑定服务账号 email、私钥和 audience 的内存指纹；同一 provider ID 换账号/密钥不会复用旧 token。并发同身份 mint 使用一个请求；删除/清空缓存会阻止已失效 generation 的异步结果重新填回缓存。

项目/区域和模式必须在 mint 或保存 secret 之前验证。后续添加失败时不能留下孤立 secret；这由服务端集成负责并通过假服务检查。

## 验证边界

- `vertex.test.ts` 覆盖服务账号 strict config、固定地址、模式/hasKey 展示、缓存身份、并发 mint、重定向和 fixture override 拒绝覆盖
- `vertex-gemini.test.ts` 覆盖原生 Gemini 假传输、旧配置兼容、三模式 secret 路由和混合鉴权拒绝
- 所有密钥均为测试现场生成的 RSA fixture，所有 HTTP 均为环回假服务；手动令牌/Express 使用内存假传输
- 未使用真实 Google 账号、服务账号、Key、账单或真实模型；假服务成功不能标为真实厂商验收

请使用 [安全测试入口](testing.md)，不要以包含真实 agent 的全量测试替代。

## 官方依据

- [服务账号 JWT 换访问令牌](https://developers.google.com/identity/protocols/oauth2/service-account)
- [标准认证与 API Key](https://cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys)
- [快速开始与 Express REST](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start?usertype=apikey)
- [区域与全球端点](https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/locations)
- [OpenAI-compatible 示例](https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference)
- [API Key 使用 HTTP 头](https://docs.cloud.google.com/docs/authentication/api-keys-use)
- [避免 Key 进入查询参数](https://docs.cloud.google.com/docs/authentication/api-keys-best-practices)

部分 Vertex 旧链接当前重定向到 Google Gemini Enterprise Agent Platform 文档；不能据旧产品名称推断协议已失效。

## Gemini 思考参数

Gemini 2.5 使用模型允许范围内的 thinkingBudget；Gemini 3 使用具体模型支持的 thinkingLevel。无法识别的模型/档位不发送控制字段，并记录原因；不会同时发送预算与等级。已有有效原生参数保留，只有支持的显式设置才覆盖它。低/中/高映射为 token 预算属于 EasySwitch 的本地策略，不是厂商新增的等级名称。
