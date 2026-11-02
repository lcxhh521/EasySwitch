import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ProviderImportService, ProviderImportError, type ImportSource } from "../src/provider-import.ts";
import { Store } from "../src/store.ts";
import type { Provider } from "../src/types.ts";
import type { SecretStore } from "../src/secrets.ts";

function fixture(t:TestContext) {
  const root=mkdtempSync(join(realpathSync(tmpdir()),"es-provider-import-")),home=join(root,"home");mkdirSync(home);
  const store=new Store(join(root,"state")),values=new Map<string,string>();let envReads=0,writes=0,reads=0,now=1_800_000_000_000;
  const environment:Record<string,string|undefined>={};
  const secrets:SecretStore={async get(key){reads++;return values.get(key);},async set(key,value){writes++;values.set(key,value);},async delete(key){values.delete(key);}};
  const service=new ProviderImportService({home,store,secrets,environment:()=>{envReads++;return environment;},now:()=>now});
  const file=(name:string,value:unknown)=>{const path=join(home,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==="string"?value:JSON.stringify(value));return path;};
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {root,home,store,values,environment,secrets,service,file,counts:()=>({envReads,writes,reads}),advance:()=>now+=600_001};
}
const oc=(key="fixture-oc-secret")=>({providers:{relay:{adapter:"openai-chat",baseUrl:"https://relay.invalid/v1/chat/completions",apiKey:key,models:["model-1"]}},providers_meta:{relay:{name:"Fixture Relay"}}});
const toml=(extra="")=>`model_provider = "custom"\nmodel = "model-2"\n[model_providers.custom]\nname = "Codex Fixture"\nbase_url = "https://codex-relay.invalid/v1"\nwire_api = "responses"\n${extra}\n`;
const snap=(home:string)=>Object.fromEntries(readdirSync(home,{recursive:true,withFileTypes:true}).filter(f=>f.isFile()).map(f=>[join(f.parentPath,f.name).slice(home.length),readFileSync(join(f.parentPath,f.name)).toString("hex")]));
function sqlite(home:string,rows:Array<{app:string;name:string;settings:unknown}>) {
  const dir=join(home,".cc-switch");mkdirSync(dir,{recursive:true});const path=join(dir,"cc-switch.db"),db=new DatabaseSync(path);
  db.exec("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)");
  for(const [i,row]of rows.entries())db.prepare("INSERT INTO providers VALUES (?, ?, ?, ?)").run(String(i),row.app,row.name,JSON.stringify(row.settings));db.close();return path;
}

