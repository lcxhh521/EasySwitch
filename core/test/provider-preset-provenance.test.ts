import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PRESETS, PRESET_CATEGORIES, PRESET_PROVENANCE, letterIcon, iconForBaseUrl } from "../src/presets.ts";
import { INDEPENDENT_PRESETS, INDEPENDENT_PRESET_PROVENANCE } from "../src/presets-official.ts";
import { OFFICIAL_PRESET_FACTS, type IndependentPresetId } from "../src/preset-facts.ts";
import { INFERENCE_PRESET_FACTS, INFERENCE_RESEARCH_ONLY, type InferencePresetId } from "../src/preset-facts-inference.ts";
import type { GatewayPresetId } from "../src/preset-facts-gateway.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { prepareOutbound } from "../src/outbound.ts";
import type { Provider, ProviderPreset } from "../src/types.ts";
import { endpointUrl, expandUrl, UnresolvedPlaceholder, upstreamHeaders } from "../src/upstream.ts";

const inferenceIds = ["groq", "cerebras", "together", "fireworks", "deepinfra", "sambanova", "nebius", "nvidia", "baseten", "scaleway", "digitalocean", "vultr", "nscale", "venice", "neuralwatt", "synthetic"] as const;
const inferenceDomains: Record<InferencePresetId, string[]> = {
  groq: ["console.groq.com"], cerebras: ["inference-docs.cerebras.ai"], together: ["docs.together.ai", "www.together.ai"],
  fireworks: ["docs.fireworks.ai"], deepinfra: ["docs.deepinfra.com"], sambanova: ["docs.sambanova.ai"],
  nebius: ["docs.tokenfactory.nebius.com"], nvidia: ["docs.api.nvidia.com", "docs.nvidia.com"], baseten: ["docs.baseten.co"],
  scaleway: ["www.scaleway.com"], digitalocean: ["docs.digitalocean.com"], vultr: ["docs.vultr.com"],
  nscale: ["docs.nscale.com"], venice: ["docs.venice.ai"], neuralwatt: ["docs.neuralwatt.com", "portal.neuralwatt.com"], synthetic: ["dev.synthetic.new"],
};
const gatewayIds = ["xai", "mistral", "meta", "zenmux", "vercel", "huggingface", "packycode", "bizrouter", "orcarouter", "tokenlab", "opengateway", "nanogpt", "opencode-zen", "kilo", "vertex", "vertex-express", "cloudflare-ai-gateway"] as const;
const gatewayDomains: Record<GatewayPresetId, string[]> = {
  xai: ["docs.x.ai"], mistral: ["docs.mistral.ai"], meta: ["dev.meta.ai"], zenmux: ["zenmux.ai"], vercel: ["vercel.com"],
  huggingface: ["huggingface.co"], packycode: ["docs.packyapi.com"], bizrouter: ["bizrouter.ai"],
  orcarouter: ["www.orcarouter.ai", "docs.orcarouter.ai"], tokenlab: ["tokenlab.sh"], opengateway: ["opengateway.ai"],
  nanogpt: ["docs.nano-gpt.com"], "opencode-zen": ["docs.opencode.ai"], kilo: ["kilo.ai"],
  vertex: ["docs.cloud.google.com"], "vertex-express": ["docs.cloud.google.com", "github.com"], "cloudflare-ai-gateway": ["developers.cloudflare.com"],
};
const domesticIds = ["deepseek", "kimi", "zhipu", "qwen", "volcengine", "qianfan", "stepfun", "siliconflow", "xiaomi"] as const;
const independentIds = ["openai", "anthropic", "gemini", "openrouter", "azure-openai", "cloudflare-workers-ai", "ollama", "lmstudio", "vllm", "litellm", ...domesticIds, ...inferenceIds, ...gatewayIds] as const;
const reconstructed = new Set<string>(independentIds);
const preset = (id: string): ProviderPreset => { const p = PRESETS.find(p => p.id === id); assert.ok(p, id); return p; };
// Deliberate, documented exceptions to the old operational contract. The SDK
// roots omitted /v1, but EasySwitch appends /messages itself. These corrections
// apply only to new preset selections, never to already-saved/custom providers.
const messagesCorrections: Record<string, { previous: string; corrected: string; endpoint: string }> = {
  deepseek: { previous: "https://api.deepseek.com/anthropic", corrected: "https://api.deepseek.com/anthropic/v1", endpoint: "https://api.deepseek.com/anthropic/v1/messages" },
  kimi: { previous: "https://api.moonshot.cn/anthropic", corrected: "https://api.moonshot.cn/anthropic/v1", endpoint: "https://api.moonshot.cn/anthropic/v1/messages" },
  zhipu: { previous: "https://open.bigmodel.cn/api/anthropic", corrected: "https://open.bigmodel.cn/api/anthropic/v1", endpoint: "https://open.bigmodel.cn/api/anthropic/v1/messages" },
  qwen: { previous: "https://dashscope.aliyuncs.com/apps/anthropic", corrected: "https://dashscope.aliyuncs.com/apps/anthropic/v1", endpoint: "https://dashscope.aliyuncs.com/apps/anthropic/v1/messages" },
  xiaomi: { previous: "https://api.xiaomimimo.com/anthropic", corrected: "https://api.xiaomimimo.com/anthropic/v1", endpoint: "https://api.xiaomimimo.com/anthropic/v1/messages" },
};
const unexposedGuidanceIds = ["zhipu", "qianfan", "stepfun"] as const;
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

