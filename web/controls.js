// Local console controls. Token plaintext stays only in this page's memory, never localStorage.
"use strict";
let budgetSaving = false;

function gatewaySessionsCard() {
  const sessions = state?.gatewaySessions ?? [];
  return `<div class="section-head"><h2>网关会话令牌</h2><span class="aside">这里只列元数据，不重新显示令牌</span></div><div class="card">
    ${sessions.map(s => `<div class="row"><div class="grow"><div class="title">${esc(s.agentId)}</div><div class="sub">到期 ${esc(new Date(s.expiresAt).toLocaleString())} · 模型调用${s.allowNativeClaude ? " · 允许原生 Claude" : ""}${s.fallbackChanges?.length ? ` · 曾换用备用 ${esc(s.fallbackChanges.at(-1).fromModel)} → ${esc(s.fallbackChanges.at(-1).toModel)}` : ""}</div></div><button class="btn danger" data-session-revoke="${esc(s.id)}">撤销</button></div>`).join("") || `<p class="empty">没有未过期的会话</p>`}
    <p class="hint" style="padding:0 16px 12px">撤销立即阻止后续请求。关闭旧式交互窗口未必自动撤销，请手动撤销或等待到期；不会为停止一个窗口而撤销别的会话。</p></div>`;
}
function budgetSettingsCard() {
  const b = state?.budget;
  if (!b?.settings) return "";
  const s = b.settings;
  const reset = b.resetsAt == null ? null : new Date(b.resetsAt);
  const resetText = reset && Number.isFinite(reset.getTime()) ? reset.toLocaleString() : "暂不可用";
  return `<div class="section-head"><h2>估算费用预算</h2><span class="aside">UTC ${s.period === "day" ? "日" : "月"}累计</span></div><div class="card" style="padding:16px">
    <p>已记录估算：$${Number(b.estimatedCostUsd ?? 0).toFixed(4)} / $${Number(s.limitUsd).toFixed(2)}</p>
    ${b.warning ? `<p class="msg ${b.blocked ? "bad" : ""}">${esc(b.warning)}</p>` : ""}
    <form data-global-budget-form class="form"><label><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}> 开启预算</label>
      <div class="field"><label>上限（USD）</label><input name="limitUsd" type="number" min="0" max="1000000000" step="0.01" required value="${esc(s.limitUsd)}"></div>
      <div class="field"><label>周期</label><select name="period"><option value="day" ${s.period === "day" ? "selected" : ""}>UTC 每日</option><option value="month" ${s.period === "month" ? "selected" : ""}>UTC 每月</option></select></div>
      <div class="field"><label>超额后</label><select name="action"><option value="warn" ${s.action === "warn" ? "selected" : ""}>仅提醒，继续请求</option><option value="stop" ${s.action === "stop" ? "selected" : ""}>暂停新的推理请求</option></select></div>
      <div class="controls"><button class="btn" type="submit" ${budgetSaving ? "disabled" : ""}>${budgetSaving ? "保存中…" : "保存预算"}</button></div></form>
    <p class="hint">${esc(b.limitations)} 通用来源探测目前不完整计费，开启暂停请求预算时会禁止探测；不能当作供应商硬限额。</p>
    <p class="hint">${esc(b.unknownCostCalls ?? 0)} 次请求缺少完整成本信息；下一周期开始时间：${esc(resetText)}。</p></div>`;
}

