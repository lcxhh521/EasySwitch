/** Explicit, read-only migration of API-key providers. No native-login readers or upstream probes. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Provider, ApiProtocol } from "./types.ts";
import type { Store } from "./store.ts";
import type { SecretStore } from "./secrets.ts";

export const IMPORT_SOURCES = ["cc-switch", "opencodex", "environment", "codex", "claude"] as const;
export type ImportSource = typeof IMPORT_SOURCES[number];
export interface ImportCandidate { id: string; source: ImportSource; name: string; baseUrl: string; models: string[]; defaultModel?: string; keyCount: number; importable: boolean; reason?: string }
export interface ImportPreview { previewId: string; candidates: ImportCandidate[]; sources: Array<{ source: ImportSource; status: "ready" | "missing" | "blocked"; message: string }> }
export interface ProviderImportDeps { home: string; environment: () => Record<string, string | undefined>; store: Pick<Store, "providers" | "provider" | "upsertProvider" | "removeProvider">; secrets: SecretStore; now?: () => number }
export interface ProviderImportResult { imported: Array<{ candidateId: string; providerId: string }>; failed: Array<{ candidateId: string; reason: string }>; rolledBack: boolean }
export class ProviderImportError extends Error { readonly code = "invalid_input"; readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }
type Json = Record<string, unknown>;
type Raw = { source: ImportSource; name: unknown; baseUrl: unknown; models: unknown; keys: string[]; protocol: ApiProtocol; reason?: string };
type Saved = { public: ImportCandidate; keys: string[]; protocol: ApiProtocol };
const FILE_LIMIT = 4 * 1024 * 1024, DB_LIMIT = 32 * 1024 * 1024, MAX_CANDIDATES = 200;
const TTL = 10 * 60_000;
const obj = (v: unknown): Json => v && typeof v === "object" && !Array.isArray(v) ? v as Json : {};
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const digest = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const fail = () => new ProviderImportError("配置格式不支持或不安全，请检查来源设置后重试。");
const keyValue = (v: unknown): string[] => typeof v === "string" && v.length > 0 ? [v] : [];
const usableKey = (v: string) => v.length <= 16_384 && !/[\s\0]/.test(v) && !/^(?:es-session-|sk-ant-oat|gho_|ghu_|ghr_)/.test(v) && !/^\$\{|^\$\(|^`/.test(v);
const PATHS: Record<Exclude<ImportSource,"environment">,string> = { "cc-switch": ".cc-switch/cc-switch.db", opencodex: ".opencodex/config.json", codex: ".codex/config.toml", claude: ".claude/settings.json" };
const ENV = [
  { key: "OPENAI_API_KEY", base: "OPENAI_BASE_URL", url: "https://api.openai.com/v1", model: "OPENAI_MODEL", name: "OpenAI", protocol: "responses" },
  { key: "ANTHROPIC_API_KEY", base: "ANTHROPIC_BASE_URL", url: "https://api.anthropic.com", model: "ANTHROPIC_MODEL", name: "Anthropic", protocol: "messages" },
  { key: "DEEPSEEK_API_KEY", base: "DEEPSEEK_BASE_URL", url: "https://api.deepseek.com", model: "DEEPSEEK_MODEL", name: "DeepSeek", protocol: "chat" },
  { key: "OPENROUTER_API_KEY", base: "OPENROUTER_BASE_URL", url: "https://openrouter.ai/api/v1", model: "OPENROUTER_MODEL", name: "OpenRouter", protocol: "chat" },
] as const;

/** Validate each component and the opened inode before reading. Hard links and special files are rejected. */
function checkedPath(home: string, tail: string): { path: string; stat: Stats } {
  if (!isAbsolute(home)) throw fail();
  const root = resolve(home), path = resolve(root, tail), rel = relative(root,path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw fail();
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep)) { current = join(current,part); const s=lstatSync(current); if(s.isSymbolicLink()) throw fail(); }
  if(realpathSync(path)!==path) throw fail();
  const stat=lstatSync(path); if(!stat.isFile() || stat.nlink!==1) throw fail();
  return {path,stat};
}
function safeRead(home:string, tail:string, limit=FILE_LIMIT): { bytes:Buffer; path:string; stamp:string } {
  const {path,stat}=checkedPath(home,tail); if(stat.size>limit) throw fail();
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened=fstatSync(fd); if(opened.dev!==stat.dev||opened.ino!==stat.ino||opened.size>limit||!opened.isFile()||opened.nlink!==1) throw fail();
    checkedPath(home,tail);
    const bytes=readFileSync(fd); const after=fstatSync(fd);
    if(bytes.length>limit||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs) throw fail();
    return {bytes,path,stamp:`${opened.dev}:${opened.ino}:${opened.size}:${opened.mtimeMs}:${opened.ctimeMs}:${digest(bytes)}`};
  } finally {closeSync(fd);}
}
function jsonFile(text:string): Json { const value=JSON.parse(text);if(!value||typeof value!=="object"||Array.isArray(value))throw fail();return value; }

