import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { request } from "node:http";
import { Store } from "../src/store.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import type { Provider } from "../src/types.ts";
const provider = (id: string): Provider => ({ id, name: id, baseUrl: "https://private-endpoint.invalid", models: ["m"], route: "chat-translate", routePinned: false, streamUsage: true, createdAt: "" });
function fixture(t: any) {
 const dir=mkdtempSync(join(tmpdir(),"es-profile-preview-"));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const s=new Store(dir);s.upsertProvider(provider("a"));s.setBinding({harness:"claude",providerId:"a",model:"m"});s.setPrefs("claude",{effort:"high",tiers:{small:"a/m"},fallbackModel:"a/m"});
 return s;
}
test("preview is read-only, complete, allowlisted and reflects replacement including clears",t=>{
 const s=fixture(t),p=s.saveProfile("saved");s.setBinding({harness:"opencode",providerId:"a",model:"m"});s.setPrefs("opencode",{effort:"low"});
 const before=JSON.stringify((s as any).state),r=s.previewProfile(p.id)!;
 assert.equal(JSON.stringify((s as any).state),before);assert.equal(s.previewProfile(p.id)!.fingerprint,r.fingerprint);
 assert.equal(r.summary.clients,2);assert.equal(r.summary.clearedBindings,1);
 assert.deepEqual(r.changes.find(c=>c.harness==="opencode")!.after,{binding:null,prefs:{}});
 assert.doesNotMatch(JSON.stringify(r),/private-endpoint|baseUrl|createdAt|credential/);
 s.applyProfile(p.id,r.fingerprint);assert.equal(s.binding("opencode"),undefined);assert.deepEqual(s.prefs("opencode"),{});
 assert.throws(()=>s.applyProfile(p.id,r.fingerprint),/重新预览/);
});
test("guard rejects duplicate no-op, and each current/profile/source/pool drift without mutation",t=>{
 const mutators=[
  (s:Store)=>s.setPrefs("claude",{effort:"low"}),
  (s:Store)=>s.setBinding({harness:"claude",providerId:"a",model:"other"}),
  (s:Store)=>{s.setPrefs("claude",{effort:"low"});s.saveProfile("saved");},
  (s:Store)=>s.upsertProvider({...provider("a"),off:true}),
  (s:Store)=>s.upsertPool({id:"pool-a",name:"pool",strategy:"order",members:["a/m"],createdAt:""}),
  (s:Store)=>s.removeProvider("a"),
 ];
 for(const mutate of mutators){const s=fixture(t),p=s.saveProfile("saved"),r=s.previewProfile(p.id)!;mutate(s);const before=JSON.stringify((s as any).state);assert.throws(()=>s.applyProfile(p.id,r.fingerprint),/重新预览/);assert.equal(JSON.stringify((s as any).state),before);}
 const s=fixture(t),p=s.saveProfile("saved"),r=s.previewProfile(p.id)!;s.applyProfile(p.id,r.fingerprint);assert.throws(()=>s.applyProfile(p.id,r.fingerprint),/重新预览/);
});
test("deleted sources/pools clear only main bindings; disabled/unlisted and stale auxiliary are retained with warnings",t=>{
 const s=fixture(t);s.upsertPool({id:"gone",name:"gone",strategy:"order",members:["a/m"],createdAt:""});s.setBinding({harness:"opencode",providerId:"pool",model:"gone"});const p=s.saveProfile("saved");
 (s as any).state.pools=[];s.upsertProvider({...provider("a"),off:true,models:[]});
 const r=s.previewProfile(p.id)!;assert.equal(r.changes.find(c=>c.harness==="opencode")!.after.binding,null);assert.match(JSON.stringify(r),/关闭/);assert.match(JSON.stringify(r),/未在来源当前列表/);
 s.applyProfile(p.id,r.fingerprint);assert.equal(s.binding("claude")?.model,"m");assert.equal(s.prefs("claude").fallbackModel,"a/m");assert.equal(s.provider("a")?.off,true);
 s.removeProvider("a");const r2=s.previewProfile(p.id)!;assert.equal(r2.changes.find(c=>c.harness==="claude")!.after.binding,null);assert.equal(r2.changes.find(c=>c.harness==="claude")!.after.prefs.fallbackModel,"a/m");
});
test("missing/null profile content fails closed for preview/guard; no empty replacement inferred",t=>{
 for(const field of ["bindings","prefs"])for(const value of [undefined,null]){const s=fixture(t),p=s.saveProfile("saved");(s as any).state.profiles[0][field]=value;const before=JSON.stringify((s as any).state);assert.throws(()=>s.previewProfile(p.id),/不完整/);assert.throws(()=>s.applyProfile(p.id,"0".repeat(64)),/不完整/);assert.equal(JSON.stringify((s as any).state),before);}
});
test("failed persistence rolls back bindings, prefs and guard revision; same preview can retry",t=>{
 const s=fixture(t),p=s.saveProfile("saved");s.clearBinding("claude");s.setPrefs("claude",{effort:"low"});const r=s.previewProfile(p.id)!,before=JSON.stringify((s as any).state),save=(s as any).save;
 (s as any).save=()=>{throw new Error("fake disk failure")};assert.throws(()=>s.applyProfile(p.id,r.fingerprint),/fake disk/);assert.equal(JSON.stringify((s as any).state),before);
 (s as any).save=save;s.applyProfile(p.id,r.fingerprint);assert.equal(s.binding("claude")?.model,"m");
});
test("HTTP preview guard, input errors, conflict and legacy apply; never reads secrets",async t=>{
 const s=fixture(t),p=s.saveProfile("saved");let reads=0;
 const server=createEasySwitchServer({store:s,port:0,gatewayAuth:new GatewayTokenAuthority(),secrets:{async get(){reads++;throw new Error("unexpected")},async set(){assert.fail("secret write")},async delete(){assert.fail("secret delete")}}});
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
 const http=(path:string,method="GET",body?:unknown,header=true)=>new Promise<{status:number;body:any}>((resolve,reject)=>{const q=request(`http://127.0.0.1:${(server.address() as any).port}${path}`,{method,headers:header?{"x-easyswitch":"1"}:{}},r=>{let data="";r.on("data",d=>data+=d);r.on("end",()=>resolve({status:r.statusCode!,body:JSON.parse(data)}));});q.on("error",reject);q.end(body===undefined?undefined:JSON.stringify(body));});
 const path=`/api/profiles/${p.id}`;
 assert.equal((await http(`${path}/preview`,"GET",undefined,false)).status,403);
 const preview=await http(`${path}/preview`);assert.equal(preview.status,200);
 for(const bad of [null,[],7,"text"]){assert.equal((await http(`${path}/apply`,"POST",bad)).status,400);}
 for(const expectedPreview of [null,7,"",{},"a"]){assert.equal((await http(`${path}/apply`,"POST",{expectedPreview})).status,400);}
 assert.equal((await http(`${path}/apply`,"POST",{expectedPreview:preview.body.fingerprint})).status,200);
 const conflict=await http(`${path}/apply`,"POST",{expectedPreview:preview.body.fingerprint});assert.equal(conflict.status,409);assert.equal(conflict.body.code,"PROFILE_PREVIEW_CONFLICT");
 assert.equal((await http(`${path}/apply`,"POST",{})).status,200);
 assert.equal((await http(`/api/profiles/f-dead/preview`)).status,404);
 (s as any).state.profiles[0].prefs=null;assert.equal((await http(`${path}/preview`)).status,422);assert.equal(reads,0);
});

