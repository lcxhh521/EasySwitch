import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chooseRule, describeWhen, matchingRules, parseRule, ruleMatches, type DispatchRule } from "../src/dispatch.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { startMockRelay } from "./mock-relay.ts";

process.env.EASYSWITCH_SECRETS = "memory";
type Json = Record<string, any>;

const rule = (over: Partial<DispatchRule> & { when?: DispatchRule["when"] }): DispatchRule => ({ id: "r-1", name: "r", enabled: true, when: {}, then: { agent: "claude" }, ...over });
const facts = (task: string, extra: Partial<{ cwd: string; from: string }> = {}) => ({ task, from: "console", ...extra });

test("a rule holds only when every condition it names holds", () => {
  const r = rule({ when: { anyWords: ["测试", "pytest"], minChars: 10, cwdPrefix: "/work/app", from: "console" } });
  assert.equal(ruleMatches(r, facts("写个 pytest 用例", { cwd: "/work/app/api" })), true);
  assert.equal(ruleMatches(r, facts("写个 PYTEST 用例", { cwd: "/work/app" })), true, "words ignore case");
  assert.equal(ruleMatches(r, facts("写个 pytest 用例", { cwd: "/other" })), false, "wrong folder");
  assert.equal(ruleMatches(r, facts("pytest", { cwd: "/work/app" })), false, "too short");
  assert.equal(ruleMatches(r, facts("改个文案", { cwd: "/work/app" })), false, "no word");
  assert.equal(ruleMatches(r, facts("写个 pytest 用例", { cwd: "/work/app", from: "claude" })), false, "someone else handed it over");
});

test("a rule with no condition catches everything; a regex needs to match; a broken one catches nothing", () => {
  assert.equal(ruleMatches(rule({}), facts("anything")), true);
  assert.equal(ruleMatches(rule({ when: { regex: "^fix\\s+#\\d+" } }), facts("Fix #12 crash")), true);
  assert.equal(ruleMatches(rule({ when: { regex: "^fix" } }), facts("write docs")), false);
  assert.equal(ruleMatches(rule({ when: { regex: "([" } }), facts("anything")), false, "an unreadable rule must not catch everything");
  assert.equal(ruleMatches(rule({ when: { maxChars: 10 } }), facts("this is a rather long task")), false);
});

test("the first enabled matching rule wins, in the order given; disabled rules are skipped", () => {
  const rules = [
    rule({ id: "r-a", name: "off", enabled: false, then: { agent: "codex" } }),
    rule({ id: "r-b", name: "tests", when: { anyWords: ["test"] }, then: { agent: "claude", effort: "high" } }),
    rule({ id: "r-c", name: "rest", then: { agent: "hermes" } }),
  ];
  assert.equal(chooseRule(rules, facts("add a test"))!.id, "r-b");
  assert.equal(chooseRule(rules, facts("rename things"))!.id, "r-c");
  assert.deepEqual(matchingRules(rules, facts("add a test")).map(r => r.id), ["r-b", "r-c"]);
});

test("a rule is explained in words", () => {
  assert.equal(describeWhen({}), "任何任务");
  assert.equal(describeWhen({ anyWords: ["测试"], minChars: 20 }), "提到「测试」，且任务不少于 20 字");
});

test("what the console sends is cleaned and checked, with reasons the user can act on", () => {
  const known = { agents: ["claude", "codex"] };
  const ok = parseRule({ name: " 测试 ", when: { anyWords: "测试，单测, pytest", minChars: "30" }, then: { agent: "claude", effort: "high" } }, known);
  assert.ok("rule" in ok);
  assert.deepEqual((ok as { rule: DispatchRule }).rule.when, { anyWords: ["测试", "单测", "pytest"], minChars: 30 });
  for (const [input, message] of [
    [{ name: "", then: { agent: "claude" } }, /名字/],
    [{ name: "x", then: {} }, /agent/],
    [{ name: "x", then: { agent: "auto" } }, /自动/],
    [{ name: "x", then: { agent: "nobody" } }, /没有这个 agent/],
    [{ name: "x", when: { regex: "([" }, then: { agent: "claude" } }, /正则/],
    [{ name: "x", when: { minChars: 10, maxChars: 5 }, then: { agent: "claude" } }, /字数/],
    [{ name: "x", when: { cwdPrefix: "relative/path" }, then: { agent: "claude" } }, /绝对路径/],
  ] as const) {
    const r = parseRule(input as never, known);
    assert.ok("error" in r && message.test(r.error), JSON.stringify(input));
  }
});

// ---------------------------------------------------------------- over HTTP, with a real agent

let relay: Awaited<ReturnType<typeof startMockRelay>>;
let server: Server;
let port: number;
let pid: string;
const H = { "content-type": "application/json", "x-easyswitch": "1" };
const api = (m: string, p: string, b?: unknown) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: H, ...(b ? { body: JSON.stringify(b) } : {}) });

