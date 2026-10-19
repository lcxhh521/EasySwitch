import type { SecretStoreHealth } from "./secrets.ts";
import type { ProbeReport } from "./types.ts";
import type { Verdict } from "./verify-launchers.ts";
import { humanError } from "./user-errors.ts";
import { diagnoseMessagesEndpoint, type ProviderEndpointMetadata } from "./endpoint-diagnostics.ts";

/** Diagnostics consume metadata only. No filesystem, credential store, process, or network imports. */
export type DoctorStatus = "ok" | "warn" | "error" | "unchecked";
export type DoctorArea = "gateway" | "helper" | "provider" | "agent" | "tokens" | "budget" | "recent-failure";
export type DoctorActionKind = "open-providers" | "open-agents" | "open-sessions" | "open-budget" | "open-helper-help" | "open-login" | "probe-provider" | "check-agent-help" | "refresh-doctor";
export interface DoctorAction { kind: DoctorActionKind; label: string; targetId?: string; requiresConfirmation?: boolean }
export interface DoctorFinding {
  code: string;
  /** Shared user-facing error category, when this row represents a known failure. */
  errorCode?: string;
  area: DoctorArea;
  status: DoctorStatus;
  title: string;
  message: string;
  nextStep: string;
  targetId?: string;
  evidence: "metadata" | "saved-probe" | "saved-help" | "active-probe" | "active-help";
  checkedAt?: string;
  actions: DoctorAction[];
}
export interface DoctorFailure { code?: string; status?: number; at?: string }
export interface DoctorProvider {
  id: string;
  /** Route metadata only; never credentials or authentication headers. */
  endpoints?: ProviderEndpointMetadata;
  off?: boolean;
  authKind?: "key" | "subscription" | "none";
  /** Structured status from the latest relevant attempt; never a raw error string. */
  lastStatus?: number;
  probe?: Pick<ProbeReport, "at" | "checks">;
  budgetBlocked?: boolean;
  /** False for unsupported/dedicated sources; omitted means not yet approved for generic probing. */
  probeAllowed?: boolean;
}
export interface DoctorAgent {
  id: string;
  /** null means detection has not run, not that the program is missing. */
  installed: boolean | null;
  required?: boolean;
  helpAllowed?: boolean;
  help?: { checkedAt?: string; verdicts: Verdict[] };
}
export interface DoctorInput {
  gateway: { reachable: boolean | null };
  helper?: SecretStoreHealth | null;
  providers?: DoctorProvider[];
  agents?: DoctorAgent[];
  tokens?: { storeAvailable: boolean | null; sessions?: Array<{ expiresAt: string }>; current?: "valid" | "invalid" | "absent" };
  budget?: { blocked: boolean; configurationInvalid?: boolean; accountingUnavailable?: boolean; probeBlocked?: boolean };
  recentFailure?: DoctorFailure | null;
  now?: number;
}
export interface DoctorReport {
  version: 1;
  mode: "metadata" | "active";
  checkedAt: string;
  status: DoctorStatus;
  counts: Record<DoctorStatus, number>;
  findings: DoctorFinding[];
  notice: string;
}

const TARGET = /^(?!es-session-|sk-)[a-z][a-z0-9-]{0,79}$/;
const safeTarget = (id: unknown): string | undefined => typeof id === "string" && TARGET.test(id) ? id : undefined;
const iso = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 35) return undefined;
  const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};
