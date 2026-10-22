import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

// VM event/state fixtures only: no browser acceptance, executable, account or model traffic.
const web = (name: string) => readFileSync(new URL(`../../web/${name}`, import.meta.url), "utf8");
function fixture() {
  const handlers: Record<string, any[]> = {}, windowHandlers: Record<string, any> = {};
  const c = vm.createContext({ Date, AbortController, URLSearchParams, location: { search: "", hash: "#agents" }, history: { replaceState() {}, pushState() {} },
    window: { addEventListener(name: string, fn: any) { windowHandlers[name] = fn; } },
    document: { activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener(name: string, fn: any) { (handlers[name] ??= []).push(fn); } },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {}, fetch() { assert.fail("No real fetch in synthetic UI"); },
  });
  for (const file of ["errors.js", "controls.js", "automatic-pools.js"]) vm.runInContext(web(file), c);
  vm.runInContext(readFileSync(new URL("../../web/overview.js", import.meta.url), "utf8"), c);
  const app = web("app.js"); vm.runInContext(app.slice(0, app.lastIndexOf('fetch("icons/manifest.json")')), c);
  const run = (source: string): any => vm.runInContext(source, c);
  run(`state={automaticToolLaunchReviews:{opencode:'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'},providers:[{id:'source',name:'Source',models:['m']},{id:'backup',name:'Backup',models:['m']}],pools:[{id:'auto',name:'Auto',strategy:'automatic',automaticToolsApprovalId:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',createdAt:'fixture',members:['source/m','backup/m'],automaticApproval:{version:1,members:[{member:'source/m',keyId:'a',credentialLabel:'Key A'},{member:'backup/m',keyId:'b',credentialLabel:'Key B'}]}}],bindings:{opencode:{harness:'opencode',providerId:'pool',model:'auto'},claude:{providerId:'source',model:'m'}},prefs:{opencode:{tiers:{small:'backup/m'}}},profiles:[],sessionDetails:[],sessions:[],native:[],log:[],selectableModels:['source/m','backup/m','pool/auto']};agentList=[{id:'opencode',name:'OpenCode',installed:true,can:{interactive:true,efforts:[],tiers:[]}}];globalThis.requests=[];globalThis.messages=[];render=()=>{};refresh=async()=>true;toast=m=>messages.push(m);globalThis.latest=JSON.parse(JSON.stringify(state));globalThis.reply={model:'pool/auto'};call=async(method,path,body)=>{requests.push({method,path,...(body===undefined?{}:{body})});return method==='GET'?latest:reply};`);
  const target = (selector: string, data: any = {}) => { const node: any = { dataset: data, disabled: false, matches: (value: string) => value === selector, hasAttribute: (key: string) => selector === `[${key}]`, closest: (value: string) => value.split(",").map(x => x.trim()).includes(selector) ? node : null }; return node; };
  const dispatch = async (selector: string, data: any = {}) => { let stopped = false; const event = { target: target(selector, data), preventDefault() {}, stopImmediatePropagation() { stopped = true; } }; for (const handler of handlers.click ?? []) { await handler(event); if (stopped) break; } };
  return { run, c, dispatch, windowHandlers, start: () => dispatch("[data-automatic-tool-start]", { automaticToolStart: "opencode" }), confirm: () => dispatch("[data-automatic-tool-confirm]") };
}
const posts = (f: ReturnType<typeof fixture>) => f.run("requests.filter(r=>r.method==='POST').length");

test("tool launch has a separate explicit OpenCode-only entry for an installed interactive confirmed automatic binding", () => {
  const f = fixture(); assert.match(f.run("genericAgentRow(agentList[0])"), /data-automatic-tool-start="opencode"[^>]*>新开工具会话/);
  for (const change of ["agentList[0].installed=false", "agentList[0].can.interactive=false", "agentList[0].where='/fixture/OpenCode.app'", "state.bindings.opencode={providerId:'source',model:'m'}", "state.pools[0].strategy='order'", "delete state.pools[0].automaticApproval", "delete state.pools[0].automaticToolsApprovalId", "delete state.automaticToolLaunchReviews", "state.automaticToolLaunchReviews.opencode='invalid'", "state.pools[0].automaticApproval.members.reverse()", "state.selectableModels=['source/m']", "page='providers'"]) {
    const each = fixture(); each.run(change); assert.doesNotMatch(each.run("automaticToolEntry('opencode')"), /data-automatic-tool-start/);
  }
  assert.equal(f.run("automaticToolEntry('claude')"), ""); assert.equal(posts(f), 0);
});

