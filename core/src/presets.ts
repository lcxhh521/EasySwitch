import type { ProviderPreset } from "./types.ts";

/**
 * One-click starting points. The addresses only prefill the form: the probe
 * that runs after adding is what establishes whether a provider works and
 * which route each harness takes, so a stale address shows up there.
 */
export const PRESETS: ProviderPreset[] = [
  {
    id: "deepseek", name: "DeepSeek", icon: "deepseek-color",
    baseUrl: "https://api.deepseek.com/v1", anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    defaultModel: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "kimi", name: "Kimi", icon: "kimi",
    baseUrl: "https://api.moonshot.cn/v1", anthropicBaseUrl: "https://api.moonshot.cn/anthropic",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "zhipu", name: "智谱 GLM", icon: "zhipu-color",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4", anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
  },
  {
    id: "minimax", name: "MiniMax", icon: "minimax-color",
    baseUrl: "https://api.minimaxi.com/v1", anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
  },
  {
    id: "openrouter", name: "OpenRouter", icon: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "relay", name: "自定义中转站", icon: "newapi-color",
    baseUrl: "",
  },
];

/** The icon for a provider, from its address; relays and unknown hosts get the relay mark. */
export function iconForBaseUrl(baseUrl: string): string {
  let host = "";
  let port = "";
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    port = url.port;
  } catch {
    // Not a URL: falls through to the relay mark.
  }
  // Only Ollama's own port reads as Ollama; any other local address is some relay.
  if (/^(127\.0\.0\.1|localhost)$/.test(host)) return port === "11434" ? "ollama" : "newapi-color";
  const table: Array<[RegExp, string]> = [
    [/deepseek/, "deepseek-color"], [/moonshot|kimi/, "kimi"], [/bigmodel|zhipu/, "zhipu-color"],
    [/dashscope|aliyun|qwen/, "qwen-color"], [/minimax/, "minimax-color"], [/openrouter/, "openrouter"],
    [/anthropic/, "anthropic"], [/openai\.com/, "openai"], [/googleapis|gemini/, "gemini-color"],
    [/siliconflow/, "siliconcloud-color"], [/volces|volcengine|ark\./, "volcengine-color"],
    [/hunyuan|tencent/, "hunyuan-color"], [/stepfun/, "stepfun-color"], [/x\.ai/, "xai"],
    [/groq/, "groq"], [/mistral/, "mistral-color"],
  ];
  return table.find(([re]) => re.test(host))?.[1] ?? "newapi-color";
}