const action = (kind: DoctorActionKind, label: string, id?: string, requiresConfirmation?: boolean): DoctorAction => ({ kind, label, ...(safeTarget(id) ? {targetId: id} : {}), ...(requiresConfirmation ? {requiresConfirmation:true} : {}) });
const ERROR_CODES: Record<string,string> = {
  gateway_unavailable:"service_unavailable",helper_missing:"keychain_unavailable",helper_unavailable:"keychain_unavailable",
  source_disabled:"source_disabled",source_budget_exceeded:"budget_blocked",provider_auth_failed:"source_auth_required",subscription_login_required:"source_auth_required",
  source_probe_failed:"service_unavailable",agent_not_installed:"client_not_installed",agent_help_failed:"capability_unavailable",
  gateway_session_storage_unavailable:"storage_unavailable",invalid_gateway_session:"session_invalid",gateway_session_expired:"session_invalid",
  budget_exceeded:"budget_blocked",budget_configuration_invalid:"budget_blocked",budget_accounting_unavailable:"budget_blocked",diagnostic_timeout:"request_timeout",
};
function finding(area: DoctorArea, code: string, status: DoctorStatus, title: string, message: string, nextStep: string, actions: DoctorAction[] = [], id?: string): DoctorFinding {
  const mapped=Object.hasOwn(ERROR_CODES,code) ? ERROR_CODES[code] : undefined;
  const error=mapped ? humanError({code:mapped}) : undefined;
  return {area,code,status,title,message:error?.reason ?? message,nextStep,actions,evidence:"metadata",...(error ? {errorCode:error.code} : {}),...(safeTarget(id) ? {targetId:id} : {})};
}
const sourceAction = (p: DoctorProvider) => action(p.authKind === "subscription" ? "open-login" : "open-providers", p.authKind === "subscription" ? "检查订阅登录" : "检查来源与密钥", p.id);
const probeAction = (p: DoctorProvider) => p.probeAllowed === true && safeTarget(p.id) ? [action("probe-provider", "检测这个来源", p.id, true)] : [];

function providerFinding(p: DoctorProvider): DoctorFinding {
  if (p.off) return finding("provider","source_disabled","warn","来源已关闭","这个来源不会用于模型菜单或请求。","如果仍要使用，在模型来源页确认后开启。",[action("open-providers","检查并开启来源",p.id)],p.id);
  if (p.budgetBlocked) return finding("provider","source_budget_exceeded","error","来源预算已暂停请求","该来源的预算条件阻止了新请求。","到来源预算查看用量；等待周期重置，或由你调整额度。",[action("open-providers","查看来源预算",p.id)],p.id);
  if (p.lastStatus === 401 || p.lastStatus === 403) return finding("provider",p.authKind === "subscription" ? "subscription_login_required" : "provider_auth_failed","error","来源拒绝了身份验证","最近一次请求的登录或密钥没有被来源接受。","检查是否过期、缺少权限或复制错误，再重新检测。",[sourceAction(p)],p.id);
  const checks = Array.isArray(p.probe?.checks) ? p.probe.checks.filter(c=>c && typeof c === "object") : [];
  const inference = checks.filter(c => ["chat","responses","messages"].includes(c.id));
  const passed = inference.some(c => c.status === "pass");
  const failed = checks.some(c => c.status === "fail");
  let result: DoctorFinding;
  if (!inference.length || !inference.some(c => c.status === "pass" || c.status === "fail")) result = finding("provider","source_not_checked","unchecked","来源尚未检查","现有记录不能确认模型请求是否能通过。","需要时点击检测；检测会向来源发送请求，可能产生费用。",probeAction(p),p.id);
  else if (!passed) result = finding("provider","source_probe_failed","error","上次来源测试未通过","已保存的测试没有找到可用的模型请求协议。","检查来源地址、模型和密钥；修正后再检测。",[sourceAction(p),...probeAction(p)],p.id);
  else result = finding("provider",failed ? "source_probe_partial" : "source_probe_passed",failed ? "warn" : "ok",failed ? "上次来源测试有未通过项" : "上次来源测试通过",failed ? "至少一种模型请求协议通过，但其他能力可能不支持。" : "保存的测试记录中有可用的模型请求协议。","这是历史结果，不代表此刻可用；需要确认时再检测。",probeAction(p),p.id);
  if (checks.length) { result.evidence="saved-probe"; const at=iso(p.probe?.at); if(at) result.checkedAt=at; }
  if (result.status === "unchecked" && !result.actions.length) { result.nextStep="此来源未开放通用探测，请到来源页查看专用接入说明。"; result.actions=[action("open-providers","查看来源说明",p.id)]; }
  return result;
}

