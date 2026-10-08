/**
 * Fresh reconstruction from preset-facts.ts plus explicit EasySwitch choices.
 * Does not import, spread, or backfill a legacy preset. Attribution is tracked
 * by output field and kept out of ProviderPreset/the console API contract.
 */
import type { ProviderPreset } from "./types.ts";
import { OFFICIAL_PRESET_FACTS, type IndependentPresetId, type PresetFacts } from "./preset-facts.ts";

interface EditorialChoice {
  id: IndependentPresetId;
  name: string;
  category: string;
  icon: string;
  ipv4Loopback?: true;
  selectDocumentedModel?: true;
  useDocumentedAuthOverride?: true;
  exposeGuidance?: boolean;
  exposeKeyGuide?: boolean;
  protocols?: NonNullable<ProviderPreset["protocols"]>;
  vertexMode?: NonNullable<ProviderPreset["vertexMode"]>;
  params?: NonNullable<ProviderPreset["urlParams"]>;
}

// These are EasySwitch compatibility/editorial decisions, not vendor facts.
// Categories are operational: 编程套餐 selects subscription billing on create.
const choices: EditorialChoice[] = [
  { id: "openai", name: "OpenAI", category: "国际官方", icon: "openai", selectDocumentedModel: true },
  { id: "anthropic", name: "Anthropic", category: "国际官方", icon: "anthropic", selectDocumentedModel: true },
  { id: "gemini", name: "Google Gemini", category: "国际官方", icon: "gemini-color", selectDocumentedModel: true },
  { id: "openrouter", name: "OpenRouter", category: "中转与聚合", icon: "openrouter-color" },
  { id: "azure-openai", name: "Azure OpenAI", category: "国际官方", icon: "openai", useDocumentedAuthOverride: true, params: [{ key: "resource", label: "Azure 资源名", example: "my-openai" }] },
  { id: "cloudflare-workers-ai", name: "Cloudflare Workers AI", category: "推理平台", icon: "cloudflare-ai-gateway-color", params: [{ key: "account_id", label: "Cloudflare 账号 ID", example: "a1b2c3…" }] },
  { id: "ollama", name: "Ollama", category: "本地", icon: "ollama-color", ipv4Loopback: true },
  { id: "lmstudio", name: "LM Studio", category: "本地", icon: "lmstudio", ipv4Loopback: true },
  { id: "vllm", name: "vLLM", category: "本地", icon: "vllm-color", ipv4Loopback: true },
  { id: "litellm", name: "LiteLLM", category: "本地", icon: "litellm", ipv4Loopback: true },
  { id: "deepseek", name: "DeepSeek", category: "国内官方", icon: "deepseek-color", selectDocumentedModel: true },
  { id: "kimi", name: "Kimi 开放平台", category: "国内官方", icon: "kimi-color" },
  { id: "zhipu", name: "智谱 GLM 开放平台", category: "国内官方", icon: "zhipu-color", selectDocumentedModel: true, exposeGuidance: false },
  { id: "qwen", name: "通义千问（百炼）", category: "国内官方", icon: "qwen-color" },
  { id: "volcengine", name: "火山方舟", category: "国内官方", icon: "volcengine-color", selectDocumentedModel: true },
  { id: "qianfan", name: "百度千帆", category: "国内官方", icon: "qianfan-color", exposeGuidance: false },
  { id: "stepfun", name: "阶跃星辰", category: "国内官方", icon: "stepfun-color", selectDocumentedModel: true, exposeGuidance: false },
  { id: "siliconflow", name: "硅基流动", category: "国内官方", icon: "siliconcloud-color" },
  { id: "xiaomi", name: "小米 MiMo 官方 API", category: "国内官方", icon: "xiaomi-color", selectDocumentedModel: true, useDocumentedAuthOverride: true },
  // Optional public fields are explicit choices; collecting evidence alone
  // must not introduce guidance, key links or alternate protocol surfaces.
  { id: "groq", name: "Groq", category: "推理平台", icon: "groq-color", exposeGuidance: true, exposeKeyGuide: true },
  { id: "cerebras", name: "Cerebras", category: "推理平台", icon: "cerebras", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "together", name: "Together", category: "推理平台", icon: "together", exposeGuidance: false, exposeKeyGuide: false },
  { id: "fireworks", name: "Fireworks", category: "推理平台", icon: "fireworks-color", exposeGuidance: false, exposeKeyGuide: false },
  { id: "deepinfra", name: "DeepInfra", category: "推理平台", icon: "deepinfra", exposeGuidance: false, exposeKeyGuide: false },
  { id: "sambanova", name: "SambaNova", category: "推理平台", icon: "sambanova", exposeGuidance: false, exposeKeyGuide: false },
  { id: "nebius", name: "Nebius Token Factory", category: "推理平台", icon: "nebius", exposeGuidance: false, exposeKeyGuide: false },
  { id: "nvidia", name: "NVIDIA NIM", category: "推理平台", icon: "nvidia-color", exposeGuidance: false, exposeKeyGuide: false },
  { id: "baseten", name: "Baseten", category: "推理平台", icon: "baseten", exposeGuidance: false, exposeKeyGuide: false },
  { id: "scaleway", name: "Scaleway", category: "推理平台", icon: "scaleway", exposeGuidance: false, exposeKeyGuide: false },
  { id: "digitalocean", name: "DigitalOcean", category: "推理平台", icon: "digitalocean", exposeGuidance: false, exposeKeyGuide: false },
  { id: "vultr", name: "Vultr", category: "推理平台", icon: "vultr", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "nscale", name: "Nscale", category: "推理平台", icon: "letter:N", exposeGuidance: false, exposeKeyGuide: false },
  { id: "venice", name: "Venice", category: "推理平台", icon: "venice", exposeGuidance: false, exposeKeyGuide: false },
  { id: "neuralwatt", name: "Neuralwatt", category: "推理平台", icon: "neuralwatt", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "synthetic", name: "Synthetic", category: "推理平台", icon: "synthetic", exposeGuidance: false, exposeKeyGuide: false },
  { id: "xai", name: "xAI", category: "国际官方", icon: "xai", exposeGuidance: true, exposeKeyGuide: true },
  { id: "mistral", name: "Mistral", category: "国际官方", icon: "mistral-color", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: true },
  { id: "meta", name: "Meta Model API", category: "国际官方", icon: "meta", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "zenmux", name: "ZenMux", category: "中转与聚合", icon: "zenmux", exposeGuidance: false, exposeKeyGuide: false },
  { id: "vercel", name: "Vercel AI Gateway", category: "中转与聚合", icon: "vercel-ai-gateway-color", exposeGuidance: false, exposeKeyGuide: false },
  { id: "huggingface", name: "Hugging Face", category: "中转与聚合", icon: "huggingface-color", exposeGuidance: false, exposeKeyGuide: false },
  // Their documented API-key requirement does not verify the runtime bearer
  // fallback. Preserve absent wire overrides without inventing header facts.
  { id: "packycode", name: "PackyCode", category: "中转与聚合", icon: "packycode", selectDocumentedModel: true, exposeGuidance: true, exposeKeyGuide: false },
  { id: "bizrouter", name: "BizRouter", category: "中转与聚合", icon: "letter:B", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "orcarouter", name: "OrcaRouter", category: "中转与聚合", icon: "orcarouter", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "tokenlab", name: "TokenLab", category: "中转与聚合", icon: "tokenlab", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "opengateway", name: "OpenGateway", category: "中转与聚合", icon: "opengateway", exposeGuidance: false, exposeKeyGuide: false },
  { id: "nanogpt", name: "NanoGPT", category: "中转与聚合", icon: "nanogpt", exposeGuidance: false, exposeKeyGuide: false },
  { id: "opencode-zen", name: "opencode Zen", category: "中转与聚合", icon: "opencode", exposeGuidance: false, exposeKeyGuide: false },
  { id: "kilo", name: "Kilo", category: "中转与聚合", icon: "kilo", exposeGuidance: false, exposeKeyGuide: false },
  { id: "vertex", name: "Google Vertex AI（标准）", category: "国际官方", icon: "gemini-color", selectDocumentedModel: true, exposeGuidance: true, exposeKeyGuide: true, protocols: ["gemini"], vertexMode: "standard" },
  { id: "vertex-express", name: "Google Vertex AI Express", category: "国际官方", icon: "gemini-color", selectDocumentedModel: true, exposeGuidance: true, exposeKeyGuide: true, protocols: ["gemini"], vertexMode: "express" },
  { id: "cloudflare-ai-gateway", name: "Cloudflare AI Gateway", category: "中转与聚合", icon: "cloudflare-ai-gateway-color", exposeGuidance: true, exposeKeyGuide: false, params: [{ key: "account_id", label: "Cloudflare 账号 ID" }, { key: "gateway", label: "网关名称", example: "my-gateway" }] },
  // Coding-plan identity and default choices remain unchanged. Restrictions are
  // evidence, not provider approval of arbitrary EasySwitch/agent traffic.
  { id: "zhipu-coding", name: "智谱 GLM 编程套餐", category: "编程套餐", icon: "zhipu-color", selectDocumentedModel: true },
  { id: "zai", name: "Z.AI GLM 编程套餐", category: "编程套餐", icon: "zai", selectDocumentedModel: true },
  { id: "kimi-coding", name: "Kimi For Coding", category: "编程套餐", icon: "kimi-color", selectDocumentedModel: true },
  { id: "minimax-coding", name: "MiniMax 编程套餐（国际）", category: "编程套餐", icon: "minimax-color", selectDocumentedModel: true },
  { id: "volcengine-coding", name: "火山方舟 编程套餐", category: "编程套餐", icon: "volcengine-color", selectDocumentedModel: true },
  { id: "tencent-coding", name: "腾讯云 编程套餐", category: "编程套餐", icon: "hunyuan-color", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "alibaba-token-plan", name: "阿里云 Token Plan（北京）", category: "编程套餐", icon: "alibaba-color", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
  { id: "mimo-token-plan", name: "小米 MiMo Token Plan", category: "编程套餐", icon: "xiaomi-color", selectDocumentedModel: true, useDocumentedAuthOverride: true },
  // The API-key requirement is documented; the implicit Bearer runtime is not
  // independent Go header evidence and does not justify a wire override.
  { id: "opencode-go", name: "opencode Go", category: "编程套餐", icon: "opencode", selectDocumentedModel: true, exposeGuidance: false, exposeKeyGuide: false },
];

export interface PresetFieldOrigin {
  kind: "official-fact" | "editorial" | "official-fact+editorial";
  factKeys: Array<keyof PresetFacts>;
  choice?: string;
}
export interface PresetReconstruction {
  preset: ProviderPreset;
  provenance: {
    status: "independent-reconstruction";
    scope: "documentation-only; no live request, entitlement, or capability verification";
    fields: Partial<Record<keyof ProviderPreset, PresetFieldOrigin>>;
  };
}

function reconstruct(choice: EditorialChoice): PresetReconstruction {
  const facts = OFFICIAL_PRESET_FACTS[choice.id];
  const fields: PresetReconstruction["provenance"]["fields"] = {};
  for (const key of ["id", "name", "category", "icon"] as const) {
    fields[key] = { kind: "editorial", factKeys: [], choice: "Retained EasySwitch identity, picker/billing category, display label, and original-avatar mapping." };
  }
  fields.baseUrl = { kind: choice.ipv4Loopback ? "official-fact+editorial" : "official-fact", factKeys: ["baseUrl"], ...(choice.ipv4Loopback ? { choice: "Use IPv4 loopback 127.0.0.1 instead of the documented localhost; retain port and path." } : {}) };
  const preset: ProviderPreset = {
    id: choice.id, name: choice.name, category: choice.category, icon: choice.icon,
    baseUrl: choice.ipv4Loopback ? facts.baseUrl.value.replace("http://localhost:", "http://127.0.0.1:") : facts.baseUrl.value,
  };
  // Facts may be recorded without adding an optional field to the public row.
  if (choice.exposeGuidance !== false) {
    preset.note = facts.guidance.value;
    fields.note = { kind: "official-fact+editorial", factKeys: ["guidance"], choice: "New EasySwitch Chinese guidance, restricted to the cited facts." };
  }
  if (facts.anthropicBaseUrl) {
    preset.anthropicBaseUrl = facts.anthropicBaseUrl.value;
    fields.anthropicBaseUrl = { kind: "official-fact", factKeys: ["anthropicBaseUrl"] };
  }
  if (choice.selectDocumentedModel) {
    if (!facts.modelId) throw new Error(`Missing documented model: ${choice.id}`);
    preset.defaultModel = facts.modelId.value;
    fields.defaultModel = { kind: "official-fact+editorial", factKeys: ["modelId"], choice: "Keep the same existing preselected documented model; do not upgrade defaults or infer access." };
  }
  if (facts.keyGuide && choice.exposeKeyGuide !== false) {
    preset.keyUrl = facts.keyGuide.value;
    fields.keyUrl = { kind: "official-fact+editorial", factKeys: ["keyGuide"], choice: "Open the checked official setup/key guide; old unverified console deep links are not reused." };
  }
  if (choice.params) {
    if (JSON.stringify(choice.params.map(p => p.key)) !== JSON.stringify(facts.placeholders?.value)) throw new Error(`Undocumented preset placeholders: ${choice.id}`);
    preset.urlParams = structuredClone(choice.params);
    fields.urlParams = { kind: "official-fact+editorial", factKeys: ["placeholders"], choice: "Keep EasySwitch placeholder keys, Chinese labels and synthetic examples; user supplies account-specific values." };
  }
  if (choice.useDocumentedAuthOverride) {
    const auth = facts.authentication.value;
    if (!auth.header || !auth.scheme) throw new Error(`Missing documented authentication: ${choice.id}`);
    preset.wire = { authHeader: auth.header, authScheme: auth.scheme };
    fields.wire = { kind: "official-fact", factKeys: ["authentication"] };
  }
  if (choice.protocols) {
    preset.protocols = structuredClone(choice.protocols);
    fields.protocols = { kind: "editorial", factKeys: [], choice: "Retain the existing native Gemini adapter selection; documented alternate surfaces do not expand preset protocols." };
  }
  if (choice.vertexMode) {
    preset.vertexMode = choice.vertexMode;
    fields.vertexMode = { kind: "editorial", factKeys: [], choice: "Retain the existing standard supplied-access-token or Express API-key workflow; no credential discovery, refresh or service-account migration." };
  }
  return { preset, provenance: { status: "independent-reconstruction", scope: "documentation-only; no live request, entitlement, or capability verification", fields } };
}

const reconstructed = choices.map(reconstruct);
export const INDEPENDENT_PRESETS: ProviderPreset[] = reconstructed.map(entry => entry.preset);
export const INDEPENDENT_PRESET_PROVENANCE = Object.fromEntries(reconstructed.map(entry => [entry.preset.id, entry.provenance])) as Record<IndependentPresetId, PresetReconstruction["provenance"]>;
