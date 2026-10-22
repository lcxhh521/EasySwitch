import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const web = (name: string) => readFileSync(new URL(`../../web/${name}`, import.meta.url), "utf8");
const preview = () => ({ confirmationId: "confirm-fixture", expiresAt: new Date(Date.now() + 60_000).toISOString(), model: "m", primaryModelId: "source/m", harness: "claude", members: [{ modelId: "source/m", providerName: "Source", keyLabel: "Key A", billing: "usage" }, { modelId: "backup/m", providerName: "Backup", keyLabel: "Key B", billing: "subscription" }] });
function fixture() {
  const handlers: Record<string, any[]> = {};
  const c = vm.createContext({ Date, AbortController, setTimeout, clearTimeout, state: { bindings: { claude: { providerId: "source", model: "m" } }, pools: [], selectableModels: ["source/m", "backup/m"] }, page: "agents", pageNavigationVersion: 0,
    document: { addEventListener(name: string, h: any) { (handlers[name] ??= []).push(h); } },
    esc: (s: any) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
    agentMeta: (id: string) => ({ name: id }), selectableModelNames: () => c.state?.selectableModels ?? [], modelSelectionReason: () => "来源不可用",
    render() {}, toast() {}, userErrorMessage: () => "操作未完成", refresh: async () => true,
    call: async () => preview(),
  });
  vm.runInContext(web("automatic-pools.js"), c);
  const run = (s: string): any => vm.runInContext(s, c);
  run(`globalThis.requests=[];globalThis.messages=[];globalThis.refreshes=0;toast=m=>messages.push(m);refresh=async()=>{refreshes++;return true};globalThis.reply=${JSON.stringify(preview())};call=async(method,path,body)=>{requests.push({method,path,body});return reply};`);
  return { c, run, preview: () => run("automaticPoolStart('claude')") as Promise<void>, confirm: () => run("automaticPoolConfirm()") as Promise<void> };
}

test("optional automatic entry is loaded once, attached to both existing Agent rows, and never to first-run draft", () => {
  const index = web("index.html"), app = web("app.js");
  assert.equal(index.match(/src="automatic-pools.js"/g)?.length, 1);
  assert.ok(index.indexOf('src="automatic-pools.js"') < index.indexOf('src="app.js"'));
  assert.match(app, /automaticPoolEntry\(harness\)/); assert.match(app, /automaticPoolEntry\(a.id\)/); assert.match(app, /automaticPoolCard\(\)/);
  assert.doesNotMatch(web("onboarding-draft.js"), /confirmationId|automaticPool/);
});

test("entry requires an existing direct binding and retains pool identity without a fallback", () => {
  const f = fixture(); assert.match(f.run("automaticPoolEntry('claude')"), /自动选来源/);
  f.run("state.bindings.claude={providerId:'pool',model:'existing'}");
  assert.doesNotMatch(f.run("automaticPoolEntry('claude')"), /data-automatic-start/);
  f.run("delete state.bindings.claude"); assert.equal(f.run("automaticPoolEntry('claude')"), "");
});

test("preview is one explicit metadata request, never an inference, binding write or launch", async () => {
  const f = fixture(); await f.preview();
  assert.equal(f.run("JSON.stringify(requests)"), JSON.stringify([{ method: "POST", path: "/api/pools/automatic/preview", body: { modelId: "source/m", harness: "claude" } }]));
  assert.equal(f.run("state.bindings.claude.providerId"), "source");
  const html = f.run("automaticPoolCard()");
  for (const text of [/Source/, /Key A/, /按量计费/, /订阅/, /不同账号/, /不保证.*最低|不保证.*最便宜/, /不.*探测/, /最多.*2|最多.*两/, /开始输出/, /工具/, /确认并使用/]) assert.match(html, text);
  assert.doesNotMatch(html, /confirm-fixture|confirmationId|<input|权重|name="name"/);
});

test("review metadata is escaped and unknown billing is never described as free", async () => {
  const f = fixture(); f.run("reply.model='<img onerror=x>';reply.members[0].providerName='<script>x</script>';reply.members[0].keyLabel='\" onmouseover=x';reply.members[1].billing='unknown'");
  await f.preview(); const html = f.run("automaticPoolCard()");
  assert.match(html, /&lt;img/); assert.match(html, /&lt;script/); assert.match(html, /&quot;/); assert.match(html, /计费未知/); assert.doesNotMatch(html, /<img onerror|<script>|免费/);
});

