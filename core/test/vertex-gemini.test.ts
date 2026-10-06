import { pickKey, setVertexToken } from "../src/keypool.ts";
import { createSecretStore } from "../src/secrets.ts";
import { vertexAccessToken } from "../src/vertex.ts";
import { vertexKind, type VertexServiceAccountConfig } from "../src/vertex-config.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareVertex, vertexConfigIssue, vertexEndpoint, type VertexConfig } from "../src/vertex-gemini.ts";
import type { Provider } from "../src/types.ts";
import type { InboundRequest } from "../src/protocol.ts";

const standard: Extract<VertexConfig, { mode: "standard" }> = { mode: "standard", project: "test-project", location: "global", auth: "access-token" };
const express: Extract<VertexConfig, { mode: "express" }> = { mode: "express", auth: "api-key" };
const provider = (vertex: VertexConfig = standard): Provider => ({ id: "v", name: "Vertex", baseUrl: "https://untrusted.invalid", models: [], route: "chat-translate", routePinned: false, streamUsage: false, createdAt: "2026-10-06", vertex });
const request = (protocol: InboundRequest["protocol"] = "gemini", stream = false): InboundRequest => ({ protocol, model: "gemini-3.5-flash", stream, body: protocol === "gemini" ? { contents: [{ role: "user", parts: [{ text: "test" }] }] } : protocol === "chat" ? { model: "m", messages: [{ role: "user", content: "test" }] } : protocol === "responses" ? { model: "m", input: "test" } : { model: "m", max_tokens: 128, messages: [{ role: "user", content: "test" }] } });

test("Vertex builds regional, global and Express Gemini endpoints without credential query strings", () => {
  assert.equal(vertexEndpoint(standard, "gemini-3.5-flash"), "https://aiplatform.googleapis.com/v1/projects/test-project/locations/global/publishers/google/models/gemini-3.5-flash:generateContent");
  assert.match(vertexEndpoint({ ...standard, location: "us-central1" }, "gemini-3.5-flash[1m]", true), /^https:\/\/us-central1-aiplatform\.googleapis\.com\/v1\/projects\/test-project\/locations\/us-central1\/publishers\/google\/models\/gemini-3\.5-flash:streamGenerateContent\?alt=sse$/);
  assert.equal(vertexEndpoint(express, "gemini-3.5-flash"), "https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.5-flash:generateContent");
});

test("Vertex rejects credential-bearing, malformed and URL-injection configurations before sending", () => {
  for (const value of [undefined, null, [], {}, { ...standard, project: "p/../x" }, { ...standard, location: "global.evil.test" }, { ...standard, token: "do-not-log" }, { ...standard, auth: "api-key" }, { ...express, baseUrl: "https://evil.test" }]) {
    const issue = vertexConfigIssue(value);
    assert.ok(issue); assert.ok(!issue.includes("do-not-log"));
  }
  for (const model of ["../gemini-flash", "publishers/anthropic/models/claude", "grok-4", "gemini-x?key=fake", "gemini-x#fragment"]) assert.throws(() => vertexEndpoint(standard, model));
});

test("Vertex uses only supplied credentials, fixed hosts and secret-free configuration", async () => {
  for (const config of [standard, express]) {
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(new URL(String(url)).hostname, "aiplatform.googleapis.com");
      assert.ok(!String(url).includes("fake-secret"));
      const headers = new Headers(init?.headers);
      assert.equal(headers.get(config.auth === "api-key" ? "x-goog-api-key" : "authorization"), config.auth === "api-key" ? "fake-secret" : "Bearer fake-secret");
      assert.equal(headers.has("x-client-secret"), false);
      assert.equal(init?.redirect, "error");
      return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] });
    };
    const p = provider(config); p.wire = { headers: { "x-client-secret": "not-forwarded" }, query: { key: "not-forwarded" } };
    const prepared = prepareVertex(p, request(), fetcher);
    assert.equal(prepared.adapter, `vertex-${config.mode}`);
    assert.equal(prepared.passthrough, true);
    assert.ok(await prepared.send("fake-secret", new AbortController().signal) instanceof Response);
    assert.equal(calls, 1); assert.ok(!JSON.stringify(p).includes("fake-secret"));
  }
});