function providerEndpointFinding(p: DoctorProvider): DoctorFinding | undefined {
  const diagnostic = diagnoseMessagesEndpoint(p.endpoints);
  if (!diagnostic) return undefined;
  return finding("provider", diagnostic.code, "warn", "Messages 地址缺少 /v1",
    `${diagnostic.service} 的有效 Messages 请求地址为 ${diagnostic.staleEndpoint}，与${diagnostic.endpointEvidence === "sdk-derived" ? "按官方客户端根地址及 SDK 路径推导的地址" : "已核实的官方地址"} ${diagnostic.recommendedEndpoint} 不一致。`,
    `查看这个来源的配置，将 Anthropic 地址（anthropicBaseUrl）设为 ${diagnostic.recommendedBaseUrl}。${diagnostic.hasPathOverride ? "同时删除 wire.paths.messages 覆盖，或将它设为 messages。" : "EasySwitch 会追加 /messages。"}此地址检查没有修改已保存的来源，也没有为检查地址发送请求；如需验证，修正后再另行确认检测。`,
    [action("open-providers", "查看来源配置", p.id)], p.id);
}

function agentFinding(a: DoctorAgent): DoctorFinding {
  if (a.installed === false) return finding("agent","agent_not_installed",a.required ? "error" : "warn","没有检测到这个 agent","目前不能用这个程序启动增强会话。","先在自己的电脑安装该程序，或选一个已安装的 agent。",[action("open-agents","选择或安装 agent",a.id)],a.id);
  if (a.installed !== true) return finding("agent","agent_not_checked","unchecked","agent 安装状态待确认","尚无安装检测结果。","到 Agent 页刷新已安装程序，再选择要用的 agent。",[action("open-agents","查看 Agent",a.id)],a.id);
  const verdicts=Array.isArray(a.help?.verdicts) ? a.help.verdicts.filter(v=>v && typeof v === "object") : [];
  const helpAction=a.helpAllowed === true && safeTarget(a.id) ? [action("check-agent-help","检查启动参数",a.id,true)] : [action("open-agents","查看启动说明",a.id)];
  if (!verdicts.length) return finding("agent","agent_help_not_checked","unchecked","启动参数尚未检查","检测到安装并不代表当前版本接受这些启动参数。",a.helpAllowed ? "检查会运行该程序的帮助命令，它可能读取自己的配置；请明确确认后再执行。" : "这个程序暂未开放帮助命令检查，请查看接入说明。",helpAction,a.id);
  const unreadable=verdicts.some(v=>v.helpOk !== true);
  const missing=verdicts.some(v=>Array.isArray(v.missing) && v.missing.length > 0);
  const result=finding("agent",unreadable ? "agent_help_failed" : missing ? "agent_flags_unconfirmed" : "agent_flags_listed",unreadable ? "error" : missing ? "warn" : "ok",unreadable ? "上次参数检查没有完成" : missing ? "部分启动参数未在帮助中找到" : "帮助中列出了启动参数",unreadable ? "没有得到可用的程序帮助结果。" : missing ? "可能是版本不同，也可能是帮助没有列出该参数。" : "帮助文字包含启动器使用的参数。","帮助匹配不能证明实际启动、目录隔离或模型调用已验证。",helpAction,a.id);
  result.evidence="saved-help"; const at=iso(a.help?.checkedAt); if(at) result.checkedAt=at; return result;
}

