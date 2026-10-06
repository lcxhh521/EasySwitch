/**
 * Subscription integration review, 2026-10-06. See docs/subscription-support.md for sources.
 * A documented agent SDK/CLI is not a generic inference API. This module never reads credentials,
 * invokes a client, or accesses the network. A registry entry does not enable an adapter.
 */
export type SubscriptionVendor = "cursor" | "kiro" | "antigravity" | "gemini-cli" | "qoder" | "codebuddy" | "trae" | "amp" | "doubao" | "grok" | "minimax" | "kimi" | "droid";
export type SubscriptionSourceState = "not-implemented" | "not-verified" | "official-api-key" | "blocked-terms";

export interface OfficialAgentRoute {
  label: string;
  auth: string;
  billing: string;
  /** Full agent-session integration is absent; experimental text-only sources are described separately. */
  implementation: "not-implemented";
  docs: string[];
}

export interface OfficialModelApiRoute {
  label: string;
  presetIds: string[];
  auth: string;
  billing: string;
  /** Reuses the ordinary API-key transport. Not an OAuth/CLI-login import. */
  implementation: "existing-api-transport";
  verification: "documentation-only";
  docs: string[];
}

export interface SubscriptionSupport {
  vendor: SubscriptionVendor;
  label: string;
  reviewedAt: string;
  modelSource: { state: SubscriptionSourceState; available: boolean; reason: string };
  agentRoutes: OfficialAgentRoute[];
  apiRoutes?: OfficialModelApiRoute[];
  sources: string[];
}

