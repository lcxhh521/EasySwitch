import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

// Real console scripts, fake DOM/events and injected API responses only.
// No credentials, discovery, network, terminal or model requests are executed.
function ui() {
  const handlers: Record<string, Array<(e: any) => unknown>> = {};
  const host = { innerHTML: "", textContent: "" };
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#agents" },
    window: { addEventListener() {} }, history: { pushState() {}, replaceState() {} }, console,
    document: { addEventListener(n: string, f: (e: any) => unknown) { (handlers[n] ??= []).push(f); }, querySelector: (s: string) => s === "#page" ? host : { innerHTML: "", textContent: "", className: "" }, querySelectorAll: () => [], activeElement: null },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {},
    navigator: { clipboard: { async writeText(value: string) { vm.runInContext(`copied=${JSON.stringify(value)}`, context); } } },
    fetch() { assert.fail("no real transport"); },
    FormData: class { form: any; constructor(form: any) { this.form = form; } get(n: string) { return this.form.values[n] ?? null; } },
  });
  for (const file of ["errors.js", "onboarding.js"]) vm.runInContext(readFileSync(new URL(`../../web/${file}`, import.meta.url), "utf8"), context);
  const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(readFileSync(new URL("../../web/overview.js", import.meta.url), "utf8"), context);
  vm.runInContext(app.slice(0, app.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (code: string): any => vm.runInContext(code, context);
  run(`globalThis.requests=[];globalThis.copied='';
    state={providers:[],log:[],sessions:[],native:[],sessionDetails:[],bindings:{},prefs:{},pools:[],profiles:[]};
    presets=[{id:'example',name:'Example',baseUrl:'https://fixture.invalid/v1',defaultModel:'m',category:'国际官方'}];
    agentList=[{id:'aider',name:'Aider',kind:'cli',installed:true,can:{interactive:true}},{id:'hermes',name:'Hermes',kind:'cli',installed:true,can:{interactive:true}}];
    call=async(method,path,body)=>{requests.push({method,path,body});
      if(path==='/api/providers'){const p={id:'p',name:'Example',models:['m']};state.providers.push(p);return p;}
      if(path.endsWith('/probe'))return {probe:{checks:[{id:'chat',status:'pass'}]}};
      if(path.startsWith('/api/bindings/'))state.bindings[path.split('/').at(-1)]={...body};return {ok:true};};
    refresh=async()=>{render();return true};loadAgents=async()=>agentList;
    renderDoctor=()=>'<p>Fixture doctor</p>';render();`);
  const button = (action: string) => { const b: any = { disabled: false, dataset: { firstAction: action }, closest: (s: string) => s === "[data-first-action]" ? b : null }; return b; };
  const form = (kind: string, values: Record<string, string>) => ({ values, matches: (s: string) => s === `[data-first-${kind}]`, reset() { values.apiKey = ""; } });
  const dispatch = async (name: string, target: any, intent?: string) => {
    let stop = false;
    for (const f of handlers[name] ?? []) { await f({ target, ...(intent ? { submitter: { dataset: { firstSubmit: intent } } } : {}), preventDefault() {}, stopImmediatePropagation() { stop = true; } }); if (stop) break; }
  };
  const click = (action: string) => dispatch("click", button(action));
  const ready = async () => { await dispatch("submit", form("source", { presetId: "example", apiKey: "fixture-secret" })); };
  const choose = (intent?: string, values = { agent: "aider", model: "m" }) => dispatch("submit", form("agent", values), intent);
  return { run, click, ready, choose, dispatch, html: () => host.innerHTML };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test("first run uses two explicit primary actions, not an automatic launch or another confirmation page", async () => {
  const app = ui(); await app.ready();
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
  assert.match(app.html(), /保存并启动增强会话/);
  assert.match(app.html(), /<details[^>]*data-keep="first-run-options"/);
  assert.doesNotMatch(app.html(), /<details[^>]*\sopen(?:\s|>)/);
  assert.match(app.html(), /可能.*费用|消耗.*额度/);
  await app.choose(); // Enter/default submit has the same explicit primary intent.
  assert.equal(app.run("firstRun.done"), true);
  assert.equal(app.run("JSON.stringify(requests.slice(-2).map(r=>[r.method,r.path]))"), '[["PUT","/api/bindings/aider"],["POST","/api/agents/aider/launch"]]');
  assert.equal(app.run("JSON.stringify(requests.at(-1).body)"), '{"model":"p/m"}');
  assert.doesNotMatch(app.run("JSON.stringify(firstRun)"), /fixture-secret/);
});

test("save-only stays available and copied command pins the chosen model without requesting a capability", async () => {
  const app = ui(); await app.ready(); await app.choose("save");
  assert.equal(app.run("firstRun.done"), false); assert.equal(app.run("firstRun.step"), 3);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
  app.run("state.bindings.aider={providerId:'other',model:'different'}");
  await app.click("copy");
  assert.equal(app.run("copied"), "es aider --model 'p/m'");
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/command')).length"), 0);
  assert.doesNotMatch(app.run("copied"), /fixture-secret|Bearer|es-session-/);
});

test("copied model argument is shell quoted even when a configured name contains quotes and metacharacters", async () => {
  const app = ui(); await app.ready();
  const model = "o'ne;$(whoami)";
  app.run(`state.providers[0].models=[${JSON.stringify(model)}];firstRun.model=${JSON.stringify(model)}`);
  await app.choose("save", { agent: "aider", model }); await app.click("copy");
  assert.equal(app.run("copied"), "es aider --model 'p/o'\\''ne;$(whoami)'");
});

test("binding rejection never launches and exposes a real budget recovery action", async () => {
  const app = ui(); await app.ready();
  app.run("globalThis.originalCall=call;call=async(m,p,b)=>{if(p.startsWith('/api/bindings/'))throw {code:'budget_blocked'};return originalCall(m,p,b)}");
  await app.choose("launch");
  assert.equal(app.run("firstRun.done"), false); assert.equal(app.run("firstRun.busy"), false);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
  assert.match(app.html(), /data-first-action="recover"/);
  await app.click("recover"); assert.equal(app.run("page"), "usage");
  assert.match(app.html(), /继续首次设置/);
  await app.click("resume"); assert.equal(app.run("page"), "agents"); assert.equal(app.run("firstRun.model"), "m");
});

test("leaving while binding saves keeps the confirmed save but does not send a delayed launch or steal navigation", async () => {
  const app = ui(); await app.ready();
  app.run("globalThis.originalCall=call;call=(m,p,b)=>p.startsWith('/api/bindings/')?new Promise(resolve=>globalThis.finishSave=()=>originalCall(m,p,b).then(resolve)):originalCall(m,p,b)");
  const pending = app.choose("launch"); await tick();
  await app.run("navigatePage('settings')"); app.run("finishSave()"); await pending;
  assert.equal(app.run("page"), "settings"); assert.equal(app.run("firstRun.step"), 3); assert.equal(app.run("firstRun.done"), false);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
  assert.match(app.html(), /继续首次设置/);
  await app.click("resume"); await app.click("launch");
  assert.equal(app.run("requests.filter(r=>r.path.startsWith('/api/bindings/')).length"), 1);
  assert.equal(app.run("firstRun.done"), true);
});

test("leaving while source creation saves does not start a paid probe later", async () => {
  const app = ui();
  app.run("globalThis.originalCall=call;call=(m,p,b)=>p==='/api/providers'?new Promise(resolve=>globalThis.finishSource=()=>originalCall(m,p,b).then(resolve)):originalCall(m,p,b)");
  const pending = app.ready(); await tick(); await app.run("navigatePage('settings')"); app.run("finishSource()"); await pending;
  assert.equal(app.run("firstRun.providerId"), "p"); assert.equal(app.run("firstRun.step"), 1);
  assert.equal(app.run("page"), "settings");
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/probe')).length"), 0);
});

test("source, catalog, budget and agent changes during save block launch without selecting a replacement", async () => {
  for (const change of ["state.providers[0].off=true", "state.selectableModels=[]", "state.providers[0].budgetStatus={blocked:true}", "state.providers[0].models=['other']", "agentList[0].installed=false"]) {
    const app = ui(); await app.ready();
    app.run("globalThis.originalCall=call;call=(m,p,b)=>p.startsWith('/api/bindings/')?new Promise(resolve=>globalThis.finishSave=()=>originalCall(m,p,b).then(resolve)):originalCall(m,p,b)");
    const pending = app.choose("launch"); await tick(); app.run(change); app.run("finishSave()"); await pending;
    assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0, change);
    assert.equal(app.run("firstRun.agent"), "aider", change); assert.equal(app.run("firstRun.model"), "m", change);
    assert.match(app.html(), /data-first-action="recover"/, change);
  }
});

test("busy spans both awaits and blocks duplicate saves, launches and dismissals", async () => {
  const app = ui(); await app.ready();
  app.run("globalThis.originalCall=call;call=(m,p,b)=>p.startsWith('/api/bindings/')?new Promise(resolve=>globalThis.finishSave=()=>originalCall(m,p,b).then(resolve)):p.endsWith('/launch')?new Promise(resolve=>globalThis.finishLaunch=()=>originalCall(m,p,b).then(resolve)):originalCall(m,p,b)");
  const pending = app.choose("launch"); await tick(); await app.choose("launch"); await app.click("dismiss");
  assert.equal(app.run("firstRun.active"), true); app.run("finishSave()"); await tick();
  assert.equal(app.run("firstRun.busy"), true); await app.click("launch"); await app.choose("launch");
  assert.equal(app.run("typeof finishLaunch"), "function"); app.run("finishLaunch()"); await pending;
  assert.equal(app.run("requests.filter(r=>r.path.startsWith('/api/bindings/')).length"), 1);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 1);
  assert.equal(app.run("firstRun.done"), true); assert.equal(app.run("firstRun.busy"), false);
});