/** Fixed strings, allowlisted public endpoints and validated IDs only; never spread raw diagnostics. */
export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const findings: DoctorFinding[]=[];
  const now=Number.isFinite(input.now) ? input.now! : Date.now();
  findings.push(input.gateway?.reachable === true ? finding("gateway","gateway_ready","ok","网关正在运行","本地服务已响应。","继续查看其他检查结果。") : finding("gateway","gateway_unavailable",input.gateway?.reachable === false ? "error" : "unchecked","暂时连不上网关","本地服务尚未确认可用。","从菜单栏启动 EasySwitch，再重新自检。",[action("refresh-doctor","重新自检")]));
  const h=input.helper;
  if (!h) findings.push(finding("helper","helper_not_checked","unchecked","钥匙串小程序状态未知","没有可用的健康元数据。","在自己的 Mac 上检查 EasySwitch 安装，再刷新。",[action("open-helper-help","查看修复方法")]));
  else if (h.backend === "memory") findings.push(finding("helper","helper_memory_only","warn","当前使用临时密钥存储","内存模式不能验证 Mac 钥匙串是否正常。","真实使用时在自己的 Mac 上检查已签名的钥匙串小程序。",[action("open-helper-help","查看钥匙串说明")]));
  else if (h.status === "helper_signature_unchecked") findings.push(finding("helper","helper_signature_unchecked","unchecked","钥匙串小程序签名尚未检查","已发现程序文件，但被动自检没有运行签名检查，也没有读取密钥。","在自己的 Mac 前台明确启动或检查 EasySwitch 后，再重新自检。",[action("open-helper-help","查看前台检查方法")]));
  else if (!h.ready) findings.push(finding("helper",h.status === "helper_missing" ? "helper_missing" : "helper_unavailable","error",h.status === "helper_missing" ? "钥匙串小程序缺失" : "钥匙串小程序不可用","密钥读取暂时可能无法完成；自检没有读取密钥。","在自己的 Mac 前台按说明重新构建或检查签名；不要放宽安全设置。",[action("open-helper-help","查看重新构建方法")]));
  else findings.push(finding("helper","helper_ready","ok","钥匙串小程序已就绪","文件和签名检查通过；没有弹窗，也没有读取任何密钥。","这不代表已存密钥有效；需要时单独检测来源。"));
  for (const p of (input.providers ?? []).slice(0,200)) {
    findings.push(providerFinding(p));
    const endpoint = providerEndpointFinding(p); if (endpoint) findings.push(endpoint);
  }
  if ((input.providers?.length ?? 0)>200) findings.push(finding("provider","source_inventory_truncated","warn","部分来源尚未列出","本次报告最多列出二百个来源。","请精简不再使用的来源后重新自检。",[action("open-providers","查看全部来源")]));
  if (!input.providers?.length) findings.push(finding("provider","source_none","unchecked","还没有模型来源","没有来源可供检查。","先添加一个模型来源或订阅。",[action("open-providers","添加来源")]));
  for (const a of (input.agents ?? []).slice(0,100)) findings.push(agentFinding(a));
  if ((input.agents?.length ?? 0)>100) findings.push(finding("agent","agent_inventory_truncated","warn","部分 agent 尚未列出","本次报告最多列出一百个 agent。","请到 Agent 页检查所需程序。",[action("open-agents","查看全部 Agent")]));
  if (!input.agents?.length) findings.push(finding("agent","agent_none","unchecked","尚无 agent 检测结果","没有安装元数据可供检查。","到 Agent 页选择或检测要使用的程序。",[action("open-agents","查看 Agent")]));
  const t=input.tokens;
  if (t?.storeAvailable === false) findings.push(finding("tokens","gateway_session_storage_unavailable","error","会话记录暂时不可用","无法确认已签发会话的有效性。","检查 EasySwitch 状态目录是否可写；修复后重新启动，不要删除记录来跳过检查。",[action("open-sessions","查看会话状态")]));
  else if (t?.current === "invalid") findings.push(finding("tokens","invalid_gateway_session","error","当前会话令牌不可用","会话可能已到期、已撤销或不属于此次启动。","重新启动增强会话；手动配置的应用需在控制台重新生成并替换。",[action("open-sessions","查看或更新会话")]));
  else if(t?.storeAvailable !== true) findings.push(finding("tokens","gateway_sessions_not_checked","unchecked","会话记录尚未检查","没有可用的会话存储状态。","刷新自检，或到会话页查看。",[action("open-sessions","查看会话")]));
  else {
    const expired=(t.sessions ?? []).some(s=>!iso(s.expiresAt) || Date.parse(s.expiresAt)<=now);
    findings.push(finding("tokens",expired ? "gateway_session_expired" : t.current === "valid" ? "gateway_session_valid" : "gateway_sessions_metadata",expired ? "warn" : t.current === "valid" ? "ok" : "unchecked",expired ? "有会话记录已到期或不完整" : t.current === "valid" ? "当前会话令牌有效" : "会话存储可读取",expired ? "旧会话不能继续用于新的请求。" : t.current === "valid" ? "此次明确提交的会话令牌通过了本地验证。" : "只检查了登记记录，没有读取或重新显示令牌。","登记正常不代表每个窗口持有的令牌都有效；失效时重新启动对应增强会话。",[action("open-sessions","查看会话")]));
  }
  const b=input.budget;
  findings.push(!b ? finding("budget","budget_not_checked","unchecked","预算状态尚未检查","没有可用的预算状态。","到费用页查看预算后再尝试请求。",[action("open-budget","查看预算")]) : b.blocked ? finding("budget",b.configurationInvalid ? "budget_configuration_invalid" : b.accountingUnavailable ? "budget_accounting_unavailable" : "budget_exceeded","error","预算已暂停新请求",b.configurationInvalid ? "预算设置无法正常读取。" : b.accountingUnavailable ? "用量记录暂时不能完整读取。" : "已达到当前设定的预算条件。","到费用页查看原因；等待周期重置或由你调整，诊断不会自动放开预算。",[action("open-budget","查看预算")]) : finding("budget","budget_not_blocked",b.accountingUnavailable || b.configurationInvalid ? "warn" : "ok","预算没有暂停请求",b.accountingUnavailable || b.configurationInvalid ? "估算或配置不完整，请留意费用。" : "当前预算条件没有阻止新请求。","预算是本地估算，不能代替供应商账单或硬限额。",[action("open-budget","查看预算")]));
  if (input.recentFailure) findings.push(recentFailureFinding(input.recentFailure));
  else findings.push(finding("recent-failure","recent_failure_none","ok","没有最近失败记录","当前提供的记录中没有失败。","没有失败记录不等于已经做过真实调用。"));
  return summarize(findings,now,"metadata");
}

