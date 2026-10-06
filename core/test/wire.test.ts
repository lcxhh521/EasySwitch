import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PRESETS } from "../src/presets.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { endpointUrl, expandUrl, UnresolvedPlaceholder, upstreamHeaders } from "../src/upstream.ts";
import type { Provider } from "../src/types.ts";

process.env.EASYSWITCH_SECRETS = "memory";

test("placeholders are filled from the user's values and refuse to guess", () => {
  assert.equal(expandUrl("https://{resource}.openai.azure.com/openai/v1", { resource: "my-oai" }), "https://my-oai.openai.azure.com/openai/v1");
  assert.equal(expandUrl("https://x/{a}/{b}/{a}", { a: "1", b: "2" }), "https://x/1/2/1");
  assert.throws(() => expandUrl("https://{resource}.x", {}), (e: unknown) => e instanceof UnresolvedPlaceholder && e.names[0] === "resource");
  assert.equal(expandUrl("https://x/{a}", { a: "a b/c" }), "https://x/a%20b%2Fc", "values are escaped, not trusted");
});

test("wire config shapes headers, paths and query", () => {
  const azure = PRESETS.find(p => p.id === "azure-openai")!;
  const provider = { baseUrl: azure.baseUrl, urlParams: { resource: "r1" }, wire: azure.wire };
  assert.deepEqual(upstreamHeaders(provider, "KEY"), { "api-key": "KEY" });
  assert.equal(endpointUrl(provider, "chat"), "https://r1.openai.azure.com/openai/v1/chat/completions");
  const legacy = { baseUrl: "https://r.x/openai/deployments/d", wire: { paths: { chat: "chat/completions" }, query: { "api-version": "2024-10-21" }, headers: { "X-Org": "o" } } };
  assert.equal(endpointUrl(legacy, "chat"), "https://r.x/openai/deployments/d/chat/completions?api-version=2024-10-21");
  assert.equal(upstreamHeaders(legacy, undefined)["x-org"], "o", "extra headers go lowercase, without a key no auth header");
  assert.deepEqual(upstreamHeaders({}, "K"), { authorization: "Bearer K" }, "plain providers are unchanged");
});

test("every templated preset declares the parameters its addresses use", () => {
  for (const p of PRESETS) {
    const used = new Set([...`${p.baseUrl} ${p.anthropicBaseUrl ?? ""}`.matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map(m => m[1]!));
    const declared = new Set((p.urlParams ?? []).map(x => x.key));
    assert.deepEqual([...used].sort(), [...declared].sort(), `preset ${p.id}`);
  }
});

// A provider that wants its key in `api-key`, a query parameter, and a custom path.
let upstream: Server;
let upstreamPort: number;
const seen: Array<{ url: string; headers: IncomingMessage["headers"] }> = [];
let server: Server;
let port: number;
let store: Store;

before(async () => {
  upstream = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      if (req.headers["api-key"] !== "azure-key") { res.writeHead(401).end("{}"); return; }
      if (req.url?.startsWith("/openai/v1/models")) { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "my-deployment" }] })); return; }
      if (req.url?.startsWith("/openai/v1/chat/completions")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "pong" } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(404).end("{}");
    });
  }).listen(0, "127.0.0.1");
  await new Promise(r => upstream.once("listening", r));
  upstreamPort = (upstream.address() as { port: number }).port;

  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => resolve(p));
    });
  });
  store = new Store(mkdtempSync(join(tmpdir(), "es-wire-")));
  server = createEasySwitchServer({ store, secrets: createSecretStore(), port });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
});

after(() => { server.close(); upstream.close(); });

test("a templated provider with a custom key header works through the gateway end to end", async () => {
  const secrets = createSecretStore();
  const provider: Provider = {
    id: "az", name: "Azure test", baseUrl: "http://127.0.0.1:{port}/openai/v1", urlParams: { port: String(upstreamPort) },
    wire: { authHeader: "api-key", authScheme: "raw", headers: { "x-test": "yes" }, query: { "api-version": "preview" } },
    models: ["my-deployment"], defaultModel: "my-deployment", route: "chat-translate", routePinned: false, streamUsage: true, createdAt: new Date().toISOString(),
  };
  // The default secret store is memory-backed per createSecretStore(); use the server's own through the API.
  store.upsertProvider(provider);
  const H = { "content-type": "application/json", "x-easyswitch": "1" };
  // Keys go in through the management API, as the console does.
  await fetch(`http://127.0.0.1:${port}/api/providers/az/keys`, { method: "POST", headers: H, body: JSON.stringify({ label: "k", apiKey: "azure-key" }) });
  void secrets;
  const response = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "az/my-deployment", stream: true, input: "ping" }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.match(text, /pong/);
  const hit = seen.find(s => s.url.startsWith("/openai/v1/chat/completions"))!;
  assert.ok(hit.url.includes("api-version=preview"), "query parameter sent");
  assert.equal(hit.headers["api-key"], "azure-key");
  assert.equal(hit.headers["x-test"], "yes");
  assert.equal(hit.headers.authorization, undefined, "no Bearer header when the provider uses api-key");
});
