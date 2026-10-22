import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { Ledger } from "../src/ledger.ts";

type J = Record<string, any>;
const listen = (server: Server) => new Promise<string>(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); };
async function fixture(run: (f: {
  base: string; token: string; store: Store; secrets: ReturnType<typeof createSecretStore>; dir: string; ledger: Ledger; auth: GatewayTokenAuthority;
  calls: Array<{source:string; key:string; body:J}>; status: Record<string,number>; hook: {before?: (id:string)=>Promise<void>; stream?: boolean; detail?: string; redirect?: string; keep?: boolean};
  api: (path:string,method?:string,body?:unknown)=>Promise<{status:number;body:J}>;
  preview: ()=>Promise<J>; confirm: (id:string)=>Promise<J>;
  request: (model:string,extra?:J,path?:string)=>Promise<Response>;
}) => Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),"es-automatic-api-")); const store=new Store(dir),secrets=createSecretStore(),ledger=new Ledger(dir),auth=new GatewayTokenAuthority();
  const calls:Array<{source:string;key:string;body:J}>=[],status:Record<string,number>={a:200,b:200}; const hook:{before?:(id:string)=>Promise<void>;stream?:boolean;detail?:string;redirect?:string;keep?:boolean}={};
  const upstream=createServer(async(req,res)=>{let raw="";for await(const c of req)raw+=c; const id=req.url!.split("/")[1]!;calls.push({source:id,key:String(req.headers.authorization),body:JSON.parse(raw)});await hook.before?.(id);
    if(hook.stream){res.writeHead(200,{"content-type":"text/event-stream"});res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');if(!hook.keep)setTimeout(()=>res.destroy(),10);return;}
    const code=status[id]??200;if(hook.redirect)res.setHeader("location",hook.redirect);res.writeHead(code,{"content-type":"application/json"});res.end(JSON.stringify(code===200?{id:"fixture",choices:[{message:{role:"assistant",content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}:{error:{message:hook.detail??"fixture refusal"}}));
  });
  const origin=await listen(upstream);
  for(const id of ["a","b"]){store.upsertProvider({id,name:`Source ${id}`,baseUrl:`${origin}/${id}/v1`,models:["mock-coder"],route:"chat-translate",routePinned:true,protocols:["chat"],streamUsage:true,createdAt:""});await secrets.set(id,`fixture-${id}`);}
  store.setBinding({harness:"aider",providerId:"a",model:"mock-coder"});store.setSettings({claudeNative:false});
  const server=createEasySwitchServer({store,secrets,ledger,gatewayAuth:auth,port:0,interactiveRuntime:{findBinary:async()=>assert.fail("must not inspect programs"),newSessionDir:()=>assert.fail("must not create launch"),launchInTerminal:async()=>assert.fail("must not launch")}});const base=await listen(server);
  const api=async(path:string,method="GET",body?:unknown)=>{const r=await fetch(base+path,{method,headers:{"content-type":"application/json","x-easyswitch":"1"},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json() as J};};
  const preview=async()=>{const r=await api("/api/pools/automatic/preview","POST",{modelId:"a/mock-coder",harness:"aider"});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const confirm=async(id:string)=>{const r=await api("/api/pools/automatic/confirm","POST",{confirmationId:id});assert.equal(r.status,200,JSON.stringify(r.body));return r.body;};
  const token=auth.issue("aider").token;
  const request=(model:string,extra:J={},path="/v1/chat/completions")=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:JSON.stringify({model,messages:[{role:"user",content:"hi"}],...extra})});
  try{await run({base,token,store,secrets,dir,ledger,auth,calls,status,hook,api,preview,confirm,request});}finally{await close(server);await close(upstream);rmSync(dir,{recursive:true,force:true});}
}

test("automatic review is local-only and confirm atomically installs and binds once",async()=>fixture(async f=>{
 const p=await f.preview();assert.deepEqual(p.members.map((m:J)=>m.modelId),["a/mock-coder","b/mock-coder"]);assert.equal(f.calls.length,0);assert.equal(f.store.pools().length,0);assert.equal(f.store.binding("aider")!.providerId,"a");
 const c=await f.confirm(p.confirmationId);assert.equal(c.pool.strategy,"automatic");assert.deepEqual(c.binding,{harness:"aider",providerId:"pool",model:c.pool.id});assert.deepEqual(f.store.binding("aider"),c.binding);
 assert.equal((await f.confirm(p.confirmationId)).pool.id,c.pool.id);assert.equal(f.store.pools().length,1);assert.equal(f.calls.length,0);
 const publicPools=await f.api("/api/pools");assert.ok(!JSON.stringify([p,c,publicPools]).includes("fixture-a"));assert.ok(!JSON.stringify(publicPools).includes('"seal"'));assert.ok(!JSON.stringify(publicPools).includes('"salt"'));assert.ok(!readFileSync(join(f.dir,"state.json"),"utf8").includes("fixture-a"));
}));
test("automatic cannot be enabled through legacy pool creation or edit",async()=>fixture(async f=>{
 assert.equal((await f.api("/api/pools","POST",{name:"Bypass",strategy:"automatic",members:["a/mock-coder","b/mock-coder"]})).status,400);
 const p=await f.preview(),c=await f.confirm(p.confirmationId);assert.equal((await f.api(`/api/pools/${c.pool.id}`,"PUT",{name:"Changed",strategy:"order",members:c.pool.members})).status,409);assert.equal(f.store.pool(c.pool.id)!.strategy,"automatic");
}));
test("changed endpoint and same-ID secret invalidate pending confirmation",async()=>fixture(async f=>{
 let p=await f.preview();f.store.upsertProvider({...f.store.provider("b")!,baseUrl:"http://127.0.0.1:1"});assert.equal((await f.api("/api/pools/automatic/confirm","POST",{confirmationId:p.confirmationId})).status,409);assert.equal(f.store.pools().length,0);
 p=await f.preview();await f.secrets.set("a","replacement-fixture");assert.equal((await f.api("/api/pools/automatic/confirm","POST",{confirmationId:p.confirmationId})).status,409);assert.equal(f.store.pools().length,0);assert.equal(f.calls.length,0);
}));
test("newer binding wins over stale confirm and idempotent retry cannot rebind",async()=>fixture(async f=>{
 let p=await f.preview();f.store.setBinding({harness:"aider",providerId:"b",model:"mock-coder"});assert.equal((await f.api("/api/pools/automatic/confirm","POST",{confirmationId:p.confirmationId})).status,409);
 f.store.setBinding({harness:"aider",providerId:"a",model:"mock-coder"});p=await f.preview();await f.confirm(p.confirmationId);f.store.clearBinding("aider");assert.equal((await f.api("/api/pools/automatic/confirm","POST",{confirmationId:p.confirmationId})).status,409);assert.equal(f.store.binding("aider"),undefined);
}));
test("failed atomic install leaves neither new pool nor changed binding",async()=>fixture(async f=>{
 const p=await f.preview();mkdirSync(join(f.dir,"state.json.tmp"));const r=await f.api("/api/pools/automatic/confirm","POST",{confirmationId:p.confirmationId});assert.ok(r.status>=400);assert.equal(f.store.pools().length,0);assert.equal(f.store.binding("aider")!.providerId,"a");
}));
test("unknown signals retain selected primary; passive refusals avoid it and all waiting means zero calls",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId),model=`pool/${c.pool.id}`;
 let r=await f.request(model);assert.equal(r.status,200,await r.text());assert.deepEqual(f.calls.map(x=>x.source),["a"]);
 f.status.a=503;r=await f.request(model);assert.equal(r.status,200,await r.text());assert.deepEqual(f.calls.map(x=>x.source),["a","a","b"]);
 f.status.b=429;r=await f.request(model);assert.equal(r.status,429,await r.text());assert.equal(f.calls.at(-1)!.source,"b");const before=f.calls.length;
 r=await f.request(model);assert.equal(r.status,503);assert.match(await r.text(),/等待|暂停/);assert.equal(f.calls.length,before);
}));
test("automatic pins the reviewed key and never internally rotates to another account",async()=>fixture(async f=>{
 f.store.upsertProvider({...f.store.provider("a")!,keys:[{id:"k1",label:"First",enabled:true,addedAt:""},{id:"k2",label:"Second",enabled:true,addedAt:""}]});await f.secrets.set("a#k1","first-fixture");await f.secrets.set("a#k2","second-fixture");f.status.a=401;
 const p=await f.preview();assert.match(p.members[0].keyLabel,/First/);const c=await f.confirm(p.confirmationId);const r=await f.request(`pool/${c.pool.id}`);assert.equal(r.status,200,await r.text());assert.deepEqual(f.calls.map(x=>[x.source,x.key]),[["a","Bearer first-fixture"],["b","Bearer fixture-b"]]);
}));
test("tools, media and opaque continuation are rejected before any inference",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId),model=`pool/${c.pool.id}`;
 for(const extra of [{tools:[{type:"function",function:{name:"x"}}]},{messages:[{role:"user",content:[{type:"image_url",image_url:{url:"https://example.invalid/a"}}]}]},{previous_response_id:"resp-fixture"},{messages:[{role:"assistant",content:"x",tool_calls:[]}]}]){const r=await f.request(model,extra);assert.equal(r.status,400,await r.text());}
 const r=await f.request(model,{input:"hi",messages:undefined,previous_response_id:"resp-fixture"},"/v1/responses");assert.equal(r.status,400,await r.text());assert.equal(f.calls.length,0);
}));
test("source/credential changes after approval refuse without falling back",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId);await f.secrets.set("b","changed-fixture");const r=await f.request(`pool/${c.pool.id}`);assert.equal(r.status,409,await r.text());assert.equal(f.calls.length,0);
}));
test("partial output or disconnect is never replayed to another source",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId);f.hook.stream=true;const r=await f.request(`pool/${c.pool.id}`,{stream:true});assert.equal(r.status,200);await r.text().catch(()=>undefined);assert.equal(f.calls.length,1);
}));
test("revocation between attempts stops the backup before dispatch",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId);f.status.a=503;f.hook.before=async()=>{for(const s of f.auth.list())f.auth.revokeId(s.id);};const r=await f.request(`pool/${c.pool.id}`);assert.equal(r.status,401,await r.text());assert.equal(f.calls.length,1);
}));
test("global budget is rechecked before backup rather than once at ingress",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId);assert.equal((await f.api("/api/budget","PUT",{enabled:true,limitUsd:1,period:"day",action:"stop",warnAt:0.8})).status,200);f.status.a=503;
 f.hook.before=async()=>{f.ledger.append({at:new Date().toISOString(),model:"a/mock-coder",providerId:"a",route:"chat-translate",status:200,ms:1,costUsd:2});};
 const r=await f.request(`pool/${c.pool.id}`);assert.equal(r.status,429,await r.text());assert.equal(f.calls.length,1);
}));

