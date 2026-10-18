/** Known-gap reproduction, outside the normal test glob. Synthetic loopback only.
 * Run: node --test --test-force-exit research/opaque-continuation-fallback.repro.ts
 * TODO failures are intentional: the desired one-account invariant is not implemented.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { Store } from "../core/src/store.ts";
import { createSecretStore } from "../core/src/secrets.ts";
import { createEasySwitchServer } from "../core/src/server.ts";
import { keySecretId } from "../core/src/keypool.ts";
import { fixtureFetch } from "../core/test/gateway-client.ts";
import type { Json } from "../core/src/protocol.ts";
process.env.EASYSWITCH_SECRETS = "memory";
const listen = async (server: Server) => { await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return "http://127.0.0.1:" + (server.address() as { port: number }).port; };
const histories = {
  compaction: { input: [{ type: "compaction", encrypted_content: "synthetic-account-a-bound-compaction" }] },
  previous_response_id: { input: "continue", previous_response_id: "resp_synthetic_a" },
  conversation: { input: "continue", conversation: "conv_synthetic_a" },
};
for (const mode of ["key", "pool"] as const) for (const [kind, history] of Object.entries(histories)) {
  test(`${kind} must not cross accounts during ${mode} fallback`, { todo: "Known gap: opaque continuation has no account-affinity or no-retry guard" }, async () => {
    const dir = mkdtempSync("/tmp/es-continuation-proof-"); const store = new Store(dir); const secrets = createSecretStore();
    const seen: Array<{ key: string | undefined; body: Json }> = [];
    const upstream = createServer(async (req, res) => {
      let raw = ""; for await (const chunk of req) raw += chunk;
      seen.push({ key: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(seen.length === 1 ? 401 : 200, { "content-type": "application/json" }).end("{}");
    });
    let gateway: Server | undefined;
    try {
      const baseUrl = await listen(upstream);
      const provider = { id: "p", name: "P", baseUrl, models: ["m"], protocols: ["responses" as const], route: "responses-native" as const, routePinned: true, streamUsage: false, createdAt: "" };
      if (mode === "key") {
        store.upsertProvider({ ...provider, keys: ["a", "b"].map(id => ({ id, label: id, enabled: true, addedAt: "" })) });
        await secrets.set(keySecretId("p", "a"), "fake-account-a"); await secrets.set(keySecretId("p", "b"), "fake-account-b");
      } else {
        store.upsertProvider(provider); store.upsertProvider({ ...provider, id: "q" });
        await secrets.set("p", "fake-account-a"); await secrets.set("q", "fake-account-b");
        store.upsertPool({ id: "proof", name: "Proof", strategy: "order", members: ["p/m", "q/m"], createdAt: "" });
      }
      gateway = createEasySwitchServer({ store, secrets, port: 0 }); const origin = await listen(gateway);
      const response = await fixtureFetch(origin + "/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: mode === "key" ? "p/m" : "pool/proof", ...history }) });
      await response.text();
      assert.deepEqual(seen.map(s => s.key), ["Bearer fake-account-a"], "Opaque history must not be retried with the second account");
    } finally {
      for (const server of [upstream, gateway]) if (server) { server.closeAllConnections(); server.close(); }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
