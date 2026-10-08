/**
 * Independently collected coding-plan facts, checked 2026-10-08.
 * Product restrictions and documented syntax do not establish account access,
 * live operation, or provider approval of EasySwitch or arbitrary automation.
 * DIRECT denotes a published raw endpoint; DERIVED denotes a documented client
 * root plus the first-party SDK's /v1/messages operation. These are not probes.
 * MiniMax CN current-host evidence stays research-only: changing that default
 * would bypass the existing plan-usage reader. Current quota docs use a new
 * host/path; response-schema and credential-routing changes need separate review.
 * Missing public preset fields remain editorial omissions, not claims that the
 * provider has no such route. No legacy registry supplies these facts.
 */
import type { PresetFact, PresetFacts } from "./preset-facts.ts";

const checkedAt = "2026-10-08";
const sources = {
  zhipuMessages: { url: "https://docs.bigmodel.cn/cn/guide/develop/claude/introduction", title: "智谱 Claude API 兼容" },
  zhipuClaude: { url: "https://docs.bigmodel.cn/cn/coding-plan/tool/claude", title: "GLM Coding Plan Claude Code 接入" },
  zhipuTools: { url: "https://docs.bigmodel.cn/cn/coding-plan/tool/others", title: "GLM Coding Plan 接入工具" },
  zhipuPolicy: { url: "https://docs.bigmodel.cn/cn/coding-plan/usage-notes", title: "GLM Coding Plan 使用须知" },
  zaiClaude: { url: "https://docs.z.ai/devpack/tool/claude", title: "Z.AI GLM Coding Plan Claude Code" },
  zaiTools: { url: "https://docs.z.ai/devpack/tool/others", title: "Z.AI supported tools" },
  zaiOverview: { url: "https://docs.z.ai/devpack/overview", title: "Z.AI GLM Coding Plan overview" },
  zaiPolicy: { url: "https://docs.z.ai/devpack/usage-policy", title: "Z.AI Coding Plan usage policy" },
  zaiAuth: { url: "https://docs.z.ai/guides/develop/http/introduction", title: "Z.AI HTTP API introduction" },
  kimi: { url: "https://www.kimi.com/code/docs/en/", title: "Kimi Code documentation" },
  kimiClaude: { url: "https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html", title: "Kimi Code Claude Code integration" },
  kimiPolicy: { url: "https://www.kimi.com/code/docs/en/kimi-code/community-guidelines.html", title: "Kimi Code community guidelines" },
  kimiFaq: { url: "https://www.kimi.com/code/docs/en/kimi-code/faq.html", title: "Kimi Code FAQ" },
  minimaxCnMessages: { url: "https://platform.minimax.cn/docs/api-reference/text-chat-anthropic", title: "MiniMax CN Anthropic-compatible API" },
  minimaxCnChat: { url: "https://platform.minimax.cn/docs/api-reference/text-chat-openai", title: "MiniMax CN OpenAI-compatible API" },
  minimaxCnTools: { url: "https://platform.minimax.cn/docs/m-plan/other-tools", title: "MiniMax CN M Plan other tools" },
  minimaxCnFaq: { url: "https://platform.minimax.cn/docs/m-plan/faq", title: "MiniMax CN M Plan FAQ" },
  minimaxCnStart: { url: "https://platform.minimax.cn/docs/m-plan/quickstart", title: "MiniMax CN M Plan quickstart" },
  minimaxChat: { url: "https://platform.minimax.io/docs/api-reference/text-chat-openai", title: "MiniMax international OpenAI Chat Completions API" },
  minimaxMessages: { url: "https://platform.minimax.io/docs/api-reference/text-chat-anthropic", title: "MiniMax international Anthropic-compatible API" },
  minimaxStart: { url: "https://platform.minimax.io/docs/m-plan/quickstart", title: "MiniMax international M Plan quickstart" },
  minimaxFaq: { url: "https://platform.minimax.io/docs/m-plan/faq", title: "MiniMax M Plan FAQ" },
  minimaxTransition: { url: "https://platform.minimax.io/docs/m-plan/token-plan-notice", title: "MiniMax Token Plan transition notice" },
  volcenginePlan: { url: "https://docs.volcengine.com/docs/ark/coding-plan-personal-plan-overview?lang=zh", title: "Ark Coding Plan overview (updated 2026-09-29 15:26:06)" },
  volcengineClaude: { url: "https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-claude-code?lang=zh", title: "Ark Coding Plan Claude Code (updated 2026-09-28 17:07:22)" },
  volcengineOpenCode: { url: "https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-opencode?lang=en", title: "Ark Coding Plan OpenCode" },
  volcengineStart: { url: "https://docs.volcengine.com/docs/ark/coding-plan-personal-get-started?lang=zh", title: "Ark Coding Plan personal setup" },
  tencentStart: { url: "https://cloud.tencent.com/document/product/1823/130092", title: "Tencent Coding Plan quickstart (updated 2026-09-10 12:23:58)" },
  tencentTools: { url: "https://cloud.tencent.com/document/product/1823/130097", title: "Tencent Coding Plan tool setup (updated 2026-04-09 15:38:35)" },
  tencentPolicy: { url: "https://cloud.tencent.com/document/product/1823/130103", title: "Tencent Coding Plan usage policy (updated 2026-06-22 22:27:30)" },
  alibabaBase: { url: "https://help.aliyun.com/en/model-studio/base-url", title: "Model Studio Base URL overview" },
  alibabaClaude: { url: "https://help.aliyun.com/en/model-studio/claude-code", title: "Model Studio Claude Code integration" },
  alibabaMessages: { url: "https://help.aliyun.com/en/model-studio/anthropic-api-messages", title: "Model Studio Anthropic-compatible Messages API" },
  alibabaTeam: { url: "https://help.aliyun.com/zh/model-studio/token-plan-team-quickstart", title: "Alibaba Token Plan team quickstart" },
  alibabaPersonal: { url: "https://help.aliyun.com/zh/model-studio/token-plan-personal-overview", title: "Alibaba Token Plan personal overview" },
  alibabaFaq: { url: "https://help.aliyun.com/zh/model-studio/token-plan-personal-faq", title: "Alibaba Token Plan personal FAQ" },
  mimoStart: { url: "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access", title: "MiMo Token Plan quick access (updated 2026-09-21)" },
  mimoPlan: { url: "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription", title: "MiMo Token Plan subscription" },
  opencodeGo: { url: "https://docs.opencode.ai/docs/go/", title: "OpenCode Go" },
  claudeEnv: { url: "https://code.claude.com/docs/en/env-vars", title: "Claude Code environment variables" },
  anthropicSdk: { url: "https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/resources/messages/messages.py", title: "First-party Anthropic Python SDK Messages operation" },
} as const;

