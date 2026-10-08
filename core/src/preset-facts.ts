/**
 * Independently collected official documentation facts, checked 2026-10-08.
 * This is a bounded ten-provider input, not a verification of the legacy table.
 * Documentation establishes endpoint/model syntax, never account entitlement,
 * a successful live request, or a complete negotiated protocol capability set.
 * No third-party registry or implementation is used to populate these facts.
 */
export interface PresetFact<T> {
  value: T;
  checkedAt: string;
  sources: Array<{ url: string; title: string }>;
  scope: string;
}

export interface PresetFacts {
  baseUrl: PresetFact<string>;
  anthropicBaseUrl?: PresetFact<string>;
  modelId?: PresetFact<string>;
  keyGuide?: PresetFact<string>;
  authentication: PresetFact<{ header?: string; scheme?: "bearer" | "raw"; requirement: string }>;
  placeholders?: PresetFact<string[]>;
  guidance: PresetFact<string>;
}

const checkedAt = "2026-10-08";
const sources = {
  openai: { url: "https://developers.openai.com/api/reference/overview", title: "OpenAI API overview" },
  openaiModel: { url: "https://developers.openai.com/api/docs/models/gpt-5.5", title: "GPT-5.5 model" },
  anthropic: { url: "https://platform.claude.com/docs/en/api/messages/create", title: "Anthropic Create a message" },
  anthropicKey: { url: "https://platform.claude.com/docs/en/get-api-key", title: "Anthropic Get an API key" },
  gemini: { url: "https://ai.google.dev/gemini-api/docs/openai", title: "Gemini OpenAI compatibility" },
  geminiModel: { url: "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash", title: "Gemini 3.5 Flash" },
  azure: { url: "https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle?tabs=key", title: "Azure OpenAI v1 API lifecycle" },
  azureEndpoints: { url: "https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints", title: "Foundry model endpoints" },
  openrouter: { url: "https://openrouter.ai/docs/quickstart", title: "OpenRouter quickstart" },
  cloudflare: { url: "https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/", title: "Workers AI OpenAI-compatible endpoints" },
  ollama: { url: "https://docs.ollama.com/api/openai-compatibility", title: "Ollama OpenAI compatibility" },
  lmstudio: { url: "https://lmstudio.ai/docs/developer/openai-compat", title: "LM Studio OpenAI-compatible endpoints" },
  lmstudioAuth: { url: "https://lmstudio.ai/docs/developer/core/authentication", title: "LM Studio API authentication" },
  vllm: { url: "https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/", title: "vLLM OpenAI-compatible server" },
  litellm: { url: "https://docs.litellm.ai/docs/proxy/docker_quick_start", title: "LiteLLM gateway quickstart" },
} as const;

function fact<T>(value: T, sourceIds: Array<keyof typeof sources>, scope: string): PresetFact<T> {
  return { value, checkedAt, sources: sourceIds.map(id => sources[id]), scope };
}
function guide(id: keyof typeof sources): PresetFact<string> {
  return fact(sources[id].url, [id], "Official setup/authentication guidance; not a verified account-console deep link.");
}

export type IndependentPresetId = "openai" | "anthropic" | "gemini" | "azure-openai" | "openrouter" | "cloudflare-workers-ai" | "ollama" | "lmstudio" | "vllm" | "litellm";

