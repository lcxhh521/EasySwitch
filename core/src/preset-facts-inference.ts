/**
 * Independently collected inference-platform documentation facts, 2026-10-08.
 * Fifteen unchanged endpoint contracts plus Together's current documented .ai
 * endpoint are reconstructed. The historical .xyz endpoint is not declared
 * broken; saved providers are unaffected. Retired Hyperbolic and Ollama Cloud
 * stay outside this collection pending service/model-ID decisions or evidence.
 * Checked facts do not establish live access, entitlement, complete parameter
 * support or pricing. Guidance, keys and discovery-only alternate surfaces
 * remain evidence even where editorial choices omit them from the public API.
 * No third-party registry or implementation populates this collection.
 */
import type { PresetFact, PresetFacts } from "./preset-facts.ts";

const checkedAt = "2026-10-08";
const sources = {
  "groq": { url: "https://console.groq.com/docs/openai", title: "Groq OpenAI Compatibility" },
  "groq2": { url: "https://console.groq.com/docs/api-reference", title: "Groq API Reference" },
  "groq3": { url: "https://console.groq.com/keys", title: "Groq API Keys" },
  "cerebras": { url: "https://inference-docs.cerebras.ai/resources/openai", title: "Cerebras OpenAI Compatibility" },
  "cerebras2": { url: "https://inference-docs.cerebras.ai/quickstart", title: "Cerebras Quickstart" },
  "together": { url: "https://docs.together.ai/docs/inference/openai-compatibility", title: "Together OpenAI compatibility" },
  "togetherHistory": { url: "https://www.together.ai/blog/function-calling-json-mode", title: "Together Announcing function calling and JSON mode (published 2024-01-31)" },
  "fireworks": { url: "https://docs.fireworks.ai/tools-sdks/openai-compatibility", title: "Fireworks OpenAI compatibility" },
  "fireworks2": { url: "https://docs.fireworks.ai/getting-started/quickstart", title: "Fireworks Serverless Quickstart" },
  "fireworks3": { url: "https://docs.fireworks.ai/tools-sdks/anthropic-compatibility", title: "Fireworks Anthropic compatibility" },
  "deepinfra": { url: "https://docs.deepinfra.com/chat/overview", title: "DeepInfra Chat Completions" },
  "deepinfra2": { url: "https://docs.deepinfra.com/integrations/anthropic", title: "DeepInfra Anthropic SDK and Claude Code" },
  "sambanova": { url: "https://docs.sambanova.ai/docs/en/get-started/api-keys-urls", title: "SambaNova API Keys and URLs" },
  "sambanova2": { url: "https://docs.sambanova.ai/docs/en/get-started/quickstart", title: "SambaNova Quickstart" },
  "nebius": { url: "https://docs.tokenfactory.nebius.com/quickstart", title: "Nebius Token Factory Quickstart" },
  "nebius2": { url: "https://docs.tokenfactory.nebius.com/api-reference/introduction", title: "Nebius Token Factory API Introduction" },
  "nvidia": { url: "https://docs.api.nvidia.com/nim/reference/diffusiongemma-26b-a4b-it-infer", title: "NVIDIA hosted NIM chat API reference" },
  "nvidia2": { url: "https://docs.nvidia.com/nemo-helix/v0.3.0/documentation/reference/troubleshooting/guardrails/", title: "NVIDIA NeMo Helix hosted endpoint authentication example" },
  "nvidia3": { url: "https://docs.api.nvidia.com/nim/docs/api-quickstart", title: "NVIDIA API Catalog Quickstart Guide" },
  "baseten": { url: "https://docs.baseten.co/inference/model-apis/overview", title: "Baseten Model APIs" },
  "scaleway": { url: "https://www.scaleway.com/en/docs/generative-apis/reference-content/integrating-generative-apis-with-popular-tools/", title: "Scaleway Generative APIs integration guide" },
  "digitalocean": { url: "https://docs.digitalocean.com/products/inference/how-to/use-chat-completions-api/", title: "DigitalOcean Chat Completions guide" },
  "digitalocean2": { url: "https://docs.digitalocean.com/products/inference/how-to/si-endpoints/", title: "DigitalOcean Serverless Inference API Endpoints" },
  "digitalocean3": { url: "https://docs.digitalocean.com/products/inference/how-to/use-messages-api/", title: "DigitalOcean Messages API guide" },
  "vultr": { url: "https://docs.vultr.com/how-to-use-tool-calling-with-vultr-serverless-inference", title: "Vultr Serverless Inference Tool Calling Guide" },
  "vultr2": { url: "https://docs.vultr.com/products/compute/serverless-inference/management/health-checks", title: "Vultr Serverless Inference Health Checks and Inference Key Retrieval" },
  "nscale": { url: "https://docs.nscale.com/api-reference/inference/create-chat-completion", title: "Nscale Create chat completion" },
  "nscale2": { url: "https://docs.nscale.com/docs/getting-started/quickstart", title: "Nscale Quickstart" },
  "venice": { url: "https://docs.venice.ai/overview/about-venice", title: "Venice API Overview" },
  "neuralwatt": { url: "https://docs.neuralwatt.com/quickstart", title: "Neuralwatt Quickstart" },
  "neuralwatt2": { url: "https://docs.neuralwatt.com/authentication", title: "Neuralwatt Authentication" },
  "neuralwatt3": { url: "https://portal.neuralwatt.com/models/glm-5.3", title: "Neuralwatt GLM 5.3 model card" },
  "neuralwatt4": { url: "https://docs.neuralwatt.com/api/messages", title: "Neuralwatt Anthropic Messages" },
  "synthetic": { url: "https://dev.synthetic.new/docs/api/overview", title: "Synthetic API Overview" },
  "synthetic2": { url: "https://dev.synthetic.new/docs/openai/chat-completions", title: "Synthetic Chat Completions" },
  "synthetic3": { url: "https://dev.synthetic.new/docs/anthropic/messages", title: "Synthetic Messages" },
} as const;

