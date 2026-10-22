import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

function ui() {
  const handlers: Record<string, Array<(e: any) => unknown>> = {};
  const page = { innerHTML: "", textContent: "" };
  const context = vm.createContext({ URLSearchParams, location: { search: "", hash: "#agents" },
    window: { addEventListener() {} }, history: { replaceState() {} }, console,
    document: { addEventListener(n: string, f: (e: any) => unknown) { (handlers[n] ??= []).push(f); }, querySelector: (s: string) => s === "#page" ? page : {innerHTML:"",textContent:"",className:""}, querySelectorAll: () => [], activeElement: null },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {},
    navigator: { clipboard: { async writeText(t: string) { vm.runInContext(`copied=${JSON.stringify(t)}`, context); } } },
    fetch() { throw new Error("No transport permitted in wizard VM"); },
    FormData: class { form: any; constructor(form: any) { this.form = form; } get(n: string) { return this.form.values[n]; } },
  });
  vm.runInContext(readFileSync(new URL("../../web/onboarding.js", import.meta.url), "utf8"), context);
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (s: string): any => vm.runInContext(s, context);
  run(`globalThis.renderActual=render; globalThis.copied=''; globalThis.requests=[];
    state={version:'test',providers:[],log:[],sessions:[],native:[],bindings:{},prefs:{},pools:[],profiles:[]};
    presets=[{id:'example',name:'Example',baseUrl:'https://fixture.invalid/v1',defaultModel:'m',category:'国际官方'}, {id:'vertex',name:'Advanced',vertexMode:'standard'}];
    agentList=[{id:'aider',name:'Aider',icon:'letter:A',kind:'cli',installed:true,can:{interactive:true}},{id:'uninstalled',name:'Missing',icon:'letter:M',kind:'cli',installed:false,can:{interactive:true}}];
    call=async(method,path,body)=>{requests.push({method,path,body});if(path==='/api/providers'){const p={id:'p',name:'Example',models:['m']};state.providers.push(p);return p;}
    if(path.endsWith('/probe')) return {probe:{checks:[{id:'chat',status:'pass'}]}};return {};};
    refresh=async()=>render();loadAgents=async()=>agentList;`);
  const dispatch = async (name: string, target: any) => {
    let stop = false;
    for (const f of handlers[name] ?? []) { await f({target,preventDefault(){},stopImmediatePropagation(){stop=true;}}); if(stop) break; }
  };
  const button = (action: string) => { const b: any = {disabled:false,dataset:{firstAction:action},closest:(s:string)=>s==='[data-first-action]'?b:null};return b; };
  const form = (kind: string, values: Record<string, string>) => ({ values, matches: (s: string) => s === `[data-first-${kind}]`, reset() { for(const k of Object.keys(values)) if(k==='apiKey') values[k]=''; } });
  return {run,dispatch,button,form,html:()=>page.innerHTML};
}

// Checks the rendered HTML contract, not a browser accessibility tree.
function assertAssociatedLabel(html: string, name: string, expected: string) {
  const controls = [...html.matchAll(/<(?:input|select)\b[^>]*>/g)].map(match => match[0]);
  const named = controls.filter(tag => tag.includes(`name="${name}"`));
  assert.equal(named.length, 1, `exactly one ${name} control`);
  const control = named[0]; assert.ok(control);
  const id = control.match(/\bid="([^"]+)"/)?.[1];
  assert.ok(id, `${name} needs a stable id for its visible label`);
  assert.equal([...html.matchAll(/\bid="([^"]+)"/g)].filter(match => match[1] === id).length, 1, `${id} must be unique in the rendered page`);
  const labels = [...html.matchAll(/<label\b([^>]*)>([^<]*)<\/label>/g)].filter(match => match[1]?.includes(`for="${id}"`));
  assert.equal(labels.length, 1, `exactly one explicit label for ${name}`);
  const label = labels[0]; assert.ok(label);
  assert.equal(label[2], expected);
  return id;
}

test("first-run preset and secret controls have stable unique visible labels", () => {
  const app = ui(); app.run("renderActual()");
  const preset = assertAssociatedLabel(app.html(), "presetId", "选择你已经购买或准备好的来源");
  const key = assertAssociatedLabel(app.html(), "apiKey", "粘贴这个来源的 Key");
  assert.notEqual(preset, key);
  app.run("renderActual()");
  assert.equal(assertAssociatedLabel(app.html(), "presetId", "选择你已经购买或准备好的来源"), preset);
  assert.equal(assertAssociatedLabel(app.html(), "apiKey", "粘贴这个来源的 Key"), key);
  assert.match(app.html(), /name="apiKey" type="password" autocomplete="off"/);
});