test("construction, empty scan and unselected sources never read environment or write keys",async t=>{
 const f=fixture(t);const p=await f.service.preview({sources:[]});assert.deepEqual(p.candidates,[]);
 assert.deepEqual(await f.service.commit({previewId:p.previewId,chosen:[]}),{imported:[],failed:[],rolledBack:false});
 assert.deepEqual(f.counts(),{envReads:0,writes:0,reads:0});assert.deepEqual(f.store.providers(),[]);
 await assert.rejects(f.service.preview({sources:["unknown"] as unknown as ImportSource[]}),ProviderImportError);
 await assert.rejects(f.service.preview({sources:["codex"],paths:{codex:"/etc/passwd"}} as never),ProviderImportError);
});
test("opencodex preview redacts secrets, keeps model lists, and imports only a selected key pool without probes",async t=>{
 const f=fixture(t);f.file(".opencodex/config.json",{...oc(),providers:{...oc().providers,pool:{baseUrl:"https://pool.invalid/v1",apiKeyPool:[{key:"fixture-pool-secret-a",label:"do-not-return-label"},{key:"fixture-pool-secret-b"}],models:["m"]},native:{baseUrl:"https://chatgpt.com/backend-api/codex",authMode:"forward"}}});
 const before=snap(f.home),p=await f.service.preview({sources:["opencodex"]});assert.equal(p.candidates.length,3);
 assert.doesNotMatch(JSON.stringify(p),/fixture-.*secret|do-not-return-label|fingerprint/);assert.equal(f.counts().writes,0);
 const pool=p.candidates.find(c=>c.baseUrl.includes("pool.invalid"))!;assert.equal(pool.keyCount,2);
 const result=await f.service.commit({previewId:p.previewId,chosen:[pool.id]});assert.equal(result.imported.length,1);assert.deepEqual(result.failed,[]);
 const provider=f.store.providers()[0]!;assert.equal(provider.off,true);assert.equal(provider.keys?.length,2);assert.equal(provider.models[0],"m");
 assert.equal(f.values.get(provider.id),"fixture-pool-secret-a");for(const key of provider.keys!)assert.ok(f.values.has(`${provider.id}#${key.id}`));
 assert.doesNotMatch(JSON.stringify(f.store.providers()),/fixture-.*secret/);assert.deepEqual(snap(f.home),before);assert.equal(f.counts().reads,0);
 await assert.rejects(f.service.commit({previewId:p.previewId,chosen:[pool.id]}),/预览已失效/);
});
test("CC Switch SQLite reads verified Claude/Codex row shapes without modifying any source bytes or sidecars",async t=>{
 const f=fixture(t);sqlite(f.home,[{app:"claude",name:"Claude fixture",settings:{env:{ANTHROPIC_BASE_URL:"https://claude-relay.invalid",ANTHROPIC_AUTH_TOKEN:"fixture-claude-secret",ANTHROPIC_MODEL:"claude-fixture"}}},{app:"codex",name:"Codex fixture",settings:{auth:{OPENAI_API_KEY:"fixture-codex-secret"},config:toml("requires_openai_auth = true")}}, {app:"gemini",name:"Unsupported fixture",settings:{apiKey:"not-imported"}}]);
 const before=snap(f.home),p=await f.service.preview({sources:["cc-switch"]});assert.equal(p.sources[0]!.status,"ready");assert.equal(p.candidates.filter(c=>c.importable).length,2);assert.equal(p.candidates[2]!.importable,false);
 const result=await f.service.commit({previewId:p.previewId,chosen:p.candidates.filter(c=>c.importable).map(c=>c.id)});assert.equal(result.imported.length,2);
 assert.deepEqual(f.store.providers().map(p=>p.protocols),[["messages"],["responses"]]);assert.deepEqual(snap(f.home),before);assert.deepEqual(readdirSync(join(f.home,".cc-switch")),["cc-switch.db"]);
 assert.doesNotMatch(JSON.stringify(p)+JSON.stringify(result)+JSON.stringify(f.store.providers()),/fixture-(?:claude|codex)-secret/);
});
test("active CC Switch journals, unexpected schemas and non-database files are blocked without guessing",async t=>{
 for(const kind of ["wal","schema","invalid"]){const f=fixture(t);const path=sqlite(f.home,[]);if(kind==="wal")writeFileSync(path+"-wal","fixture");else if(kind==="schema"){const db=new DatabaseSync(path);db.exec("DROP TABLE providers; CREATE VIEW providers AS SELECT 'x' AS id");db.close();}else writeFileSync(path,"not a sqlite database");
 const before=snap(f.home),p=await f.service.preview({sources:["cc-switch"]});assert.equal(p.sources[0]!.status,"blocked");assert.deepEqual(p.candidates,[]);assert.deepEqual(snap(f.home),before);}
});
test("environment import is explicit and recognizes only bounded API-key variables",async t=>{
 const f=fixture(t);Object.assign(f.environment,{OPENAI_API_KEY:"fixture-openai-secret",DEEPSEEK_API_KEY:"fixture-deepseek-secret",ANTHROPIC_API_KEY:"fixture-anthropic-secret",CODEX_TOKEN:"native-secret-never-read"});
 const p=await f.service.preview({sources:["environment"]});assert.equal(p.candidates.length,3);assert.equal(f.counts().envReads,1);assert.ok(p.candidates.every(c=>c.importable));
 assert.doesNotMatch(JSON.stringify(p),/fixture-.*secret|native-secret/);await f.service.commit({previewId:p.previewId,chosen:[]});assert.equal(f.values.size,0);
});
test("Codex scalar provider config resolves a selected environment key and never opens native auth",async t=>{
 const f=fixture(t);f.file(".codex/config.toml",toml('env_key = "RELAY_API_KEY"'));f.file(".codex/auth.json","intentionally invalid native login file");f.environment.RELAY_API_KEY="fixture-reference-secret";
 const alone=await f.service.preview({sources:["codex"]});assert.equal(alone.candidates[0]!.importable,false);assert.equal(f.counts().envReads,0);
 const p=await f.service.preview({sources:["codex","environment"]});assert.equal(p.candidates[0]!.importable,true);const result=await f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]});assert.equal(result.imported.length,1);assert.equal(f.store.providers()[0]!.route,"responses-native");
 assert.equal(readFileSync(join(f.home,".codex/auth.json"),"utf8"),"intentionally invalid native login file");
});
test("Codex native auth, command auth, extra headers and unknown protocols cannot be silently reinterpreted",async t=>{
 for(const extra of ['requires_openai_auth = true','[model_providers.custom.auth]\ncommand = "fixture-command"','http_headers = {}','wire_api = "chat"']){const f=fixture(t);f.file(".codex/config.toml",toml('experimental_bearer_token = "fixture-key"\n'+extra));const p=await f.service.preview({sources:["codex"]});assert.ok(p.sources[0]!.status==="blocked"||p.candidates.every(c=>!c.importable));assert.equal(f.values.size,0);}
});
test("Claude custom env settings import as Messages while helpers and native OAuth credentials are rejected",async t=>{
 const f=fixture(t);f.file(".claude/settings.json",{env:{ANTHROPIC_BASE_URL:"https://claude.invalid/v1",ANTHROPIC_API_KEY:"fixture-key",ANTHROPIC_MODEL:"model-3"},hooks:{PreToolUse:[{command:"must-not-execute"}]}});
 const p=await f.service.preview({sources:["claude"]});assert.equal(p.candidates[0]!.defaultModel,"model-3");assert.equal((await f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]})).imported.length,1);assert.equal(f.store.providers()[0]!.messagesRoute,"anthropic-native");
 for(const settings of [{apiKeyHelper:"must-not-run",env:{ANTHROPIC_BASE_URL:"https://claude.invalid",ANTHROPIC_API_KEY:"fixture-key"}},{env:{ANTHROPIC_BASE_URL:"https://claude.invalid",ANTHROPIC_AUTH_TOKEN:"sk-ant-oat01-native-token"}}]){f.file(".claude/settings.json",settings);assert.equal((await f.service.preview({sources:["claude"]})).candidates[0]!.importable,false);}
});
test("embedded keys and URL credentials never survive preview metadata",async t=>{
 for(const metadata of [{name:"fixture-key"},{baseUrl:"https://relay.invalid/fixture-key"},{baseUrl:"https://relay.invalid/%66ixture-key"},{models:["fixture-key"]},{baseUrl:"https://user:fixture-key@relay.invalid/v1"},{baseUrl:"https://relay.invalid/v1?key=fixture-key"},{baseUrl:"https://relay.invalid/v1#fixture-key"}]){const f=fixture(t);const config=oc("fixture-key");Object.assign(config.providers.relay,metadata);if("name" in metadata)config.providers_meta.relay.name=metadata.name!;f.file(".opencodex/config.json",config);const p=await f.service.preview({sources:["opencodex"]});assert.equal(p.candidates[0]!.importable,false);assert.doesNotMatch(JSON.stringify(p),/fixture-key/);}
});
test("symlink files, symlink parents, hard links and oversized files fail before import",async t=>{
 for(const mode of ["file","parent","hard","large"]){const f=fixture(t);const outside=join(f.root,"outside");mkdirSync(outside);writeFileSync(join(outside,"config.json"),JSON.stringify(oc()));
 if(mode==="parent")symlinkSync(outside,join(f.home,".opencodex"));else{mkdirSync(join(f.home,".opencodex"));const path=join(f.home,".opencodex/config.json");if(mode==="file")symlinkSync(join(outside,"config.json"),path);else if(mode==="hard")linkSync(join(outside,"config.json"),path);else writeFileSync(path,"x".repeat(4*1024*1024+1));}
 const p=await f.service.preview({sources:["opencodex"]});assert.equal(p.sources[0]!.status,"blocked");assert.equal(p.candidates.length,0);assert.equal(f.values.size,0);}
});
test("source changes, stale previews and mixed invalid selections cause zero writes",async t=>{
 const f=fixture(t);f.file(".opencodex/config.json",oc());let p=await f.service.preview({sources:["opencodex"]});await assert.rejects(f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id,"unknown"]}),/不可导入/);
 f.file(".opencodex/config.json",oc("changed-key"));await assert.rejects(f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]}),error=>error instanceof ProviderImportError&&error.status===409);
 p=await f.service.preview({sources:["opencodex"]});f.advance();await assert.rejects(f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]}),error=>error instanceof ProviderImportError&&error.status===409);assert.equal(f.counts().writes,0);
});
test("secret and provider failures roll back all new slots and rows, preserving unrelated sources",async t=>{
 for(const phase of ["secret","provider"]){const f=fixture(t);const existing:Provider={id:"existing",name:"Existing",baseUrl:"https://existing.invalid",models:[],route:"chat-translate",routePinned:false,streamUsage:true,createdAt:""};f.store.upsertProvider(existing);f.values.set("existing","unchanged-secret");f.file(".opencodex/config.json",oc());const p=await f.service.preview({sources:["opencodex"]});
 const set=f.secrets.set.bind(f.secrets),upsert=f.store.upsertProvider.bind(f.store);if(phase==="secret")f.secrets.set=async(k,v)=>{await set(k,v);throw new Error("raw-secret-failure")};else f.store.upsertProvider=p=>{upsert(p);throw new Error("raw-secret-failure")};
 const result=await f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]});assert.equal(result.rolledBack,true);assert.deepEqual(result.imported,[]);assert.deepEqual(f.store.providers(),[existing]);assert.deepEqual([...f.values],[['existing','unchanged-secret']]);assert.doesNotMatch(JSON.stringify(result),/raw-secret-failure|fixture-oc-secret/);}
});
test("rollback failures are reported honestly and duplicate concurrent commits cannot write twice",async t=>{
 const f=fixture(t);f.file(".opencodex/config.json",oc());const p=await f.service.preview({sources:["opencodex"]});let release!:()=>void;const paused=new Promise<void>(r=>release=r);f.secrets.set=async(k,v)=>{f.values.set(k,v);await paused;throw new Error("raw-error")};f.secrets.delete=async()=>{throw new Error("raw-cleanup-error")};
 const first=f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]});await assert.rejects(f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]}),ProviderImportError);release();const result=await first;assert.equal(result.rolledBack,false);assert.match(result.failed[0]!.reason,/未能确认/);assert.doesNotMatch(JSON.stringify(result),/raw-error|raw-cleanup/);
});

