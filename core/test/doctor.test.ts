import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDoctorReport, runDoctorChecks, validateDoctorChecks, DoctorCheckRequestError, type DoctorInput, type DoctorCheckRequest } from "../src/doctor.ts";
import { humanError } from "../src/user-errors.ts";

const NOW=Date.parse("2026-10-06T18:00:00.000Z");
const SECRET="DO_NOT_ECHO_FAKE_KEY_OR_TOKEN_42";
function input():DoctorInput {
  return {
    now:NOW,gateway:{reachable:true},helper:{backend:"native-keychain",ready:true,status:"helper_ready",keychainChecked:false},
    providers:[{id:"fixture-source",authKind:"key",probeAllowed:true,probe:{at:new Date(NOW-1000).toISOString(),checks:[{id:"chat",label:"Chat",status:"pass",detail:"cached fixture"}]}}],
    agents:[{id:"fixture-agent",installed:true,helpAllowed:true,help:{checkedAt:new Date(NOW-1000).toISOString(),verdicts:[{form:"interactive",helpOk:true,checked:["--model"],missing:[]}]}}],
    tokens:{storeAvailable:true,sessions:[{expiresAt:new Date(NOW+60_000).toISOString()}]},budget:{blocked:false},recentFailure:null,
  };
}
const providerRequest:DoctorCheckRequest={checks:[{kind:"provider",id:"fixture-source"}],acknowledgeSourceRequests:true};
const agentRequest:DoctorCheckRequest={checks:[{kind:"agent-help",id:"fixture-agent"}],acknowledgeCliExecution:true};

test("metadata diagnostics cover all seven areas, clearly distinguish past checks, and do no I/O",()=>{
  const data=input();
  Object.defineProperty(data,"secretStore",{get(){assert.fail("diagnostics must never access credentials");}});
  Object.defineProperty(data,"runAgent",{get(){assert.fail("diagnostics must never discover executable helpers");}});
  const report=buildDoctorReport(data);
  assert.deepEqual(report.findings.map(r=>r.area),["gateway","helper","provider","agent","tokens","budget","recent-failure"]);
  assert.equal(report.mode,"metadata"); assert.equal(report.checkedAt,new Date(NOW).toISOString());
  assert.equal(report.findings.find(r=>r.area==="provider")!.evidence,"saved-probe");
  assert.match(report.findings.find(r=>r.area==="provider")!.title,/上次/);
  assert.equal(report.findings.find(r=>r.area==="agent")!.evidence,"saved-help");
  assert.match(report.findings.find(r=>r.area==="agent")!.nextStep,/不能证明实际启动/);
  assert.equal(report.findings.find(r=>r.area==="tokens")!.status,"unchecked","registered metadata is not proof of a live client token");
  assert.match(report.notice,/不读密钥.*不运行 agent/);
});

test("five common faults have distinct actionable findings and shared human-error categories",()=>{
  const cases:Array<{edit:(d:DoctorInput)=>void;code:string;errorCode:string;action:string;advice:RegExp}>=[
    {edit:d=>{d.helper!.ready=false;d.helper!.status="helper_missing";},code:"helper_missing",errorCode:"keychain_unavailable",action:"open-helper-help",advice:/重新构建|修复/},
    {edit:d=>{d.providers![0]!.lastStatus=401;},code:"provider_auth_failed",errorCode:"source_auth_required",action:"open-providers",advice:/过期|权限|复制/},
    {edit:d=>{d.providers![0]!.off=true;},code:"source_disabled",errorCode:"source_disabled",action:"open-providers",advice:/开启/},
    {edit:d=>{d.budget!.blocked=true;},code:"budget_exceeded",errorCode:"budget_blocked",action:"open-budget",advice:/预算/},
    {edit:d=>{d.agents![0]!.installed=false;d.agents![0]!.required=true;},code:"agent_not_installed",errorCode:"client_not_installed",action:"open-agents",advice:/安装/},
  ];
  for(const c of cases) {
    const data=input();c.edit(data);const row=buildDoctorReport(data).findings.find(r=>r.code===c.code)!;
    assert.ok(row,c.code);assert.equal(row.errorCode,c.errorCode);assert.equal(row.message,humanError({code:c.errorCode}).reason);
    assert.ok(row.actions.some(a=>a.kind===c.action));assert.match(row.nextStep,c.advice);
    assert.ok(row.actions.every(a=>!a.kind.includes("execute") && !a.kind.includes("compile")),"repair suggestions never run a system change");
  }
});

