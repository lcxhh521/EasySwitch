/**
 * Independently collected official documentation facts, checked 2026-10-08.
 * This is a bounded 52-provider input, not a verification of the legacy table.
 * Documentation establishes endpoint/model syntax, never account entitlement,
 * a successful live request, or a complete negotiated protocol capability set.
 * No third-party registry or implementation is copied; only public protocol
 * facts are recorded, including official SDK URL joining where noted.
 */
import { INFERENCE_PRESET_FACTS, type InferencePresetId } from "./preset-facts-inference.ts";
import { GATEWAY_PRESET_FACTS, type GatewayPresetId } from "./preset-facts-gateway.ts";

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
  kimi: { url: "https://platform.kimi.com/docs/api/overview", title: "Kimi API 概述" },
  kimiMessages: { url: "https://platform.kimi.com/docs/api/messages", title: "Kimi Messages API" },
  kimiKey: { url: "https://platform.kimi.com/docs/get-api-key", title: "Kimi 快速开始" },
  zhipuModel: { url: "https://docs.bigmodel.cn/cn/guide/models/text/glm-4.6", title: "智谱 GLM-4.6" },
  zhipuMessages: { url: "https://docs.bigmodel.cn/cn/guide/develop/claude/introduction", title: "智谱 Claude API 兼容" },
  qwen: { url: "https://help.aliyun.com/en/model-studio/base-url", title: "Model Studio Base URL overview" },
  qwenMessages: { url: "https://help.aliyun.com/en/model-studio/anthropic-api-messages", title: "Model Studio Anthropic-compatible Messages API" },
  qwenKey: { url: "https://help.aliyun.com/en/model-studio/get-api-key", title: "Model Studio How to obtain an API key" },
  volcengine: { url: "https://docs.volcengine.com/docs/ark/compatible-with-openai-sdk?lang=en", title: "火山方舟 兼容 OpenAI SDK" },
  volcengineQuickstart: { url: "https://docs.volcengine.com/docs/82379/1399008?lang=en", title: "火山方舟 快速入门" },
  volcengineModels: { url: "https://docs.volcengine.com/docs/ark/model-list?lang=zh", title: "火山方舟 模型列表" },
  volcengineSetup: { url: "https://docs.volcengine.com/docs/ark/get-agent-api?lang=en", title: "火山方舟 获取 Agent API 接入信息" },
  qianfanAuth: { url: "https://cloud.baidu.com/doc/qianfan-api/s/ym9chdsy5", title: "千帆 认证鉴权" },
  qianfanModels: { url: "https://cloud.baidu.com/doc/qianfan-api/s/Dmba8k71y", title: "千帆 获取模型列表" },
  stepfun: { url: "https://platform.stepfun.com/docs/zh/quickstart/overview", title: "StepFun 快速开始" },
  stepfunModel: { url: "https://platform.stepfun.com/docs/zh/guides/models/step-5-preview", title: "StepFun Step 5 Preview" },
  siliconflow: { url: "https://docs.siliconflow.cn/docs/userguide/quickstart", title: "硅基流动 快速上手" },
  siliconflowChat: { url: "https://docs.siliconflow.cn/docs/api/chat-completions-post", title: "SiliconFlow Create a Chat Completion" },
  xiaomiChat: { url: "https://mimo.mi.com/docs/en-US/api/chat/openai-api", title: "Xiaomi MiMo OpenAI Chat Completions API Compatibility" },
  xiaomiMessages: { url: "https://mimo.mi.com/docs/en-US/api/chat/anthropic-api", title: "Xiaomi MiMo Anthropic Messages API Compatibility" },
  xiaomiModel: { url: "https://mimo.mi.com/models/en-US/mimo-v2.6-flash", title: "Xiaomi MiMo-V2.6-Flash" },
  xiaomiKeys: { url: "https://mimo.mi.com/docs/en-US/tokenplan/integration/mimo-desktop", title: "MiMo Desktop integration: API Key and Token Plan key distinction" },
  deepseek: { url: "https://api-docs.deepseek.com/", title: "DeepSeek Your First API Call" },
  deepseekMessages: { url: "https://api-docs.deepseek.com/guides/anthropic_api/", title: "DeepSeek Using the Anthropic API" },
  anthropicSdkMessages: { url: "https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/resources/messages/messages.py", title: "Official Anthropic Python SDK Messages resource" },
  anthropicSdkBase: { url: "https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/_base_client.py", title: "Official Anthropic Python SDK URL joining" },
} as const;

function fact<T>(value: T, sourceIds: Array<keyof typeof sources>, scope: string): PresetFact<T> {
  return { value, checkedAt, sources: sourceIds.map(id => sources[id]), scope };
}
function guide(id: keyof typeof sources): PresetFact<string> {
  return fact(sources[id].url, [id], "Official setup/authentication guidance; not a verified account-console deep link.");
}