export const OFFICIAL_PRESET_FACTS: Record<IndependentPresetId, PresetFacts> = {
  openai: {
    baseUrl: fact("https://api.openai.com/v1", ["openai"], "API base; documented models, Chat Completions and Responses paths. No capability flags are inferred."),
    modelId: fact("gpt-5.5", ["openaiModel"], "Documented model alias; account access is not established."),
    keyGuide: guide("openai"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "API credential" }, ["openai"], "API authentication fact only; existing runtime authentication is unchanged."),
    guidance: fact("官方 API，使用 API Key；模型是否可用以账号权限为准。", ["openai", "openaiModel"], "Independently written API/account-access guidance; no subscription entitlement is inferred."),
  },
  anthropic: {
    baseUrl: fact("https://api.anthropic.com/v1", ["anthropic"], "Base derived from the documented /v1/messages endpoint."),
    anthropicBaseUrl: fact("https://api.anthropic.com/v1", ["anthropic"], "Already includes /v1; EasySwitch appends /messages, not /v1/messages."),
    modelId: fact("claude-sonnet-5", ["anthropic"], "Documented Messages model enumeration, not an account-access guarantee."),
    keyGuide: guide("anthropicKey"),
    authentication: fact({ header: "x-api-key", scheme: "raw", requirement: "API credential and anthropic-version: 2023-06-01" }, ["anthropic"], "The existing Anthropic adapter owns these headers; do not introduce a preset wire override."),
    guidance: fact("通过 Console 获取官方 API Key；Claude 订阅登录不能代替 API Key。", ["anthropic", "anthropicKey"], "Independently written guidance on the API-key workflow, distinct from consumer subscription login."),
  },
  gemini: {
    baseUrl: fact("https://generativelanguage.googleapis.com/v1beta/openai", ["gemini"], "OpenAI-compatible beta surface; compatibility is not complete parameter equivalence."),
    modelId: fact("gemini-3.5-flash", ["geminiModel"], "Documented model ID; selecting it remains an EasySwitch choice."),
    keyGuide: guide("gemini"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Gemini API key" }, ["gemini"], "Bearer authentication for this compatibility surface, not every Gemini endpoint."),
    guidance: fact("使用 Gemini API Key；这里连接 OpenAI 兼容测试版接口。", ["gemini"], "Independently written guidance limited to the compatibility surface."),
  },
  "azure-openai": {
    baseUrl: fact("https://{resource}.openai.azure.com/openai/v1", ["azure", "azureEndpoints"], "Azure resource endpoint template; v1 needs no dated api-version query parameter."),
    keyGuide: guide("azure"),
    authentication: fact({ header: "api-key", scheme: "raw", requirement: "Resource API key" }, ["azure"], "The REST key example supports the existing raw api-key preset override."),
    placeholders: fact(["resource"], ["azure", "azureEndpoints"], "The user supplies their Azure resource name; placeholder spelling is EasySwitch's stable form contract."),
    guidance: fact("填写 Azure 资源名，模型填部署名；v1 接口不需要 api-version 参数。", ["azure", "azureEndpoints"], "Independently written deployment/setup guidance; Responses support is deployment-dependent."),
  },
  openrouter: {
    baseUrl: fact("https://openrouter.ai/api/v1", ["openrouter"], "Quickstart base with /chat/completions; examples do not select a universal default model."),
    keyGuide: guide("openrouter"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "OpenRouter API key" }, ["openrouter"], "Referral/title headers are optional and are not added by this reconstruction."),
    guidance: fact("使用 OpenRouter API Key，模型 ID 按所选模型填写。", ["openrouter"], "Independently written setup guidance; no model-count or availability claim."),
  },
  "cloudflare-workers-ai": {
    baseUrl: fact("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", ["cloudflare"], "Account-scoped OpenAI-compatible base for Chat Completions."),
    keyGuide: guide("cloudflare"),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Cloudflare API token" }, ["cloudflare"], "Documented Chat Completions authentication."),
    placeholders: fact(["account_id"], ["cloudflare"], "The user supplies their Cloudflare account ID; no account identifier is embedded."),
    guidance: fact("填写 Cloudflare 账号 ID 和 API Token；模型按 Workers AI 的模型 ID 填写。", ["cloudflare"], "No free-allowance/example-model claim. Documented Responses is limited to two GPT-OSS models and non-streaming; no capability expansion is made."),
  },
  ollama: {
    baseUrl: fact("http://localhost:11434/v1", ["ollama"], "Documented local example; choosing IPv4 loopback is an EasySwitch presentation/configuration choice."),
    authentication: fact({ requirement: "Local example needs no authentication; SDK placeholder keys are ignored" }, ["ollama"], "Local Ollama only, not Ollama Cloud."),
    guidance: fact("连接本机 Ollama；本地接口无需 Key，与 Ollama Cloud 分开。", ["ollama"], "Independently written local-interface guidance; cloud authentication is not inferred."),
  },
  lmstudio: {
    baseUrl: fact("http://localhost:1234/v1", ["lmstudio"], "Official example assumes a server on port 1234; this is not automatic server discovery."),
    authentication: fact({ requirement: "Authentication disabled by default; enabled servers require a token" }, ["lmstudioAuth"], "Configurable authentication, never an unconditional keyless guarantee."),
    guidance: fact("本机服务，示例端口 1234；默认无需 Key，启用鉴权后需填写令牌。", ["lmstudio", "lmstudioAuth"], "Independently written endpoint and configurable-authentication guidance."),
  },
  vllm: {
    baseUrl: fact("http://localhost:8000/v1", ["vllm"], "Documented OpenAI-client example; host/port depend on the user's server."),
    authentication: fact({ requirement: "Server-configured; the documented example enables --api-key" }, ["vllm"], "Do not infer every self-hosted server is keyless."),
    guidance: fact("连接自己部署的 vLLM；模型名和 Key 以服务端配置为准。", ["vllm"], "Independently written configuration guidance; no default model is inferred."),
  },
  litellm: {
    baseUrl: fact("http://localhost:4000/v1", ["litellm"], "Derived from documented port 4000 and /v1/chat/completions; not the SDK's alternative root URL."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Gateway credentials, including virtual keys" }, ["litellm"], "Gateway credentials are distinct from underlying provider credentials."),
    guidance: fact("连接自己部署的 LiteLLM 网关；使用网关凭据，模型按网关配置填写。", ["litellm"], "Independently written gateway guidance, not a claim about the underlying provider key."),
  },
};