test("arbitrary secret-shaped and opaque data in all diagnostics are never serialized",()=>{
  const data=input() as DoctorInput & Record<string,unknown>;
  data.token=SECRET;data.apiKey=SECRET;data.environment={secret:SECRET};
  Object.assign(data.helper!,{message:SECRET,error:SECRET});
  Object.assign(data.providers![0]!,{name:SECRET,baseUrl:`https://${SECRET}.invalid`,apiKey:SECRET});
  data.providers![0]!.probe!.checks[0]!.detail=SECRET;data.providers![0]!.probe!.checks[0]!.label=SECRET;
  Object.assign(data.agents![0]!,{name:SECRET,where:`/${SECRET}/bin`});
  data.agents![0]!.help!.verdicts[0]!.error=SECRET;data.agents![0]!.help!.verdicts[0]!.missing=[SECRET];
  Object.assign(data.tokens!.sessions![0]!,{token:SECRET,hash:SECRET,id:SECRET});
  data.recentFailure={status:401,code:SECRET,at:SECRET};Object.assign(data.recentFailure,{message:SECRET,note:SECRET,body:SECRET});
  const json=JSON.stringify(buildDoctorReport(data));assert.ok(!json.includes(SECRET));assert.ok(!json.includes("https://"));
  assert.equal(buildDoctorReport(data).findings.at(-1)!.errorCode,"source_auth_required");
});

test("missing data, unknown installation and memory storage stay explicitly unverified",()=>{
  const data=input();data.helper=null;data.providers=[];data.agents=[{id:"fixture-agent",installed:null}];data.tokens=undefined;data.budget=undefined;
  const report=buildDoctorReport(data);assert.equal(report.findings.find(r=>r.area==="agent")!.code,"agent_not_checked");
  for(const area of ["helper","provider","agent","tokens","budget"]) assert.equal(report.findings.find(r=>r.area===area)!.status,"unchecked");
  data.helper={backend:"memory",ready:true,status:"ready",keychainChecked:false};
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="helper")!.code,"helper_memory_only");
});

test("a cold passive helper signature is unchecked, never failed or ready, and cannot authorize a probe",async()=>{
  const data=input();data.helper={backend:"native-keychain",ready:false,status:"helper_signature_unchecked",keychainChecked:false,message:SECRET};
  const row=buildDoctorReport(data).findings.find(r=>r.area==="helper")!;
  assert.equal(row.code,"helper_signature_unchecked");assert.equal(row.status,"unchecked");assert.equal(row.errorCode,undefined);
  assert.match(row.message,/没有运行签名检查/);assert.match(row.nextStep,/前台.*启动或检查.*重新自检/);
  assert.equal(row.actions[0]!.kind,"open-helper-help");assert.ok(!JSON.stringify(row).includes(SECRET));
  await assert.rejects(runDoctorChecks(data,providerRequest,{probeProvider:async()=>{assert.fail("an unchecked helper must not permit key access");}}),e=>e instanceof DoctorCheckRequestError && e.code==="keychain_unavailable");
});