test("preset reconstruction is exactly 52 disjoint entries, with 15 explicitly attributed legacy rows", () => {
  assert.equal(PRESETS.length, 67);
  assert.equal(new Set(PRESETS.map(p => p.id)).size, 67);
  assert.deepEqual(INDEPENDENT_PRESETS.map(p => p.id), independentIds);
  assert.deepEqual(Object.keys(OFFICIAL_PRESET_FACTS).sort(), [...independentIds].sort());
  assert.deepEqual(Object.keys(PRESET_PROVENANCE).sort(), PRESETS.map(p => p.id).sort());
  const origins: Record<string, { status: string; source?: string; scope: string }> = PRESET_PROVENANCE;
  for (const p of PRESETS) {
    const origin = origins[p.id]!;
    assert.equal(origin.status, reconstructed.has(p.id) ? "independent-reconstruction" : "legacy-attributed", p.id);
    if (!reconstructed.has(p.id)) {
      assert.match(origin.source!, /opencodex.*MIT/);
      assert.match(origin.scope, /Not independently reconstructed or verified/);
    }
  }
  assert.equal(PRESETS.filter(p => !reconstructed.has(p.id)).length, 15);
});

test("all 67 rows retain the baseline contract except explicit documented endpoint corrections", () => {
  // Preserve the original operational hash: normalize only the five explicitly
  // checked domestic Messages fixes, the Cloudflare Messages fix, and
  // DeepSeek/Together canonical bases to old values.
  const originalOperations = PRESETS.map(({ note, keyUrl, ...p }) => {
    const correction = messagesCorrections[p.id];
    if (correction) {
      assert.equal(p.anthropicBaseUrl, correction.corrected, p.id);
      p.anthropicBaseUrl = correction.previous;
    }
    if (p.id === "cloudflare-ai-gateway") {
      assert.equal(p.anthropicBaseUrl, "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/anthropic/v1");
      p.anthropicBaseUrl = "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}/anthropic";
    }
    if (p.id === "deepseek") {
      // The old /v1 alias is unverified, not proven invalid. Select the official
      // canonical root for new selections without silently migrating old URLs.
      assert.equal(p.baseUrl, "https://api.deepseek.com");
      p.baseUrl = "https://api.deepseek.com/v1";
    }
    if (p.id === "together") {
      assert.equal(p.baseUrl, "https://api.together.ai/v1");
      p.baseUrl = "https://api.together.xyz/v1";
    }
    return p;
  });
  assert.equal(digest(originalOperations), "f09d4033eb89b4f8905563a8e4e92e9c62fd09246ad8538d74cf6ef259493d4b");
  assert.equal(digest(PRESETS.map(p => ({ id: p.id, fields: Object.keys(p).sort() }))), "ba74f5e07c68d0008451810cc3420d8712891236b5b9df64af7eb6f95e45e60e");
  // Independently captured from the unchanged 15-row subset before this batch.
  assert.equal(digest(PRESETS.filter(p => !reconstructed.has(p.id))), "00612336be41da1a8bd7f115eea69b0de05b0cf87fc86c24211e95a5112f6c35");
  assert.deepEqual(PRESET_CATEGORIES, ["编程套餐", "国内官方", "国际官方", "中转与聚合", "推理平台", "本地", "自定义"]);
  assert.deepEqual(PRESETS.filter(p => p.category === "编程套餐").map(p => p.id), ["zhipu-coding", "zai", "kimi-coding", "minimax-coding-cn", "minimax-coding", "volcengine-coding", "tencent-coding", "alibaba-token-plan", "mimo-token-plan", "opencode-go"]);
});

