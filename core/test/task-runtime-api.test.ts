import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createEasySwitchServer, stopOwnedTasks } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";
import { HeadlessCleanupError, type RunResult, type runHeadless } from "../src/agent-launch.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
interface RunnerControl {
  token: string;
  sessionId: string;
  signal: AbortSignal;
  aborted: Promise<void>;
  close(): void;
  failCleanup(): void;
  mint(): string;
  revoke(token: string): boolean;
}
async function fixture(t: TestContext, findBinary: () => Promise<string | undefined> = async () => "/fixture/never-execute-agent") {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-task-runtime-api-")), store = new Store(dir), auth = new GatewayTokenAuthority();
  const controls = new Map<string, RunnerControl>(), started = new EventEmitter(); let credentialReads = 0;
  store.upsertProvider({id:"p",name:"Fixture source",baseUrl:"http://127.0.0.1:1/v1",models:["m"],protocols:["chat"],route:"chat-translate",routePinned:true,streamUsage:false,createdAt:""});
  const runner: typeof runHeadless = (agent, input, options) => {
    assert.equal(input.bin, "/fixture/never-execute-agent");
    assert.ok(options?.signal); assert.ok(options.gatewayAuth);
    const authority = options.gatewayAuth, issued = authority.issue(agent, {depth:options.depth,allowMcp:true});
    const closed = new EventEmitter(), aborted = deferred<void>(); let settled = false;
    options.signal.addEventListener("abort", () => aborted.resolve(), {once:true});
    const done = new Promise<RunResult>((resolve,reject) => {
      closed.once("close", () => { if(settled)return;settled=true;resolve({exitCode:options.signal!.aborted?null:0,output:options.signal!.aborted?"fixture cancelled":"fixture done",timedOut:false,cancelled:options.signal!.aborted}); });
      closed.once("error", error => { if(settled)return;settled=true;reject(error); });
    });
    controls.set(input.task!, {token:issued.token,sessionId:issued.id,signal:options.signal,aborted:aborted.promise,close:()=>closed.emit("close"),failCleanup:()=>closed.emit("error",new HeadlessCleanupError()),mint:()=>authority.issue(agent,{depth:options.depth,allowMcp:true}).token,revoke:token=>authority.revoke(token)});
    started.emit("ready"); return done;
  };
  const server=createEasySwitchServer({store,port:0,gatewayAuth:auth,taskRunner:runner,interactiveRuntime:{findBinary,newSessionDir:()=>dir,launchInTerminal:async()=>assert.fail("no terminal execution")},secrets:{async get(){credentialReads++;throw new Error("unexpected credential read")},async set(){assert.fail("no credential write")},async delete(){assert.fail("no credential deletion")}}});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r)); const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  t.after(async()=>{for(const control of controls.values())control.close();await new Promise(r=>setImmediate(r));server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true});});
  const api=async(method:string,path:string,body?:unknown,header=true)=>{const response=await fetch(base+path,{method,redirect:"error",headers:{"content-type":"application/json",...(header?{"x-easyswitch":"1"}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as any};};
  const launch=async(task:string,agent="hermes")=>{const response=await api("POST","/api/tasks",{agent,model:"p/m",task});assert.equal(response.status,202,JSON.stringify(response.body));return response.body.task as {id:string};};
  const waitControl=(task:string):Promise<RunnerControl>=>{
    const current=controls.get(task);if(current)return Promise.resolve(current);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{started.off("ready",ready);reject(new Error("fixture runner did not start"));},2000);const ready=()=>{const found=controls.get(task);if(found){clearTimeout(timer);started.off("ready",ready);resolve(found);}};started.on("ready",ready);});
  };
  const models=async(token:string)=>fetch(base+"/v1/models",{headers:{authorization:`Bearer ${token}`},redirect:"error"});
  const mcp=(token:string,task:string)=>fetch(base+"/mcp",{method:"POST",redirect:"error",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"run_agent",arguments:{agent:"aider",task,model:"p/m"}}})});
  return {api,launch,waitControl,models,mcp,auth,controls,stopOwned:()=>stopOwnedTasks(server),reads:()=>credentialReads};
}

test("HTTP task cancellation waits for owned close, exposes pending cleanup, and revokes only its own tokens", {timeout:5000}, async t=>{
  const f=await fixture(t),task=await f.launch("single"),control=await f.waitControl("single");
  const other=f.auth.issue("aider",{allowMcp:true});assert.equal((await f.models(control.token)).status,200);
  const before=(await f.api("GET","/api/tasks")).body.tasks.find((row:any)=>row.id===task.id);
  assert.equal(before.status,"running");assert.ok(before.elapsedMs>=0);assert.equal(before.usage.unknownCost,true);
  assert.equal((await f.api("POST",`/api/tasks/${task.id}/stop`,{},false)).status,403);assert.equal(control.signal.aborted,false);
  let returned=false;const stopping=f.api("POST",`/api/tasks/${task.id}/stop`,{}).then(result=>{returned=true;return result});
  await control.aborted;
  const pending=(await f.api("GET","/api/tasks")).body.tasks.find((row:any)=>row.id===task.id);
  assert.equal(pending.status,"stopped");assert.equal(pending.cleanupPending,true);assert.equal(pending.cleanupFailed,0);assert.equal(pending.usage.unknownCost,true);assert.equal(returned,false,"stop must not succeed before the owned runner closes");
  assert.equal((await f.models(control.token)).status,401);assert.equal((await f.models(other.token)).status,200);
  const registered=f.auth.list().length;assert.throws(()=>control.mint(),/取消/);assert.equal(f.auth.list().length,registered,"a cancelled runner cannot leave a late minted token");
  control.close();const stopped=await stopping;assert.equal(stopped.status,200);assert.equal(stopped.body.ok,true);assert.deepEqual(stopped.body.taskIds,[task.id]);assert.deepEqual(stopped.body.cleanup,{pending:0,failed:0});
  const final=(await f.api("GET","/api/tasks")).body.tasks.find((row:any)=>row.id===task.id);assert.equal(final.status,"stopped");assert.equal(final.cleanupPending,false);assert.equal(final.cleanupFailed,0);
  assert.equal((await f.models(other.token)).status,200);assert.equal(f.reads(),0);
});