test("Vertex translates all other inbound protocols through Gemini and preserves same-protocol payloads", async () => {
  for (const protocol of ["chat", "responses", "messages", "gemini"] as const) {
    const input = request(protocol);
    input.body.safetySettings = [{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" }];
    const original = structuredClone(input);
    const prepared = prepareVertex(provider(), input, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.contents[0].parts[0].text, "test");
      assert.equal(body.model, undefined); assert.equal(body.stream, undefined);
      if (protocol === "gemini") assert.deepEqual(body.safetySettings, input.body.safetySettings);
      return Response.json({});
    });
    assert.equal(prepared.protocol, "gemini");
    assert.equal(prepared.passthrough, protocol === "gemini");
    await prepared.send("fake-token", new AbortController().signal);
    assert.deepEqual(input, original);
  }
});

test("Vertex missing credentials and aborts never call transport; failures redact secrets", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("fake-token-leak"); };
  const prepared = prepareVertex(provider(), request(), fetcher);
  assert.ok(await prepared.send(undefined, new AbortController().signal) instanceof Error);
  assert.equal(calls, 0);
  const controller = new AbortController(); controller.abort();
  assert.ok(await prepared.send("fake-token", controller.signal) instanceof Error);
  assert.equal(calls, 0);
  const failed = await prepared.send("fake-token", new AbortController().signal);
  assert.equal(calls, 1); assert.ok(failed instanceof Error); assert.ok(!failed.message.includes("fake-token"));
});

test("Vertex preserves upstream status, retry headers and Gemini SSE events without replay", async () => {
  let calls = 0;
  const failed = prepareVertex(provider(), request(), async () => { calls++; return new Response('{"error":{"message":"quota"}}', { status: 429, headers: { "retry-after": "5" } }); });
  const response = await failed.send("fake-token", new AbortController().signal);
  assert.ok(response instanceof Response); assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "5"); assert.equal(calls, 1);
  const streaming = prepareVertex(provider(express), request("gemini", true), async (url, init) => {
    assert.match(String(url), /streamGenerateContent\?alt=sse$/); assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
    return new Response('data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":1}}\n\n', { headers: { "content-type": "text/event-stream" } });
  });
  const stream = await streaming.send("fake-key", new AbortController().signal); assert.ok(stream instanceof Response);
  const events = []; for await (const event of streaming.events(stream)) events.push(event);
  assert.ok(events.some(e => e.type === "text" && e.text === "hello"));
});


test("Vertex mode metadata keeps legacy service accounts separate from supplied credentials", () => {
  const legacy = { project: "test-project", location: "global", clientEmail: "test@test-project.iam.gserviceaccount.com" };
  assert.equal(vertexKind(legacy), "service-account");
  assert.equal(vertexKind({ ...legacy, mode: "service-account", auth: "service-account" }), "service-account");
  assert.equal(vertexKind(standard), "standard"); assert.equal(vertexKind(express), "express");
  assert.equal(vertexKind(undefined), undefined);
  for (const malformed of [null, {}, { ...legacy, mode: "standard", auth: "access-token" }, { ...standard, auth: "service-account" }, { ...express, clientEmail: legacy.clientEmail }]) assert.throws(() => vertexKind(malformed));
  assert.throws(() => prepareVertex(provider(legacy), request()), /服务账号模式/);
  assert.throws(() => vertexEndpoint(legacy as never, "gemini-3.5-flash"), /服务账号模式/);
});

