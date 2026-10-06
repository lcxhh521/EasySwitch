import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test,type TestContext} from "node:test";
import {createEasySwitchServer} from "../src/server.ts";
import {GatewayTokenAuthority} from "../src/gateway-auth.ts";
import {Store} from "../src/store.ts";
import {Ledger} from "../src/ledger.ts";
import {createReadonlyRelayFixture} from "../src/parallel-tasks.ts";
async function fixture(t:TestContext,enabled=true){
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'es-parallel-api-')),store=new Store(dir),ledger=new Ledger(dir);let calls=0,keys=0,runs=0;let hold=false,failSecond=false,reviewId='';const pending:Array<()=>void>=[];
 const upstream=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);calls++;assert.equal(req.headers.authorization,undefined);assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');
 const send=()=>{res.setHeader('content-type','application/json');if(failSecond&&body.model==='p/b'){res.statusCode=503;res.end('{"error":"fixture failure"}');return;}const content=reviewId?JSON.stringify({agreements:['same'],differences:['different'],recommendation:{taskId:reviewId,reason:'reason'}}):`answer ${body.model}`;res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:5}}));};if(hold)pending.push(send);else send();});
 await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));const endpoint=`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1/chat/completions`;
 store.upsertProvider({id:'p',name:'P',baseUrl:'http://127.0.0.1:1',models:['a','b','c'],route:'chat-translate',routePinned:true,protocols:['chat'],streamUsage:false,createdAt:''});
 const selections=[{agent:'hermes',model:'p/a'},{agent:'aider',model:'p/b'},{agent:'codex',model:'p/c'}];
 const server=createEasySwitchServer({store,ledger,port:0,gatewayAuth:new GatewayTokenAuthority(),secrets:{async get(){keys++;throw new Error('keys forbidden')},async set(){},async delete(){}},readonlyFixtures:enabled?selections.map(s=>createReadonlyRelayFixture({agent:s.agent,endpoint,models:{[s.model]:{inputUsdPerMillion:2,outputUsdPerMillion:4}}})):[],interactiveRuntime:{findBinary:async()=>'/never-run/fixture',newSessionDir:()=>dir,launchInTerminal:async()=>assert.fail('no terminal')},taskRunner:async()=>{runs++;return {exitCode:0,output:'fake ordinary task',timedOut:false}}});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 t.after(async()=>{hold=false;pending.splice(0).forEach(f=>f());for(const s of [server,upstream]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()))}rmSync(dir,{recursive:true,force:true})});
 const api=async(path:string,method='GET',body?:unknown,header=true)=>{const r=await fetch(base+path,{method,redirect:'error',headers:header?{'x-easyswitch':'1'}:{},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json() as any}};
 const settle=async()=>{for(let i=0;i<100;i++){const r=await api('/api/task-groups');if(r.body.groups.every((g:any)=>g.status!=='running'&&g.reviews.every((c:any)=>c.task.status!=='running')))return r.body;await new Promise(r=>setTimeout(r,2))}assert.fail('fake group failed to settle')};
 return {api,settle,store,ledger,selections,counts:()=>({calls,keys,runs}),hold:(v:boolean)=>hold=v,release:()=>{hold=false;pending.splice(0).forEach(f=>f())},fail:()=>failSecond=true,review:(id:string)=>reviewId=id};
}
test('production parallel registry rejects forged readonly claims without tasks, keys or programs',async t=>{
 const f=await fixture(t,false);assert.equal((await f.api('/api/task-groups','GET',undefined,false)).status,403);const list=await f.api('/api/task-groups');assert.equal(list.body.productionEnabled,false);assert.ok(list.body.capabilities.every((c:any)=>!c.enabled));
 const body={task:'explain fixture',kind:'explain',selections:f.selections.slice(0,2)};assert.equal((await f.api('/api/task-groups','POST',body)).status,409);assert.equal((await f.api('/api/task-groups','POST',{...body,readonly:true,cwd:'/private'})).status,400);
 assert.equal((await f.api('/api/tasks')).body.tasks.length,0);assert.deepEqual(f.counts(),{calls:0,keys:0,runs:0});
});
test('fake groups keep independent task records, measured usage and selected cross-review results',async t=>{
 const f=await fixture(t);const started=await f.api('/api/task-groups','POST',{task:'review supplied text',kind:'review',selections:f.selections.slice(0,2)});assert.equal(started.status,202);const group=(await f.settle()).groups[0];assert.equal(group.status,'done');assert.equal(group.children.length,2);assert.ok(group.children.every((c:any)=>c.task.status==='done'&&!c.unknownCost));assert.equal(f.ledger.read().length,2);
 f.review(group.children[0].task.id);const review=await f.api(`/api/task-groups/${group.id}/review/${group.children[0].task.id}`,'POST',{});assert.equal(review.status,202);const done=(await f.settle()).groups[0];assert.equal(done.reviews[0].comparison.recommendation.taskId,group.children[0].task.id);assert.equal(f.ledger.read().length,3);assert.deepEqual(new Set(f.ledger.read().map(e=>e.taskId)),new Set([...done.children,...done.reviews].map((c:any)=>c.task.id)));assert.ok(f.ledger.read().every(e=>e.taskGroupId===group.id));assert.deepEqual(f.ledger.read().map(e=>e.taskPhase).sort(),['review','task','task']);assert.equal((await f.api('/api/tasks')).body.tasks.length,3);assert.equal(f.counts().keys,0);
});
test('one failed fake member does not discard another result and ordinary tasks share the capacity limit',async t=>{
 const f=await fixture(t);f.hold(true);const r=await f.api('/api/task-groups','POST',{task:'compare plans',kind:'plan',selections:f.selections});assert.equal(r.status,202);
 const extra=await f.api('/api/tasks','POST',{agent:'hermes',task:'another',model:'p/a'});assert.equal(extra.status,429);assert.equal(f.counts().runs,0);f.fail();f.release();const group=(await f.settle()).groups[0];assert.equal(group.status,'partial');assert.equal(group.children.filter((c:any)=>c.task.status==='done').length,2);
 const next=await f.api('/api/tasks','POST',{agent:'hermes',task:'allowed now',model:'p/a'});assert.equal(next.status,202);assert.equal(f.counts().runs,1);
});
test('global stop budgets prevent each fake inference before its relay transport',async t=>{
 const f=await fixture(t);await f.api('/api/budget','PUT',{enabled:true,limitUsd:0,period:'day',action:'stop',warnAt:.8});const r=await f.api('/api/task-groups','POST',{task:'budget fixture',kind:'explain',selections:f.selections.slice(0,2)});assert.equal(r.status,202);const g=(await f.settle()).groups[0];assert.equal(g.status,'failed');assert.equal(f.counts().calls,0);assert.ok(g.children.every((c:any)=>c.unknownCost));
});
