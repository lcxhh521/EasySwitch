# 原生 Keychain 桥：代码边界与 Mac 验收

生产存储通过 `core/native/keychain.swift` 的 Security.framework helper，不把值放到 argv，不调用 `security` 作为回退。既有 `EasySwitch` service/account 名称不变；兼容旧原文值和已有版本写入的 `b64:` 值，新写入保持 b64 编码。标识和编码兼容**不代表旧条目的访问控制已经授权**，系统拒绝不会被当成“没有 Key”。

## 稳定签名构建

在 macOS 前台确认签名操作后，用**已有**代码签名证书的 40 位 SHA-1 指纹指定身份：

```sh
EASYSWITCH_KEYCHAIN_SIGN_IDENTITY='<已有代码签名证书的40位指纹>' sh scripts/build-keychain.sh
```

- 固定代码标识为 `com.easyswitch.keychain`，designated requirement 同时绑定该标识和证书指纹；后续构建使用同一身份
- 拒绝空身份、模糊名称和 ad-hoc `-` 身份；不会创建、导入、信任或替换证书，也不会改钥匙串 ACL
- 在临时构建目录编译、签名并验证成功后才原子替换 helper；失败时保留旧文件
- 启动服务和 `/health` 只检查 helper，不再自动编译或签名。签名本身可能需要用户批准使用签名私钥，不能在 launchd 后台悄悄发起
- 这是本机开发构建，使用 `--timestamp=none`；发布包的 Developer ID 时间戳、公证和证书轮换属于单独发布流程
- 运行前检查常规可执行文件、证书绑定 requirement 和签名有效性。检查结果按文件身份/时间戳缓存；不以存在一个二进制文件冒充已验签；内部签名一致性不代替分发包来源验证

Apple 说明：ad-hoc 签名的身份绑定具体代码版本，不能可靠延续系统授权；稳定身份由 designated requirement 区分签名者与代码标识。[TN3127](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements)、[代码签名证书](https://developer.apple.com/documentation/technotes/tn3161-inside-code-signing-certificates)

如果没有合适的已有身份，停止构建，交由有 Mac 权限的人选择受支持的签名/分发方式。不要自动安装证书、降级 ad-hoc 或扩大系统信任。

## 后台失败与恢复路径

helper 在任何条目操作前禁止当前进程的用户交互，并检查是否存在默认钥匙串。不会创建、解锁、重置钥匙串或自动改变条目权限。该无交互选择只影响短生命周期 helper 进程，不修改用户的持久系统设置。

| 状态 | 含义与下一步 |
|---|---|
| `helper_missing` / `helper_not_executable` | 前台检查构建环境并重新构建；不回退 CLI 或明文文件 |
| `helper_signature_invalid` | 用同一已有身份重新构建并核实签名；不能绕过验证 |
| `no_default_keychain`，OSStatus -25307 | 在 Mac 的钥匙串访问中由用户检查登录/默认钥匙串；不自动新建或重置，不反复弹出创建窗口 |
| `keychain_unavailable`，-25294 / -25291 | 钥匙串不存在或会话不可用；在用户前台会话检查后重试 |
| `keychain_access_required`，-25308 / -25293 / -128 | 可能已锁定、旧条目 ACL 未授权或用户取消。由用户在前台检查并仅批准已核实的 helper；不建议“允许所有应用访问”，不删除旧条目来绕过限制 |
| `helper_timeout` | 超过 15 秒终止当前 helper，报告可读失败；检查 Mac 前台会话，不静默无限重试 |

失败后同一个 store 冷却 30 秒，且操作串行化，避免目录刷新为每个来源再启动一个失败进程。下一次有实际请求且冷却已过时才重试；一次成功会清除错误状态。不存在后台定时尝试读取 Key 的循环。

`/health.secretStore` 是脱敏诊断，包含 `backend`、`ready`、`status`、`keychainChecked`，必要时有固定的恢复说明和数字 OSStatus。`helper_ready` 只证明 helper 文件/签名可用；`keychainChecked:false` 表示当前进程尚未完成一次条目操作，不承诺旧条目可以读取。健康检查本身不运行 helper、不读条目、不输出账号名、本机路径、stderr 或任何 Key。

[SecKeychainCopyDefault](https://developer.apple.com/documentation/security/seckeychaincopydefault(_:)) 将“没有默认钥匙串”与“条目不存在”区分；[SecKeychainSetUserInteractionAllowed](https://developer.apple.com/documentation/security/seckeychainsetuserinteractionallowed(_:)) 用于现有文件型 Mac 钥匙串的进程级交互控制。这些旧式 API 的弃用状态不代表本次改动已迁移到 Data Protection Keychain。

## 已验证与尚未验证

2026-10-06 云端仅做源码检查、TypeScript 假传输、假签名/文件状态、编码兼容、错误脱敏、并发冷却/恢复、限长和超时测试，以及构建脚本语法检查。未执行 Swift 编译、codesign、真实 helper、真实 Keychain、任何证书或系统权限操作。

```sh
EASYSWITCH_SECRETS=memory node --import ./core/test/local-only-guard.ts \
  --test --test-force-exit core/test/native-keychain.test.ts core/test/secrets.test.ts
npm run typecheck
sh -n scripts/build-keychain.sh
```

“不回退 argv”的测试同时扫描 `secrets.ts` 和实际启动 helper 的 `native-keychain.ts`，并用假进程确认凭据只写入 stdin。

**macOS 现场验收仍需完成，不能把以上假测试写成系统实测。** 获得用户授权后，只用随机的一次性 `selftest-…` 账号和假值：

1. 构建并验证稳定签名，更新代码后用同一证书重建，核对旧/新 requirement 一致
2. 用旧 CLI 方式创建的一次性条目测试读取、原地更新和删除，记录是否需要用户前台授权；不碰任何真实服务 Key
3. 在 launchd/无 UI 会话分别验证允许访问、拒绝/锁定、超过 15 秒无响应的行为，没有循环弹窗；只用测试条目
4. 在隔离测试用户/测试环境验证没有默认钥匙串的错误；不得为了测试破坏用户当前默认钥匙串
5. 仅在明确允许时用 `EASYSWITCH_TEST_KEYCHAIN=1` 运行 opt-in 测试，并确认清理一次性条目。普通 `test:local` 始终使用内存或假传输

如旧 ACL 不兼容，保留原条目与现有原生客户端能力，报告具体 OSStatus，交用户处理前台授权；不复制真实凭据到文件、不修改别的 agent 配置、不切换不安全存储。
