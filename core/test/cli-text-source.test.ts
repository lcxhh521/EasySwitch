import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { sendChat } from "../src/upstream-chat.ts";
import { prepareOutbound, sourceProtocols } from "../src/outbound.ts";
import type { Provider } from "../src/types.ts";
import type { QoderProcessInput } from "../src/qoder-text-bridge.ts";
import type { CliTextBinaryInspector } from "../src/cli-text-process.ts";

async function call(base: string, path: string, method = "GET", body?: unknown, token?: string) {
  return new Promise<{ status: number; text: string; body: any }>((resolve, reject) => {
    const req = request(new URL(path, base), { method, headers: { "x-easyswitch": "1", "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, res => {
      let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => { let body; try { body = JSON.parse(text); } catch { body = text; } resolve({ status: res.statusCode!, text, body }); });
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(t: { after(fn: () => Promise<void>): void }, inspect: CliTextBinaryInspector = async binary => ({ realPath: binary, isFile: true, mode: 0o755, executable: true })) {
  const dir = mkdtempSync(join(tmpdir(), "es-cli-source-")); const store = new Store(dir);
  const values = new Map<string, string>(); const secretCalls: string[] = []; const jobs: QoderProcessInput[] = [];
  const auth = new GatewayTokenAuthority();
  const server: Server = createEasySwitchServer({ store, port: 0, gatewayAuth: auth, cliTextBinaryInspector: inspect,
    secrets: { async get(id) { secretCalls.push("get:" + id); return values.get(id); }, async set(id, value) { secretCalls.push("set:" + id); values.set(id, value); }, async delete(id) { secretCalls.push("delete:" + id); values.delete(id); } },
    qoderExecutor: async job => { jobs.push(job); return { exitCode: 0, stdout: "fixture text answer" }; },
    codeBuddyExecutor: async job => { jobs.push(job); return { exitCode: 0, stdout: "fixture CodeBuddy answer" }; },
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });
  return { base, store, values, secretCalls, jobs, token: auth.issue("fixture-text-client").token };
}
const config = { kind: "qoder", name: "Qoder fixture", binary: "/fixture/not-executed/qodercli", model: "fixture-model", apiKey: "fixture-pat-private", experimental: true };
const bodies = (model: string) => [
  ["/v1/chat/completions", { model, messages: [{ role: "user", content: "hello" }] }],
  ["/v1/responses", { model, input: "hello" }],
  ["/v1/messages", { model, messages: [{ role: "user", content: "hello" }], max_tokens: 30 }],
  [`/v1beta/models/${encodeURIComponent(model)}:generateContent`, { contents: [{ role: "user", parts: [{ text: "hello" }] }] }],
] as const;

test("explicit Qoder creation is default-off and never probes, discovers models, runs a CLI or exposes PAT", async t => {
  const f = await fixture(t);
  const created = await call(f.base, "/api/cli-text-sources", "POST", config);
  assert.equal(created.status, 201, created.text); const id = created.body.id;
  assert.equal(created.body.off, true); assert.equal(created.body.baseUrl, "cli://qoder");
  assert.deepEqual(created.body.models, ["fixture-model"]); assert.deepEqual(created.body.supportedProtocols, ["chat"]);
  assert.doesNotMatch(created.text, /fixture-pat-private/);
  assert.deepEqual(f.secretCalls, ["set:" + id]); assert.equal(f.jobs.length, 0);
  assert.equal(f.store.catalog().length, 0);
  for (const [path, body] of bodies(id + "/fixture-model")) assert.equal((await call(f.base, path, "POST", body, f.token)).status, 404);
  assert.deepEqual(f.secretCalls, ["set:" + id]); assert.equal(f.jobs.length, 0);
  assert.equal((await call(f.base, `/api/providers/${id}/switch`, "PUT", { on: true })).status, 200);
  assert.equal(f.jobs.length, 0, "enabling alone never calls the vendor");
  assert.equal(f.store.catalog().length, 1);
  for (const [path, body] of bodies(id + "/fixture-model")) {
    const answer = await call(f.base, path, "POST", body, f.token);
    assert.equal(answer.status, 200, answer.text); assert.match(answer.text, /fixture text answer/);
  }
  assert.equal(f.jobs.length, 4);
  assert.ok(f.jobs.every(job => job.env.QODER_PERSONAL_ACCESS_TOKEN === config.apiKey && !JSON.stringify(job.args).includes(config.apiKey)));
  const state = await call(f.base, "/api/state");
  assert.doesNotMatch(state.text, /fixture-pat-private/);
  assert.ok(state.body.log.every((entry: any) => entry.adapter === "qoder-cli-text" && entry.costNote === "subscription" && entry.inputTokens === undefined));
  assert.equal((await call(f.base, `/api/providers/${id}/switch`, "PUT", { on: false })).status, 200);
  assert.equal(f.store.catalog().length, 0);
});

test("Qoder rich input and generic probe/config endpoints fail before execution or secret lookup", async t => {
  const f = await fixture(t); const made = await call(f.base, "/api/cli-text-sources", "POST", config); const id = made.body.id;
  await call(f.base, `/api/providers/${id}/switch`, "PUT", { on: true }); const before = f.secretCalls.length;
  const unsupported = await call(f.base, "/v1/chat/completions", "POST", { model: id + "/fixture-model", messages: [{ role: "user", content: "hello" }], tools: [{ type: "function", function: { name: "run", parameters: {} } }] }, f.token);
  assert.equal(unsupported.status, 400); assert.equal(f.secretCalls.length, before); assert.equal(f.jobs.length, 0);
  for (const [action, method, body] of [["probe", "POST", { model: "fixture-model" }], ["protocols", "PUT", { protocols: ["responses"] }]] as const) assert.equal((await call(f.base, `/api/providers/${id}/${action}`, method, body)).status, 409);
  assert.equal(f.secretCalls.length, before); assert.equal(f.jobs.length, 0);
});

test("invalid or mixed creation and Droid production remain failclosed with zero side effects", async t => {
  const f = await fixture(t);
  for (const body of [{ ...config, binary: "qodercli" }, { ...config, model: "--unsafe" }, { ...config, apiKey: "" }, { ...config, plan: {} }, { ...config, env: {} }]) assert.equal((await call(f.base, "/api/cli-text-sources", "POST", body)).status, 400);
  assert.equal((await call(f.base, "/api/cli-text-sources", "POST", { ...config, experimental: false })).status, 409);
  assert.equal((await call(f.base, "/api/cli-text-sources", "POST", { kind: "droid", apiKey: "must-not-save" })).status, 501);
  assert.equal((await call(f.base, "/api/providers", "POST", { name: "Bypass", baseUrl: "https://example.invalid/v1", apiKey: "must-not-save", cliTextBridge: { kind: "qoder", binary: "/fixture" } })).status, 400);
  assert.deepEqual(f.secretCalls, []); assert.equal(f.store.providers().length, 0); assert.equal(f.jobs.length, 0);
  const status = await call(f.base, "/api/cli-text-sources"); assert.equal(status.body.droid.status, 501);
  const p: Provider = { id: "droid", name: "Blocked Droid", baseUrl: "cli://droid", models: ["m"], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "", cliTextBridge: { kind: "droid" } };
  f.store.upsertProvider(p); assert.equal(f.store.catalog().length, 0); assert.deepEqual(sourceProtocols(p, "m"), []);
  assert.equal((await call(f.base, "/api/providers/droid/switch", "PUT", { on: true })).status, 501);
  const result = await call(f.base, "/v1/chat/completions", "POST", { model: "droid/m", messages: [{ role: "user", content: "hello" }] }, f.token);
  assert.equal(result.status, 501); assert.deepEqual(f.secretCalls, []);
  assert.throws(() => prepareOutbound({ ...p, cliTextBridge: { kind: "qoder", binary: "/fixture" }, plan: { kind: "codex", accountId: "forbidden" } }, { protocol: "chat", model: "m", stream: false, body: { messages: [{ role: "user", content: "hello" }] } }), /混用/);
});


test("legacy Chat sender cannot silently treat a CLI source as an HTTP source", async t => {
  let fetched = false; t.mock.method(globalThis, "fetch", async () => { fetched = true; throw new Error("must not fetch"); });
  const p: Provider = { id: "q", name: "Q", baseUrl: "https://untrusted.invalid/v1", models: ["m"], route: "chat-translate", routePinned: true, streamUsage: false, createdAt: "", cliTextBridge: { kind: "qoder", binary: "/fixture/qoder" } };
  const result = await sendChat(p, "fake-pat", { messages: [{ role: "user", content: "x" }] }, new AbortController().signal);
  assert.ok(result instanceof Error); assert.equal(fetched, false);
});


test("CodeBuddy region-bound text sources remain off until switched and use the dedicated executor for four protocols", async t => {
  const f = await fixture(t);
  for (const edition of ["international", "china"] as const) {
    const startJobs = f.jobs.length;
    const made = await call(f.base, "/api/cli-text-sources", "POST", { ...config, kind: "codebuddy", binary: "/fixture/codebuddy", name: "CodeBuddy " + edition, edition });
    assert.equal(made.status, 201, made.text); const id = made.body.id;
    assert.equal(made.body.off, true); assert.equal(made.body.baseUrl, "cli://codebuddy");
    assert.equal(made.body.cliTextBridge.edition, edition); assert.deepEqual(made.body.supportedProtocols, ["chat"]);
    assert.doesNotMatch(made.text, /fixture-pat-private/); assert.equal(f.jobs.length, startJobs);
    const [firstPath, firstBody] = bodies(id + "/fixture-model")[0];
    assert.equal((await call(f.base, firstPath, "POST", firstBody, f.token)).status, 404);
    assert.equal((await call(f.base, `/api/providers/${id}/switch`, "PUT", { on: true })).status, 200);
    assert.equal(f.jobs.length, startJobs, "switching does not execute a CLI");
    for (const [path, body] of bodies(id + "/fixture-model")) {
      const answer = await call(f.base, path, "POST", body, f.token);
      assert.equal(answer.status, 200, answer.text); assert.match(answer.text, /fixture CodeBuddy answer/);
    }
    const jobs = f.jobs.slice(startJobs); assert.equal(jobs.length, 4);
    for (const job of jobs) {
      assert.equal(job.env.CODEBUDDY_API_KEY, config.apiKey);
      assert.equal(job.env.CODEBUDDY_INTERNET_ENVIRONMENT, edition === "china" ? "internal" : undefined);
      assert.equal(job.env.CODEBUDDY_BASE_URL, undefined); assert.equal(job.env.CODEBUDDY_AUTH_TOKEN, undefined);
      assert.equal(job.env.ANTHROPIC_BASE_URL, undefined); assert.equal(job.env.QODER_PERSONAL_ACCESS_TOKEN, undefined);
      assert.ok(!JSON.stringify(job.args).includes(config.apiKey));
    }
    const before = f.secretCalls.length;
    assert.equal((await call(f.base, `/api/providers/${id}/probe`, "POST", {})).status, 409);
    assert.equal(f.secretCalls.length, before); assert.equal(f.jobs.length, startJobs + 4);
    assert.equal((await call(f.base, `/api/providers/${id}/switch`, "PUT", { on: false })).status, 200);
  }
  assert.equal(f.store.catalog().length, 0);
  const state = await call(f.base, "/api/state"); assert.doesNotMatch(state.text, /fixture-pat-private/);
  assert.ok(state.body.log.filter((entry: any) => entry.adapter).every((entry: any) => entry.adapter === "codebuddy-cli-text" && entry.costNote === "subscription" && entry.inputTokens === undefined));
});

test("CodeBuddy creation rejects absent or invented regions and source auth overrides before side effects", async t => {
  const f = await fixture(t);
  for (const override of [{}, { edition: "enterprise" }, { edition: "china", baseUrl: "http://127.0.0.1:123/v1" }, { edition: "international", env: {} }, { edition: "china", plan: {} }]) {
    assert.equal((await call(f.base, "/api/cli-text-sources", "POST", { ...config, kind: "codebuddy", ...override })).status, 400);
  }
  assert.equal((await call(f.base, "/api/cli-text-sources", "POST", { ...config, edition: "china" })).status, 400, "Qoder does not accept a CodeBuddy region");
  assert.deepEqual(f.secretCalls, []); assert.equal(f.jobs.length, 0); assert.equal(f.store.providers().length, 0);
});


test("CLI source creation checks read-only executable metadata before storing credentials", async t => {
  for (const mode of ["missing", "not-file", "not-executable", "world-writable"] as const) {
    let inspections = 0;
    const f = await fixture(t, async binary => { inspections++; if (mode === "missing") throw new Error("fixture absence"); return { realPath: binary, isFile: mode !== "not-file", mode: mode === "world-writable" ? 0o777 : 0o755, executable: mode !== "not-executable" }; });
    const response = await call(f.base, "/api/cli-text-sources", "POST", config);
    assert.equal(response.status, 400, mode); assert.equal(inspections, 1);
    assert.deepEqual(f.secretCalls, []); assert.equal(f.store.providers().length, 0); assert.equal(f.jobs.length, 0);
  }
});