test("first-run custom and local sources keep address and conditional key labels associated", () => {
  const app = ui();
  app.run("presets.push({id:'relay',name:'Custom',category:'其他'});firstRun.presetId='relay';renderActual()");
  const ids = [assertAssociatedLabel(app.html(), "presetId", "选择你已经购买或准备好的来源"),
    assertAssociatedLabel(app.html(), "baseUrl", "来源地址"), assertAssociatedLabel(app.html(), "apiKey", "粘贴这个来源的 Key")];
  assert.equal(new Set(ids).size, 3);
  app.run("presets[0].category='本地';firstRun.presetId='example';renderActual()");
  assertAssociatedLabel(app.html(), "apiKey", "粘贴这个来源的 Key（本地模型可留空）");
  assert.doesNotMatch(app.html(), /name="baseUrl"/);
});

test("first-run advanced controls keep their labels across redraw and unavailable choices", async () => {
  const app = ui(); app.run("renderActual()");
  await app.dispatch("submit", app.form("source", {presetId:"example", apiKey:"fixture-key"}));
  const agent = assertAssociatedLabel(app.html(), "agent", "已安装的程序（Agent）");
  const model = assertAssociatedLabel(app.html(), "model", "增强会话的模型");
  assert.notEqual(agent, model);
  app.run("firstRun.agent='missing';firstRun.model='unavailable';renderActual()");
  assert.equal(assertAssociatedLabel(app.html(), "agent", "已安装的程序（Agent）"), agent);
  assert.equal(assertAssociatedLabel(app.html(), "model", "增强会话的模型"), model);
  assert.match(app.html(), /value="missing" selected disabled/);
  assert.match(app.html(), /value="unavailable" selected disabled/);
});

test("first-run busy redraw preserves explicit label associations without creating requests", async () => {
  const app = ui(); app.run("firstRun.busy=true;renderActual()");
  assertAssociatedLabel(app.html(), "presetId", "选择你已经购买或准备好的来源");
  assertAssociatedLabel(app.html(), "apiKey", "粘贴这个来源的 Key");
  assert.equal(app.run("requests.length"), 0);
  app.run("firstRun.busy=false");
  await app.dispatch("submit", app.form("source", {presetId:"example", apiKey:"fixture-key"}));
  const before = app.run("requests.length"); app.run("firstRun.busy=true;renderActual()");
  assertAssociatedLabel(app.html(), "agent", "已安装的程序（Agent）");
  assertAssociatedLabel(app.html(), "model", "增强会话的模型");
  assert.equal(app.run("requests.length"), before);
});

test("first empty console renders the real two-step wizard with safe choices", () => {
  const app=ui();app.run('renderActual()'); const html=app.html();
  assert.match(html,/第一次使用，两步准备好/);assert.match(html,/添加并检测/);assert.match(html,/可能产生费用/);
  assert.doesNotMatch(html,/value="vertex"/);assert.match(html,/type="password" autocomplete="off"/);
  app.run("presets[0].name='<script>bad</script>';renderActual()");assert.match(app.html(),/&lt;script&gt;/);assert.doesNotMatch(app.html(),/<script>bad/);
});

test("preset add and save-launch use two primary clicks and carries no key into state or copied command", async () => {
  const app=ui();app.run('renderActual()');
  const form=app.form('source',{presetId:'example',apiKey:'fixture-key'});await app.dispatch('submit',form);
  assert.equal(form.values.apiKey,'');assert.equal(app.run('firstRun.step'),2);
  assert.equal(app.run('requests.filter(r=>r.path===\"/api/providers\").length'),1);
  assert.doesNotMatch(app.run('JSON.stringify(firstRun)'),/fixture-key/);
  assert.match(app.html(),/Aider/);assert.doesNotMatch(app.html(),/value="uninstalled"/);
  await app.dispatch('submit',app.form('agent',{agent:'aider',model:'m'})); assert.equal(app.run('firstRun.step'),3);
  assert.equal(app.run('firstRun.done'),true);
  assert.equal(app.run("requests.at(-1).path"),'/api/agents/aider/launch');
  assert.equal(app.run("JSON.stringify(requests.at(-1).body)"),'{"model":"p/m"}');
});

test("add failure remains on source step and never displays raw transport errors", async () => {
  const app=ui();app.run("renderActual();call=async()=>{throw new Error('HTTP 401 fixture-secret ENOENT')}");
  await app.dispatch('submit',app.form('source',{presetId:'example',apiKey:'fixture-key'}));
  assert.equal(app.run('firstRun.step'),1);assert.equal(app.run('firstRun.busy'),false);
  assert.match(app.html(),/检查地址、密钥和模型/);assert.doesNotMatch(app.html(),/fixture-secret|HTTP 401|ENOENT/);
});