test("token storage, selected-token validity, expiry and budget accounting faults are separate",()=>{
  const data=input();data.tokens!.storeAvailable=false;
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="tokens")!.code,"gateway_session_storage_unavailable");
  data.tokens!.storeAvailable=true;data.tokens!.current="invalid";
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="tokens")!.errorCode,"session_invalid");
  data.tokens!.current="valid";
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="tokens")!.code,"gateway_session_valid");
  data.tokens!.sessions=[{expiresAt:new Date(NOW).toISOString()}];
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="tokens")!.code,"gateway_session_expired");
  data.budget={blocked:true,accountingUnavailable:true};
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="budget")!.code,"budget_accounting_unavailable");
  data.budget={blocked:true,configurationInvalid:true};
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="budget")!.code,"budget_configuration_invalid");
});

test("partial protocol support is distinct from total failure, and model listing alone is not connectivity",()=>{
  const data=input();data.providers![0]!.probe!.checks.push({id:"responses",status:"fail",label:SECRET,detail:SECRET});
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="provider")!.code,"source_probe_partial");
  data.providers![0]!.probe!.checks[0]!.status="fail";
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="provider")!.code,"source_probe_failed");
  data.providers![0]!.probe!.checks=[{id:"models",status:"pass",label:SECRET,detail:SECRET}];
  assert.equal(buildDoctorReport(data).findings.find(r=>r.area==="provider")!.code,"source_not_checked");
});

test("saved stale Messages routes add independent read-only guidance without hiding source faults",()=>{
  const data=input();const provider=data.providers![0]!;
  provider.off=true;provider.endpoints={baseUrl:"https://api.deepseek.com",anthropicBaseUrl:"https://api.deepseek.com/anthropic"};
  const before=JSON.stringify(data);const report=buildDoctorReport(data);
  assert.ok(report.findings.some(r=>r.code==="source_disabled"));
  const row=report.findings.find(r=>r.code==="source_messages_endpoint_stale")!;
  assert.equal(row.status,"warn");assert.equal(row.evidence,"metadata");assert.equal(row.targetId,"fixture-source");
  assert.match(row.message,/https:\/\/api\.deepseek\.com\/anthropic\/v1\/messages/);
  assert.match(row.nextStep,/anthropicBaseUrl.*https:\/\/api\.deepseek\.com\/anthropic\/v1/);
  assert.match(row.nextStep,/此地址检查没有修改.*没有为检查地址发送请求/);
  assert.deepEqual(row.actions,[{kind:"open-providers",label:"查看来源配置",targetId:"fixture-source"}]);
  assert.equal(JSON.stringify(data),before);
  provider.endpoints.wire={paths:{messages:"v1/messages"}};
  assert.ok(!buildDoctorReport(data).findings.some(r=>r.code==="source_messages_endpoint_stale"));
  provider.endpoints.wire.paths!.messages="messages";
  assert.match(buildDoctorReport(data).findings.find(r=>r.code==="source_messages_endpoint_stale")!.nextStep,/删除 wire\.paths\.messages.*设为 messages/);
});

test("active provider success or failure never reclassifies or replaces endpoint metadata warnings",async()=>{
  for(const fail of [false,true]) {
    const data=input();data.providers![0]!.endpoints={baseUrl:"https://api.deepseek.com/anthropic"};
    const report=await runDoctorChecks(data,providerRequest,{probeProvider:async()=>{if(fail)throw new Error(SECRET);return {probe:data.providers![0]!.probe!};}});
    const rows=report.findings.filter(r=>r.area==="provider");assert.equal(rows.length,2);
    assert.equal(rows[0]!.code,fail ? "diagnostic_failed" : "source_probe_passed");
    assert.equal(rows[1]!.code,"source_messages_endpoint_stale");assert.equal(rows[1]!.evidence,"metadata");assert.equal(rows[1]!.checkedAt,undefined);
    assert.doesNotMatch(JSON.stringify(rows),new RegExp(SECRET));
  }
});

