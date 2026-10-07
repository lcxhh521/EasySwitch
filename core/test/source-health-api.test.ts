import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createServer,type Server} from 'node:http';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../src/store.ts';
import {createEasySwitchServer} from '../src/server.ts';
import {GatewayTokenAuthority} from '../src/gateway-auth.ts';
import {recordLimitReached,clearQuota} from '../src/quota.ts';
async function listen(server:Server){await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function fixture(t:TestContext){
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'es-health-api-')),store=new Store(dir),auth=new GatewayTokenAuthority();let now=Date.now(),mode=200,reads=0,posts:string[]=[],gets=0,cut=false;
 const relay=createServer(async(req,res)=>{if(req.method==='GET'){gets++;assert.equal(req.url,'/v1/models');res.writeHead(mode,{'content-type':'application/json',...(mode===429?{'retry-after':'3600'}:{})});res.end(JSON.stringify({data:[{id:'m'}]}));return;}const parts=[];for await(const part of req)parts.push(part);const body=JSON.parse(Buffer.concat(parts).toString());posts.push(String(req.headers.authorization));if(cut){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:'started'}}]})+'\n\n');setImmediate(()=>res.destroy());return;}res.setHeader('content-type','application/json');res.end(JSON.stringify({model:body.model,choices:[{message:{role:'assistant',content:'fixture'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}}));});
 const upstream=await listen(relay);for(const id of ['primary','backup'])store.upsertProvider({id,name:id,baseUrl:upstream+'/v1',models:['m'],protocols:['chat'],route:'chat-translate',routePinned:false,streamUsage:true,createdAt:new Date().toISOString()});
 const server=createEasySwitchServer({store,port:0,gatewayAuth:auth,sourceHealth:{now:()=>now},secrets:{get:async id=>{reads++;return 'fixture-'+id;},set:async()=>{},delete:async()=>{}}});const base=await listen(server),session=auth.issue('aider');
 const api=async(method:string,path:string,body?:unknown,header=true)=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(header?{'x-easyswitch':'1'}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json() as any};};
 const call=async(token=session.token,model='primary/m',stream=false)=>{const r=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({model,messages:[{role:'user',content:'fixture'}],stream})});try{return{status:r.status,body:await r.text()};}catch{return{status:r.status,body:'interrupted'};}};
 t.after(async()=>{clearQuota();server.closeAllConnections();relay.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>relay.close(()=>r()))]);rmSync(dir,{recursive:true,force:true});});
 return{store,dir,api,call,session,auth,advance:()=>{now+=300001;},mode:(v:number)=>{mode=v;},cut:()=>{cut=true;},quota:()=>recordLimitReached('primary',now),counts:()=>({reads,gets,posts:[...posts]})};
}
test('health is explicitly permitted, performs only GET, and persists proof without credential metadata',async t=>{
 const f=await fixture(t);assert.equal((await f.api('GET','/api/source-health',undefined,false)).status,403);await f.api('POST','/api/providers/primary/health/check',{});assert.deepEqual(f.counts(),{reads:0,gets:0,posts:[]});
 assert.equal((await f.api('PUT','/api/providers/primary/health',{enabled:true},false)).status,403);
 await f.api('PUT','/api/providers/primary/health',{enabled:true});assert.equal(f.counts().gets,0);
 const result=await f.api('POST','/api/providers/primary/health/check',{});assert.equal(result.body.status,'healthy');assert.equal(f.counts().gets,1);assert.equal(f.counts().posts.length,0);assert.match(f.store.provider('primary')!.healthMonitor!.verifiedFingerprint!,/^[a-f0-9]{64}$/);
 await f.api('POST','/api/providers/primary/health/check',{});assert.equal(f.counts().gets,1);
 assert.equal((await f.api('GET','/api/providers/primary/keys',undefined,false)).status,404);assert.equal((await f.api('GET','/api/source-health')).body.sources.find((p:any)=>p.providerId==='primary').verified,true);
 assert.doesNotMatch(readFileSync(join(f.dir,'state.json'),'utf8')+JSON.stringify(result),/fixture-primary|authorization/);
 await f.api('PUT','/api/providers/primary/health',{enabled:false});f.advance();await f.api('POST','/api/providers/primary/health/check',{});assert.equal(f.counts().gets,1);
});
test('direct fallback changes once before send on confirmed outage/quota and recovers without changing the binding',async t=>{
 const f=await fixture(t);f.store.setBinding({harness:'aider',providerId:'primary',model:'m'});await f.api('PUT','/api/bindings/aider/fallback',{model:'backup/m'});await f.call();assert.equal(f.counts().posts.at(-1),'Bearer fixture-primary');
 await f.api('PUT','/api/providers/primary/health',{enabled:true});await f.api('POST','/api/providers/primary/health/check',{});f.mode(503);for(let i=0;i<3;i++){f.advance();await f.api('POST','/api/providers/primary/health/check',{});}
 const health=await f.api('GET','/api/source-health');assert.equal(health.body.sources.find((s:any)=>s.providerId==='primary').status,'unavailable');assert.equal(health.body.transitions.filter((e:any)=>e.status==='unavailable').length,1);assert.equal((await f.api('GET','/api/source-health')).body.transitions.length,0);
 assert.equal((await f.call()).status,200);assert.equal(f.counts().posts.at(-1),'Bearer fixture-backup');assert.equal(f.store.binding('aider')!.providerId,'primary');
 const sessions=(await f.api('GET','/api/gateway/sessions')).body.sessions;assert.equal(sessions[0].fallbackChanges[0].reason,'source_unavailable');assert.doesNotMatch(JSON.stringify(sessions),/fixture-primary|es-session-/);
 f.mode(200);f.advance();await f.api('POST','/api/providers/primary/health/check',{});await f.call();assert.equal(f.counts().posts.at(-1),'Bearer fixture-primary');
 f.quota();await f.call();assert.equal(f.counts().posts.at(-1),'Bearer fixture-backup');assert.match(readFileSync(join(f.dir,'usage.jsonl'),'utf8'),/quota_exhausted/);
 await f.api('DELETE','/api/bindings/aider/fallback');await f.call();assert.equal(f.counts().posts.at(-1),'Bearer fixture-primary');
});
test('fallback cannot bypass capability authentication, pools, source switches or output already sent',async t=>{
 const f=await fixture(t);await f.api('PUT','/api/bindings/aider/fallback',{model:'backup/m'});const before=f.counts();assert.equal((await f.call('es-session-forged')).status,401);assert.deepEqual(f.counts(),before);
 f.store.upsertPool({id:'choice',name:'Choice',members:['primary/m'],strategy:'order',createdAt:new Date().toISOString()});assert.equal((await f.api('PUT','/api/bindings/aider/fallback',{model:'pool/choice'})).status,400);
 f.cut();await f.call(undefined,'primary/m',true);assert.deepEqual(f.counts().posts,['Bearer fixture-primary']);
 const backup=f.store.provider('backup')!;backup.off=true;f.store.upsertProvider(backup);f.quota();await f.call();assert.equal(f.counts().posts.at(-1),'Bearer fixture-primary');
});
test('metadata rate limits stay unknown, respect cooldown, and never create a quota fallback',async t=>{
 const f=await fixture(t);await f.api('PUT','/api/providers/primary/health',{enabled:true});f.mode(429);const check=await f.api('POST','/api/providers/primary/health/check',{});assert.equal(check.body.status,'unknown');f.advance();await f.api('POST','/api/providers/primary/health/check',{});assert.equal(f.counts().gets,1);await f.api('PUT','/api/bindings/aider/fallback',{model:'backup/m'});await f.call();assert.equal(f.counts().posts.at(-1),'Bearer fixture-primary');
});

test('imported ordinary source activation is explicit and never reads credentials or probes',async t=>{
 const f=await fixture(t);const p=f.store.provider('primary')!;p.off=true;f.store.upsertProvider(p);assert.equal((await f.api('PUT','/api/providers/primary/switch',{on:true},false)).status,403);assert.equal(f.store.provider('primary')!.off,true);assert.equal((await f.api('PUT','/api/providers/primary/switch',{on:true})).status,200);assert.equal(f.store.provider('primary')!.off,undefined);assert.deepEqual(f.counts(),{reads:0,gets:0,posts:[]});
});
