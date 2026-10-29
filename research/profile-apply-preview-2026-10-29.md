# M04：方案应用前预览与并发保护（2026-10-29）

这是 B128 全功能/简单快捷方向的一批安全闭环，不是完整 M04 导入导出、分享或原生验收。独立候选叠加冻结 M03 configured-picker；不修改原冻结补丁，不自动推送。

## 用户流程
“预览并切换”先 GET 当前实际恢复结果，逐客户端展示主绑定、思考档位、备用、所有辅助档位的现在/应用后，包括仅 prefs、保持不变以及未保存在方案中而将被清空的设置。确认按钮明确应用全部列出的设置。取消、切页、较新的预览会使旧异步结果失效。

预览不是可用性验证：不登录、探测、推理、读密钥或启动程序；关闭、预算暂停、已移除来源/池与未列出的模型有说明。主绑定只沿用既有“来源/池存在”过滤；prefs 仍完整替换，不偷偷清理失效辅助或备用模型。原生配置/来源/池/账号本身不改。

## API 合同和兼容性
- GET /api/profiles/:id/preview 要求控制台 x-easyswitch:1，返回白名单 before/after、原因、汇总和 SHA256 fingerprint。
- POST /api/profiles/:id/apply 新 UI 必须带 {expectedPreview}。指纹包括完整当前绑定与 prefs、相关 revision、完整目标方案（同 ID 覆盖也失效）、来源存在/开关/模型/defaultModel、当前预算暂停、模型池内容。校验与 apply 同一同步调用栈，无 await 窗口。
- 冲突 409，不写、不自动重试。需重新预览和明确确认。一次成功会变更 bindingProfileRevision，因此重复确认失效。保存失败恢复原绑定/prefs/revision。
- 不完整或含无法展示字段的配置拒绝 guarded preview/apply（422），不把缺失结构误当作空方案。
- 旧不带 expectedPreview 的调用仍兼容，并未声称整个 API 强制预览。新 UI 在读取和确认两处验证精确 profileId、64hex 指纹、完整 schema 与汇总；缺指纹绝不发送序列化后的空对象，不能降级到旧路径。
- 确认请求出错时不宣称确定未应用；要求重新读取后决策，不自动补发。

## 验证界限
新增 backend 临时目录/loopback 测试覆盖清空、仅 prefs、状态/方案/来源/池变化、相同 ID 替换、重复确认、保存回滚、缺失结构、HTTP 格式与旧 API 兼容。新增 VM UI 测试覆盖只读预览、显式一次确认、取消/导航/旧响应、错误与 malformed fail-closed。真实浏览器使用完全独立的假状态/内存应用服务，不连接真实配置或账号。最终测试数和浏览器证据在外部 easyswitch-profile-preview-validation 中记录；真实 macOS/账号未验收。
