import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GATEWAY_PRESET_FACTS, type GatewayPresetId } from "../src/preset-facts-gateway.ts";
import { PRESETS, PRESET_PROVENANCE } from "../src/presets.ts";
import { INDEPENDENT_PRESET_PROVENANCE } from "../src/presets-official.ts";
import { endpointUrl, upstreamHeaders, UnresolvedPlaceholder } from "../src/upstream.ts";
import { prepareOutbound } from "../src/outbound.ts";
import { prepareVertex, vertexEndpoint } from "../src/vertex-gemini.ts";
import type { Provider, ProviderPreset } from "../src/types.ts";

const gatewayIds = [
  "xai", "mistral", "meta", "zenmux", "vercel", "huggingface", "packycode", "bizrouter", "orcarouter",
  "tokenlab", "opengateway", "nanogpt", "opencode-zen", "kilo", "vertex", "vertex-express", "cloudflare-ai-gateway",
] as const satisfies readonly GatewayPresetId[];
const preset = (id: string): ProviderPreset => { const p = PRESETS.find(p => p.id === id); assert.ok(p, id); return p; };
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

test("seventeen gateway reconstructions preserve every existing choice and optional field, except the verified Cloudflare join correction", () => {
  const rows = gatewayIds.map(preset);
  assert.deepEqual(Object.keys(GATEWAY_PRESET_FACTS), gatewayIds);
  assert.deepEqual(PRESETS.filter(p => gatewayIds.includes(p.id as GatewayPresetId)).map(p => p.id), gatewayIds);
  // These pin existing EasySwitch choices, not vendor verification. Only the Cloudflare Messages base gains /v1.
  assert.equal(digest(rows.map(({ note, keyUrl, ...p }) => p)), "5e3a68e08bdbdb8681d4fafe5cdd7a3adab4133c42c47539883610c7084bf6d0");
  assert.equal(digest(rows.map(p => ({ id: p.id, fields: Object.keys(p).sort() }))), "e25ab878d001ce1a2aae0868c9f139eee8bf82cc553d0e714c7702d9507791b5");
  assert.deepEqual(rows.filter(p => Object.hasOwn(p, "note")).map(p => p.id), ["xai", "packycode", "vertex", "vertex-express", "cloudflare-ai-gateway"]);
  assert.deepEqual(rows.filter(p => Object.hasOwn(p, "keyUrl")).map(p => p.id), ["xai", "mistral", "vertex", "vertex-express"]);
  for (const id of gatewayIds) {
    const p = preset(id), facts = GATEWAY_PRESET_FACTS[id], origin = INDEPENDENT_PRESET_PROVENANCE[id];
    assert.equal(PRESET_PROVENANCE[id].status, "independent-reconstruction");
    assert.deepEqual(Object.keys(origin.fields).sort(), Object.keys(p).sort(), id);
    assert.equal(Object.hasOwn(p, "wire"), false, id);
    assert.equal(Object.hasOwn(p, "models"), false, id);
    if (p.defaultModel) assert.equal(p.defaultModel, facts.modelId!.value, id);
    if (Object.hasOwn(p, "note")) assert.equal(p.note, facts.guidance.value, id);
    if (Object.hasOwn(p, "keyUrl")) assert.equal(p.keyUrl, facts.keyGuide!.value, id);
    if (id === "vertex" || id === "vertex-express") {
      assert.deepEqual(p.protocols, ["gemini"]);
      assert.equal(p.vertexMode, id === "vertex" ? "standard" : "express");
      assert.equal(origin.fields.protocols!.kind, "editorial");
      assert.equal(origin.fields.vertexMode!.kind, "editorial");
    } else {
      assert.equal(Object.hasOwn(p, "protocols"), false, id);
      assert.equal(Object.hasOwn(p, "vertexMode"), false, id);
    }
    assert.equal(Object.hasOwn(p, "anthropicBaseUrl"), id === "cloudflare-ai-gateway", id);
  }
});

test("PackyAPI and OpenCode Zen authentication gaps never become verified header facts or new overrides", () => {
  for (const id of ["packycode", "opencode-zen"] as const) {
    const fact = GATEWAY_PRESET_FACTS[id].authentication;
    assert.deepEqual(Object.keys(fact.value), ["requirement"]);
    assert.match(fact.value.requirement, /API key/);
    assert.match(fact.scope, /not generalized|verification is intentionally not claimed/);
    assert.equal(INDEPENDENT_PRESET_PROVENANCE[id].fields.wire, undefined);
    assert.equal(Object.hasOwn(preset(id), "wire"), false);
    // This is an existing local fallback regression assertion, not evidence of vendor acceptance.
    assert.deepEqual(upstreamHeaders(preset(id), "fixture-only-key"), { authorization: "Bearer fixture-only-key" });
  }
});

