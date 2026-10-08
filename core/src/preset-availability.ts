/**
 * Narrow new-provider safety notices, checked against official documentation.
 * This is not a live capability registry and never changes saved providers.
 * Hyperbolic's FAQ, read 2026-10-08, says serverless inference and playground
 * are retired and old model requests fail even with a valid API key.
 */
import type { ProviderPreset } from "./types.ts";

export interface PresetUnavailable {
  reason: string;
  sourceUrl: string;
}

export const HYPERBOLIC_RETIRED: Readonly<PresetUnavailable> = Object.freeze({
  reason: "Hyperbolic 已停用无服务器推理 API 和 playground，旧模型即使使用有效 Key 也无法调用。这个预设不再接受新增；请查看官方停用说明。",
  sourceUrl: "https://www.hyperbolic.ai/docs/faq/inference-models",
});

/** Add only a documented negative status; absence is not an availability claim. */
export function withPresetAvailability(preset: ProviderPreset): ProviderPreset & { unavailable?: PresetUnavailable } {
  return preset.id === "hyperbolic" ? { ...preset, unavailable: { ...HYPERBOLIC_RETIRED } } : preset;
}

/**
 * Preflight new add-and-test requests only, before secrets, storage or network.
 * Match the exact known retired base after standard URL/trailing-slash
 * normalization. Other hosts, routes, query-bearing custom URLs and saved
 * providers are not reclassified by a broad vendor-host rule.
 */
export function newProviderUnavailable(input: { presetId?: unknown; baseUrl?: unknown }): Readonly<PresetUnavailable> | undefined {
  if (input.presetId === "hyperbolic") return HYPERBOLIC_RETIRED;
  if (typeof input.baseUrl !== "string") return;
  try {
    const url = new URL(input.baseUrl.trim());
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (url.href === "https://api.hyperbolic.xyz/v1") return HYPERBOLIC_RETIRED;
  } catch { /* Ordinary URL validation remains the caller's responsibility. */ }
  return;
}