const REVIEWED_AT = "2026-10-06";
const SUPPORT: SubscriptionSupport[] = [
  {
    vendor: "cursor", label: "Cursor", reviewedAt: REVIEWED_AT,
    modelSource: {
      state: "not-verified", available: false,
      reason: "已保留交接中的 Cursor 专用纯文字来源：独立登录、默认关闭，兼容层只做本地假服务验证。工具调用/多模态不完整，接口许可和真实账号仍待验收。官方 SDK 是另一个 agent 路径，不能把当前私有协议实现说成官方 SDK 接入。",
    },
    agentRoutes: [{
      label: "Cursor 官方 SDK", auth: "用户自行配置的 Cursor API Key",
      billing: "用户 Key 计入用户套餐；适用 Cursor 的请求池、价格和用量限制，并非无限或免费调用。",
      implementation: "not-implemented", docs: ["https://cursor.com/docs/sdk/typescript"],
    }],
    sources: ["https://cursor.com/docs/sdk/typescript", "https://cursor.com/terms-of-service"],
  },
  {
    vendor: "kiro", label: "Kiro", reviewedAt: REVIEWED_AT,
    modelSource: {
      state: "not-implemented", available: false,
      reason: "Kiro 官方支持 CLI 无界面调用和 ACP；没有核实到可供 EasySwitch 转发的通用模型 API。CLI 的 API Key 使用订阅额度，官方 agent 接入尚未实现。已保留独立开发的 B20 登录库适配器，但其接口支持依据、条款和真实账号验收仍待核实。",
    },
    agentRoutes: [
      {
        label: "Kiro CLI 无界面任务", auth: "由用户给官方 CLI 配置 KIRO_API_KEY",
        billing: "从 Kiro 订阅 credits 扣除；Key 适用于官方文档列出的付费套餐，仍受套餐限制。",
        implementation: "not-implemented",
        docs: ["https://kiro.dev/docs/getting-started/authentication/", "https://kiro.dev/docs/cli/headless/"],
      },
      {
        label: "Kiro ACP", auth: "由官方 Kiro CLI 管理登录；EasySwitch 不读取其令牌",
        billing: "通过 Kiro 自己的 agent 使用账号权益；ACP 不是额外赠送的模型额度。",
        implementation: "not-implemented", docs: ["https://kiro.dev/docs/cli/acp/"],
      },
    ],
    sources: ["https://kiro.dev/docs/getting-started/authentication/", "https://kiro.dev/docs/cli/acp/", "https://kiro.dev/license/", "https://aws.amazon.com/agreement/"],
  },
  {
    vendor: "antigravity", label: "Google Antigravity", reviewedAt: REVIEWED_AT,
    modelSource: {
      state: "blocked-terms", available: false,
      reason: "Antigravity 的个人服务条款明确禁止第三方工具复用其 OAuth，可能停用账号。已保留独立开发的 B20 实现，新增来源默认关闭；保留代码不代表条款许可或真实账号验收通过。官方 SDK 的 Gemini API Key 或企业方案属于另外的接入和计费方式。",
    },
    agentRoutes: [{
      label: "Antigravity 官方 SDK", auth: "用户自己的 Gemini API Key，或适用的 Google Cloud 企业凭据",
      billing: "按所选 API 或企业方案计费；不代表可以借用个人 Antigravity 订阅 OAuth。",
      implementation: "not-implemented", docs: ["https://www.antigravity.google/docs/sdk/overview"],
    }],
    sources: ["https://antigravity.google/terms", "https://www.antigravity.google/docs/sdk/overview"],
  },
  {
    vendor: "gemini-cli", label: "Gemini CLI", reviewedAt: REVIEWED_AT,
    modelSource: { state: "not-verified", available: false, reason: "Google AI Pro/Ultra 权益可通过 Gemini CLI 的官方 Google 登录使用；尚未核实可给 EasySwitch 转发的订阅通用模型 API。Gemini API Key 和 Vertex 按各自配额与计费使用，不读取 CLI OAuth。" },
    agentRoutes: [{ label: "Gemini CLI 无界面 / ACP", auth: "由用户在官方 CLI 登录 Google 账号", billing: "适用账号的 Gemini CLI / Code Assist 配额；API Key 与 Vertex 是另外的计费路径。", implementation: "not-implemented", docs: ["https://geminicli.com/docs/get-started/authentication/", "https://geminicli.com/docs/resources/quota-and-pricing/"] }],
    sources: ["https://geminicli.com/docs/get-started/authentication/", "https://geminicli.com/docs/resources/quota-and-pricing/"],
  },
  {
    vendor: "qoder", label: "Qoder", reviewedAt: REVIEWED_AT,
    modelSource: { state: "not-verified", available: false, reason: "已接实验性 Qoder CLI 纯文字桥，默认关闭、使用用户提供的 PAT；真实 CLI 未验收。工具/媒体不支持，CLI 自有 agent 行为，不能视为通用模型 API 或完整 agent SDK 接入。" },
    agentRoutes: [{ label: "Qoder CLI / Agent SDK", auth: "官方 CLI 登录，或用户提供 QODER_PERSONAL_ACCESS_TOKEN", billing: "Qoder 账号 Credits 与相应套餐限制。", implementation: "not-implemented", docs: ["https://docs.qoder.com/cli/sdk/authentication", "https://docs.qoder.com/cli/sdk/how-it-works"] }],
    sources: ["https://docs.qoder.com/cli/sdk/authentication", "https://docs.qoder.com/cli/sdk/how-it-works", "https://docs.qoder.com/cli/usage"],
  },
  {
    vendor: "codebuddy", label: "CodeBuddy", reviewedAt: REVIEWED_AT,
    modelSource: { state: "not-verified", available: false, reason: "已接实验性 CodeBuddy CLI 纯文字桥，默认关闭、须明确国际/国内版和 API Key；真实 CLI 未验收。它不是通用模型 API、完整 agent SDK 或 WorkBuddy 私有订阅接口；原有 BASE_URL 启动器仍是相反方向。" },
    agentRoutes: [{ label: "CodeBuddy Code / Agent SDK（预览）", auth: "官方 CLI 登录或匹配国内/国际版的 CODEBUDDY_API_KEY", billing: "按 CodeBuddy 账号权益和 Credits；不能假定 Key 等于按 token 的通用模型额度。", implementation: "not-implemented", docs: ["https://www.codebuddy.ai/docs/cli/sdk", "https://www.codebuddy.ai/docs/cli/env-vars"] }],
    sources: ["https://www.codebuddy.ai/docs/cli/sdk", "https://www.codebuddy.ai/docs/cli/env-vars", "https://www.codebuddy.ai/pricing/"],
  },
  {
    vendor: "trae", label: "TRAE", reviewedAt: REVIEWED_AT,
    modelSource: { state: "not-verified", available: false, reason: "已查的官方公开资料未建立 TRAE 订阅导出的 API；企业页面的 TraeCode CLI 仍标为即将推出。开源 trae-agent 使用另外提供的模型 Key，不是 TRAE 订阅复用。" },
    agentRoutes: [],
    sources: ["https://www.trae.ai/enterprise", "https://github.com/bytedance/trae-agent", "https://www.trae.ai/pricing"],
  },
  {
    vendor: "amp", label: "Amp", reviewedAt: REVIEWED_AT,
    modelSource: { state: "not-verified", available: false, reason: "Amp CLI/SDK 是运行 Amp 自己的 agent；External API 管理工作区，并非通用模型推理接口。尚未核实把 Amp 额度导出给任意 harness 的官方协议。" },
    agentRoutes: [{ label: "Amp CLI / SDK", auth: "官方 Amp 登录或用户提供 AMP_API_KEY", billing: "默认使用 Amp 用量/credits；若在 Amp 配置外部来源，则由对应来源计费。", implementation: "not-implemented", docs: ["https://ampcode.com/docs/sdk", "https://ampcode.com/docs/customize/model-routing"] }],
    sources: ["https://ampcode.com/docs/sdk", "https://ampcode.com/docs/pricing", "https://ampcode.com/api/external", "https://ampcode.com/docs/customize/model-routing"],
  },
  {
    vendor: "doubao", label: "豆包", reviewedAt: REVIEWED_AT,
    modelSource: { state: "not-verified", available: false, reason: "豆包模型有火山方舟 API；豆包 App 会员/登录不能据此当成 Ark Key。尚未核实消费者订阅导出。Ark Coding Plan 仅限 AI 编程工具，不能用于任意通用 API 场景。" },
    agentRoutes: [],
    apiRoutes: [{ label: "火山方舟 API（另行计费）", presetIds: ["volcengine"], auth: "用户自行提供的 ARK_API_KEY", billing: "火山方舟 API 计费，非豆包 App 会员额度。", implementation: "existing-api-transport", verification: "documentation-only", docs: ["https://docs.volcengine.com/docs/ark/quick-start?lang=zh"] }],
    sources: ["https://docs.volcengine.com/docs/ark/quick-start?lang=zh", "https://docs.volcengine.com/docs/ark/doubao-assistant?lang=zh", "https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh"],
  },
  {
    vendor: "grok", label: "Grok / xAI", reviewedAt: REVIEWED_AT,
    modelSource: { state: "not-verified", available: false, reason: "Grok Build 提供官方 CLI/无界面/ACP；SuperGrok FAQ 已把 API 列入共享周用量，不能声称订阅永不含 API。但尚未核实 EasySwitch 可用的通用订阅 OAuth 接入；现有 xAI 预设只接受用户提供的官方 API Key。" },
    agentRoutes: [{ label: "Grok Build CLI / ACP", auth: "由官方 Grok Build 管理浏览器登录，或用户提供 XAI_API_KEY", billing: "按登录账号权益或 API Key 对应账单；不可自动等同。", implementation: "not-implemented", docs: ["https://docs.x.ai/build/overview", "https://docs.x.ai/build/cli/headless-scripting"] }],
    apiRoutes: [{ label: "xAI API Key", presetIds: ["xai"], auth: "用户自己的 xAI 控制台 API Key", billing: "按该 Key 的 API 账号计费；不声明自动借出 SuperGrok OAuth。", implementation: "existing-api-transport", verification: "documentation-only", docs: ["https://docs.x.ai/developers/quickstart"] }],
    sources: ["https://docs.x.ai/build/overview", "https://docs.x.ai/build/cli/headless-scripting", "https://docs.x.ai/developers/quickstart", "https://docs.x.ai/grok/faq"],
  },
  {
    vendor: "minimax", label: "MiniMax", reviewedAt: REVIEWED_AT,
    modelSource: { state: "official-api-key", available: true, reason: "官方 M Plan（旧称 Token/Coding Plan）支持兼容 AI 工具使用专用 Subscription Key。选择 MiniMax 套餐预设并手动提供该 Key；普通 API Key 扣按量余额，不能自动互换，也不读取 MiniMax 原生登录。" },
    agentRoutes: [{ label: "MiniMax 官方 CLI", auth: "用户按官方 CLI 指南配置账号/Key", billing: "取决于使用的 Subscription Key 或普通 API Key。", implementation: "not-implemented", docs: ["https://platform.minimax.io/docs/m-plan/minimax-cli"] }],
    apiRoutes: [{ label: "MiniMax M Plan / Token Plan", presetIds: ["minimax-coding", "minimax-coding-cn"], auth: "对应区域的专用 Subscription Key", billing: "套餐用量与适用的加油包；普通 API Key 使用按量余额。面向个人交互式开发，生产服务应使用按量 API。", implementation: "existing-api-transport", verification: "documentation-only", docs: ["https://platform.minimax.io/docs/m-plan/faq", "https://platform.minimax.io/docs/token-plan/faq"] }],
    sources: ["https://platform.minimax.io/docs/m-plan/faq", "https://platform.minimax.io/docs/token-plan/faq", "https://platform.minimax.io/docs/m-plan/minimax-cli"],
  },
  {
    vendor: "kimi", label: "Kimi", reviewedAt: REVIEWED_AT,
    modelSource: { state: "official-api-key", available: true, reason: "Kimi Code 官方提供第三方工具专用 coding Key，权益以账号/区域为准，不等于 Moonshot 按量余额。另已保留交接中的设备码登录实现及客户端头，默认关闭、仅假服务验证；API Key 的支持依据不能自动证明该 OAuth 身份路径获得厂商许可。" },
    agentRoutes: [{ label: "Kimi Code CLI / ACP", auth: "由官方 CLI 管理 OAuth 登录", billing: "按 Kimi Code 对应账号权益；国内外套餐和 API 余额边界不同。", implementation: "not-implemented", docs: ["https://www.kimi.com/code/docs/en/kimi-code/faq.html"] }],
    apiRoutes: [{ label: "Kimi Code 专用 Key", presetIds: ["kimi-coding"], auth: "Kimi Code Key；不是 Moonshot 开放平台 Key", billing: "相应 Kimi Code 套餐权益；不增加开放平台余额，不保证所有区域会员通用。", implementation: "existing-api-transport", verification: "documentation-only", docs: ["https://www.kimi.com/en/help/kimi-code/membership-guide", "https://www.kimi.com/code/docs/en/kimi-code/faq.html"] }],
    sources: ["https://www.kimi.com/en/help/kimi-code/membership-guide", "https://www.kimi.com/code/docs/en/kimi-code/faq.html", "https://www.kimi.ai/help/kimi-api/api-troubleshooting"],
  },
  {
    vendor: "droid", label: "Factory Droid", reviewedAt: REVIEWED_AT,
    modelSource: { state: "not-verified", available: false, reason: "Factory 套餐明确提供 Droid CLI/SDK；FACTORY_API_KEY 是官方 agent/平台凭据。尚未核实可当作 OpenAI 兼容推理 Key 的订阅导出接口；BYOK 是另外的模型和计费路径。" },
    agentRoutes: [{ label: "Droid CLI 无界面 / SDK", auth: "官方 CLI 登录或用户提供 FACTORY_API_KEY", billing: "套餐速率限制及可选额外用量；BYOK 另有套餐条件/费用。", implementation: "not-implemented", docs: ["https://docs.factory.com/sdk/python", "https://docs.factory.com/droid-exec/overview"] }],
    sources: ["https://docs.factory.ai/pricing/individuals", "https://docs.factory.com/sdk/python", "https://docs.factory.com/droid-exec/overview", "https://docs.factory.com/model-independence/byok"],
  },
];