test("each reconstructed output field distinguishes official facts from EasySwitch choices", () => {
  for (const id of independentIds) {
    const p = preset(id), origin = INDEPENDENT_PRESET_PROVENANCE[id], facts = OFFICIAL_PRESET_FACTS[id];
    assert.equal(origin.status, "independent-reconstruction");
    assert.match(origin.scope, /documentation-only; no live request, entitlement, or capability verification/);
    assert.deepEqual(Object.keys(origin.fields).sort(), Object.keys(p).sort(), id);
    for (const [field, evidence] of Object.entries(origin.fields)) {
      if (evidence.kind === "editorial") {
        assert.equal(evidence.factKeys.length, 0);
        assert.ok(evidence.choice);
      } else {
        assert.ok(evidence.factKeys.length > 0, `${id}.${field}`);
        for (const key of evidence.factKeys) assert.ok(facts[key], `${id}.${field} -> ${key}`);
      }
      if (evidence.kind === "official-fact+editorial") assert.ok(evidence.choice, `${id}.${field}`);
    }
    for (const field of ["id", "name", "category", "icon"] as const) assert.equal(origin.fields[field]!.kind, "editorial");
    if (Object.hasOwn(p, "note")) assert.equal(origin.fields.note!.kind, "official-fact+editorial");
    if (p.defaultModel) {
      assert.equal(origin.fields.defaultModel!.kind, "official-fact+editorial");
      assert.equal(p.defaultModel, facts.modelId!.value);
    }
  }
});

test("every fact has dated field-level official evidence and a bounded verification scope", () => {
  const domains: Record<IndependentPresetId, string[]> = {
    ...inferenceDomains,
    ...gatewayDomains,
    openai: ["developers.openai.com"], anthropic: ["platform.claude.com"], gemini: ["ai.google.dev"],
    "azure-openai": ["learn.microsoft.com"], openrouter: ["openrouter.ai"], "cloudflare-workers-ai": ["developers.cloudflare.com"],
    ollama: ["docs.ollama.com"], lmstudio: ["lmstudio.ai"], vllm: ["docs.vllm.ai"], litellm: ["docs.litellm.ai"],
    deepseek: ["api-docs.deepseek.com", "raw.githubusercontent.com"], kimi: ["platform.kimi.com"], zhipu: ["docs.bigmodel.cn"], qwen: ["help.aliyun.com"], volcengine: ["docs.volcengine.com"],
    qianfan: ["cloud.baidu.com"], stepfun: ["platform.stepfun.com"], siliconflow: ["docs.siliconflow.cn"], xiaomi: ["mimo.mi.com"],
  };
  for (const id of independentIds) for (const [field, fact] of Object.entries(OFFICIAL_PRESET_FACTS[id])) {
    assert.equal(fact.checkedAt, "2026-10-08", `${id}.${field}`);
    assert.ok(fact.scope.length > 10, `${id}.${field}`);
    assert.ok(fact.sources.length > 0, `${id}.${field}`);
    for (const source of fact.sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, "https:");
      assert.equal(url.username + url.password, "");
      assert.ok(domains[id].includes(url.hostname), `${id}.${field}: ${url.hostname}`);
      assert.ok(source.title.length > 0);
    }
  }
});

