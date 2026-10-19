import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { createEasySwitchServer } from "../src/server.ts";

test("retired dispatch endpoints never run work or touch retained history, even with old settings and tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "es-dispatch-retired-"));
  const state = { version: 1, providers: [], bindings: [], settings: { claudeNative: false, agentCalls: true }, rules: [{ id: "r-old", enabled: true, then: { agent: "claude" } }] };
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  const history = {
    "tasks.jsonl": '{"id":"t-old","status":"running","task":"keep this history"}\n',
    "feedback.jsonl": '{"taskId":"t-old","rating":"good"}\n',
    "task-accounting.json": '{"pending":true,"privateHistoricalField":"unchanged"}',
    "task-accounting.pending.json": 'retained pending marker',
    "task-accounting.failed.json": 'retained failed marker',
  };
  for (const [name, bytes] of Object.entries(history)) writeFileSync(join(dir, name), bytes);
  const store = new Store(dir), auth = new GatewayTokenAuthority();
  const old = auth.issue("claude", { allowMcp: true });
  const never = (): never => assert.fail("retired dispatch must not access credentials, discover clients or execute programs");
  const server = createEasySwitchServer({ store, gatewayAuth: auth, port: 0,
    secrets: { get: async () => never(), set: async () => never(), delete: async () => never() },
    interactiveRuntime: { findBinary: async () => never(), newSessionDir: never, launchInTerminal: async () => never() },
    sourceHealth: { fetch: async () => never() },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const api = (path: string, method = "GET", body?: unknown) => fetch(base + path, { method,
    headers: { "x-easyswitch": "1", "content-type": "application/json", authorization: `Bearer ${old.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const beforeState = readFileSync(join(dir, "state.json"), "utf8");
    const snapshot = await (await api("/api/state")).json() as any;
    assert.equal(Object.hasOwn(snapshot, "rules"), false);
    assert.equal(Object.hasOwn(snapshot.settings, "agentCalls"), false);
    for (const path of ["/api/tasks", "/api/tasks/t-old/stop", "/api/tasks/t-old/feedback", "/api/task-groups", "/api/task-groups/old/review/t-old", "/api/rules", "/api/rules/test", "/api/rules/suggestions", "/mcp"]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const response = await api(path, method, method === "GET" ? undefined : { agent: "auto", task: "must not run" });
        assert.equal(response.status, 404, `${method} ${path} remains removed`);
      }
    }
    assert.equal(readFileSync(join(dir, "state.json"), "utf8"), beforeState);
    const settings = await (await api("/api/settings", "PUT", { claudeNative: true, agentCalls: true })).json() as any;
    assert.deepEqual(settings, { claudeNative: true });
    const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    assert.deepEqual(saved.rules, state.rules); assert.equal(saved.settings.agentCalls, true, "legacy field retained inertly");
    const issueResponse = await api("/api/gateway/sessions", "POST", { agentId: "claude", allowMcp: true });
    assert.equal(issueResponse.status, 201);
    const issued = await issueResponse.json() as any;
    assert.equal(typeof issued.token, "string"); assert.equal(issued.allowMcp, false);
    assert.equal(auth.authenticate({ authorization: `Bearer ${issued.token}` }, undefined, "mcp"), undefined);
    assert.equal((await api("/api/pools/suggestions")).status, 200);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [name, bytes] of Object.entries(history)) assert.equal(readFileSync(join(dir, name), "utf8"), bytes);
    assert.deepEqual(readdirSync(dir).filter(name => /^(tasks|feedback|task-accounting)/.test(name)).sort(), Object.keys(history).sort());
    rmSync(dir, { recursive: true, force: true });
  }
});