test("one review explains launch-wide affinity, no resend or recovery, limited function support, and fixed-source exit", async () => {
  const f = fixture(); await f.start(); const html = f.run("automaticToolCard()");
  for (const pattern of [/普通函数工具试用/, /同.*自动模型.*子任务/, /固定来源和 Key/, /已发送.*不.*自动重试/, /网关重启.*新开/, /标准 Chat function/, /未.*真实 OpenCode.*验证/, /「主模型」.*固定来源/, /固定小模型.*不变/, /Key A/, /Key B/, /确认并新开工具会话/, /不支持.*思考档位/]) assert.match(html, pattern);
  assert.equal(posts(f), 0); assert.equal(f.run("requests.length"), 0);
  assert.doesNotMatch(html, /仅纯文字试用：常见编程 Agent 的工具请求会被拒绝|data-automatic-confirm|<input/);
  assert.match(f.run("automaticPoolEntry('opencode')"), /普通启动.*纯文字/);
});

test("tool confirmation checks current state then sends exact chosen pool once without changing existing preferences", async () => {
  const f = fixture(); await f.start(); await f.confirm();
  assert.equal(f.run("JSON.stringify(requests)"), JSON.stringify([{ method: "GET", path: "/api/state" }, { method: "POST", path: "/api/agents/opencode/launch", body: { model: "pool/auto", automaticTools: true, automaticToolsApprovalId: "a".repeat(64), automaticToolsLaunchReviewId: "c".repeat(64) } }]));
  assert.equal(f.run("state.prefs.opencode.tiers.small"), "backup/m"); assert.equal(f.run("state.bindings.opencode.model"), "auto");
  await f.confirm(); assert.equal(posts(f), 1); assert.match(f.run("messages.join('')"), /新开.*工具会话/);
});

test("ordinary launch still sends empty options and never opts into tools", async () => {
  const f = fixture(); await f.start(); await f.dispatch("[data-agent-launch]", { agentLaunch: "opencode" }); await f.confirm();
  assert.equal(f.run("JSON.stringify(requests)"), JSON.stringify([{ method: "POST", path: "/api/agents/opencode/launch", body: {} }]));
});

test("binding, members, confirmation, preferences or selectability changes before confirmation refuse rather than substitute", async () => {
  for (const change of ["state.bindings.opencode.model='other'", "state.automaticToolLaunchReviews.opencode='d'.repeat(64)", "state.bindings.opencode.effort='high'", "state.pools[0].members.reverse()", "state.pools[0].automaticToolsApprovalId='b'.repeat(64)", "state.pools[0].automaticApproval.members[0].keyId='new'", "state.pools[0].automaticApproval.members[0].credentialLabel='New key'", "state.prefs.opencode.tiers.small='source/m'", "state.selectableModels=[]"]) {
    const f = fixture(); await f.start(); f.run(change); await f.confirm(); assert.equal(posts(f), 0); assert.doesNotMatch(f.run("automaticToolCard()"), /data-automatic-tool-confirm/);
  }
});

test("the final asynchronous state read cannot replace the reviewed model, membership, or key", async () => {
  for (const change of ["latest.bindings.opencode.model='other'", "latest.automaticToolLaunchReviews.opencode='d'.repeat(64)", "delete latest.automaticToolLaunchReviews", "latest.pools[0].members.reverse()", "latest.pools[0].automaticToolsApprovalId='b'.repeat(64)", "latest.pools[0].automaticApproval.members[0].keyId='new'", "latest.pools=[]", "latest=null"]) {
    const f = fixture(); await f.start(); f.run(change); await f.confirm(); assert.equal(posts(f), 0); assert.match(f.run("messages.join('')"), /变化|核对|无法/);
  }
});

test("duplicate confirmation and entry clicks during preflight or launch cannot issue a second POST", async () => {
  const f = fixture(); await f.start(); f.run("call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finish=resolve)}");
  const pending = f.confirm(); await f.confirm(); await f.start(); assert.equal(f.run("requests.length"), 1);
  f.run("finish(latest)"); await new Promise(resolve => setImmediate(resolve)); assert.equal(posts(f), 1);
  await f.confirm(); await f.start(); assert.match(f.run("automaticToolEntry('opencode')"), /disabled/); assert.equal(posts(f), 1);
  f.run("finish(reply)"); await pending;
});

test("leaving, cancelling or opening the picker during preflight prevents a late launch", async () => {
  for (const change of ["automaticPoolInvalidate();pageNavigationVersion++;page='providers'", "automaticPoolInvalidate();pageNavigationVersion+=2", "automaticToolInvalidate()", "state.bindings.opencode.model='other'"]) {
    const f = fixture(); await f.start(); f.run("call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finish=resolve)}");
    const pending = f.confirm(); await new Promise(resolve => setImmediate(resolve)); f.run(change); f.run("finish(latest)"); await pending; assert.equal(posts(f), 0);
  }
});

