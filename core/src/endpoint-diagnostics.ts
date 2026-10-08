/**
 * Read-only route diagnostics. This module never probes, reads credentials, or
 * changes a provider. Only exact, independently documented official endpoints
 * are recognized; an unknown/custom URL is not evidence of a broken route.
 */
import type { Provider, WireConfig } from "./types.ts";
import { endpointUrl } from "./upstream.ts";

/** Route fields only. Authentication headers and saved keys are not needed. */
export type ProviderEndpointMetadata = Pick<Provider, "baseUrl" | "anthropicBaseUrl" | "urlParams"> & {
  wire?: Pick<WireConfig, "paths" | "query">;
};

export interface MessagesEndpointDiagnostic {
  code: "source_messages_endpoint_stale";
  service: string;
  staleEndpoint: string;
  recommendedBaseUrl: string;
  recommendedEndpoint: string;
  hasPathOverride: boolean;
}

// Checked 2026-10-08 against official documentation. These are full request
// URLs, not SDK roots: EasySwitch appends /messages, not /v1/messages.
// Keep old endpoints explicit, so a future fact update cannot broaden matching.
const KNOWN_STALE_MESSAGES = [
  {
    service: "DeepSeek",
    staleEndpoint: "https://api.deepseek.com/anthropic/messages",
    recommendedBaseUrl: "https://api.deepseek.com/anthropic/v1",
    // https://api-docs.deepseek.com/guides/anthropic_api/
    // SDK path: https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/resources/messages/messages.py
  },
  {
    service: "Kimi 开放平台",
    staleEndpoint: "https://api.moonshot.cn/anthropic/messages",
    recommendedBaseUrl: "https://api.moonshot.cn/anthropic/v1",
    // https://platform.kimi.com/docs/api/messages
  },
  {
    service: "智谱 GLM 开放平台",
    staleEndpoint: "https://open.bigmodel.cn/api/anthropic/messages",
    recommendedBaseUrl: "https://open.bigmodel.cn/api/anthropic/v1",
    // https://docs.bigmodel.cn/cn/guide/develop/claude/introduction
  },
  {
    service: "通义千问（百炼）",
    staleEndpoint: "https://dashscope.aliyuncs.com/apps/anthropic/messages",
    recommendedBaseUrl: "https://dashscope.aliyuncs.com/apps/anthropic/v1",
    // https://help.aliyun.com/en/model-studio/base-url
    // https://help.aliyun.com/en/model-studio/anthropic-api-messages
  },
  {
    service: "小米 MiMo 官方 API",
    staleEndpoint: "https://api.xiaomimimo.com/anthropic/messages",
    recommendedBaseUrl: "https://api.xiaomimimo.com/anthropic/v1",
    // https://mimo.mi.com/docs/en-US/api/chat/anthropic-api
  },
] as const;

/** Return fixed public guidance only; never return or stringify a supplied URL. */
export function diagnoseMessagesEndpoint(provider?: ProviderEndpointMetadata): MessagesEndpointDiagnostic | undefined {
  if (!provider) return undefined;
  try {
    // Use the runtime join/placeholder/query semantics, including an explicitly
    // empty path override. Looking at anthropicBaseUrl alone creates false alarms
    // for users who already fixed the effective route with wire.paths.messages.
    const effective = endpointUrl(provider, "messages");
    const known = KNOWN_STALE_MESSAGES.find(row => row.staleEndpoint === effective);
    if (!known) return undefined;
    return {
      code: "source_messages_endpoint_stale",
      ...known,
      recommendedEndpoint: `${known.recommendedBaseUrl}/messages`,
      hasPathOverride: provider.wire?.paths?.messages !== undefined,
    };
  } catch {
    // An invalid URL or unresolved placeholder is outside this bounded check.
    // Do not expose raw error messages or infer a vendor from a malformed URL.
    return undefined;
  }
}
