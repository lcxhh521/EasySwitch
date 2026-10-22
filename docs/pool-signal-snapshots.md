# 模型池选择依据快照（B119）

本批只说明已有事实，不实现 smart、不预演下一请求、不修改现有 order/rotate、Gate、额度、预算或备用策略。

## 接口和只读范围

`GET /api/pools` 与既有 `GET /api/state` 的每个池新增 `signals`。原 `live`、`memberStates` 和模型池配置保持兼容。两处复用同一个 `publicPool` 接线，具体构造在 `core/src/pool-signals.ts`。

- `capturedAt` 是读取快照的时间，不是厂商观测时间。
- `members` 按配置顺序列出，不是下一次请求的实际执行顺序；读取不会推进 rotate。
- `selectable/reason` 复用原目录资格说明。配置允许不是凭据有效、实时在线、请求能力匹配或推理成功证明。
- `effect` 是已有规则在快照时的影响：`excluded` 为目录不可选，`later` 为已有失败/额度标记使其后置，`normal` 为未被这些标记后置。`normal` 不是健康或额度充足。
- 目前后置不等于排除；全部成员都在等待时仍可能尝试。改成严格暂停需要单独明确，不在本批顺手实施。
- 快照深拷贝并递归冻结，不引用 quota 的可变窗口数组。不清标记、不读凭据、不发网络请求、不写 state/调用日志或费用，也不消费健康事件。
- 以上只读承诺针对新快照构造与 `GET /api/pools` 新增逻辑，不将既有 `/api/state` 的凭据存在性检查、客户端发现或既有后台监测包装成无副作用的新接口。

## 三种证据不可混用

### 失败等待标记

`failureWait` 是原 `pools.ts` 的 provider/model 成员级内存标记。`observedAt: null`，因为原记录只保存截止时间；`identity: unverified`，因为它未绑定端点、账号或 Key 配置代次。它不覆盖全部最后成员失败或流中断，不能用于声称完整失败历史或成功率。

`active` 仅表示仍有等待标记；`elapsed` 表示到期，不能写成已恢复；非法时间为 `unknown`，不输出 Invalid Date。诊断不修正或清除原记录，不借数据清理改变当前路由。

### 额度记录

`quota.scope` 为 `provider_id_record`，`identity` 始终是 `unverified`。旧 quota 状态仅按 providerId 保存，不能确认当前端点、账号、某个 Key 或全平台额度。更换配置不会让旧额度记录自动变成当前身份事实。

- `unknown`：没有有意义记录，或记录时间缺失/异常/在未来。
- `recorded`：有历史数值或等待事实；没有统一可验证 TTL，`freshness` 仍是 `unknown`。
- `stale`：已有窗口的明确重置时点或无窗口等待标记已经到期。混合窗口逐个标记，不因一个到期就宣布其他窗口重置。
- 真实报告的 `usedPercent: 0` 保留为历史数值，不能当作当前余量100%、免费或正常运行。缺值与零不同。
- `updatedAt` 只能叫额度状态记录更新时间。`recordLimitReached()` 可能沿用旧窗口却更新时间，所以每个窗口的 `observedAt` 保持 `null`。
- 窗口的 `vendorResetAt` 是厂商曾报告的重置提示。等待的 `basis: vendor_reset` 只用于原记录已明确识别的满窗口；否则用 `retry_marker`，它可能来自本地等待或未满窗口的 reset hint，不假称已知恢复时间。
- 到期后当前额度仍未知，不把陈旧数值用于“余量最多”评分；进程重启后无记录回到未知。

### 模型列表元数据

`metadata.scope` 固定为 `models_endpoint`。只读取现有 SourceHealthMonitor 的结果；新的 `snapshotFor(provider)` 比较当前配置指纹与许可，不调用 `sync`、`verify`、`restoreVerification`、`checkNow`、`runDue` 或 `drainTransitions`。

端点/Key配置或健康检查许可不匹配时返回未知；同 Key id 的凭据替换仍依赖既有显式 invalidate 边界。时钟倒退导致检查时间在未来时也降为未知，不当作新鲜。既有监测认定 stale 时保留 stale，不另造 TTL。

`passed` 只证明既有模型列表检查曾通过，不证明池中指定模型能够生成；`failed` 只说明模型列表连续检查失败；普通限流或不确定结果保持 unknown。`generation` 明确为 `unverified`，不从 HTTP 成功、目录存在、总耗时或 metadata 结果推导实际推理可用性。

## 界面

池卡片保留原操作，只加默认折叠的“查看选择依据”。沿用 `data-keep` 保存展开/收起及焦点行为；读取详情不新增检查按钮、权限确认或网络操作。理由使用固定词汇，名称及所有展示值转义；旧快照没有信号时不补猜。

## 未包含

没有最便宜/最快/剩余额度最多评分、默认 smart、跨模型或付费边界授权、并发抢跑、自动登录、派活恢复、额度预留、续接身份迁移，也不改旧 provider 额度文案或历史账本。真实客户端、真实账号、浏览器像素、Mac Keychain 与安装包验收仍未由本批 pure/VM/loopback 测试证明。
