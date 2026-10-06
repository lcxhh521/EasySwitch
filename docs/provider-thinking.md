# 按模型显示思考控制（B12）

官方文档核对：2026-10-06。以下是请求构造与本地测试结论，不是账号/模型实测。

## 当前默认

| 官方 API 模型 | 显示的可选值 | Chat 出站语义 |
|---|---|---|
| DeepSeek `deepseek-flash`、`deepseek-v4-pro`、兼容 V4 Flash 别名 | `none / low / high / max` | `none` 为 `thinking.type=disabled`；其余启用思考，并设置 `reasoning_effort` |
| Kimi `kimi-k3` | `low / high / max` | 始终思考，用 `reasoning_effort`；不能关闭 |
| Kimi `kimi-k2.6` | `none / high` | 仅代表关闭/开启，用 `thinking.type`，不表示两个推理强度 |
| Kimi `kimi-k2.7-code`、`kimi-k2.7-code-highspeed` | 无可调项 | 始终思考，无档位；不能发送 disabled |

这些规则仅针对核实过的官方 API 域名及具体模型，不按模型名字给任何中转站强加厂商语义。Kimi Code 的 `kimi-for-coding` 是独立套餐别名，不猜测其后端版本；未知模型不新增推理控制。用户明确保存的模型能力覆盖优先，并复制数组以防调用方修改配置。

DeepSeek 接受的旧词会归一化：`minimal→low`、`medium/xhigh→high`、`ultra→max`；`minimal` 不再误当关闭。Messages 的开关用 `thinking`、强度用 `output_config.effort`；Responses 用 `reasoning.effort`，其中 `none` 关闭思考。新 helper 让出站层采用独立协议字段。

Kimi K2.6 修改开关时保留已有 `thinking.keep`，删除不适用的 `reasoning_effort`。K2.7 Code 旧保存偏好不能造成 disabled 出站。K3 没有 `minimal`，过期的关闭偏好至多降为最低的 `low`，不会发明“不思考”能力。前端应直接显示这些模型能力及说明，不能统一展示 low/medium/high。

## 仍需验收

- 新档位只有纯函数、请求构造和本地假服务证据；未调用真实 API
- 当前 Kimi Responses 文档只声明 `kimi-k3`；不能把 K2 的 Chat 能力推导成原生 Responses 支持
- 保留厂商返回的历史 `reasoning_content` 对 Kimi K3/K2.7 和 DeepSeek 工具历史尤其重要。已有转换层覆盖部分历史，但不能以档位测试代替完整多轮真实兼容性验收
- 旧 DeepSeek `deepseek-chat`/`deepseek-reasoner` 历史行为保留兼容测试；官方曾宣布弃用，不能当作当前推荐模型

## 官方依据

- [DeepSeek 思考模式与映射](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek Anthropic 字段支持](https://api-docs.deepseek.com/guides/anthropic_api/)
- [DeepSeek Responses 支持](https://api-docs.deepseek.com/guides/responses_api/)
- [DeepSeek 模型更新及旧别名](https://api-docs.deepseek.com/zh-cn/updates/)
- [Kimi 模型参数对照](https://platform.kimi.ai/docs/api/models-overview)
- [Kimi 思考模式](https://platform.kimi.ai/docs/guide/use-thinking-models)
- [Kimi K3 强度](https://platform.kimi.ai/docs/guide/use-reasoning-effort)
- [Kimi Responses 范围](https://platform.kimi.ai/docs/api/responses)

测试：`core/test/model-efforts.test.ts`、`core/test/quirks.test.ts`。组合入口为 `npm run test:local`；不得改用含真实 agent 的原全量测试替代。
