import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test, type TestContext } from "node:test";
import { HeadlessCleanupError, LAUNCHERS, runHeadless, type HeadlessProcessRuntime } from "../src/agent-launch.ts";
import { GatewayTokenAuthority } from "../src/gateway-auth.ts";

// Every child and process-group operation below is an in-process fixture. No binary is read or run.
let serial = 0;
function fixture(t: TestContext, extra: { noGroup?: boolean; noPid?: boolean; duringSpawn?: (signal: AbortController) => void; spawnFails?: boolean; revokeFails?: boolean } = {}) {
  const id = `fake-task-process-${++serial}`, auth = new GatewayTokenAuthority(), controller = new AbortController();
  let dir = "", token = "", now = 0, next = 0, groupAlive = true, unknown = false, settled = false;
  const calls: Array<{command:string;args:readonly string[];options:Record<string,unknown>}> = [];
  const signals: Array<{group:number;signal:string}> = [], probes: number[] = [], timers = new Map<number,{at:number;callback:()=>void}>();
  const child = Object.assign(new EventEmitter(), { pid: extra.noPid ? undefined : 51001, stdout:new PassThrough(), stderr:new PassThrough(), stdin:null,
    signals: [] as string[], unrefs: 0, kill(signal:string) { child.signals.push(signal); return true; }, unref() { child.unrefs++; } });
  LAUNCHERS[id] = {verified:false,headless(input) { dir=input.sessionDir;token=input.token;return {command:"/never-run-fake-agent",args:[],env:{EASYSWITCH_GATEWAY_TOKEN:token},files:{"fixture.json":"{}"}}; }};
  const runtime: HeadlessProcessRuntime = {
    spawn: ((command:string,args:readonly string[],options:Record<string,unknown>) => {
      calls.push({command,args,options});extra.duringSpawn?.(controller);
      if(extra.spawnFails)throw new Error("fixture credential must not appear");return child;
    }) as unknown as HeadlessProcessRuntime["spawn"],
    ...(extra.noGroup ? {} : {processGroup:{signal(group:number,signal:NodeJS.Signals){signals.push({group,signal});},exists(group:number){probes.push(group);if(unknown)throw new Error("fixture lookup failure");return groupAlive;}}}),
    schedule(callback,delay){timers.set(++next,{at:now+delay,callback});return next;},cancel(timer){timers.delete(timer as number);},
  };
  const advance = (ms:number) => { const end=now+ms;for(;;){const first=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!first)break;timers.delete(first[0]);now=first[1].at;first[1].callback();}now=end; };
  const authority = {issue:auth.issue.bind(auth),revoke(value:string){const result=auth.revoke(value);if(extra.revokeFails)throw new Error("fixture persistence failure");return result;}};
  const pending = runHeadless(id,{bin:"/never-run-fake-agent",port:1234,model:"fake/model"},{attachMcp:false,gatewayAuth:authority,signal:controller.signal,timeoutMs:10_000,maxBytes:64},runtime);
  void pending.then(()=>{settled=true;},()=>{settled=true;});
  t.after(()=>{groupAlive=false;unknown=false;child.emit("close",null);advance(10_000);delete LAUNCHERS[id];});
  const clean = () => {assert.equal(auth.authenticate({authorization:`Bearer ${token}`}),undefined);assert.equal(existsSync(dir),false);assert.equal(timers.size,0);};
  return {child,controller,pending,calls,signals,probes,timers,advance,clean,get settled(){return settled;},get dir(){return dir;},set groupAlive(value:boolean){groupAlive=value;},set unknown(value:boolean){unknown=value;}};
}
const tick = async () => {for(let i=0;i<4;i++)await Promise.resolve();};