/** Deliberately bounded TOML subset: standard scalar custom-provider tables, never eval or shell expansion. */
function tomlConfig(text:string): { root:Json; providers:Map<string,Json> } {
  const root:Json={},providers=new Map<string,Json>();let target:Json|undefined=root;
  for(const original of text.split(/\r?\n/)) {
    let line="",quote="",escaped=false;
    for(const char of original){if(!quote&&char==="#")break;line+=char;if(escaped){escaped=false;continue;}if(quote==='"'&&char==='\\'){escaped=true;continue;}if(quote){if(char===quote)quote="";}else if(char==='"'||char==="'")quote=char;}
    line=line.trim();if(!line)continue;
    if(line.startsWith("[")) {
      const header=/^\[([^\[\]]+)\]$/.exec(line);if(!header){target=undefined;continue;}
      const pieces=header[1]!.match(/"[^"\\]*"|'[^']*'|[a-zA-Z0-9_-]+/g)??[];
      if(pieces.map(p=>p).join(".").replace(/\s/g,"")!==header[1]!.replace(/\s/g,""))throw fail();
      const names=pieces.map(p=>p.replace(/^["']|["']$/g,""));
      if(names[0]==="model_providers"&&names[1]){
        const id=names[1];if(!/^[a-zA-Z0-9_-]{1,80}$/.test(id))throw fail();
        if(names.length===2){if(providers.has(id))throw fail();target={};providers.set(id,target);}
        else{const p=providers.get(id)??{};p.unsupported=true;providers.set(id,p);target=undefined;}
      }else target=undefined;
      continue;
    }
    if(!target)continue;
    const assignment=/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);if(!assignment)throw fail();
    const [,key,value]=assignment;
    const wanted=target===root?["model","model_provider"]:["name","base_url","env_key","experimental_bearer_token","requires_openai_auth","wire_api","http_headers","env_http_headers","query_params","auth"];
    if(!wanted.includes(key!))continue;
    if(Object.hasOwn(target,key!))throw fail();
    if(["http_headers","env_http_headers","query_params","auth"].includes(key!)){target.unsupported=true;continue;}
    if(value==="true"||value==="false")target[key!]=value==="true";
    else if(value!.startsWith('"')) {try{const parsed=JSON.parse(value!);if(typeof parsed!=="string")throw fail();target[key!]=parsed;}catch{throw fail();}}
    else if(/^'[^']*'$/.test(value!))target[key!]=value!.slice(1,-1);
    else throw fail();
  }
  return {root,providers};
}
function codexRows(text:string,source:ImportSource,env:(name:string)=>string|undefined,authKey?:unknown,name?:unknown):Raw[] {
  const {root,providers}=tomlConfig(text); const out:Raw[]=[];
  for(const [id,p] of providers){
    const referenced=typeof p.env_key==="string"&&/^[A-Z][A-Z0-9_]{0,79}$/.test(p.env_key)?env(p.env_key):undefined;
    const keys=keyValue(p.experimental_bearer_token??referenced??authKey);
    const native=["openai","ollama","lmstudio","amazon-bedrock"].includes(id)||p.requires_openai_auth===true&&!authKey;
    out.push({source,name:name??p.name??id,baseUrl:p.base_url,models:root.model_provider===id&&typeof root.model==="string"?[root.model]:[],keys,protocol:"responses",
      ...(native?{reason:"原生登录或内置来源不导入。"}:p.unsupported||p.wire_api!==undefined&&p.wire_api!=="responses"?{reason:"此配置需要额外鉴权、请求头或未支持的协议，请手动添加。"}: {})});
  }
  return out;
}
function claudeRow(settings:Json,source:ImportSource,name:unknown="Claude 自定义来源"):Raw {
  const env=obj(settings.env);const keys=[...keyValue(env.ANTHROPIC_API_KEY),...keyValue(env.ANTHROPIC_AUTH_TOKEN)];
  const models=[settings.model,env.ANTHROPIC_MODEL,env.ANTHROPIC_DEFAULT_SONNET_MODEL,env.ANTHROPIC_DEFAULT_OPUS_MODEL,env.ANTHROPIC_DEFAULT_HAIKU_MODEL].filter((v):v is string=>typeof v==="string");
  return {source,name,baseUrl:env.ANTHROPIC_BASE_URL,models,keys,protocol:"messages",...(keys.length>1&&new Set(keys).size>1?{reason:"同时配置了不同的密钥和令牌，请先明确使用哪一种。"}:settings.apiKeyHelper||env.CLAUDE_CODE_USE_BEDROCK||env.CLAUDE_CODE_USE_VERTEX||env.ANTHROPIC_CUSTOM_HEADERS?{reason:"此配置使用命令或专用鉴权，请手动添加。"}:{})};
}
function opencodexRows(config:Json):Raw[] {
  return Object.entries(obj(config.providers)).slice(0,MAX_CANDIDATES+1).map(([id,value])=>{
    const p=obj(value),pool=Array.isArray(p.apiKeyPool)?p.apiKeyPool:[];
    const protocol:ApiProtocol=["anthropic","claude","anthropic-chat"].includes(String(p.adapter))?"messages":p.adapter==="openai-responses"?"responses":"chat";
    return {source:"opencodex",name:obj(obj(config.providers_meta)[id]).name??id,baseUrl:p.baseUrl,models:[...keyValue(p.defaultModel),...strings(p.models)],keys:[...keyValue(p.apiKey),...pool.flatMap(k=>keyValue(obj(k).key))],protocol,
      ...(p.authMode!==undefined&&p.authMode!=="key"?{reason:"原生订阅透传或未知鉴权来源不导入。"}:p.adapter!==undefined&&!["openai-chat","openai-responses","anthropic","claude","anthropic-chat"].includes(String(p.adapter))?{reason:"此适配器格式尚未支持，请手动添加。"}:Object.keys(obj(p.headers)).length?{reason:"此来源带额外请求头，请手动核对后添加。"}:{})};
  });
}
function ccRows(home:string):{rows:Raw[];stamp:string} {
  const tail=PATHS["cc-switch"],before=safeRead(home,tail,DB_LIMIT);
  for(const suffix of ["-wal","-shm","-journal"]){try{lstatSync(before.path+suffix);throw fail();}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw fail();}}
  const uri=pathToFileURL(before.path);uri.search="?mode=ro&immutable=1";
  const db=new DatabaseSync(uri.href,{readOnly:true,enableForeignKeyConstraints:false,enableDoubleQuotedStringLiterals:false,allowExtension:false});
  const rows:Raw[]=[];
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    const table=db.prepare("SELECT type FROM sqlite_schema WHERE name='providers'").get();if(table?.type!=="table")throw fail();
    const data=db.prepare("SELECT id, app_type, name, settings_config FROM providers LIMIT 201").all();if(data.length>MAX_CANDIDATES)throw fail();
    for(const row of data){
      if(typeof row.settings_config!=="string"||row.settings_config.length>FILE_LIMIT)throw fail();
      if(row.app_type!=="claude"&&row.app_type!=="codex"){rows.push({source:"cc-switch",name:row.name,baseUrl:"",models:[],keys:[],protocol:"chat",reason:"此工具的配置格式尚未支持。"});continue;}
      const config=jsonFile(row.settings_config);
      if(row.app_type==="claude")rows.push(claudeRow(config,"cc-switch",row.name));
      else if(typeof config.config==="string")rows.push(...codexRows(config.config,"cc-switch",()=>undefined,obj(config.auth).OPENAI_API_KEY,row.name));
      else rows.push({source:"cc-switch",name:row.name,baseUrl:"",models:[],keys:[],protocol:"responses",reason:"没有可导入的自定义 API Key 来源。"});
    }
  }finally{db.close();}
  if(safeRead(home,tail,DB_LIMIT).stamp!==before.stamp)throw fail();
  return {rows,stamp:before.stamp};
}
function prepare(raw:Raw,allKeys:string[]):Saved {
  const keys=[...new Set(raw.keys)].slice(0,32);let reason=raw.reason;
  const name=typeof raw.name==="string"?raw.name.trim():"";
  const models=[...new Set(strings(raw.models))];let base="";
  try {const url=new URL(String(raw.baseUrl));if(!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw fail();base=url.href.replace(/\/chat\/completions\/?$/,"").replace(/\/+$/,"");}catch{reason??="地址缺失或含不安全的鉴权参数，请手动核对。";}
  if(!keys.length)reason??="没有静态 API Key；环境变量引用需另行勾选环境变量来源。";
  if(keys.some(k=>!usableKey(k))||raw.keys.length>32)reason??="密钥形式不支持，或属于原生会话凭据。";
  const metadata=[name,base,...models].flatMap(value=>{try{return [value,decodeURIComponent(value)];}catch{return [value];}});
  const leaked=metadata.some(value=>allKeys.some(k=>k&&value.includes(k))||/(?:sk-|gho_|es-session-)[A-Za-z0-9_-]{8,}/.test(value));
  if(leaked)reason="名称、地址或模型中包含密钥，已隐藏此配置，请先修正来源。";
  if(name.length>160||/[\r\n\0]/.test(name)||models.length>200||models.some(m=>m.length>192||!m.trim()||/[\s\0]/.test(m)))reason??="名称或模型格式不支持，请手动核对。";
  return {public:{id:randomUUID(),source:raw.source,name:leaked?"已隐藏的配置项":name.slice(0,160)||"未命名来源",baseUrl:leaked?"":base,models:leaked?[]:models.slice(0,200),...(!leaked&&models[0]?{defaultModel:models[0]}:{}),keyCount:keys.length,importable:!reason,...(reason?{reason}:{})},keys,protocol:raw.protocol};
}

export class ProviderImportService {
  #deps:ProviderImportDeps; #previews=new Map<string,{expires:number;sources:ImportSource[];fingerprint:string;candidates:Array<Omit<Saved,"keys">>}>(); #busy=false;
  constructor(deps:ProviderImportDeps){this.#deps=deps;}
  #scan(sources:ImportSource[]){
    const raw:Raw[]=[],reports:ImportPreview["sources"]=[],stamps:unknown[]=[];const usedEnv:Record<string,string|undefined>={};
    let environment:Record<string,string|undefined>|undefined;
    try { environment=sources.includes("environment")?this.#deps.environment():undefined; } catch { throw new ProviderImportError("环境变量暂时无法安全读取，请稍后再试。"); }
    const env=(name:string)=>{if(!environment)return undefined;const value=environment[name];usedEnv[name]=value;return value;};
    for(const source of sources){try{
      if(source==="environment") {for(const entry of ENV){const key=env(entry.key);if(key)raw.push({source,name:entry.name,baseUrl:env(entry.base)??entry.url,models:keyValue(env(entry.model)),keys:[key],protocol:entry.protocol});}}
      else if(source==="cc-switch"){const cc=ccRows(this.#deps.home);raw.push(...cc.rows);stamps.push([source,cc.stamp]);}
      else {const file=safeRead(this.#deps.home,PATHS[source]);stamps.push([source,file.stamp]);const text=file.bytes.toString("utf8");
        if(source==="opencodex")raw.push(...opencodexRows(jsonFile(text)));
        else if(source==="codex")raw.push(...codexRows(text,source,env));
        else raw.push(claudeRow(jsonFile(text),source));}
      reports.push({source,status:"ready",message:"只读扫描完成；尚未导入或检测模型。"});
    }catch(error){const missing=(error as NodeJS.ErrnoException).code==="ENOENT";reports.push({source,status:missing?"missing":"blocked",message:missing?"默认位置没有配置文件。":"配置无法安全读取或格式不支持；请退出来源工具后检查固定位置，再重试。"});stamps.push([source,"blocked"]);}}
    if(raw.length>MAX_CANDIDATES)throw new ProviderImportError("发现的来源过多，请分别选择工具扫描。");
    const allKeys=raw.flatMap(r=>r.keys);if(allKeys.reduce((n,k)=>n+Buffer.byteLength(k),0)>1_048_576)throw new ProviderImportError("密钥配置过大，请分别选择工具扫描。");return {reports,candidates:raw.map(r=>prepare(r,allKeys)),fingerprint:digest(JSON.stringify([stamps,usedEnv]))};
  }
  async preview(value:{sources:ImportSource[]}):Promise<ImportPreview>{
    if(!value||Object.keys(value).some(k=>k!=="sources")||!Array.isArray(value.sources)||value.sources.some(s=>!IMPORT_SOURCES.includes(s))||new Set(value.sources).size!==value.sources.length)throw fail();
    const now=this.#deps.now?.()??Date.now();for(const [id,p]of this.#previews)if(p.expires<=now)this.#previews.delete(id);
    if(this.#previews.size>=16)this.#previews.delete(this.#previews.keys().next().value!);
    const sources=[...value.sources],scan=this.#scan(sources),previewId=randomUUID();
    this.#previews.set(previewId,{expires:now+TTL,sources,fingerprint:scan.fingerprint,candidates:scan.candidates.map(c=>({public:c.public,protocol:c.protocol}))});
    return {previewId,candidates:scan.candidates.map(c=>structuredClone(c.public)),sources:scan.reports};
  }
  async commit(value:{previewId:string;chosen:string[]}):Promise<ProviderImportResult>{
    if(!value||Object.keys(value).some(k=>!["previewId","chosen"].includes(k))||typeof value.previewId!=="string"||!Array.isArray(value.chosen)||value.chosen.some(id=>typeof id!=="string")||new Set(value.chosen).size!==value.chosen.length)throw fail();
    if(!value.chosen.length)return {imported:[],failed:[],rolledBack:false};
    const preview=this.#previews.get(value.previewId),now=this.#deps.now?.()??Date.now();if(!preview||preview.expires<=now)throw new ProviderImportError("预览已失效，请重新扫描并选择。",409);
    if(this.#busy)throw new ProviderImportError("另一项导入正在保存，请稍后再试。",409);
    const indices=value.chosen.map(id=>preview.candidates.findIndex(c=>c.public.id===id));if(indices.some(i=>!preview.candidates[i]?.public.importable))throw new ProviderImportError("选择中有不可导入的来源，请重新选择。");
    const fresh=this.#scan(preview.sources);
    if(fresh.fingerprint!==preview.fingerprint||indices.some(i=>!fresh.candidates[i]?.public.importable))throw new ProviderImportError("来源配置已变化，请重新预览后再导入。",409);
    const selected=indices.map(i=>({...fresh.candidates[i]!,public:preview.candidates[i]!.public}));
    this.#previews.delete(value.previewId);this.#busy=true;
    const created:string[]=[],written:string[]=[],imported:ProviderImportResult["imported"]=[];
    try {
      for(const candidate of selected as Saved[]){
        const c=candidate.public,id=`import-${randomUUID()}`;if(this.#deps.store.provider(id))throw fail();
        const p:Provider={id,name:c.name,baseUrl:c.baseUrl,models:c.models,...(c.defaultModel?{defaultModel:c.defaultModel}:{}),protocols:[candidate.protocol],route:candidate.protocol==="responses"?"responses-native":"chat-translate",routePinned:true,streamUsage:true,off:true,createdAt:new Date(now).toISOString(),...(candidate.protocol==="messages"?{anthropicBaseUrl:c.baseUrl,messagesRoute:"anthropic-native"}:{})};
        // Retain the primary slot for console compatibility; every pool key has fresh metadata and a fresh slot.
        written.push(id);await this.#deps.secrets.set(id,candidate.keys[0]!);
        if(candidate.keys.length>1){p.keys=[];for(const [index,key]of candidate.keys.entries()){const kid=`k-${randomUUID()}`,slot=`${id}#${kid}`;written.push(slot);await this.#deps.secrets.set(slot,key);p.keys.push({id:kid,label:`导入密钥 ${index+1}`,enabled:true,addedAt:p.createdAt});}}
        created.push(id);this.#deps.store.upsertProvider(p);imported.push({candidateId:c.id,providerId:id});
      }
      return {imported,failed:[],rolledBack:false};
    }catch{
      let complete=true;
      for(const id of created.reverse())try{this.#deps.store.removeProvider(id);}catch{complete=false;}
      for(const key of written.reverse())try{await this.#deps.secrets.delete(key);}catch{complete=false;}
      return {imported:[],failed:value.chosen.map(candidateId=>({candidateId,reason:complete?"保存失败，本次新增来源和密钥已回滚。":"保存失败，部分清理未能确认；请在来源页和钥匙串检查本次新增项。"})),rolledBack:complete};
    }finally{this.#busy=false;}
  }
}
