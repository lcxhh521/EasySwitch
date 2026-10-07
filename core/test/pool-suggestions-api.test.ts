import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { poolSuggestionDismissKey } from "../src/pool-suggestions.ts";

async function fixture(run: (store: Store, api: (path: string, method?: string, body?: unknown) => Promise<{status:number;body:any}>, dir:string) => Promise<void>) {
 const dir=mkdtempSync(join(tmpdir(),"es-pool-suggest-")),store=new Store(dir);store.setSettings({claudeNative:false});
 for(const [id,model,off] of [["a","DeepSeek-V4",false],["b","deepseek/deepseek-v4",false],["c","deepseek-v4-flash",false],["d","deepseek-v4",true]] as const)store.upsertProvider({id,name:id,models:[model],off,baseUrl:"http://127.0.0.1:1",route:"chat-translate",routePinned:true,streamUsage:false,createdAt:""});
 const never=()=>assert.fail("pool suggestions must not access credentials or programs");
 const server=createEasySwitchServer({store,port:0,secrets:{get:async()=>never(),set:async()=>never(),delete:async()=>never()},interactiveRuntime:{findBinary:async()=>never(),newSessionDir:never,launchInTerminal:async()=>never()}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 const api=async(path:string,method="GET",body?:unknown)=>{const r=await fetch(base+path,{method,headers:{"x-easyswitch":"1","content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json()};};
 try{await run(store,api,dir);}finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});}
}
test("fresh suggestions apply once, retain actual members, and remain ordinary editable pools",async()=>fixture(async(store,api)=>{
 const first=await api("/api/pools/suggestions");assert.equal(first.status,200);assert.equal(first.body.suggestions.length,1);const s=first.body.suggestions[0];
 assert.deepEqual(s.members.map((m:any)=>m.modelId),["a/DeepSeek-V4","b/deepseek/deepseek-v4"]);
 assert.equal((await api(`/api/pools/suggestions/${s.id}/apply`,"POST",{members:["d/deepseek-v4"]})).status,400);assert.equal(store.pools().length,0);
 const made=await api(`/api/pools/suggestions/${s.id}/apply`,"POST",{});assert.equal(made.status,200);assert.equal(made.body.strategy,"order");assert.equal(store.pools().length,1);
 assert.equal((await api(`/api/pools/suggestions/${s.id}/apply`,"POST",{})).status,409);assert.equal(store.pools().length,1);
 assert.deepEqual((await api("/api/pools/suggestions")).body.suggestions,[]);
 assert.equal((await api(`/api/pools/${made.body.id}`,"PUT",{name:"Chosen name",strategy:"rotate",members:made.body.members})).status,200);
 assert.equal(store.pool(made.body.id)!.name,"Chosen name");assert.equal((await api(`/api/pools/${made.body.id}`,"DELETE")).status,200);
}));
test("dismissal persists across restart and stale catalogue suggestions cannot apply",async()=>fixture(async(store,api,dir)=>{
 let s=(await api("/api/pools/suggestions")).body.suggestions[0];store.upsertProvider({...store.provider("b")!,off:true});
 assert.equal((await api(`/api/pools/suggestions/${s.id}/apply`,"POST",{})).status,409);assert.equal(store.pools().length,0);
 store.upsertProvider({...store.provider("b")!,off:false});s=(await api("/api/pools/suggestions")).body.suggestions[0];
 assert.equal((await api(`/api/pools/suggestions/${s.id}/dismiss`,"POST",{})).status,200);assert.deepEqual((await api("/api/pools/suggestions")).body.suggestions,[]);
 assert.deepEqual(new Store(dir).dismissedPoolSuggestions(),[poolSuggestionDismissKey("deepseek-v4")]);
 assert.ok(!readFileSync(join(dir,"state.json"),"utf8").includes("apiKey"));
}));
test("failed writes do not keep an in-memory pool or dismissal as if saved",()=>{
 const dir=mkdtempSync(join(tmpdir(),"es-pool-write-")),store=new Store(dir);
 try{mkdirSync(join(dir,"state.json.tmp"));assert.throws(()=>store.dismissPoolSuggestion(poolSuggestionDismissKey("m")));assert.deepEqual(store.dismissedPoolSuggestions(),[]);
 assert.throws(()=>store.upsertPool({id:"fixture",name:"M",members:["a/m","b/m"],strategy:"order",createdAt:""}));assert.deepEqual(store.pools(),[]);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