document.addEventListener("click", async event => {
  const revoke = event.target.closest?.("[data-session-revoke]");
  if (!revoke) return;
  event.stopImmediatePropagation();
  if (revoke.disabled) return; revoke.disabled = true;
  try { await call("DELETE", `/api/gateway/sessions/${encodeURIComponent(revoke.dataset.sessionRevoke)}`); if (guideData?.session?.id === revoke.dataset.sessionRevoke) { guideData = null; guideOpen = null; } await refresh(true); }
  catch (error) { showError(error); revoke.disabled = false; }
});
document.addEventListener("submit", async event => {
  if (!event.target.matches?.("[data-global-budget-form]")) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (budgetSaving) return;
  const form = event.target; const f = new FormData(form);
  if (!state?.budget?.settings) { toast("预算状态暂不可用，请刷新后重试"); return; }
  const settings = { enabled: f.get("enabled") === "on", limitUsd: Number(f.get("limitUsd")), period: f.get("period"), action: f.get("action"), warnAt: state.budget.settings.warnAt };
  if (!String(f.get("limitUsd") ?? "").trim() || !Number.isFinite(settings.limitUsd) || settings.limitUsd < 0) { toast("请填写有效的美元上限"); return; }
  const controls = [...form.querySelectorAll("button,input,select")]; const disabled = controls.map(el => el.disabled);
  budgetSaving = true; controls.forEach(el => { el.disabled = true; });
  try { await call("PUT", "/api/budget", settings); await refresh(true); toast("预算已保存"); }
  catch (error) { showError(error); }
  finally { budgetSaving = false; controls.forEach((el, i) => { el.disabled = disabled[i]; }); }
});

function subscriptionSupportCard() {
  const rows = planInfo?.subscriptionSupport ?? [];
  if (!rows.length) return "";
  const states = { "official-api-key": "已有专用 Key 通道", "not-implemented": "官方接法未实现", "not-verified": "通用模型接口未核实", "blocked-terms": "个人条款限制" };
  const link = url => /^https:\/\//.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">官方说明</a>` : "";
  return `<details class="card" style="padding:16px;margin-top:12px"><summary>订阅与官方 agent 接入核对（${rows.length} 家）</summary><p class="hint">这里说明各家官方支持的依据。新增订阅默认关闭；只对照过文档、用假服务测过的，不等于用真账号确认过。</p>
    ${rows.map(row => `<div class="row"><div class="grow"><div class="title">${esc(row.label)} <span class="chip">${esc(states[row.modelSource.state] ?? row.modelSource.state)}</span></div><p class="sub">${esc(row.modelSource.reason)}</p>${(row.apiRoutes ?? []).map(route => `<p class="hint">${esc(route.label)}：${esc(route.auth)}；${esc(route.billing)}</p>`).join("")}<div class="sub">${row.sources.map(link).filter(Boolean).join(" · ")}</div></div></div>`).join("")}</details>`;
}

