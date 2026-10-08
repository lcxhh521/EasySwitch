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
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { ProviderPreset } from "../src/types.ts";
import { endpointUrl, expandUrl, UnresolvedPlaceholder, upstreamHeaders } from "../src/upstream.ts";

const independentIds = ["openai", "anthropic", "gemini", "openrouter", "azure-openai", "cloudflare-workers-ai", "ollama", "lmstudio", "vllm", "litellm"] as const;
const reconstructed = new Set<string>(independentIds);
const preset = (id: string): ProviderPreset => { const p = PRESETS.find(p => p.id === id); assert.ok(p, id); return p; };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

test("preset reconstruction is exactly ten disjoint entries, with 57 explicitly attributed legacy rows", () => {
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
  assert.equal(PRESETS.filter(p => !reconstructed.has(p.id)).length, 57);
});

test("all 67 IDs, order, labels, billing categories, icons and operational values retain the baseline contract", () => {
  // These hashes pin EasySwitch's pre-migration contract, not official verification.
  assert.equal(digest(PRESETS.map(({ note, keyUrl, ...p }) => p)), "f09d4033eb89b4f8905563a8e4e92e9c62fd09246ad8538d74cf6ef259493d4b");
  assert.equal(digest(PRESETS.map(p => ({ id: p.id, fields: Object.keys(p).sort() }))), "ba74f5e07c68d0008451810cc3420d8712891236b5b9df64af7eb6f95e45e60e");
  assert.equal(digest(PRESETS.filter(p => !reconstructed.has(p.id))), "1ef3f5e2fcd1e4ce13f2f5a3c5e12ee775ec83e8ecda4f7992bd998dd2799cb1");
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
    assert.equal(origin.fields.note!.kind, "official-fact+editorial");
    if (p.defaultModel) {
      assert.equal(origin.fields.defaultModel!.kind, "official-fact+editorial");
      assert.equal(p.defaultModel, facts.modelId!.value);
    }
  }
});

test("every fact has dated field-level official evidence and a bounded verification scope", () => {
  const domains: Record<IndependentPresetId, string[]> = {
    openai: ["developers.openai.com"], anthropic: ["platform.claude.com"], gemini: ["ai.google.dev"],
    "azure-openai": ["learn.microsoft.com"], openrouter: ["openrouter.ai"], "cloudflare-workers-ai": ["developers.cloudflare.com"],
    ollama: ["docs.ollama.com"], lmstudio: ["lmstudio.ai"], vllm: ["docs.vllm.ai"], litellm: ["docs.litellm.ai"],
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

test("documentation facts do not expand protocol, authentication, model or subscription behavior", () => {
  assert.deepEqual(INDEPENDENT_PRESETS.filter(p => p.defaultModel).map(p => [p.id, p.defaultModel]), [["openai", "gpt-5.5"], ["anthropic", "claude-sonnet-5"], ["gemini", "gemini-3.5-flash"]]);
  for (const p of INDEPENDENT_PRESETS) {
    assert.equal(p.protocols, undefined, p.id);
    assert.equal(p.models, undefined, p.id);
    assert.equal(p.vertexMode, undefined, p.id);
    assert.notEqual(p.category, "编程套餐", p.id);
    if (p.id !== "azure-openai") assert.equal(p.wire, undefined, p.id);
  }
  assert.deepEqual(preset("azure-openai").wire, { authHeader: "api-key", authScheme: "raw" });
  assert.deepEqual(upstreamHeaders(preset("azure-openai"), "fixture-only-key"), { "api-key": "fixture-only-key" });
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
