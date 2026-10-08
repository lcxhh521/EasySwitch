import assert from "node:assert/strict";
import {request,createServer} from "node:http";
import {NativeKeychainStore} from "../src/native-keychain.ts";
import {EncodedSecretStore} from "../src/secrets.ts";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test,type TestContext} from "node:test";
import {createEasySwitchServer} from "../src/server.ts";
import {Store} from "../src/store.ts";
import {GatewayTokenAuthority} from "../src/gateway-auth.ts";
import {esMain} from "../../bin/es.ts";
async function fixture(t:TestContext){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'es-doctor-api-'));const store=new Store(dir);let reads=0,probes=0,helps=0;
  store.upsertProvider({id:'p',name:'secret-label-do-not-output',baseUrl:'https://secret-host.invalid',models:['m'],route:'chat-translate',routePinned:false,streamUsage:true,createdAt:''});
  let helper=true;
  const server=createEasySwitchServer({store,port:0,gatewayAuth:new GatewayTokenAuthority(),secrets:{health:()=>({backend:helper?'memory':'native-keychain',ready:helper,status:helper?'ready':'helper_missing',keychainChecked:false}),async get(){reads++;throw new Error('unexpected secret read')},async set(){throw new Error('PRIVATE KEY fixture-value')},async delete(){}},doctor:{agents:()=>[{id:'fixture',installed:true,helpAllowed:true},{id:'missing',installed:false}],runners:{async probeProvider(){probes++;return {probe:{at:new Date().toISOString(),checks:[{id:'chat',label:'fixture',status:'pass',detail:'secret-probe-output'}]}}},async checkAgentHelp(){helps++;return {verdicts:[{form:'headless',helpOk:true,checked:['--help'],missing:[]}]}}}}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});});
  const http=(path:string,method='GET',body?:unknown,header=true)=>new Promise<{status:number;body:any}>((resolve,reject)=>{const q=request(`http://127.0.0.1:${port}${path}`,{method,headers:header?{'x-easyswitch':'1'}:{}},r=>{let s='';r.on('data',d=>s+=d);r.on('end',()=>resolve({status:r.statusCode!,body:JSON.parse(s)}));});q.on('error',reject);q.end(body===undefined?undefined:JSON.stringify(body));});
  return {store,port,http,setHelper:(v:boolean)=>helper=v,counts:()=>({reads,probes,helps})};
}
test('doctor metadata requires console header and never reads keys, calls sources or executes help',async t=>{
 const f=await fixture(t);assert.equal((await f.http('/api/doctor','GET',undefined,false)).status,403);
 const r=await f.http('/api/doctor');assert.equal(r.status,200);assert.equal(r.body.mode,'metadata');assert.ok(r.body.findings.some((x:any)=>x.code==='agent_not_installed'));
 assert.deepEqual(f.counts(),{reads:0,probes:0,helps:0});assert.doesNotMatch(JSON.stringify(r.body),/secret-label|secret-host|PRIVATE KEY/);
 f.setHelper(false);const missing=await f.http('/api/doctor');assert.ok(missing.body.findings.some((x:any)=>x.code==='helper_missing'));
});
test('HTTP doctor warns about saved stale effective Messages URLs without editing or probing sources',async t=>{
 const f=await fixture(t);const original=f.store.provider('p')!;
 f.store.upsertProvider({...original,anthropicBaseUrl:'https://api.deepseek.com/anthropic'});
 const before=JSON.stringify(f.store.provider('p'));const result=await f.http('/api/doctor');
 assert.equal(result.status,200);const warning=result.body.findings.find((x:any)=>x.code==='source_messages_endpoint_stale');
 assert.equal(warning.targetId,'p');assert.equal(warning.evidence,'metadata');assert.equal(warning.status,'warn');assert.match(warning.nextStep,/https:\/\/api\.deepseek\.com\/anthropic\/v1/);
 assert.equal(JSON.stringify(f.store.provider('p')),before);assert.deepEqual(f.counts(),{reads:0,probes:0,helps:0});assert.doesNotMatch(JSON.stringify(result.body),/secret-label|secret-host|PRIVATE KEY/);
 f.store.upsertProvider({...f.store.provider('p')!,wire:{paths:{messages:'v1/messages'}}});
 assert.ok(!(await f.http('/api/doctor')).body.findings.some((x:any)=>x.code==='source_messages_endpoint_stale'));
 f.store.upsertProvider({...f.store.provider('p')!,wire:{paths:{messages:'messages'}}});
 assert.match((await f.http('/api/doctor')).body.findings.find((x:any)=>x.code==='source_messages_endpoint_stale').nextStep,/wire\.paths\.messages/);
 f.store.upsertProvider({...f.store.provider('p')!,anthropicBaseUrl:'https://api.deepseek.com/anthropic/v1'});
 assert.ok(!(await f.http('/api/doctor')).body.findings.some((x:any)=>x.code==='source_messages_endpoint_stale'));
 assert.deepEqual(f.counts(),{reads:0,probes:0,helps:0});
});
test('active checks need separate consent, enforce disabled/budget/helper guards, and report only safe evidence',async t=>{
 const f=await fixture(t);const checks=[{kind:'provider',id:'p'}];
 assert.equal((await f.http('/api/doctor/checks','POST',{checks})).status,400);
 f.store.upsertProvider({...f.store.provider('p')!,off:true});assert.equal((await f.http('/api/doctor/checks','POST',{checks,acknowledgeSourceRequests:true})).body.uiError.code,'source_disabled');
 f.store.upsertProvider({...f.store.provider('p')!,off:false});f.setHelper(false);assert.equal((await f.http('/api/doctor/checks','POST',{checks,acknowledgeSourceRequests:true})).body.uiError.code,'keychain_unavailable');
 f.setHelper(true);const r=await f.http('/api/doctor/checks','POST',{checks,acknowledgeSourceRequests:true});assert.equal(r.status,200);assert.equal(r.body.mode,'active');assert.doesNotMatch(JSON.stringify(r.body),/secret-probe-output/);
 const help=await f.http('/api/doctor/checks','POST',{checks:[{kind:'agent-help',id:'fixture'}],acknowledgeCliExecution:true});assert.equal(help.status,200);
 await f.http('/api/budget','PUT',{enabled:true,limitUsd:100,period:'day',action:'stop',warnAt:.8});assert.equal((await f.http('/api/doctor/checks','POST',{checks,acknowledgeSourceRequests:true})).body.uiError.code,'budget_blocked');
 assert.deepEqual(f.counts(),{reads:0,probes:1,helps:1});
});
test('console errors keep safe structure and never include raw process or credential-bearing exception text',async t=>{
 const f=await fixture(t);const r=await f.http('/api/providers','POST',{name:'Fixture',baseUrl:'http://127.0.0.1:1/v1',apiKey:'fake'});
 assert.equal(r.status,500);assert.equal(r.body.uiError.code,'unknown_error');assert.equal(r.body.error,r.body.uiError.message);assert.equal(r.body.uiError.details.status,500);assert.doesNotMatch(JSON.stringify(r.body),/PRIVATE KEY|fixture-value/);
});
test('es doctor is read-only, uses the guarded API, and does not auto-start when offline',async t=>{
 const f=await fixture(t);const out:string[]=[],err:string[]=[];let spawns=0;
 const deps={env:{EASYSWITCH_PORT:String(f.port)},out:(s:string)=>out.push(s),err:(s:string)=>err.push(s),spawn:(()=>{spawns++;assert.fail('doctor must not spawn')}) as any};
 assert.equal(await esMain(['doctor'],deps),0);assert.match(out.join('\n'),/只读取状态/);assert.equal(spawns,0);assert.equal(f.counts().reads,0);
 out.length=0;assert.equal(await esMain(['doctor','--json'],deps),0);assert.equal(JSON.parse(out[0]!).version,1);
 assert.equal(await esMain(['doctor'],{...deps,fetch:async()=>{throw new Error('raw-secret EACCES')}}),1);assert.doesNotMatch(err.join('\n'),/raw-secret|EACCES/);assert.equal(spawns,0);
});