let cliTextFormOpen = false;
let cliTextKind = "qoder";
let cliTextBusy = false;
function cliTextSourceNotice(p) {
  return ["qoder", "codebuddy"].includes(p.cliTextBridge?.kind)
    ? `${p.cliTextBridge.kind === "codebuddy" ? "CodeBuddy" : "Qoder"}纯文字桥：拒绝工具定义、工具历史和图片；普通编码agent通常附带工具，不能直接当完整模型API用。多轮对话只会当成一段文字发过去，流式请求要等完整结果出来才返回，也拿不到准确的用量。真实CLI未验收（还没有在真实命令行上验证过），开启后调用会消耗你所选厂商的额度。`
    : "Droid 暂时还不能用：隔离方式没有验证过，所以先不接通；测试里的模拟程序不代表真能用。";
}
function cliTextSourcesCard() {
  const label = cliTextKind === "codebuddy" ? "CodeBuddy" : "Qoder";
  return `<div class="section-head"><h2>CLI文字来源</h2><span class="aside">实验性 · 默认关闭 · 不自动运行程序</span></div><div class="card" style="padding:16px">
    <p>${esc(cliTextSourceNotice({cliTextBridge:{kind:cliTextKind}}))}</p>
    ${cliTextFormOpen ? `<form class="form" data-cli-text-form>
      <div class="field"><label>来源名称</label><input name="name" required placeholder="我的${label}文字来源"></div>
      <div class="field"><label>已安装${label} CLI绝对路径（只检查文件，不执行或安装）</label><input name="binary" required placeholder="/absolute/path/to/${cliTextKind === "codebuddy" ? "codebuddy" : "qoder"}"></div>
      ${cliTextKind === "codebuddy" ? `<div class="field"><label>凭据所属区域（必须明确选择，不自动切换）</label><select name="edition" required><option value="">请选择</option><option value="international">国际版</option><option value="china">国内版</option></select></div><p class="hint">这是让CodeBuddy提供纯文字结果的来源，不是把EasySwitch模型接入CodeBuddy的启动器；不继承本地网关地址。</p>` : ""}
      <div class="field"><label>你已确认可用的模型ID（不自动查询）</label><input name="model" required></div>
      <div class="field"><label>用户自行提供的${cliTextKind === "codebuddy" ? "CodeBuddy API Key" : "Qoder 个人访问令牌"}</label><input name="apiKey" type="password" autocomplete="off" required></div>
      <label><input name="experimental" type="checkbox" required> 我了解纯文字限制与真实CLI尚未验收，添加后仍需明确开启</label>
      <div class="controls"><button class="btn" type="submit" ${cliTextBusy ? "disabled" : ""}>${cliTextBusy ? "保存中…" : "添加，保持关闭"}</button><button type="button" class="btn secondary" data-cli-text-close ${cliTextBusy ? "disabled" : ""}>取消</button></div>
    </form>` : `<button class="btn secondary" data-cli-text-open="qoder">添加Qoder纯文字来源</button> <button class="btn secondary" data-cli-text-open="codebuddy">添加CodeBuddy纯文字来源</button>`}
    <p class="hint">Droid：尚未开放，生产返回501。需要先验证无工具权限、私有会话和隔离传输，不能用按钮或设置跳过。</p></div>`;
}
document.addEventListener("click", async event => {
  const open = event.target.closest?.("[data-cli-text-open]");
  if (open) { event.stopImmediatePropagation(); if (cliTextBusy) return; cliTextKind = open.dataset.cliTextOpen === "codebuddy" ? "codebuddy" : "qoder"; cliTextFormOpen = true; render(); return; }
  if (event.target.closest?.("[data-cli-text-close]")) { event.stopImmediatePropagation(); if (!cliTextBusy) { cliTextFormOpen = false; render(); } return; }
  const button = event.target.closest?.("[data-cli-source-switch]");
  if (!button) return; event.stopImmediatePropagation();
  if (button.disabled) return; button.disabled = true;
  try { await call("PUT", `/api/providers/${encodeURIComponent(button.dataset.cliSourceSwitch)}/switch`, { on: button.dataset.on !== "1" }); await refresh(true); }
  catch (error) { showError(error); button.disabled = false; }
});
document.addEventListener("submit", async event => {
  if (!event.target.matches?.("[data-cli-text-form]")) return;
  event.preventDefault(); event.stopImmediatePropagation(); if (cliTextBusy) return;
  const form = event.target; const fields = new FormData(form);
  if (fields.get("experimental") !== "on") { toast("请先确认纯文字限制与未实测状态"); return; }
  const edition = fields.get("edition");
  if (cliTextKind === "codebuddy" && !["international", "china"].includes(edition)) { toast("请选择凭据所属的CodeBuddy区域"); return; }
  const body = { kind: cliTextKind, ...(cliTextKind === "codebuddy" ? { edition } : {}), name: String(fields.get("name") ?? "").trim(), binary: String(fields.get("binary") ?? "").trim(), model: String(fields.get("model") ?? "").trim(), apiKey: String(fields.get("apiKey") ?? ""), experimental: true };
  cliTextBusy = true; form.querySelectorAll("button,input,select").forEach(el => { el.disabled = true; });
  try { await call("POST", "/api/cli-text-sources", body); cliTextFormOpen = false; await refresh(true); toast("文字来源已添加，仍处于关闭状态"); }
  catch (error) { showError(error); }
  finally { cliTextBusy = false; form.querySelectorAll("button,input,select").forEach(el => { el.disabled = false; }); }
});