test("launch failure preserves the confirmed selection and retry does not re-save or recreate a source", async () => {
  const app = ui(); await app.ready();
  app.run("globalThis.originalCall=call;call=async(m,p,b)=>{if(p.endsWith('/launch')){requests.push({method:m,path:p,body:b});throw {code:'client_not_installed'}}return originalCall(m,p,b)}");
  await app.choose("launch"); assert.equal(app.run("firstRun.step"), 3); assert.equal(app.run("firstRun.done"), false);
  assert.match(app.html(), /设置已保存/); await app.click("recover");
  assert.equal(app.run("firstRun.suspended"), true); assert.match(app.html(), /继续首次设置/);
  assert.doesNotMatch(app.html(), /id="first-run"/);
  await app.click("resume"); app.run("call=originalCall"); await app.click("launch");
  assert.equal(app.run("requests.filter(r=>r.path==='/api/providers').length"), 1);
  assert.equal(app.run("requests.filter(r=>r.path.startsWith('/api/bindings/')).length"), 1);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 2);
});

test("uncertain launch outcomes warn to check existing windows and are never automatically replayed", async () => {
  const app = ui(); await app.ready();
  app.run("globalThis.originalCall=call;call=async(m,p,b)=>{if(p.endsWith('/launch')){requests.push({method:m,path:p,body:b});throw {code:'request_timeout'}}return originalCall(m,p,b)}");
  await app.choose("launch");
  assert.match(app.html(), /结果.*未确认|未确认.*结果/); assert.match(app.html(), /先.*检查.*窗口|先.*确认.*窗口/);
  await app.click("copy"); app.run("render()");
  assert.match(app.html(), /先.*检查.*窗口|先.*确认.*窗口/);
  await app.click("back"); app.run("state.providers[0].models.push('other')");
  await app.dispatch("change", { matches: (s: string) => s === "[data-first-choice]", dataset: { firstChoice: "model" }, value: "other" });
  assert.match(app.html(), /上次启动结果尚未确认/);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 1);
});