export type IndependentPresetId = "openai" | "anthropic" | "gemini" | "azure-openai" | "openrouter" | "cloudflare-workers-ai" | "ollama" | "lmstudio" | "vllm" | "litellm"
  | "deepseek" | "kimi" | "zhipu" | "qwen" | "volcengine" | "qianfan" | "stepfun" | "siliconflow" | "xiaomi" | InferencePresetId | GatewayPresetId;

export const OFFICIAL_PRESET_FACTS: Record<IndependentPresetId, PresetFacts> = {
  ...INFERENCE_PRESET_FACTS,
  ...GATEWAY_PRESET_FACTS,
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
  kimi: {
    baseUrl: fact("https://api.moonshot.cn/v1", ["kimi"], "Documented Chat/Responses compatibility base; preserve existing base."),
    anthropicBaseUrl: fact("https://api.moonshot.cn/anthropic/v1", ["kimi", "kimiMessages"], "Derived from explicit POST /anthropic/v1/messages. SDK root /anthropic omits /v1 because SDK adds it; EasySwitch appends only /messages."),
    keyGuide: fact("https://platform.kimi.com/docs/get-api-key", ["kimiKey"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Provider API key" }, ["kimi", "kimiMessages"], "API reference shows Authorization Bearer for Chat and Messages. No new global wire override required."),
    guidance: fact("使用 Kimi API 开放平台创建的 API Key；这里连接 moonshot.cn 的开放 API。", ["kimi", "kimiKey"], "Original wording grounded in API-key setup. Do not infer Kimi membership entitlement."),
  },
  zhipu: {
    baseUrl: fact("https://open.bigmodel.cn/api/paas/v4", ["zhipuModel"], "Derived from GLM-4.6 curl POST /api/paas/v4/chat/completions."),
    anthropicBaseUrl: fact("https://open.bigmodel.cn/api/anthropic/v1", ["zhipuMessages"], "Derived from explicit curl /api/anthropic/v1/messages. Current legacy field is SDK root /api/anthropic and omits required /v1 for EasySwitch's join."),
    modelId: fact("glm-4.6", ["zhipuModel"], "Exact model ID from official GLM-4.6 curl/Python examples; preserve existing default despite newer examples on compatibility page."),
    keyGuide: fact("https://docs.bigmodel.cn/cn/guide/develop/claude/introduction", ["zhipuMessages"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Provider API key" }, ["zhipuModel", "zhipuMessages"], "Chat: Bearer API key. General Claude-compatible API example uses x-api-key. The existing Messages adapter supplies it; do not override Chat globally to x-api-key."),
    guidance: fact("使用智谱开放平台 API Key；普通 API 与编程套餐的接入配置需分别核对。", ["zhipuModel", "zhipuMessages"], "Original API-key guidance. This source is general development documentation, not only Coding Plan documentation."),
  },
  qwen: {
    baseUrl: fact("https://dashscope.aliyuncs.com/compatible-mode/v1", ["qwen"], "Documented China Beijing shared DashScope pay-as-you-go base. Still available, though workspace-specific production domains are recommended. Preserve current region/host."),
    anthropicBaseUrl: fact("https://dashscope.aliyuncs.com/apps/anthropic/v1", ["qwen", "qwenMessages"], "Combine documented Beijing shared SDK root /apps/anthropic with documented /v1/messages wire path. EasySwitch must include /v1 in this field because it appends /messages."),
    keyGuide: fact("https://help.aliyun.com/en/model-studio/get-api-key", ["qwenKey"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Provider API key" }, ["qwenMessages", "qwenKey"], "Model Studio API key, matched to region and billing plan. Messages explicitly accepts x-api-key or Authorization Bearer; OpenAI compatibility client uses the same API key. No wire override."),
    guidance: fact("北京地域的百炼按量 API；Key 须与地域和计费方案匹配，不能混用编程套餐专用 Key。", ["qwen", "qwenKey"], "Original guidance. Keep shared domain; do not introduce workspace placeholder migration in this reconstruction."),
  },
  volcengine: {
    baseUrl: fact("https://ark.cn-beijing.volces.com/api/v3", ["volcengine", "volcengineQuickstart"], "Official Beijing OpenAI-compatible base."),
    modelId: fact("doubao-seed-2-1-pro-260628", ["volcengine", "volcengineModels"], "Exact ID occurs in official SDK example and model list. Preserve existing default; model list marks it a prior model, not evidence of universal account access."),
    keyGuide: fact("https://docs.volcengine.com/docs/82379/1399008?lang=en", ["volcengineQuickstart"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Provider API key" }, ["volcengineQuickstart"], "Official curl shows Authorization Bearer $ARK_API_KEY."),
    guidance: fact("使用火山方舟 API Key；模型可填写官方模型 ID 或已创建的推理接入点 ID。", ["volcengineQuickstart", "volcengineSetup"], "Corrects old overly restrictive note demanding only endpoint ID. No account endpoint is embedded."),
  },
  qianfan: {
    baseUrl: fact("https://qianfan.baidubce.com/v2", ["qianfanAuth", "qianfanModels"], "Derived from official Chat Completions and Models request addresses. Mainland Qianfan v2; not international api.baiduqianfan.ai."),
    keyGuide: fact("https://cloud.baidu.com/doc/qianfan-api/s/ym9chdsy5", ["qianfanAuth"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Provider API key" }, ["qianfanAuth"], "Authorization is Bearer plus API Key. Key must be configured for Qianfan ModelBuilder and allowed resources/appid as applicable."),
    guidance: fact("使用千帆 ModelBuilder 的 API Key，并核对 Key 的资源范围；模型按千帆模型 ID 填写。", ["qianfanAuth", "qianfanModels"], "Original setup guidance limited to v2 model APIs."),
  },
  stepfun: {
    baseUrl: fact("https://api.stepfun.com/v1", ["stepfun"], "Official quickstart OpenAI-compatible API base and curl Chat endpoint."),
    modelId: fact("step-5-preview", ["stepfun", "stepfunModel"], "Exact official model ID, not display-name inference. Preserve current default."),
    keyGuide: fact("https://platform.stepfun.com/docs/zh/quickstart/overview", ["stepfun"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Provider API key" }, ["stepfun"], "Official curl Authorization Bearer; obtain API key through platform account management/interface-key."),
    guidance: fact("使用阶跃星辰开放平台 API Key；模型填写官方 Model ID，具体可用范围以账号为准。", ["stepfun", "stepfunModel"], "Original API setup wording, no inference of subscription balance."),
  },
  siliconflow: {
    baseUrl: fact("https://api.siliconflow.cn/v1", ["siliconflow", "siliconflowChat"], "Official mainland OpenAI-compatible base."),
    keyGuide: fact("https://docs.siliconflow.cn/docs/userguide/quickstart", ["siliconflow"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Provider API key" }, ["siliconflowChat"], "Explicit Authorization Bearer API key; no special override."),
    guidance: fact("使用硅基流动 API Key，模型 ID 按平台当前模型列表填写。", ["siliconflow", "siliconflowChat"], "Original wording avoids unsupported static model inventory claims; model availability can change."),
  },
  xiaomi: {
    baseUrl: fact("https://api.xiaomimimo.com/v1", ["xiaomiChat"], "Derived from explicit OpenAI Chat Completions request address."),
    anthropicBaseUrl: fact("https://api.xiaomimimo.com/anthropic/v1", ["xiaomiMessages"], "Derived from explicit /anthropic/v1/messages request address; fixes omitted /v1 in legacy SDK-style root."),
    modelId: fact("mimo-v2.6-flash", ["xiaomiChat", "xiaomiMessages", "xiaomiModel"], "Exact documented API model ID; preserve current default."),
    keyGuide: fact("https://mimo.mi.com/models/en-US/mimo-v2.6-flash", ["xiaomiModel"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "api-key", scheme: "raw", requirement: "Xiaomi MiMo API key" }, ["xiaomiChat", "xiaomiMessages"], "Both APIs explicitly support raw api-key header. Retain existing wire override; docs also offer Bearer but no reason to change working auth choice."),
    guidance: fact("官方按量 API，使用普通 API Key；与 Token Plan 专用 Key 分开，真实账号可用性仍需自行验证。", ["xiaomiModel", "xiaomiKeys"], "Original wording. Official guide distinguishes sk- API keys from tp-/ttp- Token Plan keys; does not rely on experimental MiMo Free."),
  },
  deepseek: {
    baseUrl: fact("https://api.deepseek.com", ["deepseek"], "Official canonical OpenAI-compatible root, selected for new presets. The old /v1 alias is not documented in the current pages checked; absence is not proof that alias stopped working. Saved providers are not migrated."),
    anthropicBaseUrl: fact("https://api.deepseek.com/anthropic/v1", ["deepseekMessages", "anthropicSdkMessages", "anthropicSdkBase"], "Derived EasySwitch base: DeepSeek documents SDK base /anthropic; official Anthropic Python SDK appends /v1/messages to that base path. This value lets EasySwitch append /messages. Protocol URL derivation, not an observed response or copied SDK implementation."),
    modelId: fact("deepseek-flash", ["deepseek"], "Exact current official API model ID; matches the existing default. No default upgrade."),
    keyGuide: fact("https://api-docs.deepseek.com/", ["deepseek"], "Official public setup/key guidance; no sign-in or account-console access performed."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Provider API key" }, ["deepseek", "deepseekMessages"], "Chat: Authorization Bearer. Messages: x-api-key is explicitly fully supported; existing runtime anthropicHeaders already sends it."),
    guidance: fact("使用 DeepSeek API Key；提供 OpenAI 与 Anthropic 兼容接口，具体能力以模型和接口文档为准。", ["deepseek", "deepseekMessages"], "Original EasySwitch wording; no account/live-call guarantee."),
  },
};