test("an authenticated loopback MCP child is shown in the tree and parent cancellation leaves an unrelated task alive", {timeout:5000}, async t=>{
  const f=await fixture(t),parent=await f.launch("parent"),parentRun=await f.waitControl("parent"),unrelated=await f.launch("unrelated"),unrelatedRun=await f.waitControl("unrelated");
  const childReply=f.mcp(parentRun.token,"child");const childRun=await f.waitControl("child");
  const snapshot=(await f.api("GET","/api/tasks")).body,child=snapshot.tasks.find((row:any)=>row.task==="child");
  assert.ok(child);assert.equal(child.parentTaskId,parent.id);assert.equal(snapshot.tree.find((row:any)=>row.id===parent.id).children[0].id,child.id);assert.equal(snapshot.running,3);
  assert.equal(parentRun.revoke(unrelatedRun.token),false,"a runner cannot revoke another task's session");assert.equal((await f.models(unrelatedRun.token)).status,200);
  let returned=false;const stopping=f.api("POST",`/api/tasks/${parent.id}/stop`,{}).then(result=>{returned=true;return result});await Promise.all([parentRun.aborted,childRun.aborted]);
  assert.equal(unrelatedRun.signal.aborted,false);assert.equal((await f.models(parentRun.token)).status,401);assert.equal((await f.models(childRun.token)).status,401);assert.equal((await f.models(unrelatedRun.token)).status,200);
  childRun.close();const mcp=await childReply;assert.equal(mcp.status,200);const body=await mcp.json() as any;assert.equal(body.result.isError,true);assert.match(JSON.stringify(body.result),/cancel|取消/i);assert.equal(returned,false,"closed child is insufficient while the parent is still cleaning up");
  parentRun.close();const stopped=await stopping;assert.equal(stopped.status,200);assert.deepEqual(new Set(stopped.body.taskIds),new Set([parent.id,child.id]));assert.deepEqual(stopped.body.cleanup,{pending:0,failed:0});
  const final=(await f.api("GET","/api/tasks")).body;assert.equal(final.running,1);assert.equal(final.tasks.find((row:any)=>row.id===unrelated.id).status,"running");assert.equal(final.tasks.filter((row:any)=>row.id===parent.id||row.id===child.id).every((row:any)=>row.status==="stopped"&&!row.cleanupPending),true);
  const after=await f.mcp(parentRun.token,"must-not-create");assert.equal(after.status,401);assert.equal(f.controls.has("must-not-create"),false);assert.equal(f.reads(),0);
  const ownStop=f.api("POST",`/api/tasks/${unrelated.id}/stop`,{});await unrelatedRun.aborted;unrelatedRun.close();await ownStop;
});

test("HeadlessCleanupError remains visible after awaited cancellation and cannot report complete cleanup", {timeout:5000}, async t=>{
  const f=await fixture(t),task=await f.launch("cleanup failure"),control=await f.waitControl("cleanup failure");
  const stopping=f.api("POST",`/api/tasks/${task.id}/stop`,{});await control.aborted;control.failCleanup();const result=await stopping;
  assert.equal(result.status,200);assert.equal(result.body.ok,false);assert.equal(result.body.cleanup.pending,0);assert.ok(result.body.cleanup.failed>=1);
  const row=(await f.api("GET","/api/tasks")).body.tasks.find((taskRow:any)=>taskRow.id===task.id);assert.equal(row.status,"stopped");assert.equal(row.cleanupPending,false);assert.ok(row.cleanupFailed>=1);assert.equal(row.usage.unknownCost,true);
  assert.equal((await f.models(control.token)).status,401);assert.throws(()=>control.mint(),/取消/);assert.equal(f.reads(),0);
  await assert.rejects(f.stopOwned(),/任务清理未确认/,"shutdown must retain terminal cleanup failures instead of reporting success");
});


test("shutdown during binary discovery rejects the pending launch before registering a task or minting a token", {timeout:5000}, async t=>{
  const discovered=deferred<void>(),binary=deferred<string>();
  const f=await fixture(t,async()=>{discovered.resolve();return binary.promise;});
  const request=f.api("POST","/api/tasks",{agent:"hermes",model:"p/m",task:"must not start after shutdown"});
  await discovered.promise;await f.stopOwned();binary.resolve("/fixture/never-execute-agent");
  const response=await request;assert.equal(response.status,409);assert.equal(f.controls.size,0);assert.equal(f.auth.list().length,0);
  const snapshot=(await f.api("GET","/api/tasks")).body;assert.equal(snapshot.tasks.length,0);assert.equal(snapshot.running,0);assert.equal(f.reads(),0);
});
