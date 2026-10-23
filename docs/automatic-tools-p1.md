# 自动来源的启动级工具会话 P1

> 实验状态：已推 B124 `3c1f3830` 不应用于真实工具任务。官方 OpenCode v1.19.4 源码核对确认，下游可能在参数首次可解析时、响应完整性验证前执行工具。B125 已在 dev 修复工具字节提前暴露；这不是网关自动重放问题。B129 云端候选仅修 EasySwitch 自己生成的模型档位，尚未推送；配置合并和标题并发仍待真实客户端验收，不能把生成配置测试视为工具任务已可用。

## 用户入口与范围

B123 的普通 HTTP 无状态纯文字自动模式保持原样；旧 order/rotate、不带新标记的启动和原生旁路不迁移。B124 在已安装 OpenCode、当前已确认的 automatic 模型卡旁增加独立的「新开工具会话（试用）」入口，用户阅读并确认后才启动。仅云端 fake/loopback/VM 已验证，尚未验证真实 OpenCode、供应商账号、浏览器 DOM 或打包。

这是整次增强启动的作用域，不是每个 conversation 的身份。使用同一个自动模型的子任务共用一次来源选择；保留原固定小模型及原生旁路，不把它们静默改成自动模型。若已设置且程序认识的小模型/子任务来源不可用，新 P1 启动拒绝，不删除配置让它跟随主模型。普通启动的既有行为不改。

只接受普通 Chat Completions 到原生 Chat Completions 的标准 function 工具请求，不转换 Responses、Messages、Gemini、订阅/专用认证、opaque continuation、媒体、hosted tools、推理私有字段或未知扩展。P1 不支持显式 effort；入口显示原因，用户可显式恢复该程序默认档位，再重新核对启动。此操作不清空小模型配置，不自动启动。

## 一次明确确认

- 控制台展示来源和固定 Key 名单、同启动子任务共 pin、异常或重启须新开会话、已发请求不自动重放，以及恢复固定来源的路径。不声称同 provider/Key ID 就是同一账号。
- `automaticTools: true` 必须与当前绑定模型、`automaticToolsApprovalId` 和 `automaticToolsLaunchReviewId` 一起提交。后两者是非秘密比较摘要，不是账号身份或调用授权。
- 启动 review 摘要覆盖 binding、binding revision 和完整程序 prefs。入口和异步凭据核验之后都比较当前状态；小模型配置使用同一份已核对快照。配置改变须重新核对，不能使用晚到的新配置。
- 新标记只允许 OpenCode 的顶层显式增强启动，不给手动网关令牌、MCP、原生旁路或其他程序默默加能力。单页离开/改变选择取消待启动确认；已发启动结果不确定时不重复提交。

## 来源、凭据与派发

首次实际发送前，在现有已确认的有限来源/固定凭据名单内按原列表顺序选择。只接受配置声明为原生 Chat 的兼容来源；未知额度和未知健康保持中性，不代表健康、充足或免费，不新增探测。可信被动负证据仍可暂时排除来源；全部等待时零上游发送。

发送前同步原子固定 member、provider、精确 Key 引用、端点、模型、Chat 协议、确认代次和本地配置摘要。并发首请求不能创建不同 pin；同一作用域仅允许一个进行中的 HTTP 请求，另一个明确返回 busy，不排队或暗中重试。正常响应须经验证并到达 HTTP `finish` 才释放；背压/取消不能提前解锁。

每次实际发送重核会话、撤销、授权、全局/来源预算、来源配置和确认代次，并重读选中 Key 比对。跨池、Key 和 outbound 修复共享最多 **1 次实际发送**；P0 仍最多 2 次。原生请求体除固定目标 model 外不做工具兼容修复，不自动补字段或重放。

应用内代次变更立即失效；外部 Keychain 更改在读取发现后失效，每次派发前必须重读，不能读失败后用缓存旧值，也不会偷偷采用新值。外部后端读取与网络发送之间无法提供原子事务，这是已知边界，不是获得读取真实账号的许可。

预算仍是既有的已知费用估算守卫，不是供应商账单硬上限或并发预留；本功能不扩大支出或账号权限。

## 工具历史与输出

首次请求可声明 tools，但不能带旧 tool call/result 或外来/opaque 续接。后续工具调用 ID、函数名和参数摘要必须来自本作用域已验证完整响应，结果正确配对；完整历史可以在后续请求再次携带，不把历史复述错误地当成一次性凭据消费。不同启动不能导入这些证明。

