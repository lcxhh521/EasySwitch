import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { prepareOutbound } from "../src/outbound.ts";
import type { Provider, ProviderPreset } from "../src/types.ts";
import { PRESETS, PRESET_PROVENANCE } from "../src/presets.ts";
import { OFFICIAL_PRESET_FACTS } from "../src/preset-facts.ts";
import { INDEPENDENT_PRESETS, INDEPENDENT_PRESET_PROVENANCE } from "../src/presets-official.ts";
import { hasPlanUsage } from "../src/plan-usage.ts";
import { vendorFor } from "../src/pricing/cost.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { SUBSCRIPTION_PRESET_FACTS, MINIMAX_CN_RESEARCH_FACTS, type AuditedSubscriptionPresetId as SubscriptionPresetId } from "../src/preset-facts-subscription.ts";
import { endpointUrl } from "../src/upstream.ts";

const subscriptionFacts = { ...SUBSCRIPTION_PRESET_FACTS, "minimax-coding-cn": MINIMAX_CN_RESEARCH_FACTS };

const ids = ["zhipu-coding", "zai", "kimi-coding", "minimax-coding-cn", "minimax-coding", "volcengine-coding", "tencent-coding", "alibaba-token-plan", "mimo-token-plan", "opencode-go"] as const;
const activeIds = ids.filter((id): id is Exclude<SubscriptionPresetId, "minimax-coding-cn"> => id !== "minimax-coding-cn");
const selectedModels = ["glm-5.3", "glm-5.3", "kimi-for-coding", "MiniMax-M3", "MiniMax-M3", "ark-code-latest", "tc-code-latest", "qwen3.8-max", "mimo-v2.6-pro", "kimi-k2.7-code"];
const chatEndpoints: Record<SubscriptionPresetId, string> = {
  "zhipu-coding": "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
  zai: "https://api.z.ai/api/coding/paas/v4/chat/completions",
  "kimi-coding": "https://api.kimi.com/coding/v1/chat/completions",
  "minimax-coding-cn": "https://api.minimax.cn/v1/chat/completions",
  "minimax-coding": "https://api.minimax.io/v1/chat/completions",
  "volcengine-coding": "https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions",
  "tencent-coding": "https://api.lkeap.cloud.tencent.com/coding/v3/chat/completions",
  "alibaba-token-plan": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  "mimo-token-plan": "https://token-plan-cn.xiaomimimo.com/v1/chat/completions",
  "opencode-go": "https://opencode.ai/zen/go/v1/chat/completions",
};
const messagesEndpoints: Partial<Record<SubscriptionPresetId, string>> = {
  "zhipu-coding": "https://open.bigmodel.cn/api/anthropic/v1/messages",
  zai: "https://api.z.ai/api/anthropic/v1/messages",
  "kimi-coding": "https://api.kimi.com/coding/v1/messages",
  "minimax-coding-cn": "https://api.minimax.cn/anthropic/v1/messages",
  "minimax-coding": "https://api.minimax.io/anthropic/v1/messages",
  "volcengine-coding": "https://ark.cn-beijing.volces.com/api/coding/v1/messages",
  "mimo-token-plan": "https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages",
};
const domains: Record<SubscriptionPresetId, string[]> = {
  "zhipu-coding": ["docs.bigmodel.cn"], zai: ["docs.z.ai"], "kimi-coding": ["www.kimi.com"],
  "minimax-coding-cn": ["platform.minimax.cn", "platform.minimax.io"], "minimax-coding": ["platform.minimax.io"],
  "volcengine-coding": ["docs.volcengine.com"], "tencent-coding": ["cloud.tencent.com"],
  "alibaba-token-plan": ["help.aliyun.com"], "mimo-token-plan": ["mimo.mi.com"], "opencode-go": ["docs.opencode.ai"],
};

