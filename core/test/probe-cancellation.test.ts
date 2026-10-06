import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { listModels, probeProvider } from "../src/probe.ts";
import type { Provider } from "../src/types.ts";

const provider:Provider={id:"probe-fixture",name:"Fixture",baseUrl:"http://127.0.0.1:1/v1",models:["m"],route:"chat-translate",routePinned:false,streamUsage:false,createdAt:"2026-10-06T00:00:00Z"};
const json=(value:unknown)=>new Response(JSON.stringify(value),{headers:{"content-type":"application/json"}});
function normal(input:string|URL|Request,init?:RequestInit):Response {
  const url=String(input);const body=JSON.parse(String(init?.body ?? "{}"));
  if(url.endsWith("/models")) return json({data:[{id:"m"}]});
  if(body.stream) return new Response('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\ndata: [DONE]\n\n');
  if(url.endsWith("/responses")) return json({output:[{type:"message"}]});
  if(url.endsWith("/messages")) return json({content:[{type:"text",text:"fixture"}]});
  if(body.tools) return json({choices:[{message:{tool_calls:[{function:{name:"get_weather"}}]}}]});
  return json({choices:[{message:{content:"fixture"}}]});
}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test("already aborted discovery and probe never start a fetch",async t=>{
  t.mock.method(globalThis,"fetch",()=>{assert.fail("no fetch after cancellation");});
  const signal=AbortSignal.abort("private fixture reason");
  await assert.rejects(listModels(provider,undefined,signal),{name:"AbortError"});
  await assert.rejects(probeProvider(provider,undefined,"m",signal),{name:"AbortError"});
});

test("cancelling an in-flight model request reaches fetch and launches no inference probes",async t=>{
  const controller=new AbortController();let calls=0;let aborted=false;
  t.mock.method(globalThis,"fetch",async(_url:unknown,init:RequestInit)=>{
    calls++;assert.equal(init.redirect,"error");
    return new Promise((_resolve,reject)=>init.signal!.addEventListener("abort",()=>{aborted=true;reject(new DOMException("fixture","AbortError"));},{once:true}));
  });
  const pending=probeProvider(provider,"fake-key","m",controller.signal);controller.abort();
  await assert.rejects(pending,{name:"AbortError"});assert.equal(aborted,true);assert.equal(calls,1);
});

test("cancelling a stalled JSON body closes its reader even if the source does not finish cancelling",async t=>{
  const controller=new AbortController();let cancelled=false;let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response(new ReadableStream<Uint8Array>({cancel(){cancelled=true;return new Promise(()=>{});}}));});
  const pending=probeProvider(provider,undefined,"m",controller.signal);await turn();controller.abort();
  await assert.rejects(pending,{name:"AbortError"});assert.equal(cancelled,true);assert.equal(calls,1);
});

test("stalled SSE cancellation closes its source without retrying include_usage",async t=>{
  const controller=new AbortController();let cancelled=false;let streaming=0;
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request,init?:RequestInit)=>{
    assert.equal(init?.redirect,"error");assert.ok(init?.signal);
    const body=JSON.parse(String(init?.body ?? "{}"));
    if(body.stream){streaming++;return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));},cancel(){cancelled=true;return new Promise(()=>{});}}));}
    return normal(input,init);
  });
  const pending=probeProvider(provider,undefined,"m",controller.signal);await turn();controller.abort();
  await assert.rejects(pending,{name:"AbortError"});assert.equal(cancelled,true);assert.equal(streaming,1);
});

test("an abort arriving with a rejected stream option never starts the fallback request",async t=>{
  const controller=new AbortController();let streaming=0;let cancelled=false;
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body ?? "{}"));
    if(body.stream){streaming++;controller.abort();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:400});}
    return normal(input,init);
  });
  await assert.rejects(probeProvider(provider,undefined,"m",controller.signal),{name:"AbortError"});
  assert.equal(streaming,1);assert.equal(cancelled,true);
});

test("uncancelled include_usage fallback remains compatible and closes the rejected body",async t=>{
  const controller=new AbortController();let streaming=0;let discarded=false;let calls=0;
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request,init?:RequestInit)=>{
    calls++;assert.equal(init?.redirect,"error");assert.ok(init?.signal);
    const body=JSON.parse(String(init?.body ?? "{}"));
    if(body.stream){streaming++;if(body.stream_options)return new Response(new ReadableStream({cancel(){discarded=true;}}),{status:400});}
    return normal(input,init);
  });
  const result=await probeProvider(provider,"fake-fixture-key","m",controller.signal);
  assert.equal(streaming,2);assert.equal(discarded,true);assert.equal(calls,7);assert.equal(result.streamUsage,false);
  assert.ok(result.report.checks.every(check=>check.status==="pass"));
});

test("all JSON response readers get cancelled together, not just discovery or SSE",async t=>{
  const controller=new AbortController();let cancelled=0;let bodies=0;
  t.mock.method(globalThis,"fetch",async(input:string|URL|Request,init?:RequestInit)=>{
    if(String(input).endsWith("/models"))return normal(input,init);
    bodies++;return new Response(new ReadableStream({cancel(){cancelled++;}}));
  });
  const pending=probeProvider(provider,undefined,"m",controller.signal);await turn();assert.equal(bodies,5);controller.abort();
  await assert.rejects(pending,{name:"AbortError"});await turn();assert.equal(cancelled,5);
});

async function listen(server:Server):Promise<string>{await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));return `http://127.0.0.1:${(server.address() as {port:number}).port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
test("loopback redirect rejection never forwards a fake key to the redirected host",async t=>{
  let targetCalls=0;const target=createServer((_req,res)=>{targetCalls++;res.end('{}');});const targetUrl=await listen(target);
  const redirect=createServer((_req,res)=>{res.writeHead(302,{location:`${targetUrl}/stolen`});res.end();});const url=await listen(redirect);
  t.after(async()=>{await close(redirect);await close(target);});
  const result=await listModels({...provider,baseUrl:url},"FAKE-REDIRECT-KEY");
  assert.equal(result.check.status,"fail");assert.equal(targetCalls,0);
});

test("aborting a loopback streaming probe actually closes the upstream connection",async t=>{
  const controller=new AbortController();let ready!:()=>void;let ended!:()=>void;
  const started=new Promise<void>(r=>{ready=r;});const closed=new Promise<void>(r=>{ended=r;});let streamCalls=0;
  const server=createServer(async(req,res)=>{
    let raw="";for await(const chunk of req)raw+=String(chunk);
    const body=JSON.parse(raw || "{}");
    if(body.stream){streamCalls++;res.writeHead(200,{"content-type":"text/event-stream"});res.write('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\n');res.once("close",ended);ready();return;}
    const response=normal(`http://127.0.0.1${req.url}`,{body:raw || "{}"});res.writeHead(200,{"content-type":"application/json"});res.end(await response.text());
  });
  const base=await listen(server);t.after(()=>close(server));
  const pending=probeProvider({...provider,baseUrl:`${base}/v1`},"FAKE-LOCAL-KEY","m",controller.signal);
  await started;controller.abort();await assert.rejects(pending,{name:"AbortError"});
  let timer:ReturnType<typeof setTimeout>|undefined;
  try { await Promise.race([closed,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("fixture connection did not close")),2000);})]); }
  finally {clearTimeout(timer);}
  assert.equal(streamCalls,1);
});