test("fresh reconstruction imports facts only, while checked guides replace unverified legacy deep links", () => {
  const source = readFileSync(new URL("../src/presets-official.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']\.\/presets\.ts["']|LEGACY_PRESETS|\bfetch\s*\(|readFile/);
  for (const p of INDEPENDENT_PRESETS) {
    const facts = OFFICIAL_PRESET_FACTS[p.id as IndependentPresetId];
    if (p.keyUrl) {
      assert.equal(p.keyUrl, facts.keyGuide!.value);
      assert.ok(facts.keyGuide!.sources.some(s => s.url === p.keyUrl));
      assert.match(INDEPENDENT_PRESET_PROVENANCE[p.id as IndependentPresetId].fields.keyUrl!.choice!, /old unverified console deep links are not reused/);
    }
  }
});

test("all placeholder declarations agree with URL templates and concrete routes join without extra v1", () => {
  for (const p of PRESETS) {
    const placeholders = [...new Set([...`${p.baseUrl} ${p.anthropicBaseUrl ?? ""}`.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!))].sort();
    assert.deepEqual((p.urlParams ?? []).map(param => param.key).sort(), placeholders, p.id);
    if (placeholders.length) assert.throws(() => expandUrl(p.baseUrl), UnresolvedPlaceholder, p.id);
  }
  const call = (id: string, kind: "chat" | "responses" | "messages", params?: Record<string, string>) => {
    const p = preset(id);
    return endpointUrl({ baseUrl: p.baseUrl, anthropicBaseUrl: p.anthropicBaseUrl, wire: p.wire, urlParams: params }, kind);
  };
  assert.equal(call("openai", "responses"), "https://api.openai.com/v1/responses");
  assert.equal(call("anthropic", "messages"), "https://api.anthropic.com/v1/messages");
  assert.equal(call("gemini", "chat"), "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
  assert.equal(call("azure-openai", "responses", { resource: "fixture-resource" }), "https://fixture-resource.openai.azure.com/openai/v1/responses");
  assert.equal(call("cloudflare-workers-ai", "chat", { account_id: "fixture-account" }), "https://api.cloudflare.com/client/v4/accounts/fixture-account/ai/v1/chat/completions");
  assert.equal(call("litellm", "chat"), "http://127.0.0.1:4000/v1/chat/completions");
});

test("domestic reconstructed bases yield the exact documented Chat and Messages request URLs", () => {
  const chatEndpoints = {
    deepseek: "https://api.deepseek.com/chat/completions",
    kimi: "https://api.moonshot.cn/v1/chat/completions",
    zhipu: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    qwen: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    volcengine: "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
    qianfan: "https://qianfan.baidubce.com/v2/chat/completions",
    stepfun: "https://api.stepfun.com/v1/chat/completions",
    siliconflow: "https://api.siliconflow.cn/v1/chat/completions",
    xiaomi: "https://api.xiaomimimo.com/v1/chat/completions",
  };
  for (const id of domesticIds) {
    const p = preset(id);
    const provider = { baseUrl: p.baseUrl, anthropicBaseUrl: p.anthropicBaseUrl, wire: p.wire };
    assert.equal(endpointUrl(provider, "chat"), chatEndpoints[id], id);
    const correction = messagesCorrections[id];
    if (correction) {
      assert.equal(p.anthropicBaseUrl, correction.corrected, id);
      assert.equal(endpointUrl(provider, "messages"), correction.endpoint, id);
      assert.equal(OFFICIAL_PRESET_FACTS[id].anthropicBaseUrl!.value, correction.corrected, id);
      assert.match(OFFICIAL_PRESET_FACTS[id].anthropicBaseUrl!.scope, /\/v1/);
    } else assert.equal(p.anthropicBaseUrl, undefined, id);
    assert.equal(p.urlParams, undefined, id);
  }
  // Do not fix SDK roots by changing generic joining: existing version-complete
  // and user-defined paths must remain literal, without another inserted /v1.
  assert.equal(endpointUrl({ baseUrl: "https://fixture.example.invalid/private/v1" }, "messages"), "https://fixture.example.invalid/private/v1/messages");
  assert.equal(endpointUrl({ baseUrl: "https://fixture.example.invalid/custom" }, "messages"), "https://fixture.example.invalid/custom/messages");
});

test("Messages production adapter sends the five corrected preset URLs to an in-memory fetch fixture", async t => {
  const sent: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    sent.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return Response.json({ id: "fixture-message", content: [] });
  });
  for (const [id, correction] of Object.entries(messagesCorrections)) {
    const p = preset(id);
    // Protocol selection is an explicit synthetic fixture, not a new preset
    // capability claim. No request leaves this in-memory fetch implementation.
    const provider: Provider = {
      id: `fixture-${id}`, name: `Fixture ${id}`, baseUrl: p.baseUrl,
      anthropicBaseUrl: p.anthropicBaseUrl, wire: p.wire, models: [], protocols: ["messages"],
      route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "2026-10-08T00:00:00.000Z",
    };
    const prepared = prepareOutbound(provider, { protocol: "messages", model: "fixture-model", stream: false, body: { messages: [{ role: "user", content: "fixture" }], max_tokens: 1 } });
    assert.equal(prepared.protocol, "messages", id);
    const response = await prepared.send("fixture-only-key", new AbortController().signal);
    assert.ok(response instanceof Response, id);
    assert.equal(response.status, 200, id);
    assert.equal(sent.at(-1), correction.endpoint, id);
  }
  assert.equal(sent.length, 5);
});

test("documentation facts do not expand protocol, authentication, model or subscription behavior", () => {
  assert.deepEqual(INDEPENDENT_PRESETS.filter(p => p.defaultModel).map(p => [p.id, p.defaultModel]), [["openai", "gpt-5.5"], ["anthropic", "claude-sonnet-5"], ["gemini", "gemini-3.5-flash"], ["deepseek", "deepseek-flash"], ["zhipu", "glm-4.6"], ["volcengine", "doubao-seed-2-1-pro-260628"], ["stepfun", "step-5-preview"], ["xiaomi", "mimo-v2.6-flash"], ["cerebras", "gpt-oss-120b"], ["vultr", "kimi-k2-instruct"], ["neuralwatt", "glm-5.3"], ["mistral", "codestral-latest"], ["meta", "muse-spark-1.3"], ["packycode", "gpt-5.5"], ["bizrouter", "openai/gpt-5.6-sol"], ["orcarouter", "openai/gpt-5.5"], ["tokenlab", "gpt-5.6-terra"], ["vertex", "gemini-3.5-flash"], ["vertex-express", "gemini-3.5-flash"]]);
  for (const id of unexposedGuidanceIds) {
    assert.ok(OFFICIAL_PRESET_FACTS[id].guidance.value);
    assert.equal(Object.hasOwn(preset(id), "note"), false, id);
    assert.equal(Object.hasOwn(INDEPENDENT_PRESET_PROVENANCE[id].fields, "note"), false, id);
  }
  for (const p of INDEPENDENT_PRESETS) {
    if (p.id === "vertex" || p.id === "vertex-express") {
      assert.deepEqual(p.protocols, ["gemini"], p.id);
      assert.equal(p.vertexMode, p.id === "vertex" ? "standard" : "express", p.id);
    } else {
      assert.equal(p.protocols, undefined, p.id);
      assert.equal(p.vertexMode, undefined, p.id);
    }
    assert.equal(p.models, undefined, p.id);
    assert.notEqual(p.category, "编程套餐", p.id);
    if (p.id !== "azure-openai" && p.id !== "xiaomi") assert.equal(p.wire, undefined, p.id);
  }
  assert.deepEqual(preset("azure-openai").wire, { authHeader: "api-key", authScheme: "raw" });
  assert.deepEqual(upstreamHeaders(preset("azure-openai"), "fixture-only-key"), { "api-key": "fixture-only-key" });
  assert.deepEqual(preset("xiaomi").wire, { authHeader: "api-key", authScheme: "raw" });
  assert.deepEqual(upstreamHeaders(preset("xiaomi"), "fixture-only-key"), { "api-key": "fixture-only-key" });
  assert.match(OFFICIAL_PRESET_FACTS["cloudflare-workers-ai"].guidance.scope, /two GPT-OSS models and non-streaming/);
  assert.doesNotMatch(preset("cloudflare-workers-ai").note!, /免费|llama-3/);
});

test("local host selection and LM Studio configurable authentication remain explicit editorial choices", () => {
  for (const id of ["ollama", "lmstudio", "vllm", "litellm"] as const) {
    assert.equal(new URL(OFFICIAL_PRESET_FACTS[id].baseUrl.value).hostname, "localhost");
    assert.equal(new URL(preset(id).baseUrl).hostname, "127.0.0.1");
    assert.equal(INDEPENDENT_PRESET_PROVENANCE[id].fields.baseUrl!.kind, "official-fact+editorial");
  }
  assert.match(preset("lmstudio").note!, /默认无需 Key.*启用鉴权后需填写令牌/);
  assert.match(preset("vllm").note!, /服务端配置/);
  assert.notEqual(preset("ollama").baseUrl, preset("ollama-cloud").baseUrl);
  assert.equal(iconForBaseUrl("https://fixture-resource.openai.azure.com/openai/v1"), "openai");
  assert.equal(iconForBaseUrl("http://127.0.0.1:11434/v1"), "ollama-color");
  assert.equal(iconForBaseUrl("http://127.0.0.1:1234/v1"), "newapi-color");
  assert.equal(letterIcon("  example"), "letter:E");
});

test("inference reconstruction retains optional-field absence, exact defaults, icons and ordinary routing", () => {
  assert.deepEqual(Object.keys(INFERENCE_PRESET_FACTS), [...inferenceIds]);
  assert.deepEqual(inferenceIds.filter(id => preset(id).defaultModel).map(id => [id, preset(id).defaultModel]), [
    ["cerebras", "gpt-oss-120b"], ["vultr", "kimi-k2-instruct"], ["neuralwatt", "glm-5.3"],
  ]);
  for (const id of inferenceIds) {
    const p = preset(id), facts = INFERENCE_PRESET_FACTS[id], fields = INDEPENDENT_PRESET_PROVENANCE[id].fields;
    assert.equal(p.category, "推理平台", id);
    assert.equal(p.baseUrl, facts.baseUrl.value, id);
    assert.equal(endpointUrl({ baseUrl: p.baseUrl, wire: p.wire }, "chat"), `${facts.baseUrl.value}/chat/completions`, id);
    assert.deepEqual(upstreamHeaders(p, "fixture-inference-key"), { authorization: "Bearer fixture-inference-key" }, id);
    for (const field of ["anthropicBaseUrl", "wire", "protocols", "urlParams", "models", "vertexMode"] as const) {
      assert.equal(Object.hasOwn(p, field), false, `${id}.${field}`);
      assert.equal(Object.hasOwn(fields, field), false, `${id}.${field} origin`);
    }
    // Research can establish guides and useful guidance without adding them to
    // the existing console contract. Absence differs from an undefined value.
    assert.ok(facts.keyGuide?.value && facts.guidance.value, id);
    assert.equal(Object.hasOwn(p, "keyUrl"), id === "groq", id);
    assert.equal(Object.hasOwn(p, "note"), id === "groq", id);
    assert.equal(Object.hasOwn(fields, "keyUrl"), id === "groq", id);
    assert.equal(Object.hasOwn(fields, "note"), id === "groq", id);
    assert.deepEqual(facts.placeholders?.value, [], id);
  }
  assert.equal(preset("nscale").icon, letterIcon("Nscale"));
  assert.match(preset("groq").note!, /API Key/);
  const origins: Record<string, { status: string }> = PRESET_PROVENANCE;
  for (const id of ["hyperbolic", "ollama-cloud"]) {
    assert.equal(Object.hasOwn(INFERENCE_PRESET_FACTS, id), false, id);
    assert.equal(origins[id]!.status, "legacy-attributed", id);
  }
});

test("inference research-only alternate surfaces stay outside emitted presets and field origins", () => {
  assert.deepEqual(Object.keys(INFERENCE_RESEARCH_ONLY), ["together", "fireworks", "deepinfra", "baseten", "scaleway", "digitalocean", "neuralwatt", "synthetic"]);
  for (const [id, research] of Object.entries(INFERENCE_RESEARCH_ONLY)) {
    const domains = inferenceDomains[id as InferencePresetId];
    for (const fact of research.alternates) {
      assert.equal(fact.checkedAt, "2026-10-08", id);
      assert.ok(fact.scope.length > 10 && fact.sources.length > 0, id);
      for (const source of fact.sources) {
        const url = new URL(source.url);
        assert.equal(url.protocol, "https:");
        assert.equal(url.username + url.password, "");
        assert.ok(domains.includes(url.hostname), `${id}: ${url.hostname}`);
        assert.ok(source.title.length > 0);
      }
    }
    assert.equal(Object.hasOwn(preset(id), "alternates"), false);
    assert.equal(Object.hasOwn(preset(id), "caveats"), false);
  }
  const implementation = readFileSync(new URL("../src/presets-official.ts", import.meta.url), "utf8");
  assert.doesNotMatch(implementation, /INFERENCE_RESEARCH_ONLY/);
  assert.match(INFERENCE_RESEARCH_ONLY.synthetic!.caveats.join(" "), /hf:.*syn:/);
});

test("Together uses the documented canonical host for new presets with only an exact historical icon fallback", () => {
  assert.equal(preset("together").baseUrl, "https://api.together.ai/v1");
  assert.equal(endpointUrl({ baseUrl: preset("together").baseUrl }, "chat"), "https://api.together.ai/v1/chat/completions");
  const oldBase = "https://api.together.xyz/v1";
  assert.equal(INFERENCE_RESEARCH_ONLY.together!.alternates[0]!.value.baseUrl, oldBase);
  assert.match(INFERENCE_RESEARCH_ONLY.together!.alternates[0]!.scope, /does not prove .xyz is broken/);
  assert.equal(endpointUrl({ baseUrl: oldBase }, "chat"), `${oldBase}/chat/completions`);
  for (const base of [oldBase, "https://api.together.ai/v1"]) assert.equal(iconForBaseUrl(base), "together");
  for (const host of ["api.together.xyz.example.invalid", "api.together.ai.example.invalid", "not-api.together.xyz", "api-together.xyz"]) {
    assert.equal(iconForBaseUrl(`https://${host}/v1`, "Fixture"), "letter:F", host);
  }
});

const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };

