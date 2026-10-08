/**
 * Independently audited official endpoint, model and setup facts, checked 2026-10-08.
 * Seventeen international/gateway presets are reconstructed from this bounded input.
 * Cline remains legacy: its exact existing gateway model ID was not verified.
 * PackyAPI/OpenCode Zen establish API-key requirements only; missing raw HTTP
 * header/scheme facts are intentional. Unchanged runtime defaults are not evidence.
 * Documentation does not establish live availability, entitlement or a universal
 * negotiated protocol set. No third-party registry supplies these facts.
 */
import type { PresetFact, PresetFacts } from "./preset-facts.ts";

const checkedAt = "2026-10-08";
const sources = {
  xai: {"url": "https://docs.x.ai/developers/quickstart", "title": "xAI API quickstart"},
  xaiAuth: {"url": "https://docs.x.ai/developers/rest-api-reference/inference", "title": "xAI REST API reference"},
  mistral: {"url": "https://docs.mistral.ai/api/endpoint/models", "title": "Mistral Models endpoints"},
  mistralModel: {"url": "https://docs.mistral.ai/vibe/code/cli/configuration", "title": "Mistral Vibe provider and model configuration"},
  mistralKey: {"url": "https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request", "title": "Mistral first API request"},
  meta: {"url": "https://dev.meta.ai/docs/overview", "title": "Meta Model API overview"},
  metaKey: {"url": "https://dev.meta.ai/docs/quickstart", "title": "Meta Model API quickstart"},
  zenmux: {"url": "https://zenmux.ai/docs/guide/quickstart", "title": "ZenMux quickstart"},
  vercel: {"url": "https://vercel.com/docs/ai-gateway/authentication-and-byok", "title": "Vercel AI Gateway authentication and BYOK"},
  vercelApis: {"url": "https://vercel.com/docs/ai-gateway/sdks-and-apis", "title": "Vercel AI Gateway SDKs and APIs"},
  huggingface: {"url": "https://huggingface.co/docs/inference-providers/index", "title": "Hugging Face Inference Providers"},
  packy: {"url": "https://docs.packyapi.com/docs/cli/3-codex.html", "title": "PackyAPI Codex configuration"},
  packyEndpoints: {"url": "https://docs.packyapi.com/docs/register/6-cli.html", "title": "PackyAPI endpoint instructions"},
  packyKey: {"url": "https://docs.packyapi.com/docs/register/4-token.html", "title": "PackyAPI token setup"},
  bizAuth: {"url": "https://bizrouter.ai/docs/authentication", "title": "BizRouter authentication"},
  bizChat: {"url": "https://bizrouter.ai/docs/chat-completions", "title": "BizRouter Chat Completions"},
  bizResponses: {"url": "https://bizrouter.ai/docs/responses", "title": "BizRouter Responses"},
  orcaModel: {"url": "https://www.orcarouter.ai/models/openai/gpt-5.5", "title": "OrcaRouter GPT-5.5 model"},
  orcaFormats: {"url": "https://docs.orcarouter.ai/native-formats/openai-compat", "title": "OrcaRouter OpenAI-compatible HTTP"},
  orcaKey: {"url": "https://docs.orcarouter.ai/getting-started/get-api-key", "title": "OrcaRouter API key setup"},
  tokenModel: {"url": "https://tokenlab.sh/en/models/gpt-5-6/gpt-5.6-terra", "title": "TokenLab GPT-5.6 Terra model"},
  tokenFormats: {"url": "https://tokenlab.sh/docs/en/guides/api-formats", "title": "TokenLab API formats"},
  tokenGetModel: {"url": "https://tokenlab.sh/docs/en/api-reference/models/get-model", "title": "TokenLab get a model"},
  tokenKey: {"url": "https://tokenlab.sh/docs/en/quickstart", "title": "TokenLab quickstart"},
  openGateway: {"url": "https://opengateway.ai/docs/reference/guides/overview", "title": "OpenGateway API reference overview"},
  openGatewayCodex: {"url": "https://opengateway.ai/docs/coding-agents/codex", "title": "OpenGateway Codex integration"},
  openGatewayKey: {"url": "https://opengateway.ai/docs/platform/api-keys", "title": "OpenGateway API keys"},
  nanoHosts: {"url": "https://docs.nano-gpt.com/api-reference/miscellaneous/api-hosts", "title": "NanoGPT API hosts"},
  nanoAuth: {"url": "https://docs.nano-gpt.com/authentication", "title": "NanoGPT authentication"},
  opencode: {"url": "https://docs.opencode.ai/docs/zen/", "title": "OpenCode Zen"},
  kilo: {"url": "https://kilo.ai/docs/gateway", "title": "Kilo Gateway"},
  kiloReference: {"url": "https://kilo.ai/docs/gateway/api-reference", "title": "Kilo Gateway API reference"},
  kiloKey: {"url": "https://kilo.ai/docs/getting-started/setup-authentication", "title": "Kilo authentication setup"},
  kiloAuth: {"url": "https://kilo.ai/docs/gateway/authentication", "title": "Kilo Gateway authentication"},
  vertexGuide: {"url": "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-3-5-flash", "title": "Google Gemini 3.5 Flash development guide"},
  vertexModel: {"url": "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash", "title": "Google Gemini 3.5 Flash model"},
  vertexAuth: {"url": "https://docs.cloud.google.com/gemini-enterprise-agent-platform/machine-learning/authentication", "title": "Google Cloud authentication"},
  vertexToken: {"url": "https://docs.cloud.google.com/docs/authentication/token-types", "title": "Google Cloud token types"},
  express: {"url": "https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/express-mode/api-reference", "title": "Google Cloud Express REST API"},
  expressModel: {"url": "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/express-mode/overview", "title": "Google Cloud Express overview"},
  expressKey: {"url": "https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys", "title": "Google Cloud API keys"},
  expressHeader: {"url": "https://github.com/googleapis/go-genai/blob/main/api_client.go", "title": "First-party Google Gen AI Go SDK API client"},
  cfOpenai: {"url": "https://developers.cloudflare.com/ai-gateway/usage/providers/openai/", "title": "Cloudflare AI Gateway OpenAI provider"},
  cfAnthropic: {"url": "https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/", "title": "Cloudflare AI Gateway Anthropic provider"},
  cfAuth: {"url": "https://developers.cloudflare.com/ai-gateway/configuration/authentication/", "title": "Cloudflare AI Gateway authentication"},
} as const;

