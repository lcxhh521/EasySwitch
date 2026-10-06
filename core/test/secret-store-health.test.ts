import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { createSecretStore, type SecretStoreHealth } from "../src/secrets.ts";

for (const status of ["helper_missing", "helper_signature_invalid", "no_default_keychain"] as const) test(`/health reports ${status} without reading any credential or invoking a helper`, async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-health-")); let reads = 0;
  const health: SecretStoreHealth = { backend: "native-keychain", ready: false, status, keychainChecked: false };
  const server = createEasySwitchServer({ store: new Store(dir), port: 0, secrets: { health: () => health, async get() { reads++; throw new Error("must not read key"); }, async set() { assert.fail("must not write key"); }, async delete() { assert.fail("must not delete key"); } } });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try {
    const value = await new Promise<any>((resolve, reject) => { const req = request(`http://127.0.0.1:${(server.address() as { port: number }).port}/health`, res => { let text = ""; res.on("data", d => text += d); res.on("end", () => resolve(JSON.parse(text))); }); req.on("error", reject); req.end(); });
    assert.equal(value.ok, true); assert.deepEqual(value.secretStore, health); assert.equal(reads, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
});

test("explicit memory storage reports readiness without pretending to have checked macOS Keychain", () => {
  assert.deepEqual(createSecretStore().health?.(), { backend: "memory", ready: true, status: "ready", keychainChecked: false });
});
