import { fixtureFetch as fetch, fixtureToken } from "./gateway-client.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSign } from "node:crypto";
import { after, before, test } from "node:test";
import { mimoClientId, withMimoMarker, MIMO_SYSTEM_MARKER, mimoFreeIssue, mimoJwt } from "../src/mimo-free.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { sendChat } from "../src/upstream-chat.ts";
import type { Provider } from "../src/types.ts";
import { sessionToken } from "../src/gateway-auth.ts";
import { Store } from "../src/store.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

const signJwt = (claims: Json) => {
  const head = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createSign("RSA-SHA256").update("x"); // unsigned is fine for expiry parsing
  void sig;
  return `${head}.${body}.`;
};

let bootstrapCalls = 0;
let redirectChat = false;
let chatBodies: Json[] = [];
let chatHeaders: Array<Record<string, string | string[] | undefined>> = [];

const fake = createServer((req, res) => {
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    console.error(`[fake] ${req.method} ${req.url}`);
    if (req.url?.startsWith("/api/free-ai/bootstrap")) {
      bootstrapCalls += 1;
      return send(200, { jwt: signJwt({ exp: Math.floor(Date.now() / 1000) + 1800 }) });
    }
    if (req.url?.startsWith("/api/free-ai/openai/chat")) {
      if (redirectChat) { res.writeHead(302, { location: "https://must-not-contact.invalid/chat" }).end(); return; }
      chatBodies.push(JSON.parse(raw || "{}") as Json);
      chatHeaders.push({ ...req.headers });
      return send(200, { id: "c1", object: "chat.completion", created: 1, model: "mimo-auto", choices: [{ index: 0, message: { role: "assistant", content: "free pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    }
    res.writeHead(404).end();
  });
});
let port = 0;
let serverPort = 0;
let server: Server;
let store: Store;
let pid: string;
let stateDir: string;

before(async () => {
  process.env.EASYSWITCH_TEST_MIMO_FIXTURES = "1";
  await new Promise<void>(r => fake.listen(0, "127.0.0.1", r));
  port = (fake.address() as { port: number }).port;
  process.env.EASYSWITCH_MIMO_BOOTSTRAP = `http://127.0.0.1:${port}/api/free-ai/bootstrap`;
  process.env.EASYSWITCH_MIMO_CHAT = `http://127.0.0.1:${port}/api/free-ai/openai/chat`;
  stateDir = mkdtempSync(join(tmpdir(), "es-mimo-"));
  process.env.EASYSWITCH_HOME = stateDir;
  store = new Store(join(stateDir, "state"));
  server = createEasySwitchServer({ store, secrets: createSecretStore(), port: 0 });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  serverPort = (server.address() as { port: number }).port;
});

after(() => { server.closeAllConnections(); server.close(); fake.closeAllConnections(); fake.close(); delete process.env.EASYSWITCH_HOME; delete process.env.EASYSWITCH_TEST_MIMO_FIXTURES; });

test("MiMo Free cannot reach vendor endpoints even with the fixture flag", async () => {
  const bootstrap = process.env.EASYSWITCH_MIMO_BOOTSTRAP;
  const chat = process.env.EASYSWITCH_MIMO_CHAT;
  try {
    delete process.env.EASYSWITCH_MIMO_BOOTSTRAP; delete process.env.EASYSWITCH_MIMO_CHAT;
    assert.match(mimoFreeIssue()!, /现已停用/);
    await assert.rejects(mimoJwt(stateDir), /现已停用/);
    const legacy = await sendChat({ mimoFree: true } as Provider, undefined, { model: "mimo-auto", messages: [], stream: false }, new AbortController().signal);
    assert.ok(legacy instanceof Response); assert.equal(legacy.status, 501);
    process.env.EASYSWITCH_MIMO_BOOTSTRAP = bootstrap;
    assert.ok(mimoFreeIssue(), "a local bootstrap with a real chat destination is still blocked");
    process.env.EASYSWITCH_MIMO_CHAT = chat;
    delete process.env.EASYSWITCH_TEST_MIMO_FIXTURES;
    assert.ok(mimoFreeIssue(), "local destinations require explicit fixture opt-in");
  } finally {
    process.env.EASYSWITCH_MIMO_BOOTSTRAP = bootstrap;
    process.env.EASYSWITCH_MIMO_CHAT = chat;
    process.env.EASYSWITCH_TEST_MIMO_FIXTURES = "1";
  }
  assert.equal(bootstrapCalls, 0, "validation fails before bootstrap I/O");
});

test("the client id is a stable random UUID stored in our directory, not machine-derived", () => {
  const a = mimoClientId(stateDir);
  assert.match(a, /^[0-9a-f-]{36}$/i);
  assert.equal(mimoClientId(stateDir), a);
});

test("the required marker is prepended once, not duplicated", () => {
  const once = withMimoMarker({ messages: [{ role: "user", content: "hi" }] }) as { messages: Json[] };
  assert.equal(once.messages[0]!.content, MIMO_SYSTEM_MARKER);
  assert.equal(once.messages.length, 2);
  const twice = withMimoMarker({ messages: [{ role: "system", content: `x ${MIMO_SYSTEM_MARKER} y` }, { role: "user", content: "hi" }] }) as { messages: Json[] };
  assert.equal(twice.messages.length, 2, "left alone when the marker is already there");
});

test("a chat call against the free endpoint bootstraps a JWT once and sends the marker and client headers", async () => {
  const made = (await fetch(`http://127.0.0.1:${serverPort}/api/providers`, {
    method: "POST", headers: { "content-type": "application/json", "x-easyswitch": "1" },
    body: JSON.stringify({ name: "MiMo Free 演示", baseUrl: process.env.EASYSWITCH_MIMO_CHAT, presetId: "mimo-free" }),
  }).then(r => r.json())) as { id: string };
  pid = made.id;
  const res = await fetch(`http://127.0.0.1:${serverPort}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", host: `127.0.0.1:${serverPort}`, authorization: `Bearer ${sessionToken("chat")}` },
    body: JSON.stringify({ model: `${pid}/mimo-auto`, messages: [{ role: "user", content: "pong please" }] }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(((await res.json()) as Json).choices[0].message.content, "free pong");
  assert.equal(bootstrapCalls, 1, "one bootstrap for the first call");
  // The probe also touches the chat endpoint with an empty body; the real call is the one with messages.
  const sent = chatBodies.find(b => Array.isArray(b.messages) && b.messages.length > 0)!;
  assert.equal(sent.messages[0].role, "system");
  assert.ok(String(sent.messages[0].content).includes(MIMO_SYSTEM_MARKER));
  const headers = chatHeaders[chatBodies.indexOf(sent)]!;
  assert.match(String(headers["x-mimo-source"]), /mimocode-cli-free/);
  assert.match(String(headers.authorization), /^Bearer ey/);
  // A second call reuses the cached JWT.
  await fetch(`http://127.0.0.1:${serverPort}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", host: `127.0.0.1:${serverPort}`, authorization: `Bearer ${sessionToken("chat")}` },
    body: JSON.stringify({ model: `${pid}/mimo-auto`, messages: [{ role: "user", content: "again" }] }),
  }).then(r => r.text());
  assert.equal(bootstrapCalls, 1);
});


test("legacy MiMo fixture transport refuses redirects rather than leaving loopback", async () => {
  redirectChat = true;
  try {
    const result = await sendChat(store.provider(pid)!, undefined, { model: "mimo-auto", messages: [{ role: "user", content: "fixture" }], stream: false }, new AbortController().signal);
    assert.ok(result instanceof Error, "redirect:error blocks even the legacy sender");
  } finally { redirectChat = false; }
});
