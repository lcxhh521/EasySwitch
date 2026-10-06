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