test("Cloudflare joins Messages at anthropic/v1/messages and keeps its provider-key and gateway-key distinction", async t => {
  const p = preset("cloudflare-ai-gateway");
  assert.throws(() => endpointUrl({ baseUrl: p.baseUrl, anthropicBaseUrl: p.anthropicBaseUrl }, "messages"), UnresolvedPlaceholder);
  const params = { account_id: "fixture-account", gateway: "fixture-gateway" };
  const configured = { baseUrl: p.baseUrl, anthropicBaseUrl: p.anthropicBaseUrl, urlParams: params };
  assert.equal(endpointUrl(configured, "messages"), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic/v1/messages");
  assert.equal(endpointUrl(configured, "chat"), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/openai/chat/completions");
  assert.equal(endpointUrl(configured, "responses"), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/openai/responses");
  assert.deepEqual(p.urlParams, [{ key: "account_id", label: "Cloudflare 账号 ID" }, { key: "gateway", label: "网关名称", example: "my-gateway" }]);
  assert.match(p.note!, /cf-aig-authorization/);
  assert.match(p.note!, /BYOK／统一计费/);
  assert.deepEqual(upstreamHeaders(p, "fixture-only-upstream-key"), { authorization: "Bearer fixture-only-upstream-key" });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    assert.equal(String(url), "https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/anthropic/v1/messages");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("x-api-key"), "fixture-only-upstream-key");
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    assert.equal(headers.has("cf-aig-authorization"), false);
    return Response.json({ id: "fixture-message", content: [] });
  });
  const provider: Provider = {
    id: "fixture-cloudflare", name: "Fixture Cloudflare", ...configured,
    models: [], protocols: ["messages"], route: "chat-translate", routePinned: true,
    streamUsage: false, createdAt: "2026-10-08",
  };
  const prepared = prepareOutbound(provider, { protocol: "messages", model: "fixture-model", stream: false, body: { messages: [{ role: "user", content: "fixture" }], max_tokens: 1 } });
  assert.ok(await prepared.send("fixture-only-upstream-key", new AbortController().signal) instanceof Response);
  assert.equal(calls, 1);
});

test("gateway compatibility claims stay bounded and established bases never silently adopt alternative surfaces", () => {
  assert.equal(preset("nanogpt").baseUrl, "https://nano-gpt.com/api/v1");
  assert.match(GATEWAY_PRESET_FACTS.nanogpt.baseUrl.scope, /recommend api.nano-gpt.com/);
  assert.equal(endpointUrl({ baseUrl: preset("kilo").baseUrl }, "chat"), "https://api.kilo.ai/api/gateway/chat/completions");
  assert.match(GATEWAY_PRESET_FACTS.kilo.guidance.value, /Responses 兼容性需另行确认/);
  assert.equal(preset("opengateway").baseUrl, "https://apis.opengateway.ai/v1");
  assert.match(GATEWAY_PRESET_FACTS.opengateway.baseUrl.scope, /not the opengateway.ai\/api\/v1 resource-management/);
  assert.match(GATEWAY_PRESET_FACTS["vertex-express"].modelId!.scope, /same-page available-model table lags/);
  assert.deepEqual(preset("cline"), { id: "cline", name: "Cline", category: "中转与聚合", baseUrl: "https://api.cline.bot/api/v1", icon: "cline-color", defaultModel: "anthropic/claude-sonnet-5" });
  const origins: Record<string, { status: string }> = PRESET_PROVENANCE;
  assert.equal(origins.cline!.status, "legacy-attributed");
  assert.equal(Object.hasOwn(GATEWAY_PRESET_FACTS, "cline"), false);
});

test("Vertex preset metadata keeps native fixed-host routing and supplied-token authentication unchanged", async () => {
  for (const id of ["vertex", "vertex-express"] as const) {
    const p = preset(id);
    const config = id === "vertex"
      ? { mode: "standard" as const, project: "fixture-project", location: "us-central1", auth: "access-token" as const }
      : { mode: "express" as const, auth: "api-key" as const };
    const provider: Provider = {
      id: `fixture-${id}`, name: p.name, baseUrl: p.baseUrl, protocols: p.protocols, vertex: config,
      models: [], route: "chat-translate", routePinned: false, streamUsage: false, createdAt: "2026-10-08",
    };
    const model = p.defaultModel!;
    let calls = 0;
    const prepared = prepareVertex(provider, { protocol: "gemini", model, stream: false, body: { contents: [{ role: "user", parts: [{ text: "fixture" }] }] } }, async (url, init) => {
      calls++;
      assert.equal(String(url), vertexEndpoint(config, model));
      assert.equal(new URL(String(url)).hostname, id === "vertex" ? "us-central1-aiplatform.googleapis.com" : "aiplatform.googleapis.com");
      assert.equal(new URL(String(url)).search, "");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(id === "vertex" ? "authorization" : "x-goog-api-key"), id === "vertex" ? "Bearer fixture-only-credential" : "fixture-only-credential");
      assert.equal(headers.has(id === "vertex" ? "x-goog-api-key" : "authorization"), false);
      return Response.json({});
    });
    assert.equal(prepared.protocol, "gemini");
    assert.ok(await prepared.send("fixture-only-credential", new AbortController().signal) instanceof Response);
    assert.equal(calls, 1);
  }
});

test("gateway facts are self-contained public documentation and never import legacy presets or execute external requests", () => {
  const source = readFileSync(new URL("../src/preset-facts-gateway.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["']\.\/presets\.ts["']|LEGACY_PRESETS|\bfetch\s*\(|readFile/);
  for (const id of gatewayIds) for (const [field, fact] of Object.entries(GATEWAY_PRESET_FACTS[id])) {
    assert.equal(fact.checkedAt, "2026-10-08", `${id}.${field}`);
    assert.ok(fact.scope.length > 10, `${id}.${field}`);
    assert.ok(fact.sources.length > 0, `${id}.${field}`);
    for (const source of fact.sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, "https:");
      assert.equal(url.username + url.password, "");
      assert.ok(source.title.length > 0);
      if (url.hostname === "github.com") assert.match(url.pathname, /^\/googleapis\/go-genai\//);
    }
  }
});