test("an observed changed binding remains invalid after ABA or re-render, never restoring launch authority", async () => {
  const f = fixture(); await f.start(); f.run("state.bindings.opencode.model='other';automaticToolSync();state.bindings.opencode.model='auto';automaticToolSync()"); await f.confirm(); assert.equal(posts(f), 0);
  assert.match(web("app.js"), /state = nextState;\s*if \(typeof automaticToolSync/);
});

test("unknown launch result is never retried, resumed by refresh/navigation or exposed as raw errors", async () => {
  for (const failure of ["throw new Error('private-upstream-secret')", "throw {status:503}", "return {model:'other'}"]) {
    const f = fixture(); await f.start(); f.run(`call=async(method,path,body)=>{requests.push({method,path,body});if(method==='GET')return latest;${failure}}`); await f.confirm();
    assert.match(f.run("automaticToolCard()"), /启动结果尚未确定/); assert.doesNotMatch(f.run("automaticToolCard()"), /private-upstream-secret|data-automatic-tool-confirm/);
    f.run("automaticPoolInvalidate();pageNavigationVersion+=2"); await f.run("refresh(true)"); await f.start(); await f.confirm(); assert.equal(posts(f), 1);
    await f.dispatch("[data-agent-launch]", { agentLaunch: "opencode" }); assert.equal(posts(f), 1);
  }
});

test("late launch completion after navigation never restores review or fires another launch", async () => {
  const f = fixture(); await f.start(); f.run("call=async(method,path,body)=>{requests.push({method,path,body});return method==='GET'?latest:new Promise(resolve=>globalThis.finish=resolve)}");
  const pending = f.confirm(); await new Promise(resolve => setImmediate(resolve)); f.run("automaticPoolInvalidate();pageNavigationVersion++;page='providers'"); f.run("finish(reply)"); await pending;
  assert.equal(posts(f), 1); assert.equal(f.run("messages.length"), 0); assert.equal(f.run("automaticToolReview"), null);
});

test("known launch rejection needs a new explicit review; timeout remains unknown and blocks duplicate launch", async () => {
  for (const status of [400, 409]) { const f = fixture(); await f.start(); f.run(`call=async(method,path,body)=>{requests.push({method,path,body});if(method==='GET')return latest;throw {status:${status}}}`); await f.confirm(); await f.confirm(); assert.equal(posts(f), 1); assert.match(f.run("messages.join('')"), /核对|不支持/); }
  const f = fixture(); await f.start(); f.run("globalThis.expire=null;setTimeout=fn=>{expire=fn;return 1};call=async(method,path,body)=>{requests.push({method,path,body});return method==='GET'?latest:new Promise(()=>{})}");
  const pending = f.confirm(); await new Promise(resolve => setImmediate(resolve)); f.run("expire()"); await pending; assert.match(f.run("automaticToolCard()"), /启动结果尚未确定/); await f.start(); await f.confirm(); assert.equal(posts(f), 1);
});

test("tool review safely renders labels and does not store launch authority or revive removed task dispatch", async () => {
  const f = fixture(); f.run("state.pools[0].name='<script>bad</script>';state.pools[0].automaticApproval.members[0].credentialLabel='<img src=x>';state.pools[0].automaticApproval.secret='never-render'"); await f.start();
  assert.match(f.run("automaticToolCard()"), /&lt;script&gt;/); assert.match(f.run("automaticToolCard()"), /&lt;img/); assert.doesNotMatch(f.run("automaticToolCard()"), /<script>|<img|never-render/);
  assert.doesNotMatch(web("automatic-pools.js"), /localStorage|sessionStorage|\/api\/tasks|\/api\/dispatch/);
});


test("actual navigation and hash-return paths discard a pending tool review", async () => {
  const f = fixture(); await f.start(); await f.run("navigatePage('providers')");
  f.c.location.hash = "#agents"; await f.windowHandlers.hashchange(); await f.confirm();
  assert.equal(posts(f), 0); assert.equal(f.run("automaticToolReview"), null);
});

test("preflight failure and late read after timeout never issue launch or restore a review", async () => {
  const f = fixture(); await f.start(); f.run("globalThis.expire=null;setTimeout=fn=>{expire=fn;return 1};call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finish=resolve)}");
  const pending = f.confirm(); await new Promise(resolve => setImmediate(resolve)); f.run("expire()"); await pending; f.run("finish(latest)");
  await f.confirm(); assert.equal(posts(f), 0); assert.equal(f.run("automaticToolUncertain"), null); assert.equal(f.run("automaticToolReview"), null);
});

test("OpenCode pool-setup warning distinguishes ordinary startup from separately confirmed tool trial", () => {
  const f = fixture(); assert.match(f.run("automaticPoolScopeWarning('opencode')"), /普通启动.*纯文字.*普通启动.*拒绝工具/);
  assert.match(f.run("automaticPoolScopeWarning('opencode')"), /另点「新开工具会话」确认/);
  f.run("delete state.pools[0].automaticToolsApprovalId"); assert.doesNotMatch(f.run("automaticPoolEntry('opencode')"), /「新开工具会话」/);
});

test("full-document pagehide discards preflight authority even if the document later returns from bfcache", async () => {
  const f = fixture(); await f.start(); f.run("call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finish=resolve)}");
  const pending = f.confirm(); await new Promise(resolve => setImmediate(resolve)); f.windowHandlers.pagehide(); f.run("finish(latest)"); await pending;
  await f.confirm(); assert.equal(posts(f), 0); assert.equal(f.run("automaticToolReview"), null);
});


test("nondefault effort disables tool trial with an explicit reset and never silently clears preferences", async () => {
  const f = fixture(); f.run("state.prefs.opencode.effort='high'");
  const html = f.run("automaticToolEntry('opencode')");
  assert.match(html, /data-automatic-tool-start="opencode"[^>]*disabled/);
  assert.match(html, /不支持.*思考档位/); assert.match(html, /data-automatic-tool-reset-effort[^>]*>恢复默认档位/);
  await f.start(); await f.confirm(); assert.equal(f.run("requests.length"), 0); assert.equal(f.run("state.prefs.opencode.effort"), "high");
});

test("explicit effort reset reuses the existing narrow setter without launching or changing tiers", async () => {
  const f = fixture(); f.run("state.prefs.opencode.effort='high';reply={tiers:{small:'backup/m'}}");
  await f.dispatch("[data-automatic-tool-reset-effort]");
  assert.equal(f.run("JSON.stringify(requests)"), JSON.stringify([{ method: "PUT", path: "/api/bindings/opencode/effort", body: { effort: "" } }]));
  assert.equal(posts(f), 0); assert.equal(f.run("state.prefs.opencode.tiers.small"), "backup/m"); assert.equal(f.run("state.bindings.opencode.model"), "auto");
  assert.match(f.run("messages.join('')"), /默认档位.*未启动|未启动.*默认档位/);
});

test("effort reset is single-flight, does not restore stale review, and a late response never launches", async () => {
  const f = fixture(); await f.start(); f.run("state.prefs.opencode.effort='high';call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finish=resolve)}");
  const pending = f.dispatch("[data-automatic-tool-reset-effort]"); await new Promise(resolve => setImmediate(resolve)); assert.equal(f.run("requests.length"), 1); await f.dispatch("[data-automatic-tool-reset-effort]"); await f.start(); await f.confirm();
  assert.equal(f.run("requests.length"), 1); assert.equal(f.run("automaticToolReview"), null);
  f.run("automaticPoolInvalidate();pageNavigationVersion++;page='providers';finish({tiers:{small:'backup/m'}})"); await pending;
  assert.equal(posts(f), 0); assert.equal(f.run("messages.length"), 0);
});

test("reset failures never echo secrets, retry automatically, or authorize tool launch", async () => {
  const f = fixture(); f.run("state.prefs.opencode.effort='high';call=async(method,path,body)=>{requests.push({method,path,body});throw new Error('private-setting-error')}");
  await f.dispatch("[data-automatic-tool-reset-effort]"); await f.confirm();
  assert.equal(f.run("requests.length"), 1); assert.equal(posts(f), 0); assert.equal(f.run("state.prefs.opencode.effort"), "high");
  assert.doesNotMatch(f.run("messages.join('')"), /private-setting-error/); assert.match(f.run("messages.join('')"), /未.*确定|核对/);
});


test("effort reset accepts real default prefs without effort and rejects malformed success bodies", async () => {
  for (const reply of ["{}", "{tiers:{small:'backup/m'}}"]) {
    const f = fixture(); f.run(`state.prefs.opencode.effort='high';reply=${reply}`); await f.dispatch("[data-automatic-tool-reset-effort]");
    assert.match(f.run("messages.join('')"), /已恢复默认档位/); assert.equal(posts(f), 0);
  }
  for (const reply of ["null", "[]", "{effort:'high'}", "{effort:null}", "{error:'unexpected'}", "{tiers:[]}", "{tiers:{small:42}}", "{fallbackModel:42}", "'unexpected'"]) {
    const f = fixture(); f.run(`state.prefs.opencode.effort='high';reply=${reply}`); await f.dispatch("[data-automatic-tool-reset-effort]");
    assert.match(f.run("messages.join('')"), /尚未确定/); assert.doesNotMatch(f.run("messages.join('')"), /已恢复默认档位/); assert.equal(posts(f), 0);
  }
});