before(async () => {
  relay = await startMockRelay(0, { apiKey: "k" });
  port = await new Promise<number>(resolve => {
    const probe = createServer().listen(0, "127.0.0.1", () => { const p = (probe.address() as { port: number }).port; probe.close(() => resolve(p)); });
  });
  server = createEasySwitchServer({ store: new Store(mkdtempSync(join(tmpdir(), "es-dispatch-"))), secrets: createSecretStore(), port, gatewayAuth: true });
  await new Promise<void>(r => server.listen(port, "127.0.0.1", r));
  pid = ((await (await api("POST", "/api/providers", { name: "mock-relay", baseUrl: relay.baseUrl, apiKey: "k" })).json()) as { id: string }).id;
});
after(() => { server.closeAllConnections(); server.close(); relay.server.closeAllConnections(); relay.server.close(); });

test("rules can be added, listed, reordered, edited and deleted over the API", async () => {
  assert.equal((await api("POST", "/api/rules", { name: "", then: { agent: "dsh" } })).status, 400);
  const a = (await (await api("POST", "/api/rules", { name: "第一条", when: { anyWords: ["alpha"] }, then: { agent: "dsh" } })).json()) as Json;
  const b = (await (await api("POST", "/api/rules", { name: "第二条", then: { agent: "dsh" } })).json()) as Json;
  let list = (await (await api("GET", "/api/rules")).json()) as { rules: Json[] };
  assert.deepEqual(list.rules.map(r => r.name), ["第一条", "第二条"]);
  assert.equal(list.rules[0]!.summary, "提到「alpha」");
  await api("POST", `/api/rules/${b.id}/move`, { direction: "up" });
  list = (await (await api("GET", "/api/rules")).json()) as { rules: Json[] };
  assert.deepEqual(list.rules.map(r => r.name), ["第二条", "第一条"]);
  assert.equal((await api("PUT", `/api/rules/${a.id}`, { name: "改名", enabled: false, then: { agent: "dsh" } })).status, 200);
  assert.equal(((await (await api("GET", "/api/rules")).json()) as { rules: Json[] }).rules.find(r => r.id === a.id)!.enabled, false);
  assert.equal((await api("DELETE", `/api/rules/${a.id}`)).status, 200);
  assert.equal((await api("DELETE", `/api/rules/${b.id}`)).status, 200);
  assert.equal((await api("PUT", `/api/rules/${b.id}`, { name: "x", then: { agent: "dsh" } })).status, 404);
});

test("a dry run says who would get a task and why, without running anything", async t => {
  const agents = (await (await api("GET", "/api/agents")).json()) as { agents: Array<{ id: string; installed: boolean; can?: { headless: boolean } }> };
  const available = agents.agents.find(a => a.installed && a.can?.headless);
  if (!available) { t.skip("no agent that can take a task is installed"); return; }
  await api("POST", "/api/rules", { name: "要点", when: { anyWords: ["summarise"] }, then: { agent: available.id } });
  const hit = (await (await api("POST", "/api/rules/test", { task: "please summarise this" })).json()) as Json;
  assert.equal(hit.agent, available.id);
  assert.match(hit.why, /按规则「要点」（提到「summarise」）/);
  const miss = (await (await api("POST", "/api/rules/test", { task: "something else entirely" })).json()) as Json;
  assert.match(miss.why, /没有规则接这个任务/, "falls back to the first agent that can work, and says so");
});

test("a rule pointing at an agent that is not installed is skipped for the next one", async () => {
  await api("POST", "/api/rules", { name: "不存在的", when: { anyWords: ["zzz-skip"] }, then: { agent: "aider" } });
  const r = (await (await api("POST", "/api/rules/test", { task: "zzz-skip this" })).json()) as Json;
  if (r.error) return; // nothing at all can take work on this machine; nothing more to check
  assert.match(r.why, /规则「不存在的」要派给 aider，但它现在接不了活，已跳过/);
});

test("a task sent to auto runs on the agent the rules chose, and the record says why", async t => {
  const agents = (await (await api("GET", "/api/agents")).json()) as { agents: Array<{ id: string; installed: boolean; can?: { headless: boolean } }> };
  if (!agents.agents.some(a => a.id === "dsh" && a.installed)) { t.skip("DeepSeek Harness not installed"); return; }
  await api("POST", "/api/rules", { name: "走 dsh", when: { anyWords: ["pong-please"] }, then: { agent: "dsh", model: `${pid}/mock-coder` } });
  const started = (await (await api("POST", "/api/tasks", { agent: "auto", task: "Reply with exactly the word: pong-please" })).json()) as { task: Json };
  assert.equal(started.task.agent, "dsh");
  assert.equal(started.task.model, `${pid}/mock-coder`);
  assert.match(started.task.why, /按规则「走 dsh」/);
  let final: Json | undefined;
  for (let i = 0; i < 120 && !final; i++) {
    const list = (await (await api("GET", "/api/tasks")).json()) as { tasks: Json[] };
    const mine = list.tasks.find(x => x.id === started.task.id);
    if (mine && mine.status !== "running") final = mine; else await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(final?.status, "done");
  assert.match(final?.output ?? "", /Hello from the mock relay|pong/i);
});
