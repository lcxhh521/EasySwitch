import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { CoreSupervisor } from "../src/core-supervisor.ts";
import { runAppSupervisor } from "../src/app-supervisor.ts"; // Import must never launch main.ts or any process.

function fixture() {
  let now=0,next=0;const timers=new Map<number,{at:number;callback:()=>void}>();
  const children:Array<EventEmitter & {pid?:number;signals:string[];kill(signal:string):boolean}>=[];
  const supervisor=new CoreSupervisor({now:()=>now,schedule:(callback,delay)=>{timers.set(++next,{at:now+delay,callback});return next;},cancel:id=>{timers.delete(id as number);},spawn:()=>{
    const child=Object.assign(new EventEmitter(),{pid:100+children.length,signals:[] as string[],kill(signal:string){this.signals.push(signal);return true;}});children.push(child);return child as unknown as ChildProcess;
  }});
  const advance=(ms:number)=>{const until=now+ms;while(true){const first=[...timers].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];if(!first)break;timers.delete(first[0]);now=first[1].at;first[1].callback();}now=until;};
  return {supervisor,children,timers,advance};
}
test("start owns one fake child and crash restarts use increasing delays",()=>{
  const f=fixture();f.supervisor.start();f.supervisor.start();assert.equal(f.children.length,1);
  f.children[0]!.emit("close",1);assert.equal(f.supervisor.status().state,"backoff");
  f.advance(249);assert.equal(f.children.length,1);f.advance(1);assert.equal(f.children.length,2);
  f.children[1]!.emit("close",1);f.advance(499);assert.equal(f.children.length,2);f.advance(1);assert.equal(f.children.length,3);
});
test("five automatic retries bound a crash loop and never kill an unrelated listener",()=>{
  const f=fixture();f.supervisor.start();
  for(let i=0;i<6;i++){f.children.at(-1)!.emit("close",1);f.advance(10_000);}
  assert.equal(f.children.length,6);assert.equal(f.supervisor.status().failure,"crash_loop");assert.equal(f.timers.size,0);
  assert.ok(f.children.every(c=>c.signals.length===0));
});
test("a stable run resets retry history",()=>{
  const f=fixture();f.supervisor.start();f.children[0]!.emit("close",1);f.advance(250);assert.equal(f.supervisor.status().restarts,1);
  f.advance(30_000);f.children[1]!.emit("close",1);assert.equal(f.supervisor.status().restarts,1);
});
test("stop during backoff cancels restart and is idempotent",async()=>{
  const f=fixture();f.supervisor.start();f.children[0]!.emit("close",1);
  const stopped=f.supervisor.stop();assert.equal(f.supervisor.stop(),stopped);await stopped;f.advance(100_000);
  assert.equal(f.children.length,1);assert.equal(f.supervisor.status().state,"stopped");assert.equal(f.timers.size,0);
});
test("stop waits for owned close and never restarts after normal termination",async()=>{
  const f=fixture();f.supervisor.start();let finished=false;const pending=f.supervisor.stop().then(()=>{finished=true;});
  await Promise.resolve();assert.equal(finished,false);assert.deepEqual(f.children[0]!.signals,["SIGTERM"]);
  f.children[0]!.emit("close",0);await pending;f.advance(10_000);assert.equal(f.children.length,1);assert.equal(f.supervisor.status().state,"stopped");
});
test("unresponsive owned child is escalated, but unconfirmed stop remains a failure",async()=>{
  const f=fixture();f.supervisor.start();const pending=f.supervisor.stop();const rejected=assert.rejects(pending,/not confirmed/);
  f.advance(2999);assert.deepEqual(f.children[0]!.signals,["SIGTERM"]);f.advance(1);assert.deepEqual(f.children[0]!.signals,["SIGTERM","SIGKILL"]);
  f.advance(1000);await rejected;assert.equal(f.supervisor.status().failure,"stop_unconfirmed");f.supervisor.start();assert.equal(f.children.length,1);
});
test("spawn error followed by close cannot schedule duplicate replacements",()=>{
  const f=fixture();f.supervisor.start();delete f.children[0]!.pid;f.children[0]!.emit("error",new Error("fixture secret"));f.children[0]!.emit("close",-1);
  assert.equal(f.timers.size,1);assert.equal(f.supervisor.status().failure,"spawn_failed");assert.ok(!JSON.stringify(f.supervisor.status()).includes("secret"));
});

test("the parent ownership pipe ends the supervised fake core and sets Application Support without touching other processes",async()=>{
  const input=new PassThrough(),signals=new EventEmitter(),output:string[]=[];const calls:unknown[][]=[];
  const child=Object.assign(new EventEmitter(),{pid:321,kill(signal:string){assert.equal(signal,"SIGTERM");child.emit("close",0);return true;}});
  const pending=runAppSupervisor({input:input as unknown as NodeJS.ReadStream,signals:signals as unknown as NodeJS.Process,homeDir:"/fixture/home",execPath:"/fixture/bundled-node",out:line=>output.push(line),spawn:((...args:unknown[])=>{calls.push(args);return child;}) as never});
  assert.equal(calls.length,1);assert.equal(calls[0]![0],"/fixture/bundled-node");
  assert.deepEqual((calls[0]![2] as {stdio:string[]}).stdio,["pipe","ignore","ignore"]);
  assert.equal((calls[0]![2] as {env:Record<string,string>}).env.EASYSWITCH_HOME,"/fixture/home/Library/Application Support/EasySwitch");
  input.end();assert.equal(await pending,0);assert.equal(signals.listenerCount("SIGTERM"),0);
  assert.equal(JSON.parse(output.at(-1)!).state,"stopped");assert.equal(calls.length,1);
});
