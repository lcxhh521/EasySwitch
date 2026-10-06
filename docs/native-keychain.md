# 原生 Keychain 桥

生产存储通过 `core/native/keychain.swift` 的 Security.framework helper，不把值放到 argv，不调用 `security` 作为回退。既有 `EasySwitch` service/account 名称不变；兼容旧原文值和已有版本写入的 `b64:` 值，新写入保持 b64 编码，错误不会被误当成不存在。

在获准的 macOS 开发环境构建：`sh scripts/build-keychain.sh`。构建只编译，不读取或更改钥匙串。缺少 helper 时明确报错；不要把模拟验证误当作 macOS 编译或真实 Keychain 验收。

2026-10-06 云端验证仅覆盖 TypeScript 假传输、编码兼容、错误脱敏、限长和超时；没有读取真实账号或 Keychain。Swift helper 尚未在 macOS 编译、执行或验证已有条目兼容。