/** Public, secret-free metadata. Callers cannot mutate the policy through the returned objects. */
export function subscriptionSupport(): SubscriptionSupport[] { return structuredClone(SUPPORT); }

function supportFor(value: unknown): SubscriptionSupport | undefined {
  return typeof value === "string" ? SUPPORT.find(s => s.vendor === value.trim().toLowerCase()) : undefined;
}

/** Compatible with the existing capability matrix; documented research is not implemented code. */
export function subscriptionSourceCapability(vendor: SubscriptionVendor): { state: "todo" | "impossible" | "documented"; note: string } {
  const support = SUPPORT.find(s => s.vendor === vendor)!;
  return { state: support.modelSource.state === "blocked-terms" ? "impossible" : support.modelSource.state === "official-api-key" ? "documented" : "todo", note: support.modelSource.reason };
}

export interface SubscriptionSourceIssue {
  status: 400 | 501;
  code: "invalid_subscription_source" | "subscription_source_unavailable";
  message: string;
  vendor?: SubscriptionVendor;
}

function unavailable(support: SubscriptionSupport): SubscriptionSourceIssue {
  return { status: 501, code: "subscription_source_unavailable", message: support.modelSource.reason, vendor: support.vendor };
}

function invalid(): SubscriptionSourceIssue {
  // Never echo untrusted mode strings, provider metadata, local paths, or credential values.
  return { status: 400, code: "invalid_subscription_source", message: "这个订阅接入方式无效或尚未实现，请选择已提供的登录方式。" };
}

