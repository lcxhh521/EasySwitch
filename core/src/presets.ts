import type { ProviderPreset, WireConfig } from "./types.ts";

/**
 * One-click starting points, grouped for the picker. Addresses, labels, key
 * pages and default models come from the provider registry of opencodex (MIT,
 * src/providers/registry/entries-*.ts, read 2026-10-05), checked and trimmed
 * by hand; entries whose address needs the user's own account id (Azure,
 * Cloudflare, Vertex) or a proprietary protocol (Qoder, CodeBuddy, GitLab
 * Duo) are left out. The addresses only prefill the form: the probe that
 * runs after adding is what establishes whether a provider works and which
 * route each harness takes, so a stale address shows up there.
 */
export const PRESET_CATEGORIES = ["编程套餐", "国内官方", "国际官方", "中转与聚合", "推理平台", "本地", "自定义"] as const;

type Extra = {
  anthropic?: string; model?: string; key?: string; note?: string; icon?: string;
  params?: Array<{ key: string; label: string; example?: string }>;
  wire?: WireConfig;
};

/**
 * Brand mark per preset (files in web/icons: lobe-icons, MIT, and opencodex's
 * provider-icons set, MIT; the marks belong to their owners and only identify
 * the service). A preset without one gets a letter avatar, never another
 * brand's mark.
 */
const ICON_BY_ID: Record<string, string> = {
  "zhipu-coding": "zhipu-color", zhipu: "zhipu-color", zai: "zai",
  "kimi-coding": "kimi-color", kimi: "kimi-color",
  "minimax-coding-cn": "minimax-color", "minimax-coding": "minimax-color",
  "volcengine-coding": "volcengine-color", volcengine: "volcengine-color",
  "tencent-coding": "hunyuan-color", "alibaba-token-plan": "alibaba-color", qwen: "qwen-color",
  "mimo-token-plan": "xiaomi-color", xiaomi: "xiaomi-color", "opencode-go": "opencode", "opencode-zen": "opencode",
  deepseek: "deepseek-color", qianfan: "qianfan-color", stepfun: "stepfun-color", siliconflow: "siliconcloud-color",
  openai: "openai", "azure-openai": "openai", anthropic: "anthropic", gemini: "gemini-color", xai: "xai", mistral: "mistral-color", meta: "meta",
  openrouter: "openrouter-color", zenmux: "zenmux", vercel: "vercel-ai-gateway-color", huggingface: "huggingface-color",
  packycode: "packycode", orcarouter: "orcarouter", tokenlab: "tokenlab", opengateway: "opengateway",
  nanogpt: "nanogpt", cline: "cline-color", kilo: "kilo", "cloudflare-ai-gateway": "cloudflare-ai-gateway-color", "cloudflare-workers-ai": "cloudflare-ai-gateway-color",
  groq: "groq-color", cerebras: "cerebras", together: "together", fireworks: "fireworks-color", deepinfra: "deepinfra", sambanova: "sambanova",
  nebius: "nebius", hyperbolic: "hyperbolic", nvidia: "nvidia-color", baseten: "baseten", scaleway: "scaleway", digitalocean: "digitalocean",
  vultr: "vultr", venice: "venice", neuralwatt: "neuralwatt", synthetic: "synthetic",
  ollama: "ollama-color", "ollama-cloud": "ollama-color", lmstudio: "lm-studio-color", vllm: "vllm-color", litellm: "litellm",
  relay: "newapi-color",
};

/** A letter avatar: the first character of the name, coloured by a hash so neighbours differ. */
export function letterIcon(name: string): string {
  return `letter:${[...name.trim()][0]?.toUpperCase() ?? "?"}`;
}

function p(category: typeof PRESET_CATEGORIES[number], id: string, name: string, baseUrl: string, x: Extra = {}): ProviderPreset {
  return {
    id, name, category, baseUrl,
    icon: x.icon ?? ICON_BY_ID[id] ?? letterIcon(name),
    ...(x.anthropic ? { anthropicBaseUrl: x.anthropic } : {}),
    ...(x.model ? { defaultModel: x.model } : {}),
    ...(x.key ? { keyUrl: x.key } : {}),
    ...(x.note ? { note: x.note } : {}),
    ...(x.params ? { urlParams: x.params } : {}),
    ...(x.wire ? { wire: x.wire } : {}),
  };
}

