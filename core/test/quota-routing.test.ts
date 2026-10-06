import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { test } from "node:test";
import { prepareOutbound } from "../src/outbound.ts";
import { sendKimiConversation } from "../src/kimi-upstream.ts";
import { decodeRequest } from "../src/inbound.ts";
import { isExhausted, clearQuota, describeQuota, quotaOf } from "../src/quota.ts";
import { copilotQuotaCapability } from "../src/copilot-quota.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import type { Provider } from "../src/types.ts";
import type { InboundRequest } from "../src/protocol.ts";

const input: InboundRequest = { protocol: "chat", model: "kimi-k2.6", stream: false, body: { model: "kimi-k2.6", messages: [{ role: "user", content: "fixture" }] } };
const provider = (id: string, baseUrl: string): Provider => ({ id, name: id, baseUrl, models: [input.model], protocols: ["chat"], route: "chat-translate", routePinned: false, streamUsage: true, createdAt: new Date().toISOString() });
const limited = "You've reached your 5-hour usage limit.";

test("only the official Kimi source or its dedicated adapter records an explicit quota 403; native status/body stay unchanged", async t => {
  let text = limited, calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ error: { message: text } }, { status: 403 }); });
  try {
    for (const [id, base, expected] of [["official", "https://api.kimi.com/coding/v1", true], ["relay", "https://relay.invalid/v1", false], ["insecure", "http://api.kimi.com/coding/v1", false], ["custom-port", "https://api.kimi.com:444/coding/v1", false]] as const) {
      const response = await prepareOutbound(provider(id, base), input).send("fixture-key", new AbortController().signal);
      assert.ok(response instanceof Response);
      assert.equal(response.status, 403); assert.match(await response.text(), /5-hour usage limit/);
      assert.equal(isExhausted(id), expected);
    }
    const own = provider("member", "https://api.kimi.com/coding/v1");
    const response = await sendKimiConversation(own, "fixture-token", decodeRequest(input), input, "http://127.0.0.1:123/coding/v1", new AbortController().signal);
    assert.equal(response.status, 403); assert.equal(isExhausted("member"), true);
    assert.match(describeQuota(quotaOf("member"))!, /恢复时间未知/);
    text = "Concurrent request limit exceeded.";
    const denied = await prepareOutbound(provider("concurrency", "https://api.kimi.ai/coding/v1"), input).send("fixture-key", new AbortController().signal);
    assert.ok(denied instanceof Response);
    assert.equal(denied.status, 403); assert.equal(isExhausted("concurrency"), false);
    assert.equal(calls, 6);
  } finally { clearQuota(); }
});

test("the account API exposes disconnected Copilot quota capability without reading credentials or calling a vendor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-quota-api-")); const store = new Store(dir); let reads = 0;
  store.siwcStorage().save({ id: "fixture-copilot", kind: "copilot", subject: "fixture", label: "Fixture", clientId: "fixture", scopes: [], expiresAt: Date.now() + 10000, planUsage: true });
  const server = createEasySwitchServer({ port: 0, store, secrets: { get: async () => { reads++; throw new Error("forbidden credential read"); }, set: async () => {}, delete: async () => {} } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/plan`, { headers: { "x-easyswitch": "1" } });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.deepEqual(body.quotaSupport.copilot, copilotQuotaCapability());
    assert.deepEqual(body.accounts[0].quotaSupport, copilotQuotaCapability());
    assert.equal(body.accounts[0].quota, undefined); assert.equal(reads, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});

test("the actual subscription card explains unknown quota and escapes capability prose", () => {
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#providers" }, window: { addEventListener() {} }, document: { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], activeElement: null }, localStorage: { getItem: () => null }, history: { replaceState() {} }, setTimeout: () => 0, clearTimeout() {}, console });
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  context.capability = copilotQuotaCapability();
  vm.runInContext(`planInfo = {accounts:[{id:'fixture',kind:'copilot',label:'Fixture',on:true,planUsage:true,quotaSupport:capability}],signIn:null}`, context);
  const card = vm.runInContext("planCard()", context) as string;
  assert.match(card, /尚未接入官方额度读取/); assert.doesNotMatch(card, /剩余100%|已恢复/);
  vm.runInContext(`planInfo.accounts[0].quotaSupport.text = '<img src=x onerror=alert(1)>'`, context);
  const malicious = vm.runInContext("planCard()", context) as string;
  assert.ok(malicious.includes("&lt;img")); assert.ok(!malicious.includes("<img src=x"));
});