test("preview and completed confirmation reject binding ABA and explicit same-value saves",async()=>fixture(async f=>{
 const p=await f.preview();f.store.setBinding({harness:"aider",providerId:"b",model:"mock-coder"});f.store.setBinding({harness:"aider",providerId:"a",model:"mock-coder"});
 assert.equal((await f.api("/api/pools/automatic/confirm","POST",{confirmationId:p.confirmationId})).status,409);assert.equal(f.store.pools().length,0);
 const p2=await f.preview(),c=await f.confirm(p2.confirmationId);f.store.setBinding(c.binding);
 assert.equal((await f.api("/api/pools/automatic/confirm","POST",{confirmationId:p2.confirmationId})).status,409);assert.equal(f.calls.length,0);
}));
test("concurrent confirmation installs only one reviewed pool",async()=>fixture(async f=>{
 const p=await f.preview(),results=await Promise.all([f.confirm(p.confirmationId),f.confirm(p.confirmationId)]);
 assert.equal(results[0].pool.id,results[1].pool.id);assert.equal(f.store.pools().length,1);assert.equal(f.calls.length,0);
}));
test("adapter max_tokens repair and pool backup share the two physical request cap",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId);f.hook.detail="max_tokens exceeds maximum limit";
 f.hook.before=async()=>{f.status.a=f.calls.length===1?400:503;};
 const r=await f.request(`pool/${c.pool.id}`,{max_tokens:50000},"/v1/messages");assert.equal(r.status,503,await r.text());assert.deepEqual(f.calls.map(x=>x.source),["a","a"]);assert.equal(f.calls[1]!.body.max_tokens,undefined);
}));
test("source disable between attempts invalidates the grant instead of choosing a backup",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId);f.status.a=503;f.hook.before=async()=>{f.store.upsertProvider({...f.store.provider("a")!,off:true});};
 const r=await f.request(`pool/${c.pool.id}`);assert.equal(r.status,409,await r.text());assert.equal(f.calls.length,1);
}));
test("selected key is re-read after whole-list async checks before each physical dispatch",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId),get=f.secrets.get.bind(f.secrets);let readsOfB=0;
 f.secrets.get=async id=>{const value=await get(id);if(id==="b"&&++readsOfB===3)await f.secrets.set("a","changed-outside-wrapper");return value;};
 const r=await f.request(`pool/${c.pool.id}`);assert.equal(r.status,409,await r.text());assert.equal(f.calls.length,0);
}));