test("double preview clicks share one pending request", async () => {
  const f = fixture(); f.run("call=async(...args)=>{requests.push(args);return new Promise(resolve=>globalThis.finish=resolve)}");
  const a = f.preview(); await f.preview(); assert.equal(f.run("requests.length"), 1);
  f.run("finish(reply)"); await a; assert.match(f.run("automaticPoolCard()"), /确认并使用/);
});

test("late preview cannot revive after cancellation, newer selection, or leave and return", async () => {
  for (const change of ["automaticPoolInvalidate()", "state.bindings.claude={providerId:'backup',model:'m'}", "pageNavigationVersion+=2"]) {
    const f = fixture(); f.run("call=async()=>new Promise(resolve=>globalThis.finish=resolve)"); const pending = f.preview(); f.run(change); f.run("finish(reply)"); await pending;
    await f.confirm(); assert.equal(f.run("requests.length"), 0); assert.doesNotMatch(f.run("automaticPoolCard()"), /id="automatic-pool-confirm"/);
  }
});

test("confirmation expires and mismatched preview identities cannot grant binding authority", async () => {
  for (const change of ["reply.primaryModelId='backup/m'", "reply.harness='aider'", "reply.members=[]", "reply.members[0].modelId='backup/m'", "reply.expiresAt='invalid'"]) {
    const f = fixture(); f.run(change); await f.preview(); await f.confirm(); assert.equal(f.run("requests.length"), 1);
    assert.doesNotMatch(f.run("automaticPoolCard()"), /id="automatic-pool-confirm"/);
  }
  const f = fixture(); await f.preview(); f.run("automaticPoolReview.preview.expiresAt=0"); await f.confirm(); assert.equal(f.run("requests.length"), 1); assert.match(f.run("automaticPoolCard()"), /重新核对/);
});

test("explicit confirmation sends only the memory-held ID, suppresses repeats, refreshes actual binding and never launches", async () => {
  const f = fixture(); await f.preview();
  f.run("call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finish=resolve)}");
  const pending = f.confirm(); await f.confirm(); assert.equal(f.run("requests.length"), 2);
  assert.equal(f.run("JSON.stringify(requests[1])"), JSON.stringify({ method: "POST", path: "/api/pools/automatic/confirm", body: { confirmationId: "confirm-fixture" } }));
  f.run("finish({pool:{id:'auto',strategy:'automatic'},binding:{harness:'claude',providerId:'pool',model:'auto'}})"); await pending;
  assert.equal(f.run("refreshes"), 1); assert.equal(f.run("state.bindings.claude.providerId"), "source"); assert.match(f.run("messages.join('')"), /未.*启动/);
});

test("409 and 400 require a new review, do not silently retry or change selection", async () => {
  for (const status of [409, 400]) { const f = fixture(); await f.preview(); f.run(`call=async(method,path,body)=>{requests.push({method,path,body});throw {status:${status}}}`); await f.confirm(); await f.confirm();
    assert.equal(f.run("requests.length"), 2); assert.equal(f.run("state.bindings.claude.providerId"), "source"); assert.match(f.run("automaticPoolCard()"), status === 409 ? /已变化|过期/ : /不支持|不可用/); }
});

test("unknown confirm outcome retains the same ID for explicit retry and blocks fresh duplicate creation", async () => {
  const f = fixture(); await f.preview(); f.run("call=async(method,path,body)=>{requests.push({method,path,body});throw new Error('network secret')}"); await f.confirm();
  assert.match(f.run("automaticPoolCard()"), /结果尚未确定/); assert.doesNotMatch(f.run("automaticPoolCard()"), /network secret/);
  await f.preview(); assert.equal(f.run("requests.length"), 2);
  f.run("call=async(method,path,body)=>{requests.push({method,path,body});return {pool:{id:'auto',strategy:'automatic'},binding:{harness:'claude',providerId:'pool',model:'auto'}}}"); await f.confirm();
  assert.equal(f.run("JSON.stringify(requests[1].body)"), f.run("JSON.stringify(requests[2].body)"));
});

test("navigation during confirmation never reuses late UI success or automatically launches", async () => {
  const f = fixture(); await f.preview(); f.run("call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finish=resolve)}");
  const pending = f.confirm(); f.run("automaticPoolInvalidate();pageNavigationVersion++;page='providers'");
  f.run("finish({pool:{id:'auto',strategy:'automatic'},binding:{harness:'claude',providerId:'pool',model:'auto'}})"); await pending;
  assert.equal(f.run("messages.length"), 0); assert.equal(f.run("requests.length"), 2); assert.equal(f.run("automaticPoolReview"), null);
});