function fact<T>(value: T, sourceIds: Array<keyof typeof sources>, scope: string): PresetFact<T> {
  return { value, checkedAt, sources: sourceIds.map(id => sources[id]), scope };
}

export type GatewayPresetId = "xai" | "mistral" | "meta" | "zenmux" | "vercel" | "huggingface" | "packycode" | "bizrouter" | "orcarouter" | "tokenlab" | "opengateway" | "nanogpt" | "opencode-zen" | "kilo" | "vertex" | "vertex-express" | "cloudflare-ai-gateway";

export const GATEWAY_PRESET_FACTS: Record<GatewayPresetId, PresetFacts> = {
  "xai": {
    baseUrl: fact("https://api.x.ai/v1", ["xai"], "Exact OpenAI-client base and /v1/responses example. No model capabilities or account entitlement inferred."),
    keyGuide: fact("https://docs.x.ai/developers/quickstart", ["xai"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "xAI inference API key"}, ["xaiAuth"], "Inference key, not separate management key."),
    guidance: fact("Grok 官方 API，使用 xAI API Key；具体模型与权限以账号为准。", ["xai", "xaiAuth"], "Independent setup guidance; no default model chosen."),
  },
  "mistral": {
    baseUrl: fact("https://api.mistral.ai/v1", ["mistral"], "Derived from official /v1/models endpoint."),
    modelId: fact("codestral-latest", ["mistralModel"], "Exact chat-capable model ID is listed; selecting it is an EasySwitch default choice, not a vendor recommendation."),
    keyGuide: fact("https://docs.mistral.ai/getting-started/quickstarts/developer/first-api-request", ["mistralKey"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "Mistral API key"}, ["mistral"], "Official cURL bearer authentication."),
    guidance: fact("使用 Mistral API Key；codestral-latest 是官方列出的代码模型别名，实际可用性以账号为准。", ["mistral", "mistralModel"], "Independently written key and model guidance."),
  },
  "meta": {
    baseUrl: fact("https://api.meta.ai/v1", ["meta", "metaKey"], "OpenAI-compatible base documented for Responses and Chat."),
    modelId: fact("muse-spark-1.3", ["meta", "metaKey"], "Exact standard-tier model ID, not contributor variant."),
    keyGuide: fact("https://dev.meta.ai/docs/quickstart", ["metaKey"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "Meta Model API key"}, ["metaKey"], "Official Responses cURL authentication."),
    guidance: fact("使用 Meta Model API Key；模型填 muse-spark-1.3，按账号的访问权限和 API 计费设置使用。", ["meta", "metaKey"], "Independently written guidance; no consumer subscription or entitlement inference."),
  },
  "zenmux": {
    baseUrl: fact("https://zenmux.ai/api/v1", ["zenmux"], "Documented Chat and Responses base; per-model protocol support must be checked separately."),
    keyGuide: fact("https://zenmux.ai/docs/guide/quickstart", ["zenmux"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "ZenMux API key for the chosen usage plan"}, ["zenmux"], "Official Chat cURL uses Authorization bearer. Management keys are separate."),
    guidance: fact("使用对应计费方案的 ZenMux API Key，模型按平台的 provider/model-name 标识填写；协议支持以所选模型为准。", ["zenmux"], "Avoid the same page's broad all-model cross-protocol marketing claim; its Anthropic section explicitly says models are adapted in batches."),
  },
  "vercel": {
    baseUrl: fact("https://ai-gateway.vercel.sh/v1", ["vercel", "vercelApis"], "Documented Chat and Responses SDK base."),
    keyGuide: fact("https://vercel.com/docs/ai-gateway/authentication-and-byok", ["vercel"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "AI Gateway API key or Vercel OIDC token"}, ["vercel"], "Vercel request authentication is always required. BYOK provider credentials do not replace gateway authentication."),
    guidance: fact("使用 Vercel AI Gateway API Key；模型按网关标识填写。即使配置了 BYOK，也仍需网关鉴权。", ["vercel"], "Key workflow appropriate to manual desktop-client configuration; do not imply automatic OIDC provisioning."),
  },
  "huggingface": {
    baseUrl: fact("https://router.huggingface.co/v1", ["huggingface"], "Exact documented OpenAI-compatible router base; this surface is documented for chat completion tasks only."),
    keyGuide: fact("https://huggingface.co/docs/inference-providers/index", ["huggingface"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "Hugging Face fine-grained token with Make calls to Inference Providers permission"}, ["huggingface"], "Exact permission named in official authentication guide and Bearer in direct HTTP example."),
    guidance: fact("使用具有 Inference Providers 调用权限的 Hugging Face Token；这里连接 Chat Completions 兼容接口，模型可用性取决于推理服务商。", ["huggingface"], "No Responses, Anthropic, image-generation or universal-model compatibility inferred."),
  },
  "packycode": {
    baseUrl: fact("https://cf.api.fan/v1", ["packy", "packyEndpoints"], "Exact current Codex base; official tutorial specifies Responses. Do not copy tutorial requires_openai_auth behavior into EasySwitch or use any account."),
    modelId: fact("gpt-5.5", ["packy"], "Exact ID in current Windows tutorial; macOS example is stale and internally contradicted by retirement warning."),
    keyGuide: fact("https://docs.packyapi.com/docs/register/4-token.html", ["packyKey"], "Verified public official key/setup guide. No console access, key generation or account availability test."),
    authentication: fact({"requirement": "PackyAPI Codex-group API key"}, ["packy", "packyKey"], "Codex OPENAI_API_KEY configuration is directly established. Images API bearer header is not generalized into a claimed raw Responses header fact; no wire override added."),
    guidance: fact("使用 PackyAPI 的 Codex 分组令牌；gpt-5.5 是当前教程示例，实际可用模型以控制台 Codex 分组为准。", ["packy", "packyKey"], "Independent group-specific API-key guidance, not an instruction to read or write native auth files."),
  },
  "bizrouter": {
    baseUrl: fact("https://api.bizrouter.ai/v1", ["bizAuth", "bizChat", "bizResponses"], "Current official docs base, distinct from older docs.bizrouter.ai example. Some current page evidence came from official search-index text when page extraction omitted body."),
    modelId: fact("openai/gpt-5.6-sol", ["bizResponses"], "Exact model string in current official Responses example; account scope/org policies still apply."),
    keyGuide: fact("https://bizrouter.ai/docs/authentication", ["bizAuth"], "Verified public official key/setup guide. No console access, key generation or account availability test."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "BizRouter model-service API key (sk-br-v1-), not usage-only key"}, ["bizAuth"], "Bearer preferred; X-API-Key documented legacy and subordinate if both sent. No new wire override required."),
    guidance: fact("使用 BizRouter 模型服务 API Key，保留模型 ID 的 openai/ 前缀；可用模型受密钥权限和组织策略限制。", ["bizAuth", "bizResponses"], "Does not imply catalog visibility guarantees live availability."),
  },
  "orcarouter": {
    baseUrl: fact("https://api.orcarouter.ai/v1", ["orcaModel", "orcaFormats"], "Exact OpenAI-compatible base; /chat/completions and /responses documented."),
    modelId: fact("openai/gpt-5.5", ["orcaModel"], "Exact model page ID and endpoint examples."),
    keyGuide: fact("https://docs.orcarouter.ai/getting-started/get-api-key", ["orcaKey"], "Verified public official key/setup guide. No console access, key generation or account availability test."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "OrcaRouter API key"}, ["orcaKey", "orcaFormats"], "Official bearer scheme; gateway keys, not underlying provider keys."),
    guidance: fact("使用 OrcaRouter API Key，模型 ID 填写 openai/gpt-5.5；按客户端要求选择已支持的请求协议。", ["orcaModel", "orcaFormats"], "Per-model and gateway documentation establishes syntax, not live account entitlement."),
  },
  "tokenlab": {
    baseUrl: fact("https://api.tokenlab.sh/v1", ["tokenModel", "tokenFormats"], "Exact OpenAI-compatible base with Responses example."),
    modelId: fact("gpt-5.6-terra", ["tokenModel", "tokenGetModel"], "Exact ID; Get Model example lists openai_chat_completions and openai_responses. Other gateway formats do not establish support for this model."),
    keyGuide: fact("https://tokenlab.sh/docs/en/quickstart", ["tokenKey"], "Verified public official key/setup guide. No console access, key generation or account availability test."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "Complete TokenLab API key, not displayed prefix"}, ["tokenFormats", "tokenKey"], "Official bearer scheme. Full key shown once in Workspace API Keys."),
    guidance: fact("填写 TokenLab 的完整 API Key，不能只复制列表里的前缀；gpt-5.6-terra 支持 Chat Completions 和 Responses，其他模型请核对 API 格式。", ["tokenKey", "tokenGetModel"], "Independent key/setup and exact-model format guidance; no global protocol flags."),
  },
  "opengateway": {
    baseUrl: fact("https://apis.opengateway.ai/v1", ["openGateway", "openGatewayCodex"], "Inference SDK base, not the opengateway.ai/api/v1 resource-management surface."),
    keyGuide: fact("https://opengateway.ai/docs/platform/api-keys", ["openGatewayKey"], "Verified public official key/setup guide. No console access, key generation or account availability test."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "OpenGateway team API key"}, ["openGateway", "openGatewayKey"], "Inference bearer authentication. Key availability can depend on team status/balance."),
    guidance: fact("使用 OpenGateway 团队 API Key，并从模型目录选择模型；团队余额不足时密钥可能被暂停。", ["openGatewayKey", "openGatewayCodex"], "No default selected; Codex tutorial model is explicitly an example, not a universal default."),
  },
  "nanogpt": {
    baseUrl: fact("https://nano-gpt.com/api/v1", ["nanoHosts"], "Existing website-host endpoint remains explicitly documented; preserve it in bounded reconstruction. Current docs recommend api.nano-gpt.com for new API-key integrations, with potentially different rollout catalogs."),
    keyGuide: fact("https://docs.nano-gpt.com/authentication", ["nanoAuth"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "NanoGPT inference API key"}, ["nanoAuth"], "Authorization Bearer recommended; X-API-Key raw also accepted. Management-only tokens are not inference keys."),
    guidance: fact("使用 NanoGPT 推理 API Key；此预设保留网站域名接口。官方建议新集成使用 api.nano-gpt.com，两个域名的模型列表可能暂时不同。", ["nanoAuth", "nanoHosts"], "Explicitly qualifies existing endpoint without automatically changing saved or new provider behavior."),
  },
  "opencode-zen": {
    baseUrl: fact("https://opencode.ai/zen/v1", ["opencode"], "Derived from official model-specific Chat, Responses, Messages and Gemini endpoint table. Protocol is model-dependent."),
    keyGuide: fact("https://docs.opencode.ai/docs/zen/", ["opencode"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"requirement": "OpenCode Zen API key"}, ["opencode"], "API-key requirement established. Public page's explicit Authorization Bearer example is for /systemone only; exact Chat/Responses header verification is intentionally not claimed."),
    guidance: fact("使用 OpenCode Zen API Key；模型 ID 和接口按官方模型表选择，不同模型使用的协议可能不同。", ["opencode"], "No universal Chat support, default model, free tier entitlement or live availability inferred."),
  },
  "kilo": {
    baseUrl: fact("https://api.kilo.ai/api/gateway", ["kilo", "kiloReference"], "Exact base; append /chat/completions or /models directly, never insert /v1."),
    keyGuide: fact("https://kilo.ai/docs/getting-started/setup-authentication", ["kiloKey"], "Verified public official key/setup guide. No console access, key generation or account availability test."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "Kilo Gateway API key, documented as account-bound JWT"}, ["kiloAuth"], "Gateway key sent bearer. Organization header exists but do not invent organization ID."),
    guidance: fact("从 Kilo 个人资料页获取 Gateway API Key；接口地址不要追加 /v1。公开文档确认 Chat Completions，Responses 兼容性需另行确认。", ["kiloKey", "kiloReference"], "No default model chosen. A model is nevertheless required on actual chat requests."),
  },
  "vertex": {
    baseUrl: fact("https://aiplatform.googleapis.com/v1", ["vertexGuide"], "Official global native-Gemini root. EasySwitch vertex-gemini.ts constructs effective regional/global URL from validated mode/location and deliberately ignores preset baseUrl/wire."),
    modelId: fact("gemini-3.5-flash", ["vertexGuide", "vertexModel"], "Exact official model ID and global REST example."),
    keyGuide: fact("https://docs.cloud.google.com/gemini-enterprise-agent-platform/machine-learning/authentication", ["vertexAuth"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "User-supplied short-lived Google Cloud access token"}, ["vertexGuide", "vertexToken"], "Documentation confirms bearer access token; restriction to user-supplied nonrefreshed token is EasySwitch local behavior, not a Google-wide limitation."),
    guidance: fact("标准模式：填写 Google Cloud 项目 ID、location（如 global）和自行取得的短期 Access Token。Token 到期后需手动更新。", ["vertexGuide", "vertexToken"], "Official token/setup guidance; local no-gcloud/no-ADC/no-refresh behavior separately verified in vertex-gemini.ts."),
  },
  "vertex-express": {
    baseUrl: fact("https://aiplatform.googleapis.com/v1", ["express"], "Native Gemini path omits project and location: /publishers/google/models/{model}:generateContent. Runtime constructs path independently."),
    modelId: fact("gemini-3.5-flash", ["expressModel"], "Exact ID appears in vertexai=True + api_key express SDK example, but same-page available-model table lags. Documentation evidence, not entitlement/live availability."),
    keyGuide: fact("https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/api-keys", ["expressKey"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "x-goog-api-key", "scheme": "raw", "requirement": "Google Cloud Express API key"}, ["express", "expressHeader"], "REST docs show query key; first-party Go SDK independently confirms raw x-goog-api-key header. EasySwitch uses that header. No query-key rewrite."),
    guidance: fact("Express 模式：填写 Google Cloud Express 的 API Key，无需项目 ID 和 location；按 Google Cloud 的密钥指南配置。", ["express", "expressKey"], "No blanket claim that every AI Studio key is technically invalid under all possible configurations."),
  },
  "cloudflare-ai-gateway": {
    baseUrl: fact("https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/openai", ["cfOpenai"], "Provider-native OpenAI base appends /chat/completions or /responses; no extra /v1."),
    anthropicBaseUrl: fact("https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/anthropic/v1", ["cfAnthropic"], "Corrected EasySwitch-specific base because runtime directly appends /messages; official full path ends /anthropic/v1/messages. SDK root ending /anthropic is not sufficient here. New presets only; do not migrate saved configurations."),
    keyGuide: fact("https://developers.cloudflare.com/ai-gateway/usage/providers/openai/", ["cfOpenai"], "Verified public official setup guidance; no account-console access or key creation was performed."),
    authentication: fact({"header": "Authorization", "scheme": "bearer", "requirement": "Upstream OpenAI API key in request-key mode; gateway authentication may additionally require cf-aig-authorization"}, ["cfOpenai", "cfAnthropic", "cfAuth"], "Anthropic upstream uses raw x-api-key + anthropic-version 2023-06-01; authenticated gateway adds cf-aig-authorization Bearer CF token. BYOK/Unified Billing differ; no universal one-key claim and no new wire override."),
    placeholders: fact(["account_id", "gateway"], ["cfOpenai", "cfAnthropic"], "Official docs call the second value gateway_id; retain EasySwitch's existing placeholder key gateway, whose supplied value must identify the gateway."),
    guidance: fact("填写 Cloudflare 账号 ID 和网关 ID。此预设按请求携带上游厂商 Key；若启用网关认证，还需 cf-aig-authorization。BYOK／统一计费请按官方说明配置。", ["cfOpenai", "cfAnthropic", "cfAuth"], "Independently written mode-qualified guidance; no automatic auth capability expansion."),
  },
};