test("normal completion waits for child close, preserves output and releases token and directory",async t=>{
  const f=fixture(t);assert.equal(f.calls.length,1);assert.equal(f.calls[0]!.options.detached,true);assert.equal(f.calls[0]!.options.shell,false);
  f.child.stdout.write("fake answer\n");f.groupAlive=false;f.child.emit("exit",0);await tick();assert.equal(f.settled,false);assert.equal(existsSync(f.dir),true);
  f.child.emit("close",0);const result=await f.pending;assert.equal(result.output,"fake answer");assert.equal(result.exitCode,0);assert.deepEqual(f.signals,[]);f.clean();
});
test("cancel waits for both the direct child and its own group before returning",async t=>{
  const f=fixture(t);f.controller.abort();assert.deepEqual(f.signals,[{group:51001,signal:"SIGTERM"}]);
  f.child.emit("exit",null);f.child.emit("close",null);await tick();assert.equal(f.settled,false);
  f.groupAlive=false;f.advance(25);const result=await f.pending;assert.equal(result.cancelled,true);assert.equal(result.exitCode,null);assert.match(result.output,/已取消/);f.clean();
});
test("a leader exiting with grandchildren still holding pipes terminates only its created group",async t=>{
  const f=fixture(t);f.child.emit("exit",0);assert.deepEqual(f.signals,[{group:51001,signal:"SIGTERM"}]);
  f.advance(3000);assert.deepEqual(f.signals.map(v=>v.signal),["SIGTERM","SIGKILL"]);assert.deepEqual(f.child.signals,[]);await tick();assert.equal(f.settled,false);
  f.groupAlive=false;f.advance(275);assert.equal((await f.pending).exitCode,0);assert.equal(f.child.stdout.destroyed,true);assert.equal(f.child.stderr.destroyed,true);assert.ok(f.probes.every(id=>id===51001));f.clean();
});
test("an external pipe holder cannot prolong completion or become a process target",async t=>{
  const f=fixture(t);f.groupAlive=false;f.child.emit("exit",0);f.advance(249);await tick();assert.equal(f.settled,false);
  f.advance(1);assert.equal((await f.pending).exitCode,0);assert.deepEqual(f.signals,[]);assert.deepEqual(f.child.signals,[]);assert.equal(f.child.stdout.destroyed,true);f.clean();
});
test("error with a live child waits for exit and close and never returns raw error text",async t=>{
  const f=fixture(t);f.child.emit("error",new Error("fake credential must stay private"));await tick();assert.equal(f.settled,false);
  f.groupAlive=false;f.child.emit("exit",1);f.child.emit("close",1);const result=await f.pending;assert.equal(result.exitCode,null);assert.match(result.output,/运行失败/);assert.doesNotMatch(result.output,/credential/);
  f.child.emit("error",new Error("late error"));f.child.emit("close",0);f.clean();
});
test("a failed spawn without a pid never signals any group or waits for a nonexistent process",async t=>{
  const f=fixture(t,{noPid:true});f.child.emit("error",new Error("fake secret"));const result=await f.pending;assert.equal(result.exitCode,null);assert.doesNotMatch(result.output,/secret/);assert.deepEqual(f.signals,[]);f.clean();
});
test("a synchronous spawn failure still revokes its token and removes its private directory",async t=>{
  const f=fixture(t,{spawnFails:true});const result=await f.pending;assert.equal(result.exitCode,null);assert.doesNotMatch(result.output,/credential/);f.clean();
});
test("abort during spawn is observed after listeners are installed",async t=>{
  const f=fixture(t,{duringSpawn:signal=>signal.abort()});assert.equal(f.signals[0]?.signal,"SIGTERM");f.groupAlive=false;f.child.emit("close",null);
  assert.equal((await f.pending).cancelled,true);f.clean();
});
test("timeout escalates then waits for confirmed group cleanup",async t=>{
  const f=fixture(t);f.advance(10_000);assert.equal(f.signals[0]?.signal,"SIGTERM");f.advance(3000);assert.equal(f.signals[1]?.signal,"SIGKILL");
  f.groupAlive=false;f.child.emit("close",null);const result=await f.pending;assert.equal(result.timedOut,true);assert.equal(result.exitCode,null);f.clean();
});
test("a group surviving close is a bounded cleanup failure, with authentication and files still cleaned",async t=>{
  const f=fixture(t);const rejected=assert.rejects(f.pending,(error:unknown)=>error instanceof HeadlessCleanupError && error.code==="process_cleanup_failed");
  f.controller.abort();f.child.emit("close",null);f.advance(4000);await rejected;assert.equal(f.child.unrefs,1);assert.equal(f.child.stdout.destroyed,true);f.clean();
});
test("unknown group state is never reported as successful cleanup",async t=>{
  const f=fixture(t);f.unknown=true;const rejected=assert.rejects(f.pending,HeadlessCleanupError);f.child.emit("exit",0);f.child.emit("close",0);f.advance(4000);await rejected;
  assert.deepEqual(f.signals,[]);assert.deepEqual(f.child.signals,[]);f.clean();
});
test("a vanished group id is retired permanently before any potential reuse",async t=>{
  const f=fixture(t);f.groupAlive=false;f.controller.abort();assert.deepEqual(f.signals,[]);assert.deepEqual(f.child.signals,[]);const probes=f.probes.length;
  f.groupAlive=true;f.advance(3000);f.child.emit("close",null);const result=await f.pending;assert.equal(result.cancelled,true);assert.equal(f.probes.length,probes);assert.deepEqual(f.signals,[]);assert.deepEqual(f.child.signals,[]);f.clean();
});
test("without process groups only the spawned child is signalled and exit is still required",async t=>{
  const f=fixture(t,{noGroup:true});assert.equal(f.calls[0]!.options.detached,false);f.controller.abort();assert.deepEqual(f.child.signals,["SIGTERM"]);f.advance(3000);assert.deepEqual(f.child.signals,["SIGTERM","SIGKILL"]);
  f.child.emit("close",null);assert.equal((await f.pending).cancelled,true);f.clean();
});
test("revocation storage failure cannot skip directory or process cleanup",async t=>{
  const f=fixture(t,{revokeFails:true});const rejected=assert.rejects(f.pending,/persistence failure/);f.controller.abort();f.groupAlive=false;f.child.emit("close",null);await rejected;f.clean();
});
test("simultaneous process and revocation failures preserve the cleanup failure classification",async t=>{
  const f=fixture(t,{revokeFails:true});const rejected=assert.rejects(f.pending,(error:unknown)=>error instanceof HeadlessCleanupError && error.code==="process_cleanup_failed" && error.tokenCleanupFailed);
  f.controller.abort();f.advance(4000);await rejected;f.clean();
});
test("synchronous close during a stop leaves no escalation timers",async t=>{
  const f=fixture(t,{noGroup:true});f.child.kill=signal=>{f.child.signals.push(signal);f.child.emit("exit",null);f.child.emit("close",null);return true;};
  f.controller.abort();assert.equal((await f.pending).cancelled,true);f.clean();
});
test("pipe errors terminate the owned run without unhandled errors or raw diagnostic output",async t=>{
  const f=fixture(t);f.child.stdout.emit("error",new Error("fixture secret"));await tick();assert.equal(f.settled,false);f.groupAlive=false;f.child.emit("close",1);
  const result=await f.pending;assert.equal(result.exitCode,null);assert.doesNotMatch(result.output,/secret/);f.child.stderr.emit("error",new Error("late secret"));f.clean();
});