JSON/SSE 同协议透传，严格核对一个 choice、声明的函数、tool_choice、parallel_tool_calls、结束原因及完整参数；不以 usage 日志支路作为工具证明来源。SSE 拒绝裸 CR、非法事件或终止后额外数据。B125 从首个包含 tool_calls 的帧开始，扣住该帧以及全部后续原始帧，包括文字、评论、finish/usage/DONE；只有正常 EOF、完整校验及同步工具证明提交/完成检查成功后，才按原字节原顺序释放。首个工具帧之前的普通文字仍可流式传送，工具参数不再在完整验证前暴露。未释放的缓冲遇错误、超限或取消直接丢弃，不重放。参数摘要使用无浮点舍入的规范化 JSON，保留负零差异并拒绝重复对象 key，避免大整数、小数和极小数碰撞。

范围受限：32 MiB 响应、2 MiB SSE 帧、2048 个作用域、每作用域 4096 个工具证明、全局 65536 个证明。容量不足明确拒绝/暂停，不通过淘汰活跃 pin 重新选号。作用域登记只保存 ID、函数名、参数哈希及固定配置摘要，不持久保存工具参数、结果或会话全文。验证期间输出门会暂存原始响应字节，32 MiB 是每响应原始字节上限，不是整个进程 RSS 上限；临时解析/复制和多个独立作用域可能叠加。本批未引入新的全局缓冲预算。工具执行最早时点会推迟到本次上游响应完整结束，不承诺继续流式执行工具参数。

上游拒绝、未知/不完整结果、取消、身份或已固定来源预算失效会暂停，不换源、不换 Key、不自动重发。服务重启后持久化标记仍存在，但进程内 pin 不存在，旧标记明确要求新开会话，不能降级 P0 或从外来历史重建 pin。

## 恢复与不保证的内容

1. 先检查客户端和实际工具是否已执行，特别是修改文件、命令或外部副作用；错误提示不会鼓励盲目重试。
2. 恢复来源/预算/默认档位等配置后，新开增强会话。旧作用域已暂停不会因来源恢复而自行复活；新作用域不接收旧工具历史。
3. 也可显式回到固定来源，再明确启动。不会偷偷换成其他模式或改原生配置。

网关不执行工具，也不识别任意客户端独立 conversation。每请求一次发送不等于工具副作用 exactly-once；客户端自行重试、新开会话重做、正常 HTTP finish 后客户端是否实际消费，以及外部工具自身行为，不在该保证内。HTTP finish 仅代表响应已交给底层发送，不是客户端应用层收讫证明。真实客户端如何处理 busy、标准字段和恢复仍须单独验收。

无后台任务分派、手动派活 UI、真实模型探测、新凭据创建、网络共享或 CI runner 扩展。


## 已知真实客户端兼容缺口

官方 OpenCode `v1.19.4`（提交 `148842ef7cb1bc34192b3fff57d0f9721ab9c801`）使用 bundled `@ai-sdk/openai-compatible@2.0.41` 和 `ai@6.0.168`。源码显示其后台标题在缺少独立 small_model 时会回退主模型，`smallOptions` 采用 variants 第一项；B129 之前 EasySwitch 无条件注入的第一项是 low，因此可能自动发送 P1 未允许的 reasoning_effort。标题与主请求还可能并行，遇到本作用域的 409 busy。这些是固定版本源码结论，不是客户端抓包。

B129 独立云端候选按各模型自己的配置能力生成 variants，不再替未知/空能力制造 low/medium/high；能力表覆盖实际主模型、菜单和固定 small/subagent，包括合法目录外引用。仅在已核验 P1 启动的精确主自动模型上不注入 variants，固定小模型、子任务模型和普通固定来源保留各自能力，原生配置不改。P0 档位与严格请求白名单的冲突仍未作新决策，不能为通过测试放开 reasoning_effort 或未知字段。

这只证明 EasySwitch 不再主动注入。OpenCode 会合并既有 provider/model 配置，省略 variants 不保证清除原配置已有的同名 variants，也不证明运行时不会加入其他私有字段。后台标题并发的 409 busy 行为保持不变，不静默重试或排队。真实客户端仍须在明确授权且验证严格 loopback/空 HOME 隔离后验收，本轮未安装或执行客户端。

官方依据：[OpenCode v1.19.4](https://github.com/anomalyco/opencode/releases/tag/v1.19.4)、[标题回退与 small 请求](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/session/prompt.ts#L216-L235)、[smallOptions](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/provider/transform.ts#L1390-L1412)、[模型配置合并](https://github.com/anomalyco/opencode/blob/148842ef7cb1bc34192b3fff57d0f9721ab9c801/packages/opencode/src/provider/provider.ts#L1619-L1629)、[SDK 提前发 tool-call](https://github.com/vercel/ai/blob/99327b1d7b3d172ed0aae7230ae153f2d32b0ebb/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts#L584-L607)、[收到事件后执行工具](https://github.com/vercel/ai/blob/c38119a2e3df201a95a9979580f2c7a3c1b319ab/packages/ai/src/generate-text/run-tools-transformation.ts#L266-L365)。