test("SDK-derived subscription warnings disclose derivation and shared Zhipu routes produce one warning",()=>{
  for (const baseUrl of ["https://api.z.ai/api/anthropic","https://ark.cn-beijing.volces.com/api/coding"]) {
    const data=input();data.providers![0]!.endpoints={baseUrl};
    const row=buildDoctorReport(data).findings.find(r=>r.code==="source_messages_endpoint_stale")!;
    assert.equal(row.evidence,"metadata");assert.match(row.message,/官方客户端根地址及 SDK 路径推导/);
    assert.doesNotMatch(row.message,/已核实的官方地址/);
  }
  const data=input();data.providers![0]!.endpoints={baseUrl:"https://open.bigmodel.cn/api/coding/paas/v4",anthropicBaseUrl:"https://open.bigmodel.cn/api/anthropic"};
  const rows=buildDoctorReport(data).findings.filter(r=>r.code==="source_messages_endpoint_stale");
  assert.equal(rows.length,1);assert.match(rows[0]!.message,/智谱 GLM.*已核实的官方地址/);assert.doesNotMatch(rows[0]!.message,/开放平台/);
});

test("endpoint warnings obey the provider inventory limit",()=>{
  const data=input();data.providers=Array.from({length:201},(_,i)=>({id:`source-${i}`,endpoints:{baseUrl:"https://api.deepseek.com/anthropic"}}));
  const report=buildDoctorReport(data);assert.equal(report.findings.filter(r=>r.code==="source_messages_endpoint_stale").length,200);
  assert.ok(report.findings.some(r=>r.code==="source_inventory_truncated"));assert.ok(!report.findings.some(r=>r.targetId==="source-200"));
});

test("only explicit selected and acknowledged checks validate, with no duplicate or unbounded batches",()=>{
  const data=input();assert.deepEqual(validateDoctorChecks(data,providerRequest),providerRequest);
  const bad:unknown[]=[undefined,{},[],{checks:[]},{checks:providerRequest.checks},{checks:agentRequest.checks},
    {...providerRequest,secret:SECRET},{...providerRequest,acknowledgeSourceRequests:false},
    {...providerRequest,checks:[...providerRequest.checks,...providerRequest.checks]},
    {...providerRequest,checks:[{kind:"provider",id:"missing"}]},
    {...providerRequest,checks:[{kind:"provider",id:"fixture-source",command:"execute"}]},
    {...providerRequest,checks:Array.from({length:9},()=>providerRequest.checks[0])}];
  for(const value of bad) assert.throws(()=>validateDoctorChecks(data,value),DoctorCheckRequestError);
});

test("off sources, stop budgets, helper failures and uninstalled agents cannot run active checks",async()=>{
  const cases:Array<{edit:(d:DoctorInput)=>void;request:DoctorCheckRequest;code:string}>=[
    {edit:d=>{d.gateway.reachable=null;},request:providerRequest,code:"service_unavailable"},
    {edit:d=>{d.providers![0]!.off=true;},request:providerRequest,code:"source_disabled"},
    {edit:d=>{d.budget!.probeBlocked=true;},request:providerRequest,code:"budget_blocked"},
    {edit:d=>{d.budget=undefined;},request:providerRequest,code:"budget_blocked"},
    {edit:d=>{d.providers![0]!.budgetBlocked=true;},request:providerRequest,code:"budget_blocked"},
    {edit:d=>{d.helper!.ready=false;},request:providerRequest,code:"keychain_unavailable"},
    {edit:d=>{d.providers![0]!.probeAllowed=false;},request:providerRequest,code:"capability_unavailable"},
    {edit:d=>{d.agents![0]!.installed=false;},request:agentRequest,code:"client_not_installed"},
    {edit:d=>{d.agents![0]!.helpAllowed=false;},request:agentRequest,code:"capability_unavailable"},
  ];
  for(const c of cases){const data=input();c.edit(data);await assert.rejects(runDoctorChecks(data,c.request,{probeProvider:async()=>{assert.fail("must not probe");},checkAgentHelp:async()=>{assert.fail("must not execute");}}),e=>e instanceof DoctorCheckRequestError && e.code===c.code);}
});

