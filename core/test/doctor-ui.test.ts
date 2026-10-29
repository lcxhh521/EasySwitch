import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {test} from "node:test";
function ui(){
 const handlers:Record<string,Array<(e:any)=>unknown>>={};const nodes:any={'#page':{},'#ver':{},'#guard-chip':{}};const added:any[]=[];
 const element=(tag:string)=>({tag,textContent:'',className:'',children:[] as any[],events:{} as any,append(...e:any[]){this.children.push(...e)},addEventListener(k:string,f:any){this.events[k]=f},remove(){}});
 const context=vm.createContext({URLSearchParams,AbortController,location:{search:'',hash:'#doctor'},window:{addEventListener(){}},history:{replaceState(){}},console,
 document:{addEventListener(k:string,f:any){(handlers[k]??=[]).push(f)},querySelector:(s:string)=>nodes[s]??null,querySelectorAll:()=>[],activeElement:null,createElement:element,body:{append(e:any){added.push(e)}}},
 setTimeout:()=>0,clearTimeout(){},requestAnimationFrame(){},fetch(){throw new Error('unexpected network')},FormData:class{f:any;constructor(f:any){this.f=f}get(k:string){return this.f.values[k]}}});
 for(const name of ['errors','doctor'])vm.runInContext(readFileSync(new URL(`../../web/${name}.js`,import.meta.url),'utf8'),context);
 vm.runInContext(readFileSync(new URL("../../web/overview.js", import.meta.url), "utf8"), context);
 const app=readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');vm.runInContext(app.slice(0,app.lastIndexOf('fetch("icons/manifest.json")')),context);
 const run=(s:string):any=>vm.runInContext(s,context);run(`globalThis.requests=[];globalThis.report={version:1,mode:'metadata',status:'warn',notice:'metadata only',findings:[{code:'source_disabled',title:'来源已关闭',status:'warn',message:'保持关闭',nextStep:'去来源页面',targetId:'p',actions:[{kind:'probe-provider',label:'检测来源',targetId:'p'}]}]};call=async(m,p,b,o)=>{requests.push({m,p,b,signal:o?.signal});return report;};`);
 const dispatch=async(k:string,target:any)=>{let stop=false;for(const f of handlers[k]??[]){await f({target,preventDefault(){},stopImmediatePropagation(){stop=true}});if(stop)break;}};
 const button=(kind:string,id='p')=>{const e:any={dataset:{doctorAction:kind,doctorTarget:id},disabled:false,closest:(s:string)=>s==='[data-doctor-action]'?e:null};return e;};
 return {run,dispatch,button,html:()=>nodes['#page'].innerHTML as string,added};
}
test('doctor direct navigation reads only its guarded metadata API, never state or account discovery',async()=>{
 const app=ui();await app.run('refresh(true)');assert.equal(app.run('requests.length'),1);assert.equal(app.run('requests[0].p'),'/api/doctor');assert.match(app.html(),/来源已关闭/);assert.match(app.html(),/不会读取密钥/);
});
test('account recovery opens settings without running a check or changing account state',async()=>{
 const app=ui();app.run('globalThis.visits=[];refresh=async()=>{visits.push(page)}');
 await app.dispatch('click',app.button('open-settings'));
 assert.equal(app.run('page'),'settings');assert.equal(app.run('requests.length'),0);assert.equal(app.run('visits[0]'),'settings');
});
test('active source and CLI checks require specific visible confirmation and suppress repeated submissions',async()=>{
 const app=ui();await app.run('refresh(true)');await app.dispatch('click',app.button('probe-provider'));assert.equal(app.run('requests.length'),1);assert.match(app.html(),/可能产生费用/);
 const form={values:{ack:''},matches:(s:string)=>s==='[data-doctor-confirm]'};await app.dispatch('submit',form);assert.equal(app.run('requests.length'),1);
 app.run("call=(m,p,b,o)=>{requests.push({m,p,b,signal:o?.signal});return new Promise(resolve=>globalThis.finish=()=>resolve(report))}");form.values.ack='on';const pending=app.dispatch('submit',form);await new Promise(r=>setImmediate(r));await app.dispatch('submit',form);assert.equal(app.run('requests.length'),2);
 assert.equal(app.run('requests[1].b.acknowledgeSourceRequests'),true);assert.equal(app.run('requests[1].b.acknowledgeCliExecution'),undefined);app.run('finish()');await pending;assert.equal(app.run('doctorBusy'),false);
 await app.dispatch('click',app.button('check-agent-help','aider'));assert.match(app.html(),/可能读取自己的配置或登录状态/);
});
test('cancel aborts the in-flight diagnostic and failures restore a safe retry state',async()=>{
 const app=ui();await app.run('refresh(true)');await app.dispatch('click',app.button('probe-provider'));
 app.run("call=(m,p,b,o)=>new Promise((resolve,reject)=>o.signal.addEventListener('abort',()=>reject(new Error('private-key raw failure'))))");
 const pending=app.dispatch('submit',{values:{ack:'on'},matches:(s:string)=>s==='[data-doctor-confirm]'});await new Promise(r=>setImmediate(r));await app.dispatch('click',app.button('cancel'));await pending;
 assert.equal(app.run('doctorBusy'),false);assert.match(app.html(),/已取消主动检查/);assert.doesNotMatch(app.html(),/private-key|raw failure/);
});
test('error API, message body and details never expose raw secrets; actions and folded details are retained',async()=>{
 const app=ui();const source=readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');const call=source.slice(source.indexOf('async function call('),source.indexOf('\nlet monoIcons'));
 app.run(call);app.run("fetch=async()=>({ok:false,status:401,json:async()=>({error:'private-secret HTTP 401',code:'invalid_api_key'})})");
 await assert.rejects(app.run("call('POST','/api/providers',{})"),(error:any)=>{assert.equal(error.code,'source_auth_required');assert.doesNotMatch(error.message,/private-secret|401|HTTP/);return true});
 app.run("showError({code:'helper_missing',message:'private-secret ENOENT'})");const toast=app.added[0];assert.doesNotMatch(toast.textContent,/private-secret|ENOENT/);assert.ok(toast.children.some((e:any)=>e.tag==='button'));assert.ok(toast.children.some((e:any)=>e.tag==='details'));
});
test('self-check IDs, messages and action labels are escaped and repair instructions do not execute commands',async()=>{
 const app=ui();app.run("report.findings[0].title='<img src=x>';report.findings[0].targetId='<svg>'");await app.run('refresh(true)');assert.match(app.html(),/&lt;img/);assert.doesNotMatch(app.html(),/<img|<svg/);
 await app.dispatch('click',app.button('open-helper-help'));assert.match(app.html(),/不会替你创建证书/);assert.equal(app.run('requests.length'),1);
});


test('menu-bar failures use safe API wording or fixed local guidance instead of process error interpolation',()=>{
 const source=readFileSync(new URL('../../menubar/main.swift',import.meta.url),'utf8');
 assert.match(source,/payload\?\["uiError"\]/);assert.match(source,/a\.addButton\(withTitle: "打开控制台"\)/);
 assert.doesNotMatch(source,/alert\("启动失败", "\\\(error\)"\)|alert\("没能启动增强会话", body\)/);
});

function destinationUi() {
 const app=ui();
 app.run(`globalThis.snapshot={providers:[{id:'one',name:'Same'},{id:'two',name:'Same'},{id:'three',name:'Same'}],bindings:{},profiles:[],accounts:[]};globalThis.clients=[{id:'aider',installed:true},{id:'hermes',installed:false}];
 globalThis.originalRenderAgents=renderAgents;
 clientCard=a=>'<button data-agent-select="'+a.id+'">'+a.id+'</button>';clientDetail=a=>'<section id="client-detail">'+a.id+'</section>';experimentalAgentsCard=()=>'';
 renderProviders=()=>'<section data-open="'+openProvider+'" data-segment="'+sourceSegment+'"></section>';
 call=async(m,p,b)=>{requests.push({m,p,b});if(p==='/api/state')return snapshot;if(p==='/api/agents')return {agents:clients};if(p==='/api/plan')return {accounts:[]};return {};};`);
 return app;
}
test('diagnostic provider links target exact ID across duplicate labels and stale filters without mutations',async()=>{
 for(const kind of ['open-providers','open-login']){
  const app=destinationUi();app.run("sourceSegment='subscriptions';openProvider='one'");
  await app.dispatch('click',app.button(kind,'two'));
  assert.equal(app.run('page'),'providers');assert.equal(app.run('sourceSegment'),'all');assert.equal(app.run('openProvider'),'two');
  assert.match(app.html(),/已定位自检对象：two/);assert.equal(app.run('requests.every(r=>r.m===\"GET\")'),true);
 }
});
test('diagnostic client links select installed or available target and never launch or inspect programs',async()=>{
 for(const [id,segment] of [['aider','installed'],['hermes','available']] as const){
  const app=destinationUi();await app.dispatch('click',app.button('open-agents',id));
  assert.equal(app.run('selectedAgent'),id);assert.equal(app.run('agentSegment'),segment);assert.match(app.html(),new RegExp('id="client-detail">'+id));
  assert.equal(app.run('requests.every(r=>r.m===\"GET\")'),true);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(requests.map(r=>r.p))')),['/api/state','/api/chatgpt','/api/claude-desktop','/api/agents']);
 }
});
test('missing or unsafe targets show an explicit recovery notice rather than selecting a different object',async()=>{
 for(const id of ['gone','sk-secret','es-session-unsafe','<img>','']) for(const kind of ['open-providers','open-agents']){
  const app=destinationUi();await app.dispatch('click',app.button(kind,id));
  assert.match(app.html(),/已变化或不在当前列表/);assert.doesNotMatch(app.html(),/<img>|id="client-detail"/);
  assert.equal(app.run(kind==='open-agents'?'selectedAgent':'openProvider'),null);
  assert.equal(app.run('requests.every(r=>r.m===\"GET\")'),true);
 }
});
test('a failed client metadata refresh never locates an object from an older cached list',async()=>{
 const app=destinationUi();app.run("agentList=clients;agentListNavigationVersion=0;globalThis.read=call;call=(m,p,b)=>p==='/api/agents'?Promise.reject(new Error('offline')):read(m,p,b)");
 await app.dispatch('click',app.button('open-agents','aider'));
 assert.match(app.html(),/未能读取最新客户端列表/);assert.equal(app.run('selectedAgent'),null);assert.doesNotMatch(app.html(),/id="client-detail"/);
});
test('targetless and global-budget diagnostic actions preserve general navigation without object targeting',async()=>{
 for(const [action,target] of [['open-providers','providers'],['open-agents','agents'],['open-budget','usage']] as const){
  const app=destinationUi();app.run('renderUsage=()=>"usage";loadUsage=async()=>null');const button=app.button(action);if(action!=='open-budget')delete button.dataset.doctorTarget;
  await app.dispatch('click',button);assert.equal(app.run('page'),target);assert.equal(app.run('doctorDestination'),null);
 }
});
test('slow diagnostic navigation cannot redirect or select after a newer page visit',async()=>{
 const app=destinationUi();app.run(`globalThis.read=call;globalThis.release=null;call=(m,p,b)=>p==='/api/state' && !release ? new Promise(r=>{release=()=>r(snapshot)}) : read(m,p,b);renderSettings=()=>'<div>settings</div>'`);
 const pending=app.dispatch('click',app.button('open-providers','two'));await new Promise(r=>setImmediate(r));
 assert.match(app.html(),/正在读取模型/);assert.doesNotMatch(app.html(),/data-open=/);
 await app.run("navigatePage('settings')");app.run('release()');await pending;
 assert.equal(app.run('page'),'settings');assert.equal(app.run('openProvider'),null);assert.match(app.html(),/settings/);assert.doesNotMatch(app.html(),/已定位/);
});
test('explicit client selection leaves diagnostic recovery and allows normal selection again',async()=>{
 const app=destinationUi();await app.dispatch('click',app.button('open-agents','gone'));
 app.run("selectClient('aider','installed')");assert.equal(app.run('doctorDestination'),null);assert.equal(app.run('selectedAgent'),'aider');assert.match(app.html(),/id="client-detail">aider/);
});
test('queued repeated diagnostic clicks cannot replace an in-flight target or issue another read',async()=>{
 const app=destinationUi();app.run(`globalThis.read=call;call=(m,p,b)=>p==='/api/state'?new Promise(r=>{globalThis.release=()=>r(snapshot)}):read(m,p,b)`);
 const pending=app.dispatch('click',app.button('open-providers','two'));await new Promise(r=>setImmediate(r));
 await app.dispatch('click',app.button('open-providers','three'));assert.equal(app.run('doctorDestination.id'),'two');
 app.run('release()');await pending;assert.equal(app.run('openProvider'),'two');
});
test('diagnostic focus lands on the exact object once, or on the recovery notice, without activating it',async()=>{
 for(const id of ['two','gone']){
  const app=destinationUi();app.run(`globalThis.focused=[];globalThis.scrolled=[];globalThis.query=document.querySelector;document.querySelector=s=>s.startsWith('[data-')?{focus:()=>focused.push(s),scrollIntoView:()=>scrolled.push(s)}:query(s)`);
  await app.dispatch('click',app.button('open-providers',id));
  assert.equal(app.run('focused[0]'),id==='two'?'[data-source-detail="two"]':'[data-doctor-destination]');
  app.run('render()');assert.equal(app.run('focused.length'),1);assert.equal(app.run('scrolled.length'),1);
  assert.equal(app.run('requests.every(r=>r.m===\"GET\")'),true);
 }
});
test('a located object removed by later refresh never silently falls back to another object',async()=>{
 for(const [kind,id] of [['open-providers','two'],['open-agents','aider']] as const){
  const app=destinationUi();await app.dispatch('click',app.button(kind,id));
  app.run(kind==='open-providers'?"snapshot.providers=snapshot.providers.filter(p=>p.id!=='two')":"clients=clients.filter(a=>a.id!=='aider')");
  await app.run('refresh(true)');assert.match(app.html(),/没有自动选择其他对象/);
  assert.equal(app.run(kind==='open-providers'?'openProvider':'selectedAgent'),null);assert.doesNotMatch(app.html(),/id="client-detail"/);
 }
});
test('Claude desktop diagnostic opens its existing experimental section without selecting or launching a different client',async()=>{
 const app=destinationUi();app.run("clients.push({id:'claude-desktop',installed:true});globalThis.focused=[];globalThis.query=document.querySelector;document.querySelector=s=>s==='details[data-keep=\"experimental-agents\"] > summary'?{focus:()=>focused.push(s),scrollIntoView(){}}:query(s)");
 await app.dispatch('click',app.button('open-agents','claude-desktop'));
 assert.equal(app.run('selectedAgent'),null);assert.equal(app.run('openDetails.has(\"experimental-agents\")'),true);
 assert.equal(app.run('focused[0]'),'details[data-keep="experimental-agents"] > summary');
 assert.doesNotMatch(app.html(),/不在当前列表|id="client-detail"/);assert.equal(app.run('requests.every(r=>r.m===\"GET\")'),true);
});
test('a located client changing installation status stays the same ID across both segments',async()=>{
 for(const [id,installed] of [['aider',false],['hermes',true]] as const){
  const app=destinationUi();await app.dispatch('click',app.button('open-agents',id));
  app.run(`clients=clients.map(a=>a.id===${JSON.stringify(id)}?{...a,installed:${installed}}:a)`);
  await app.run('refresh(true)');
  assert.equal(app.run('selectedAgent'),id);assert.equal(app.run('agentSegment'),installed?'installed':'available');
  assert.match(app.html(),new RegExp('id="client-detail">'+id));assert.equal(app.run('requests.every(r=>r.m===\"GET\")'),true);
 }
});
