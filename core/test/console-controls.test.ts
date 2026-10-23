import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
import { subscriptionSupport } from "../src/subscription-support.ts";

function ui() {
  const handlers: Record<string, Array<(event: any) => unknown>> = {};
  let storageWrites = 0;
  const nodes: Record<string, any> = Object.fromEntries(["#page", "#ver", "#guard-chip"].map(id => [id, { innerHTML: "", textContent: "", className: "" }]));
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#agents" },
    window: { addEventListener() {}, webkit: undefined }, history: { replaceState() {} }, console,
    document: { addEventListener(name: string, fn: (event: any) => unknown) { (handlers[name] ??= []).push(fn); }, activeElement: null, querySelector: (selector: string) => nodes[selector] ?? null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() { storageWrites++; } }, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0,
    fetch() { throw new Error("No network in console VM tests"); },
    FormData: class { form: any; constructor(form: any) { this.form = form; } get(name: string) { return this.form.values[name]; } },
  });
  vm.runInContext(readFileSync(new URL("../../web/controls.js", import.meta.url), "utf8"), context);
  const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(app.slice(0, app.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (s: string) => vm.runInContext(s, context);
  run(`globalThis.renderActual=render; state={native:[],sessions:[],log:[],prefs:{},profiles:[],version:"test",providers:[],pools:[],bindings:{},gatewaySessions:[],budget:{settings:{enabled:false,limitUsd:10,period:'month',action:'warn',warnAt:0.8},estimatedCostUsd:0,unknownCostCalls:0,resetsAt:'2026-11-01T00:00:00Z',limitations:'Estimate only'}};
    globalThis.requests=[];globalThis.messages=[];render=()=>{};refresh=async()=>{};toast=m=>messages.push(m);call=async(method,path,body)=>{requests.push({method,path,body});return {};};`);
  const dispatch = async (name: string, target: any) => {
    let stop = false;
    for (const handler of handlers[name] ?? []) { await handler({ target, preventDefault() {}, stopImmediatePropagation() { stop = true; } }); if (stop) break; }
  };
  const target = (selector: string, dataset = {}) => { const el = { dataset, disabled: false, closest: (s: string): any => s === selector ? el : null }; return el; };
  return { run, dispatch, target, html: () => nodes["#page"].innerHTML as string, storageWrites: () => storageWrites };
}

test("manual guide uses POST once, masks the issued token and clears page state on close", async () => {
  const app = ui();
  app.run(`call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finishGuide=resolve)};`);
  const button = app.target("[data-guide]", { guide: "workbuddy" });
  const pending = app.dispatch("click", button);
  await new Promise(resolve => setImmediate(resolve));
  await app.dispatch("click", button);
  assert.equal(app.run("requests.length"), 1);
  assert.equal(app.run("requests[0].method"), "POST");
  app.run(`finishGuide({name:'WorkBuddy',steps:['Settings'],fields:[{label:'Token',value:'fixture-page-only-token',secret:true}],models:['p/m'],caveat:'24 hours',session:{id:'s'}})`);
  await pending;
  let html = app.run(`guidePanel({id:'workbuddy'})`) as string;
  assert.match(html, /••••••••••••/);
  assert.doesNotMatch(html, /gvalue">fixture-page-only-token/);
  await app.dispatch("click", app.target("[data-guide-reveal]"));
  html = app.run(`guidePanel({id:'workbuddy'})`);
  assert.match(html, /gvalue">fixture-page-only-token/);
  await app.dispatch("click", app.target("[data-guide-close]"));
  assert.equal(app.run("guideData"), null);
  assert.equal(app.storageWrites(), 0);
});

test("token list never renders plaintext and revoke clears the matching open guide only", async () => {
  const app = ui();
  app.run(`state.gatewaySessions=[{id:'s',agentId:'<test>',expiresAt:'2026-10-07T00:00:00Z',allowMcp:false,token:'must-not-render'}];guideData={session:{id:'s'}};guideOpen='workbuddy';`);
  const html = app.run("gatewaySessionsCard()") as string;
  assert.match(html, /&lt;test&gt;/); assert.doesNotMatch(html, /must-not-render/);
  const button = app.target("[data-session-revoke]", { sessionRevoke: "s" });
  await app.dispatch("click", button);
  assert.equal(app.run("requests[0].method"), "DELETE");
  assert.equal(app.run("requests[0].path"), "/api/gateway/sessions/s");
  assert.equal(app.run("guideData"), null);
  assert.equal(app.storageWrites(), 0);
});

test("budget form submits validated settings once and re-enables controls after a failed save", async () => {
  const app = ui(); const controls = [{ disabled: false }];
  const form = { values: { enabled: "on", limitUsd: "25", period: "day", action: "stop" }, matches: (s: string) => s === "[data-global-budget-form]", querySelectorAll: () => controls };
  app.run("call=async(method,path,body)=>{requests.push({method,path,body});return new Promise((resolve,reject)=>globalThis.rejectSave=reject)}");
  const pending = app.dispatch("submit", form);
  assert.equal(controls[0]!.disabled, true);
  await app.dispatch("submit", form);
  assert.equal(app.run("requests.length"), 1);
  assert.equal(app.run("JSON.stringify(requests[0].body)"), '{"enabled":true,"limitUsd":25,"period":"day","action":"stop","warnAt":0.8}');
  app.run("rejectSave(new Error('fixture budget failure'))"); await pending;
  assert.equal(controls[0]!.disabled, false);
  assert.equal(app.run("budgetSaving"), false);
  assert.match(app.run("messages[0]"), /这次操作没有完成/); assert.doesNotMatch(app.run("messages[0]"), /fixture budget failure/);
  form.values.limitUsd = "not-a-number";
  await app.dispatch("submit", form);
  assert.equal(app.run("requests.length"), 1);
  assert.match(app.run("budgetSettingsCard()"), /禁止探测/);
});

test("budget count, warning and null reset render without HTML injection or epoch dates", () => {
  const app = ui();
  app.run(`state.budget.unknownCostCalls='<img src=x onerror="bad">';state.budget.warning='<svg onload=bad>';state.budget.resetsAt=null;`);
  let html = app.run("budgetSettingsCard()") as string;
  assert.match(html, /&lt;img src=x onerror=&quot;bad&quot;&gt;/); assert.match(html, /&lt;svg onload=bad&gt;/);
  assert.doesNotMatch(html, /<img|<svg|1970|Invalid Date/); assert.match(html, /暂不可用/);
  app.run("state.budget.unknownCostCalls=null"); html = app.run("budgetSettingsCard()");
  assert.match(html, /0 次请求缺少完整成本信息/);
  app.run("state.budget={settings:null}"); assert.equal(app.run("budgetSettingsCard()"), "");
  app.run("state=null"); assert.equal(app.run("budgetSettingsCard()"), "");
});

test("empty budget values and a stale form after state loss never submit", async () => {
  const app = ui(); const controls = [{disabled:false},{disabled:true}];
  const form = {values:{limitUsd:'',period:'day',action:'warn'},matches:(s:string)=>s==='[data-global-budget-form]',querySelectorAll:()=>controls};
  await app.dispatch("submit", form); assert.equal(app.run("requests.length"), 0);
  assert.equal(controls[0]!.disabled, false); assert.equal(controls[1]!.disabled, true);
  form.values.limitUsd='2';app.run("state=null");
  await app.dispatch("submit", form); assert.equal(app.run("requests.length"), 0);
  assert.match(app.run("messages[1]"), /状态暂不可用/);
});

test("support review shows all researched vendors and does not invent login buttons", () => {
  const app = ui();
  app.run(`planInfo={subscriptionSupport:${JSON.stringify(subscriptionSupport())}}`);
  const html = app.run("subscriptionSupportCard()") as string;
  assert.match(html, /13 家/);
  for (const row of subscriptionSupport()) assert.ok(html.includes(row.label), row.vendor);
  assert.match(html, /个人条款限制/); assert.match(html, /新增订阅默认关闭/);
  assert.doesNotMatch(html, /<button|data-plan-signin/);
});

test("menu-bar subscription rows preserve default-off state, quota and per-account switch actions", async () => {
  const app = ui();
  app.run(`planInfo={accounts:[{id:'a',label:'Example',kind:'codex',planUsage:true,needsSignIn:false,on:false},{id:'b',label:'Other',kind:'kiro',planUsage:true,on:true,quota:{text:'50%'}},{id:'hidden',label:'Expired',planUsage:true,needsSignIn:true}]}`);
  const html = app.run("panelSubscriptions()") as string;
  assert.match(html, /data-plan-switch="a" data-on="0"/);
  assert.match(html, /data-plan-switch="b" data-on="1"/);
  assert.match(html, /50%/); assert.match(html, /Expired/);
  assert.match(html, /需要重新登录/);
  assert.match(html, /data-plan-switch="hidden"[^>]*disabled/);
  await app.dispatch("click", app.target("[data-plan-switch]", { planSwitch: "a", on: "0" }));
  assert.equal(app.run("requests[0].path"), "/api/plan/a/switch");
  assert.equal(app.run("JSON.stringify(requests[0].body)"), '{"on":true}');
});

test("service-account Vertex form is distinct from manual Gemini modes and suppresses double submission", async () => {
  const app = ui();
  app.run(`vertexForm={};call=async(method,path,body)=>{requests.push({method,path,body});return new Promise((resolve,reject)=>globalThis.failVertex=reject)}`);
  assert.match(app.run("renderVertexForm()"), /服务账号 \/ Chat/);
  assert.match(app.run("renderVertexForm()"), /Express Key/);
  const form = { id: "vertex-form", matches: () => false, values: { project: "fixture-project", location: "global", models: "google/gemini-fixture", serviceAccount: "FAKE-SA-FORM-ONLY" } };
  const pending = app.dispatch("submit", form);
  await new Promise(resolve => setImmediate(resolve));
  await app.dispatch("submit", form);
  assert.equal(app.run("requests.length"), 1);
  assert.equal(app.run("requests[0].path"), "/api/vertex");
  await app.dispatch("click", app.target("[data-vertex-close]"));
  assert.equal(app.run("vertexForm.busy"), true);
  app.run("failVertex(new Error('fake validation refused'))"); await pending;
  assert.match(app.run("vertexForm.message"), /这次操作没有完成/); assert.doesNotMatch(app.run("vertexForm.message"), /fake validation refused/);
  assert.doesNotMatch(app.run("JSON.stringify(vertexForm)"), /FAKE-SA/);
  assert.equal(app.storageWrites(), 0);
});


test("complete page rendering keeps client launch, off/none controls and distinct budget forms", () => {
  const app = ui();
  app.run(`state.providers=[{id:'p',name:'Fixture',icon:'letter:F',baseUrl:'http://127.0.0.1:1/v1',models:['m'],usedBy:[],hasKey:true,budget:{monthlyUsd:5,stop:true},budgetStatus:{spent:1,limit:5,ratio:0.2,level:'ok',stop:true},supportedProtocols:['chat']}];
    state.bindings={pi:{providerId:'p',model:'m'}}; state.modelEfforts={'p/m':['none','high']}; state.prefs={pi:{effort:'off'}};
    agentList=[{id:'pi',name:'Pi',icon:'letter:P',note:'Fixture',vendor:'Fixture',support:'planned',installed:true,where:'/fixture/pi',can:{interactive:true,headless:true,efforts:['off','high'],tiers:[]}}];
    page='agents';renderActual();`);
  assert.match(app.html(), /data-agent-launch="pi"/);
  assert.doesNotMatch(app.html(), /data-quick-task/);
  assert.match(app.html(), /data-value="off" aria-pressed="true">关闭思考/);
  assert.match(app.html(), /data-value="high" aria-pressed="false">开启思考/);
  assert.match(app.html(), /网关会话令牌/);
  app.run(`planInfo={accounts:[],subscriptionSupport:${JSON.stringify(subscriptionSupport())}};openProvider='p';page='providers';renderActual();`);
  assert.match(app.html(), /订阅与官方 agent 接入核对（13 家）/);
  assert.match(app.html(), /data-provider-budget-form="p"/);
  assert.match(app.html(), /本地日历月/);
  assert.doesNotMatch(app.html(), /data-global-budget-form/);
  app.run(`page='usage';renderActual();`);
  assert.match(app.html(), /data-global-budget-form/);
  assert.match(app.html(), /UTC/);
  assert.doesNotMatch(app.html(), /data-provider-budget-form/);
});

test("source and global budget forms dispatch to different endpoints", async () => {
  const app = ui();
  const form = { dataset: { providerBudgetForm: 'p' }, matches: () => false, values: { monthlyUsd: '4.5', stop: 'on' } };
  await app.dispatch('submit', form);
  assert.equal(app.run('requests[0].path'), '/api/providers/p/budget');
  assert.equal(app.run('JSON.stringify(requests[0].body)'), '{"monthlyUsd":4.5,"stop":true}');
});

test("full provider page clearly labels Qoder text limits, default-off switch and blocked Droid", () => {
  const app = ui();
  app.run(`state.providers=[{id:'qoder-fixture',name:'Qoder fixture',icon:'letter:Q',baseUrl:'cli://qoder',models:['m'],usedBy:[],hasKey:true,off:true,billing:'subscription',cliTextBridge:{kind:'qoder',binary:'/fixture/qodercli'},supportedProtocols:['chat']}];openProvider='qoder-fixture';planInfo={accounts:[]};sourceAddOpen=true;sourceAddMode='cli';page='providers';renderActual();`);
  const html = app.html();
  assert.match(html, /CLI文字来源/); assert.match(html, /不自动运行程序/);
  assert.match(html, /data-cli-source-switch="qoder-fixture" data-on="0"/);
  assert.match(html, /拒绝工具定义、工具历史和图片/);
  assert.match(html, /本地CLI标识（不是HTTP接口）/);
  assert.match(html, /Droid：尚未开放，生产返回501/);
  assert.doesNotMatch(html, /data-probe|data-protocol-form/);
  assert.doesNotMatch(html, /OpenAI 兼容地址：.*cli:\/\/qoder/);
});

test("Qoder creation requires the current limitation acknowledgment and is submitted once", async () => {
  const app = ui(); await app.dispatch('click',app.target('[data-cli-text-open]'));
  const controls=[{disabled:false}];
  const form={matches:(s:string)=>s==='[data-cli-text-form]',querySelectorAll:()=>controls,values:{name:'Qoder',model:'m',binary:'/fixture/qoder',apiKey:'fixture-private-pat',experimental:''}};
  await app.dispatch('submit',form); assert.equal(app.run('requests.length'),0);
  form.values.experimental='on';
  app.run(`call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finishCli=resolve)}`);
  const pending=app.dispatch('submit',form); await app.dispatch('submit',form);
  assert.equal(app.run('requests.length'),1); assert.equal(controls[0]!.disabled,true);
  assert.equal(app.run('requests[0].path'),'/api/cli-text-sources');
  assert.equal(app.run('requests[0].body.kind'),'qoder'); assert.equal(app.run('requests[0].body.experimental'),true);
  app.run('finishCli({off:true})'); await pending;
  assert.equal(app.run('cliTextFormOpen'),false); assert.equal(app.storageWrites(),0);
});

test("Qoder source switch uses the source API and never initiates a sign-in or task", async () => {
  const app=ui(); await app.dispatch('click',app.target('[data-cli-source-switch]',{cliSourceSwitch:'q',on:'0'}));
  assert.equal(app.run('requests[0].path'),'/api/providers/q/switch');
  assert.equal(app.run('JSON.stringify(requests[0].body)'),'{"on":true}');
  assert.equal(app.run('requests.length'),1);
});


test("CodeBuddy source UI requires explicit region, retains text-only caveats and never uses the launcher route", async () => {
  const app = ui();
  await app.dispatch("click", app.target("[data-cli-text-open]", { cliTextOpen: "codebuddy" }));
  app.run(`planInfo={accounts:[]};page='providers';renderActual();`);
  assert.match(app.html(), /CodeBuddy API Key/); assert.match(app.html(), /凭据所属区域/);
  assert.match(app.html(), /不继承本地网关地址/); assert.match(app.html(), /真实CLI未验收/);
  assert.match(app.html(), /value="international"/); assert.match(app.html(), /value="china"/);
  const form = { matches: (s: string) => s === "[data-cli-text-form]", querySelectorAll: () => [], values: { name: "CodeBuddy", binary: "/fixture/codebuddy", model: "m", apiKey: "fake-key", edition: "", experimental: "on" } };
  await app.dispatch("submit", form); assert.equal(app.run("requests.length"), 0);
  form.values.edition = "china"; await app.dispatch("submit", form);
  assert.equal(app.run("requests[0].path"), "/api/cli-text-sources");
  assert.equal(app.run("requests[0].body.kind"), "codebuddy"); assert.equal(app.run("requests[0].body.edition"), "china");
  assert.equal(app.storageWrites(), 0);
});

test("CodeBuddy source form closes cleanly and a later Qoder form does not retain the region", async () => {
  const app = ui();
  await app.dispatch("click", app.target("[data-cli-text-open]", { cliTextOpen: "codebuddy" }));
  await app.dispatch("click", app.target("[data-cli-text-close]"));
  assert.equal(app.run("cliTextFormOpen"), false);
  await app.dispatch("click", app.target("[data-cli-text-open]", { cliTextOpen: "qoder" }));
  assert.equal(app.run("cliTextKind"), "qoder");
  assert.doesNotMatch(app.run("cliTextSourcesCard()"), /name="edition"/);
});

test("billing keeps legacy reference estimates distinct from user-entered rates", () => {
  const app = ui();
  const html = app.run(`billingBlock({priceSample:{model:'fixture',source:'legacy',rates:{input:2,output:3,cacheRead:0.5}}})`) as string;
  assert.match(html, /旧参考表，未按官方现价复核/);
  assert.match(html, /输入 \$2/);
  const own = app.run(`billingBlock({priceSample:{model:'fixture',source:'user',rates:{input:2,output:3,cacheRead:0.5}}})`) as string;
  assert.match(own, /你填的/); assert.doesNotMatch(own, /旧参考表/);
});
