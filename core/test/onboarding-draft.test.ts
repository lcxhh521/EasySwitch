import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const key = "easyswitch:first-run:draft:v1";
const provider = () => ({ id: "p", name: "Current source", models: ["m", "other"], defaultModel: "m" });
function seed(storage: Map<string, string>, overrides: Record<string, unknown> = {}) {
  storage.set(key, JSON.stringify({ schema: 1, updatedAt: Date.now(), providerId: "p", model: "m", agent: "aider", phase: "select", ...overrides }));
}
function ui(storage = new Map<string, string>(), providers: unknown[] = [provider()], blocked = false) {
  const handlers: Record<string, Array<(event: any) => unknown>> = {};
  const page = { innerHTML: "", textContent: "" };
  const sandbox: Record<string, any> = { URLSearchParams, TextEncoder, location: { search: "", hash: "#agents" }, console,
    window: { addEventListener() {} }, history: { replaceState() {} },
    document: { addEventListener(name: string, fn: (event: any) => unknown) { (handlers[name] ??= []).push(fn); },
      querySelector: (selector: string) => selector === "#page" ? page : { innerHTML: "", textContent: "", className: "", focus() {} },
      querySelectorAll: () => [], activeElement: null },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {},
    navigator: { clipboard: { async writeText() { throw new Error("Unexpected clipboard operation"); } } },
    fetch() { throw new Error("No transport permitted in draft VM"); },
    FormData: class { form: any; constructor(form: any) { this.form = form; } get(name: string) { return this.form.values[name]; } },
  };
  Object.defineProperty(sandbox, "sessionStorage", { get() {
    if (blocked) throw new Error("Storage unavailable");
    return { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value), removeItem: (name: string) => storage.delete(name) };
  } });
  const context = vm.createContext(sandbox);
  for (const file of ["onboarding-draft.js", "onboarding.js"]) vm.runInContext(readFileSync(new URL(`../../web/${file}`, import.meta.url), "utf8"), context);
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (code: string): any => vm.runInContext(code, context);
  run(`globalThis.renderActual=render;globalThis.requests=[];
    state={version:'test',providers:${JSON.stringify(providers)},log:[],sessions:[],native:[],bindings:{},prefs:{},pools:[],profiles:[]};
    presets=[{id:'example',name:'Example',baseUrl:'https://fixture.invalid/v1',defaultModel:'m',category:'国际官方'}];
    agentList=[{id:'aider',name:'Aider',icon:'letter:A',kind:'cli',installed:true,can:{interactive:true}}, {id:'hermes',name:'Hermes',icon:'letter:H',kind:'cli',installed:true,can:{interactive:true}}];
    call=async(method,path,body)=>{requests.push({method,path,body});if(path==='/api/providers'){const p=${JSON.stringify(provider())};state.providers.push(p);return p;}
    if(path.endsWith('/probe'))return {probe:{checks:[{id:'chat',status:'pass'}]}};return {};};
    refresh=async()=>render();loadAgents=async()=>agentList;renderActual();`);
  const dispatch = async (type: string, target: any, submitter?: any) => {
    let stop = false;
    for (const handler of handlers[type] ?? []) { await handler({ target, submitter, preventDefault() {}, stopImmediatePropagation() { stop = true; } }); if (stop) break; }
  };
  const button = (action: string) => { const value: any = { disabled: false, dataset: { firstAction: action }, closest: (selector: string) => selector === "[data-first-action]" ? value : null }; return value; };
  const form = (kind: string, values: Record<string, string>) => ({ values, matches: (selector: string) => selector === `[data-first-${kind}]`, reset() { if ("apiKey" in values) values.apiKey = ""; } });
  const change = (field: string, value: string, draft = true) => dispatch("change", { value, dataset: draft ? { firstDraftChoice: field } : { firstChoice: field }, matches: (selector: string) => selector === (draft ? "[data-first-draft-choice]" : "[data-first-choice]") });
  return { run, storage, dispatch, button, form, change, html: () => page.innerHTML };
}

test("reload presents an unverified draft without restoring success or making requests", async () => {
  const storage = new Map<string, string>(); seed(storage);
  const app = ui(storage);
  assert.match(app.html(), /未验证的选择草稿/);
  assert.match(app.html(), /不能证明.*服务.*账号/);
  assert.match(app.html(), /Current source/);
  assert.equal(app.run("requests.length"), 0);
  assert.equal(app.run("firstRun.providerId"), "");
  for (const flag of ["tested", "saved", "done", "busy", "subscription"]) assert.equal(app.run(`firstRun.${flag}`), false);
  await app.dispatch("click", app.button("confirm-draft"));
  assert.equal(app.run("firstRun.draft"), null);
  assert.equal(app.run("firstRun.providerId"), "p");
  assert.equal(app.run("firstRun.step"), 2);
  assert.equal(app.run("firstRun.tested || firstRun.saved || firstRun.done"), false);
  assert.equal(app.run("requests.length"), 0);
});

