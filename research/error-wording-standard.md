# 错误提示用词标准

本表选取现有代码路径中需要优先覆盖的十五类常见问题；没有收集真实用户错误频率，因此不是遥测频次排名。只规范展示，不改变鉴权、预算、重试或来源行为。

每个提示同时回答「发生了什么」「已知或可能的原因」「点哪里处理」。正文使用固定中文，不显示状态数字、系统错误名或厂商原文。技术代码只放进默认折叠的详情。原因不确定时用「可能」，不能把网络错误断言为余额不足。

## 登记表

这些列与 web/errors.js 是逐字段校验合同，修改任意文案或新增规范代码都必须同时修改此表和覆盖测试。未知运行时异常走独立通用兜底，不自动注册新文案。

| 规范代码 | 发生了什么 | 原因 | 操作按钮 | 导航目标 | 已有路径依据 |
|---|---|---|---|---|---|
| profile_preview_conflict | 设置已变化，尚未应用 | 当前设置、保存的方案或相关来源已变化；旧预览不能用于覆盖新设置 | 重新预览后确认 | current | store.ts 方案预览指纹冲突，尚未应用 |
| profile_preview_invalid | 这套设置无法安全预览 | 保存的方案或当前设置不完整，或含有不能确认的设置字段 | 检查并重新保存方案 | current | profile-preview.ts 结构检查，拒绝不完整的恢复预览 |
| service_unavailable | 暂时连不上服务 | 本地服务或模型来源暂时没有响应，可能是服务未启动或网络连接中断 | 检查服务和连接 | doctor | 网页连接请求；gateway-route.ts 上游连接失败 |
| request_timeout | 这次请求等得太久了 | 连接或处理超过了等待时间，还没有收到完整结果 | 检查连接后重试 | doctor | cli-text-process.ts 请求超时；上游等待超时 |
| invalid_input | 这次操作没有完成 | 填写的内容缺少必要信息，或当前功能不支持这些选项 | 返回当前表单检查 | current | server.ts 表单验证与协议字段拒绝 |
| model_unavailable | 当前没有可用的模型 | 选择的模型或来源不存在、已被移除，或还没有配置完成 | 查看模型来源 | providers | gateway.ts 模型解析与来源缺失 |
| source_disabled | 这个模型来源还没打开 | 来源目前处于关闭状态，因此没有向它发送请求 | 到模型来源开启 | providers | gateway.ts 已关闭订阅；outbound.ts 文字来源关闭 |
| source_retired | 这个推理服务已停用 | 厂商已停止旧推理接口，即使密钥有效也无法调用；本次新增和自动检测已停止 | 查看来源停用说明 | providers | preset-availability.ts：Hyperbolic 官方停用说明；新增预设或精确旧地址被阻止 |
| source_auth_required | 模型来源的登录或密钥不可用 | 来源没有接受当前凭据，可能已过期、被撤销，或与所选账号和区域不匹配 | 检查来源登录和密钥 | providers | Kimi/Cursor/Antigravity 登录与 keypool.ts 凭据失败 |
| permission_denied | 这次操作没有获得许可 | 当前账号或本地连接没有执行此操作所需的权限 | 查看权限检查 | doctor | 网关权限范围与来源权限拒绝 |
| quota_limited | 模型来源暂时不能继续接收请求 | 可能达到用量上限或短时间请求过多，需要核对来源额度和恢复时间 | 查看来源额度 | providers | quota.ts 与来源额度或限流返回 |
| budget_blocked | 新的请求已被预算设置暂停 | 已记录的估算费用达到暂停条件，或预算需要核对未完整记录的用量 | 查看用量和预算 | usage | global-budget.ts 暂停条件；来源预算；探测预算限制 |
| usage_range_too_large | 已有记录的时间跨度太长 | 已有记录跨度超过 10,000 个日历日，无法一次生成完整的每日图表 | 选择今天、近 7 天或近 30 天 | usage | ledger.ts 用量图表输出上限；server.ts 用量接口完整拒绝，不返回部分总计或图表 |
| client_not_installed | 还没找到要启动的程序 | 程序可能未安装，或选择的程序位置已不可用 | 查看已安装程序 | agents | server.ts agentBinary 检测；文字桥程序元数据检查 |
| capability_unavailable | 这个功能暂时还不能使用 | 所选工具或来源尚未支持这种操作，或必要的安全验证还没有完成 | 查看功能检查 | doctor | 桌面隔离未验证；未支持订阅或协议 |
| keychain_unavailable | 暂时无法读取或保存密钥 | 系统密钥存储未准备好，可能需要解锁、确认访问权限或修复配套程序 | 检查密钥存储 | doctor | native-keychain.ts helper 与钥匙串错误 |
| storage_unavailable | 本地记录暂时无法保存或读取 | 记录文件可能不完整、不可写，或磁盘空间不足；先检查再重试，避免覆盖原记录 | 检查本地存储 | doctor | gateway-session-store.ts；账本或配置写入失败 |
| session_invalid | 这个窗口的连接凭据已失效 | 当前窗口没有有效的本地访问权限，可能已过期或被撤销 | 重新准备连接 | agents | server.ts invalid_gateway_session 与已撤销或过期本地会话 |
| request_busy | 当前正在处理的请求太多 | 同时运行的请求或连接达到本地上限，需要先等待或停止不再使用的会话 | 查看正在运行的会话 | sessions | cli-text-process.ts 本地并发；手动会话签发限制 |

