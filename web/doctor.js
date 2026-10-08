// Read-only diagnostics first. Active checks always require a separate, explicit confirmation.
"use strict";
let doctorReport = null;
let doctorError = "";
let doctorBusy = false;
let doctorConfirmation = null;
let doctorController = null;
let doctorHelperHelp = false;
async function loadDoctor() {
  try { doctorReport = await call("GET", "/api/doctor"); doctorError = ""; }
  catch (error) { doctorReport = null; doctorError = userErrorMessage(error); }
}
function cancelDoctorCheck() {
  doctorController?.abort(); doctorConfirmation = null;
}
function renderDoctor() {
  const labels = {ok:"正常",warn:"需要留意",error:"需要处理",unchecked:"尚未检查"};
  const report = doctorReport;
  return `<div class="section-head"><h2>自检</h2><button class="btn secondary" data-doctor-action="refresh-doctor" ${doctorBusy ? "disabled" : ""}>刷新状态</button></div>
    <p class="hint">先读取已有状态；不会读取密钥、登录账号、调用模型或运行程序。主动检查需要另行确认。</p>
    ${doctorError ? `<div class="card msg bad">${esc(doctorError)}</div>` : ""}
    ${doctorHelperHelp ? `<div class="card" style="padding:16px"><h3>修复钥匙串小程序</h3><p>在自己的 Mac 上，先确认已有可用的代码签名身份，再按安装说明在前台运行构建脚本。旧的未签名或临时签名版本不能直接使用；这里不会替你创建证书、签名或读取钥匙串。</p><p><code>./scripts/build-keychain.sh</code></p><p>完成后重新启动 EasySwitch 并刷新自检；详见项目文档 docs/native-keychain.md。</p></div>` : ""}
    ${doctorConfirmation ? `<form class="card form" data-doctor-confirm><h3>确认主动检查</h3><p>${doctorConfirmation.kind === "provider" ? "会向所选模型来源发送少量检测请求，可能产生费用。暂停请求预算仍会阻止检测；不会自动开启关闭的来源。" : "会运行所选程序的帮助命令，它可能读取自己的配置或登录状态；不会发送模型任务，但需要你确认允许执行该程序。"}</p><label><input type="checkbox" name="ack" required ${doctorBusy ? "disabled" : ""}>我了解并确认本次检查</label><div class="controls"><button class="btn" type="submit" ${doctorBusy ? "disabled" : ""}>${doctorBusy ? "正在检查…" : "开始检查"}</button><button class="btn secondary" type="button" data-doctor-action="cancel">${doctorBusy ? "取消检查" : "返回"}</button></div></form>` : ""}
    ${report ? `<p class="hint">${esc(report.notice)}</p>${(report.findings ?? []).map(f => `<div class="card" style="padding:16px;margin-bottom:10px"><div class="title">${esc(f.title)} ${f.targetId ? `· ${esc(f.targetId)}` : ""} <span class="chip">${esc(labels[f.status] ?? "尚未检查")}</span></div><p>${esc(f.message)}</p><p class="hint">${esc(f.nextStep)}</p>${f.checkedAt ? `<p class="hint">记录时间：${esc(f.checkedAt)}</p>` : ""}<div class="controls">${(f.actions ?? []).map(a => `<button class="btn secondary" data-doctor-action="${esc(a.kind)}" ${a.targetId ? `data-doctor-target="${esc(a.targetId)}"` : ""} ${doctorBusy ? "disabled" : ""}>${esc(a.label)}</button>`).join("")}</div></div>`).join("")}` : doctorError ? "" : `<div class="card empty">正在读取本地检查结果…</div>`}`;
}
document.addEventListener("click", async event => {
  const button=event.target.closest?.("[data-doctor-action]");if(!button)return;
  event.preventDefault();event.stopImmediatePropagation();
  const action=button.dataset.doctorAction;
  if(action==="cancel"){cancelDoctorCheck();if(!doctorBusy)render();return;}
  if(doctorBusy||button.disabled)return;
  if(action==="refresh-doctor"){await loadDoctor();render();return;}
  if(action==="open-helper-help"){doctorHelperHelp=!doctorHelperHelp;render();return;}
  if(["probe-provider","check-agent-help"].includes(action)){
    const id=button.dataset.doctorTarget;if(!/^[a-z][a-z0-9-]{0,79}$/.test(id??""))return;
    doctorConfirmation={kind:action==="probe-provider"?"provider":"agent-help",id};render();return;
  }
  const targets={"open-providers":"providers","open-login":"providers","open-agents":"agents","open-sessions":"sessions","open-budget":"usage"};
  if(targets[action]){pageNavigationVersion++;page=targets[action];history.replaceState(null,"",`#${page}`);doctorConfirmation=null;await refresh(true);}
});
document.addEventListener("submit", async event=>{
  if(!event.target.matches?.("[data-doctor-confirm]"))return;
  event.preventDefault();event.stopImmediatePropagation();if(doctorBusy||!doctorConfirmation)return;
  if(new FormData(event.target).get("ack")!=="on")return;
  const check={...doctorConfirmation};doctorBusy=true;doctorError="";doctorController=new AbortController();const controller=doctorController;render();
  try {
    doctorReport=await call("POST","/api/doctor/checks",{checks:[check],...(check.kind==="provider"?{acknowledgeSourceRequests:true}:{acknowledgeCliExecution:true})},{signal:controller.signal});doctorConfirmation=null;
  } catch(error){doctorError=controller.signal.aborted?"已取消主动检查；已完成的检查记录可能已保存，可以刷新状态查看。":userErrorMessage(error);}
  finally{if(doctorController===controller)doctorController=null;doctorBusy=false;render();}
});
