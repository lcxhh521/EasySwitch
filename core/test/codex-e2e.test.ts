/**
 * End to end with the real Codex binary: Codex -> EasySwitch gateway (Responses)
 * -> strict chat-only mock relay. The relay asks Codex to run a shell command;
 * Codex runs it and sends the output back; the relay answers from it. Passing
 * means tool calls survived the round trip in both directions.
 *
 * Codex runs with a throwaway CODEX_HOME, and the user's real
 * ~/.codex/config.toml is fingerprinted before and after.
 */
import { sessionToken } from "../src/gateway-chat.ts";
import { withoutProjectPaths } from "../src/native.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { writeCodexCatalog } from "../src/catalog.ts";
import { codexArgs, findCodex, SESSION_MARKER } from "../src/launch.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { SHELL_MARKER, startMockRelay } from "./mock-relay.ts";

type Json = Record<string, unknown>;
const run = promisify(execFile);
process.env.EASYSWITCH_SECRETS = "memory";

function freePort(): Promise<number> {
  return new Promise(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function realCodexConfigHash(): string {
  try {
    return createHash("sha256").update(readFileSync(join(homedir(), ".codex", "config.toml"))).digest("hex");
  } catch {
    return "absent";
  }
}

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let store: Store;
let server: Server;
let port: number;
let base: string;
const hashBefore = realCodexConfigHash();

async function api(method: string, path: string, body?: Json): Promise<{ status: number; json: Json }> {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-easyswitch": "1" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

before(async () => {
  relay = await startMockRelay(0, { apiKey: "test-key" });
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  store = new Store(mkdtempSync(join(tmpdir(), "es-home-")));
  server = createEasySwitchServer({ store, secrets: createSecretStore(), port, gatewayAuth: true });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", resolve));
});

after(() => {
  server.close();
  relay.server.close();
});

test("adding a relay lists its models and keeps the key out of state", async () => {
  const { status, json } = await api("POST", "/api/providers", { name: "Mock Relay", baseUrl: relay.baseUrl, apiKey: "test-key" });
  assert.equal(status, 201);
  assert.equal(json.id, "mock-relay");
  assert.deepEqual(json.models, ["mock-coder", "mock-mini"]);
  assert.equal(json.hasKey, true);
  assert.equal(JSON.stringify(json).includes("test-key"), false);
});

test("the probe grades a chat-only relay and routes it through translation", async () => {
  const { json } = await api("POST", "/api/providers/mock-relay/probe", { model: "mock-coder" });
  const checks = Object.fromEntries(((json.probe as Json).checks as Json[]).map(c => [c.id, c.status]));
  assert.deepEqual(checks, { models: "pass", chat: "pass", "chat-stream": "pass", tools: "pass", responses: "fail", messages: "fail" });
  assert.equal(json.route, "chat-translate");
  assert.equal(json.streamUsage, true);
});

test("the management API refuses requests without the local header", async () => {
  const response = await fetch(`${base}/api/providers/mock-relay`, { method: "DELETE" });
  assert.equal(response.status, 403);
});

test("a binding yields a Codex command that touches nothing but this one process", async () => {
  await api("PUT", "/api/bindings/codex", { providerId: "mock-relay", model: "mock-coder" });
  const { json } = await api("GET", "/api/launch/codex");
  assert.equal(json.model, "mock-relay/mock-coder");
  assert.match(String(json.command), new RegExp(SESSION_MARKER.replace(".", "\\.")));
  if (await findCodex()) assert.ok(String(json.command).includes(join(store.dir, "codex-catalog.json")), "the catalog lives in EasySwitch's own data dir");
});

test("Codex's own model list in an augmented session is every EasySwitch model", async t => {
  const codex = await findCodex();
  if (!codex) {
    t.skip("codex not installed");
    return;
  }
  const catalog = await writeCodexCatalog(codex, store.dir, store.providers());
  assert.ok(catalog, "a catalog was generated from the installed Codex");
  const codexHome = mkdtempSync(join(tmpdir(), "es-codex-home-"));
  // `codex debug models` renders the catalog the /model menu is built from.
  const configOnly = codexArgs(port, "mock-relay/mock-coder", catalog).slice(0, -2); // `debug models` takes no -m
  const { stdout } = await run(codex, ["debug", "models", ...configOnly],
    { cwd: codexHome, env: { ...process.env, HOME: codexHome, CODEX_HOME: codexHome, OPENAI_API_KEY: "" }, timeout: 60_000 });
  const listed = ((JSON.parse(stdout) as Json).models as Json[]).filter(m => m.visibility === "list").map(m => m.slug);
  assert.deepEqual(listed, ["mock-relay/mock-coder", "mock-relay/mock-mini"]);
});

test("the real Codex binary completes a tool round trip through the gateway", async t => {
  const codex = await findCodex();
  if (!codex) {
    t.skip("codex not installed");
    return;
  }
  const codexHome = mkdtempSync(join(tmpdir(), "es-codex-home-"));
  const work = mkdtempSync(join(tmpdir(), "es-work-"));
  const before = relay.requests.length;
  // A throwaway HOME as well as CODEX_HOME: even a helper that ignored
  // CODEX_HOME could not reach the user's real files from here.
  // With the catalog, as a real launch has it: the round trip must survive the swapped model metadata.
  const catalog = await writeCodexCatalog(codex, store.dir, store.providers());
  const pending = run(codex, [
    "exec", "--skip-git-repo-check",
    // As a real launch has it: with the launch's own token, which the gateway requires.
    ...codexArgs(port, "mock-relay/mock-coder", catalog, undefined, sessionToken("codex")),
    "Run the shell command you are given and report what it printed.",
  ], { cwd: work, env: { ...process.env, HOME: codexHome, CODEX_HOME: codexHome, OPENAI_API_KEY: "" }, timeout: 120_000 });
  // `codex exec` waits for more prompt text on an open stdin pipe.
  pending.child.stdin?.end();
  const result = await pending
    .catch((error: { stdout?: string; stderr?: string; message: string }) => {
      throw new Error(`codex exec failed: ${error.message}\n--- stdout\n${error.stdout ?? ""}\n--- stderr\n${(error.stderr ?? "").slice(-3000)}`);
    });
  const stdout = result.stdout;

  assert.match(stdout, new RegExp(SHELL_MARKER));
  const turns = relay.requests.slice(before);
  assert.ok(turns.length >= 2, "expected a tool call turn and a follow-up turn");
  const followUp = turns.at(-1) as Json;
  const toolMessage = (followUp.messages as Json[]).find(m => m.role === "tool");
  assert.ok(String(toolMessage?.content).includes(SHELL_MARKER), "the command output came back as a tool message");
});

test("EasySwitch leaves no trace in the user's real Codex config", t => {
  // Other writers (the ChatGPT app shares ~/.codex) may change the file while
  // tests run, so the claim checked here is ours alone: nothing of EasySwitch
  // ever lands in it. A changed hash is reported, not failed on.
  const real = join(homedir(), ".codex", "config.toml");
  let text = "";
  try { text = readFileSync(real, "utf8"); } catch { /* no config at all is clean too */ }
  // A `[projects."<path>"]` header is Codex remembering a folder the user trusts (their own checkout of
  // this project has our name in its path); it is not something EasySwitch wrote.
  assert.equal(/easyswitch|es-codex-home|es-work-/i.test(withoutProjectPaths(text)), false);
  if (realCodexConfigHash() !== hashBefore) t.diagnostic("~/.codex/config.toml changed during the run (not by EasySwitch: no trace above)");
});
