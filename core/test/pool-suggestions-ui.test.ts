import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";
const ID="pool-suggestion-0123456789abcdef01234567";
function fixture(){let handler!:(event:any)=>Promise<void>;const requests:any[]=[];const c=vm.createContext({state:{poolSuggestions:[]},document:{addEventListener(_name:string,fn:any){handler=fn;}},esc:(v:any)=>String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;"),render(){},toast(){},userErrorMessage:()=>"操作未完成，请重试",refresh:async()=>{},call:async(...args:any[])=>{requests.push(args);return{};}});vm.runInContext(readFileSync(new URL("../../web/pool-suggestions.js",import.meta.url),"utf8"),c);return{c,requests,run:(s:string)=>vm.runInContext(s,c),click:(action:string)=>handler({target:{closest:()=>({dataset:{poolSuggestion:ID,poolAction:action}})},preventDefault(){},stopImmediatePropagation(){}})};}
test("suggestion cards are empty without evidence, escape metadata and offer explicit accept or dismiss",()=>{
 const f=fixture();assert.equal(f.run("poolSuggestionsCard()"),"");
 f.c.state={poolSuggestions:[{id:ID,model:'<script>alert(1)</script>',members:[{providerName:'<img onerror=x>'},{providerName:'B'}]}]};const html=f.run("poolSuggestionsCard()");assert.ok(!html.includes("<script>"));assert.ok(html.includes("&lt;script>"));assert.match(html,/合成模型池/);assert.match(html,/不用/);
});
test("double click is suppressed, failed actions unlock for retry and send no replacement members",async()=>{
 const f=fixture();f.run("call=async(...args)=>{globalThis.args=args;return new Promise(resolve=>globalThis.finish=resolve)}");const pending=f.click("apply");await f.click("apply");assert.equal(f.run("poolSuggestionBusy"),true);assert.equal(f.run("JSON.stringify(args)"),JSON.stringify(["POST",`/api/pools/suggestions/${ID}/apply`,{}]));f.run("finish({})");await pending;assert.equal(f.run("poolSuggestionBusy"),false);
 f.run("call=async()=>{throw {status:409}}");await f.click("dismiss");assert.match(f.run("poolSuggestionMessage"),/建议已变化/);assert.equal(f.run("poolSuggestionBusy"),false);
});