for (const code of [307,308]) test(`automatic rejects HTTP ${code} instead of following hidden redirect`,async()=>fixture(async f=>{
 const targetCalls:string[]=[];const target=createServer((req,res)=>{targetCalls.push(req.url!);res.end("unexpected");});const destination=await listen(target);
 try {const c=await f.confirm((await f.preview()).confirmationId);f.status.a=code;f.hook.redirect=destination+"/redirected";
 const r=await f.request(`pool/${c.pool.id}`);assert.equal(r.status,502,await r.text());assert.deepEqual(f.calls.map(x=>x.source),["a"]);assert.equal(targetCalls.length,0);
 }finally{await close(target);}
}));
for(const change of ["session", "global-budget", "source-budget"]) test(`loopback API final selected-key await cannot bypass changed ${change}`,async()=>fixture(async f=>{
 if(change==="global-budget")assert.equal((await f.api("/api/budget","PUT",{enabled:true,limitUsd:1,period:"day",action:"stop",warnAt:0.8})).status,200);
 const c=await f.confirm((await f.preview()).confirmationId),get=f.secrets.get.bind(f.secrets);let selectedReads=0,changed=false;
 f.secrets.get=async id=>{const value=await get(id);if(id==="a"&&++selectedReads===5)queueMicrotask(()=>{changed=true;if(change==="session")for(const s of f.auth.list())f.auth.revokeId(s.id);else if(change==="global-budget")f.ledger.append({at:new Date().toISOString(),model:"a/mock-coder",providerId:"a",route:"chat-translate",status:200,ms:1,costUsd:2});else f.store.setProviderBudgetChecker(p=>p.id==="a");});return value;};
 const r=await f.request(`pool/${c.pool.id}`);assert.equal(r.status,change==="session"?401:429,await r.text());assert.equal(changed,true);assert.equal(f.calls.length,0);
 if(change==="source-budget"){f.store.setProviderBudgetChecker(()=>false);const next=await f.request(`pool/${c.pool.id}`);assert.equal(next.status,200,await next.text());assert.deepEqual(f.calls.map(x=>x.source),["a"],"local guard failure did not mark source health");}
}));
test("loopback HTTP client cancellation after output cannot replay to another member",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId),abort=new AbortController();f.hook.stream=true;f.hook.keep=true;
 const r=await fetch(f.base+"/v1/chat/completions",{method:"POST",signal:abort.signal,headers:{"content-type":"application/json",authorization:`Bearer ${f.token}`},body:JSON.stringify({model:`pool/${c.pool.id}`,stream:true,messages:[{role:"user",content:"hi"}]})});
 assert.equal(r.status,200);const reader=r.body!.getReader();const first=await reader.read();assert.equal(first.done,false);abort.abort();await reader.read().catch(()=>{});await new Promise(r=>setTimeout(r,30));assert.deepEqual(f.calls.map(x=>x.source),["a"]);
}));
import {routeRequest} from "../src/gateway-route.ts";
test("direct gateway fallback to automatic cannot flatten it to first member",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId),automatic=`pool/${c.pool.id}`;
 const direct=createServer((req,res)=>void routeRequest(req,res,{model:"a/mock-coder",protocol:"chat",stream:false,body:{messages:[{role:"user",content:"hi"}]}},"aider",{store:f.store,secrets:f.secrets,log:()=>{},fallback:()=>({model:automatic,change:{fromModel:"a/mock-coder",toModel:automatic,reason:"source_unavailable",at:new Date().toISOString()}})}));
 try{const base=await listen(direct),r=await fetch(base);assert.equal(r.status,409);assert.match(await r.text(),/automatic_route_required/);assert.equal(f.calls.length,0);}finally{await close(direct);}
}));

test("all four automatic HTTP entrypoints dispatch only the reviewed source and key",async()=>fixture(async f=>{
 const c=await f.confirm((await f.preview()).confirmationId),model=`pool/${c.pool.id}`;
 const rows:[string,Record<string,unknown>][]=[
 ["/v1/chat/completions",{model,messages:[{role:"user",content:"chat text"}]}],
 ["/v1/responses",{model,input:"responses text"}],
 ["/v1/messages",{model,max_tokens:20,messages:[{role:"user",content:"messages text"}]}],
 [`/v1beta/models/${encodeURIComponent(model)}:generateContent`,{contents:[{role:"user",parts:[{text:"gemini text"}]}]}]];
 for(const [path,body] of rows){const r=await fetch(f.base+path,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${f.token}`},body:JSON.stringify(body)});assert.equal(r.status,200,await r.text());}
 assert.deepEqual(f.calls.map(x=>[x.source,x.key]),Array.from({length:4},()=>["a","Bearer fixture-a"]));
}));