test("loopback console API preserves public preset shape and category-driven billing", async t => {
  const root = mkdtempSync(join(tmpdir(), "es-preset-provenance-"));
  const store = new Store(root);
  const api = createEasySwitchServer({ store, port: 0, secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} } });
  const upstream = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ object: "list", data: [{ id: "fixture-model", object: "model" }] })); });
  t.after(async () => { await Promise.all([close(api), close(upstream)]); rmSync(root, { recursive: true, force: true }); });
  const upstreamBase = await listen(upstream), apiBase = await listen(api);
  const response = await fetch(`${apiBase}/api/presets`, { headers: { "x-easyswitch": "1" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), PRESETS);
  assert.equal(Object.hasOwn(preset("openai"), "provenance"), false);
  for (const id of ["openai", "zhipu-coding"] as const) {
    const created = await fetch(`${apiBase}/api/providers`, { method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" }, body: JSON.stringify({ name: `fixture-${id}`, baseUrl: `${upstreamBase}/v1`, presetId: id }) });
    assert.equal(created.status, 201);
    const body = await created.json() as { billing?: string; models: string[]; icon: string };
    assert.equal(body.billing, id === "zhipu-coding" ? "subscription" : undefined);
    assert.equal(body.icon, preset(id).icon);
    assert.deepEqual(body.models, ["fixture-model"]);
  }
});

test("serving revised presets never migrates saved providers or user-defined Messages paths", async t => {
  const root = mkdtempSync(join(tmpdir(), "es-preset-saved-"));
  const store = new Store(root);
  const previousMessagesBases = [
    ["deepseek", "https://api.deepseek.com/anthropic"],
    ["kimi", "https://api.moonshot.cn/anthropic"],
    ["zhipu", "https://open.bigmodel.cn/api/anthropic"],
    ["qwen", "https://dashscope.aliyuncs.com/apps/anthropic"],
    ["xiaomi", "https://api.xiaomimimo.com/anthropic"],
  ] as const;
  const saved: Provider[] = previousMessagesBases.map(([id, anthropicBaseUrl]) => ({
    id: `saved-${id}`, name: `Saved ${id}`, baseUrl: id === "deepseek" ? "https://api.deepseek.com/v1" : preset(id).baseUrl,
    anthropicBaseUrl, models: [], route: "chat-translate", routePinned: true,
    streamUsage: false, createdAt: "2026-10-01T00:00:00.000Z",
  }));
  saved.push({
    id: "saved-custom", name: "User-specified custom path", baseUrl: "https://fixture.example.invalid/api",
    anthropicBaseUrl: "https://fixture.example.invalid/private/anthropic", models: [],
    wire: { paths: { messages: "v7/messages" } }, route: "chat-translate", routePinned: true,
    streamUsage: false, createdAt: "2026-10-01T00:00:00.000Z",
  });
  saved.push({
    id: "saved-together", name: "Saved Together historical host", baseUrl: "https://api.together.xyz/v1",
    models: ["saved-model"], route: "chat-translate", routePinned: true,
    streamUsage: false, createdAt: "2026-10-01T00:00:00.000Z",
  });
  saved.push({
    id: "saved-cloudflare", name: "Saved Cloudflare Messages path", baseUrl: "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/openai",
    anthropicBaseUrl: "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic",
    models: [], route: "chat-translate", routePinned: true,
    streamUsage: false, createdAt: "2026-10-01T00:00:00.000Z",
  });
  for (const provider of saved) store.upsertProvider(provider);
  const before = readFileSync(join(root, "state.json"), "utf8");
  const api = createEasySwitchServer({ store, port: 0, secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} } });
  t.after(async () => { await close(api); rmSync(root, { recursive: true, force: true }); });
  const apiBase = await listen(api);
  const response = await fetch(`${apiBase}/api/presets`, { headers: { "x-easyswitch": "1" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), PRESETS);
  assert.deepEqual(store.providers(), saved);
  assert.equal(readFileSync(join(root, "state.json"), "utf8"), before);
  const reloaded = new Store(root);
  assert.deepEqual(reloaded.providers(), saved);
  assert.equal(endpointUrl(reloaded.provider("saved-cloudflare")!, "messages"), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic/messages");
  assert.equal(endpointUrl(reloaded.provider("saved-together")!, "chat"), "https://api.together.xyz/v1/chat/completions");
  assert.equal(endpointUrl(reloaded.provider("saved-deepseek")!, "chat"), "https://api.deepseek.com/v1/chat/completions");
  for (const [id, base] of previousMessagesBases) assert.equal(endpointUrl(reloaded.provider(`saved-${id}`)!, "messages"), `${base}/messages`);
  assert.equal(endpointUrl(reloaded.provider("saved-custom")!, "messages"), "https://fixture.example.invalid/private/anthropic/v7/messages");
});
