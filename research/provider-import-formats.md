# 统一来源导入的格式与安全边界

核查时间：2026-10-07。本文依据维护者公开文档和源码字段合同；实现独立编写，没有复制第三方实现。仅使用合成 JSON、TOML、SQLite 和内存密钥夹具验证，没有扫描实际用户目录、环境变量、原生登录或厂商账号。

## 已确认的来源

| 来源 | 默认位置/输入 | 本轮读取的字段 | 不读取/不执行 |
| --- | --- | --- | --- |
| CC Switch | `~/.cc-switch/cc-switch.db` | `providers` 表的 `id/app_type/name/settings_config`；Claude 的 `env`；Codex 的 `config` TOML 与 `auth.OPENAI_API_KEY` | 其他表、OAuth 文件、脚本、用量查询、数据库迁移 |
| opencodex | `~/.opencodex/config.json` | 项目既有格式 `providers`、`providers_meta`、`baseUrl`、`models/defaultModel`、`apiKey/apiKeyPool`、已知 adapter | `authMode:forward` 和未知鉴权、未知 adapter、额外请求头 |
| 环境变量 | 用户明确勾选后，由可信服务端注入当前环境 | `OPENAI/ANTHROPIC/DEEPSEEK/OPENROUTER` 的 `API_KEY`、对应 `BASE_URL` 与 `MODEL` | 不扫描任意 token 变量，不读 shell 配置，不执行 export/source/命令 |
| Codex | `~/.codex/config.toml` | 自定义 `model_providers` 标量表、主 `model/model_provider`、`base_url/name/env_key/experimental_bearer_token/wire_api` | `auth.json`、原生登录、命令鉴权、额外 headers/query、内置来源 |
| Claude Code | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`、静态 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN`、显式模型字段 | `apiKeyHelper`、hooks 执行、原生 OAuth、Bedrock/Vertex 专用鉴权 |

CC Switch 的[官方存储说明](https://github.com/farion1231/cc-switch/blob/main/README_ZH.md)将 SQLite 数据库和设备设置、OAuth 文件分开；[数据库 schema](https://github.com/farion1231/cc-switch/blob/main/src-tauri/src/database/schema.rs)明确了供应商行字段。格式按字段验证，不运行其升级流程。

[CC Switch Codex 模板](https://github.com/farion1231/cc-switch/blob/main/src/config/codexProviderPresets.ts)把第三方 Key 放在行内 `auth.OPENAI_API_KEY`，配置字符串可能仍带 `requires_openai_auth=true`。仅在该行已经明确提供静态 API Key 时识别这种组合；它不授权读取原生 Codex `auth.json`。没有自定义供应商配置的官方登录条目不会生成可导入候选。

[CC Switch Claude 模板](https://github.com/farion1231/cc-switch/blob/main/src/config/claudeProviderPresets.ts)以 `env` 对象保存地址、凭据和模型。若同时存在不同的 API Key 和 AUTH_TOKEN，则提示先明确使用哪一个，不擅自合成轮换池。

[Codex 官方配置参考](https://developers.openai.com/codex/config-reference/)区分静态环境变量 Key、直接 bearer token、OpenAI 登录和命令鉴权。本轮仅识别标准标量自定义表，`wire_api` 接受 `responses` 或省略；不把其他协议猜成 Responses。不支持复杂 TOML 结构时明确失败。`env_key` 只有环境变量来源也被明确勾选才解析；不借助其他原生认证文件补全。

[Claude Code 设置说明](https://code.claude.com/docs/en/settings)和[环境变量说明](https://code.claude.com/docs/en/env-vars)记录设置文件与自定义地址、认证变量。这里不执行其帮助命令、hooks 或动态密钥命令。

opencodex 目前使用 EasySwitch 已有 `opencodex-import.ts` 及其测试所支持的格式；没有将未核实的其他同名项目格式当作通用标准。旧格式缺字段就提示手动添加，不能凭字符串像 Key 就扩展匹配。

## 扫描、预览与保存

1. 构造导入服务不读取任何来源。扫描需要显式提交来源列表；空列表不读取环境或文件。固定路径由可信服务端 `home` 注入，不接受客户端自选文件、路径越界、符号链接、硬链接或特殊文件。
2. JSON/TOML 最大四 MiB，数据库最大三十二 MiB，候选最多二百个，待处理密钥总量最多一 MiB。SQLite 使用 Node 内置模块的只读、immutable 连接，关闭扩展和可信 schema，仅运行固定查询；不把含秘密的数据库复制到临时文件。
3. 发现数据库 WAL、SHM 或 journal 侧文件时阻止读取并提示退出来源工具后重试，避免遗漏未合并数据或改动文件。自定义 CC Switch 数据目录、旧 JSON 数据库格式、其他 app_type 暂未支持；不得称为已兼容。
4. 前端只收到随机候选 ID、来源种类、经检查的名称/地址/模型和 Key 数量。URL 含 userinfo、query、hash 时拒绝且不返回原地址。已提取 Key 出现在名称、地址、模型或 URL 编码中时隐藏这些字段。不返回原文、Key、密钥指纹或源文件路径。
5. 预览只在服务器保存脱敏候选和不可公开的完整来源摘要，十分钟后逻辑失效，数量有界；不在预览缓存保留明文 Key。提交时重新只读扫描，确认文件身份、内容与引用环境变量未变化，再取本次勾选项的 Key。
6. 空选择零写入，混入未知或不可导入项时整批拒绝。采用随机新来源 ID，默认关闭，不覆盖已有来源、不自动绑定、不探测模型、不刷新额度。主 Key 与多 Key 池只交给 SecretStore；来源状态只有密钥元数据。
7. 来源文件在扫描与保存后都保持原字节。任何 Key 或来源保存失败，回滚本批已尝试写入的新槽位和新来源；清理失败则明确报告未确认，不能声称事务已完整回滚。源文件、已有来源和已有 Key 不在回滚范围。

文件系统与 Keychain 是两个存储系统，无法承诺进程崩溃瞬间的跨系统原子性。批次异常已覆盖补偿回滚；真实 Mac 钥匙串的授权弹窗、系统失败和崩溃恢复仍待真机验收。

## 合成验证

`core/test/provider-import.test.ts` 使用隔离 HOME、合成配置、合成 SQLite、内存 SecretStore；覆盖五种来源、零选择、只读源字节、脱敏、路径边界、旧预览/来源变化、失败前后写入、全批回滚、清理未确认和并发重复提交。运行时加载本地测试网络/进程守卫，不执行任何 CLI 或外部服务请求。

用户 Mac 验收需自行点击来源扫描和逐项选择，确认弹窗后保存静态 Key；再检查默认关闭、原工具仍正常，以及取消/无选择时没有新增来源。这一步尚未执行。