test("a later batch failure rolls back earlier successful entries rather than claiming a partial import",async t=>{
 const f=fixture(t);f.file(".opencodex/config.json",{providers:{one:{...oc().providers.relay,apiKey:"fixture-first-key"},two:{...oc().providers.relay,apiKey:"fixture-second-key"}}});
 const p=await f.service.preview({sources:["opencodex"]}),set=f.secrets.set.bind(f.secrets);let attempts=0;
 f.secrets.set=async(k,v)=>{await set(k,v);if(++attempts===2)throw new Error("second write failed")};
 const result=await f.service.commit({previewId:p.previewId,chosen:p.candidates.map(c=>c.id)});
 assert.equal(result.rolledBack,true);assert.equal(result.failed.length,2);assert.deepEqual(f.store.providers(),[]);assert.equal(f.values.size,0);
});
test("environment changes after preview require reselection and failures never disclose environment errors",async t=>{
 const f=fixture(t);f.environment.OPENAI_API_KEY="fixture-before";const p=await f.service.preview({sources:["environment"]});f.environment.OPENAI_API_KEY="fixture-after";
 await assert.rejects(f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]}),error=>error instanceof ProviderImportError&&error.status===409);assert.equal(f.counts().writes,0);
 const service=new ProviderImportService({home:f.home,store:f.store,secrets:f.secrets,environment:()=>{throw new Error("private-environment-content")}});
 await assert.rejects(service.preview({sources:["environment"]}),error=>error instanceof ProviderImportError&&!error.message.includes("private-environment"));
});
test("ambiguous Claude credentials and unknown opencodex adapters remain explicit unsupported candidates",async t=>{
 const f=fixture(t);f.file(".claude/settings.json",{env:{ANTHROPIC_BASE_URL:"https://relay.invalid",ANTHROPIC_API_KEY:"fixture-one",ANTHROPIC_AUTH_TOKEN:"fixture-two"}});
 f.file(".opencodex/config.json",{providers:{odd:{...oc().providers.relay,adapter:"undocumented-protocol"}}});
 const p=await f.service.preview({sources:["claude","opencodex"]});assert.equal(p.candidates.length,2);assert.ok(p.candidates.every(c=>!c.importable&&c.reason));
});

