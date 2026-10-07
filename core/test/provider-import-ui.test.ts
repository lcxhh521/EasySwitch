import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
function fixture(){
 const handlers:Record<string,Array<(e:any)=>unknown>>={},requests:any[]=[];let refreshes=0;
 const context=vm.createContext({document:{addEventListener(kind:string,fn:any){(handlers[kind]??=[]).push(fn);}},esc:(v:unknown)=>String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;"),render(){},refresh:async()=>{refreshes++;},userErrorMessage:()=>"操作没有完成，请检查设置。",call:async(...args:any[])=>{requests.push(args);return {previewId:"preview",sources:[{source:"opencodex",status:"ready"}],candidates:[{id:"candidate",source:"opencodex",name:"Fixture",baseUrl:"https://relay.invalid/v1",models:["m"],keyCount:1,importable:true}]};}});
 vm.runInContext(readFileSync(new URL("../../web/provider-import.js",import.meta.url),"utf8"),context);
 const run=(s:string):any=>vm.runInContext(s,context);
 const dispatch=async(kind:string,selector:string,props:any={})=>{const target:any={...props,closest:(s:string)=>s===selector?target:null,matches:(s:string)=>s===selector};for(const fn of handlers[kind]??[])await fn({target,preventDefault(){},stopImmediatePropagation(){}});};
 return {context,requests,run,html:()=>run("providerImportCard()") as string,dispatch,refreshes:()=>refreshes,open:()=>dispatch("click","[data-provider-import-open]"),cancel:()=>dispatch("click","[data-provider-import-cancel]"),source:(checked=true)=>dispatch("change","[data-provider-import-source]",{dataset:{providerImportSource:"opencodex"},checked}),choose:(checked=true,id="candidate")=>dispatch("change","[data-provider-import-candidate]",{dataset:{providerImportCandidate:id},checked}),scan:()=>dispatch("submit","[data-provider-import-scan]"),commit:()=>dispatch("submit","[data-provider-import-commit]")};
}
test("opening, rendering and unselected form submission never scan or import",async()=>{
 const f=fixture();assert.equal(f.html(),"");await f.open();assert.equal(f.requests.length,0);assert.equal(f.run("providerImportSources.size"),0);assert.equal(f.run("providerImportChosen.size"),0);
 assert.match(f.html(),/读取所选配置/);assert.match(f.html(),/默认关闭/);assert.doesNotMatch(f.html(),/ checked/);await f.scan();await f.commit();assert.equal(f.requests.length,0);
 await f.source();assert.equal(f.requests.length,0);await f.scan();assert.equal(f.requests.length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.requests[0])),["POST","/api/provider-import/preview",{sources:["opencodex"]}]);
 assert.equal(f.run("providerImportChosen.size"),0);await f.commit();assert.equal(f.requests.length,1);
});
test("selected import submits only server references and leaves saved sources off without a probe",async()=>{
 const f=fixture();await f.open();await f.source();await f.scan();await f.choose();f.run("call=async(...args)=>{globalThis.sent=args;return {imported:[{candidateId:'candidate',providerId:'saved'}],failed:[],rolledBack:false}};");await f.commit();
 assert.equal(f.run("JSON.stringify(sent)"),JSON.stringify(["POST","/api/provider-import/commit",{previewId:"preview",chosen:["candidate"]}]));assert.match(f.html(),/已导入 1 个来源，均保持关闭/);assert.equal(f.refreshes(),1);assert.equal(f.run("providerImportPreview"),null);
});
test("source changes invalidate selection without an automatic read and unsupported candidates cannot be chosen",async()=>{
 const f=fixture();await f.open();await f.source();await f.scan();f.run("providerImportPreview.candidates.push({id:'blocked',source:'codex',name:'Blocked',models:[],keyCount:0,importable:false,reason:'命令鉴权不支持'})");await f.choose(true,"blocked");assert.equal(f.run("providerImportChosen.size"),0);assert.match(f.html(),/命令鉴权不支持/);
 await f.choose();await f.source(false);assert.equal(f.run("providerImportPreview"),null);assert.equal(f.run("providerImportChosen.size"),0);assert.equal(f.requests.length,1);
});
test("double submissions are suppressed and late scan responses cannot reopen cancelled panels",async()=>{
 const f=fixture();await f.open();await f.source();f.run("globalThis.calls=0;call=()=>{calls++;return new Promise(resolve=>globalThis.finish=resolve)}");const pending=f.scan();await f.scan();assert.equal(f.run("calls"),1);assert.equal(f.run("providerImportBusy"),true);
 await f.cancel();await f.open();assert.equal(f.run("providerImportSources.size"),0);f.run("finish({previewId:'old',sources:[],candidates:[{id:'old'}]})");await pending;assert.equal(f.run("providerImportPreview"),null);assert.equal(f.run("providerImportBusy"),false);assert.doesNotMatch(f.html(),/old/);
});
test("closing during a save explains that saving continues and cannot overwrite a newly opened panel",async()=>{
 const f=fixture();await f.open();await f.source();await f.scan();await f.choose();f.run("globalThis.saves=0;call=()=>{saves++;return new Promise(resolve=>globalThis.finish=resolve)}");const pending=f.commit();await f.commit();assert.equal(f.run("saves"),1);assert.match(f.html(),/保存仍会继续/);
 await f.cancel();await f.open();f.run("finish({imported:[{}],failed:[]})");await pending;assert.equal(f.run("providerImportMessage"),"");assert.equal(f.run("providerImportSources.size"),0);assert.equal(f.refreshes(),0);
});
test("stale and failed commits require manual reread, expose fixed messages and unlock controls",async()=>{
 for(const outcome of ["stale","failed","unconfirmed","network"]){const f=fixture();await f.open();await f.source();await f.scan();await f.choose();
 f.run(outcome==="stale"?"call=async()=>{throw {status:409,message:'private-raw-key'}}":outcome==="network"?"call=async()=>{throw new Error('private-raw-key')}":`call=async()=>({imported:[],failed:[{reason:'private-raw-key'}],rolledBack:${outcome==="failed"}})`);
 await f.commit();assert.equal(f.run("providerImportPreview"),null);assert.equal(f.run("providerImportBusy"),false);assert.equal(f.requests.length,1);assert.doesNotMatch(f.html(),/private-raw-key/);assert.match(f.html(),/重新|未能确认/);if(outcome==="unconfirmed")assert.match(f.html(),/清理未能确认/);}
});
test("candidate metadata is escaped and arbitrary key fields or source parse errors are never rendered",async()=>{
 const f=fixture();await f.open();await f.source();await f.scan();f.run("providerImportPreview.sources=[{source:'opencodex',status:'blocked',message:'raw-secret-parse-exception'}];Object.assign(providerImportPreview.candidates[0],{name:'<script>x</script>',baseUrl:'<img onerror=x>',models:['<svg>'],apiKey:'raw-secret-key',key:'raw-secret-key',skipReason:'raw-secret-body'})");
 const html=f.html();assert.match(html,/&lt;script>/);assert.match(html,/&lt;img/);assert.match(html,/&lt;svg>/);assert.doesNotMatch(html,/<script>|<img|<svg>|raw-secret/);assert.match(html,/无法安全读取/);
});

test("an older cancelled read cannot clear the busy state or replace results of a newer read",async()=>{
 const f=fixture();await f.open();await f.source();f.run("globalThis.pending=[];call=()=>new Promise(resolve=>pending.push(resolve))");const first=f.scan();await f.cancel();await f.open();await f.source();const second=f.scan();
 f.run("pending[0]({previewId:'old',sources:[],candidates:[]})");await first;assert.equal(f.run("providerImportBusy"),true);assert.equal(f.run("providerImportPreview"),null);
 f.run("pending[1]({previewId:'new',sources:[],candidates:[]})");await second;assert.equal(f.run("providerImportBusy"),false);assert.equal(f.run("providerImportPreview.previewId"),"new");
});