test("key selection never mints or reads service-account secrets for supplied-token and Express modes", async () => {
  const secrets = createSecretStore();
  const reads: string[] = [];
  const original = secrets.get.bind(secrets);
  secrets.get = async name => { reads.push(name); return original(name); };
  await secrets.set("v", "manual-fake-key");
  await secrets.set("vertex:v", "must-not-be-read");
  let mints = 0;
  setVertexToken(async () => { mints++; return "service-account-fake-token"; });
  try {
    for (const config of [standard, express]) assert.equal((await pickKey(secrets, provider(config))).apiKey, "manual-fake-key");
    assert.equal(mints, 0); assert.deepEqual(reads, ["v", "v"]);
    reads.length = 0;
    const legacy: VertexServiceAccountConfig = { project: "test-project", location: "global", clientEmail: "test@test-project.iam.gserviceaccount.com" };
    assert.equal((await pickKey(secrets, provider(legacy))).apiKey, "service-account-fake-token");
    assert.equal(mints, 1); assert.deepEqual(reads, [], "service-account mode never falls back to the ordinary provider key");
    setVertexToken(undefined);
    await assert.rejects(pickKey(secrets, provider(legacy)), /不会改用普通 API Key/);
    await assert.rejects(vertexAccessToken(secrets, provider(standard)), /只有服务账号模式/);
    await assert.rejects(vertexAccessToken(secrets, provider(express)), /只有服务账号模式/);
    assert.deepEqual(reads, []);
  } finally { setVertexToken(undefined); }
});

test("mixed Vertex auth configurations fail before any other provider credential can win", async () => {
  let reads = 0;
  const secrets = createSecretStore(); secrets.get = async () => { reads++; return "fake"; };
  for (const extra of [{ plan: { kind: "codex", accountId: "fake" } }, { antigravity: {} }, { kiro: {} }, { mimoFree: true }]) {
    await assert.rejects(pickKey(secrets, { ...provider(), ...extra } as Provider), /多种专用鉴权/);
  }
  await assert.rejects(pickKey(secrets, { ...provider(), vertex: {} } as Provider));
  assert.equal(reads, 0);
});

/** Inspect the actual egress body with fake credentials and an injected, non-network transport. */
async function thinkingRequest(model: string, effort?: string, input = request()) {
  input = { ...input, model, effort };
  const original = structuredClone(input);
  let body: Record<string, any> | undefined;
  const prepared = prepareVertex(provider(), input, async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return Response.json({});
  });
  assert.ok(await prepared.send("fake-token", new AbortController().signal) instanceof Response);
  assert.ok(body);
  assert.deepEqual(input, original, "thinking normalization never mutates the caller's request");
  return { body, dropped: prepared.dropped };
}

test("Vertex Gemini 2.5 maps saved levels to bounded token budgets for every inbound protocol", async () => {
  for (const protocol of ["chat", "responses", "messages", "gemini"] as const) {
    for (const [model, maximum] of [["gemini-2.5-pro", 32768], ["gemini-2.5-flash", 24576], ["gemini-2.5-flash-lite", 24576]] as const) {
      for (const [effort, budget] of [["low", 1024], ["medium", 8192], ["high", maximum]] as const) {
        const { body, dropped } = await thinkingRequest(model, effort, request(protocol));
        assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: budget });
        assert.deepEqual(dropped, []);
      }
    }
  }
  for (const model of ["gemini-2.5-flash", "gemini-2.5-flash-lite"]) {
    for (const effort of ["none", "off"]) assert.deepEqual((await thinkingRequest(model, effort)).body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
  }
  assert.deepEqual((await thinkingRequest("gemini-2.5-pro-preview-05-06[1m]", "high")).body.generationConfig.thinkingConfig, { thinkingBudget: 32768 });
});