const openCode = (key="fixture-opencode-key") => ({model:"relay/model/b",provider:{relay:{npm:"@ai-sdk/openai-compatible",name:"OpenCode Relay",options:{baseURL:"https://opencode-relay.invalid/v1",apiKey:key},models:{"model/a":{name:"Display A"},"model/b":{}}}}});

test("OpenCode explicit global JSON imports literal custom API chat sources off without reading auth or environment",async t=>{
 const f=fixture(t);f.file(".config/opencode/opencode.json",openCode());f.file(".local/share/opencode/auth.json","not-json native token fixture");f.environment.OPENCODE_CONFIG="/must-not-read";f.environment.OPENCODE_CONFIG_CONTENT="must-not-parse";const before=snap(f.home);
 const preview=await f.service.preview({sources:["opencode"]});assert.equal(preview.sources[0]!.status,"ready");assert.equal(preview.candidates.length,1);assert.deepEqual(preview.candidates[0]!.models,["model/b","model/a"]);assert.equal(preview.candidates[0]!.importable,true);assert.doesNotMatch(JSON.stringify(preview),/fixture-opencode-key|Display A|native token/);assert.deepEqual(f.counts(),{envReads:0,writes:0,reads:0});
 const result=await f.service.commit({previewId:preview.previewId,chosen:[preview.candidates[0]!.id]});assert.equal(result.imported.length,1);const saved=f.store.providers()[0]!;assert.equal(saved.off,true);assert.equal(saved.defaultModel,"model/b");assert.deepEqual(saved.protocols,["chat"]);assert.equal(saved.route,"chat-translate");assert.equal(f.values.get(saved.id),"fixture-opencode-key");assert.deepEqual(snap(f.home),before);assert.equal(f.counts().envReads,0);
});