test("uncertain save survives navigation without granting a new confirmation or writing storage", async () => {
  const f = fixture(); await f.preview(); f.run("call=async()=>{throw {status:503}}"); await f.confirm();
  f.run("automaticPoolInvalidate();pageNavigationVersion+=2"); await f.confirm(); await f.preview();
  assert.equal(f.run("requests.length"), 1); assert.match(f.run("automaticPoolCard()"), /上次|重新查看/);
  assert.doesNotMatch(web("automatic-pools.js"), /sessionStorage|localStorage|data-copy|clipboard|JSON.stringify/);
});

test("legacy pool editor cannot silently downgrade automatic strategy and navigation invalidates previews", () => {
  const app = web("app.js");
  assert.match(app, /p.strategy === "automatic" \? "已确认名单内自动选择"/);
  assert.match(app, /data-automatic-manage/); assert.match(app, /if \(p.strategy === "automatic"\)/);
  assert.match(app, /poolForm\?\.strategy === "automatic"/);
  assert.ok((app.match(/automaticPoolInvalidate\(\)/g) ?? []).length >= 3);
});

test("unknown save can be explicitly reconciled with the same ID after refresh shows a pool or a newer direct choice", async () => {
  for (const providerId of ["pool", "newer"]) {
    const f = fixture(); await f.preview();
    f.run("call=async(method,path,body)=>{requests.push({method,path,body});throw {status:503}}"); await f.confirm();
    f.run(`automaticPoolInvalidate();pageNavigationVersion+=2;state.bindings.claude={providerId:'${providerId}',model:'new-choice'}`);
    assert.match(f.run("automaticPoolCard()"), /核对上次保存结果/);
    f.run("call=async(method,path,body)=>{requests.push({method,path,body});return {pool:{id:'auto',strategy:'automatic'},binding:{harness:'claude',providerId:'pool',model:'auto'}}}");
    await f.run("automaticPoolResolve()");
    assert.equal(f.run("requests.length"), 3); assert.equal(f.run("requests[1].body.confirmationId"), f.run("requests[2].body.confirmationId"));
    assert.equal(f.run("state.bindings.claude.model"), "new-choice"); assert.equal(f.run("automaticPoolUncertain"), null);
  }
});

test("reconcile is explicit, single-flight, and a changed-binding rejection unlocks a fresh review", async () => {
  const f = fixture(); await f.preview(); f.run("call=async()=>{throw {status:503}}"); await f.confirm();
  f.run("automaticPoolInvalidate();pageNavigationVersion+=2;call=async(method,path,body)=>{requests.push({method,path,body});return new Promise((resolve,reject)=>globalThis.reject=reject)}");
  const pending = f.run("automaticPoolResolve()"); await f.run("automaticPoolResolve()"); await f.preview(); assert.equal(f.run("requests.length"), 2);
  f.run("reject({status:409})"); await pending; assert.equal(f.run("automaticPoolUncertain"), null);
});

test("preview and confirm errors never echo arbitrary upstream prose or hidden server fields", async () => {
  const f = fixture(); f.run("reply.secret='never-render';reply.digest='hidden';reply.members[0].endpoint='https://private.invalid';reply.members[0].key='secret-key'");
  await f.preview(); assert.doesNotMatch(f.run("automaticPoolCard()"), /never-render|hidden|private.invalid|secret-key/);
  assert.equal(f.run("Object.keys(automaticPoolReview.preview).sort().join(',')"), "confirmationId,expiresAt,members,model");
  assert.equal(f.run("Object.keys(automaticPoolReview.preview.members[0]).sort().join(',')"), "billing,keyLabel,modelId,providerName");
});

