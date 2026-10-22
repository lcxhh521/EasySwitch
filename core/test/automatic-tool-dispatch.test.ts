import assert from "node:assert/strict";
import { test } from "node:test";
import { withAutomaticAttempt, dispatchInference, type AutomaticAttempt } from "../src/automatic-dispatch.ts";
import { prepareOutbound } from "../src/outbound.ts";
import { ProtocolError } from "../src/protocol.ts";
import type { Provider } from "../src/types.ts";
const provider:Provider={id:"p",name:"Fixture",baseUrl:"http://127.0.0.1:1/v1",models:["m"],protocols:["chat"],route:"chat-translate",routePinned:true,streamUsage:true,createdAt:""};
const attempt:AutomaticAttempt={providerId:"p",requireNativeChat:true,readKey:async()=>"fixture",beforeDispatch:async()=>{},observe:()=>{}};
const signal=()=>new AbortController().signal;
test("tool dispatch cap is one even when a nested ordinary path asks again",async()=>{
  let calls=0;const budget={used:0,limit:1 as const};await withAutomaticAttempt(attempt,budget,async()=>{
    await dispatchInference(provider,signal(),async()=>{calls++;return Response.json({});});
    await assert.rejects(()=>dispatchInference(provider,signal(),async()=>{calls++;return Response.json({});}),ProtocolError);
  });assert.equal(calls,1);assert.equal(budget.used,1);
});
test("a tool context cannot silently adopt the P0 two-send budget",async()=>{
  let calls=0;await withAutomaticAttempt(attempt,{used:0,limit:2},async()=>{
    await assert.rejects(()=>dispatchInference(provider,signal(),async()=>{calls++;return Response.json({});}),ProtocolError);
  });assert.equal(calls,0);
});
test("tool egress rejects protocol conversion and injected saved effort without dispatch",async()=>{
  await withAutomaticAttempt(attempt,{used:0,limit:1},async()=>{
    const body={model:"m",messages:[{role:"user",content:"hi"}]};
    assert.throws(()=>prepareOutbound({...provider,protocols:["messages"]},{protocol:"chat",model:"m",stream:false,body}),ProtocolError);
    assert.throws(()=>prepareOutbound(provider,{protocol:"messages",model:"m",stream:false,body}),ProtocolError);
    assert.throws(()=>prepareOutbound(provider,{protocol:"chat",model:"m",stream:false,body,effort:"high"}),ProtocolError);
  });
});
test("tool egress preserves caller schema and controls instead of shaping them for a vendor",async t=>{
  const original=globalThis.fetch;let sent:any;globalThis.fetch=async(_url,init)=>{sent=JSON.parse(String(init?.body));return Response.json({});};t.after(()=>{globalThis.fetch=original;});
  const body={model:"m",stream:true,messages:[{role:"user",content:"hi"}],tools:[{type:"function",function:{name:"lookup",parameters:{$defs:{item:{type:"string"}},type:"object",properties:{q:{$ref:"#/$defs/item"}}}}}],parallel_tool_calls:true,tool_choice:"required"};
  await withAutomaticAttempt(attempt,{used:0,limit:1},async()=>{const out=prepareOutbound({...provider,baseUrl:"https://api.moonshot.cn/v1"},{protocol:"chat",model:"m",stream:true,body});assert.equal(out.adapter,"api-chat");assert.equal(out.passthrough,true);assert.deepEqual(out.dropped,[]);await out.send("fixture",signal());});
  assert.deepEqual(sent,body);assert.equal(Object.hasOwn(sent,"stream_options"),false,"does not inject a field absent from the caller's verified request");
});
