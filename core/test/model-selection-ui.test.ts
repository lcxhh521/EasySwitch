import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

type Handler = (event: any) => unknown;
function ui() {
  const handlers: Record<string, Handler[]> = {};
  const windowHandlers: Record<string, Handler[]> = {};
  class Node {
    innerHTML = ""; value = ""; removed = false; className = ""; style: Record<string, string> = {}; offsetWidth = 400; offsetHeight = 200;
    dataset: Record<string, string> = {}; children: Node[] = []; listeners: Record<string, Handler[]> = {};
    parts: Record<string, Node> = {};
    classList = { toggle() {} }; focus() {} scrollIntoView() {} remove() { this.removed = true; }
    querySelector(selector: string) { return this.parts[selector] ?? null; }
    addEventListener(name: string, handler: Handler) { (this.listeners[name] ??= []).push(handler); }
    async emit(name: string, event: any = {}) { for (const h of this.listeners[name] ?? []) await h({ preventDefault() {}, ...event }); await new Promise(r => setImmediate(r)); }
  }
  let current: Node;
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#agents" }, history: { replaceState() {} }, console,
    window: { innerWidth: 1200, innerHeight: 800, addEventListener(name: string, handler: Handler) { (windowHandlers[name] ??= []).push(handler); } },
    document: { activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener(name: string, h: Handler) { (handlers[name] ??= []).push(h); },
      body: { append(node: Node) { current = node; } }, createElement() { const node = new Node(); node.parts = { input: new Node(), ".rail": new Node(), ".list": new Node(), ".picker-shortcuts": new Node(), ".picker-current": new Node() }; return node; } },
    localStorage: { getItem: () => null, setItem() { assert.fail("Rendering selections must not write storage"); } },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0, fetch() { assert.fail("Synthetic UI must not fetch"); },
    FormData: class { form: any; constructor(form: any) { this.form = form; } get(name: string) { return this.form.values[name] ?? null; } },
  });
  for (const file of ["errors.js", "controls.js"]) vm.runInContext(readFileSync(new URL(`../../web/${file}`, import.meta.url), "utf8"), context);
  const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(app.slice(0, app.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (source: string): any => vm.runInContext(source, context);
  run(`state={providers:[
    {id:'on',name:'Active source',models:['m','vendor/model'],icon:'letter:A',sourceHealth:{status:'unknown'}},
    {id:'off',name:'Closed source',models:['closed'],off:true},
    {id:'budget',name:'Budget source',models:['blocked'],budgetStatus:{blocked:true}},
    {id:'droid',name:'Unsupported bridge',models:['unsupported'],cliTextBridge:{kind:'droid'}},
    {id:'qoder',name:'Supported bridge',models:['text'],cliTextBridge:{kind:'qoder'}},
    {id:'default',name:'Default source',models:[],defaultModel:'default-only'}
    ],pools:[{id:'empty',name:'Empty pool',members:[]},{id:'closed',name:'Closed pool',members:['off/closed']},{id:'mixed',name:'Mixed pool',members:['off/closed','on/m']}],bindings:{},prefs:{},profiles:[],sessionDetails:[],sessions:[],native:[],log:[],codexPath:'/fixture/codex',claudePath:'/fixture/claude'};
    agentList=[{id:'claude',name:'Claude Code',installed:true,can:{headless:true,interactive:true,efforts:[],tiers:[{id:'small',label:'后台小任务',hint:'Fixture'}]}},{id:'aider',name:'Aider',installed:true,can:{headless:true,interactive:true,efforts:[],tiers:[]}}];
    globalThis.requests=[];globalThis.messages=[];render=()=>{};refresh=async()=>{};toast=m=>messages.push(m);call=async(method,path,body)=>{requests.push({method,path,body});return {}};
    globalThis.anchor={getBoundingClientRect:()=>({right:450,bottom:50,top:20})};`);
  const dispatch = async (name: string, target: any, extra: Record<string, unknown> = {}) => { for (const h of handlers[name] ?? []) await h({ target, preventDefault() {}, stopImmediatePropagation() {}, ...extra }); };
  const target = (selector: string, extra: Record<string, unknown> = {}) => { const node: any = { ...extra, matches: (s: string) => s === selector, closest: (s: string) => s === selector ? node : null }; return node; };
  const open = (name = "claude") => { run(`openPicker(anchor,${JSON.stringify(name)})`); return current!; };
  const click = async (picker: Node, index: number) => { await picker.parts[".list"]!.emit("click", { target: target(".opt", { dataset: { i: String(index) } }) }); };
  const search = async (picker: Node, text: string) => { picker.parts.input!.value = text; await picker.parts.input!.emit("input"); };
  const key = (picker: Node, key: string, extra: Record<string, unknown> = {}) => picker.parts.input!.emit("keydown", { key, ...extra });
  const shortcut = async (picker: Node, scope: string) => picker.parts[".picker-shortcuts"]!.emit("click", {target:target(scope === "current" ? "[data-picker-current]" : "[data-picker-scope]", {dataset:{pickerScope:scope}})});
  const windowEvent = async (name: string) => { for (const handler of windowHandlers[name] ?? []) await handler({}); };
  return { run, open, click, search, key, dispatch, target, windowEvent, shortcut };
}

test("all existing model selectors use catalog eligibility, including unknown health and usable pools", () => {
  const app = ui();
  assert.equal(app.run("JSON.stringify(selectableModelNames())"), '["on/m","on/vendor/model","qoder/text","default/default-only","pool/mixed"]');
  const picker = app.open(), list = picker.parts[".list"]!.innerHTML;
  assert.match(list, /Active source|Supported bridge|模型池/); assert.match(list, />mixed</);
  assert.doesNotMatch(list, />closed<|>blocked<|>unsupported<|>empty</);
  assert.match(picker.parts[".rail"]!.innerHTML, /data-only="on"/);
  const controls = app.run("agentControls('claude')") as string;
  assert.match(controls, /value="qoder\/text"/); assert.doesNotMatch(controls, /value="pool\/|value="droid\/|value="off\//);
});

test("canonical catalog overrides older client flags and health never supplies a selection veto", () => {
  const app = ui();
  app.run("state.selectableModels=['off/closed'];state.providers[0].sourceHealth.status='unavailable'");
  assert.equal(app.run("JSON.stringify(selectableModelNames())"), '["off/closed"]');
  assert.match(app.open().parts[".list"]!.innerHTML, />closed</);
  app.run("state.selectableModels=['on/m']");
  assert.equal(app.run("modelSelectionReason('on/m')"), "");
  assert.match(app.open().parts[".list"]!.innerHTML, />m</);
});

test("saved main, tier and fallback values remain visible with reasons and are never cleared by rendering", () => {
  const app = ui();
  app.run("state.bindings.claude={providerId:'off',model:'closed'};state.prefs.claude={tiers:{small:'budget/blocked'},fallbackModel:'off/closed'};globalThis.before=JSON.stringify(state)");
  const row = app.run("agentRow('claude')") as string;
  assert.match(row, />closed</); assert.match(row, /来源已关闭/); assert.match(row, />blocked</); assert.match(row, /预算阻断/);
  assert.match(row, /<option value="off\/closed" selected disabled>.*已保留：来源已关闭/);
  const picker = app.open("claude@small");
  assert.match(picker.innerHTML, /已保留 budget\/blocked/);
  assert.doesNotMatch(picker.parts[".list"]!.innerHTML, />blocked</);
  assert.equal(app.run("JSON.stringify(state)===before"), true); assert.equal(app.run("requests.length"), 0);
  app.run("state.providers[1].off=false");
  const reopened = app.run("agentControls('claude')") as string;
  assert.match(reopened, /<option value="off\/closed" selected>/); assert.doesNotMatch(reopened, /value="off\/closed" selected disabled/);
});

test("independent tiers read prefs with native main and retain the correct checkmark", () => {
  const app = ui(); app.run("state.prefs.claude={tiers:{small:'on/vendor/model'}}");
  const list = app.open("claude@small").parts[".list"]!.innerHTML;
  assert.match(list, /vendor\/model<small class="picker-roles">已配置：后台小任务<\/small><\/span><span class="meta">[^<]*<\/span><span class="tick">✓/);
  assert.match(list, /跟随主模型/); assert.doesNotMatch(list.slice(0, list.indexOf("</button>")), /class="tick">✓/);
});

test("search, source groups, keyboard and mouse keep native and valid selection paths", async () => {
  const app = ui(); let picker = app.open();
  await app.search(picker, "vendor/model"); await app.key(picker, "ArrowDown"); await app.key(picker, "ArrowUp"); await app.key(picker, "Enter");
  assert.equal(app.run("JSON.stringify(requests[0])"), '{"method":"PUT","path":"/api/bindings/claude","body":{"providerId":"on","model":"vendor/model"}}');
  picker = app.open("claude@small"); await app.click(picker, 0);
  assert.equal(app.run("requests[1].method"), "DELETE"); assert.equal(app.run("requests[1].path"), "/api/bindings/claude/tiers/small");
  picker = app.open(); await app.search(picker, "Closed source"); await app.key(picker, "Enter");
  assert.equal(app.run("requests.length"), 2); assert.match(picker.parts[".list"]!.innerHTML, /没有匹配/);
  await app.key(picker, "Escape"); assert.equal(picker.removed, true);
  picker = app.open(); await picker.parts[".rail"]!.emit("click", { target: app.target("button", { dataset: { only: "qoder" } }) });
  assert.match(picker.parts[".list"]!.innerHTML, /Supported bridge/); assert.doesNotMatch(picker.parts[".list"]!.innerHTML, /Active source/);
  await app.click(picker, 0); assert.equal(app.run("requests[2].body.providerId"), "qoder");
  picker = app.open(); await app.search(picker, "native"); await app.key(picker, "Enter");
  assert.equal(app.run("requests[3].method"), "DELETE"); assert.equal(app.run("requests[3].path"), "/api/bindings/claude");
});

test("a stale menu cannot submit a newly unavailable choice and failed saves retain the old state", async () => {
  const app = ui(); app.run("state.bindings.claude={providerId:'on',model:'m'};globalThis.before=JSON.stringify(state)");
  let picker = app.open(); await app.search(picker, "vendor/model"); app.run("state.selectableModels=[]"); await app.click(picker, 0);
  assert.equal(app.run("requests.length"), 0); assert.match(app.run("messages[0]"), /原设置已保留/);
  app.run("delete state.selectableModels;call=async(method,path,body)=>{requests.push({method,path,body});throw {code:'provider_disabled'}}");
  picker = app.open(); await app.search(picker, "vendor/model"); await app.key(picker, "Enter");
  assert.equal(app.run("requests.length"), 1); assert.equal(app.run("JSON.stringify(state)===before"), true);
});

test("desktop saved choices and arbitrary upstream IDs are displayed without automatic replacement", async () => {
  const app = ui(); app.run("state.bindings['claude-desktop']={providerId:'off',model:'closed'};claudeDesktopInfo={installed:true,launchBlocked:false,sessions:[]}");
  let html = app.run("claudeDesktopCard()") as string;
  assert.equal(app.run("claudeDesktopModel"), "off/closed"); assert.match(html, /value="off\/closed" selected disabled/); assert.match(html, /data-claude-desktop-ask disabled/);
  app.run("claudeDesktopConfirm=true"); await app.dispatch("click", app.target("[data-claude-desktop-start]")); assert.equal(app.run("requests.length"), 0);
  app.run("state.bindings.claude={providerId:'on',model:'unlisted/upstream'}"); html = app.run("agentRow('claude')");
  assert.match(html, /unlisted\/upstream/); assert.match(html, /模型未列入当前目录/);
  assert.doesNotMatch(html.match(/<button[^>]*data-launch="claude"[^>]*>/)?.[0] ?? "", /disabled/);
});

test("saved unavailable labels escape model and source text", () => {
  const app = ui(); app.run("state.prefs.claude={fallbackModel:'off/<img onerror=bad>'};state.bindings.claude={providerId:'off',model:'<svg onload=bad>'}");
  const html = app.run("agentRow('claude')") as string;
  assert.match(html, /&lt;img/); assert.match(html, /&lt;svg/); assert.doesNotMatch(html, /<img onerror|<svg onload/);
});

test("fallback rendering never clears a saved value and an explicit blank selection does", async () => {
  const app = ui(); app.run("state.prefs.claude={fallbackModel:'off/closed'}");
  app.run("agentControls('claude')"); assert.equal(app.run("requests.length"), 0);
  await app.dispatch("change", app.target("[data-fallback-select]", { value: "", dataset: { fallbackSelect: "claude" }, disabled: false }));
  assert.equal(app.run("JSON.stringify(requests[0])"), '{"method":"PUT","path":"/api/bindings/claude/fallback","body":{"model":""}}');
});

for (const [target, path] of [["claude", "/api/bindings/claude"], ["claude@small", "/api/bindings/claude/tiers/small"]]) {
  test(`existing automatic pool discloses the plain-text trial in ${target} picker before explicit selection`, async () => {
    const app = ui(); app.run("state.pools.push({id:'auto',name:'Automatic trial',strategy:'automatic',members:['on/m']})");
    const picker = app.open(target); await app.search(picker, "Automatic trial");
    const html = picker.parts[".list"]!.innerHTML;
    assert.match(html, /<span class="meta">仅纯文字试用；工具请求拒绝（已确认名单）<\/span>/);
    assert.equal(app.run("requests.length"), 0);
    await app.click(picker, 0);
    assert.equal(app.run("JSON.stringify(requests)"), JSON.stringify([{ method: "PUT", path, body: { providerId: "pool", model: "auto" } }]));
    assert.doesNotMatch(app.run("JSON.stringify(requests)"), /launch|probe|automatic\/confirm/);
  });
}

test("Claude Desktop automatic-pool option discloses plain-text limitation without changing launch safety", async () => {
  const app = ui(); app.run("state.pools.push({id:'auto',name:'Automatic trial',strategy:'automatic',members:['on/m']});claudeDesktopInfo={installed:true,launchBlocked:true,sessions:[]}");
  const html = app.run("claudeDesktopCard()");
  assert.match(html, /<option value="pool\/auto"[^>]*>模型池 · Automatic trial · 仅纯文字试用；工具请求拒绝（已确认名单）<\/option>/);
  assert.match(html.match(/<button[^>]*data-claude-desktop-ask[^>]*>/)?.[0] ?? "", /disabled/);
  assert.equal(app.run("requests.length"), 0);
  await app.dispatch("change", app.target("[data-claude-desktop-model]", { value: "pool/auto" }));
  assert.equal(app.run("claudeDesktopModel"), "pool/auto"); assert.equal(app.run("claudeDesktopConfirm"), false); assert.equal(app.run("requests.length"), 0);
  app.run("claudeDesktopConfirm=true"); await app.dispatch("click", app.target("[data-claude-desktop-start]")); assert.equal(app.run("requests.length"), 0);
});

test("saved profile warning is visible only when both profiles and an automatic pool exist", () => {
  const app = ui(); app.run("state.profiles=[{id:'f-fixture',name:'Saved',agents:1}]");
  assert.doesNotMatch(app.run("profileBar()"), /方案可能恢复纯文字自动模式/);
  app.run("state.pools.push({id:'auto',name:'Automatic trial',strategy:'automatic',members:['on/m']})");
  assert.match(app.run("profileBar()"), /方案可能恢复纯文字自动模式，工具请求会被拒绝；切换后请核对主模型和小模型/);
  assert.equal(app.run("requests.length"), 0);
  app.run("state.profiles=[]"); assert.doesNotMatch(app.run("profileBar()"), /方案可能恢复纯文字自动模式/);
});


test("picker remains readable and inert when a background refresh loses core state", async () => {
  const app = ui();
  app.run("state.bindings.claude={providerId:'on',model:'m'};globalThis.savedState=state");
  const picker = app.open();
  app.run("state=null");
  await assert.doesNotReject(() => app.search(picker, "vendor/model"));
  assert.match(picker.parts[".list"]!.innerHTML, /连不上|不可用|离线|连接|重新读取|刷新/);
  assert.doesNotMatch(picker.parts[".list"]!.innerHTML, /class="opt/);
  await app.key(picker, "Enter");
  assert.equal(app.run("requests.length"), 0);
  assert.equal(app.run("savedState.bindings.claude.model"), "m");
});

for (const choice of ["native", "external"]) {
  test(`stale ${choice} picker choice cannot write after core state becomes unavailable`, async () => {
    const app = ui();
    app.run("state.bindings.claude={providerId:'on',model:'m'};globalThis.savedState=state");
    const picker = app.open();
    await app.search(picker, choice === "native" ? "native" : "vendor/model");
    app.run("state=null");
    await app.click(picker, 0);
    assert.equal(app.run("requests.length"), 0, "offline includes the native DELETE path");
    assert.equal(app.run("savedState.bindings.claude.model"), "m");
  });
}

test("closed or replaced picker ignores queued selection events without dismissing its successor", async () => {
  const app = ui();
  const old = app.open();
  await app.search(old, "vendor/model");
  await app.key(old, "Escape");
  const next = app.open("claude@small");
  await app.click(old, 0);
  assert.equal(app.run("requests.length"), 0);
  assert.equal(next.removed, false, "obsolete callback must not close the current picker");
  await app.click(next, 0);
  assert.equal(app.run("requests.length"), 1);
  assert.equal(app.run("requests[0].path"), "/api/bindings/claude/tiers/small");
});

test("repeated queued picker submission sends only one mutation while the first save awaits", async () => {
  const app = ui();
  app.run("globalThis.finishSave=null;call=(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>{finishSave=resolve})}");
  const picker = app.open();
  await app.search(picker, "vendor/model");
  await app.click(picker, 0);
  await app.click(picker, 0);
  await app.key(picker, "Enter");
  assert.equal(app.run("requests.length"), 1);
  app.run("finishSave({})");
  await new Promise(resolve => setImmediate(resolve));
});

for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
  test(`IME confirmation and cancellation leave picker and global confirmation intact (${JSON.stringify(composition)})`, async () => {
    const app = ui();
    const picker = app.open();
    await app.search(picker, "vendor/model");
    await app.key(picker, "ArrowDown", composition);
    await app.key(picker, "Enter", composition);
    assert.equal(app.run("requests.length"), 0, "IME Enter confirms text, not model selection");
    await app.key(picker, "Escape", composition);
    assert.equal(picker.removed, false, "IME Escape cancels composition, not picker");
    app.run("claudeDesktopConfirm=true");
    await app.dispatch("keydown", picker.parts.input, { key: "Escape", ...composition });
    assert.equal(picker.removed, false);
    assert.equal(app.run("claudeDesktopConfirm"), true, "global Escape must also ignore composition");
    await app.key(picker, "Enter");
    assert.equal(app.run("requests.length"), 1, "normal Enter still selects after composition");
  });
}

for (const crossPage of [false, true]) {
  for (const failed of [false, true]) {
    test(`picker save completion preserves navigation ownership (crossPage=${crossPage}, failed=${failed})`, async () => {
      const app = ui();
      app.run("globalThis.refreshes=[];refresh=async(force)=>{refreshes.push(force)};globalThis.finishSave=null;globalThis.failSave=null;call=(method,path,body)=>{requests.push({method,path,body});return new Promise((resolve,reject)=>{finishSave=resolve;failSave=reject})}");
      const picker = app.open();
      await app.search(picker, "vendor/model");
      await app.click(picker, 0);
      if (crossPage) app.run("pageNavigationVersion++;page='providers';globalThis.draftText='Unsaved provider draft'");
      app.run(failed ? "failSave({code:'provider_disabled'})" : "finishSave({})");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(app.run("JSON.stringify(refreshes)"), crossPage ? "[]" : "[true]");
      assert.equal(app.run("requests.length"), 1);
      if (crossPage) {
        assert.equal(app.run("page"), "providers");
        assert.equal(app.run("draftText"), "Unsaved provider draft");
      }
    });
  }
}


test("live picker follows viewport resize while detached or dismissed anchors are ignored", async () => {
  const app = ui();
  app.run("window.innerWidth=1440;anchor.isConnected=true;anchor.getBoundingClientRect=()=>({right:1337,bottom:50,top:20})");
  const picker = app.open();
  assert.equal(picker.style.left, "937px");
  picker.offsetWidth = 366; // CSS max-width responds to the new narrow viewport.
  app.run("window.innerWidth=390;anchor.getBoundingClientRect=()=>({right:378,bottom:90,top:60})");
  await app.windowEvent("resize");
  assert.equal(picker.style.left, "12px");
  assert.equal(picker.style.top, "96px");
  assert.ok(Number.parseFloat(picker.style.left) + picker.offsetWidth <= 390);
  app.run("anchor.isConnected=false;anchor.getBoundingClientRect=()=>{throw new Error('Detached anchor must not be measured')}");
  await assert.doesNotReject(() => app.windowEvent("resize"));
  await app.key(picker, "Escape");
  app.run("anchor.isConnected=true");
  await assert.doesNotReject(() => app.windowEvent("resize"));
  assert.equal(app.run("requests.length"), 0);
});

test('configured shortcut derives only this client main, fallback and tiers and deduplicates full model identities', async () => {
 const app=ui();app.run("state.bindings.claude={providerId:'on',model:'m'};state.bindings.aider={providerId:'qoder',model:'text'};state.prefs.claude={fallbackModel:'on/m',tiers:{small:'on/vendor/model',other:'pool/mixed'}};globalThis.before=JSON.stringify(state)");
 const picker=app.open();await app.shortcut(picker,'configured');const html=picker.parts['.list']!.innerHTML;
 assert.equal((html.match(/class="name">m</g)??[]).length,1);assert.match(html,/主模型 \/ 备用模型/);assert.match(html,/后台小任务/);assert.match(html,/辅助配置 other/);assert.match(html,/>mixed</);assert.doesNotMatch(html,/>text<|default-only/);
 assert.equal(app.run('requests.length'),0);assert.equal(app.run('JSON.stringify(state)===before'),true);
 await app.shortcut(picker,'all');assert.match(picker.parts['.list']!.innerHTML,/>text<|default-only/);
});
test('configured shortcut preserves search and source restrictions and escapes roles', async () => {
 const app=ui();app.run("state.bindings.claude={providerId:'on',model:'m'};state.prefs.claude={tiers:{'<img>':'qoder/text'}}");
 const picker=app.open();await app.search(picker,'text');await app.shortcut(picker,'configured');assert.match(picker.parts['.list']!.innerHTML,/>text</);assert.match(picker.parts['.list']!.innerHTML,/&lt;img&gt;/);assert.doesNotMatch(picker.parts['.list']!.innerHTML,/<img>/);
 await picker.parts['.rail']!.emit('click',{target:app.target('button',{dataset:{only:'on'}})});assert.doesNotMatch(picker.parts['.list']!.innerHTML,/class="name">text/);assert.match(picker.parts['.list']!.innerHTML,/没有匹配的模型/);assert.equal(app.run('requests.length'),0);
});
test('unavailable configured models remain read-only with reasons and cannot be selected by stale indices', async () => {
 const app=ui();app.run("state.bindings.claude={providerId:'off',model:'closed'};state.prefs.claude={fallbackModel:'removed/m',tiers:{small:'budget/blocked'}}");
 const picker=app.open();await app.shortcut(picker,'configured');const html=picker.parts['.list']!.innerHTML;
 assert.match(html,/off\/closed/);assert.match(html,/来源已关闭/);assert.match(html,/模型来源已不存在/);assert.match(html,/来源预算阻断/);
 assert.doesNotMatch(html,/class="name">closed|class="name">blocked/);
 await app.click(picker,2);assert.equal(app.run('requests.length'),0);
 await app.shortcut(picker,'current');await app.key(picker,'Enter');assert.equal(app.run('requests.length'),0);assert.equal(picker.removed,false);
});
test('locate current clears view filters and targets exact selected main or tier without writing', async () => {
 for(const target of ['claude','claude@small']){
  const app=ui();app.run("state.bindings.claude={providerId:'on',model:'vendor/model'};state.prefs.claude={tiers:{small:'pool/mixed'}}");
  const picker=app.open(target);await app.search(picker,'no-match');await app.shortcut(picker,'configured');await app.shortcut(picker,'current');
  assert.equal(picker.parts.input!.value,'');assert.equal(app.run('requests.length'),0);
  const html=picker.parts['.list']!.innerHTML;const highlighted=/<button class="opt kb"[^>]*>([\s\S]*?)<\/button>/.exec(html)?.[1];assert.match(highlighted??'',target==='claude'?/vendor\/model/:/>mixed</);
  await app.key(picker,'Enter');assert.equal(app.run('requests.length'),1);assert.equal(app.run('requests[0].method'),'PUT');
  assert.equal(app.run('requests[0].body.model'),target==='claude'?'vendor/model':'mixed');
 }
});
test('empty configured shortcut retains explicit native action and all models remain accessible on reopen', async () => {
 const app=ui();const picker=app.open();await app.shortcut(picker,'configured');assert.match(picker.parts['.list']!.innerHTML,/尚未配置外接模型/);assert.match(picker.parts['.list']!.innerHTML,/class="opt native/);assert.doesNotMatch(picker.parts['.list']!.innerHTML,/class="name">m/);
 await app.key(picker,'Escape');const reopened=app.open();assert.match(reopened.parts['.list']!.innerHTML,/>default-only</);assert.equal(app.run('requests.length'),0);
});
test('configured choices recheck eligibility and newer binding snapshots update the current marker', async () => {
 const app=ui();app.run("state.bindings.claude={providerId:'on',model:'m'}");const picker=app.open();await app.shortcut(picker,'configured');app.run("state.selectableModels=[]");await app.click(picker,1);assert.equal(app.run('requests.length'),0);
 app.run("delete state.selectableModels");const next=app.open();app.run("state.bindings.claude={providerId:'on',model:'vendor/model'}");await app.shortcut(next,'current');assert.match((next.parts['.picker-current'] as any).textContent,/on\/vendor\/model/);assert.equal(app.run('requests.length'),0);
});
test('current configuration status is keyboard reachable and only announces changed content', async () => {
 const app=ui();app.run("state.bindings.claude={providerId:'on',model:'m'}");const picker=app.open();assert.match(picker.innerHTML,/picker-current" role="status" tabindex="0"/);
 const status=picker.parts['.picker-current'] as any;let value=status.textContent,writes=0;Object.defineProperty(status,'textContent',{get:()=>value,set:next=>{value=next;writes++}});
 await app.search(picker,'m');await app.key(picker,'ArrowDown');assert.equal(writes,0);
 app.run("state.bindings.claude={providerId:'on',model:'vendor/model'}");await app.shortcut(picker,'current');assert.equal(writes,1);assert.match(value,/on\/vendor\/model/);assert.equal(app.run('requests.length'),0);
});
test('native or follow-main location is read-only and core loss never offers a writable configured fallback', async () => {
 for(const name of ['claude','claude@small']){
  const app=ui();const picker=app.open(name);await app.shortcut(picker,'configured');await app.shortcut(picker,'current');assert.match(picker.parts['.list']!.innerHTML,/class="opt native kb"/);assert.equal(app.run('requests.length'),0);
  app.run('state=null');await app.shortcut(picker,'configured');assert.match(picker.parts['.list']!.innerHTML,/核心状态暂时不可用/);await app.key(picker,'Enter');assert.equal(app.run('requests.length'),0);
 }
});

test('custom shortlist defaults picker to user order without changing binding',async()=>{const app=ui();app.run("state.prefs.claude={modelMenu:['on/vendor/model','on/m']};state.bindings.claude={providerId:'on',model:'m'}");const picker=app.open();const h=picker.parts['.list']!.innerHTML;assert.ok(h.indexOf('>vendor/model<')<h.indexOf('>m<'));assert.doesNotMatch(h,/>default-only</);assert.equal(app.run('state.bindings.claude.model'),'m');assert.equal(app.run('requests.length'),0);await app.shortcut(picker,'all');assert.match(picker.parts['.list']!.innerHTML,/>default-only</);});
test('empty shortlist preserves native fallback and does not silently show all models',async()=>{const app=ui();app.run('state.prefs.claude={modelMenu:[]}');const picker=app.open();assert.match(picker.parts['.list']!.innerHTML,/这是空短名单/);assert.match(picker.parts['.list']!.innerHTML,/class="opt native/);assert.doesNotMatch(picker.parts['.list']!.innerHTML,/class="name">m/);await app.shortcut(picker,'all');assert.match(picker.parts['.list']!.innerHTML,/>default-only</);});
test('invalid shortlist refs stay visible read-only and eligibility is rechecked before select',async()=>{const app=ui();app.run("state.prefs.claude={modelMenu:['removed/<bad>','off/closed','on/m']}");const picker=app.open();assert.match(picker.parts['.list']!.innerHTML,/removed\/&lt;bad&gt;/);assert.match(picker.parts['.list']!.innerHTML,/已保留/);assert.doesNotMatch(picker.parts['.list']!.innerHTML,/<bad>/);app.run('state.selectableModels=[]');await app.click(picker,1);assert.equal(app.run('requests.length'),0);});
test('current-model location leaves shortlist and configured filter stays independent',async()=>{const app=ui();app.run("state.prefs.claude={modelMenu:['on/m']};state.bindings.claude={providerId:'on',model:'vendor/model'}");const picker=app.open();assert.doesNotMatch(picker.parts['.list']!.innerHTML,/>vendor\/model</);await app.shortcut(picker,'current');assert.match(picker.parts['.list']!.innerHTML,/>vendor\/model</);await app.shortcut(picker,'configured');assert.doesNotMatch(picker.parts['.list']!.innerHTML,/>m</);});
test('client shortlist does not affect another clients picker',()=>{const app=ui();app.run("state.prefs.codex={modelMenu:[]}");const picker=app.open('claude');assert.match(picker.parts['.list']!.innerHTML,/>default-only</);assert.equal(app.run('requests.length'),0);});
