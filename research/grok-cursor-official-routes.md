# Grok / Cursor：当前模型来源边界

2026-10-18 更新。唯一需求清单为 BACKLOG.md。B115已取消任务派发、规则/评价/建议、并行互审、EasySwitch MCP互调与自动注册，以及专用后台执行器；不再规划替代调度路线。历史设计只保留在Git历史，用户已有记录和规则文件不删除、不迁移、不自动执行。

## 保留的核查范围

原Grok订阅转通用模型来源及Cursor私有协议工具映射仍不能以官方agent产品替代验收。官方CLI、ACP或SDK具有自己的会话和工具语义；本项目不再开发它们的任务控制器、运行器或调度入口。

- xAI API函数调用由调用方执行，内置搜索等工具由厂商执行；网关只按已核实协议转发定义、调用与结果，不自行执行本地函数。[函数调用](https://docs.x.ai/developers/tools/function-calling)、[工具概览](https://docs.x.ai/developers/tools/overview)
- API有独立计费体系，不假设已有Grok订阅登录自动提供API Key或同等额度。[API计费](https://docs.x.ai/console/billing)
- Cursor SDK是agent SDK，不是独立Chat模型API；SDK/Bridge存在不证明旧agent.v1私有exec族可以映射外部工具协议。[SDK](https://cursor.com/docs/sdk/typescript)、[Bridge](https://cursor.com/docs/sdk/bridge)
- 当前Cursor源码保持自身已声明的文字范围，不猜exec字段，不把工具操作压平成普通文字，也不将原生凭据发往其他服务。

## 后续验收

仅围绕原来源/协议合同准备合成证据：来源和模型能力、同协议直通与跨协议转换、明确损失/拒绝、鉴权归属、取消、usage未知和计费范围。若官方合同不足，保持未支持。真实厂商请求、安装、账号登录、发送材料和费用使用另行确认；不以官网资料或假服务称为真实兼容。
