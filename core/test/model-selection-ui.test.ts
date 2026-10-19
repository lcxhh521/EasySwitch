import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

type Handler = (event: any) => unknown;
function ui() {
  const handlers: Record<string, Handler[]> = {};
  class Node {
    innerHTML = ""; value = ""; removed = false; className = ""; style = {}; offsetWidth = 400; offsetHeight = 200;
    dataset: Record<string, string> = {}; children: Node[] = []; listeners: Record<string, Handler[]> = {};
    parts: Record<string, Node> = {};
    classList = { toggle() {} }; focus() {} scrollIntoView() {} remove() { this.removed = true; }
    querySelector(selector: string) { return this.parts[selector] ?? null; }
    addEventListener(name: string, handler: Handler) { (this.listeners[name] ??= []).push(handler); }
    async emit(name: string, event: any = {}) { for (const h of this.listeners[name] ?? []) await h({ preventDefault() {}, ...event }); await new Promise(r => setImmediate(r)); }
  }
  let current: Node;
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#agents" }, history: { replaceState() {} }, console,
    window: { innerWidth: 1200, innerHeight: 800, addEventListener() {} },
    document: { activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener(name: string, h: Handler) { (handlers[name] ??= []).push(h); },
      body: { append(node: Node) { current = node; } }, createElement() { const node = new Node(); node.parts = { input: new Node(), ".rail": new Node(), ".list": new Node() }; return node; } },
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
  const dispatch = async (name: string, target: any) => { for (const h of handlers[name] ?? []) await h({ target, preventDefault() {}, stopImmediatePropagation() {} }); };
  const target = (selector: string, extra: Record<string, unknown> = {}) => { const node: any = { ...extra, matches: (s: string) => s === selector, closest: (s: string) => s === selector ? node : null }; return node; };
  const open = (name = "claude") => { run(`openPicker(anchor,${JSON.stringify(name)})`); return current!; };
  const click = async (picker: Node, index: number) => { await picker.parts[".list"]!.emit("click", { target: target(".opt", { dataset: { i: String(index) } }) }); };
  const search = async (picker: Node, text: string) => { picker.parts.input!.value = text; await picker.parts.input!.emit("input"); };
  const key = (picker: Node, key: string) => picker.parts.input!.emit("keydown", { key });
  return { run, open, click, search, key, dispatch, target };
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
  assert.match(list, /vendor\/model<\/span><span class="meta">[^<]*<\/span><span class="tick">✓/);
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