test("Vertex translates agent-supplied effort through the destination Gemini generation", async () => {
  for (const protocol of ["chat", "responses", "messages"] as const) {
    const input = request(protocol);
    if (protocol === "chat") input.body.reasoning_effort = "medium";
    else if (protocol === "responses") input.body.reasoning = { effort: "medium" };
    else input.body.output_config = { effort: "medium" };
    assert.deepEqual((await thinkingRequest("gemini-2.5-flash", undefined, input)).body.generationConfig.thinkingConfig, { thinkingBudget: 8192 });
    assert.deepEqual((await thinkingRequest("gemini-3-flash-preview", undefined, input)).body.generationConfig.thinkingConfig, { thinkingLevel: "MEDIUM" });
    const unknown = structuredClone(input);
    if (protocol === "chat") unknown.body.reasoning_effort = "ultra";
    else if (protocol === "responses") unknown.body.reasoning.effort = "ultra";
    else unknown.body.output_config.effort = "ultra";
    const { body, dropped } = await thinkingRequest("gemini-3-flash-preview", undefined, unknown);
    assert.equal(body.generationConfig?.thinkingConfig, undefined);
    assert.ok(dropped.includes("effort:unsupported_gemini"));
  }
});

test("Vertex Gemini 3 forwards only each documented model's thinking levels", async () => {
  for (const [model, levels] of [
    ["gemini-3-pro-preview", ["low", "high"]],
    ["gemini-3.1-pro-preview", ["low", "medium", "high"]],
    ["gemini-3-flash-preview", ["minimal", "low", "medium", "high"]],
    ["gemini-3.5-flash", ["minimal", "low", "medium", "high"]],
    ["gemini-3.5-flash-lite", ["minimal", "low", "medium", "high"]],
    ["gemini-3.8-flash", ["low", "medium", "high"]],
    ["gemini-3-pro-image-preview", ["high"]],
    ["gemini-3.1-flash-image-preview", ["minimal", "high"]],
  ] as const) {
    for (const effort of levels) {
      const { body, dropped } = await thinkingRequest(model, effort);
      assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: effort.toUpperCase() });
      assert.deepEqual(dropped, []);
    }
  }
});

test("Vertex omits and reports unsupported levels or unrecognized model generations", async () => {
  for (const [model, effort] of [
    ["gemini-2.5-pro", "none"], ["gemini-2.5-pro", "off"], ["gemini-2.5-flash", "xhigh"],
    ["gemini-3-pro-preview", "medium"], ["gemini-3-pro-preview", "minimal"],
    ["gemini-3.8-flash", "minimal"], ["gemini-3.5-flash", "off"], ["gemini-3.5-flash", "ultra"],
    ["gemini-3-pro-image-preview", "low"], ["gemini-3.1-flash-image-preview", "medium"],
    ["gemini-2.0-flash", "high"], ["gemini-4-pro", "high"], ["gemini-3.7-flash-cyber", "high"],
    ["gemini-2.5-flash-image", "high"], ["gemini-3.5-flash-unrecognized", "high"],
  ]) {
    const { body, dropped } = await thinkingRequest(model!, effort);
    assert.equal(body.generationConfig?.thinkingConfig, undefined, `${model}: ${effort}`);
    assert.ok(dropped.includes("effort:unsupported_gemini"));
  }
});

test("Vertex preserves valid native thinking budgets and unrelated generation fields without a saved override", async () => {
  for (const [model, budgets] of [
    ["gemini-2.5-pro", [-1, 128, 2048, 32768]],
    ["gemini-2.5-flash", [-1, 0, 1, 24576]],
    ["gemini-2.5-flash-lite", [-1, 0, 512, 24576]],
  ] as const) {
    for (const thinkingBudget of budgets) {
      const input = request();
      input.body.generationConfig = { temperature: 0.6, maxOutputTokens: 40000, responseMimeType: "application/json", thinkingConfig: { thinkingBudget, includeThoughts: true } };
      const { body, dropped } = await thinkingRequest(model, undefined, input);
      assert.deepEqual(body.generationConfig, input.body.generationConfig);
      assert.deepEqual(dropped, []);
      const stale = await thinkingRequest(model, "ultra", input);
      assert.deepEqual(stale.body.generationConfig, input.body.generationConfig);
      assert.ok(stale.dropped.includes("effort:unsupported_gemini"));
    }
  }
  const input = request();
  input.body.generationConfig = { temperature: 0.7, thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } };
  assert.deepEqual((await thinkingRequest("gemini-3-flash-preview", undefined, input)).body.generationConfig, input.body.generationConfig);
  assert.deepEqual((await thinkingRequest("gemini-3-flash-preview", "high", input)).body.generationConfig, { temperature: 0.7, thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: false } });
});

