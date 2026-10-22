import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { createEasySwitchServer } from "../src/server.ts";
import { InferenceActivity } from "../src/inference-activity.ts";
import { Ledger } from "../src/ledger.ts";
import { monthWindow } from "../src/budget.ts";
async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail("Expected local request lifecycle event");
}
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-overview-"));
  const pending: ServerResponse[] = [];
  const relay = createServer(async (req, res) => { for await (const _ of req) { /* Drain fixture body. */ } pending.push(res); });
  const upstream = await listen(relay), store = new Store(dir), auth = new GatewayTokenAuthority(), ledger = new Ledger(dir);
  store.upsertProvider({ id:"fixture", name:"Fixture", baseUrl:upstream + "/v1", models:["m"], protocols:["chat"], route:"chat-translate", routePinned:false, streamUsage:true, createdAt:new Date().toISOString() });
  let reads = 0;
  const server = createEasySwitchServer({ store, port:0, ledger, gatewayAuth:auth, secrets:{ get:async()=>{reads++;return "fixture-key";}, set:async()=>{}, delete:async()=>{} } });
  const base = await listen(server), session = auth.issue("aider");
  t.after(async () => { server.closeAllConnections();relay.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>relay.close(()=>r()))]);rmSync(dir,{recursive:true,force:true}); });
  const overview = async () => { const response=await fetch(base+"/api/overview",{headers:{"x-easyswitch":"1"}}); assert.equal(response.status,200);return await response.json() as any; };
  const request = (path = "/v1/chat/completions", token = session.token, signal?: AbortSignal) => fetch(base+path, { method:"POST", signal, headers:{authorization:"Bearer "+token,"content-type":"application/json"}, body:JSON.stringify({model:"fixture/m",messages:[{role:"user",content:"private fixture prompt"}],stream:false}) }).then(async r=>({status:r.status,text:await r.text()}));
  const finish = (index:number,status=200) => { pending[index]!.writeHead(status,{"content-type":"application/json"});pending[index]!.end(JSON.stringify({choices:[{message:{role:"assistant",content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1}})); };
  return { dir,store,auth,ledger,base,session,pending,request,overview,finish,reads:()=>reads };
}
test("overview reads no key, keeps idle credentials out, and distinguishes unknown sources and missing costs", async t => {
  const f=await fixture(t), now=new Date(), window=monthWindow(now);
  f.ledger.append({at:now.toISOString(),model:"fixture/m",providerId:"fixture",route:"chat-translate",harness:"aider",status:200,ms:1,costNote:"unpriced"});
  f.ledger.append({at:new Date(window.start.getTime()-1000).toISOString(),model:"fixture/m",providerId:"fixture",route:"chat-translate",harness:"aider",status:200,ms:1,costUsd:99});
  const a=await f.overview(), b=await f.overview();
  assert.equal(f.reads(),0);assert.equal(f.pending.length,0);assert.equal(a.activity.sessions.length,0);assert.equal(b.activity.activeRequests,0);
  assert.equal(a.sources[0].status,"unknown");assert.equal(a.sources[0].selectable,true);assert.equal(a.sources[0].quota,null);
  assert.equal(a.month.estimatedCostUsd,0);assert.equal(a.month.unknownCostCalls,1);assert.equal(a.month.calls,1);assert.equal(a.month.startsAt,window.start.toISOString());
  assert.doesNotMatch(JSON.stringify(a),/fixture-key|es-session-|private fixture prompt|baseUrl|wire|authorization/);
  assert.equal((await fetch(f.base+"/api/overview")).status,403);
});
test("parallel requests deduplicate by authenticated session and drop only completed work", async t => {
  const f=await fixture(t), first=f.request(), second=f.request();await until(()=>f.pending.length===2);
  let snapshot=await f.overview();assert.equal(snapshot.activity.sessions.length,1);assert.equal(snapshot.activity.activeRequests,2);assert.equal(snapshot.activity.sessions[0].agentId,"aider");
  f.finish(0);await first;snapshot=await f.overview();assert.equal(snapshot.activity.sessions.length,1);assert.equal(snapshot.activity.activeRequests,1);
  f.finish(1);await second;assert.equal((await f.overview()).activity.activeRequests,0);
});
test("failures and downstream cancellation clear live activity, including separate sessions", async t => {
  const f=await fixture(t), other=f.auth.issue("codex"), controller=new AbortController();
  const first=f.request(), second=f.request("/v1/chat/completions",other.token,controller.signal).catch(()=>null);await until(()=>f.pending.length===2);
  assert.equal((await f.overview()).activity.sessions.length,2);
  f.finish(0,400);await first;controller.abort();await second;
  let snapshot=await f.overview();for(let i=0;i<10&&snapshot.activity.activeRequests;i++){await new Promise(r=>setTimeout(r,10));snapshot=await f.overview();}
  assert.equal(snapshot.activity.activeRequests,0);
});
test("models, token counts, invalid credentials and invalid targets never create inference activity", async t => {
  const f=await fixture(t);
  assert.equal((await fetch(f.base+"/v1/models",{headers:{authorization:"Bearer "+f.session.token}})).status,200);
  assert.equal((await f.request("/v1/chat/completions","es-session-forged")).status,401);
  await f.request("/v1/messages/count_tokens");
  assert.equal((await f.overview()).activity.activeRequests,0);assert.equal(f.pending.length,0);
});
test("observer completion is idempotent and independent instances never share activity", () => {
  const a=new InferenceActivity(),b=new InferenceActivity();const end=a.begin({sessionId:"s",agentId:"codex",providerId:"p",model:"p/m"});
  assert.equal(b.snapshot().activeRequests,0);assert.equal(a.snapshot().activeRequests,1);end();end();assert.equal(a.snapshot().activeRequests,0);
});