test("ten coding-plan fact rows preserve exact selected model IDs with dated first-party evidence", () => {
  assert.deepEqual(Object.keys(subscriptionFacts).sort(), [...ids].sort());
  assert.deepEqual(ids.map(id => subscriptionFacts[id].modelId!.value), selectedModels);
  for (const id of ids) for (const [field, fact] of Object.entries(subscriptionFacts[id])) {
    assert.equal(fact.checkedAt, "2026-10-08", `${id}.${field}`);
    assert.ok(fact.scope.length > 25, `${id}.${field}`);
    assert.ok(fact.sources.length > 0, `${id}.${field}`);
    for (const source of fact.sources) {
      const url = new URL(source.url);
      assert.equal(url.protocol, "https:", `${id}.${field}`);
      assert.ok(source.title.length > 0, `${id}.${field}`);
      if (url.hostname === "raw.githubusercontent.com") {
        assert.equal(source.url, "https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/resources/messages/messages.py");
        assert.equal(field, "anthropicBaseUrl");
        assert.match(fact.scope, /DERIVED/);
      } else if (url.hostname === "code.claude.com") {
        assert.equal(source.url, "https://code.claude.com/docs/en/env-vars");
        assert.equal(field, "authentication");
      } else assert.ok(domains[id].includes(url.hostname), `${id}.${field}: ${source.url}`);
    }
  }
});

test("coding-plan facts compose exact Chat and seven normalized Messages URLs without inferring alternate routes", () => {
  for (const id of ids) {
    const facts = subscriptionFacts[id];
    const p = { baseUrl: facts.baseUrl.value, anthropicBaseUrl: facts.anthropicBaseUrl?.value };
    assert.equal(endpointUrl(p, "chat"), chatEndpoints[id], id);
    if (messagesEndpoints[id]) {
      assert.equal(endpointUrl(p, "messages"), messagesEndpoints[id], id);
      assert.match(facts.anthropicBaseUrl!.value, /\/v1$/);
    } else assert.equal(Object.hasOwn(facts, "anthropicBaseUrl"), false, id);
  }
  for (const id of ["zai", "volcengine-coding"] as const) {
    assert.match(subscriptionFacts[id].anthropicBaseUrl!.scope, /DERIVED/);
    assert.match(subscriptionFacts[id].anthropicBaseUrl!.scope, /not a vendor-published/i);
  }
  for (const id of ["zhipu-coding", "kimi-coding", "minimax-coding-cn", "minimax-coding", "mimo-token-plan"] as const) assert.match(subscriptionFacts[id].anthropicBaseUrl!.scope, /DIRECT/);
});

test("MiniMax CN current-host facts do not claim the historical host is broken or all subscriptions include M3", () => {
  const cn = subscriptionFacts["minimax-coding-cn"];
  assert.equal(cn.baseUrl.value, "https://api.minimax.cn/v1");
  assert.match(cn.baseUrl.scope, /api\.minimaxi\.com is not proven broken/);
  assert.match(cn.baseUrl.scope, /no stored-provider migration/);
  assert.equal(Object.hasOwn(SUBSCRIPTION_PRESET_FACTS, "minimax-coding-cn"), false);
  assert.match(cn.baseUrl.scope, /Research-only/);
  for (const id of ["minimax-coding-cn", "minimax-coding"] as const) {
    const row = subscriptionFacts[id];
    assert.equal(row.modelId!.value, "MiniMax-M3");
    assert.match(row.modelId!.scope, /general API model enum/);
    assert.match(row.guidance.value, /个人交互开发/);
    assert.match(row.guidance.value, /普通 API Key.*按量计费/);
    assert.match(row.guidance.scope, /categorical.*ban/);
  }
});

test("plan-specific restrictions and conflicting Alibaba device or quota guidance remain scoped", () => {
  const facts = subscriptionFacts;
  assert.match(facts["zhipu-coding"].guidance.scope, /relay\/intermediation/);
  assert.match(facts.zai.guidance.scope, /shared\/multi-user/);
  assert.match(facts["kimi-coding"].guidance.scope, /noninteractive scripted batches/);
  assert.match(facts["volcengine-coding"].guidance.scope, /ordinary API\/non-tool use excluded/);
  assert.match(facts["tencent-coding"].guidance.scope, /automated scripts, custom application backends and noninteractive batches forbidden/);
  assert.match(facts["alibaba-token-plan"].guidance.scope, /conflict on quota windows and device count/);
  assert.doesNotMatch(facts["alibaba-token-plan"].guidance.value, /7 天|七天|月度|单设备|多设备|隐私保障/);
  assert.match(facts["mimo-token-plan"].guidance.scope, /custom backends disallowed/);
  for (const id of ids) assert.doesNotMatch(facts[id].guidance.value, /EasySwitch.*官方允许|官方批准.*EasySwitch|无限|任意.*自动化/);
});

