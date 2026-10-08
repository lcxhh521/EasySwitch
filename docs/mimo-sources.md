# MiMo 三种来源核对

核对日期：2026-10-06。官方文档能确定预设、Key 类型与协议；没有真实账号调用结果。

| 来源 | 当前实现 | 认证/计费边界 |
|---|---|---|
| 官方按量 API | 既有 `xiaomi` 预设已核实并补充说明、Key 页面、明确 api-key 原始头 | `sk-` Key；按开放平台实际用量余额 |
| Token Plan | 既有 `mimo-token-plan` 预设已补 Anthropic 地址和认证/Key 页面 | 专用 `tp-` 或团队 `ttp-` Key；扣套餐权益 |
| MiMo Free 历史入口 | 生产停用，仅保留严格本地假服务测试 | 无官方第三方通用 API 支持依据；不能承诺免费、无限或绕过配额 |

官方按量 Chat base 为 `https://api.xiaomimimo.com/v1`，EasySwitch Messages base 为 `https://api.xiaomimimo.com/anthropic/v1`（拼接 `/messages` 后为官方完整端点）；套餐分别为 `https://token-plan-cn.xiaomimimo.com/v1` 和 `https://token-plan-cn.xiaomimimo.com/anthropic/v1`。以用户后台展示的区域与专用 Key 为准，不把普通 API Key 和订阅 Key 自动调换。

现有默认模型 `mimo-v2.6-flash`、`mimo-v2.6-pro` 均在当前官方文档中。它们存在不等于本项目已成功调用；预设与请求构造本地通过，账号权限、费用、限额、实际工具/流兼容性仍待明确授权后验收。

历史 Free 代码依赖 bootstrap、客户端来源头和声明 MiMoCode 身份的 system marker，这不是公开 API 支持证明。`mimoFreeIssue()` 在任何 JWT 缓存或 bootstrap 前拒绝生产访问。唯一测试条件是显式 fixture flag 且 bootstrap/chat 两端都是 HTTP 数字环回地址；即使开 flag 也不能请求真实厂商地址。不会为规避配额轮换身份，不会把这个历史实现包装成官方免费接口。

测试 `provider-presets.test.ts` 验证三种来源分离、端点、假 Key 头、不会选择 bootstrap 或 MiMoCode 标识；`mimo-free.test.ts` 验证真实目的地拒绝和本地历史夹具。运行时未使用真实账号、Key、付费模型或官方 agent。

官方依据：

- [首次 API 调用、PAYG/Token Plan 凭据与端点](https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call)
- [Token Plan 快速接入](https://platform.xiaomimimo.com/docs/en-US/tokenplan/quick-access)
- [Token Plan 订阅说明](https://platform.xiaomimimo.com/docs/tokenplan/subscription)
- [官方平台](https://platform.xiaomimimo.com/)

2026-10-08核对：SDK示例的 Anthropic base 可能省略 `/v1`，但EasySwitch直接拼接 `/messages`。本轮修正普通按量及Token Plan新预设；已存来源不自动改写用户地址。普通按量证据：https://mimo.mi.com/docs/en-US/api/chat/anthropic-api 。