test("failed inference checks retain one saved source and retry never duplicates creation", async () => {
  const app=ui(); app.run("renderActual();globalThis.originalCall=call;call=async(m,p,b)=>p.endsWith('/probe')?{probe:{checks:[{id:'models',status:'pass'},{id:'chat',status:'fail'}]}}:originalCall(m,p,b)");
  await app.dispatch('submit',app.form('source',{presetId:'example',apiKey:'fixture-key'}));
  assert.equal(app.run('firstRun.step'),1);assert.match(app.html(),/重试不会重复添加/);
  app.run('call=originalCall'); await app.dispatch('click',app.button('probe'));
  assert.equal(app.run('firstRun.step'),2);assert.equal(app.run("requests.filter(r=>r.path==='/api/providers').length"),1);
});

test("empty installed list explains recovery without offering an invalid launch", async () => {
  const app=ui();app.run('renderActual();agentList=[]');
  await app.dispatch('submit',app.form('source',{presetId:'example',apiKey:'fixture-key'}));
  assert.match(app.html(),/还没有可启动的 Agent/);assert.match(app.html(),/重新检测已安装程序/);
  assert.doesNotMatch(app.html(),/data-first-action="launch"/);
});

test("duplicate add and dismiss during work cannot race source creation", async () => {
  const app=ui();app.run("renderActual();globalThis.originalCall=call;call=(m,p,b)=>p==='/api/providers'?new Promise(resolve=>globalThis.finish=()=>originalCall(m,p,b).then(resolve)):originalCall(m,p,b)");
  const pending=app.dispatch('submit',app.form('source',{presetId:'example',apiKey:'fixture-key'}));
  await new Promise(resolve=>setImmediate(resolve));
  await app.dispatch('submit',app.form('source',{presetId:'example',apiKey:'second-key'}));
  await app.dispatch('click',app.button('dismiss'));assert.equal(app.run('firstRun.active'),true);
  app.run('finish()');await pending;assert.equal(app.run("requests.filter(r=>r.path==='/api/providers').length"),1);
});

test("subscription navigation does not sign in or enable an account and resumes only after explicit enablement", async () => {
  const app=ui();app.run('renderActual()'); await app.dispatch('click',app.button('subscription'));
  assert.equal(app.run('page'),'providers');assert.equal(app.run('requests.length'),0);
  app.run("state.providers=[{id:'sub',name:'Sub',off:true,models:['m']}];firstRunSync()");assert.equal(app.run('firstRun.step'),1);
  app.run("state.providers[0].off=false;firstRunSync()");assert.equal(app.run('firstRun.step'),2);assert.equal(app.run('firstRun.tested'),false);
  await app.dispatch('click',app.button('resume'));assert.equal(app.run('page'),'agents');assert.match(app.html(),/尚未验证真实推理/);
});

test("launch failure unlocks controls, preserves choices and never copies a capability", async () => {
  const app=ui();app.run("renderActual();state.providers=[{id:'p',name:'Example',models:['m']}];Object.assign(firstRun,{providerId:'p',model:'m',agent:'aider',step:3});call=async()=>{throw new Error('spawn private-secret failed')}");
  await app.dispatch('click',app.button('launch'));assert.equal(app.run('firstRun.busy'),false);assert.equal(app.run('firstRun.done'),false);
  assert.match(app.html(),/启动没有完成/);assert.doesNotMatch(app.html(),/private-secret/);
  await app.dispatch('click',app.button('copy'));assert.equal(app.run('copied'),"es aider --model 'p/m'");
});

test("existing sources skip first-run takeover and dismissal does not remove saved sources", async () => {
  const app=ui();app.run("state.providers=[{id:'p',name:'Example',models:['m']}]");assert.equal(app.run('firstRunVisible()'),false);
  app.run('firstRun.active=true');await app.dispatch('click',app.button('dismiss'));assert.equal(app.run('firstRunVisible()'),false);assert.equal(app.run('state.providers.length'),1);
});


test("blank keys and malformed discovered IDs cannot create a source or enter a command", async () => {
  const app=ui();app.run("renderActual();agentList=[{id:'aider;bad',installed:true,can:{interactive:true}}]");
  assert.equal(app.run('firstRunAgents().length'),0);
  await app.dispatch('submit',app.form('source',{presetId:'example',apiKey:'   '}));
  assert.equal(app.run('requests.length'),0);assert.equal(app.run('firstRun.step'),1);
  app.run("agentList=[{id:'hermes',installed:true,can:{interactive:true}}];Object.assign(firstRun,{step:3,agent:'aider'});firstRunSync()");
  assert.equal(app.run('firstRun.agent'),'aider');
});