test("Vertex saved effort overrides native controls without mixing thinkingBudget and thinkingLevel", async () => {
  const input = request();
  input.body.generationConfig = { topP: 0.9, thinkingConfig: { thinkingBudget: 2048, thinkingLevel: "LOW", includeThoughts: true } };
  for (const [model, expected] of [["gemini-2.5-pro", { thinkingBudget: 8192 }], ["gemini-3.5-flash", { thinkingLevel: "MEDIUM" }]] as const) {
    const { body } = await thinkingRequest(model, "medium", input);
    assert.deepEqual(body.generationConfig, { topP: 0.9, thinkingConfig: { ...expected, includeThoughts: true } });
  }
  const nativeBudget = await thinkingRequest("gemini-2.5-pro", undefined, input);
  assert.deepEqual(nativeBudget.body.generationConfig.thinkingConfig, { thinkingBudget: 2048, includeThoughts: true });
  assert.ok(nativeBudget.dropped.includes("field:generationConfig.thinkingConfig.thinkingLevel"));
  const nativeLevel = await thinkingRequest("gemini-3.5-flash", undefined, input);
  assert.deepEqual(nativeLevel.body.generationConfig.thinkingConfig, { thinkingLevel: "LOW", includeThoughts: true });
  assert.ok(nativeLevel.dropped.includes("field:generationConfig.thinkingConfig.thinkingBudget"));
});

test("Vertex remaps native level-only Gemini 2.5 requests and omits invalid native controls", async () => {
  const input = request();
  input.body.generationConfig = { thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true } };
  assert.deepEqual((await thinkingRequest("gemini-2.5-flash", undefined, input)).body.generationConfig.thinkingConfig, { thinkingBudget: 24576, includeThoughts: true });
  for (const [model, config, omitted] of [
    ["gemini-2.5-pro", { thinkingBudget: 0 }, "thinkingBudget"],
    ["gemini-2.5-flash-lite", { thinkingBudget: 1 }, "thinkingBudget"],
    ["gemini-2.5-flash", { thinkingBudget: 24577 }, "thinkingBudget"],
    ["gemini-2.5-pro", { thinkingBudget: -2 }, "thinkingBudget"],
    ["gemini-2.5-pro", { thinkingBudget: 128.5 }, "thinkingBudget"],
    ["gemini-2.5-pro", { thinkingBudget: "2048" }, "thinkingBudget"],
    ["gemini-2.5-flash", { thinkingLevel: "ULTRA" }, "thinkingLevel"],
    ["gemini-3-pro-preview", { thinkingLevel: "MEDIUM" }, "thinkingLevel"],
    ["gemini-3.5-flash", { thinkingBudget: -1 }, "thinkingBudget"],
    ["gemini-4-pro", { thinkingLevel: "HIGH" }, "thinkingLevel"],
  ] as const) {
    input.body.generationConfig = { temperature: 0.5, thinkingConfig: { ...config, includeThoughts: true } };
    const { body, dropped } = await thinkingRequest(model, undefined, input);
    assert.deepEqual(body.generationConfig, { temperature: 0.5, thinkingConfig: { includeThoughts: true } });
    assert.ok(dropped.includes(`field:generationConfig.thinkingConfig.${omitted}`));
  }
  for (const model of ["gemini-2.5-pro", "gemini-3.5-flash"]) {
    const { body, dropped } = await thinkingRequest(model);
    assert.equal(body.generationConfig?.thinkingConfig, undefined);
    assert.deepEqual(dropped, []);
  }
});
