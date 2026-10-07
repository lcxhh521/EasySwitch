import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEventStream, encodeMessage, encodeTypedMessage, EventStreamError, type EventHeaderValue, type EventStreamLimits } from "../src/aws-eventstream.ts";
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex,"hex"));
const empty = bytes("000000100000000005c248eb7d98c8ff");
const hello = bytes("0000001500000000cd22c79b68656c6c6f570c3496");
const event = bytes("0000002500000013e8bd3ec30b3a6576656e742d74797065070004746573747b7dba921fc5");
// Golden frames above were independently built with Python struct + zlib.crc32.
// This small bitwise oracle follows RFC1952, independent of the decoder's table.
function crc(data: Uint8Array) { let result=0xffffffff;for(const byte of data){result^=byte;for(let i=0;i<8;i++)result=(result>>>1)^((result&1)?0xedb88320:0);}return(result^0xffffffff)>>>0; }
function raw(headers: Uint8Array, payload = new Uint8Array(0)) {
 const frame=new Uint8Array(16+headers.length+payload.length),view=new DataView(frame.buffer);view.setUint32(0,frame.length);view.setUint32(4,headers.length);view.setUint32(8,crc(frame.subarray(0,8)));frame.set(headers,12);frame.set(payload,12+headers.length);view.setUint32(frame.length-4,crc(frame.subarray(0,frame.length-4)));return frame;
}
const stream=(chunks:Uint8Array[],cancel?:()=>void|PromiseLike<void>)=>new ReadableStream<Uint8Array>({pull(c){const next=chunks.shift();if(next)c.enqueue(next);else c.close();},cancel});
async function collect(chunks:Uint8Array[],limits:EventStreamLimits={}) {const result=[];for await(const frame of decodeEventStream(stream([...chunks]),limits))result.push(frame);return result;}
const invalid=(error:unknown)=>error instanceof EventStreamError&&error.code==="invalid_eventstream";
const over=(error:unknown)=>error instanceof EventStreamError&&error.code==="eventstream_limit";