export const PRESETS: ProviderPreset[] = [
  // 编程套餐：按月订阅、给编程工具用的 Key
  p("编程套餐", "zhipu-coding", "智谱 GLM 编程套餐", "https://open.bigmodel.cn/api/coding/paas/v4", { anthropic: "https://open.bigmodel.cn/api/anthropic", model: "glm-5.3", key: "https://bigmodel.cn/console/usercenter/apikeys", note: "GLM Coding Plan（国内站）" }),
  p("编程套餐", "zai", "Z.AI GLM 编程套餐", "https://api.z.ai/api/coding/paas/v4", { anthropic: "https://api.z.ai/api/anthropic", model: "glm-5.3", key: "https://z.ai/manage-apikey/apikey-list", note: "GLM Coding Plan（国际站）" }),
  p("编程套餐", "kimi-coding", "Kimi For Coding", "https://api.kimi.com/coding/v1", { anthropic: "https://api.kimi.com/coding", model: "kimi-for-coding", key: "https://www.kimi.com/coding", note: "Kimi 编程套餐，Key 在会员页拿" }),
  p("编程套餐", "minimax-coding-cn", "MiniMax 编程套餐（国内）", "https://api.minimaxi.com/v1", { anthropic: "https://api.minimaxi.com/anthropic", model: "MiniMax-M3", key: "https://platform.minimaxi.com" }),
  p("编程套餐", "minimax-coding", "MiniMax 编程套餐（国际）", "https://api.minimax.io/v1", { anthropic: "https://api.minimax.io/anthropic", model: "MiniMax-M3", key: "https://platform.minimax.io" }),
  p("编程套餐", "volcengine-coding", "火山方舟 编程套餐", "https://ark.cn-beijing.volces.com/api/coding/v3", { anthropic: "https://ark.cn-beijing.volces.com/api/coding", model: "ark-code-latest", key: "https://console.volcengine.com/ark/", note: "Ark Coding Plan" }),
  p("编程套餐", "tencent-coding", "腾讯云 编程套餐", "https://api.lkeap.cloud.tencent.com/coding/v3", { model: "tc-code-latest" }),
  p("编程套餐", "alibaba-token-plan", "阿里云 Token Plan（北京）", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", { model: "qwen3.8-max" }),
  p("编程套餐", "mimo-token-plan", "小米 MiMo Token Plan", "https://token-plan-cn.xiaomimimo.com/v1", { model: "mimo-v2.6-pro" }),
  p("编程套餐", "opencode-go", "opencode Go", "https://opencode.ai/zen/go/v1", { model: "kimi-k2.7-code" }),

  // 国内官方：按量计费的开放平台
  p("国内官方", "deepseek", "DeepSeek", "https://api.deepseek.com/v1", { anthropic: "https://api.deepseek.com/anthropic", model: "deepseek-flash", key: "https://platform.deepseek.com/api_keys", note: "官方 API，也有 Anthropic 兼容地址" }),
  p("国内官方", "kimi", "Kimi 开放平台", "https://api.moonshot.cn/v1", { anthropic: "https://api.moonshot.cn/anthropic", key: "https://platform.moonshot.cn/console/api-keys", note: "moonshot.cn；用 API Key，不是会员账号" }),
  p("国内官方", "zhipu", "智谱 GLM 开放平台", "https://open.bigmodel.cn/api/paas/v4", { anthropic: "https://open.bigmodel.cn/api/anthropic", model: "glm-4.6", key: "https://bigmodel.cn/console/usercenter/apikeys" }),
  p("国内官方", "qwen", "通义千问（百炼）", "https://dashscope.aliyuncs.com/compatible-mode/v1", { anthropic: "https://dashscope.aliyuncs.com/apps/anthropic", key: "https://bailian.console.aliyun.com/", note: "阿里云百炼兼容模式" }),
  p("国内官方", "volcengine", "火山方舟", "https://ark.cn-beijing.volces.com/api/v3", { model: "doubao-seed-2-1-pro-260628", key: "https://console.volcengine.com/ark/", note: "豆包 / 火山引擎；模型填接入点 ID" }),
  p("国内官方", "qianfan", "百度千帆", "https://qianfan.baidubce.com/v2", { key: "https://console.bce.baidu.com/iam/#/iam/apikey/list" }),
  p("国内官方", "stepfun", "阶跃星辰", "https://api.stepfun.com/v1", { model: "step-5-preview", key: "https://platform.stepfun.com/" }),
  p("国内官方", "siliconflow", "硅基流动", "https://api.siliconflow.cn/v1", { key: "https://cloud.siliconflow.cn/account/ak", note: "聚合平台：DeepSeek、Qwen、GLM 都有" }),
  p("国内官方", "xiaomi", "小米 MiMo", "https://api.xiaomimimo.com/v1", { anthropic: "https://api.xiaomimimo.com/anthropic", model: "mimo-v2.6-flash" }),

  // 国际官方
  p("国际官方", "openai", "OpenAI", "https://api.openai.com/v1", { model: "gpt-5.5", key: "https://platform.openai.com/api-keys", note: "官方 API；原样转发 Responses 协议" }),
  p("国际官方", "anthropic", "Anthropic", "https://api.anthropic.com/v1", { anthropic: "https://api.anthropic.com/v1", model: "claude-sonnet-5", key: "https://console.anthropic.com/settings/keys", note: "官方 API Key（不是 Claude 订阅）" }),
  p("国际官方", "gemini", "Google Gemini", "https://generativelanguage.googleapis.com/v1beta/openai", { model: "gemini-3.5-flash", key: "https://aistudio.google.com/apikey", note: "AI Studio 的 Key，OpenAI 兼容层" }),
  p("国际官方", "xai", "xAI", "https://api.x.ai/v1", { key: "https://console.x.ai", note: "Grok 官方 API" }),
  p("国际官方", "mistral", "Mistral", "https://api.mistral.ai/v1", { model: "codestral-latest", key: "https://console.mistral.ai/api-keys" }),
  p("国际官方", "meta", "Meta Model API", "https://api.meta.ai/v1", { model: "muse-spark-1.3" }),

  // 中转与聚合
  p("中转与聚合", "openrouter", "OpenRouter", "https://openrouter.ai/api/v1", { key: "https://openrouter.ai/keys", note: "一个 Key 用几百个模型" }),
  p("中转与聚合", "zenmux", "ZenMux", "https://zenmux.ai/api/v1"),
  p("中转与聚合", "vercel", "Vercel AI Gateway", "https://ai-gateway.vercel.sh/v1"),
  p("中转与聚合", "huggingface", "Hugging Face", "https://router.huggingface.co/v1"),
  p("中转与聚合", "packycode", "PackyCode", "https://cf.api.fan/v1", { model: "gpt-5.5", note: "API 中转，Codex 分组的令牌" }),
  p("中转与聚合", "bizrouter", "BizRouter", "https://api.bizrouter.ai/v1", { model: "openai/gpt-5.6-sol" }),
  p("中转与聚合", "orcarouter", "OrcaRouter", "https://api.orcarouter.ai/v1", { model: "openai/gpt-5.5" }),
  p("中转与聚合", "tokenlab", "TokenLab", "https://api.tokenlab.sh/v1", { model: "gpt-5.6-terra" }),
  p("中转与聚合", "opengateway", "OpenGateway", "https://apis.opengateway.ai/v1"),
  p("中转与聚合", "nanogpt", "NanoGPT", "https://nano-gpt.com/api/v1"),
  p("中转与聚合", "opencode-zen", "opencode Zen", "https://opencode.ai/zen/v1"),
  p("中转与聚合", "cline", "Cline", "https://api.cline.bot/api/v1", { model: "anthropic/claude-sonnet-5" }),
  p("中转与聚合", "kilo", "Kilo", "https://api.kilo.ai/api/gateway"),

  // 地址里有你自己的名字或 ID 的
  p("国际官方", "azure-openai", "Azure OpenAI", "https://{resource}.openai.azure.com/openai/v1", {
    params: [{ key: "resource", label: "Azure 资源名", example: "my-openai" }],
    wire: { authHeader: "api-key", authScheme: "raw" },
    icon: "openai", key: "https://portal.azure.com/", note: "模型名填「部署名」；用的是 v1 接口，不需要 api-version",
  }),
  p("推理平台", "cloudflare-workers-ai", "Cloudflare Workers AI", "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1", {
    params: [{ key: "account_id", label: "Cloudflare 账号 ID", example: "a1b2c3…" }],
    key: "https://dash.cloudflare.com/profile/api-tokens", note: "有免费额度；模型名形如 @cf/meta/llama-3.3-70b-instruct-fp8-fast",
  }),
  p("中转与聚合", "cloudflare-ai-gateway", "Cloudflare AI Gateway", "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/openai", {
    anthropic: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/anthropic",
    params: [{ key: "account_id", label: "Cloudflare 账号 ID" }, { key: "gateway", label: "网关名称", example: "my-gateway" }],
    note: "套在别的服务商前面的网关；Key 填你要用的那家的 Key",
  }),

  // 推理平台
  p("推理平台", "groq", "Groq", "https://api.groq.com/openai/v1", { key: "https://console.groq.com/keys", note: "跑得快；有开源模型" }),
  p("推理平台", "cerebras", "Cerebras", "https://api.cerebras.ai/v1", { model: "gpt-oss-120b" }),
  p("推理平台", "together", "Together", "https://api.together.xyz/v1"),
  p("推理平台", "fireworks", "Fireworks", "https://api.fireworks.ai/inference/v1"),
  p("推理平台", "deepinfra", "DeepInfra", "https://api.deepinfra.com/v1/openai"),
  p("推理平台", "sambanova", "SambaNova", "https://api.sambanova.ai/v1"),
  p("推理平台", "nebius", "Nebius Token Factory", "https://api.tokenfactory.nebius.com/v1"),
  p("推理平台", "hyperbolic", "Hyperbolic", "https://api.hyperbolic.xyz/v1"),
  p("推理平台", "nvidia", "NVIDIA NIM", "https://integrate.api.nvidia.com/v1"),
  p("推理平台", "baseten", "Baseten", "https://inference.baseten.co/v1"),
  p("推理平台", "scaleway", "Scaleway", "https://api.scaleway.ai/v1"),
  p("推理平台", "digitalocean", "DigitalOcean", "https://inference.do-ai.run/v1"),
  p("推理平台", "vultr", "Vultr", "https://api.vultrinference.com/v1", { model: "kimi-k2-instruct" }),
  p("推理平台", "nscale", "Nscale", "https://inference.api.nscale.com/v1"),
  p("推理平台", "venice", "Venice", "https://api.venice.ai/api/v1"),
  p("推理平台", "neuralwatt", "Neuralwatt", "https://api.neuralwatt.com/v1", { model: "glm-5.3" }),
  p("推理平台", "synthetic", "Synthetic", "https://api.synthetic.new/openai/v1"),
  p("推理平台", "ollama-cloud", "Ollama Cloud", "https://ollama.com/v1", { model: "glm-5.3" }),

  // 本地
  p("本地", "ollama", "Ollama", "http://127.0.0.1:11434/v1", { note: "本机模型，不需要 Key" }),
  p("本地", "lmstudio", "LM Studio", "http://127.0.0.1:1234/v1", { icon: "lmstudio", note: "本机模型，不需要 Key" }),
  p("本地", "vllm", "vLLM", "http://127.0.0.1:8000/v1", { note: "本机或自己的服务器" }),
  p("本地", "litellm", "LiteLLM", "http://127.0.0.1:4000/v1", { note: "自己搭的 LiteLLM 代理" }),

  // 自定义
  { id: "relay", name: "自定义中转站", category: "自定义", icon: "newapi-color", baseUrl: "", note: "任何 OpenAI 兼容地址；也可以回到首页把使用说明整段粘贴" },
  { id: "mimo-free", name: "小米 MiMo Free", category: "国内官方", icon: "xiaomi-color", baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat", models: ["mimo-auto"], wire: { paths: { chat: "", models: "" } }, note: "小米的免费公开档位，不需要 key；提示词会由小米处理，别发敏感内容。非公开接口，随时可能变化或受限" },
];

/** The icon for a provider, from its address: a preset on the same host first, then the vendor table, else a letter avatar. */
export function iconForBaseUrl(baseUrl: string, name?: string): string {
  let host = "";
  let port = "";
  try {
    const url = new URL(baseUrl);
    host = url.hostname;
    port = url.port;
  } catch {
    // Not a URL: falls through to the fallback.
  }
  // Only Ollama's own port reads as Ollama; any other local address is some relay.
  if (/^(127\.0\.0\.1|localhost)$/.test(host)) return port === "11434" ? "ollama-color" : "newapi-color";
  // Placeholders in preset addresses ({resource}.openai.azure.com) match by their fixed tail.
  const sameHost = PRESETS.find(p => {
    try {
      const pattern = new URL(p.baseUrl.replace(/\{[^}]+\}/g, "x")).hostname;
      return pattern === host || (pattern.startsWith("x.") && host.endsWith(pattern.slice(1)));
    } catch {
      return false;
    }
  });
  if (sameHost && sameHost.id !== "relay") return sameHost.icon;
  const table: Array<[RegExp, string]> = [
    [/deepseek/, "deepseek-color"], [/moonshot|kimi/, "kimi-color"], [/bigmodel|zhipu/, "zhipu-color"],
    [/dashscope|aliyun|qwen/, "qwen-color"], [/minimax/, "minimax-color"], [/openrouter/, "openrouter-color"],
    [/anthropic/, "anthropic"], [/openai\.com/, "openai"], [/googleapis|gemini/, "gemini-color"],
    [/siliconflow/, "siliconcloud-color"], [/volces|volcengine|ark\./, "volcengine-color"],
    [/hunyuan|tencent/, "hunyuan-color"], [/stepfun/, "stepfun-color"], [/x\.ai/, "xai"],
    [/groq/, "groq-color"], [/mistral/, "mistral-color"],
  ];
  return table.find(([re]) => re.test(host))?.[1] ?? (name ? letterIcon(name) : "newapi-color");
}
