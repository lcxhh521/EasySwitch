import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.ts";
import { createSecretStore } from "../src/secrets.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { Ledger } from "../src/ledger.ts";
import { mintAutomaticApproval } from "../src/automatic-approval.ts";
import { poolEfforts } from "../src/pools.ts";

type J = Record<string, any>;
const listen = (server: Server) => new Promise<string>(r => server.listen(0,"127.0.0.1",()=>r(`http://127.0.0.1:${(server.address() as {port:number}).port}`)));
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); };
const tools = [{type:"function",function:{name:"read_file",description:"Fixture only",parameters:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false}}}];
const user = {role:"user",content:"Read the fixture"};
const toolCall = (id="call_fixture") => ({id,type:"function",function:{name:"read_file",arguments:'{"path":"fixture.txt"}'}});
const history = (id="call_fixture") => [user,{role:"assistant",content:null,tool_calls:[toolCall(id)]},{role:"tool",tool_call_id:id,content:"fixture contents"}];
async function fixture(run:(f:{store:Store;secrets:ReturnType<typeof createSecretStore>;auth:GatewayTokenAuthority;ledger:Ledger;calls:J[];hook:{status?:number;before?:()=>Promise<void>;mode?:"text"|"stream"|"partial"|"malformed"};api:(path:string,body?:J,method?:string)=>Promise<{status:number;body:J}>;launch:(options?:J)=>Promise<{status:number;body:J}>;confirm:()=>Promise<string>;request:(token:string,model:string,extra?:J,path?:string)=>Promise<Response>;restart:()=>Promise<void>;terminalCalls:()=>number})=>Promise<void>) {
  const dir=mkdtempSync(join(tmpdir(),"es-tool-api-")),store=new Store(dir),secrets=createSecretStore(),ledger=new Ledger(dir),auth=new GatewayTokenAuthority();
  const calls:J[]=[],hook:{status?:number;before?:()=>Promise<void>;mode?:"text"|"stream"|"partial"|"malformed"}={};let terminalCalls=0;
  const upstream=createServer(async(req,res)=>{let raw="";for await(const c of req)raw+=c;const body=JSON.parse(raw),source=req.url!.split("/")[1]!;calls.push({source,key:req.headers.authorization,body});await hook.before?.();
    if(hook.status && hook.status!==200){res.writeHead(hook.status,{"content-type":"application/json"});res.end(JSON.stringify({error:{message:"fixture refusal"}}));return;}
    if(hook.mode==="partial"){res.writeHead(200,{"content-type":"text/event-stream"});res.write('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock-coder","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');setTimeout(()=>res.destroy(),5);return;}
    if(hook.mode==="malformed"){res.writeHead(200,{"content-type":"application/json"});res.end('{"choices":[]');return;}
    if(hook.mode==="stream"){res.writeHead(200,{"content-type":"text/event-stream"});for(const delta of [{role:"assistant",tool_calls:[{index:0,id:"call_fixture",type:"function",function:{name:"read_file",arguments:""}}]},{tool_calls:[{index:0,function:{arguments:'{"path":'}}]},{tool_calls:[{index:0,function:{arguments:'"fixture.txt"}'}}]}])res.write(`data: ${JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:"mock-coder",choices:[{index:0,delta,finish_reason:null}]})}\n\n`);res.end('data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"mock-coder","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n');return;}
    const continued=body.messages?.some((m:J)=>m.role==="tool")||hook.mode==="text";
    res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({id:"fixture",object:"chat.completion",created:1,model:"mock-coder",choices:[{index:0,message:continued?{role:"assistant",content:"done"}:{role:"assistant",content:null,tool_calls:[toolCall()]},finish_reason:continued?"stop":"tool_calls"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}));
  });const origin=await listen(upstream);
  for(const id of ["a","b"]){store.upsertProvider({id,name:id,baseUrl:`${origin}/${id}/v1`,models:["mock-coder"],route:"chat-translate",routePinned:true,protocols:["chat"],streamUsage:false,createdAt:""});await secrets.set(id,`fixture-${id}`);}
  store.setSettings({claudeNative:false});store.setBinding({harness:"opencode",providerId:"a",model:"mock-coder"});
  const make=()=>createEasySwitchServer({store,secrets,ledger,gatewayAuth:auth,port:0,interactiveRuntime:{findBinary:async()=>"/fixture/never-run-opencode",newSessionDir:()=>mkdtempSync(join(dir,"session-")),launchInTerminal:async()=>{terminalCalls++;}}});
  let server=make(),base=await listen(server);
  const api=async(path:string,body?:J,method=body?"POST":"GET")=>{const r=await fetch(base+path,{method,headers:{"content-type":"application/json","x-easyswitch":"1"},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json() as J};};
  const confirm=async()=>{const p=await api("/api/pools/automatic/preview",{modelId:"a/mock-coder",harness:"opencode"});assert.equal(p.status,200,JSON.stringify(p.body));const c=await api("/api/pools/automatic/confirm",{confirmationId:p.body.confirmationId});assert.equal(c.status,200,JSON.stringify(c.body));return`pool/${c.body.pool.id}`;};
  const launch=async(options:J={})=>{const state=await api("/api/state"),pools=await api("/api/pools"),pool=pools.body.pools?.find((p:J)=>`pool/${p.id}`===options.model)??(Array.isArray(pools.body)?pools.body.find((p:J)=>`pool/${p.id}`===options.model):undefined);return api("/api/agents/opencode/command",{automaticTools:true,automaticToolsApprovalId:pool?.automaticToolsApprovalId,automaticToolsLaunchReviewId:state.body.automaticToolLaunchReviews?.opencode,...options});};
  const request=(token:string,model:string,extra:J={},path="/v1/chat/completions")=>fetch(base+path,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${token}`},body:JSON.stringify({model,messages:[user],tools,...extra})});
  try{await run({store,secrets,auth,ledger,calls,hook,api,launch,confirm,request,restart:async()=>{await close(server);server=make();base=await listen(server);},terminalCalls:()=>terminalCalls});}finally{await close(server);await close(upstream);rmSync(dir,{recursive:true,force:true});}
}
function tokenOf(command:J):string{return JSON.parse(command.env.OPENCODE_CONFIG_CONTENT).provider.easyswitch.options.apiKey;}

test("tool launch omits variants only for its exact main pool and preserves fixed sources, other pools and P0",async()=>fixture(async f=>{
  f.store.upsertProvider({...f.store.provider("a")!,modelEfforts:{"mock-coder":["high","none","xhigh"]}});
  f.store.upsertProvider({...f.store.provider("b")!,modelEfforts:{"mock-coder":["none","high"]}});
  const other=await f.confirm();f.store.setBinding({harness:"opencode",providerId:"a",model:"mock-coder"});const model=await f.confirm();assert.notEqual(other,model);
  f.store.upsertPool({id:"fixed-pool",name:"Fixed fixture",strategy:"order",members:["a/mock-coder","b/mock-coder"],createdAt:""});
  f.store.setPrefs("opencode",{tiers:{small:"b/mock-coder",subagent:"a/mock-coder"}});
  const before={providers:f.store.providers(),pools:f.store.pools(),prefs:f.store.prefs("opencode"),binding:f.store.binding("opencode")};
  assert.deepEqual(poolEfforts(f.store,f.store.pool(model.slice(5))!),["high","none"],"the source intersection really is nonempty before per-launch suppression");
  const made=await f.launch({model});assert.equal(made.status,200,JSON.stringify(made.body));
  const config=JSON.parse(made.body.env.OPENCODE_CONFIG_CONTENT),models=config.provider.easyswitch.models;
  assert.deepEqual(Object.keys(models),[model,"a/mock-coder","b/mock-coder",other,"pool/fixed-pool"]);
  assert.deepEqual(Object.keys(models[model].variants??{}),[]);
  assert.ok(!made.body.args.includes("--variant"));
  assert.deepEqual(Object.keys(models["a/mock-coder"].variants),["high","none","xhigh"]);
  assert.deepEqual(Object.keys(models["b/mock-coder"].variants),["none","high"]);
  for(const name of [other,"pool/fixed-pool"])assert.deepEqual(Object.keys(models[name].variants),["high","none"]);
  assert.equal(config.small_model,"easyswitch/b/mock-coder");assert.equal(config.agent.general.model,"easyswitch/a/mock-coder");assert.equal(config.agent.explore.model,"easyswitch/a/mock-coder");
  // Pure simulation of OpenCode smallOptions selecting the first variant. No SDK,
  // client execution or user-config merge is exercised by this regression.
  const smallOptions=(entry:J)=>Object.values(entry.variants??{})[0]??{};
  assert.deepEqual(smallOptions(models[model]),{},"a small task falling back to the main pool gets no injected reasoning effort");
  assert.deepEqual(smallOptions(models["b/mock-coder"]),{reasoningEffort:"none"},"an explicitly fixed small model keeps its own first variant");
  const ordinary=await f.launch({model,automaticTools:false});assert.equal(ordinary.status,200);
  assert.deepEqual(Object.keys(JSON.parse(ordinary.body.env.OPENCODE_CONFIG_CONTENT).provider.easyswitch.models[model].variants),["high","none"],"do not silently change P0 effort policy");
  assert.deepEqual({providers:f.store.providers(),pools:f.store.pools(),prefs:f.store.prefs("opencode"),binding:f.store.binding("opencode")},before);
  assert.equal(f.calls.length,0);assert.equal(f.terminalCalls(),0);
}));

test("reviewed tool launch keeps out-of-catalog small and subagent capabilities",async()=>fixture(async f=>{
  f.store.upsertProvider({...f.store.provider("a")!,modelEfforts:{"mock-coder":["high"],"manual-small":["off","low"]}});
  f.store.upsertProvider({...f.store.provider("b")!,modelEfforts:{"mock-coder":["high"],"manual-child":["max","medium"]}});
  const model=await f.confirm();f.store.setPrefs("opencode",{tiers:{small:"a/manual-small",subagent:"b/manual-child"}});
  assert.ok(f.store.catalog().every(m=>!m.model.startsWith("manual-")));
  const made=await f.launch({model});assert.equal(made.status,200,JSON.stringify(made.body));const config=JSON.parse(made.body.env.OPENCODE_CONFIG_CONTENT),models=config.provider.easyswitch.models;
  assert.deepEqual(Object.keys(models["a/manual-small"].variants),["off","low"]);assert.deepEqual(Object.keys(models["b/manual-child"].variants),["max","medium"]);
  assert.equal(config.small_model,"easyswitch/a/manual-small");assert.equal(config.agent.general.model,"easyswitch/b/manual-child");
  assert.deepEqual(Object.keys(models[model].variants??{}),[]);assert.equal(f.calls.length,0);assert.equal(f.terminalCalls(),0);
}));

for(const source of ["request","preferences"])test(`tool launch still rejects a model-supported nondefault effort from ${source}`,async()=>fixture(async f=>{
  for(const id of ["a","b"])f.store.upsertProvider({...f.store.provider(id)!,modelEfforts:{"mock-coder":["high"]}});
  const model=await f.confirm();if(source==="preferences")f.store.setPrefs("opencode",{effort:"high"});
  const made=await f.launch({model,...(source==="request"?{effort:"high"}:{})});assert.equal(made.status,400,JSON.stringify(made.body));assert.equal(made.body.code,"capability_unavailable","the existing public error facade normalizes unsupported-effort errors");
  assert.equal(made.body.env,undefined);assert.equal(f.store.prefs("opencode").effort,source==="preferences"?"high":undefined);
  assert.equal(f.auth.list().length,0);assert.equal(f.calls.length,0);assert.equal(f.terminalCalls(),0);
}));

test("explicit tool launch creates a marked scope without inference and preserves configured small models",async()=>fixture(async f=>{
  const model=await f.confirm();f.store.setPrefs("opencode",{tiers:{small:"b/mock-coder",subagent:"a/mock-coder"}});
  const made=await f.launch({model});assert.equal(made.status,200,JSON.stringify(made.body));const session=f.auth.list().find(s=>s.id===made.body.session.id)!;
  assert.deepEqual(Object.keys((session as any).automaticTools).sort(),["approvalId","poolId","version"]);assert.equal((session as any).automaticTools.poolId,model.slice(5));
  const config=JSON.parse(made.body.env.OPENCODE_CONFIG_CONTENT);assert.equal(config.small_model,"easyswitch/b/mock-coder");assert.equal(config.agent.general.model,"easyswitch/a/mock-coder");assert.equal(f.calls.length,0);assert.equal(f.terminalCalls(),0);
}));
test("tool mode is explicit and rejects invalid flags, direct models and non-OpenCode launch targets",async()=>fixture(async f=>{
  const model=await f.confirm();for(const automaticTools of ["true",1,{},null]){const r=await f.launch({model,automaticTools});assert.equal(r.status,400,JSON.stringify(r.body));}
  assert.equal((await f.launch({model:"a/mock-coder"})).status,409);assert.equal((await f.api("/api/agents/aider/command",{model,automaticTools:true})).status,400);assert.equal(f.auth.list().length,0);assert.equal(f.calls.length,0);
}));
test("old sessions stay P0 and do not gain tool mode from the request body",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model,automaticTools:false});assert.equal(made.status,200);assert.equal((f.auth.list()[0] as any).automaticTools,undefined);
  const r=await f.request(tokenOf(made.body),model);assert.equal(r.status,400);assert.equal(f.calls.length,0);
}));
test("ordinary Chat function request, tool result and a later subtask keep the same approved source and key",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);
  let r=await f.request(token,model);assert.equal(r.status,200);assert.deepEqual((await r.json() as J).choices[0].message.tool_calls,[toolCall()]);
  r=await f.request(token,model,{messages:history()});assert.equal(r.status,200);assert.equal((await r.json() as J).choices[0].message.content,"done");
  f.hook.mode="text";r=await f.request(token,model,{messages:[{role:"user",content:"Another subtask"}]});assert.equal(r.status,200);await r.text();
  assert.deepEqual(f.calls.map(c=>[c.source,c.key,c.body.model]),[["a","Bearer fixture-a","mock-coder"],["a","Bearer fixture-a","mock-coder"],["a","Bearer fixture-a","mock-coder"]]);
}));
test("unowned and modified tool histories cause zero dispatch",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);
  let r=await f.request(token,model,{messages:history("foreign")});assert.equal(r.status,400);assert.equal(f.calls.length,0);
  r=await f.request(token,model);await r.text();assert.equal(f.calls.length,1);
  const messages=history();(messages[1] as any).tool_calls[0].function.arguments='{"path":"different.txt"}';r=await f.request(token,model,{messages});assert.equal(r.status,400);assert.equal(f.calls.length,1);
}));
test("SSE function fragments are captured before a following result is accepted",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);f.hook.mode="stream";
  const r=await f.request(token,model,{stream:true});assert.equal(r.status,200);assert.match(await r.text(),/\[DONE\]/);f.hook.mode="text";
  const next=await f.request(token,model,{messages:history()});assert.equal(next.status,200,await next.text());assert.equal(f.calls.length,2);assert.deepEqual(f.calls.map(c=>c.source),["a","a"]);
}));
for(const status of [401,429,503])test(`HTTP ${status} never rotates key/source and permanently pauses that launch`,async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);f.hook.status=status;
  let r=await f.request(token,model);assert.equal(r.status,status);await r.text();assert.equal(f.calls.length,1);f.hook.status=200;
  r=await f.request(token,model);assert.equal(r.status,409);assert.match(await r.text(),/新|暂停/);assert.equal(f.calls.length,1);
}));
for(const mode of ["partial","malformed"] as const)test(`${mode} output is not replayed or treated as a resumable success`,async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);f.hook.mode=mode;
  await f.request(token,model,{stream:mode==="partial"}).then(r=>r.text()).catch(()=>undefined);assert.equal(f.calls.length,1);f.hook.mode="text";
  const next=await f.request(token,model);assert.equal(next.status,409,await next.text());assert.equal(f.calls.length,1);
}));
test("restart retains mode marker but refuses to recreate a lost pin or fall back to P0",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);f.hook.mode="text";
  assert.equal((await f.request(token,model)).status,200);await f.restart();const r=await f.request(token,model,{tools:[]});assert.equal(r.status,409,await r.text());assert.equal(f.calls.length,1);
}));
test("deleting or replacing marked pool cannot make the token use a legacy route",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body),pool=f.store.pool(model.slice(5))!;f.store.upsertPool({...pool,strategy:"order"});
  const r=await f.request(token,model,{tools:[]});assert.equal(r.status,409,await r.text());assert.equal(f.calls.length,0);
}));
test("same-id secret replacement after first output stops without reading another account",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);await(await f.request(token,model)).text();await f.secrets.set("a","replacement-fixture");
  const r=await f.request(token,model,{messages:history()});assert.equal(r.status,409,await r.text());assert.equal(f.calls.length,1);
}));
test("global budget stops a pinned continuation without an extra physical request",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);await(await f.request(token,model)).text();
  assert.equal((await f.api("/api/budget",{enabled:true,limitUsd:1,period:"day",action:"stop",warnAt:0.8},"PUT")).status,200);f.ledger.append({at:new Date().toISOString(),model:"a/mock-coder",providerId:"a",route:"chat-translate",status:200,ms:1,costUsd:2});
  const r=await f.request(token,model,{messages:history()});assert.equal(r.status,429,await r.text());assert.equal(f.calls.length,1);
}));
test("ordinary fixed small model requests remain explicitly fixed, not captured by the automatic pin",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);f.hook.mode="text";let r=await f.request(token,model);await r.text();
  r=await f.request(token,"b/mock-coder",{tools:[]});assert.equal(r.status,200,await r.text());assert.deepEqual(f.calls.map(c=>c.source),["a","b"]);
}));
test("stale consent fingerprint cannot launch a newer same-labelled approval",async()=>fixture(async f=>{
  const model=await f.confirm(),pools=await f.api("/api/pools"),pool=pools.body.pools.find((p:J)=>`pool/${p.id}`===model);
  const current=f.store.pool(model.slice(5))!;f.store.upsertPool({...current,automaticApproval:await mintAutomaticApproval(f.store,f.secrets,current.members)});
  const r=await f.launch({model,automaticToolsApprovalId:pool.automaticToolsApprovalId});assert.equal(r.status,409);assert.equal(f.auth.list().length,0);assert.equal(f.calls.length,0);assert.match(pool.automaticToolsApprovalId,/^[a-f0-9]{64}$/);
}));
test("a server restart before first inference does not register a persisted tool token lazily",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);await f.restart();const r=await f.request(token,model,{tools:[]});assert.equal(r.status,409,await r.text());assert.equal(f.calls.length,0);
}));
test("another automatic pool cannot enter P0 beneath a marked tool launch",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);f.store.setBinding({harness:"opencode",providerId:"a",model:"mock-coder"});const other=await f.confirm();assert.notEqual(other,model);
  let r=await f.request(token,other,{tools:[]});assert.equal(r.status,409,await r.text());r=await f.request(token,model);assert.equal(r.status,409);assert.equal(f.calls.length,0);
}));
test("budget rejection pauses the launch even if the user later raises its budget",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);await(await f.request(token,model)).text();
  await f.api("/api/budget",{enabled:true,limitUsd:1,period:"day",action:"stop",warnAt:0.8},"PUT");f.ledger.append({at:new Date().toISOString(),model:"a/mock-coder",providerId:"a",route:"chat-translate",status:200,ms:1,costUsd:2});
  assert.equal((await f.request(token,model,{messages:history()})).status,429);await f.api("/api/budget",{enabled:false,limitUsd:1,period:"day",action:"stop",warnAt:0.8},"PUT");
  const r=await f.request(token,model,{messages:history()});assert.equal(r.status,409,await r.text());assert.equal(f.calls.length,1);
}));
test("a Messages request under the tool model is refused before dispatch, not converted",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);const r=await f.request(token,model,{tools:[],max_tokens:100},"/v1/messages");assert.equal(r.status,400,await r.text());assert.equal(f.calls.length,0);
}));
test("a newly launched scope cannot import tool IDs from an older launch",async()=>fixture(async f=>{
  const model=await f.confirm(),first=await f.launch({model});await(await f.request(tokenOf(first.body),model)).text();const second=await f.launch({model});
  const r=await f.request(tokenOf(second.body),model,{messages:history()});assert.equal(r.status,400,await r.text());assert.equal(f.calls.length,1);
}));
test("concurrent first requests cannot split the launch across two selected sources",async()=>fixture(async f=>{
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);let entered!:()=>void,release!:()=>void;
  const started=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);f.hook.mode="text";f.hook.before=async()=>{entered();await blocked;};
  const first=f.request(token,model);await started;const second=await f.request(token,model);assert.equal(second.status,409,await second.text());assert.equal(f.calls.length,1);release();assert.equal((await first).status,200);
}));
test("first selection skips an explicitly incompatible protocol but only inside the confirmed list",async()=>fixture(async f=>{
  f.store.upsertProvider({...f.store.provider("a")!,protocols:["messages"],route:"chat-translate",messagesRoute:"anthropic-native"});
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body);const r=await f.request(token,model);assert.equal(r.status,200,await r.text());assert.deepEqual(f.calls.map(c=>c.source),["b"]);
}));
test("all sources explicitly incompatible with Chat stop without any upstream call",async()=>fixture(async f=>{
  for(const id of ["a","b"])f.store.upsertProvider({...f.store.provider(id)!,protocols:["messages"],route:"chat-translate",messagesRoute:"anthropic-native"});
  const model=await f.confirm(),made=await f.launch({model}),token=tokenOf(made.body),r=await f.request(token,model);assert.equal(r.status,400,await r.text());assert.equal(f.calls.length,0);
}));
test("binding changed between review and POST cannot launch the old automatic selection",async()=>fixture(async f=>{
  const model=await f.confirm();f.store.setBinding({harness:"opencode",providerId:"b",model:"mock-coder"});
  const made=await f.launch({model});assert.equal(made.status,409,JSON.stringify(made.body));assert.equal(f.auth.list().length,0);assert.equal(f.calls.length,0);
}));
test("reviewed launch preferences cannot change between the last UI read and POST",async()=>fixture(async f=>{
  const model=await f.confirm(),review=await f.api("/api/state");f.store.setPrefs("opencode",{tiers:{small:"b/mock-coder"}});
  const made=await f.launch({model,automaticToolsLaunchReviewId:review.body.automaticToolLaunchReviews?.opencode});assert.equal(made.status,409);assert.equal(f.auth.list().length,0);assert.equal(f.calls.length,0);
}));
test("preferences changing while the reviewed credentials are read cannot silently replace a fixed small model",async()=>fixture(async f=>{
  const model=await f.confirm();f.store.setPrefs("opencode",{tiers:{small:"b/mock-coder"}});const review=(await f.api("/api/state")).body,pool=review.pools.find((p:J)=>`pool/${p.id}`===model);const get=f.secrets.get.bind(f.secrets);let changed=false;
  f.secrets.get=async id=>{const value=await get(id);if(!changed){changed=true;f.store.setPrefs("opencode",{effort:"high",tiers:{small:"a/mock-coder"}});}return value;};
  const made=await f.api("/api/agents/opencode/command",{model,automaticTools:true,automaticToolsApprovalId:pool.automaticToolsApprovalId,automaticToolsLaunchReviewId:review.automaticToolLaunchReviews.opencode});assert.equal(changed,true);assert.equal(made.status,409);assert.equal(f.auth.list().length,0);assert.equal(f.terminalCalls(),0);assert.equal(f.calls.length,0);
}));
for(const when of ["before POST","during credential validation"])test(`a fixed small-model source becoming unavailable ${when} cannot silently follow the main model`,async()=>fixture(async f=>{
  f.store.upsertProvider({...f.store.provider("a")!,id:"c",name:"Small fixture",models:["tiny"]});await f.secrets.set("c","fixture-c");
  const model=await f.confirm();f.store.setPrefs("opencode",{tiers:{small:"c/tiny",subagent:"c/tiny"}});const review=(await f.api("/api/state")).body,pool=review.pools.find((p:J)=>`pool/${p.id}`===model);
  const disable=()=>f.store.upsertProvider({...f.store.provider("c")!,off:true});
  if(when==="before POST")disable();else{const get=f.secrets.get.bind(f.secrets);let once=false;f.secrets.get=async id=>{const value=await get(id);if(!once){once=true;disable();}return value;};}
  const made=await f.api("/api/agents/opencode/command",{model,automaticTools:true,automaticToolsApprovalId:pool.automaticToolsApprovalId,automaticToolsLaunchReviewId:review.automaticToolLaunchReviews.opencode});
  assert.equal(made.status,409);assert.equal(f.auth.list().length,0);assert.equal(f.terminalCalls(),0);assert.equal(f.calls.length,0);
}));