test("published wire layout matches independent CRC golden frames and the legacy encoder",async()=>{
 assert.equal(crc(new TextEncoder().encode("123456789")),0xcbf43926);
 assert.deepEqual(encodeMessage({},new Uint8Array()),empty);
 assert.deepEqual(encodeMessage({},new TextEncoder().encode("hello")),hello);
 assert.deepEqual(encodeMessage({":event-type":"test"},new TextEncoder().encode("{}")),event);
 const result=await collect([Buffer.concat([empty,hello,event])]);assert.equal(result.length,3);assert.equal(result[0]!.payload.length,0);assert.equal(new TextDecoder().decode(result[1]!.payload),"hello");assert.equal(result[2]!.headers[":event-type"],"test");assert.equal(new TextDecoder().decode(result[2]!.payload),"{}");
});
test("every transport split, one-byte chunks, empty chunks and nonzero byte offsets preserve frames",async()=>{
 for(let split=0;split<=event.length;split++){const r=await collect([event.subarray(0,split),event.subarray(split)]);assert.equal(r[0]!.headers[":event-type"],"test");}
 const all=Buffer.concat([hello,event,empty]),padded=Buffer.concat([Buffer.alloc(9),all,Buffer.alloc(7)]);
 const r=await collect([...padded.subarray(9,9+all.length)].flatMap(byte=>[Uint8Array.of(),Uint8Array.of(byte)]));assert.equal(r.length,3);
});
test("all ten header wire tags decode losslessly, including signed integers, timestamps and binary UUID",async()=>{
 const headers=bytes("016100016201016302800164038000016504800000000166057fffffffffffffff016706000300feff016807000568656c6c6f016908ffffffffffffffff016a0900112233445566778899aabbccddeeff");
 const values:Record<string,EventHeaderValue>={a:{type:"boolean",value:true},b:{type:"boolean",value:false},c:{type:"byte",value:-128},d:{type:"short",value:-32768},e:{type:"integer",value:-2147483648},f:{type:"long",value:9223372036854775807n},g:{type:"binary",value:bytes("00feff")},h:{type:"string",value:"hello"},i:{type:"timestamp",value:-1n},j:{type:"uuid",value:"00112233-4455-6677-8899-aabbccddeeff"}};
 const frame=raw(headers),decoded=(await collect([frame]))[0]!;assert.deepEqual({...decoded.headerValues},values);assert.deepEqual({...decoded.headers},{h:"hello"});assert.deepEqual(encodeTypedMessage(values,new Uint8Array()),frame);
});
test("UTF-8 names and values retain BOM and multibyte characters without prototype mutation",async()=>{
 const headers:Record<string,string>=Object.create(null);headers["__proto__"]="safe";Object.defineProperty(headers,"constructor",{value:"safe too",enumerable:true});headers["名"]="文字 🧪";headers["\ufeffname"]="\ufefftext";
 const decoded=(await collect([encodeMessage(headers,new Uint8Array())]))[0]!;assert.equal(Object.getPrototypeOf(decoded.headers),null);assert.deepEqual({...decoded.headers},{...headers});assert.equal(({} as any).polluted,undefined);
});
test("prelude CRC is checked before trusting or allocating a declared huge frame",async()=>{
 const corrupt=hello.slice();new DataView(corrupt.buffer).setUint32(0,0xffffffff);let cancelled=0,pulls=0;
 const input=new ReadableStream<Uint8Array>({pull(c){pulls++;c.enqueue(corrupt.subarray(0,12));},cancel(){cancelled++;}});
 await assert.rejects(async()=>{for await(const ignored of decodeEventStream(input))assert.fail("invalid prelude must never emit");},invalid);assert.equal(cancelled,1);assert.ok(pulls<=2);assert.equal(input.locked,false);
 const validCrc=corrupt.slice(0,12);new DataView(validCrc.buffer).setUint32(8,crc(validCrc.subarray(0,8)));await assert.rejects(collect([validCrc]),over);
});
test("message CRC protects header and payload bytes and no invalid frame is emitted",async()=>{
 for(const index of [12,20,event.length-5,event.length-1]){const corrupt=event.slice();corrupt[index]=corrupt[index]!^1;await assert.rejects(collect([corrupt]),invalid);}
 let count=0;const bad=hello.slice();bad[bad.length-1]=bad[bad.length-1]!^1;await assert.rejects(async()=>{for await(const ignored of decodeEventStream(stream([Buffer.concat([empty,bad])]))){count++;}},invalid);assert.equal(count,1);
});
test("every truncated prelude/body/trailer fails, while a clean empty stream is valid",async()=>{
 assert.deepEqual(await collect([]),[]);
 for(let length=1;length<event.length;length++)await assert.rejects(collect([event.slice(0,length)]),invalid);
 for(const [length,headerLength]of[[15,0],[16,1],[20,9]] as const){const prelude=new Uint8Array(12),view=new DataView(prelude.buffer);view.setUint32(0,length);view.setUint32(4,headerLength);view.setUint32(8,crc(prelude.subarray(0,8)));await assert.rejects(collect([prelude]),invalid);}
});
test("headers cannot overrun their own area, use unknown tags or repeat names",async()=>{
 for(const hex of ["00","036162","0161","0161ff","01610300","0161060005abcd","0161070005abcd","0161090000","016100016101"]){await assert.rejects(collect([raw(bytes(hex))]),invalid);}
});
test("invalid UTF-8 is rejected instead of aliasing names or silently replacing string values",async()=>{
 for(const hex of ["01ff00","02c0af00","0161070001ff","0161070003f09080"]){await assert.rejects(collect([raw(bytes(hex))]),invalid);}
 assert.throws(()=>encodeMessage({"\ud800":"x"},new Uint8Array()),invalid);assert.throws(()=>encodeMessage({a:"\udfff"},new Uint8Array()),invalid);
});
test("local frame/buffer/stream/message/header limits terminate rather than accumulating unbounded data",async()=>{
 await assert.rejects(collect([hello],{maxFrameBytes:20}),over);
 await assert.rejects(collect([hello],{maxChunkBytes:20}),over);
 await assert.rejects(collect([empty,empty],{maxStreamBytes:31}),over);
 await assert.rejects(collect([empty,empty],{maxMessages:1}),over);
 await assert.rejects(collect([raw(bytes("016100016201"))],{maxHeaders:1}),over);
 await assert.rejects(collect(Array.from({length:1025},()=>new Uint8Array())),over);
 for(const options of [{maxFrameBytes:15},{maxMessages:0},{maxHeaders:1.1},{maxStreamBytes:NaN}])await assert.rejects(collect([empty],options),TypeError);
});
test("service-side header size is not confused with the explicit local resource policy",async()=>{
 const text="x".repeat(65535),frame=encodeMessage({a:text,b:text,c:"",d:"边界"},new Uint8Array());assert.ok(new DataView(frame.buffer).getUint32(4)>131072);
 const decoded=(await collect([frame]))[0]!;assert.equal(decoded.headers.a?.length,65535);assert.equal(decoded.headers.c,"");assert.equal(decoded.headers.d,"边界");
});
test("early consumer return cancels and releases its reader without waiting for an uncooperative cancel promise",{timeout:1000},async()=>{
 let cancelled=0;const input=new ReadableStream<Uint8Array>({start(c){c.enqueue(empty);},cancel(){cancelled++;return new Promise(()=>{});}});const iterator=decodeEventStream(input);assert.equal((await iterator.next()).done,false);await iterator.return(undefined);assert.equal(cancelled,1);assert.equal(input.locked,false);
});
test("explicit abort cancels a pending read and hides arbitrary signal reasons",{timeout:1000},async()=>{
 let cancelled=0;const controller=new AbortController(),input=new ReadableStream<Uint8Array>({pull(){return new Promise(()=>{});},cancel(){cancelled++;return new Promise(()=>{});}}),iterator=decodeEventStream(input,{signal:controller.signal});const pending=iterator.next();controller.abort(new Error("Bearer fixture-private-value"));await assert.rejects(pending,(error:any)=>error.name==="AbortError"&&!error.message.includes("fixture-private"));assert.equal(cancelled,1);assert.equal(input.locked,false);
});
test("source errors never expose raw upstream details and reader ownership is released",async()=>{
 const input=new ReadableStream<Uint8Array>({start(c){c.error(new Error("fixture-payload-and-secret"));}});await assert.rejects(async()=>{for await(const ignored of decodeEventStream(input))assert.fail("no message");},(error:any)=>invalid(error)&&!error.message.includes("fixture-payload"));assert.equal(input.locked,false);
});
test("typed encoder validates ranges and names instead of silently truncating or coercing",()=>{
 for(const header of [{type:"byte",value:128},{type:"short",value:-32769},{type:"integer",value:1.5},{type:"long",value:1},{type:"long",value:1n<<63n},{type:"timestamp",value:-(1n<<63n)-1n},{type:"boolean",value:1},{type:"uuid",value:"bad"},{type:"string",value:"x".repeat(65536)}])assert.throws(()=>encodeTypedMessage({a:header as EventHeaderValue},new Uint8Array()),invalid);
 assert.throws(()=>encodeMessage({"":"x"},new Uint8Array()),invalid);assert.throws(()=>encodeMessage({["界".repeat(86)]:"x"},new Uint8Array()),invalid);
});

test("abort between buffered frame assembly and delivery prevents yielding a cancelled event",async()=>{
 const controller=new AbortController();const iterator=decodeEventStream(new ReadableStream<Uint8Array>({start(c){c.enqueue(empty);}}),{signal:controller.signal});const next=iterator.next();for(let i=0;i<3;i++)await Promise.resolve();controller.abort();await assert.rejects(next,(error:any)=>error.name==="AbortError");
});