test("unconfirmed draft cannot enter probe, launch, clipboard or form handlers", async () => {
  const storage = new Map<string, string>(); seed(storage); const app = ui(storage);
  for (const action of ["probe", "launch", "copy", "next", "back", "reset-source", "subscription"]) await app.dispatch("click", app.button(action));
  await app.dispatch("submit", app.form("source", { presetId: "example", apiKey: "FIXTURE_SECRET_NOT_REAL" }));
  await app.dispatch("submit", app.form("agent", { agent: "aider", model: "m" }));
  assert.equal(app.run("requests.length"), 0);
  assert.equal(app.run("firstRun.providerId"), "");
  assert.ok(app.run("firstRun.draft"));
});

for (const [name, mutate] of [
  ["deleted source", "state.providers=[]"], ["disabled source", "state.providers[0].off=true"],
  ["budget-blocked source", "state.providers[0].budgetStatus={blocked:true}"],
  ["missing model", "state.providers[0].models=['other']"], ["missing program", "agentList=agentList.filter(a=>a.id!=='aider')"],
]) test(`draft confirmation rejects ${name} without replacing the saved choices`, async () => {
  const storage = new Map<string, string>(); seed(storage); const app = ui(storage);
  app.run(`${mutate};renderActual()`);
  assert.match(app.html(), /data-first-action="confirm-draft"[^>]*disabled/);
  await app.dispatch("click", app.button("confirm-draft"));
  assert.equal(app.run("firstRun.draft.providerId"), "p");
  assert.equal(app.run("firstRun.draft.model"), "m");
  assert.equal(app.run("firstRun.draft.agent"), "aider");
  assert.equal(app.run("requests.length"), 0);
});

test("draft confirmation rechecks changes that happen after rendering", async () => {
  const storage = new Map<string, string>(); seed(storage); const app = ui(storage);
  app.run("state.providers[0].off=true");
  await app.dispatch("click", app.button("confirm-draft"));
  assert.ok(app.run("firstRun.draft")); assert.equal(app.run("requests.length"), 0);
});

test("explicit source change clears only its model and never silently chooses a replacement", async () => {
  const storage = new Map<string, string>(); seed(storage);
  const app = ui(storage, [provider(), { id: "p2", name: "Another source", models: ["replacement"] }]);
  await app.change("providerId", "p2");
  assert.equal(app.run("firstRun.draft.providerId"), "p2");
  assert.equal(app.run("firstRun.draft.model"), "");
  assert.equal(app.run("firstRun.draft.agent"), "aider");
  await app.dispatch("click", app.button("confirm-draft")); assert.ok(app.run("firstRun.draft"));
  await app.change("model", "replacement"); await app.change("agent", "hermes");
  await app.dispatch("click", app.button("confirm-draft"));
  assert.equal(app.run("JSON.stringify(firstRunSelection())"), '{"providerId":"p2","model":"replacement","agent":"hermes"}');
  assert.equal(app.run("requests.length"), 0);
});

test("same provider ID is only a hint and the confirmation displays the current source", async () => {
  const storage = new Map<string, string>(); seed(storage);
  const app = ui(storage, [{ ...provider(), name: "Different <service>" }]);
  assert.match(app.html(), /Different &lt;service&gt;/); assert.doesNotMatch(app.html(), /<service>/);
  assert.match(app.html(), /未验证的选择草稿/); assert.equal(app.run("firstRun.providerId"), "");
  await app.dispatch("click", app.button("confirm-draft"));
  assert.equal(app.run("firstRun.tested || firstRun.saved || firstRun.done"), false);
  assert.equal(app.run("requests.length"), 0);
});

test("expired pending drafts are discarded again at confirmation time", async () => {
  const storage = new Map<string, string>(); seed(storage); const app = ui(storage);
  app.run("firstRun.draft.updatedAt=Date.now()-EasySwitchFirstRunDraft.ttlMs");
  await app.dispatch("click", app.button("confirm-draft"));
  assert.equal(app.run("firstRun.draft"), null); assert.equal(storage.has(key), false);
  assert.equal(app.run("requests.length"), 0);
});

test("editing an expired in-memory draft does not silently renew its lifetime", async () => {
  const storage = new Map<string, string>(); seed(storage); const app = ui(storage);
  app.run("firstRun.draft.updatedAt=Date.now()-EasySwitchFirstRunDraft.ttlMs");
  await app.change("agent", "hermes");
  assert.equal(app.run("firstRun.draft"), null); assert.equal(storage.has(key), false);
  assert.equal(app.run("requests.length"), 0);
});

test("resetting a deleted source does not discard an earlier uncertain launch warning", async () => {
  const storage = new Map<string, string>(); seed(storage, { phase: "launch-uncertain" }); const app = ui(storage);
  await app.dispatch("click", app.button("confirm-draft"));
  app.run("state.providers=[];renderActual()");
  await app.dispatch("click", app.button("reset-source"));
  assert.equal(JSON.parse(storage.get(key)!).phase, "launch-uncertain");
  await app.dispatch("submit", app.form("source", { presetId: "example", apiKey: "fixture" }));
  assert.equal(JSON.parse(storage.get(key)!).phase, "launch-uncertain");
  const reloaded = ui(storage); assert.match(reloaded.html(), /上次启动结果尚未确认/);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
  assert.equal(reloaded.run("requests.length"), 0);
});