function integrated() {
  const handlers: Record<string, any[]> = {};
  const windowHandlers: Record<string, any> = {};
  const c = vm.createContext({ Date, AbortController, URLSearchParams, location: { search: "", hash: "#agents" }, history: { replaceState() {}, pushState() {} },
    window: { addEventListener(name: string, fn: any) { windowHandlers[name] = fn; } },
    document: { activeElement: null, querySelector: () => null, querySelectorAll: () => [], addEventListener(name: string, fn: any) { (handlers[name] ??= []).push(fn); } },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {}, fetch() { assert.fail("No real fetch in synthetic UI"); },
  });
  for (const file of ["errors.js", "controls.js", "automatic-pools.js"]) vm.runInContext(web(file), c);
  vm.runInContext(readFileSync(new URL("../../web/overview.js", import.meta.url), "utf8"), c);
  const app = web("app.js"); vm.runInContext(app.slice(0, app.lastIndexOf('fetch("icons/manifest.json")')), c);
  const run = (source: string): any => vm.runInContext(source, c);
  run(`state={providers:[{id:'source',name:'Source',models:['m'],icon:'letter:A'},{id:'backup',name:'Backup',models:['m']}],pools:[],bindings:{claude:{providerId:'source',model:'m'},aider:{providerId:'source',model:'m'}},prefs:{},profiles:[],sessionDetails:[],sessions:[],native:[],log:[],codexPath:'/fixture/codex',claudePath:'/fixture/claude'};agentList=[{id:'claude',name:'Claude Code',installed:true,can:{interactive:true,efforts:[],tiers:[]}},{id:'aider',name:'Aider',installed:true,can:{interactive:true,efforts:[],tiers:[]}}];globalThis.requests=[];globalThis.messages=[];render=()=>{};refresh=async()=>true;toast=m=>messages.push(m);globalThis.reply=${JSON.stringify(preview())};call=async(method,path,body)=>{requests.push({method,path,body});return reply};`);
  const target = (selector: string, data: any = {}) => { const node: any = { dataset: data, disabled: false, matches: (value: string) => value === selector, hasAttribute: (key: string) => selector === `[${key}]`, closest: (value: string) => value.split(",").map(x => x.trim()).includes(selector) ? node : null }; return node; };
  const dispatch = async (name: string, node: any) => { let stopped = false; const event = { target: node, preventDefault() {}, stopImmediatePropagation() { stopped = true; } }; for (const handler of handlers[name] ?? []) { await handler(event); if (stopped) break; } };
  return { run, target, dispatch, windowHandlers, c };
}

test("real app rendering gives each automatic action one ID and the event path binds only after confirmation", async () => {
  const f = integrated(); const html = f.run("agentRow('claude')+genericAgentRow(agentList[1])");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m: any) => m[1]); assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /id="automatic-pool-start-claude"/); assert.match(html, /id="automatic-pool-start-aider"/);
  await f.dispatch("click", f.target("[data-automatic-start]", { automaticStart: "claude" })); assert.equal(f.run("requests.length"), 1);
  const review = f.run("automaticPoolCard()"); assert.equal((review.match(/id="automatic-pool-confirm"/g) ?? []).length, 1);
  f.run("reply={pool:{id:'auto',strategy:'automatic'},binding:{harness:'claude',providerId:'pool',model:'auto'}}");
  await f.dispatch("click", f.target("[data-automatic-confirm]")); assert.equal(f.run("requests.length"), 2); assert.equal(f.run("requests[1].path"), "/api/pools/automatic/confirm");
});

