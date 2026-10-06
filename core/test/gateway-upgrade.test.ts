import assert from "node:assert/strict";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { handleChatgptUpgrade } from "../src/chatgpt-gateway.ts";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";

const listen = async (s: Server) => { await new Promise<void>(r => s.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${(s.address() as { port: number }).port}`; };
test("native WebSocket handshake helper strips local capabilities when called by a fixture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-upgrade-auth-"));
  const seen: IncomingHttpHeaders[] = [];
  const upstream = createServer();
  upstream.on("upgrade", (req, socket) => {
    seen.push(req.headers);
    socket.on("error", () => {});
    socket.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
  });
  const remote = await listen(upstream);
  const previous = process.env.EASYSWITCH_CHATGPT_UPSTREAM;
  process.env.EASYSWITCH_CHATGPT_UPSTREAM = remote + "/backend-api/codex";
  const auth = new GatewayTokenAuthority(); const local = auth.issue("codex");
  const gateway = createServer();
  gateway.on("upgrade", (req, socket, head) => handleChatgptUpgrade(req, socket as import("node:net").Socket, head));
  const base = await listen(gateway);
  try {
    for (const header of ["authorization", "x-api-key", "x-goog-api-key"] as const) {
      await new Promise<void>((resolve, reject) => {
        const req = request(base + "/backend-api/codex/responses", { headers: {
          connection: "Upgrade", upgrade: "websocket", "x-easyswitch-session": local.token, "x-easyswitch-depth": "0",
          authorization: "Bearer fake-vendor-login", [header]: header === "authorization" ? `Bearer ${local.token}` : local.token,
        } });
        req.on("error", reject); req.on("upgrade", (_res, socket) => { socket.destroy(); resolve(); }); req.end();
      });
      const sent = seen.at(-1)!;
      assert.equal(sent["x-easyswitch-session"], undefined); assert.equal(sent["x-easyswitch-depth"], undefined);
      assert.equal(sent[header], undefined); assert.ok(!JSON.stringify(sent).includes(local.token));
      if (header !== "authorization") assert.equal(sent.authorization, "Bearer fake-vendor-login");
      assert.equal(sent.upgrade, "websocket");
    }
  } finally {
    gateway.closeAllConnections(); upstream.closeAllConnections(); gateway.close(); upstream.close();
    if (previous === undefined) delete process.env.EASYSWITCH_CHATGPT_UPSTREAM; else process.env.EASYSWITCH_CHATGPT_UPSTREAM = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