function recentFailureFinding(failure: DoctorFailure): DoctorFinding {
  const mapped=failure.code && Object.hasOwn(ERROR_CODES,failure.code) ? ERROR_CODES[failure.code] : failure.code;
  const error=humanError({code:mapped,status:failure.status},{context:"source"});
  const targets={doctor:"refresh-doctor",current:"open-providers",providers:"open-providers",usage:"open-budget",agents:"open-agents",sessions:"open-sessions"} as const;
  const result=finding("recent-failure",error.code,"warn",`最近一次失败：${error.title}`,error.reason,`请点击「${error.action.label}」检查后再试。`,[action(targets[error.action.target],error.action.label)]);
  result.errorCode=error.code;
  const at=iso(failure.at); if(at) result.checkedAt=at; return result;
}
function summarize(findings: DoctorFinding[], now: number, mode: DoctorReport["mode"]): DoctorReport {
  const counts:Record<DoctorStatus,number>={ok:0,warn:0,error:0,unchecked:0}; for(const row of findings) counts[row.status]++;
  return {version:1,mode,checkedAt:new Date(now).toISOString(),status:counts.error ? "error" : counts.warn ? "warn" : counts.unchecked ? "unchecked" : "ok",counts,findings,notice:"默认自检只读取状态元数据，不读密钥、不登录、不发模型请求、不运行 agent。主动检查需另行确认；帮助和历史测试均不能代替真实使用验证。"};
}

export interface DoctorCheckRequest {
  checks: Array<{ kind: "provider" | "agent-help"; id: string }>;
  acknowledgeSourceRequests?: true;
  acknowledgeCliExecution?: true;
}
export class DoctorCheckRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, code="invalid_input", status=400) { super(message); this.code=code; this.status=status; }
}
export interface DoctorCheckRunners {
  /** The adapter must recheck current budget/source guards and respect abort; it alone owns auth. */
  probeProvider?: (id: string, options: {signal: AbortSignal}) => Promise<{probe: Pick<ProbeReport,"at"|"checks">; lastStatus?: number}>;
  /** The adapter must kill its owned help process on abort, and never return raw output to the UI. */
  checkAgentHelp?: (id: string, options: {signal: AbortSignal}) => Promise<{checkedAt?: string; verdicts: Verdict[]}>;
  signal?: AbortSignal;
  /** Dependency seam for fast fake tests; callers cannot raise the production bound. */
  timeoutMs?: number;
}

