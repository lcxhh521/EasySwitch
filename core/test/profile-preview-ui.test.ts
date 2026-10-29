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
  const context = vm.createContext({ AbortController, URLSearchParams, location: { search: "", hash: "#agents" }, history: { replaceState() {} }, console,
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


const preview = {
 profileId:"f-abcd", name:"Fixture",fingerprint:"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
 summary:{clients:2,changed:2,clearedBindings:1},warnings:["No launch"],
 changes:[
 {harness:"aider",changed:true,before:{binding:{providerId:"p",model:"m"},prefs:{effort:"high",fallbackModel:"p/back",tiers:{small:"p/tiny"}}},after:{binding:null,prefs:{}},warnings:["Binding will clear"]},
 {harness:"<unsafe>",changed:true,before:{binding:null,prefs:{}},after:{binding:null,prefs:{effort:"low"}},warnings:[]}
 ]};
function ready(app:ReturnType<typeof ui>) {
 app.run(`profileSelectedId="f-abcd";profileReview={id:"f-abcd",data:${JSON.stringify(preview)}};`);
}
test("profile preview renders each actual before/after including clearing and prefs-only",()=>{
 const app=ui();ready(app);const html=app.run("profileReviewHtml()");
 assert.match(html,/aider/);assert.match(html,/p\/back/);assert.match(html,/p\/tiny/);
 assert.match(html,/无外接主模型/);assert.match(html,/无覆盖/);assert.match(html,/low/);
 assert.match(html,/&lt;unsafe&gt;/);assert.doesNotMatch(html,/<unsafe>/);
 assert.match(html,/确认应用以上全部设置/);assert.equal(app.run("requests.length"),0);
});
test("preview load is read-only and confirm uses the exact displayed fingerprint once",async()=>{
 const app=ui();app.run(`call=async(method,path,body)=>{requests.push({method,path,body});return ${JSON.stringify(preview)}}`);
 await app.run('loadProfileReview("f-abcd")');assert.equal(app.run("requests[0].method"),"GET");
 assert.equal(app.run("requests[0].path"),"/api/profiles/f-abcd/preview");
 app.run('globalThis.finishApply=null;call=(method,path,body)=>{requests.push({method,path,body});return new Promise(r=>finishApply=r)}');
 const one=app.run("confirmProfileReview()");await app.run("confirmProfileReview()");
 assert.equal(app.run("requests.length"),2);assert.equal(app.run("requests[1].body.expectedPreview"),"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
 app.run('finishApply({name:"Fixture"})');await one;
 assert.equal(app.run("profileReview"),null);assert.equal(app.run("profileApplyFlight"),null);
});
test("cancel and navigation discard delayed preview even when transport ignores abort",async()=>{
 for(const mode of ["cancel","navigation"]){
 const app=ui();app.run('globalThis.finishRead=null;call=()=>new Promise(r=>finishRead=r)');
 const loading=app.run('loadProfileReview("f-abcd")');
 app.run(mode==="cancel"?"cancelProfileReview()":"pageNavigationVersion++;page='settings';cancelProfileReview()");
 app.run(`finishRead(${JSON.stringify(preview)})`);await loading;
 assert.equal(app.run("profileReview"),null);assert.equal(app.run("requests.length"),0);
 }
});
test("late older preview cannot replace newer selected profile review",async()=>{
 const app=ui();app.run('globalThis.reads=[];call=()=>new Promise(r=>reads.push(r))');
 const older=app.run('loadProfileReview("f-abcd")'),newer=app.run('loadProfileReview("f-eeee")');
 app.run(`reads[1](${JSON.stringify({...preview,profileId:"f-eeee",name:"New"})})`);await newer;
 app.run(`reads[0](${JSON.stringify(preview)})`);await older;
 assert.equal(app.run("profileReview.id"),"f-eeee");assert.equal(app.run("profileReview.data.name"),"New");
});
test("conflict removes confirm and requires explicit fresh preview, no automatic write retry",async()=>{
 const app=ui();ready(app);app.run('call=async(method,path,body)=>{requests.push({method,path,body});throw Object.assign(new Error("conflict"),{status:409})}');
 await app.run("confirmProfileReview()");await app.run("confirmProfileReview()");
 assert.equal(app.run("requests.length"),1);assert.match(app.run("profileReview.error"),/重新预览/);
 assert.doesNotMatch(app.run("profileReviewHtml()"),/data-profile-preview-confirm/);
});
test("failed read and uncertain write never provide an automatic confirm or retry",async()=>{
 const app=ui();app.run('call=async()=>{throw new Error("offline")}');
 await app.run('loadProfileReview("f-abcd")');assert.match(app.run("profileReview.error"),/尚未应用/);
 ready(app);await app.run("confirmProfileReview()");
 assert.match(app.run("profileReview.error"),/未获确认/);assert.match(app.run("profileReview.error"),/不会自动重试/);
 assert.equal(app.run("profileApplyFlight"),null);
});
test("apply response after navigation cannot restore old review or toast on destination",async()=>{
 const app=ui();ready(app);app.run('globalThis.finish=null;call=()=>new Promise(r=>finish=r)');
 const applying=app.run("confirmProfileReview()");
 app.run("pageNavigationVersion++;page='settings';cancelProfileReview();finish({name:'Fixture'})");
 await applying;assert.equal(app.run("profileReview"),null);assert.equal(app.run("messages.length"),0);
});
test("clicking preview cancel writes nothing and confirm without reviewed data is ignored",async()=>{
 const app=ui();ready(app);
 await app.dispatch("click",app.target("[data-profile-preview-cancel]"));
 await app.run("confirmProfileReview()");assert.equal(app.run("requests.length"),0);
});
test("native route and incomplete preview ids do not initiate profile reads",async()=>{
 const app=ui();await app.run('loadProfileReview("../secret")');assert.equal(app.run("requests.length"),0);
});

test("malformed, foreign or fingerprint-free preview cannot downgrade to legacy unguarded apply",async()=>{
 for (const patch of [{fingerprint:undefined},{fingerprint:""},{fingerprint:["a".repeat(64)]},{fingerprint:"bad"},{profileId:"f-eeee"},{changes:null},{summary:{}},{warnings:null}]) {
  const app=ui(), data={...preview,...patch};
  app.run(`call=async(method,path,body)=>{requests.push({method,path,body});return ${JSON.stringify(data)}}`);
  await app.run('loadProfileReview("f-abcd")');await app.run("confirmProfileReview()");
  assert.match(app.run("profileReview.error"),/无法读取/);
  assert.equal(app.run("requests.length"),1);assert.equal(app.run("requests[0].method"),"GET");
  app.run(`profileReview={id:"f-abcd",data:${JSON.stringify(data)}}`);
  await app.run("confirmProfileReview()");assert.equal(app.run("requests.length"),1);
 }
});
