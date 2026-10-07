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