test("OpenCode JSONC supports comments and trailing commas without mangling URL slashes or quoted comment markers",async t=>{
 const f=fixture(t);f.file(".config/opencode/opencode.jsonc",`{ // a comment\n "provider": { "relay": {"npm":"@ai-sdk/openai-compatible", "name":"Comment /* literal */", "options":{"baseURL":"https://relay.invalid/v1", "apiKey":"fixture-jsonc-key",}, "models":{"model":{},},},}, /* tail */ }`);
 const p=await f.service.preview({sources:["opencode"]});assert.equal(p.sources[0]!.status,"ready");assert.equal(p.candidates[0]!.importable,true);assert.equal(p.candidates[0]!.name,"Comment /* literal */");assert.equal(p.candidates[0]!.baseUrl,"https://relay.invalid/v1");
});

test("OpenCode dual global files, aliases, malformed JSONC, duplicate keys, depth and special paths fail closed",async t=>{
 for(const kind of ["both","symlink","hardlink","malformed","duplicate","escaped-duplicate","prototype","depth","json-comments","oversized"]){const f=fixture(t),base=".config/opencode/opencode.jsonc";f.file(base,openCode());
 if(kind==="both")f.file(".config/opencode/opencode.json",openCode());
 if(kind==="symlink"){rmSync(join(f.home,base));symlinkSync(f.file("outside.json",openCode()),join(f.home,base));}
 if(kind==="hardlink"){rmSync(join(f.home,base));linkSync(f.file("outside.json",openCode()),join(f.home,base));}
 if(kind==="malformed")f.file(base,'{"provider": {} /* unclosed');
 if(kind==="duplicate")f.file(base,'{"provider": {}, "provider": {}}');
 if(kind==="escaped-duplicate")f.file(base,'{"provider": {}, "provi\\u0064er": {}}');
 if(kind==="prototype")f.file(base,'{"__proto__": {"polluted": true}}');
 if(kind==="depth")f.file(base,'{"x":'+"[".repeat(70)+'0'+"]".repeat(70)+'}');
 if(kind==="json-comments"){rmSync(join(f.home,base));f.file(".config/opencode/opencode.json",'{/*comment*/"provider":{}}');}
 if(kind==="oversized")f.file(base," ".repeat(4*1024*1024+1));
 const p=await f.service.preview({sources:["opencode"]});assert.equal(p.sources[0]!.status,"blocked",kind);assert.deepEqual(p.candidates,[],kind);assert.equal(f.values.size,0);}
});