test("OpenCode Go raw authentication is unverified and selected Kimi model does not imply Messages capability", () => {
  const go = subscriptionFacts["opencode-go"];
  assert.deepEqual(go.authentication.value, { requirement: "OpenCode Go subscription API key" });
  assert.match(go.authentication.scope, /UNVERIFIED raw HTTP header\/scheme/);
  assert.match(go.authentication.scope, /implicit Bearer runtime is a compatibility choice/);
  assert.match(go.modelId!.scope, /mapped to Chat Completions/);
  assert.match(go.guidance.scope, /truthful client User-Agent/);
  assert.match(go.guidance.scope, /stable per-conversation/);
  assert.match(go.guidance.scope, /separate review/);
  assert.equal(go.anthropicBaseUrl, undefined);
});

test("MiMo alone supplies the retained cross-protocol api-key override fact", () => {
  const mimo = subscriptionFacts["mimo-token-plan"].authentication;
  assert.deepEqual(mimo.value, { header: "api-key", scheme: "raw", requirement: "Dedicated valid tp-/ttp- subscription key, separate from sk- pay-as-you-go or MiMo Free credentials" });
  assert.match(mimo.scope, /both Chat and Messages/);
  for (const id of ["zhipu-coding", "kimi-coding"] as const) {
    const auth = subscriptionFacts[id].authentication;
    assert.equal(auth.value.header, "x-api-key");
    assert.match(auth.scope, /global.*override/);
  }
});


