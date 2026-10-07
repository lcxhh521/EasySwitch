import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test, type TestContext } from "node:test";
import { createEasySwitchServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

async function fixture(t:TestContext){
 const root=mkdtempSync(join(realpathSync(tmpdir()),"es-import-api-")),home=join(root,"home");mkdirSync(home);const store=new Store(join(root,"state")),keys=new Map<string,string>();let reads=0,writes=0,envReads=0,fail=false,now=Date.now();
 const env={OPENAI_API_KEY:"fixture-environment-key",OPENAI_MODEL:"fixture-model"};
 const server=createEasySwitchServer({store,port:0,providerImport:{home,environment:()=>{envReads++;return env;},now:()=>now},secrets:{get:async id=>{reads++;return keys.get(id);},set:async(id,key)=>{writes++;keys.set(id,key);if(fail)throw new Error("Bearer fixture-error-secret");},delete:async id=>{keys.delete(id);}}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(root,{recursive:true,force:true});});
 const api=async(method:string,path:string,body?:unknown,header=true)=>{const response=await fetch(base+path,{method,headers:{"content-type":"application/json",...(header?{"x-easyswitch":"1"}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:response.status,body:await response.json() as any};};
 const put=(path:string,value:unknown)=>{const file=join(home,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,JSON.stringify(value));return file;};
 return{root,home,store,keys,api,put,env,counts:()=>({reads,writes,envReads}),fail:()=>{fail=true;},expire:()=>{now+=600001;}};
}
test("HTTP previews require explicit POST/source choice; GET, old path and arbitrary file paths cannot read/import",async t=>{
 const f=await fixture(t);
 assert.equal((await f.api("GET","/api/provider-import/preview")).status,405);
 assert.equal((await f.api("GET","/api/import/opencodex")).status,405);
 assert.equal((await f.api("POST","/api/import/opencodex",{configPath:"/fixture/not-readable",chosen:["all"]})).status,405);
 assert.equal((await f.api("POST","/api/provider-import/preview",{sources:["environment"]},false)).status,403);
 assert.equal((await f.api("POST","/api/provider-import/preview",{sources:["codex"],configPath:"/fixture/not-readable"})).status,400);
 assert.deepEqual((await f.api("POST","/api/provider-import/preview",{sources:[]})).body.candidates,[]);
 assert.deepEqual(f.counts(),{reads:0,writes:0,envReads:0});assert.equal(f.store.providers().length,0);
});
test("real HTTP preview is redacted, empty selection writes nothing, and one chosen source saves only to the secret store",async t=>{
 const f=await fixture(t);const file=f.put(".opencodex/config.json",{providers:{relay:{baseUrl:"http://127.0.0.1:1/v1",apiKey:"fixture-file-key",models:["m"]}},providers_meta:{relay:{name:"Relay"}}});const before=readFileSync(file);
 const preview=(await f.api("POST","/api/provider-import/preview",{sources:["opencodex","environment"]})).body;
 assert.equal(preview.candidates.length,2);assert.doesNotMatch(JSON.stringify(preview),/fixture-file-key|fixture-environment-key|fingerprint/);assert.equal(f.keys.size,0);
 const empty=await f.api("POST","/api/provider-import/commit",{previewId:preview.previewId,chosen:[]});assert.deepEqual(empty.body.imported,[]);assert.equal(f.counts().writes,0);
 const chosen=preview.candidates.find((c:any)=>c.source==="opencodex");const saved=await f.api("POST","/api/provider-import/commit",{previewId:preview.previewId,chosen:[chosen.id]});
 assert.equal(saved.status,200);assert.equal(saved.body.imported.length,1);assert.deepEqual(saved.body.failed,[]);
 const provider=f.store.providers()[0]!;assert.equal(provider.off,true);assert.equal(f.keys.get(provider.id),"fixture-file-key");assert.deepEqual(provider.models,["m"]);assert.equal(f.counts().reads,0);
 assert.deepEqual(readFileSync(file),before);assert.doesNotMatch(readFileSync(join(f.store.dir,"state.json"),"utf8")+JSON.stringify(saved.body),/fixture-file-key|fixture-environment-key/);
 assert.equal((await f.api("POST","/api/provider-import/commit",{previewId:preview.previewId,chosen:[chosen.id]})).status,409);
});
test("changed or expired previews and unselected candidates fail before secret writes",async t=>{
 const f=await fixture(t);let preview=(await f.api("POST","/api/provider-import/preview",{sources:["environment"]})).body;
 f.env.OPENAI_API_KEY="fixture-rotated-key";assert.equal((await f.api("POST","/api/provider-import/commit",{previewId:preview.previewId,chosen:[preview.candidates[0].id]})).status,409);
 preview=(await f.api("POST","/api/provider-import/preview",{sources:["environment"]})).body;f.expire();assert.equal((await f.api("POST","/api/provider-import/commit",{previewId:preview.previewId,chosen:[preview.candidates[0].id]})).status,409);
 assert.equal(f.counts().writes,0);assert.equal(f.keys.size,0);
});
test("HTTP save failure rolls back even a secret write that threw afterward, without returning exception text",async t=>{
 const f=await fixture(t);const preview=(await f.api("POST","/api/provider-import/preview",{sources:["environment"]})).body;f.fail();const result=await f.api("POST","/api/provider-import/commit",{previewId:preview.previewId,chosen:[preview.candidates[0].id]});
 assert.equal(result.body.rolledBack,true);assert.equal(result.body.failed.length,1);assert.deepEqual(result.body.imported,[]);assert.equal(f.keys.size,0);assert.deepEqual(f.store.providers(),[]);
 assert.doesNotMatch(JSON.stringify(result.body),/fixture-error-secret|fixture-environment-key|Bearer/);
 const files=readdirSync(f.store.dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>readFileSync(join(e.parentPath,e.name),"utf8")).join("\n");assert.doesNotMatch(files,/fixture-error-secret|fixture-environment-key/);
});
