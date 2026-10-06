import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, realpathSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

async function http(base: string, path: string, method = "GET", header = true, body?: unknown) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => { const req = request(base + path, { method, headers: header ? { "x-easyswitch": "1" } : {} }, res => { let text = ""; res.on("data", d => text += d); res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) })); }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body)); });
}
test("console model listing needs the local header and command-only issuance returns an owned revocable session", async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-command-api-")); const store = new Store(dir); store.setSettings({ claudeNative: false });
  store.upsertProvider({ id: "p", name: "P", baseUrl: "http://127.0.0.1:1", models: ["m"], route: "chat-translate", routePinned: true, protocols: ["chat"], streamUsage: false, createdAt: "" });
  const auth = new GatewayTokenAuthority(); let terminalCalls = 0, keyReads = 0;
  const server = createEasySwitchServer({ store, port: 0, gatewayAuth: auth, secrets: { async get() { keyReads++; throw new Error("must not read keys"); }, async set() {}, async delete() {} }, interactiveRuntime: { findBinary: async () => "/fixture/never-run-hermes", newSessionDir: () => mkdtempSync(join(dir, "session-")), launchInTerminal: async () => { terminalCalls++; assert.fail("command inspection must not open a terminal"); } } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    assert.equal((await http(base, "/api/models", "GET", false)).status, 403);
    assert.equal((await http(base, "/v1/models", "GET", false)).status, 401);
    const models = await http(base, "/api/models"); assert.equal(models.status, 200); assert.ok(models.body.data.some((m: any) => m.id === "p/m")); assert.equal(auth.list().length, 0);
    const command = await http(base, "/api/agents/hermes/command", "POST", true, { model: "p/m" });
    assert.equal(command.status, 200); assert.equal(command.body.command, "/fixture/never-run-hermes"); assert.ok(Array.isArray(command.body.args));
    assert.equal(command.body.session.id, auth.list()[0]!.id); assert.equal(command.body.session.expiresAt, auth.list()[0]!.expiresAt);
    assert.ok(existsSync(command.body.sessionDir)); assert.equal(terminalCalls, 0); assert.equal(keyReads, 0);
    assert.equal((await http(base, `/api/gateway/sessions/${command.body.session.id}`, "DELETE")).status, 200); assert.equal(auth.list().length, 0);
    rmSync(command.body.sessionDir, { recursive: true, force: true });
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});
