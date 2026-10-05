import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { importFromOpencodex, opencodexCandidates } from "../src/opencodex-import.ts";
import { createSecretStore } from "../src/secrets.ts";
import { Store } from "../src/store.ts";
import type { Provider } from "../src/types.ts";

function configFixture(dir: string): string {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    providers: {
      ark: { adapter: "openai-chat", baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3", authMode: "key", apiKey: "sk-ark-secret-0001", models: ["ark-code-latest", "glm-5.3"], defaultModel: "ark-code-latest" },
      tx: { adapter: "openai-chat", baseUrl: "https://copilot.tencent.com/v2/chat/completions", apiKeyPool: [{ id: "aaa", key: "sk-tx-one-0002", label: "main" }, { id: "bbb", key: "sk-tx-two-0003", label: "spare" }], models: ["auto", "hy3"] },
      openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" },
      broken: { adapter: "openai-chat", baseUrl: "https://x.example.com/v1", authMode: "key" },
    },
    providers_meta: { ark: { name: "火山方舟" } },
  }));
  return file;
}

test("candidates list what can be imported and say why the rest cannot", () => {
  const dir = mkdtempSync(join(tmpdir(), "es-ocx-"));
  const file = configFixture(dir);
  const all = opencodexCandidates(file);
  const ark = all.find(c => c.sourceId === "ark")!;
  assert.equal(ark.name, "火山方舟");
  assert.equal(ark.keys, 1);
  assert.equal(ark.skipReason, undefined);
  const tx = all.find(c => c.sourceId === "tx")!;
  assert.equal(tx.baseUrl, "https://copilot.tencent.com/v2"); // only the endpoint file is stripped
  assert.equal(tx.keys, 2);
  assert.match(all.find(c => c.sourceId === "openai")!.skipReason ?? "", /透传/);
  assert.equal(all.find(c => c.sourceId === "broken")!.skipReason, "没有 Key");
});

test("import moves keys into the secret store and never into state; models come along", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-ocx2-"));
  const file = configFixture(dir);
  const store = new Store(mkdtempSync(join(tmpdir(), "es-ocx-store-")));
  const secrets = createSecretStore();
  const result = await importFromOpencodex(["ark", "tx"], file, store, secrets, async () => ({ models: ["live-model"] }));
  assert.deepEqual(result.failed, []);
  const ark = store.provider("ark")!;
  assert.equal(ark.name, "火山方舟");
  assert.deepEqual(ark.models, ["live-model"]); // refreshed by the probe
  assert.equal(await secrets.get("ark"), "sk-ark-secret-0001");
  assert.equal(await secrets.get("tx#aaa"), "sk-tx-one-0002");
  assert.equal(await secrets.get("tx#bbb"), "sk-tx-two-0003");
  // The provider rows carry no secrets at all.
  for (const p of store.providers()) {
    assert.equal(JSON.stringify(p).includes("sk-"), false, `secret leaked in state for ${p.id}`);
  }
  assert.equal((result.imported.find(i => i.sourceId === "tx")!).keys, 2);
});

test("a missing candidate fails cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-ocx3-"));
  const file = configFixture(dir);
  const store = new Store(mkdtempSync(join(tmpdir(), "es-ocx3-store-")));
  const result = await importFromOpencodex(["nope"], file, store, createSecretStore(), async () => ({ models: [] }));
  assert.deepEqual(result.imported, []);
  assert.match(result.failed[0]!.reason, /没有这一项/);
});

test("an anthropic adapter sets the anthropic base url for Claude Code", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-ocx4-"));
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ providers: { dev: { adapter: "anthropic", baseUrl: "https://ezr.sh/v1", apiKey: "sk-dev-0004" } } }));
  const store = new Store(mkdtempSync(join(tmpdir(), "es-ocx4-store-")));
  const result = await importFromOpencodex(["dev"], file, store, createSecretStore(), async (provider: Provider) => ({ models: provider.models }));
  assert.equal(result.failed.length, 0);
  assert.equal(store.provider("dev")!.anthropicBaseUrl, "https://ezr.sh/v1");
});