/**
 * Reject incomplete WIP/unsupported subscription providers before key lookup or network I/O.
 * Ordinary API providers may be called Cursor/Kiro/etc. or use flat subscription billing;
 * neither their display names nor billing models imply native subscription authentication.
 */
export function subscriptionSourceIssue(provider: unknown): SubscriptionSourceIssue | undefined {
  if (!provider || typeof provider !== "object" || Array.isArray(provider)) return undefined;
  const p = provider as Record<string, unknown>;
  // Reserved adapter configuration keys used by subscription imports, including the Kiro WIP.
  // Merely having a key is enough: malformed or empty metadata must not select ordinary API I/O.
  for (const support of SUPPORT) if (Object.hasOwn(p, support.vendor)) return unavailable(support);
  if (!Object.hasOwn(p, "plan") || p.plan === undefined) return undefined;
  if (!p.plan || typeof p.plan !== "object" || Array.isArray(p.plan)) return invalid();
  const kind = (p.plan as Record<string, unknown>).kind;
  const support = supportFor(kind);
  if (support) return unavailable(support);
  if (kind !== "chatgpt" && kind !== "codex" && kind !== "copilot") return invalid();
  return undefined;
}

/** Unknown sign-in modes must never fall through into a different vendor's login flow. */
export function subscriptionSignInIssue(mode: unknown): SubscriptionSourceIssue | undefined {
  if (mode === undefined || mode === "open" || mode === "codex" || mode === "copilot") return undefined;
  const support = supportFor(mode);
  return support ? unavailable(support) : invalid();
}