const scopes = {
  baseUrl: "Documented OpenAI-compatible base, with no live request or account entitlement verification.",
  authentication: "Authentication for this documented surface only; retain the existing runtime default, do not add a wire override.",
  placeholders: "The documented retained base is a fixed URL with no URL placeholders; preserve absence of runtime urlParams.",
  keyGuide: "Checked official setup/authentication guide, not a verified account-console session.",
  guidance: "Independently written Chinese setup guidance; no capabilities or account access are inferred.",
  modelId: "Exact model identifier appears in official provider documentation; retaining it as default is an EasySwitch editorial choice, not guaranteed account access.",
} as const;

function fact<T>(value: T, sourceIds: Array<keyof typeof sources>, scope: string): PresetFact<T> {
  return { value, checkedAt, sources: sourceIds.map(id => sources[id]), scope };
}

export type InferencePresetId = "groq" | "cerebras" | "together" | "fireworks" | "deepinfra" | "sambanova" | "nebius" | "nvidia" | "baseten" | "scaleway" | "digitalocean" | "vultr" | "nscale" | "venice" | "neuralwatt" | "synthetic";

export const INFERENCE_PRESET_FACTS: Record<InferencePresetId, PresetFacts> = {
  "groq": {
    baseUrl: fact("https://api.groq.com/openai/v1", ["groq"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Groq API key" }, ["groq2"], scopes.authentication),
    placeholders: fact([], ["groq"], scopes.placeholders),
    keyGuide: fact("https://console.groq.com/keys", ["groq3"], scopes.keyGuide),
    guidance: fact("使用 Groq API Key 连接 OpenAI 兼容接口；模型及参数支持以平台文档和账号权限为准。", ["groq", "groq2", "groq3"], scopes.guidance),
  },
  "cerebras": {
    baseUrl: fact("https://api.cerebras.ai/v1", ["cerebras"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Cerebras API key" }, ["cerebras2"], scopes.authentication),
    placeholders: fact([], ["cerebras"], scopes.placeholders),
    keyGuide: fact("https://inference-docs.cerebras.ai/quickstart", ["cerebras2"], scopes.keyGuide),
    guidance: fact("共享推理使用 Cerebras 模型 ID；专用推理使用对应端点 ID。", ["cerebras", "cerebras2"], scopes.guidance),
    modelId: fact("gpt-oss-120b", ["cerebras"], scopes.modelId),
  },
  "together": {
    baseUrl: fact("https://api.together.ai/v1", ["together"], "Current documented OpenAI-compatible base for new presets. Historical .xyz support or alias equivalence is not established; existing saved providers are not migrated."),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Together API key" }, ["together"], scopes.authentication),
    placeholders: fact([], ["together"], scopes.placeholders),
    keyGuide: fact("https://docs.together.ai/docs/inference/openai-compatibility", ["together"], scopes.keyGuide),
    guidance: fact("使用 Together API Key；新来源采用当前官方指南中的 api.together.ai，已有来源的地址保持原样。", ["together"], scopes.guidance),
  },
  "fireworks": {
    baseUrl: fact("https://api.fireworks.ai/inference/v1", ["fireworks"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Fireworks API key" }, ["fireworks2"], scopes.authentication),
    placeholders: fact([], ["fireworks"], scopes.placeholders),
    keyGuide: fact("https://docs.fireworks.ai/getting-started/quickstart", ["fireworks2"], scopes.keyGuide),
    guidance: fact("使用 Fireworks API Key；模型名称按平台完整标识填写。", ["fireworks", "fireworks2"], scopes.guidance),
  },
  "deepinfra": {
    baseUrl: fact("https://api.deepinfra.com/v1/openai", ["deepinfra"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "DeepInfra API token" }, ["deepinfra"], scopes.authentication),
    placeholders: fact([], ["deepinfra"], scopes.placeholders),
    keyGuide: fact("https://docs.deepinfra.com/chat/overview", ["deepinfra"], scopes.keyGuide),
    guidance: fact("使用 DeepInfra Token 连接 OpenAI 兼容接口；模型填写平台列出的完整 ID。", ["deepinfra"], scopes.guidance),
  },
  "sambanova": {
    baseUrl: fact("https://api.sambanova.ai/v1", ["sambanova"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "SambaCloud API key" }, ["sambanova2"], scopes.authentication),
    placeholders: fact([], ["sambanova"], scopes.placeholders),
    keyGuide: fact("https://docs.sambanova.ai/docs/en/get-started/api-keys-urls", ["sambanova"], scopes.keyGuide),
    guidance: fact("这里连接 SambaCloud；SambaStack 私有部署需使用管理员提供的地址和密钥。", ["sambanova", "sambanova2"], scopes.guidance),
  },
  "nebius": {
    baseUrl: fact("https://api.tokenfactory.nebius.com/v1", ["nebius", "nebius2"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Nebius Token Factory API key" }, ["nebius2"], scopes.authentication),
    placeholders: fact([], ["nebius", "nebius2"], scopes.placeholders),
    keyGuide: fact("https://docs.tokenfactory.nebius.com/api-reference/introduction", ["nebius2"], scopes.keyGuide),
    guidance: fact("使用 Token Factory API Key；模型填写平台提供的模型 ID。", ["nebius", "nebius2"], scopes.guidance),
  },
  "nvidia": {
    baseUrl: fact("https://integrate.api.nvidia.com/v1", ["nvidia"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "NVIDIA Developer/API Catalog key" }, ["nvidia2"], scopes.authentication),
    placeholders: fact([], ["nvidia"], scopes.placeholders),
    keyGuide: fact("https://docs.api.nvidia.com/nim/docs/api-quickstart", ["nvidia3"], scopes.keyGuide),
    guidance: fact("这里连接 NVIDIA 托管的 API Catalog；自部署 NIM 使用自己的服务地址。", ["nvidia", "nvidia2", "nvidia3"], scopes.guidance),
  },
  "baseten": {
    baseUrl: fact("https://inference.baseten.co/v1", ["baseten"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Baseten API key" }, ["baseten"], scopes.authentication),
    placeholders: fact([], ["baseten"], scopes.placeholders),
    keyGuide: fact("https://docs.baseten.co/inference/model-apis/overview", ["baseten"], scopes.keyGuide),
    guidance: fact("这里连接 Baseten Model APIs；使用 Baseten API Key 和平台模型 slug。", ["baseten"], scopes.guidance),
  },
  "scaleway": {
    baseUrl: fact("https://api.scaleway.ai/v1", ["scaleway"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Secret portion of a Scaleway API key; fixed base uses default project" }, ["scaleway"], scopes.authentication),
    placeholders: fact([], ["scaleway"], scopes.placeholders),
    keyGuide: fact("https://www.scaleway.com/en/docs/generative-apis/reference-content/integrating-generative-apis-with-popular-tools/", ["scaleway"], scopes.keyGuide),
    guidance: fact("此地址使用默认 Scaleway 项目；其他项目需按官方指南使用带项目 ID 的地址。", ["scaleway"], scopes.guidance),
  },
  "digitalocean": {
    baseUrl: fact("https://inference.do-ai.run/v1", ["digitalocean"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "DigitalOcean model access key or personal access token" }, ["digitalocean"], scopes.authentication),
    placeholders: fact([], ["digitalocean"], scopes.placeholders),
    keyGuide: fact("https://docs.digitalocean.com/products/inference/how-to/si-endpoints/", ["digitalocean2"], scopes.keyGuide),
    guidance: fact("连接 DigitalOcean Serverless Inference；使用模型访问密钥或官方支持的个人访问令牌。", ["digitalocean", "digitalocean2"], scopes.guidance),
  },
  "vultr": {
    baseUrl: fact("https://api.vultrinference.com/v1", ["vultr"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Vultr Serverless Inference subscription key, distinct from management VULTR_API_KEY" }, ["vultr"], scopes.authentication),
    placeholders: fact([], ["vultr"], scopes.placeholders),
    keyGuide: fact("https://docs.vultr.com/products/compute/serverless-inference/management/health-checks", ["vultr2"], scopes.keyGuide),
    guidance: fact("使用 Serverless Inference 订阅密钥；它与管理 Vultr 资源的 API Key 不同。", ["vultr", "vultr2"], scopes.guidance),
    modelId: fact("kimi-k2-instruct", ["vultr"], scopes.modelId),
  },
  "nscale": {
    baseUrl: fact("https://inference.api.nscale.com/v1", ["nscale"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Nscale service token" }, ["nscale"], scopes.authentication),
    placeholders: fact([], ["nscale"], scopes.placeholders),
    keyGuide: fact("https://docs.nscale.com/docs/getting-started/quickstart", ["nscale2"], scopes.keyGuide),
    guidance: fact("使用 Nscale Service Token；模型按平台提供的模型 ID 填写。", ["nscale", "nscale2"], scopes.guidance),
  },
  "venice": {
    baseUrl: fact("https://api.venice.ai/api/v1", ["venice"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Venice API key" }, ["venice"], scopes.authentication),
    placeholders: fact([], ["venice"], scopes.placeholders),
    keyGuide: fact("https://docs.venice.ai/overview/about-venice", ["venice"], scopes.keyGuide),
    guidance: fact("使用 Venice API Key 连接兼容接口；可用模型及访问额度以账号为准。", ["venice"], scopes.guidance),
  },
  "neuralwatt": {
    baseUrl: fact("https://api.neuralwatt.com/v1", ["neuralwatt"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Neuralwatt API key" }, ["neuralwatt2"], scopes.authentication),
    placeholders: fact([], ["neuralwatt"], scopes.placeholders),
    keyGuide: fact("https://docs.neuralwatt.com/authentication", ["neuralwatt2"], scopes.keyGuide),
    guidance: fact("使用 Neuralwatt API Key；GLM-5.3 的模型 ID 为 glm-5.3。", ["neuralwatt", "neuralwatt2"], scopes.guidance),
    modelId: fact("glm-5.3", ["neuralwatt", "neuralwatt3"], scopes.modelId),
  },
  "synthetic": {
    baseUrl: fact("https://api.synthetic.new/openai/v1", ["synthetic", "synthetic2"], scopes.baseUrl),
    authentication: fact({ header: "Authorization", scheme: "bearer", requirement: "Synthetic API key" }, ["synthetic"], scopes.authentication),
    placeholders: fact([], ["synthetic", "synthetic2"], scopes.placeholders),
    keyGuide: fact("https://dev.synthetic.new/docs/api/overview", ["synthetic"], scopes.keyGuide),
    guidance: fact("使用 Synthetic API Key；模型名称按平台目录或官方别名填写。", ["synthetic", "synthetic2"], scopes.guidance),
  },
};

/** Research only: no caller may project these alternate interfaces into presets. */
export const INFERENCE_RESEARCH_ONLY: Partial<Record<InferencePresetId, {
  alternates: PresetFact<Record<string, unknown>>[];
  caveats: string[];
}>> = {
  "together": {
    alternates: [
      fact({ kind: "historical-openai-compatible-base", baseUrl: "https://api.together.xyz/v1" }, ["togetherHistory"], "Historical .xyz endpoint from the official blog published 2024-01-31. Current compatibility docs specify .ai; this evidence does not prove .xyz is broken or establish current alias equivalence."),
    ],
    caveats: ["Current .xyz host support, redirects and alias equivalence are not established by the current official documentation."],
  },
  "fireworks": {
    alternates: [
      fact({ kind: "anthropic-messages", fullEndpoint: "https://api.fireworks.ai/inference/v1/messages", sdkBase: "https://api.fireworks.ai/inference", easySwitchBaseIfFutureEnabled: "https://api.fireworks.ai/inference/v1", authentication: "Authorization: Bearer Fireworks API key" }, ["fireworks3"], "Discovery only; SDK appends /v1/messages, EasySwitch appends /messages. Do not add a new anthropicBaseUrl or protocol field in this rewrite."),
    ],
    caveats: [],
  },
  "deepinfra": {
    alternates: [
      fact({ kind: "anthropic-messages", fullEndpoint: "https://api.deepinfra.com/anthropic/v1/messages", sdkBase: "https://api.deepinfra.com/anthropic", easySwitchBaseIfFutureEnabled: "https://api.deepinfra.com/anthropic/v1", authentication: "x-api-key or Authorization: Bearer DeepInfra API key" }, ["deepinfra2"], "Discovery only; SDK and EasySwitch append different path suffixes. No runtime alternate added."),
    ],
    caveats: [],
  },
  "baseten": {
    alternates: [
      fact({ kind: "anthropic-messages-beta", fullEndpoint: "https://inference.baseten.co/v1/messages", sdkBase: "https://inference.baseten.co", easySwitchBaseIfFutureEnabled: "https://inference.baseten.co/v1", authentication: "Authorization: Bearer Baseten API key; x-api-key alone is not the documented auth" }, ["baseten"], "Discovery only. Baseten explicitly requires overriding Anthropic SDK default headers to send Authorization. No runtime alternate added."),
    ],
    caveats: [],
  },
  "scaleway": {
    alternates: [
      fact({ kind: "project-scoped-openai-base", baseUrl: "https://api.scaleway.ai/{project_id}/v1", placeholders: ["project_id"], authentication: "Authorization: Bearer Scaleway secret key" }, ["scaleway"], "Documented for non-default projects; keep fixed default-project base and absent urlParams in the retained preset."),
    ],
    caveats: [],
  },
  "digitalocean": {
    alternates: [
      fact({ kind: "anthropic-messages", fullEndpoint: "https://inference.do-ai.run/v1/messages", easySwitchBaseIfFutureEnabled: "https://inference.do-ai.run/v1", authentication: "x-api-key: MODEL_ACCESS_KEY and anthropic-version: 2023-06-01" }, ["digitalocean3"], "Discovery only. Guide prose calls the full /v1/messages URL ANTHROPIC_BASE_URL, while curl and endpoint table establish it is a full endpoint. Do not copy the full path into an append-based client."),
    ],
    caveats: [],
  },
  "neuralwatt": {
    alternates: [
      fact({ kind: "anthropic-messages", fullEndpoint: "https://api.neuralwatt.com/v1/messages", sdkBase: "https://api.neuralwatt.com", easySwitchBaseIfFutureEnabled: "https://api.neuralwatt.com/v1", authentication: "x-api-key or Authorization: Bearer Neuralwatt key" }, ["neuralwatt4"], "Discovery only. Dedicated Messages auth docs allow both headers even though general auth page says Bearer for all requests; scope authentication facts by endpoint."),
    ],
    caveats: [],
  },
  "synthetic": {
    alternates: [
      fact({ kind: "anthropic-messages", fullEndpoint: "https://api.synthetic.new/anthropic/v1/messages", easySwitchBaseIfFutureEnabled: "https://api.synthetic.new/anthropic/v1" }, ["synthetic", "synthetic3"], "Discovery only. No explicit wire auth header was shown in read Messages page; do not infer it from SDK api_key. No runtime alternate added."),
    ],
    caveats: ["Overview's sample curl uses /v1/chat/completions while its explicit base and detailed reference use /openai/v1. Retained /openai/v1 is explicitly supported. The detailed reference still says hf: prefix is required while newer overview also documents syn: aliases; no default or restrictive model-name validation is inferred."],
  },
};
