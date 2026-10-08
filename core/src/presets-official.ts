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
  fields.note = { kind: "official-fact+editorial", factKeys: ["guidance"], choice: "New EasySwitch Chinese guidance, restricted to the cited facts." };
  const preset: ProviderPreset = {
    id: choice.id, name: choice.name, category: choice.category, icon: choice.icon,
    baseUrl: choice.ipv4Loopback ? facts.baseUrl.value.replace("http://localhost:", "http://127.0.0.1:") : facts.baseUrl.value,
    note: facts.guidance.value,
  };
  if (facts.anthropicBaseUrl) {
    preset.anthropicBaseUrl = facts.anthropicBaseUrl.value;
    fields.anthropicBaseUrl = { kind: "official-fact", factKeys: ["anthropicBaseUrl"] };
  }
  if (choice.selectDocumentedModel) {
    if (!facts.modelId) throw new Error(`Missing documented model: ${choice.id}`);
    preset.defaultModel = facts.modelId.value;
    fields.defaultModel = { kind: "official-fact+editorial", factKeys: ["modelId"], choice: "Keep the same existing preselected documented model; do not upgrade defaults or infer access." };
  }
  if (facts.keyGuide) {
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
  return { preset, provenance: { status: "independent-reconstruction", scope: "documentation-only; no live request, entitlement, or capability verification", fields } };
}

const reconstructed = choices.map(reconstruct);
export const INDEPENDENT_PRESETS: ProviderPreset[] = reconstructed.map(entry => entry.preset);
export const INDEPENDENT_PRESET_PROVENANCE = Object.fromEntries(reconstructed.map(entry => [entry.preset.id, entry.provenance])) as Record<IndependentPresetId, PresetReconstruction["provenance"]>;
