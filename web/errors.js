/* One fixed-language error dictionary for the console, server and menu bar. No I/O or DOM access. */
(function (root) {
  "use strict";
  const rows = [
    ["profile_preview_conflict", "设置已变化，尚未应用", "当前设置、保存的方案或相关来源已变化；旧预览不能用于覆盖新设置", "重新预览后确认", "current"],
    ["profile_preview_invalid", "这套设置无法安全预览", "保存的方案或当前设置不完整，或含有不能确认的设置字段", "检查并重新保存方案", "current"],
    ["service_unavailable", "暂时连不上服务", "本地服务或模型来源暂时没有响应，可能是服务未启动或网络连接中断", "检查服务和连接", "doctor"],
    ["request_timeout", "这次请求等得太久了", "连接或处理超过了等待时间，还没有收到完整结果", "检查连接后重试", "doctor"],
    ["invalid_input", "这次操作没有完成", "填写的内容缺少必要信息，或当前功能不支持这些选项", "返回当前表单检查", "current"],
    ["model_unavailable", "当前没有可用的模型", "选择的模型或来源不存在、已被移除，或还没有配置完成", "查看模型来源", "providers"],
    ["source_disabled", "这个模型来源还没打开", "来源目前处于关闭状态，因此没有向它发送请求", "到模型来源开启", "providers"],
    ["source_retired", "这个推理服务已停用", "厂商已停止旧推理接口，即使密钥有效也无法调用；本次新增和自动检测已停止", "查看来源停用说明", "providers"],
    ["source_auth_required", "模型来源的登录或密钥不可用", "来源没有接受当前凭据，可能已过期、被撤销，或与所选账号和区域不匹配", "检查来源登录和密钥", "providers"],
    ["permission_denied", "这次操作没有获得许可", "当前账号或本地连接没有执行此操作所需的权限", "查看权限检查", "doctor"],
    ["quota_limited", "模型来源暂时不能继续接收请求", "可能达到用量上限或短时间请求过多，需要核对来源额度和恢复时间", "查看来源额度", "providers"],
    ["budget_blocked", "新的请求已被预算设置暂停", "已记录的估算费用达到暂停条件，或预算需要核对未完整记录的用量", "查看用量和预算", "usage"],
    ["usage_range_too_large", "已有记录的时间跨度太长", "已有记录跨度超过 10,000 个日历日，无法一次生成完整的每日图表", "选择今天、近 7 天或近 30 天", "usage"],
    ["client_not_installed", "还没找到要启动的程序", "程序可能未安装，或选择的程序位置已不可用", "查看已安装程序", "agents"],
    ["capability_unavailable", "这个功能暂时还不能使用", "所选工具或来源尚未支持这种操作，或必要的安全验证还没有完成", "查看功能检查", "doctor"],
    ["keychain_unavailable", "暂时无法读取或保存密钥", "系统密钥存储未准备好，可能需要解锁、确认访问权限或修复配套程序", "检查密钥存储", "doctor"],
    ["storage_unavailable", "本地记录暂时无法保存或读取", "记录文件可能不完整、不可写，或磁盘空间不足；先检查再重试，避免覆盖原记录", "检查本地存储", "doctor"],
    ["session_invalid", "这个窗口的连接凭据已失效", "当前窗口没有有效的本地访问权限，可能已过期或被撤销", "重新准备连接", "agents"],
    ["request_busy", "当前正在处理的请求太多", "同时运行的请求或连接达到本地上限，需要先等待或停止不再使用的会话", "查看正在运行的会话", "sessions"],
    ["account_auto_disabled", "自动选号还没有开启", "自动选号需要先了解说明并明确开启，本次没有启动账号", "到设置选择账号", "settings"],
    ["account_unavailable", "没有参与自动选号的账号", "这个客户端尚未添加账号，或已有账号都已停用自动选号", "到设置检查账号", "settings"],
    ["account_resting", "账号都在休息，已暂停自动启动", "所有参与自动选号的账号都有休息标记；标记时间不代表实际额度恢复，确认后可手动启动或清除标记", "到设置检查休息标记", "settings"],
    ["account_selection_invalid", "选择的账号或客户端已不可用", "账号可能已移除、与客户端不匹配，或选择的信息不完整；没有自动改选其他账号", "到设置重新选择", "settings"],
  ];
  const entries = rows.map(([code, title, reason, label, target]) => Object.freeze({ code, title, reason, action: Object.freeze({ label, target }) }));
  const dictionary = new Map(entries.map(entry => [entry.code, entry]));
  const fallback = Object.freeze({ code: "unknown_error", title: "这次操作没有完成", reason: "暂时无法判断具体原因，需要先检查连接和配置", action: Object.freeze({ label: "打开问题检查", target: "doctor" }) });
  const aliases = new Map(Object.entries({
    PROFILE_PREVIEW_CONFLICT: "profile_preview_conflict", PROFILE_PREVIEW_INVALID: "profile_preview_invalid",
    ECONNREFUSED: "service_unavailable", ECONNRESET: "service_unavailable", ENOTFOUND: "service_unavailable", EAI_AGAIN: "service_unavailable", ERR_NETWORK: "service_unavailable", provider_unavailable: "service_unavailable",
    ETIMEDOUT: "request_timeout", UND_ERR_CONNECT_TIMEOUT: "request_timeout", UND_ERR_HEADERS_TIMEOUT: "request_timeout", UND_ERR_BODY_TIMEOUT: "request_timeout",
    invalid_request_error: "invalid_input", invalid_subscription_source: "invalid_input", bad_request: "invalid_input",
    model_not_found: "model_unavailable", source_not_found: "model_unavailable", provider_not_found: "model_unavailable",
    antigravity_client_unavailable: "source_auth_required", provider_disabled: "source_disabled", authentication_error: "source_auth_required", invalid_api_key: "source_auth_required", key_rejected: "source_auth_required",
    access_denied: "permission_denied", EACCES: "permission_denied", EPERM: "permission_denied",
    rate_limit_error: "quota_limited", insufficient_quota: "quota_limited", subscription_sharing_usage_limit_exceeded: "quota_limited",
    budget_exceeded: "budget_blocked", provider_budget_exceeded: "budget_blocked", budget_accounting_unavailable: "budget_blocked", probe_budget_unmetered: "budget_blocked",
    agent_not_found: "client_not_installed", executable_not_found: "client_not_installed",
    desktop_isolation_unverified: "capability_unavailable", desktop_gateway_auth_unverified: "capability_unavailable", subscription_source_unavailable: "capability_unavailable",
    agent_not_integrated: "capability_unavailable", unsupported_platform: "capability_unavailable", protocol_unsupported: "capability_unavailable",
    helper_missing: "keychain_unavailable", helper_not_executable: "keychain_unavailable", helper_signature_invalid: "keychain_unavailable", helper_timeout: "keychain_unavailable",
    no_default_keychain: "keychain_unavailable", keychain_error: "keychain_unavailable", keychain_access_required: "keychain_unavailable",
    gateway_session_storage_unavailable: "storage_unavailable", ENOSPC: "storage_unavailable", EROFS: "storage_unavailable", EIO: "storage_unavailable",
    invalid_gateway_session: "session_invalid", gateway_auth_required: "session_invalid", session_expired: "session_invalid", session_revoked: "session_invalid",
    gateway_session_issuance_limited: "request_busy", cli_concurrency_limit: "request_busy",
  }));
  // Legacy wording is used only to select a constant entry, never echoed or interpolated.
  // Match specific local conditions before generic upstream/status conditions.
  const legacy = [
    [/没有默认钥匙串|钥匙串|Keychain|OSStatus|keychain helper/i, "keychain_unavailable"],
    [/账本|本地存储|记录无法安全|failed to (?:read|write|save)|disk.{0,12}full/i, "storage_unavailable"],
    [/预算.{0,30}(?:暂停|达到|超|拒绝|禁止|无法)|budget.{0,30}(?:exceed|block|limit|accounting)/i, "budget_blocked"],
    [/同时.{0,20}(?:最多|上限|三个|3)|最多同时|已有\s*\d+\s*个文字桥请求运行|并发.{0,12}(?:上限|已满)|too many active gateway sessions|签发过于频繁|令牌数量已达上限/i, "request_busy"],
    [/来源.{0,20}(?:关闭|关着)|订阅.{0,20}(?:关闭|关着)|source.{0,30}switched off|subscription.{0,30}switched off/i, "source_disabled"],
    [/没有(?:找到|检测到).{0,30}(?:命令|程序|桌面端|agent)|找不到.{0,30}命令|CLI 不存在或无法读取|command not found/i, "client_not_installed"],
    [/尚未.{0,25}(?:验证|核实|支持|接通)|还没有(?:接入|无界面)|暂不支持|不支持.{0,20}(?:工具|协议|来源)|隔离.{0,12}未验证/i, "capability_unavailable"],
    [/没有可用的模型|没有任何.{0,10}模型|还没有可用的模型|没有这个模型|没有这个模型来源|model.{0,40}(?:not found|unavailable|does not exist)|unknown model|no provider for model/i, "model_unavailable"],
    [/gateway.{0,20}(?:token|session|authentication)|会话.{0,12}(?:过期|失效|撤销|无效)|本地.{0,12}(?:令牌|凭据).{0,12}(?:失效|无效)/i, "session_invalid"],
    [/没有接受这个服务账号|没有拿到.{0,30}登录|登录.{0,20}(?:过期|失效|不见)|(?:密钥|令牌).{0,8}(?:无效|过期|失效)|请.{0,12}重新登录|invalid.{0,12}(?:api.?key|credential|token)|upstream authentication failed/i, "source_auth_required"],
    [/quota|rate.limit|too many requests|额度不足|用量上限|余额不足|请求过于频繁/i, "quota_limited"],
    [/timeout|timed out|请求超时|等待.{0,10}超时/i, "request_timeout"],
    [/fetch failed|failed to fetch|network.?error|上游连接失败|连接中断|连接失败|网络.{0,10}(?:不可用|失败)/i, "service_unavailable"],
    [/permission denied|forbidden|access denied|权限不足|没有权限|未获.{0,6}授权/i, "permission_denied"],
    [/无效|格式不|不能为空|请填写|请选择|需要名称|缺少.{0,10}(?:字段|参数)|不接受额外|too large|too long|context limit|rejected a request field|invalid request/i, "invalid_input"],
  ];
  const contexts = new Set(["local", "source", "session", "launch", "budget", "storage", "keychain", "request"]);
  function field(value, name) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
    try { const descriptor = Object.getOwnPropertyDescriptor(value, name); return descriptor && "value" in descriptor ? descriptor.value : undefined; }
    catch { return undefined; }
  }
  function short(value, max) { return typeof value === "string" && value.length <= max ? value : undefined; }
  function knownCode(value) { return dictionary.has(value) ? value : aliases.get(value); }
  function humanError(input, options) {
    const nested = field(input, "error");
    const object = nested && typeof nested === "object" ? nested : input;
    const context = contexts.has(field(options, "context")) ? field(options, "context") : contexts.has(field(input, "context")) ? field(input, "context") : undefined;
    const rawCode = short(field(input, "code"), 100) ?? short(field(object, "code"), 100) ?? short(field(object, "type"), 100) ?? short(field(input, "status"), 100);
    const rawStatus = field(input, "status") ?? field(input, "statusCode") ?? field(object, "status");
    const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : undefined;
    let code = knownCode(rawCode);
    if (!code && rawCode === "ENOENT") code = context === "launch" ? "client_not_installed" : context === "storage" ? "storage_unavailable" : undefined;
    const rawMessage = typeof input === "string" ? input : field(object, "message") ?? (typeof nested === "string" ? nested : field(input, "message"));
    const message = typeof rawMessage === "string" ? rawMessage.slice(0, 2048) : "";
    if (!code) code = legacy.find(([pattern]) => pattern.test(message))?.[1];
    if (!code && context === "keychain") code = "keychain_unavailable";
    if (!code && context === "storage") code = "storage_unavailable";
    if (!code && [408, 504].includes(status)) code = "request_timeout";
    if (!code && [400, 413, 422].includes(status)) code = "invalid_input";
    if (!code && status === 401) code = context === "source" ? "source_auth_required" : "session_invalid";
    if (!code && status === 403) code = "permission_denied";
    if (!code && status === 429) code = context === "local" || context === "session" || context === "launch" ? "request_busy" : "quota_limited";
    if (!code && status === 501) code = "capability_unavailable";
    if (!code && [502, 503].includes(status)) code = "service_unavailable";
    const entry = dictionary.get(code) ?? fallback;
    const details = { code: entry.code, ...(status ? { status } : {}) };
    if (rawCode && (knownCode(rawCode) || (rawCode === "ENOENT" && code))) details.technicalCode = rawCode;
    const osStatus = field(input, "osStatus") ?? field(object, "osStatus");
    if (entry.code === "keychain_unavailable" && Number.isSafeInteger(osStatus) && osStatus >= -100000 && osStatus <= 100000) details.osStatus = osStatus;
    return { code: entry.code, title: entry.title, reason: entry.reason, action: { ...entry.action }, message: `${entry.title}。${entry.reason}。请点击「${entry.action.label}」`, details };
  }
  function registeredErrors() { return entries.map(entry => ({ ...entry, action: { ...entry.action } })); }
  function requireRegisteredError(code) {
    if (!dictionary.has(code)) throw new RangeError("User-facing error code must be registered in the dictionary and wording standard");
    return humanError({ code });
  }
  const api = Object.freeze({ humanError, registeredErrors, requireRegisteredError });
  Object.defineProperty(root, "EasySwitchErrors", { value: api, configurable: true });
})(globalThis);
