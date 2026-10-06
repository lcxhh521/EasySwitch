import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,realpathSync,rmSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {test,type TestContext} from "node:test";
import {createEasySwitchServer} from "../src/server.ts";
import {GatewayTokenAuthority} from "../src/gateway-auth.ts";
import {Store} from "../src/store.ts";
import {Ledger} from "../src/ledger.ts";
async function fixture(t:TestContext){
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'es-feedback-api-')),store=new Store(dir),ledger=new Ledger(dir);let base='',missingUsage=false,partial: 'destroy'|'eof'|undefined,attempts=0;
 const upstream=createServer(async(req,res)=>{for await(const _ of req){}assert.equal(req.headers.authorization,'Bearer fake-api-key');if(partial&&attempts++===0){res.writeHead(200,{'content-type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:'partial'},finish_reason:null}],usage:{prompt_tokens:100,completion_tokens:10}})}\n\n`);if(partial==='destroy')setTimeout(()=>res.destroy(),20);else res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'fake result'},finish_reason:'stop'}],...(missingUsage?{}:{usage:{prompt_tokens:100,completion_tokens:100}})}));});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 store.upsertProvider({id:'p',name:'P',baseUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,models:['expensive','cheap'],route:'chat-translate',routePinned:true,protocols:['chat'],streamUsage:false,prices:{expensive:{input:10,output:10,cacheRead:0,cacheWrite:0},cheap:{input:1,output:1,cacheRead:0,cacheWrite:0}},createdAt:''});
 const rule=store.addRule({name:'class tasks',enabled:true,when:{anyWords:['class']},then:{agent:'hermes',model:'p/expensive'}});
 const auth=new GatewayTokenAuthority();const server=createEasySwitchServer({store,ledger,port:0,gatewayAuth:auth,secrets:{async get(){return 'fake-api-key'},async set(){},async delete(){}},taskAgentAvailable:id=>['hermes','aider'].includes(id),interactiveRuntime:{findBinary:async id=>['hermes','aider'].includes(id)?'/never-run/fake-agent':undefined,newSessionDir:()=>dir,launchInTerminal:async()=>assert.fail('no terminal')},taskRunner:async(id,input,opts)=>{
   const session=opts!.gatewayAuth!.issue(id,{depth:opts?.depth,allowMcp:true});
   try{
     if(input.task?.startsWith('recover')){try{const first=await fetch(base+'/v1/chat/completions',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${session.token}`},body:JSON.stringify({model:input.model,stream:true,messages:[{role:'user',content:'partial fixture'}]})});await first.text();}catch{/* The fake agent explicitly retries after a partial attempt. */}}
     const r=await fetch(base+'/v1/chat/completions',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${session.token}`,'x-easyswitch-task-id':'forged-task'},body:JSON.stringify({model:input.model,messages:[{role:'user',content:input.task}],taskId:'forged-task'})});assert.equal(r.status,200);await r.text();
     if(input.task?.startsWith('parent')){const child=await fetch(base+'/mcp',{method:'POST',redirect:'error',headers:{authorization:`Bearer ${session.token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_agent',arguments:{agent:'aider',task:'class child task',model:'p/cheap'}}})});const body=await child.json() as any;assert.equal(body.result.isError,undefined);}
     return {exitCode:0,output:'fake task output',timedOut:false};
   }finally{opts!.gatewayAuth!.revoke(session.token);}
 }});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 t.after(async()=>{for(const s of [server,upstream]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()))}rmSync(dir,{recursive:true,force:true})});
 const api=async(path:string,method='GET',body?:unknown,header=true)=>{const r=await fetch(base+path,{method,redirect:'error',headers:header?{'x-easyswitch':'1'}:{},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json() as any}};
 const finitelyRecorded=(task:any)=>!partial||ledger.read().filter(e=>e.taskId===task.id).length===2;
 const run=async(agent:string,model:string,text='class ordinary task')=>{const r=await api('/api/tasks','POST',{agent,model,task:text});assert.equal(r.status,202,JSON.stringify(r.body));for(let i=0;i<200;i++){const list=(await api('/api/tasks')).body.tasks;const task=list.find((t:any)=>t.id===r.body.task.id);if(task.status!=='running'&&((missingUsage||partial)?finitelyRecorded(task):!task.usage.unknownCost))return task;await new Promise(r=>setTimeout(r,2))}assert.fail('task did not settle with cost')};
 return {api,run,store,ledger,dir,rule,auth,missingUsage:()=>missingUsage=true,partial:(mode:'destroy'|'eof')=>{partial=mode;attempts=0}};
}
test('feedback and proposals use exact issued-session attribution, require samples, and apply before the original rule',async t=>{
 const f=await fixture(t);assert.equal((await f.api('/api/rules/suggestions','GET',undefined,false)).status,403);assert.equal((await f.api('/api/rules/suggestions')).body.evaluatedRatings,0);
 const tasks:any[]=[];for(const [agent,model] of [['hermes','p/expensive'],['aider','p/cheap']])for(let i=0;i<5;i++){const task=await f.run(agent!,model!);tasks.push(task);assert.match(task.id,/^t-[a-f0-9]{32}$/);assert.equal(task.status,'done');assert.equal(task.usage.unknownCost,false);assert.equal((await f.api(`/api/tasks/${task.id}/feedback`,'PUT',{rating:'good'})).status,200);}
 assert.deepEqual(new Set(f.ledger.read().map(e=>e.taskId)),new Set(tasks.map(t=>t.id)));assert.ok(!f.ledger.read().some(e=>e.taskId==='forged-task'));
 const report=(await f.api('/api/rules/suggestions')).body;assert.equal(report.suggestions.length,1);const s=report.suggestions[0];assert.equal(s.evidence.baseline.samples,5);assert.equal(s.evidence.candidate.samples,5);
 assert.equal((await f.api(`/api/rules/suggestions/${s.id}/apply`,'POST',{})).status,201);assert.equal(f.store.rules()[0]!.then.agent,'aider');assert.equal(f.store.rules()[1]!.id,f.rule.id);assert.equal((await f.api(`/api/rules/suggestions/${s.id}/apply`,'POST',{})).status,409);
 const saved=f.store.rules()[0]!;assert.equal((await f.api(`/api/rules/${saved.id}`,'PUT',{...saved,name:'edited',enabled:false})).status,200);assert.equal(f.store.rules()[0]!.enabled,false);assert.equal((await f.api('/api/rules/suggestions')).body.suggestions.length,0);
 for(const name of ['task-feedback.json','task-accounting.json'])assert.doesNotMatch(readFileSync(join(f.dir,name),'utf8'),/class ordinary task|fake task output|fake-api-key|es-session-|forged-task/);
 assert.equal(f.auth.list().length,0);
});
test('unknown usage cannot produce price advice and ratings reject nonexistent or malformed targets',async t=>{
 const f=await fixture(t);assert.equal((await f.api('/api/tasks/t-missing/feedback','PUT',{rating:'good'})).status,404);const good=await f.run('hermes','p/expensive');assert.equal((await f.api(`/api/tasks/${good.id}/feedback`,'PUT',{rating:'good',prompt:'never store'})).status,400);
 f.missingUsage();const unknown=await f.run('aider','p/cheap');assert.equal(unknown.usage.unknownCost,true);await f.api(`/api/tasks/${unknown.id}/feedback`,'PUT',{rating:'good'});assert.equal((await f.api('/api/rules/suggestions')).body.suggestions.length,0);
 await f.api(`/api/tasks/${unknown.id}/feedback`,'PUT',{rating:null});assert.equal((await f.api('/api/tasks')).body.tasks.find((t:any)=>t.id===unknown.id).feedback,null);
});
test('MCP child cost belongs to its own task and the parent tree, without agent/time-window guessing',async t=>{
 const f=await fixture(t);const parent=await f.run('hermes','p/expensive','parent class task');const tasks=(await f.api('/api/tasks')).body.tasks;assert.equal(tasks.length,2);const child=tasks.find((t:any)=>t.id!==parent.id);assert.equal(child.status,'done');assert.equal(child.usage.unknownCost,false);
 const total=f.ledger.read().reduce((n,e)=>n+(e.costUsd??0),0);assert.equal(parent.usage.costUsd,total);assert.ok(parent.usage.costUsd>child.usage.costUsd);assert.equal(new Set(f.ledger.read().map(e=>e.taskId)).size,2);
});


test('partial usage from interrupted or terminal-less streams stays unknown after a successful task retry',async t=>{
 for(const mode of ['destroy','eof'] as const){
  const f=await fixture(t);f.partial(mode);const task=await f.run('hermes','p/expensive','recover class task');assert.equal(task.status,'done');
  assert.equal(task.usage.unknownCost,true,mode);const rows=f.ledger.read().filter(e=>e.taskId===task.id);assert.equal(rows.length,2);assert.equal(rows[0]!.inputTokens,100);assert.equal(rows[0]!.outputTokens,10);assert.equal(rows[0]!.usageComplete,false);assert.equal(rows[1]!.usageComplete,true);
  assert.ok(Math.abs((task.usage.costUsd??0)-.0031)<1e-9,'known partial cost remains recorded, but cannot enter price advice');
  await f.api(`/api/tasks/${task.id}/feedback`,'PUT',{rating:'good'});assert.equal((await f.api('/api/rules/suggestions')).body.suggestions.length,0);
 }
});