/** Validate the entire selection before calling anything. A malformed mixed batch has zero effects. */
export function validateDoctorChecks(input: DoctorInput, value: unknown): DoctorCheckRequest {
  const bad=()=>new DoctorCheckRequestError("请选择要检查的来源或 agent，并确认检查方式。");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const v=value as Record<string,unknown>;
  if (Object.keys(v).some(k=>!["checks","acknowledgeSourceRequests","acknowledgeCliExecution"].includes(k)) || !Array.isArray(v.checks) || !v.checks.length || v.checks.length>8) throw bad();
  if(input.gateway?.reachable !== true) throw new DoctorCheckRequestError("网关状态尚未确认，请先重新连接并自检。","service_unavailable",409);
  if (v.acknowledgeSourceRequests !== undefined && v.acknowledgeSourceRequests !== true || v.acknowledgeCliExecution !== undefined && v.acknowledgeCliExecution !== true) throw bad();
  const seen=new Set<string>(); const checks:DoctorCheckRequest["checks"]=[];
  for(const item of v.checks) {
    if(!item || typeof item !== "object" || Array.isArray(item)) throw bad();
    const c=item as Record<string,unknown>;
    if(Object.keys(c).some(k=>k!=="kind" && k!=="id") || !safeTarget(c.id) || c.kind!=="provider" && c.kind!=="agent-help") throw bad();
    const id=c.id as string; const key=`${c.kind}:${id}`; if(seen.has(key)) throw bad(); seen.add(key);
    if(c.kind === "provider") {
      if(v.acknowledgeSourceRequests !== true) throw new DoctorCheckRequestError("检测会向来源发送请求并可能产生费用，请先明确确认。");
      const p=input.providers?.slice(0,200).find(p=>p.id===id); if(!p) throw bad();
      if(p.off) throw new DoctorCheckRequestError("来源已关闭，请先在来源页确认是否开启。","source_disabled",409);
      if(!input.budget || p.budgetBlocked || input.budget.blocked || input.budget.probeBlocked) throw new DoctorCheckRequestError("预算当前不允许探测，请到费用页查看原因。","budget_blocked",409);
      if(p.probeAllowed !== true) throw new DoctorCheckRequestError("此来源不支持通用检测，请查看专用接入说明。","capability_unavailable",409);
      if(p.authKind !== "none" && input.helper?.ready !== true) throw new DoctorCheckRequestError("钥匙串小程序不可用，请先查看修复说明。","keychain_unavailable",409);
    } else {
      if(v.acknowledgeCliExecution !== true) throw new DoctorCheckRequestError("参数检查会运行所选程序的帮助命令，请先明确确认。");
      const a=input.agents?.slice(0,100).find(a=>a.id===id); if(!a) throw bad();
      if(a.installed !== true) throw new DoctorCheckRequestError("没有确认这个 agent 已安装，请先查看安装状态。","client_not_installed",409);
      if(a.helpAllowed !== true) throw new DoctorCheckRequestError("此 agent 暂未开放帮助命令检查。","capability_unavailable",409);
    }
    checks.push({kind:c.kind,id});
  }
  return {checks,...(v.acknowledgeSourceRequests ? {acknowledgeSourceRequests:true} : {}),...(v.acknowledgeCliExecution ? {acknowledgeCliExecution:true} : {})};
}

