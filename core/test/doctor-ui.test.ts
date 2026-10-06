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
 const app=readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');vm.runInContext(app.slice(0,app.lastIndexOf('fetch("icons/manifest.json")')),context);
 const run=(s:string):any=>vm.runInContext(s,context);run(`globalThis.requests=[];globalThis.report={version:1,mode:'metadata',status:'warn',notice:'metadata only',findings:[{code:'source_disabled',title:'来源已关闭',status:'warn',message:'保持关闭',nextStep:'去来源页面',targetId:'p',actions:[{kind:'probe-provider',label:'检测来源',targetId:'p'}]}]};call=async(m,p,b,o)=>{requests.push({m,p,b,signal:o?.signal});return report;};`);
 const dispatch=async(k:string,target:any)=>{let stop=false;for(const f of handlers[k]??[]){await f({target,preventDefault(){},stopImmediatePropagation(){stop=true}});if(stop)break;}};
 const button=(kind:string,id='p')=>{const e:any={dataset:{doctorAction:kind,doctorTarget:id},disabled:false,closest:(s:string)=>s==='[data-doctor-action]'?e:null};return e;};
 return {run,dispatch,button,html:()=>nodes['#page'].innerHTML as string,added};
}
test('doctor direct navigation reads only its guarded metadata API, never state or account discovery',async()=>{
 const app=ui();await app.run('refresh(true)');assert.equal(app.run('requests.length'),1);assert.equal(app.run('requests[0].p'),'/api/doctor');assert.match(app.html(),/来源已关闭/);assert.match(app.html(),/不会读取密钥/);
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