test('HTTP doctor requests passive native helper metadata through the encoded store without verifier or key operations',async t=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'es-doctor-passive-'));let verifications=0,operations=0;
 const secret=new EncodedSecretStore(new NativeKeychainStore(async()=>{operations++;throw new Error('must not read keys')},{inspect:options=>{if(!options?.passive)verifications++;return {backend:'native-keychain',ready:false,status:'helper_signature_unchecked',keychainChecked:false}}}));
 const server=createEasySwitchServer({store:new Store(dir),port:0,secrets:secret,gatewayAuth:new GatewayTokenAuthority()});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})});
 const response=await fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/doctor`,{headers:{'x-easyswitch':'1'},redirect:'error'});const report=await response.json() as any;
 assert.equal(response.status,200);assert.ok(report.findings.some((f:any)=>f.code==='helper_signature_unchecked'&&f.status==='unchecked'));assert.equal(verifications,0);assert.equal(operations,0);
});

test('active source diagnostics recheck source and budget after the credential wait before network I/O',async t=>{
 for(const change of ['off','budget'] as const){
  const dir=mkdtempSync(join(realpathSync(tmpdir()),'es-doctor-race-'));const store=new Store(dir);let calls=0;
  const upstream=createServer((req,res)=>{calls++;res.end('{}')});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
  store.upsertProvider({id:'p',name:'Fixture',baseUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,models:['m'],route:'chat-translate',routePinned:false,streamUsage:true,createdAt:''});
  let read!:()=>void,release!:(value:string)=>void;const started=new Promise<void>(r=>read=r);const key=new Promise<string>(r=>release=r);
  const server=createEasySwitchServer({store,port:0,gatewayAuth:new GatewayTokenAuthority(),secrets:{health:()=>({backend:'memory',ready:true,status:'ready',keychainChecked:false}),async get(){read();return key},async set(){},async delete(){}}});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(async()=>{for(const s of [server,upstream]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()))}rmSync(dir,{recursive:true,force:true})});
  const headers={'x-easyswitch':'1','content-type':'application/json'};
  const pending=fetch(base+'/api/doctor/checks',{method:'POST',headers,redirect:'error',body:JSON.stringify({checks:[{kind:'provider',id:'p'}],acknowledgeSourceRequests:true})});await started;
  if(change==='off')store.upsertProvider({...store.provider('p')!,off:true});else await fetch(base+'/api/budget',{method:'PUT',headers,redirect:'error',body:JSON.stringify({enabled:true,limitUsd:100,period:'day',action:'stop',warnAt:.8})});
  release('fake-credential');const report=await (await pending).json() as any;assert.equal(calls,0);assert.ok(report.findings.some((f:any)=>f.code==='diagnostic_failed'));
 }
});


test('a delayed active probe cannot resurrect a source deleted before its results arrive',async t=>{
 const dir=mkdtempSync(join(realpathSync(tmpdir()),'es-doctor-result-race-'));const store=new Store(dir);let notify!:()=>void;const arrived=new Promise<void>(r=>notify=r);let releasing=false;const waiting:Array<()=>void>=[];
 const upstream=createServer((req,res)=>{req.resume();const send=()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'m'}],choices:[{message:{content:'pong'},finish_reason:'stop'}],output:[{type:'message',content:[]}],content:[{type:'text',text:'pong'}]}))};if(req.method==='GET'||releasing)send();else{waiting.push(send);notify()}});await new Promise<void>(r=>upstream.listen(0,'127.0.0.1',r));
 store.upsertProvider({id:'p',name:'Fixture',baseUrl:`http://127.0.0.1:${(upstream.address() as {port:number}).port}/v1`,models:['m'],route:'chat-translate',routePinned:false,streamUsage:true,createdAt:''});
 const server=createEasySwitchServer({store,port:0,gatewayAuth:new GatewayTokenAuthority(),secrets:{health:()=>({backend:'memory',ready:true,status:'ready',keychainChecked:false}),async get(){return 'fixture-key'},async set(){},async delete(){}}});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{for(const s of [server,upstream]){s.closeAllConnections();await new Promise<void>(r=>s.close(()=>r()))}rmSync(dir,{recursive:true,force:true})});
 const pending=fetch(`http://127.0.0.1:${(server.address() as {port:number}).port}/api/doctor/checks`,{method:'POST',headers:{'x-easyswitch':'1'},redirect:'error',body:JSON.stringify({checks:[{kind:'provider',id:'p'}],acknowledgeSourceRequests:true})});await arrived;store.removeProvider('p');releasing=true;waiting.forEach(send=>send());
 const report=await (await pending).json() as any;assert.equal(store.provider('p'),undefined);assert.ok(report.findings.some((f:any)=>f.code==='diagnostic_failed'));
});