test("automatic pool display omits legacy quota evidence and actual legacy edit/submit paths cannot downgrade it", async () => {
  const f = integrated(); f.run("state.pools=[{id:'auto',name:'Auto',strategy:'automatic',members:['source/m','backup/m'],signals:{members:[]}}]");
  const html = f.run("poolsCard()"); assert.match(html, /已确认名单内自动选择/); assert.match(html, /全部等待时暂停/); assert.match(html, /旧额度和失败标记不参与/); assert.doesNotMatch(html, /data-pool-edit="auto"|data-keep="pool-signals/);
  await f.dispatch("click", f.target("[data-pool-edit]", { poolEdit: "auto" })); assert.equal(f.run("poolForm"), null);
  for (const strategy of ["automatic", "order"]) { f.run(`poolForm={id:'auto',name:'Auto',strategy:'${strategy}',members:['source/m']}`); await f.dispatch("submit", f.target("form[data-pool-form]")); assert.equal(f.run("poolForm"), null); }
  assert.equal(f.run("requests.length"), 0);
});

test("real navigation and hash back invalidate a preview before a stale confirmation click", async () => {
  const f = integrated(); await f.run("automaticPoolStart('claude')"); await f.run("navigatePage('providers')");
  f.c.location.hash = "#agents"; await f.windowHandlers.hashchange(); await f.run("automaticPoolConfirm()");
  assert.equal(f.run("requests.length"), 1); assert.equal(f.run("automaticPoolReview"), null);
});

test("a stalled preview or confirm is bounded, and timed-out confirmation can only retry the same ID", async () => {
  const first = fixture(); first.run("globalThis.requestTimeout=null;setTimeout=fn=>{requestTimeout=fn;return 1};clearTimeout=()=>{};call=async()=>new Promise(()=>{})");
  const reading = first.preview(); assert.equal(first.run("typeof requestTimeout"), "function"); first.run("requestTimeout()"); await reading;
  assert.doesNotMatch(first.run("automaticPoolCard()"), /id="automatic-pool-confirm"/); assert.equal(first.run("automaticPoolReview.busy"), "");
  const second = fixture(); await second.preview(); second.run("globalThis.requestTimeout=null;setTimeout=fn=>{requestTimeout=fn;return 1};clearTimeout=()=>{};call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(()=>{})}");
  const saving = second.confirm(); assert.equal(second.run("typeof requestTimeout"), "function"); second.run("requestTimeout()"); await saving;
  assert.match(second.run("automaticPoolCard()"), /结果尚未确定/); await second.preview(); assert.equal(second.run("requests.length"), 2);
});

test("direct-source automatic entry visibly discloses plain-text trial before any click", () => {
  const f = fixture(); const html = f.run("automaticPoolEntry('claude')");
  assert.match(html, />自动选来源（仅纯文字试用）<\/button>/);
  assert.match(html, /title="[^"]*仅纯文字[^"]*工具请求会被拒绝[^"]*"/);
  assert.equal(f.run("requests.length"), 0); assert.equal(f.run("state.bindings.claude.providerId"), "source");
});

test("confirmation opens with prominent coding-tool refusal and an explicit fixed-source recovery path", async () => {
  const f = fixture(); await f.preview(); const html = f.run("automaticPoolCard()");
  assert.match(html, /<strong>仅纯文字试用：常见编程 Agent 的工具请求会被拒绝。<\/strong>/);
  assert.match(html, /工具会话请保留固定来源/);
  assert.match(html, /在该 Agent 卡片的「主模型」选择器选回固定来源即可恢复/);
  assert.ok(html.indexOf("工具请求会被拒绝") < html.indexOf("<ol>"));
  assert.match(html, /id="automatic-pool-confirm"[^>]*>确认并使用纯文字模式<\/button>/);
  assert.equal(f.run("requests.length"), 1); assert.equal(f.run("state.bindings.claude.providerId"), "source");
});

test("an automatic binding retains a persistent scope warning and recovery directions without silently switching sources", () => {
  const f = integrated(); f.run("state.pools=[{id:'auto',name:'Auto',strategy:'automatic',members:['source/m','backup/m']}];state.bindings.claude={providerId:'pool',model:'auto'}");
  const html = f.run("agentRow('claude')");
  assert.match(html, /仅纯文字试用/); assert.match(html, /工具请求会被拒绝/);
  assert.match(html, /本 Agent 卡片的「主模型」选择器选回固定来源/);
  assert.match(html, /data-pick="claude"/); assert.doesNotMatch(html, /data-automatic-start/);
  assert.equal(f.run("requests.length"), 0); assert.equal(f.run("state.bindings.claude.providerId"), "pool");
  f.run("state.pools[0].strategy='order'"); assert.doesNotMatch(f.run("automaticPoolEntry('claude')"), /仅纯文字试用/);
});

test("uncertain-save confirmation keeps the plain-text restriction visible during explicit retry or reconciliation", async () => {
  const f = fixture(); await f.preview(); f.run("call=async()=>{throw {status:503}}"); await f.confirm();
  assert.match(f.run("automaticPoolCard()"), /id="automatic-pool-confirm"[^>]*>重试同一次纯文字确认<\/button>/);
  f.run("automaticPoolInvalidate();pageNavigationVersion+=2");
  const html = f.run("automaticPoolCard()"); assert.match(html, /工具请求会被拒绝/); assert.match(html, /「主模型」选择器选回固定来源即可恢复/);
  assert.equal(f.run("requests.length"), 1);
});

test("automatic small-model bindings keep a persistent recovery notice while leaving the main-source entry unchanged", () => {
  const f = integrated(); f.run("state.pools=[{id:'auto',name:'Auto',strategy:'automatic',members:['source/m']}];state.prefs.claude={tiers:{small:'pool/auto'}}");
  const html = f.run("automaticPoolEntry('claude')");
  assert.match(html, /data-automatic-start="claude"/); assert.match(html, /小模型已使用纯文字自动模式/); assert.match(html, /工具请求会被拒绝/);
  assert.match(html, /对应小模型选择器改回固定来源或跟随主模型，下次启动生效/);
  assert.equal(f.run("requests.length"), 0); assert.equal(f.run("state.prefs.claude.tiers.small"), "pool/auto"); assert.equal(f.run("state.bindings.claude.providerId"), "source");
  f.run("delete state.bindings.claude"); assert.match(f.run("automaticPoolEntry('claude')"), /小模型已使用纯文字自动模式/);
  f.run("state.pools.push({id:'legacy',name:'Legacy',strategy:'order',members:['source/m']});state.bindings.claude={providerId:'pool',model:'legacy'}");
  assert.match(f.run("automaticPoolEntry('claude')"), /对应小模型选择器改回固定来源或跟随主模型/);
  f.run("state.pools[0].strategy='order'"); assert.equal(f.run("automaticPoolEntry('claude')"), "");
});