function fact<T>(value: T, sourceIds: Array<keyof typeof sources>, scope: string): PresetFact<T> {
  return { value, checkedAt, sources: sourceIds.map(id => sources[id]), scope };
}
function guide(id: keyof typeof sources): PresetFact<string> {
  return fact(sources[id].url, [id], "Official setup/key guide; no account access, credential creation or entitlement verification.");
}

export type AuditedSubscriptionPresetId = "zhipu-coding" | "zai" | "kimi-coding" | "minimax-coding-cn" | "minimax-coding" | "volcengine-coding" | "tencent-coding" | "alibaba-token-plan" | "mimo-token-plan" | "opencode-go";

export type SubscriptionPresetId = Exclude<AuditedSubscriptionPresetId, "minimax-coding-cn">;

export const SUBSCRIPTION_PRESET_FACTS: Record<SubscriptionPresetId, PresetFacts> = {
  "zhipu-coding": {
    baseUrl: fact("https://open.bigmodel.cn/api/coding/paas/v4", ["zhipuTools"], "Documented Coding Plan Chat base; /chat/completions is the operation. Separate from ordinary pay-as-you-go API."),
    anthropicBaseUrl: fact("https://open.bigmodel.cn/api/anthropic/v1", ["zhipuMessages"], "DIRECT: raw endpoint https://open.bigmodel.cn/api/anthropic/v1/messages. Remove only /messages for EasySwitch; the SDK root alone omits /v1."),
    modelId: fact("glm-5.3", ["zhipuMessages"], "Exact model ID in official Claude-compatible examples. Retained EasySwitch selection, not a recommendation or plan-entitlement guarantee."),
    keyGuide: guide("zhipuClaude"),
    authentication: fact({ header: "x-api-key", scheme: "raw", requirement: "Personal or team Coding Plan key for the corresponding subscriber" }, ["zhipuMessages", "zhipuClaude", "claudeEnv"], "x-api-key is the DIRECT raw Messages example, not a global Chat override. Claude Code ANTHROPIC_AUTH_TOKEN derives Authorization: Bearer; EasySwitch keeps its existing protocol-owned headers."),
    guidance: fact("国内 GLM Coding Plan；使用对应个人或团队套餐 Key，仅限官方列出的工具与产品环境，禁止共享账号；具体权益以套餐为准。", ["zhipuClaude", "zhipuTools", "zhipuPolicy"], "Subscriber-only supported tools/products; sharing, resale, relay/intermediation and arbitrage face policy review or bans. Protocol syntax does not establish provider approval of EasySwitch."),
  },
  zai: {
    baseUrl: fact("https://api.z.ai/api/coding/paas/v4", ["zaiTools"], "Documented Coding Plan Chat base, distinct from ordinary API billing."),
    anthropicBaseUrl: fact("https://api.z.ai/api/anthropic/v1", ["zaiClaude", "anthropicSdk"], "DERIVED: documented client root https://api.z.ai/api/anthropic plus the official SDK /v1/messages operation yields https://api.z.ai/api/anthropic/v1/messages. Not a vendor-published complete raw URL or live verification."),
    modelId: fact("glm-5.3", ["zaiOverview", "zaiClaude"], "Exact listed model; retained EasySwitch default despite differing vendor example/default mappings. No access promise."),
    keyGuide: guide("zaiClaude"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Z.AI subscriber API key" }, ["zaiAuth", "zaiClaude", "claudeEnv"], "Chat HTTP docs use Bearer. Messages Bearer is DERIVED from Claude Code ANTHROPIC_AUTH_TOKEN, not independent raw x-api-key evidence."),
    guidance: fact("国际 GLM Coding Plan；使用 Z.AI API Key，仅限官方支持的工具与产品环境，禁止共享账号；套餐额度与并发限制以账号为准。", ["zaiTools", "zaiPolicy"], "Subscriber-only supported tools; shared/multi-user use prohibited. Best-effort general agents do not imply unrestricted backend or arbitrary-tool permission."),
  },
  "kimi-coding": {
    baseUrl: fact("https://api.kimi.com/coding/v1", ["kimi", "kimiClaude"], "DIRECT: China Chat endpoint https://api.kimi.com/coding/v1/chat/completions. Overseas api.kimi.ai is a distinct regional choice, not substituted here."),
    anthropicBaseUrl: fact("https://api.kimi.com/coding/v1", ["kimi", "kimiClaude"], "DIRECT: https://api.kimi.com/coding/v1/messages; remove /messages for EasySwitch. The documented SDK root https://api.kimi.com/coding/ alone omits /v1."),
    modelId: fact("kimi-for-coding", ["kimi", "kimiFaq"], "Documented alias currently maps to K2.8 Preview; membership controls access and the backend/version is not fixed by this alias."),
    keyGuide: guide("kimiClaude"),
    authentication: fact({ header: "x-api-key", scheme: "raw", requirement: "Kimi Code dedicated key, separate from Moonshot pay-as-you-go" }, ["kimiClaude", "claudeEnv", "kimiFaq"], "Messages x-api-key is DERIVED from documented ANTHROPIC_API_KEY. Chat uses the OpenAI-compatible key workflow/Bearer convention; do not apply a global x-api-key override."),
    guidance: fact("Kimi Code 国内套餐端点，使用 Kimi Code 专用 Key；仅供个人交互式使用，模型和权益取决于会员档位，不能代替 Moonshot 按量 API。", ["kimiPolicy", "kimiFaq"], "Personal interactive use only; noninteractive scripted batches and data annotation prohibited. Enterprise integrations/commercial services are directed to Kimi Platform, with separate keys, endpoints and billing."),
  },
  "minimax-coding": {
    baseUrl: fact("https://api.minimax.io/v1", ["minimaxChat"], "DIRECT: raw https://api.minimax.io/v1/chat/completions endpoint. Subscription and pay-as-you-go key classes are distinct."),
    anthropicBaseUrl: fact("https://api.minimax.io/anthropic/v1", ["minimaxMessages"], "DIRECT: https://api.minimax.io/anthropic/v1/messages. EasySwitch requires /v1 in its base because it appends only /messages."),
    modelId: fact("MiniMax-M3", ["minimaxChat", "minimaxMessages", "minimaxStart", "minimaxTransition"], "Exact general API model enum, retained EasySwitch default. Current M Plan favors M3.1 Flash Preview; M3 subscription eligibility is not established for every plan."),
    keyGuide: guide("minimaxStart"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Dedicated Subscription Key; ordinary API keys consume pay-as-you-go balance" }, ["minimaxChat", "minimaxMessages", "minimaxStart", "minimaxFaq"], "Chat and Messages explicitly document Bearer; Messages documents Authorization precedence over x-api-key; SDK quickstarts use ANTHROPIC_API_KEY. No global authentication change required."),
    guidance: fact("MiniMax M Plan / 既有 Token Plan 使用专用 Subscription Key；面向个人交互开发，普通 API Key 走按量计费，模型与额度以套餐为准。", ["minimaxStart", "minimaxFaq", "minimaxTransition"], "M Plan replaces new Token Plan purchases; existing subscriptions may continue under migration terms. Personal interactive developer positioning and pay-as-you-go production recommendation do not establish unrestricted production permission or a categorical production ban."),
  },
  "volcengine-coding": {
    baseUrl: fact("https://ark.cn-beijing.volces.com/api/coding/v3", ["volcengineOpenCode"], "DIRECT: official OpenCode integration appends /chat/completions. Ordinary /api/v3 and Agent Plan are different products and may incur separate charges."),
    anthropicBaseUrl: fact("https://ark.cn-beijing.volces.com/api/coding/v1", ["volcengineClaude", "anthropicSdk"], "DERIVED: documented SDK root https://ark.cn-beijing.volces.com/api/coding plus official /v1/messages operation. Full https://ark.cn-beijing.volces.com/api/coding/v1/messages is not a vendor-published raw URL in the checked plan pages; no live request."),
    modelId: fact("ark-code-latest", ["volcengineClaude", "volcengineOpenCode"], "Documented selector follows the model configured in the console; not a fixed foundation-model ID. Auto is a console choice, not a literal request model substituted here."),
    keyGuide: guide("volcengineStart"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Ark Coding Plan key used at the plan-specific address" }, ["volcengineClaude", "claudeEnv"], "DERIVED from documented ANTHROPIC_AUTH_TOKEN and Claude Code's Bearer definition. No independent raw x-api-key claim or new override."),
    guidance: fact("方舟 Coding Plan，仅限官方允许的 AI 编程工具场景；使用套餐专用地址与 Key，ark-code-latest 跟随控制台选择，勿混用按量 API 或 Agent Plan 地址。", ["volcenginePlan", "volcengineClaude", "volcengineOpenCode"], "Personal development through allowed AI coding tools; ordinary API/non-tool use excluded and abuse can suspend or ban access. This does not establish approval of EasySwitch."),
  },
  "tencent-coding": {
    baseUrl: fact("https://api.lkeap.cloud.tencent.com/coding/v3", ["tencentStart", "tencentTools"], "Documented OpenAI-compatible base; /chat/completions composition is DERIVED, not a complete raw example. Documented Messages client root /coding/anthropic is intentionally not exposed as a new preset field."),
    modelId: fact("tc-code-latest", ["tencentStart", "tencentTools"], "Documented Auto selector, retained without freezing the changing catalog or selecting the soon-retiring glm-5/glm-5-0 models."),
    keyGuide: guide("tencentStart"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Coding Plan dedicated sk-sp- key, not a normal sk- prepaid/postpaid key" }, ["tencentStart", "tencentTools", "claudeEnv"], "Messages Bearer is DERIVED from ANTHROPIC_AUTH_TOKEN. Chat follows OpenAI-compatible workflow; no plan-specific raw Chat header example was located. Public preset retains its implicit runtime convention."),
    guidance: fact("腾讯云 Coding Plan 专用 sk-sp- Key，仅用于允许的个人编程工具场景；不用于自动化脚本、应用后端或非交互批量调用，tc-code-latest 自动选择模型。", ["tencentStart", "tencentPolicy"], "Personal supported coding-tool use only; automated scripts, custom application backends and noninteractive batches forbidden. Team/enterprise needs use other products. Guidance/key evidence is retained without adding absent public fields."),
  },
  "alibaba-token-plan": {
    baseUrl: fact("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", ["alibabaBase", "alibabaClaude"], "Documented Beijing Token Plan Chat base. Dedicated /apps/anthropic SDK root plus general Messages /v1/messages reference is DERIVED alternate-route evidence, intentionally not exposed as a new preset field."),
    modelId: fact("qwen3.8-max", ["alibabaClaude", "alibabaTeam"], "Exact model in personal/team mappings; retained EasySwitch choice even though current main guide selects auto. No plan-wide access guarantee."),
    keyGuide: guide("alibabaClaude"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Dedicated Token Plan sk-sp- key matched to the Token Plan endpoint" }, ["alibabaClaude", "alibabaMessages", "claudeEnv"], "Plan Messages Bearer is DERIVED from ANTHROPIC_AUTH_TOKEN; general Messages reference accepts Bearer or x-api-key but does not prove every plan's entitlement. Ordinary DashScope and Coding Plan credentials/endpoints are separate."),
    guidance: fact("阿里云 Token Plan 北京专用 Key 与地址；个人版仅供交互式编程或智能体工具使用，禁止共享、脚本批量或应用后端调用；不要与 Coding Plan 或按量 Key 混用。", ["alibabaPersonal", "alibabaFaq", "alibabaTeam", "alibabaBase"], "Personal plan is single-subscriber interactive-tool use, no sharing or noninteractive scripts/backends/batches. Official overview and FAQ conflict on quota windows and device count; do not hard-code either. Data-use terms may include service improvement/model optimization; no privacy guarantee. Team member-seat keys are not the universal personal workflow."),
  },
  "mimo-token-plan": {
    baseUrl: fact("https://token-plan-cn.xiaomimimo.com/v1", ["mimoStart"], "DIRECT: raw CN Chat example composes /chat/completions. Region must match the account's console cluster; other documented clusters are not silently substituted."),
    anthropicBaseUrl: fact("https://token-plan-cn.xiaomimimo.com/anthropic/v1", ["mimoStart"], "DIRECT: official raw example appends /v1/messages to https://token-plan-cn.xiaomimimo.com/anthropic; normalized EasySwitch base includes /v1."),
    modelId: fact("mimo-v2.6-pro", ["mimoStart", "mimoPlan"], "Exact example and personal-plan model-list entry. Other plan models or advertised features do not imply universal protocol/capability flags."),
    keyGuide: guide("mimoStart"),
    authentication: fact({ header: "api-key", scheme: "raw", requirement: "Dedicated valid tp-/ttp- subscription key, separate from sk- pay-as-you-go or MiMo Free credentials" }, ["mimoStart"], "DIRECT raw api-key authentication in both Chat and Messages quick-access examples. Preserve the existing cross-protocol wire override."),
    guidance: fact("MiMo Token Plan 专用 tp-/ttp- Key；按控制台选择套餐区域端点，仅用于允许的编程工具场景，不与按量 API 或 MiMo Free 混用。", ["mimoStart", "mimoPlan"], "Programming tools only; obvious non-coding automated scripts and custom backends disallowed. Key validity follows the subscription. General Batch API/marketing claims do not override plan-specific restrictions."),
  },
  "opencode-go": {
    baseUrl: fact("https://opencode.ai/zen/go/v1", ["opencodeGo"], "DIRECT: remove /chat/completions from the published kimi-k2.7-code endpoint. Other Go models use /messages; that does not establish Messages support for this selected Kimi model or justify an alternate endpoint field."),
    modelId: fact("kimi-k2.7-code", ["opencodeGo"], "Exact Go model is explicitly mapped to Chat Completions. Retain this selection without deriving provider-wide protocol capability from the mixed-model catalog."),
    keyGuide: guide("opencodeGo"),
    authentication: fact({ requirement: "OpenCode Go subscription API key" }, ["opencodeGo"], "UNVERIFIED raw HTTP header/scheme: checked Go documentation establishes an API-key requirement and SDK packages only. Existing implicit Bearer runtime is a compatibility choice, not independently verified Go evidence; do not borrow Zen-only auth examples or add an override."),
    guidance: fact("OpenCode Go 编程订阅；按模型使用对应协议，需符合编码代理流量规范并保留会话标识，模型、额度和客户端兼容性以官方说明为准。", ["opencodeGo"], "Normal coding-agent traffic requires a distinctive truthful client User-Agent and a stable per-conversation x-opencode-session or recognized native session header. Fake branded identity or a globally shared static session ID is inappropriate. Per-conversation forwarding needs separate review; a fixed preset header cannot establish end-to-end compatibility. Public note/key/alternate-route omissions are retained."),
  },
};

/** Research only; never spread into the active reconstruction collection. */
export const MINIMAX_CN_RESEARCH_FACTS: PresetFacts = {
  baseUrl: fact("https://api.minimax.cn/v1", ["minimaxCnChat", "minimaxCnStart"], "DIRECT: current documented CN /v1/chat/completions host. Research-only current host evidence: api.minimaxi.com is not proven broken and its current status is unverified. Keep the existing CN preset legacy until plan-usage and endpoint compatibility are checked; no stored-provider migration."),
  anthropicBaseUrl: fact("https://api.minimax.cn/anthropic/v1", ["minimaxCnMessages"], "DIRECT: https://api.minimax.cn/anthropic/v1/messages. This is the normalized current-host root only. Do not change the retained legacy preset or claim the older minimaxi.com host is invalid; its full raw endpoint was not independently verified."),
  modelId: fact("MiniMax-M3", ["minimaxCnChat", "minimaxCnMessages", "minimaxCnStart"], "Exact general API model enum; retained compatibility default. Current M Plan setup prioritizes MiniMax-M3.1-Flash-Preview, so API syntax does not guarantee the subscriber's M3 entitlement."),
  keyGuide: guide("minimaxCnStart"),
  authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Dedicated Subscription Key; an ordinary API key bills pay-as-you-go" }, ["minimaxCnChat", "minimaxCnMessages", "minimaxCnTools"], "Messages documents Authorization: Bearer and its precedence over x-api-key. SDK quickstarts use ANTHROPIC_API_KEY. Existing dual-header behavior needs no new override; Chat uses Bearer."),
  guidance: fact("国内 MiniMax 订阅使用专用 Subscription Key；普通 API Key 走按量计费。面向个人交互开发，模型与额度以所订套餐为准。", ["minimaxCnTools", "minimaxCnStart", "minimaxCnFaq"], "M Plan targets individual interactive development and recommends pay-as-you-go for production; do not turn that recommendation into a categorical ban. Existing Token Plan terms/quotas can differ."),
};

/** Discovery only: no reader, allowlist or destination is changed by this fact. */
export const MINIMAX_CN_QUOTA_RESEARCH = fact({
  endpoint: "https://www.minimax.cn/v1/token_plan/remains",
  header: "Authorization", scheme: "bearer",
}, ["minimaxCnFaq"], "DIRECT quota cURL uses a different host and path from the legacy api.minimaxi.com/v1/api/openplatform/coding_plan/remains reader. Response schema is not provided here; parsing, plan compatibility and credential-destination changes require separate review. No account request was made.");
