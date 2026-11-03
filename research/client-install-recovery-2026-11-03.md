# M35 客户端未发现恢复闭环

基线 dev `585bedaec0351b2e0e2889db266d8634b789701b`。本批承接 B128/M35，独立 dot 云端候选，不推送。用户要求继续 EasySwitch。未运行安装器、真实客户端、真实账号或用户电脑。

## 用户流程

客户端详情区明确区分「检测中」「检测失败」「未发现」「已发现」。未发现只表示 EasySwitch 服务进程 PATH 和已知位置未命中，不等于电脑上绝对未安装。已有主模型配置可继续选择，检测失败不清空配置，也不将旧缓存当成最新成功。

用户可查看官方说明、复制安装示例，再自行决定安装。复制不会执行或打开终端，不自动安装依赖、不登录。安装后「重新检测客户端」明确绕过30秒缓存，只访问 GET /api/agents?refresh=1；同一读取去重，用户所选客户端被发现后保持选择并进入已发现分组。重复点击、15秒硬截止、失败重试及迟到导航不覆盖新选择。首次设置中的原有重检入口也走相同流程，不再随后触发通用状态刷新；逐项检测错误与空列表明确区分。安装指引展开状态在重绘后保留。

此按钮的检测仅做路径/权限/文件元数据观察，不运行 login shell、客户端 help/version、插件或安装器，不读取登录文件。原控制台首次/周期 /api/state 等既有状态观察不属于这条新检测承诺，仍保留原session/login相关行为；本批不改实际客户端启动语义。移除 /api/agents 附带的推理档位进程探测，不把静态能力回退称为动态验证。

## 安装指引范围和来源

2026-11-03读取官方文档，独立复核具体命令：
- Codex CLI：https://github.com/openai/codex ，npm全局安装@openai/codex；说明是CLI不是ChatGPT桌面安装。
- Claude Code：https://code.claude.com/docs/en/setup ，macOS已有Homebrew时的cask示例；其他平台查看官方说明。
- OpenCode：https://opencode.ai/docs/ ，npm安装opencode-ai为V1示例；官网提醒V1/V2共用命令可能互相替换，界面保留该限制。
- Gemini CLI：https://geminicli.com/docs/get-started/installation/ ，npm安装@google/gemini-cli，Node20以上。
- Qwen Code：https://qwenlm.github.io/qwen-code-docs/en/users/quickstart/ ，npm安装@qwen-code/qwen-code@latest，Node22以上。

其他客户端显示「暂无已核实的安装指引」，不猜测命令或官网。5条指引不是33个客户端安装覆盖完成。发现文件不证明版本、登录、可执行协议或增强会话兼容性；菜单栏/GUI启动的PATH可能和用户终端不同，新安装后可能需要重启EasySwitch以继承PATH。不修改系统PATH或shell配置。

## 验证

仅合成文件/注入探测和本地HTTP、VM与云浏览器夹具。最终全量、独立审查、浏览器证据保存于独立验证目录，实际版本/macOS原生与供应商调用未验收。本条保持进行中，不关闭整个M35/B128，不复制第三方实现。

最终受控全量：1766项，1765通过、1真实Keychain跳过；类型与BACKLOG检查通过。独立153项与合成文件/symlink检查通过。新增检测17项、HTTP7项、UI14项，不把它们再次加总到全量。BACKLOG仍7待办、21进行中，共28开放，本批没有关闭整个M35/B128。

独立合成浏览器发现重检重绘丢键盘焦点，已修复为仅此只读按钮aria-disabled并保留同目标焦点；重复激活仍由loading/busy守卫阻止。loading→success、转移焦点、改选和导航均复验，新增console-shell回归；不对其他禁用动作放宽焦点守卫。

实际云Chromium + 合成HTTP端点验收通过：桌面与390px布局（内容375px，无横向溢出），五条指引展示，Codex复制内容用原生粘贴核对但不执行；未发现→发现、HTTP503/逐项error、首次设置、重复Enter、迟到导航和焦点均覆盖。浏览器只验真实前端与mock，不代表真实后端或macOS。报告见独立验证目录 browser/REPORT.md。首次设置旧附文仍可能出现“程序可能未安装或位置不可用”，主文案明确检测失败不能判定，作为非阻断措辞限制保留。