test("loopback adapters preserve exact coding-plan paths and existing synthetic-key header shapes", async t => {
  const seen: Array<{ path: string; headers: IncomingHttpHeaders; body: { model?: string } }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      seen.push({ path: req.url!, headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const loopback = (url: string) => `${origin}${new URL(url).pathname}`;
  for (const id of activeIds) {
    const facts = subscriptionFacts[id], selected = preset(id);
    for (const protocol of ["chat", ...(selected.anthropicBaseUrl ? ["messages" as const] : [])] as const) {
      // Explicit fixture capability selects the adapter; facts/public presets
      // do not infer negotiated support merely from the endpoint's presence.
      const provider: Provider = {
        id: `fixture-${id}`, name: "Local subscription fixture", baseUrl: loopback(selected.baseUrl),
        ...(selected.anthropicBaseUrl ? { anthropicBaseUrl: loopback(selected.anthropicBaseUrl) } : {}),
        ...(selected.wire ? { wire: selected.wire } : {}),
        protocols: [protocol], models: [], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "",
      };
      const key = `synthetic-${id}-only`;
      const prepared = prepareOutbound(provider, {
        protocol, model: facts.modelId!.value, stream: false,
        body: { messages: [{ role: "user", content: "fixture" }], ...(protocol === "messages" ? { max_tokens: 8 } : {}) },
      });
      const response = await prepared.send(key, new AbortController().signal);
      assert.ok(response instanceof Response, `${id} ${protocol}`);
      assert.equal(response.status, 200);
      await response.text();
      const request = seen.at(-1)!;
      const expected = protocol === "chat" ? chatEndpoints[id] : messagesEndpoints[id]!;
      assert.equal(request.path, new URL(expected).pathname, `${id} ${protocol}`);
      assert.equal(request.body.model, facts.modelId!.value);
      assert.equal(request.headers.authorization, id === "mimo-token-plan" ? undefined : `Bearer ${key}`);
      assert.equal(request.headers["api-key"], id === "mimo-token-plan" ? key : undefined);
      assert.equal(request.headers["x-api-key"], protocol === "messages" ? key : undefined);
      assert.equal(request.headers["anthropic-version"], protocol === "messages" ? "2023-06-01" : undefined);
      assert.equal(request.headers["x-opencode-session"], undefined, "No fabricated static conversation ID");
      assert.equal(request.headers["x-mimo-source"], undefined, "No branded client spoofing");
    }
  }
  assert.equal(seen.length, 15);
  // These are fixture observations of current runtime behavior. In particular,
  // Go's observed Bearer header is not upgraded to a documented vendor fact.
  assert.equal(subscriptionFacts["opencode-go"].authentication.value.header, undefined);
});


const preset = (id: string): ProviderPreset => { const p = PRESETS.find(p => p.id === id); assert.ok(p, id); return p; };

test("coding-plan picker order, defaults, avatars and optional-field presence remain unchanged", () => {
  const rows = PRESETS.filter(p => p.category === "编程套餐");
  assert.deepEqual(rows.map(p => p.id), ids);
  assert.deepEqual(rows.map(p => p.defaultModel), selectedModels);
  assert.deepEqual(rows.map(p => [p.name, p.icon]), [
    ["智谱 GLM 编程套餐", "zhipu-color"], ["Z.AI GLM 编程套餐", "zai"], ["Kimi For Coding", "kimi-color"],
    ["MiniMax 编程套餐（国内）", "minimax-color"], ["MiniMax 编程套餐（国际）", "minimax-color"],
    ["火山方舟 编程套餐", "volcengine-color"], ["腾讯云 编程套餐", "hunyuan-color"],
    ["阿里云 Token Plan（北京）", "alibaba-color"], ["小米 MiMo Token Plan", "xiaomi-color"], ["opencode Go", "opencode"],
  ]);
  for (const p of rows) {
    const expected = ["id", "name", "category", "icon", "baseUrl", "defaultModel"];
    if (!["tencent-coding", "alibaba-token-plan", "opencode-go"].includes(p.id)) expected.push("anthropicBaseUrl", "keyUrl", "note");
    if (p.id === "mimo-token-plan") expected.push("wire");
    assert.deepEqual(Object.keys(p).sort(), expected.sort(), p.id);
    if (p.id === "mimo-token-plan") assert.deepEqual(p.wire, { authHeader: "api-key", authScheme: "raw" });
    else assert.equal(p.wire, undefined, p.id);
  }
});

test("MiniMax CN remains legacy without changing runtime credential destinations or plan-usage selection", () => {
  const cn = preset("minimax-coding-cn");
  assert.deepEqual(cn, {
    id: "minimax-coding-cn", name: "MiniMax 编程套餐（国内）", category: "编程套餐", icon: "minimax-color",
    baseUrl: "https://api.minimaxi.com/v1", anthropicBaseUrl: "https://api.minimaxi.com/anthropic", defaultModel: "MiniMax-M3",
    keyUrl: "https://platform.minimaxi.com", note: "使用国内专用 Subscription Key；普通 API Key 扣按量余额；适用套餐范围和限额",
  });
  const origins: Readonly<Record<string, { status: string }>> = PRESET_PROVENANCE;
  assert.equal(origins["minimax-coding-cn"]!.status, "legacy-attributed");
  const provider: Provider = { ...cn, models: [], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "" };
  assert.equal(hasPlanUsage(provider), true);
  assert.equal(hasPlanUsage({ ...provider, baseUrl: MINIMAX_CN_RESEARCH_FACTS.baseUrl.value }), false);
  assert.equal(vendorFor(cn.baseUrl), "minimax-cn");
  assert.equal(vendorFor(MINIMAX_CN_RESEARCH_FACTS.baseUrl.value), undefined);
});


const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
};
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
const headers = { "content-type": "application/json", "x-easyswitch": "1" };

test("serving coding-plan presets never migrates saved SDK roots, MiniMax hosts or custom Messages paths", async t => {
  const root = mkdtempSync(join(tmpdir(), "es-subscription-saved-"));
  const store = new Store(root);
  const previousBases = [
    ["zhipu-coding", "https://open.bigmodel.cn/api/anthropic"],
    ["zai", "https://api.z.ai/api/anthropic"],
    ["kimi-coding", "https://api.kimi.com/coding"],
    ["minimax-coding-cn", "https://api.minimaxi.com/anthropic"],
    ["minimax-coding", "https://api.minimax.io/anthropic"],
    ["volcengine-coding", "https://ark.cn-beijing.volces.com/api/coding"],
    ["mimo-token-plan", "https://token-plan-cn.xiaomimimo.com/anthropic"],
  ] as const;
  const saved: Provider[] = previousBases.map(([id, anthropicBaseUrl]) => ({
    id: `saved-${id}`, name: "Saved coding plan", baseUrl: preset(id).baseUrl, anthropicBaseUrl,
    models: [], billing: "subscription", route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "2026-10-01T00:00:00.000Z",
  }));
  saved.push({ id: "saved-custom", name: "Saved custom path", baseUrl: "https://fixture.invalid/api", anthropicBaseUrl: "https://fixture.invalid/private/root", models: [], wire: { paths: { messages: "v7/messages" } }, route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "2026-10-01T00:00:00.000Z" });
  for (const provider of saved) store.upsertProvider(provider);
  const before = readFileSync(join(root, "state.json"), "utf8");
  const server = createEasySwitchServer({ store, port: 0, secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} } });
  t.after(async () => { await close(server); rmSync(root, { recursive: true, force: true }); });
  const origin = await listen(server);
  const response = await fetch(`${origin}/api/presets`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), PRESETS);
  assert.equal(readFileSync(join(root, "state.json"), "utf8"), before);
  assert.deepEqual(store.providers(), saved);
  const reloaded = new Store(root);
  assert.deepEqual(reloaded.providers(), saved);
  for (const [id, base] of previousBases) assert.equal(endpointUrl(reloaded.provider(`saved-${id}`)!, "messages"), `${base}/messages`, id);
  assert.equal(reloaded.provider("saved-minimax-coding-cn")!.baseUrl, "https://api.minimaxi.com/v1");
  assert.equal(endpointUrl(reloaded.provider("saved-custom")!, "messages"), "https://fixture.invalid/private/root/v7/messages");
});