test("the complete batch is validated before any runner and no default runner exists",async()=>{
  const data=input();let calls=0;
  await assert.rejects(runDoctorChecks(data,{...providerRequest,checks:[providerRequest.checks[0],{kind:"provider",id:"missing"}]},{probeProvider:async()=>{calls++;return {probe:data.providers![0]!.probe!};}}),DoctorCheckRequestError);
  assert.equal(calls,0);await assert.rejects(runDoctorChecks(data,providerRequest),e=>e instanceof DoctorCheckRequestError && e.code==="capability_unavailable");
});

test("explicit fake checks run in selection order, refresh only their evidence, and do not mutate input",async()=>{
  const data=input();data.providers![0]!.lastStatus=401;const before=JSON.stringify(data);const calls:string[]=[];
  const report=await runDoctorChecks(data,{checks:[...agentRequest.checks,...providerRequest.checks],acknowledgeSourceRequests:true,acknowledgeCliExecution:true},{
    checkAgentHelp:async(id,{signal})=>{calls.push(id);assert.equal(signal.aborted,false);return {verdicts:[{form:"interactive",helpOk:true,checked:[SECRET],missing:[]}]};},
    probeProvider:async(id,{signal})=>{calls.push(id);assert.equal(signal.aborted,false);return {probe:{at:new Date(NOW).toISOString(),checks:[{id:"chat",status:"pass",detail:SECRET,label:SECRET}]}};},
  });
  assert.deepEqual(calls,["fixture-agent","fixture-source"]);assert.equal(JSON.stringify(data),before);assert.equal(report.mode,"active");
  assert.equal(report.findings.find(r=>r.area==="agent")!.evidence,"active-help");
  const source=report.findings.find(r=>r.area==="provider")!;assert.equal(source.evidence,"active-probe");assert.equal(source.code,"source_probe_passed");assert.match(source.title,/此次/);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test("runner errors are fixed-language findings and a later independent check can finish",async()=>{
  const data=input();let helped=false;
  const report=await runDoctorChecks(data,{checks:[...providerRequest.checks,...agentRequest.checks],acknowledgeSourceRequests:true,acknowledgeCliExecution:true},{probeProvider:async()=>{throw new Error(SECRET);},checkAgentHelp:async()=>{helped=true;return data.agents![0]!.help!;}});
  assert.equal(helped,true);assert.equal(report.findings.find(r=>r.area==="provider")!.code,"diagnostic_failed");assert.ok(!JSON.stringify(report).includes(SECRET));
});

test("timeout aborts the selected fake runner and never starts subsequent work",async()=>{
  const data=input();let aborted=false;let helped=false;
  const report=await runDoctorChecks(data,{checks:[...providerRequest.checks,...agentRequest.checks],acknowledgeSourceRequests:true,acknowledgeCliExecution:true},{timeoutMs:5,probeProvider:async(_id,{signal})=>{signal.addEventListener("abort",()=>{aborted=true;});return new Promise(()=>{});},checkAgentHelp:async()=>{helped=true;return data.agents![0]!.help!;}});
  assert.equal(aborted,true);assert.equal(helped,false);
  assert.equal(report.findings.find(r=>r.area==="provider")!.code,"diagnostic_timeout");
  assert.equal(report.findings.find(r=>r.area==="agent")!.code,"diagnostic_not_run");
});

test("request cancellation reaches an active runner without leaking its late result",async()=>{
  const data=input();const controller=new AbortController();let started!:()=>void;const ready=new Promise<void>(r=>{started=r;});let released!:()=>void;
  const pending=runDoctorChecks(data,providerRequest,{signal:controller.signal,probeProvider:async(_id,{signal})=>{started();await new Promise<void>(r=>{released=r;});assert.equal(signal.aborted,true);return {probe:data.providers![0]!.probe!};}});
  await ready;controller.abort();const report=await pending;released();
  assert.equal(report.findings.find(r=>r.area==="provider")!.code,"diagnostic_cancelled");
});