class CheckStopped extends Error { cancelled: boolean; constructor(cancelled: boolean) { super("Diagnostic check stopped"); this.cancelled=cancelled; } }
async function boundedCheck<T>(run:(signal:AbortSignal)=>Promise<T>,signal:AbortSignal|undefined,ms:number):Promise<T> {
  const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>|undefined;
  let stop:()=>void=()=>{};
  const stopped=new Promise<never>((_resolve,reject)=>{
    stop=()=>{controller.abort();reject(new CheckStopped(true));};
    if(signal?.aborted) { stop(); return; }
    signal?.addEventListener("abort",stop,{once:true});
    timer=setTimeout(()=>{controller.abort();reject(new CheckStopped(false));},ms);
  });
  try { if(controller.signal.aborted) return await stopped; return await Promise.race([Promise.resolve().then(()=>run(controller.signal)),stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort",stop); }
}

/** No default runners. Calling this API alone cannot read credentials, launch a CLI, or make a request. */
export async function runDoctorChecks(input: DoctorInput, request: unknown, runners: DoctorCheckRunners = {}): Promise<DoctorReport> {
  const selected=validateDoctorChecks(input,request);
  if(selected.checks.some(c=>c.kind==="provider" ? !runners.probeProvider : !runners.checkAgentHelp)) throw new DoctorCheckRequestError("选中的主动检查尚未接通，请查看对应说明。","capability_unavailable",409);
  const updated:DoctorInput={...input,providers:input.providers?.map(p=>({...p})),agents:input.agents?.map(a=>({...a}))};
  const overrides=new Map<string,DoctorFinding>(); const active=new Set<string>();
  const timeout=Math.max(1,Math.min(10_000,Number.isFinite(runners.timeoutMs) ? runners.timeoutMs! : 10_000));
  const deadline=Date.now()+30_000;
  let stopped=false;
  for(const c of selected.checks) {
    const area=c.kind==="provider" ? "provider" : "agent";
    const key=`${area}:${c.id}`;
    if(stopped || runners.signal?.aborted || Date.now()>=deadline) {
      overrides.set(key,finding(area,"diagnostic_not_run","unchecked","这项主动检查没有执行","前面的检查已取消或超时。","需要时重新选择这一项检查。",[action("refresh-doctor","返回自检")],c.id)); continue;
    }
    try {
      await boundedCheck(async signal=>{
        if(c.kind === "provider") {
          const result=await runners.probeProvider!(c.id,{signal});
          if(signal.aborted) return;
          if(!result?.probe || !Array.isArray(result.probe.checks)) throw new Error("Invalid probe result");
          const p=updated.providers!.find(p=>p.id===c.id)!;
          p.probe=result.probe; p.lastStatus=result.lastStatus;
        } else {
          const result=await runners.checkAgentHelp!(c.id,{signal});
          if(signal.aborted) return;
          if(!result || !Array.isArray(result.verdicts)) throw new Error("Invalid help result");
          updated.agents!.find(a=>a.id===c.id)!.help=result;
        }
      },runners.signal,Math.min(timeout,Math.max(1,deadline-Date.now())));
      active.add(key);
    } catch(error) {
      const interrupted=error instanceof CheckStopped;
      if(interrupted) stopped=true;
      overrides.set(key,finding(area,interrupted ? error.cancelled ? "diagnostic_cancelled" : "diagnostic_timeout" : "diagnostic_failed","error",interrupted ? error.cancelled ? "检查已取消" : "检查等待超时" : "检查没有完成","没有得到可用的检查结果，原始程序或来源输出不会展示。","检查安装或网络后，可以重新选择此项检查。",[action(area==="provider" ? "open-providers" : "open-agents","查看相关设置",c.id)],c.id));
    }
  }
  const report=buildDoctorReport(updated);
  const findings=report.findings.map(row=>{
    // Route advice remains metadata even if this source's separate active check
    // succeeds, fails or is cancelled. Never replace it with probe evidence.
    if(row.code === "source_messages_endpoint_stale") return row;
    const key=`${row.area}:${row.targetId}`; const replacement=overrides.get(key); if(replacement) return replacement;
    if(active.has(key)) return {...row,evidence:row.area==="provider" ? "active-probe" as const : "active-help" as const,title:row.title.replace(/^上次/,"此次"),...(row.code==="source_probe_passed" || row.code==="source_probe_partial" ? {nextStep:"本次检测只覆盖列出的能力，不保证后续请求或所有模型都能使用。"} : {}),checkedAt:iso(row.checkedAt) ?? report.checkedAt};
    return row;
  });
  return summarize(findings,Date.parse(report.checkedAt),"active");
}