test("OpenCode rejects unsupported provider, model and option semantics rather than silently losing configuration",async t=>{
 const mutations:Array<(c:any)=>void>=[c=>c.provider.relay.npm="@ai-sdk/openai",c=>c.provider.relay.options.headers={Authorization:"private-header-value"},c=>c.provider.relay.options.timeout=1000,c=>c.provider.relay.api="other",c=>c.provider.relay.models["model/b"].id="remapped",c=>c.provider.relay.models["model/b"].provider={npm:"@ai-sdk/anthropic"},c=>c.provider.relay.models["model/b"].limit={context:123},c=>c.provider.relay.models["model/b"].options={},c=>c.provider.relay.models=[],c=>c.provider.relay.models={},c=>c.model="relay/missing",c=>c.disabled_providers=["relay"],c=>c.enabled_providers=["other"]];
 for(const mutate of mutations){const f=fixture(t),config=openCode();mutate(config);f.file(".config/opencode/opencode.json",config);const p=await f.service.preview({sources:["opencode"]});assert.equal(p.candidates.length,1);assert.equal(p.candidates[0]!.importable,false);assert.doesNotMatch(JSON.stringify(p),/private-header-value|fixture-opencode-key/);await assert.rejects(f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]}));assert.equal(f.values.size,0);}
});

test("OpenCode does not expand file/environment/command references or read implicit environment",async t=>{
 for(const value of ["{env:MY_KEY}","{file:~/.private-key}","prefix-${KEY}","$(echo key)","`echo key`"]){for(const field of ["key","url","name","model"]){const f=fixture(t),config=openCode();if(field==="key")config.provider.relay.options.apiKey=value;if(field==="url")config.provider.relay.options.baseURL=`https://relay.invalid/${value}`;if(field==="name")config.provider.relay.name=value;if(field==="model")(config.provider.relay.models as any)[value]={};f.file(".config/opencode/opencode.json",config);f.environment.MY_KEY="must-not-resolve";
 const p=await f.service.preview({sources:["opencode"]});assert.equal(p.candidates[0]!.importable,false,`${field} ${value}`);assert.equal(f.counts().envReads,0);assert.doesNotMatch(JSON.stringify(p),/must-not-resolve/);}}
});

test("OpenCode source changes and second fixed file appearing invalidate preview before secret writes",async t=>{
 for(const kind of ["changed","second","removed"]){const f=fixture(t);const path=f.file(".config/opencode/opencode.json",openCode());const p=await f.service.preview({sources:["opencode"]});if(kind==="changed")f.file(".config/opencode/opencode.json",openCode("changed-fixture-key"));if(kind==="second")f.file(".config/opencode/opencode.jsonc",openCode());if(kind==="removed")rmSync(path);
 await assert.rejects(f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]}),/来源配置已变化/);assert.equal(f.counts().writes,0);}
});

test("OpenCode source changes while a credential write awaits roll back without persisting stale provider",async t=>{
 const f=fixture(t);f.file(".config/opencode/opencode.json",openCode());const p=await f.service.preview({sources:["opencode"]});f.secrets.set=async(slot,value)=>{f.values.set(slot,value);f.file(".config/opencode/opencode.json",openCode("changed-during-save"));};const result=await f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]});assert.equal(result.rolledBack,true);assert.equal(f.store.providers().length,0);assert.equal(f.values.size,0);
});

