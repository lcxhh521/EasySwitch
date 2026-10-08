import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnoseMessagesEndpoint, type ProviderEndpointMetadata } from "../src/endpoint-diagnostics.ts";
import { endpointUrl } from "../src/upstream.ts";

const officialBases = [
  "https://api.deepseek.com/anthropic",
  "https://api.moonshot.cn/anthropic",
  "https://open.bigmodel.cn/api/anthropic",
  "https://dashscope.aliyuncs.com/apps/anthropic",
  "https://api.xiaomimimo.com/anthropic",
];

test("only the five verified stale effective Messages endpoints have precise public guidance", () => {
  for (const base of officialBases) {
    const provider = { baseUrl: "https://custom-chat.invalid/v1", anthropicBaseUrl: base };
    const before = JSON.stringify(provider);
    const diagnostic = diagnoseMessagesEndpoint(provider)!;
    assert.equal(diagnostic.code, "source_messages_endpoint_stale");
    assert.equal(diagnostic.staleEndpoint, `${base}/messages`);
    assert.equal(diagnostic.recommendedBaseUrl, `${base}/v1`);
    assert.equal(diagnostic.recommendedEndpoint, `${base}/v1/messages`);
    assert.equal(diagnostic.hasPathOverride, false);
    assert.equal(endpointUrl({ ...provider, anthropicBaseUrl: diagnostic.recommendedBaseUrl }, "messages"), diagnostic.recommendedEndpoint);
    assert.equal(JSON.stringify(provider), before);
    assert.deepEqual(diagnoseMessagesEndpoint({ baseUrl: base }), diagnostic, "fallback base has the same effective Messages URL");
    assert.equal(diagnoseMessagesEndpoint({ ...provider, anthropicBaseUrl: `${base}/v1` }), undefined);
  }
});

test("explicit Messages overrides use runtime semantics and already corrected routes do not warn", () => {
  const base = officialBases[0]!;
  for (const messages of ["v1/messages", "/v1/messages"]) {
    assert.equal(diagnoseMessagesEndpoint({ baseUrl: base, wire: { paths: { messages } } }), undefined);
  }
  assert.equal(diagnoseMessagesEndpoint({ baseUrl: `${base}/v1/messages`, wire: { paths: { messages: "" } } }), undefined);
  for (const provider of [
    { baseUrl: base, wire: { paths: { messages: "messages" } } },
    { baseUrl: `${base}/messages`, wire: { paths: { messages: "" } } },
    { baseUrl: "https://api.deepseek.com", wire: { paths: { messages: "anthropic/messages" } } },
  ]) {
    const diagnostic = diagnoseMessagesEndpoint(provider)!;
    assert.equal(diagnostic.hasPathOverride, true);
    assert.equal(diagnostic.staleEndpoint, `${base}/messages`);
    assert.equal(endpointUrl({ ...provider, anthropicBaseUrl: diagnostic.recommendedBaseUrl, wire: { paths: { messages: "messages" } } }, "messages"), diagnostic.recommendedEndpoint);
  }
});

test("custom hosts, unverified official routes, queries, fragments and credentials are not guessed", () => {
  const base = officialBases[0]!;
  const values: ProviderEndpointMetadata[] = [
    { baseUrl: "https://custom.invalid/anthropic" },
    { baseUrl: "https://api.deepseek.com.evil.invalid/anthropic" },
    { baseUrl: "https://api.deepseek.com/custom/anthropic" },
    { baseUrl: "https://api.deepseek.com/anthropic-extra" },
    { baseUrl: "https://api.deepseek.com:8443/anthropic" },
    { baseUrl: "http://api.deepseek.com/anthropic" },
    { baseUrl: "https://user:secret@api.deepseek.com/anthropic" },
    { baseUrl: `${base}?api_key=secret` },
    { baseUrl: `${base}#secret` },
    { baseUrl: base, wire: { query: { api_key: "secret" } } },
    { baseUrl: base, wire: { paths: { messages: "custom/messages" } } },
    { baseUrl: base, anthropicBaseUrl: "https://custom.invalid/anthropic" },
    { baseUrl: "https://api.moonshot.ai/anthropic" },
    { baseUrl: "https://api.xiaomimimo.com/v1" },
  ];
  for (const provider of values) assert.equal(diagnoseMessagesEndpoint(provider), undefined, JSON.stringify(provider));
});

test("placeholders are expanded exactly; invalid or missing route metadata never escapes as an error", () => {
  const base = officialBases[0]!;
  const provider = { baseUrl: "https://{host}/anthropic", urlParams: { host: "api.deepseek.com" } };
  assert.equal(diagnoseMessagesEndpoint(provider)?.staleEndpoint, `${base}/messages`);
  for (const value of [undefined, { baseUrl: "not a URL" }, { baseUrl: "https://{host}/anthropic" }, { baseUrl: "" }, { baseUrl: null }]) {
    assert.equal(diagnoseMessagesEndpoint(value as ProviderEndpointMetadata | undefined), undefined);
  }
});

test("diagnostics do not touch credentials or auth headers and do not return arbitrary provider metadata", () => {
  const provider = { baseUrl: officialBases[0]!, name: "SECRET_NAME", wire: { paths: {} } };
  for (const name of ["apiKey", "keys", "secretStore"]) Object.defineProperty(provider, name, { get() { assert.fail(`read ${name}`); } });
  for (const name of ["headers", "authHeader", "authScheme"]) Object.defineProperty(provider.wire, name, { get() { assert.fail(`read wire.${name}`); } });
  const diagnostic = diagnoseMessagesEndpoint(provider)!;
  assert.ok(diagnostic);
  assert.doesNotMatch(JSON.stringify(diagnostic), /SECRET_NAME|apiKey|secretStore|headers|authHeader|authScheme/);
  diagnostic.recommendedBaseUrl = "changed";
  assert.equal(diagnoseMessagesEndpoint(provider)?.recommendedBaseUrl, `${officialBases[0]}/v1`, "a caller cannot mutate the known endpoint table");
});
