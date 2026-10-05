import type { ProviderPreset } from "./types.ts";

/**
 * One-click starting points. The addresses only prefill the form: the probe
 * that runs after adding is what establishes whether a provider works and
 * which route each harness takes, so a stale address shows up there.
 */
export const PRESETS: ProviderPreset[] = [
  // 编程套餐 / 国内主流
  {
    id: "deepseek", name: "DeepSeek", icon: "deepseek-color",
    baseUrl: "https://api.deepseek.com/v1", anthropicBaseUrl: "https://api.deepseek.com/anthropic",
    defaultModel: "deepseek-chat", keyUrl: "https://platform.deepseek.com/api_keys",
    note: "官方 API，也有 Anthropic 兼容地址",
  },
  {
    id: "kimi", name: "Kimi", icon: "kimi",
    baseUrl: "https://api.moonshot.cn/v1", anthropicBaseUrl: "https://api.moonshot.cn/anthropic",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    note: "Kimi 开放平台（moonshot.cn）；用 API Key，不是会员账号",
  },
  {
    id: "kimi-coding", name: "Kimi For Coding", icon: "kimi",
    baseUrl: "https://api.kimi.com/coding/v1",
    keyUrl: "https://www.kimi.com/coding",
    note: "Kimi 编程套餐（api.kimi.com）；Key 在会员页拿",
  },
  {
    id: "zhipu", name: "智谱 GLM", icon: "zhipu-color",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4", anthropicBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    defaultModel: "glm-4.6", keyUrl: "https://bigmodel.cn/console/usercenter/apikeys",
    note: "GLM 开放平台；编程套餐用同一个地址",
  },
  {
    id: "minimax", name: "MiniMax", icon: "minimax-color",
    baseUrl: "https://api.minimaxi.com/v1", anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
    defaultModel: "MiniMax-M3", keyUrl: "https://platform.minimaxi.com",
    note: "MiniMax 国内站（minimaxi.com）",
  },
  {
    id: "siliconflow", name: "硅基流动", icon: "siliconcloud-color",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    note: "聚合平台：DeepSeek、Qwen、GLM 都有",
  },
  {
    id: "qwen", name: "通义千问", icon: "qwen-color",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://bailian.console.aliyun.com/",
    note: "阿里云百炼（兼容模式）",
  },
  {
    id: "volcengine", name: "火山方舟", icon: "volcengine-color",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyUrl: "https://console.volcengine.com/ark/",
    note: "豆包 / 火山引擎；模型用接入点 ID",
  },
  // 聚合 / 国际
  {
    id: "openrouter", name: "OpenRouter", icon: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    note: "一个 Key 用几百个模型",
  },
  {
    id: "openai", name: "OpenAI", icon: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.5", keyUrl: "https://platform.openai.com/api-keys",
    note: "官方 API；原样转发 Responses 协议",
  },
  {
    id: "anthropic", name: "Anthropic", icon: "anthropic",
    baseUrl: "https://api.anthropic.com/v1", anthropicBaseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-5", keyUrl: "https://console.anthropic.com/settings/keys",
    note: "官方 API；Claude Code 原样转发",
  },
  {
    id: "gemini", name: "Google Gemini", icon: "gemini-color",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    note: "AI Studio 的 Key，OpenAI 兼容层",
  },
  {
    id: "groq", name: "Groq", icon: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    note: "跑得快；有开源模型",
  },
  {
    id: "xai", name: "xAI", icon: "xai",
    baseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    note: "Grok 官方 API",
  },
  // 本地
  {
    id: "ollama", name: "Ollama", icon: "ollama",
    baseUrl: "http://127.0.0.1:11434/v1",
    note: "本机模型，不需要 Key",
  },
  {
    id: "lmstudio", name: "LM Studio", icon: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    note: "本机模型，不需要 Key",
  },
  // 自定义
  {
    id: "relay", name: "自定义中转站", icon: "newapi-color",
    baseUrl: "",
    note: "任何 OpenAI 兼容地址；粘贴「地址 + Key」也行",
  },
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