test("stale visible selections remain explicit instead of browser or sync silently choosing the first alternative", async () => {
  const app = ui(); await app.ready();
  app.run("agentList[0].installed=false;state.providers[0].models=['other'];firstRunSync();render()");
  assert.equal(app.run("firstRun.agent"), "aider"); assert.equal(app.run("firstRun.model"), "m");
  assert.match(app.html(), /value="aider" selected disabled/); assert.match(app.html(), /value="m" selected disabled/);
  assert.match(app.html(), /data-first-submit="launch"[^>]*disabled/);
  await app.choose("launch"); assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
});

test("source recovery opens the selected source, preserves choices and does not login, enable or probe", async () => {
  const app = ui(); await app.ready();
  app.run("state.providers[0].off=true;render();globalThis.countBefore=requests.length");
  await app.click("recover"); assert.equal(app.run("page"), "providers"); assert.equal(app.run("openProvider"), "p");
  assert.match(app.html(), /继续首次设置/);
  assert.equal(app.run("requests.length"), app.run("countBefore")); assert.equal(app.run("state.providers[0].off"), true);
  await app.click("resume"); assert.equal(app.run("firstRun.providerId"), "p"); assert.equal(app.run("firstRun.model"), "m");
});


test("changing the advanced choice requires another explicit launch and keeps invalid choices blocked", async () => {
  const app = ui(); await app.ready();
  await app.dispatch("change", { matches: (s: string) => s === "[data-first-choice]", dataset: { firstChoice: "agent" }, value: "hermes" });
  assert.equal(app.run("firstRun.agent"), "hermes");
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
  await app.choose("launch", { agent: "hermes", model: "m" });
  assert.equal(app.run("requests.at(-1).path"), "/api/agents/hermes/launch");
});