test("rollback preserves a concurrently edited earlier provider and its credentials after a later failure",async t=>{
 const f=fixture(t),config=openCode();(config.provider as any).second={...config.provider.relay,name:"Second",options:{...config.provider.relay.options,apiKey:"fixture-second-key"}};f.file(".config/opencode/opencode.json",config);const p=await f.service.preview({sources:["opencode"]});let count=0;const upsert=f.store.upsertProvider.bind(f.store);f.store.upsertProvider=provider=>{if(++count===2){const previous=f.store.providers()[0]!;upsert({...previous,name:"Concurrent user edit"});throw new Error("synthetic failure");}upsert(provider);};
 const result=await f.service.commit({previewId:p.previewId,chosen:p.candidates.map(c=>c.id)});assert.equal(result.rolledBack,false);assert.match(result.failed[0]!.reason,/未能确认/);assert.equal(f.store.providers().length,1);const kept=f.store.providers()[0]!;assert.equal(kept.name,"Concurrent user edit");assert.equal(f.values.get(kept.id),"fixture-opencode-key");assert.equal(f.values.size,1);
});

test("OpenCode does not resolve apiKey references even when environment scanning is separately authorized",async t=>{
 const f=fixture(t);f.file(".config/opencode/opencode.json",openCode("{env:OPENAI_API_KEY}"));f.environment.OPENAI_API_KEY="fixture-explicit-env-key";const p=await f.service.preview({sources:["opencode","environment"]});assert.equal(p.candidates.find(c=>c.source==="opencode")!.importable,false);assert.equal(p.candidates.find(c=>c.source==="environment")!.importable,true);assert.equal(f.counts().envReads,1);assert.doesNotMatch(JSON.stringify(p),/fixture-explicit-env-key/);
});


test("OpenCode invalid UTF-8 is rejected instead of rewriting key bytes with replacement characters",async t=>{
 const f=fixture(t),path=f.file(".config/opencode/opencode.json",openCode());const raw=Buffer.from(JSON.stringify(openCode())),at=raw.indexOf("fixture-opencode-key");raw[at]=0xff;writeFileSync(path,raw);const p=await f.service.preview({sources:["opencode"]});assert.equal(p.sources[0]!.status,"blocked");assert.deepEqual(p.candidates,[]);assert.equal(f.values.size,0);assert.equal(f.counts().writes,0);
});


test("all imported providers remain unpublished until every awaited secret write completes",async t=>{
 const f=fixture(t),config=openCode();(config.provider as any).second={...config.provider.relay,name:"Second",options:{...config.provider.relay.options,apiKey:"fixture-stage-second"}};f.file(".config/opencode/opencode.json",config);const p=await f.service.preview({sources:["opencode"]});let writes=0;f.secrets.set=async(slot,value)=>{f.values.set(slot,value);assert.equal(f.store.providers().length,0,"no partial rows during await");writes++;await Promise.resolve();assert.equal(f.store.providers().length,0);};
 const result=await f.service.commit({previewId:p.previewId,chosen:p.candidates.map(c=>c.id)});assert.equal(writes,2);assert.equal(result.imported.length,2);assert.equal(f.store.providers().length,2);
});

test("rollback preserves a credential whose application revision changed during awaited lookup",async t=>{
 const f=fixture(t);f.file(".config/opencode/opencode.json",openCode());const p=await f.service.preview({sources:["opencode"]});f.secrets.set=async(slot,value)=>{f.values.set(slot,value);throw new Error("synthetic write failure");};f.secrets.get=async slot=>{const old=f.values.get(slot);f.store.touchCredentialRevision(slot);f.values.set(slot,"concurrent-fixture-key");return old;};const result=await f.service.commit({previewId:p.previewId,chosen:[p.candidates[0]!.id]});assert.equal(result.rolledBack,false);assert.deepEqual([...f.values.values()],["concurrent-fixture-key"]);assert.equal(f.store.providers().length,0);assert.doesNotMatch(JSON.stringify(result),/concurrent-fixture-key/);
});