test("invalid persisted records neither reactivate an existing installation nor perform requests", () => {
  for (const value of ["{broken", JSON.stringify({ schema: 2 }), JSON.stringify({ schema: 1, updatedAt: 0, providerId: "p", model: "m", agent: "aider", phase: "select" })]) {
    const storage = new Map([[key, value]]); const app = ui(storage);
    assert.equal(app.run("firstRun.draft"), null); assert.equal(storage.has(key), false);
    assert.doesNotMatch(app.html(), /未验证的选择草稿/); assert.equal(app.run("requests.length"), 0);
  }
});

test("the draft helper loads before onboarding and every draft control has a unique associated label", () => {
  const index = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  assert.ok(index.indexOf('src="onboarding-draft.js"') >= 0);
  assert.ok(index.indexOf('src="onboarding-draft.js"') < index.indexOf('src="onboarding.js"'));
  const storage = new Map<string, string>(); seed(storage); const app = ui(storage);
  for (const field of ["provider", "model", "agent"]) {
    const id = `first-run-draft-${field}`;
    assert.equal([...app.html().matchAll(new RegExp(`\\bid="${id}"`, "g"))].length, 1);
    assert.equal([...app.html().matchAll(new RegExp(`<label for="${id}">`, "g"))].length, 1);
  }
});

test("source setup stores only allowlisted hints and reload never repeats creation or inference", async () => {
  const app = ui(new Map(), []);
  await app.dispatch("submit", app.form("source", { presetId: "example", apiKey: "FIXTURE_SECRET_NOT_REAL" }));
  const raw = app.storage.get(key); assert.ok(raw); assert.doesNotMatch(raw, /SECRET|apiKey|token|tested|saved|done/);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["schema", "updatedAt", "providerId", "model", "agent", "phase"].sort());
  const reloaded = ui(app.storage);
  assert.match(reloaded.html(), /未验证的选择草稿/); assert.equal(reloaded.run("requests.length"), 0);
});

test("save-only reload is not a saved or successful launch and skip clears only the marker", async () => {
  const app = ui(new Map(), []);
  await app.dispatch("submit", app.form("source", { presetId: "example", apiKey: "fixture" }));
  await app.dispatch("submit", app.form("agent", { agent: "aider", model: "m" }), { dataset: { firstSubmit: "save" } });
  assert.equal(app.run("firstRun.saved"), true);
  const reloaded = ui(app.storage);
  assert.equal(reloaded.run("firstRun.saved || firstRun.done || firstRun.tested"), false);
  assert.doesNotMatch(reloaded.html(), /设置已保存|data-first-action="copy"/);
  await reloaded.dispatch("click", reloaded.button("dismiss"));
  assert.equal(app.storage.has(key), false); assert.equal(reloaded.run("state.providers.length"), 1);
  assert.equal(reloaded.run("requests.length"), 0);
});

test("launch is marked uncertain before dispatch and reload never replays it", async () => {
  const app = ui(new Map(), []);
  await app.dispatch("submit", app.form("source", { presetId: "example", apiKey: "fixture" }));
  app.run("globalThis.originalCall=call;call=(method,path,body)=>path.endsWith('/launch')?new Promise((resolve,reject)=>{requests.push({method,path,body});globalThis.failLaunch=()=>reject({code:'request_timeout'});}):originalCall(method,path,body)");
  const pending = app.dispatch("submit", app.form("agent", { agent: "aider", model: "m" }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(app.storage.get(key)!).phase, "launch-uncertain");
  const reloaded = ui(app.storage);
  assert.match(reloaded.html(), /上次启动结果尚未确认/);
  await reloaded.dispatch("click", reloaded.button("confirm-draft"));
  assert.equal(reloaded.run("firstRun.launchUncertain"), true);
  await reloaded.change("model", "other", false);
  assert.match(reloaded.html(), /上次启动结果尚未确认/); assert.equal(reloaded.run("requests.length"), 0);
  app.run("failLaunch()"); await pending;
});

test("normal successful launch clears its marker and unavailable storage never blocks the original flow", async () => {
  for (const blocked of [false, true]) {
    const app = ui(new Map(), [], blocked);
    await app.dispatch("submit", app.form("source", { presetId: "example", apiKey: "fixture" }));
    await app.dispatch("submit", app.form("agent", { agent: "aider", model: "m" }));
    assert.equal(app.run("firstRun.done"), true); assert.equal(app.storage.has(key), false);
    assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 1);
  }
});

test("existing installations without a draft are not taken over", () => {
  const app = ui(); assert.doesNotMatch(app.html(), /未验证的选择草稿|第一次使用，两步准备好/);
  assert.equal(app.run("requests.length"), 0);
});