test("leaving and returning during save still cancels the deferred launch intent", async () => {
  const app = ui(); await app.ready();
  app.run("globalThis.originalCall=call;call=(m,p,b)=>p.startsWith('/api/bindings/')?new Promise(resolve=>globalThis.finishSave=()=>originalCall(m,p,b).then(resolve)):originalCall(m,p,b)");
  const pending = app.choose("launch"); await tick();
  await app.run("navigatePage('settings')"); await app.run("navigatePage('agents')"); app.run("finishSave()"); await pending;
  assert.equal(app.run("firstRun.saved"), true);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
});

test("removed source can be explicitly reselected without deleting or changing any stored source", async () => {
  const app = ui(); await app.ready();
  app.run("state.providers=[{id:'other',name:'Other',models:['x']}];render();globalThis.countBefore=requests.length");
  assert.equal(app.run("firstRun.providerId"), "p");
  await app.click("reset-source");
  assert.equal(app.run("firstRun.providerId"), ""); assert.equal(app.run("firstRun.step"), 1);
  assert.equal(app.run("state.providers.length"), 1); assert.equal(app.run("state.providers[0].id"), "other");
  assert.equal(app.run("requests.length"), app.run("countBefore"));
  assert.match(app.html(), /添加并检测/);
});

test("an unavailable chosen program can be explicitly redetected even when another program is installed", async () => {
  const app = ui(); await app.ready();
  app.run("agentList[0].installed=false;render();globalThis.countBefore=requests.length;globalThis.detections=0;loadAgents=async()=>{detections++;return [{id:'aider',name:'Aider',installed:true,can:{interactive:true}},{id:'hermes',name:'Hermes',installed:true,can:{interactive:true}}]}");
  assert.match(app.html(), /data-first-action="detect"/);
  assert.equal(app.run("firstRun.agent"), "aider");
  await app.click("detect");
  assert.equal(app.run("detections"), 1); assert.equal(app.run("firstRun.agent"), "aider");
  assert.equal(app.run("firstRunSelectionIssue()"), "");
  assert.equal(app.run("requests.length"), app.run("countBefore"));
  await app.choose("launch"); assert.equal(app.run("requests.at(-1).path"), "/api/agents/aider/launch");
});


test("changing a model does not inherit the old model's inference-check badge", async () => {
  const app = ui(); await app.ready(); app.run("state.providers[0].models.push('other')");
  await app.dispatch("change", { matches: (s: string) => s === "[data-first-choice]", dataset: { firstChoice: "model" }, value: "other" });
  assert.equal(app.run("firstRun.tested"), false); assert.equal(app.run("firstRun.model"), "other");
  assert.match(app.html(), /尚未验证真实推理/);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/probe')).length"), 1);
  assert.equal(app.run("requests.filter(r=>r.path.endsWith('/launch')).length"), 0);
});