test("every coding-plan selection retains subscription billing and public shape through the loopback console", async t => {
  const root = mkdtempSync(join(tmpdir(), "es-subscription-console-"));
  const store = new Store(root);
  const server = createEasySwitchServer({ store, port: 0, secrets: { get: async () => undefined, set: async () => {}, delete: async () => {} } });
  const upstream = createServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
  });
  t.after(async () => { await Promise.all([close(server), close(upstream)]); rmSync(root, { recursive: true, force: true }); });
  const upstreamOrigin = await listen(upstream), origin = await listen(server);
  for (const id of ids) {
    const response = await fetch(`${origin}/api/providers`, {
      method: "POST", headers, body: JSON.stringify({ name: `fixture-${id}`, baseUrl: `${upstreamOrigin}/v1`, presetId: id }),
    });
    assert.equal(response.status, 201, id);
    const body = await response.json() as Provider;
    assert.equal(body.billing, "subscription", id);
    assert.equal(body.icon, preset(id).icon, id);
    assert.deepEqual(body.models, ["fixture-model"], id);
    assert.equal(body.protocols, undefined, id);
    assert.equal(Object.hasOwn(body, "provenance"), false, id);
    assert.deepEqual(body.wire, preset(id).wire, id);
  }
});


test("nine active coding plans reconstruct from facts while MiniMax CN stays research-only", () => {
  assert.equal(activeIds.length, 9);
  assert.deepEqual(INDEPENDENT_PRESETS.filter(p => p.category === "编程套餐").map(p => p.id), activeIds);
  assert.equal(Object.hasOwn(OFFICIAL_PRESET_FACTS, "minimax-coding-cn"), false);
  const origins: Readonly<Record<string, { status: string }>> = PRESET_PROVENANCE;
  for (const id of activeIds) {
    const p = preset(id), facts = subscriptionFacts[id];
    assert.equal(origins[id]!.status, "independent-reconstruction", id);
    assert.equal(OFFICIAL_PRESET_FACTS[id], SUBSCRIPTION_PRESET_FACTS[id]);
    assert.equal(p.baseUrl, facts.baseUrl.value, id);
    assert.equal(p.defaultModel, facts.modelId!.value, id);
    assert.equal(p.anthropicBaseUrl, facts.anthropicBaseUrl?.value, id);
    const endpoint = { baseUrl: p.baseUrl, anthropicBaseUrl: p.anthropicBaseUrl, wire: p.wire };
    assert.equal(endpointUrl(endpoint, "chat"), chatEndpoints[id], id);
    if (p.anthropicBaseUrl) assert.equal(endpointUrl(endpoint, "messages"), messagesEndpoints[id], id);
    const fields = INDEPENDENT_PRESET_PROVENANCE[id].fields;
    assert.deepEqual(Object.keys(fields).sort(), Object.keys(p).sort(), id);
    if (["tencent-coding", "alibaba-token-plan", "opencode-go"].includes(id)) {
      assert.equal(Object.hasOwn(p, "note"), false);
      assert.equal(Object.hasOwn(p, "keyUrl"), false);
      assert.equal(Object.hasOwn(p, "anthropicBaseUrl"), false);
      assert.ok(facts.guidance.value);
      assert.ok(facts.keyGuide!.value);
    } else {
      assert.equal(p.note, facts.guidance.value);
      assert.equal(p.keyUrl, facts.keyGuide!.value);
    }
  }
});