| account_auto_disabled | 自动选号还没有开启 | 自动选号需要先了解说明并明确开启，本次没有启动账号 | 到设置选择账号 | settings | accounts.ts 自动选号须明确开启 |
| account_unavailable | 没有参与自动选号的账号 | 这个客户端尚未添加账号，或已有账号都已停用自动选号 | 到设置检查账号 | settings | accounts.ts 同客户端启用账号筛选 |
| account_resting | 账号都在休息，已暂停自动启动 | 所有参与自动选号的账号都有休息标记；标记时间不代表实际额度恢复，确认后可手动启动或清除标记 | 到设置检查休息标记 | settings | accounts.ts 全部休息时拒绝自动启动；本地标记不是实时额度 |
| account_selection_invalid | 选择的账号或客户端已不可用 | 账号可能已移除、与客户端不匹配，或选择的信息不完整；没有自动改选其他账号 | 到设置重新选择 | settings | server.ts 显式账号与客户端校验，不回退自动选号 |

## 接入合同

- 浏览器加载 web/errors.js 后使用 EasySwitchErrors.humanError；Node 使用 core/src/user-errors.ts 的同名导出，两端只有一份文案
- 输入可含 code、status、message、context，或嵌套的 error；固定规范代码及已知技术代码优先。旧文案仅用于有界分类，不插入输出
- context 只能是 local/source/session/launch/budget/storage/keychain/request；例如同样的文件不存在，启动程序和读取记录需要不同提示
- 输出 title/reason/action/message 用于主提示；details 仅包含规范代码、有效数字状态、白名单技术代码和钥匙串数字状态，不包含上游内容、路径、地址、请求正文、令牌、堆栈或未知技术代码
- current 表示留在当前表单检查，不刷新或清空输入；其他目标都是固定页面或问题检查入口，按钮不得自动登录、启用来源、关闭预算、修改权限或执行修复
- requireRegisteredError 用于新增的显式展示代码；未登记会失败。registeredErrors 返回副本，调用方不能更改全局词典
- 菜单栏应使用相同结构化错误，不把服务端原始异常再次拼进标题。详情默认折叠，复制详情也只复制经过允许的元数据

## 通用兜底

unknown_error：这次操作没有完成。暂时无法判断具体原因，需要先检查连接和配置。请点击「打开问题检查」。

未识别的字符串即使含有密钥、地址、网页片段或英文报错，主文案和详情都不能回显。已登记代码来自不可信响应时，也只能选择固定词条，不能采用响应自带的 title、reason、action 或 HTML。

## 验证

core/test/user-errors.test.ts 遍历全部词条并对照本表，检查三件套、正文无技术原文、已登记代码优先、当前真实错误形状、浏览器/Node一致、未知错误与恶意字段不泄漏。测试只用内存数据和本地文件，禁止真实程序、账号和服务调用。界面按钮/折叠以及菜单栏接口接线由各端集成回归单独验证。


## 命令行启动拒绝

交互命令接口保留稳定技术原因码：`agent_not_integrated`映射`capability_unavailable`，`agent_not_found`映射`client_not_installed`，`model_not_found`映射`model_unavailable`，`provider_disabled`映射`source_disabled`。这些别名只选择固定词条，不带程序名、路径或原始异常。CLI对未接入和未检测到保留明确区别，并给`es list`、`es doctor`或控制台入口；不拼接HTTP状态、服务端error/uiError文案。只有CLI自行写出的参数校验提示可原样显示，网络或子进程异常同样经过固定词典。
