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
  /** SDK-derived means documented client root plus the SDK's /v1/messages operation. */
  endpointEvidence: "direct" | "sdk-derived";
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
    endpointEvidence: "sdk-derived",
    // https://api-docs.deepseek.com/guides/anthropic_api/
    // SDK path: https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/resources/messages/messages.py
  },
  {
    service: "Kimi 开放平台",
    staleEndpoint: "https://api.moonshot.cn/anthropic/messages",
    recommendedBaseUrl: "https://api.moonshot.cn/anthropic/v1",
    endpointEvidence: "direct",
    // https://platform.kimi.com/docs/api/messages
  },
  {
    // The API and Coding Plan presets share this endpoint; diagnose it once.
    service: "智谱 GLM",
    staleEndpoint: "https://open.bigmodel.cn/api/anthropic/messages",
    recommendedBaseUrl: "https://open.bigmodel.cn/api/anthropic/v1",
    endpointEvidence: "direct",
    // https://docs.bigmodel.cn/cn/guide/develop/claude/introduction
  },
  {
    service: "通义千问（百炼）",
    staleEndpoint: "https://dashscope.aliyuncs.com/apps/anthropic/messages",
    recommendedBaseUrl: "https://dashscope.aliyuncs.com/apps/anthropic/v1",
    endpointEvidence: "direct",
    // https://help.aliyun.com/en/model-studio/base-url
    // https://help.aliyun.com/en/model-studio/anthropic-api-messages
  },
  {
    service: "小米 MiMo 官方 API",
    staleEndpoint: "https://api.xiaomimimo.com/anthropic/messages",
    recommendedBaseUrl: "https://api.xiaomimimo.com/anthropic/v1",
    endpointEvidence: "direct",
    // https://mimo.mi.com/docs/en-US/api/chat/anthropic-api
  },
  {
    service: "Z.AI GLM 编程套餐",
    staleEndpoint: "https://api.z.ai/api/anthropic/messages",
    recommendedBaseUrl: "https://api.z.ai/api/anthropic/v1",
    endpointEvidence: "sdk-derived",
    // https://docs.z.ai/devpack/tool/claude
    // Documented client root + official Anthropic SDK /v1/messages operation.
  },
  {
    service: "Kimi Code 国内套餐",
    staleEndpoint: "https://api.kimi.com/coding/messages",
    recommendedBaseUrl: "https://api.kimi.com/coding/v1",
    endpointEvidence: "direct",
    // https://www.kimi.com/code/docs/en/
    // https://www.kimi.com/code/docs/en/third-party-tools/claude-code.html
  },
  {
    service: "MiniMax 编程套餐（国际）",
    staleEndpoint: "https://api.minimax.io/anthropic/messages",
    recommendedBaseUrl: "https://api.minimax.io/anthropic/v1",
    endpointEvidence: "direct",
    // https://platform.minimax.io/docs/api-reference/text-chat-anthropic
    // CN minimaxi.com status is unresolved; neither CN host is included here.
  },
  {
    service: "火山方舟 Coding Plan",
    staleEndpoint: "https://ark.cn-beijing.volces.com/api/coding/messages",
    recommendedBaseUrl: "https://ark.cn-beijing.volces.com/api/coding/v1",
    endpointEvidence: "sdk-derived",
    // https://docs.volcengine.com/docs/ark/coding-plan-personal-ai-claude-code?lang=zh
    // Documented client root + official Anthropic SDK /v1/messages operation.
  },
  {
    service: "小米 MiMo Token Plan",
    staleEndpoint: "https://token-plan-cn.xiaomimimo.com/anthropic/messages",
    recommendedBaseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic/v1",
    endpointEvidence: "direct",
    // https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access
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
