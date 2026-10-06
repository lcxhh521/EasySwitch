import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {test} from "node:test";
function ui(){
 const handlers:Record<string,Array<(e:any)=>unknown>>={};const context=vm.createContext({URLSearchParams,location:{search:'',hash:'#tasks'},window:{addEventListener(){}},history:{replaceState(){}},console,
 document:{addEventListener(n:string,f:any){(handlers[n]??=[]).push(f)},querySelector:()=>({innerHTML:'',textContent:'',className:''}),querySelectorAll:()=>[],activeElement:null},localStorage:{getItem:()=>null,setItem(){throw new Error('do not persist ratings in browser')}},setTimeout:()=>0,clearTimeout(){},requestAnimationFrame(){},fetch(){throw new Error('no transport')},
 FormData:class{f:any;constructor(f:any){this.f=f}get(k:string){return this.f.values[k]}}});
 for(const name of ['errors','feedback'])vm.runInContext(readFileSync(new URL(`../../web/${name}.js`,import.meta.url),'utf8'),context);
 const source=readFileSync(new URL('../../web/app.js',import.meta.url),'utf8');vm.runInContext(source.slice(0,source.lastIndexOf('fetch("icons/manifest.json")')),context);
 const run=(s:string):any=>vm.runInContext(s,context);run("globalThis.requests=[];globalThis.messages=[];state={providers:[],rules:[],bindings:{},prefs:{},pools:[]};render=()=>{};refresh=async()=>{};toast=s=>messages.push(s);call=async(m,p,b)=>{requests.push({m,p,b});return {evaluatedRatings:0,suggestions:[]}};");
 const dispatch=async(n:string,target:any)=>{let stop=false;for(const f of handlers[n]??[]){await f({target,preventDefault(){},stopImmediatePropagation(){stop=true}});if(stop)break;}};
 const button=(selector:string,dataset:any)=>{const el:any={dataset,closest:(s:string)=>s===selector?el:null};return el;};
 return {run,dispatch,button};
}
test('rules page stays unchanged without ratings or sufficient comparable evidence',()=>{
 const app=ui();assert.equal(app.run('ruleSuggestionsCard()'),'');app.run('suggestionReport={evaluatedRatings:4,suggestions:[],insufficient:[{message:"还没有足够价格记录"}]}');assert.match(app.run('ruleSuggestionsCard()'),/建议还需要更多依据/);assert.doesNotMatch(app.run('ruleSuggestionsCard()'),/data-suggestion-apply/);
 assert.equal(app.run("taskFeedbackControls({id:'t-a',status:'running'})"),'');const html=app.run("taskFeedbackControls({id:'t-a',status:'done',task:'do not duplicate prompt',output:'secret response'})");assert.match(html,/评价这次结果（可选）/);assert.doesNotMatch(html,/do not duplicate prompt|secret response/);
});
test('ratings submit only the exact task and value once and support withdrawal',async()=>{
 const app=ui();app.run("call=(m,p,b)=>{requests.push({m,p,b});return p.endsWith('/feedback')?new Promise(resolve=>globalThis.finish=resolve):Promise.resolve({evaluatedRatings:0,suggestions:[]})}");
 const btn=app.button('[data-task-feedback]',{taskFeedback:'t-a',rating:'good'});const pending=app.dispatch('click',btn);await new Promise(r=>setImmediate(r));await app.dispatch('click',btn);assert.equal(app.run('requests.length'),1);assert.equal(app.run('JSON.stringify(requests[0].b)'),'{"rating":"good"}');assert.equal(app.run('requests[0].p'),'/api/tasks/t-a/feedback');app.run('finish({})');await pending;
 app.run("call=async(m,p,b)=>{requests.push({m,p,b});return {evaluatedRatings:0,suggestions:[]}}");await app.dispatch('click',app.button('[data-task-feedback]',{taskFeedback:'t-a',rating:'clear'}));assert.equal(app.run('JSON.stringify(requests[2].b)'),'{"rating":null}');
});
test('suggestion application sends only its fresh identifier, never client-supplied draft rules',async()=>{
 const app=ui();app.run("call=(m,p,b)=>{requests.push({m,p,b});return new Promise((resolve,reject)=>globalThis.fail=reject)}");const btn=app.button('[data-suggestion-apply]',{suggestionApply:'suggestion-abc'});const pending=app.dispatch('click',btn);await new Promise(r=>setImmediate(r));await app.dispatch('click',btn);assert.equal(app.run('requests.length'),1);assert.equal(app.run('JSON.stringify(requests[0].b)'),'{}');app.run("fail(Object.assign(new Error('old private error'),{status:409}))");await pending;assert.equal(app.run('suggestionSaving'),false);assert.match(app.run('suggestionMessage'),/建议已变化/);assert.doesNotMatch(app.run('suggestionMessage'),/private/);
});
test('advice shows sample and price evidence as escaped text with uncertainty caveats',()=>{
 const app=ui();app.run("suggestionReport={evaluatedRatings:10,suggestions:[{id:'suggestion-abc',summary:'<img src=x>',evidence:{baseline:{target:{agent:'A',model:'p/a'},samples:5,good:5,medianCostUsd:1},candidate:{target:{agent:'B',model:'p/b'},samples:5,good:5,medianCostUsd:0.2}},caveats:['观察样本，不证明质量相同','<script>bad</script>']}]} ");
 const html=app.run('ruleSuggestionsCard()');assert.match(html,/5次评价/);assert.match(html,/观察样本，不证明质量相同/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script>/);assert.match(html,/生成这条规则/);
});
test('generated rules remain editable without dropping hidden filters or re-enabling disabled rules',async()=>{
 const app=ui();app.run("state.rules=[{id:'r-abc',name:'Original',enabled:false,when:{anyWords:['class'],from:'console',regex:'safe'},then:{agent:'hermes',model:'p/a'}}]");await app.dispatch('click',app.button('[data-rule-edit]',{ruleEdit:'r-abc'}));assert.equal(app.run('ruleForm.id'),'r-abc');
 const form:any={values:{name:'Edited',words:'class',minChars:'',maxChars:'',cwdPrefix:'',agent:'aider',model:'p/b',effort:''},matches:()=>false,closest:(s:string)=>s==='form[data-rule-form]'?form:null};await app.dispatch('submit',form);
 assert.equal(app.run('requests[0].m'),'PUT');assert.equal(app.run('requests[0].p'),'/api/rules/r-abc');assert.equal(app.run('requests[0].b.enabled'),false);assert.equal(app.run('requests[0].b.when.from'),'console');assert.equal(app.run('requests[0].b.when.regex'),'safe');assert.equal(app.run('requests[0].b.then.model'),'p/b');
});


test('task accounting storage and fixed-capacity warnings stay visible without inventing zero prices',()=>{
 const app=ui();app.run('taskList={accounting:{available:true,capacityReached:true,capacity:5000}}');assert.match(app.run('taskAccountingNotice()'),/五千|5000/);assert.match(app.run('taskAccountingNotice()'),/费用将标为未知/);
 app.run('taskList.accounting.failureUnrecorded=true');assert.match(app.run('taskAccountingNotice()'),/请暂停派活并检查磁盘/);app.run('suggestionReport={evaluatedRatings:0,suggestions:[]}');assert.equal(app.run('ruleSuggestionsCard()'),'');
});