test("same-ID replacement and changed-back binding generation invalidate review, unknown fields stay private",t=>{
 const s=fixture(t),p=s.saveProfile("saved"),r=s.previewProfile(p.id)!;
 (s as any).state.profiles[0]={...p,createdAt:"later",privateMetadata:"not-for-preview"};
 assert.throws(()=>s.applyProfile(p.id,r.fingerprint),/重新预览/);
 const second=s.previewProfile(p.id)!;assert.doesNotMatch(JSON.stringify(second),/privateMetadata|not-for-preview/);
 s.setBinding({harness:"claude",providerId:"a",model:"other"});s.setBinding({harness:"claude",providerId:"a",model:"m"});
 assert.throws(()=>s.applyProfile(p.id,second.fingerprint),/重新预览/);
});

test("default catalog fallback is valid; budget changes warn and invalidate without altering apply eligibility",t=>{
 const s=fixture(t);s.upsertProvider({...provider("a"),models:[],defaultModel:"m"});const p=s.saveProfile("saved"),r=s.previewProfile(p.id)!;
 assert.doesNotMatch(JSON.stringify(r),/未在来源当前列表/);
 s.setProviderBudgetChecker(()=>true);const blocked=s.previewProfile(p.id)!;assert.match(JSON.stringify(blocked),/预算暂停/);
 assert.throws(()=>s.applyProfile(p.id,r.fingerprint),/重新预览/);s.applyProfile(p.id,blocked.fingerprint);assert.equal(s.binding("claude")?.model,"m");
});

test("guarded preview rejects unshown binding settings and catches direct default-model changes",t=>{
 const s=fixture(t),p=s.saveProfile("saved"),r=s.previewProfile(p.id)!;
 (s as any).state.providers[0].defaultModel="other";assert.throws(()=>s.applyProfile(p.id,r.fingerprint),/重新预览/);
 (s as any).state.profiles[0].bindings[0].legacyHiddenSetting="private";assert.throws(()=>s.previewProfile(p.id),/不完整/);
});
