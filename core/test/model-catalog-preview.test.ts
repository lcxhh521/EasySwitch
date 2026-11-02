import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createServer, request } from "node:http";
import { Store } from "../src/store.ts";
import { ModelCatalogPreviews, ModelCatalogError } from "../src/model-catalog-preview.ts";
function memorySecrets() { const values = new Map<string,string>(); return { async get(id:string){return values.get(id)},async set(id:string,value:string){values.set(id,value)},async delete(id:string){values.delete(id)} }; }
import { createEasySwitchServer } from "../src/server.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { keySecretId } from "../src/keypool.ts";
import type { Provider } from "../src/types.ts";

const source = (): Provider => ({ id:"source", name:"Source", baseUrl:"https://example.invalid/v1", models:["old","kept"], defaultModel:"old", route:"chat-translate", routePinned:true, streamUsage:true, createdAt:"2026-01-01" });
function fixture(t:TestContext) {
 const dir=mkdtempSync(join(tmpdir(),"es-catalog-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new Store(dir), secrets=memorySecrets();store.upsertProvider(source());
 return {store,secrets};
}
const listing = (models:string[]) => async()=>({models,check:{id:"models" as const,label:"目录",detail:"synthetic",status:"pass" as const}});
const isConflict=(error:unknown)=>error instanceof ModelCatalogError&&error.status===409;

test("preview is read-only, deduplicates discovery; confirmation adds selected only and preserves all existing fields",async t=>{
 const {store,secrets}=fixture(t);store.setBinding({harness:"claude",providerId:"source",model:"old"});
 const p={...source(),off:true,models:["old","kept","old"],modelProtocols:{old:["messages"] as ("messages")[]}};store.upsertProvider(p as Provider);
 const service=new ModelCatalogPreviews(store,secrets,{list:listing(["kept","new","new","other"])});
 const before=JSON.stringify((store as any).state),preview=await service.preview("source");
 assert.equal(JSON.stringify((store as any).state),before);assert.deepEqual(preview.added,["new","other"]);assert.deepEqual(preview.existing,["kept"]);assert.deepEqual(preview.missing,["old"]);assert.equal(preview.discoveredCount,3);assert.equal(preview.limit,500);
 assert.doesNotMatch(JSON.stringify(preview),/baseUrl|credential|configuration|example.invalid/);
 assert.deepEqual(await service.apply("source",preview.token,["other"]),{added:["other"],modelCount:4});assert.deepEqual(store.provider("source"),{...p,models:["old","kept","old","other"]});assert.equal(store.binding("claude")?.model,"old");
 await assert.rejects(service.apply("source",preview.token,["other"]),isConflict);
});

test("rejects forged, cross-source, duplicate, invalid and non-discovered selections without writes",async t=>{
 const {store,secrets}=fixture(t),service=new ModelCatalogPreviews(store,secrets,{list:listing(["new"])}),p=await service.preview("source"),before=JSON.stringify((store as any).state);
 for(const models of [[],["new","new"],["old"],["invented"],["__proto__"],[42],null])await assert.rejects(service.apply("source",p.token,models));
 await assert.rejects(service.apply("source","aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",["new"]),isConflict);await assert.rejects(service.apply("another",p.token,["new"]),isConflict);
 assert.equal(JSON.stringify((store as any).state),before);await service.apply("source",p.token,["new"]);
});

test("expiry, superseded previews, config ABA, credential revision and secret replacement invalidate consent",async t=>{
 for(const change of ["expiry","new-preview","config","aba","credential-revision","secret","delete"]){
 const {store,secrets}=fixture(t);let now=1000;const service=new ModelCatalogPreviews(store,secrets,{now:()=>now,list:listing(["new"])}),p=await service.preview("source");
 if(change==="expiry")now+=300000;
 if(change==="new-preview")await service.preview("source");
 if(change==="config")store.upsertProvider({...source(),name:"Changed"});
 if(change==="aba"){store.upsertProvider({...source(),baseUrl:"https://other.invalid/v1"});store.upsertProvider(source());}
 if(change==="credential-revision")store.touchCredentialRevision("source");
 if(change==="secret")await secrets.set("source","synthetic-changed");
 if(change==="delete")store.removeProvider("source");
 const before=JSON.stringify((store as any).state);await assert.rejects(service.apply("source",p.token,["new"]));assert.equal(JSON.stringify((store as any).state),before,change);
 }
});

test("discovery rejects drift during request and during key read; never publishes stale preview",async t=>{
 const {store,secrets}=fixture(t);const service=new ModelCatalogPreviews(store,secrets,{list:async()=>{store.upsertProvider({...source(),models:["changed"]});return listing(["new"])();}});
 await assert.rejects(service.preview("source"),isConflict);
 const reading={...secrets,get:async()=>{store.upsertProvider({...source(),name:"changed-again"});return "synthetic";},set:async()=>{},delete:async()=>{}};
 await assert.rejects(new ModelCatalogPreviews(store,reading,{list:listing(["new"])}).preview("source"),isConflict);
});

test("credential changes during discovery reject; first enabled key is stable and never updates use/rest/rotation",async t=>{
 const {store,secrets}=fixture(t);const keys=[{id:"disabled",label:"D",enabled:false,addedAt:""},{id:"first",label:"F",enabled:true,addedAt:"",restUntil:"2099-01-01"},{id:"second",label:"S",enabled:true,addedAt:""}];store.upsertProvider({...source(),keys});
 await secrets.set(keySecretId("source","first"),"synthetic-first");await secrets.set(keySecretId("source","second"),"synthetic-second");
 const before=JSON.stringify((store as any).state),seen:string[]=[];
 const service=new ModelCatalogPreviews(store,secrets,{list:async(_p,key)=>{seen.push(key!);return listing(["new"])();}});await service.preview("source");await service.preview("source");assert.deepEqual(seen,["synthetic-first","synthetic-first"]);assert.equal(JSON.stringify((store as any).state),before);
 const drift=new ModelCatalogPreviews(store,secrets,{list:async()=>{await secrets.set(keySecretId("source","first"),"synthetic-change");return listing(["new"])();}});await assert.rejects(drift.preview("source"),isConflict);
});

test("unsupported identities, malformed IDs, failed/empty catalogs and unreadable credentials fail safely",async t=>{
 const {store,secrets}=fixture(t);let requests=0;
 for(const field of ["plan","vertex","mimoFree","cliTextBridge","antigravity","kimi","cursor","kiro"]){store.upsertProvider({...source(),[field]:false});await assert.rejects(new ModelCatalogPreviews(store,secrets,{list:async()=>{requests++;return listing(["new"])();}}).preview("source"),isConflict);}assert.equal(requests,0);store.upsertProvider(source());
 for(const models of [[" bad"],["a\nb"],["a b"],["a".repeat(513)],["__proto__"],["constructor"],Array(501).fill("new")])await assert.rejects(new ModelCatalogPreviews(store,secrets,{list:listing(models)}).preview("source"),e=>e instanceof ModelCatalogError&&e.status===502);
 const fail=new ModelCatalogPreviews(store,secrets,{list:async()=>({models:[],check:{id:"models",label:"models",status:"fail",detail:"SECRET upstream private detail"}})});await assert.rejects(fail.preview("source"),e=>e instanceof ModelCatalogError&&!e.message.includes("SECRET"));
 const broken={get:async()=>{throw new Error("SECRET")},set:async()=>{},delete:async()=>{}};await assert.rejects(new ModelCatalogPreviews(store,broken).preview("source"),e=>e instanceof ModelCatalogError&&e.status===503&&!e.message.includes("SECRET"));
 store.upsertProvider({...source(),keys:[{id:"a",enabled:false,label:"",addedAt:""}]});await assert.rejects(new ModelCatalogPreviews(store,secrets).preview("source"),isConflict);
});

test("aborted requests never yield consent or write; overlapping request guarded and concurrent apply only once",async t=>{
 const {store,secrets}=fixture(t);const controller=new AbortController();controller.abort();const service=new ModelCatalogPreviews(store,secrets,{list:listing(["new"])});await assert.rejects(service.preview("source",controller.signal));
 const p=await service.preview("source"),before=JSON.stringify((store as any).state);await assert.rejects(service.apply("source",p.token,["new"],controller.signal));assert.equal(JSON.stringify((store as any).state),before);
 const results=await Promise.allSettled([service.apply("source",p.token,["new"]),service.apply("source",p.token,["new"])]);assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 let unblock!:()=>void;const blocked=new Promise<void>(r=>unblock=r);const slow=new ModelCatalogPreviews(store,secrets,{list:async()=>{await blocked;return listing(["other"])();}});const first=slow.preview("source");await assert.rejects(slow.preview("source"),isConflict);unblock();await first;
});

test("persistence failure rolls back, preserves consent for retry, and never accepts an empty added selection",async t=>{
 const {store,secrets}=fixture(t),service=new ModelCatalogPreviews(store,secrets,{list:listing(["new"])}),p=await service.preview("source"),before=JSON.stringify((store as any).state),save=(store as any).save;
 (store as any).save=()=>{throw new Error("synthetic disk failure")};await assert.rejects(service.apply("source",p.token,["new"]));assert.equal(JSON.stringify((store as any).state),before);(store as any).save=save;await service.apply("source",p.token,["new"]);
 const empty=await service.preview("source");assert.deepEqual(empty.added,[]);await assert.rejects(service.apply("source",empty.token,[]));
});

test("HTTP workflow contacts only catalog GET, header protected, adds selected without inference or secret disclosure",async t=>{
 const {store,secrets}=fixture(t);const paths:string[]=[];const vendor=createServer((req,res)=>{paths.push(`${req.method} ${req.url}`);assert.equal(req.headers.authorization,"Bearer synthetic-token");res.setHeader("content-type","application/json");res.end(JSON.stringify({data:[{id:"kept"},{id:"new"},{id:"other"}]}));});await new Promise<void>(r=>vendor.listen(0,"127.0.0.1",r));t.after(()=>{vendor.closeAllConnections();vendor.close();});
 store.upsertProvider({...source(),baseUrl:`http://127.0.0.1:${(vendor.address() as any).port}/v1`});await secrets.set("source","synthetic-token");
 const server=createEasySwitchServer({store,secrets,port:0,gatewayAuth:new GatewayTokenAuthority()});await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(()=>{server.closeAllConnections();server.close();});
 const http=(path:string,body:unknown={},header=true)=>new Promise<{status:number;body:any}>((resolve,reject)=>{const q=request(`http://127.0.0.1:${(server.address() as any).port}/api/providers/source/catalog-${path}`,{method:"POST",headers:header?{"x-easyswitch":"1"}:{}},r=>{let data="";r.on("data",d=>data+=d);r.on("end",()=>resolve({status:r.statusCode!,body:JSON.parse(data)}));});q.on("error",reject);q.end(JSON.stringify(body));});
 assert.equal((await http("preview",{},false)).status,403);for(const bad of [null,[],1,{models:["new"]}])assert.equal((await http("preview",bad)).status,400);
 const p=await http("preview");assert.equal(p.status,200);assert.deepEqual(paths,["GET /v1/models"]);assert.doesNotMatch(JSON.stringify(p.body),/synthetic-token|127\.0\.0\.1/);assert.equal((await http("apply",{token:p.body.token,models:["new"],extra:true})).status,400);
 assert.equal((await http("apply",{token:p.body.token,models:["new"]})).status,200);assert.equal((await http("apply",{token:p.body.token,models:["new"]})).status,409);assert.deepEqual(store.provider("source")!.models,["old","kept","new"]);assert.deepEqual(paths,["GET /v1/models"]);
});

test("abort during catalog transport yields no consent; abort during apply key read cannot mutate",async t=>{
 const {store,secrets}=fixture(t),controller=new AbortController();
 const service=new ModelCatalogPreviews(store,secrets,{list:async(_provider,_key,signal)=>{assert.equal(signal,controller.signal);controller.abort();return listing(["new"])();}});
 const before=JSON.stringify((store as any).state);await assert.rejects(service.preview("source",controller.signal));assert.equal(JSON.stringify((store as any).state),before);
 let abortRead=false;const applyController=new AbortController(),wrapped={get:async(id:string)=>{if(abortRead)applyController.abort();return secrets.get(id)},set:secrets.set,delete:secrets.delete};
 const next=new ModelCatalogPreviews(store,wrapped,{list:listing(["new"])}),p=await next.preview("source");abortRead=true;await assert.rejects(next.apply("source",p.token,["new"],applyController.signal));assert.equal(JSON.stringify((store as any).state),before);
});

test("capacity limits are explicit and invalid prior catalog rejected before contacting provider",async t=>{
 const {store,secrets}=fixture(t);const ids=Array.from({length:500},(_,i)=>`vendor/model-${i}`),service=new ModelCatalogPreviews(store,secrets,{list:listing(ids)}),p=await service.preview("source");assert.equal(p.added.length,500);assert.equal(p.limit,500);await service.apply("source",p.token,ids);assert.equal(store.provider("source")!.models.length,502);
 store.upsertProvider({...source(),models:Array.from({length:10000},(_,i)=>`old-${i}`)});await assert.rejects(service.preview("source"),isConflict);
 let called=false;store.upsertProvider({...source(),models:["bad\nold"]});await assert.rejects(new ModelCatalogPreviews(store,secrets,{list:async()=>{called=true;return listing(["new"])();}}).preview("source"),isConflict);assert.equal(called,false);
});


test("capacity counts preserved duplicate entries rather than distinct prior IDs",async t=>{
 const {store,secrets}=fixture(t),service=new ModelCatalogPreviews(store,secrets,{list:listing(["new"])});
 store.upsertProvider({...source(),models:Array(10000).fill("old")});const before=JSON.stringify((store as any).state);await assert.rejects(service.preview("source"),isConflict);assert.equal(JSON.stringify((store as any).state),before);
 store.upsertProvider({...source(),models:Array(9999).fill("old")});const p=await service.preview("source");await service.apply("source",p.token,["new"]);assert.equal(store.provider("source")!.models.length,10000);const again=await service.preview("source");assert.deepEqual(again.added,[]);
});
