import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {test} from "node:test";
function ui(){
 const handlers:Record<string,Array<(e:any)=>unknown>>={};const context=vm.createContext({
 document:{addEventListener(n:string,f:any){(handlers[n]??=[]).push(f)}},FormData:class{form:any;constructor(f:any){this.form=f}get(k:string){return this.form.values[k]}getAll(k:string){return this.form.values[k]??[]}},console,
 esc:(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)),
 money:(n:number)=>`$${n}`,agentMeta:(id:string)=>({name:id}),keepOpen:()=>'',render(){},userErrorMessage:()=> '这次操作没有完成，请检查后重试',TASK_STATUS:{done:['完成'],failed:['失败'],running:['运行中']}});
 vm.runInContext(readFileSync(new URL('../../web/parallel.js',import.meta.url),'utf8'),context);const run=(s:string):any=>vm.runInContext(s,context);
 run("globalThis.requests=[];call=async(m,p,b)=>{requests.push({m,p,b});return parallelState};parallelState={groups:[],capabilities:[{agent:'hermes',enabled:false,execution:'unavailable',models:[]},{agent:'aider',enabled:false,execution:'unavailable',models:[]}]}");
 const dispatch=async(n:string,target:any)=>{for(const f of handlers[n]??[])await f({target,preventDefault(){},stopImmediatePropagation(){}})};
 return {run,dispatch,form:(values:any)=>({values,matches:(s:string)=>s==='[data-parallel-form]'})};
}
test('production UI states the genuine boundary and cannot submit disabled agents',async()=>{
 const app=ui();const html=app.run('parallelCard()');assert.match(html,/当前真实 Agent 都未开放并行运行/);assert.match(html,/type="submit" disabled/);assert.match(html,/不能代替隔离/);
 await app.dispatch('submit',app.form({task:'explain',kind:'explain',agent:['hermes','aider'],'model:hermes':'p/a','model:aider':'p/b'}));assert.equal(app.run('requests.length'),0);assert.match(app.run('parallelMessage'),/未启动任何任务/);
});
test('fake selection posts only text and selected models, preserves failed drafts and suppresses duplicates',async()=>{
 const app=ui();app.run("parallelState.capabilities=[{agent:'hermes',enabled:true,execution:'fixture-relay',models:['p/a']},{agent:'aider',enabled:true,execution:'fixture-relay',models:['p/b']}];call=(m,p,b)=>{requests.push({m,p,b});return new Promise((resolve,reject)=>globalThis.fail=reject)}");
 const form=app.form({task:'review provided text',kind:'review',agent:['hermes','aider'],'model:hermes':'p/a','model:aider':'p/b'});const pending=app.dispatch('submit',form);await new Promise(r=>setImmediate(r));await app.dispatch('submit',form);assert.equal(app.run('requests.length'),1);
 assert.equal(app.run('JSON.stringify(requests[0].b)'),'{"task":"review provided text","kind":"review","selections":[{"agent":"hermes","model":"p/a"},{"agent":"aider","model":"p/b"}]}');app.run("fail(new Error('private failure'))");await pending;assert.equal(app.run('parallelBusy'),false);assert.match(app.run('parallelCard()'),/value="review" selected/);assert.match(app.run('parallelCard()'),/review provided text/);assert.doesNotMatch(app.run('parallelCard()'),/private failure/);
});
test('side-by-side failures, unknown prices and selected review are visible without treating output as HTML',()=>{
 const app=ui();app.run("parallelState.groups=[{id:'g-1',task:'<img>',status:'partial',children:[{task:{id:'t-a',agent:'hermes',model:'p/a',status:'done',output:'<script>bad</script>'},unknownCost:false,costUsd:0.2},{task:{id:'t-b',agent:'aider',model:'p/b',status:'failed',output:'失败'},unknownCost:true}],reviews:[]}]");
 let html=app.run('parallelCard()');assert.match(html,/display:flex/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img>|data-parallel-review/);assert.match(html,/费用未知/);assert.match(html,/\$0.2/);
 app.run("parallelState.groups[0].children[1].task.status='done';parallelState.groups[0].reviews=[{task:{agent:'hermes',model:'p/a',output:''},unknownCost:true,comparison:{agreements:['same'],differences:['different'],recommendation:{taskId:'t-a',reason:'<svg>'}}}]");html=app.run('parallelCard()');assert.match(html,/data-parallel-review="t-a"/);assert.match(html,/相同点|不同点/);assert.match(html,/&lt;svg&gt;/);
});
test('review buttons target the chosen existing child and cannot add execution options',async()=>{
 const app=ui();const el:any={dataset:{parallelReview:'t-a',parallelGroup:'g-1'},closest:(s:string)=>s==='[data-parallel-review]'?el:null};await app.dispatch('click',el);
 assert.equal(app.run('requests[0].p'),'/api/task-groups/g-1/review/t-a');assert.equal(app.run('JSON.stringify(requests[0].b)'),'{}');
});
