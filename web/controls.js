// Local console controls. Token plaintext stays only in this page's memory, never localStorage.
"use strict";
let budgetSaving = false;

function gatewaySessionsCard() {
  const sessions = state?.gatewaySessions ?? [];
  return `<div class="section-head"><h2>网关会话令牌</h2><span class="aside">这里只列元数据，不重新显示令牌</span></div><div class="card">
    ${sessions.map(s => `<div class="row"><div class="grow"><div class="title">${esc(s.agentId)}</div><div class="sub">到期 ${esc(new Date(s.expiresAt).toLocaleString())} · ${s.allowMcp ? "允许 MCP" : "仅模型调用"}${s.allowNativeClaude ? " · 允许原生 Claude" : ""}</div></div><button class="btn danger" data-session-revoke="${esc(s.id)}">撤销</button></div>`).join("") || `<p class="empty">没有未过期的会话</p>`}
    <p class="hint" style="padding:0 16px 12px">撤销立即阻止后续请求。关闭旧式交互窗口未必自动撤销，请手动撤销或等待到期；不会为停止一个窗口而撤销别的会话。</p></div>`;
}
function budgetSettingsCard() {
  const b = state?.budget;
  if (!b) return "";
  const s = b.settings;
  return `<div class="section-head"><h2>估算费用预算</h2><span class="aside">UTC ${s.period === "day" ? "日" : "月"}累计</span></div><div class="card" style="padding:16px">
    <p>已记录估算：$${Number(b.estimatedCostUsd ?? 0).toFixed(4)} / $${Number(s.limitUsd).toFixed(2)}</p>
    ${b.warning ? `<p class="msg ${b.blocked ? "bad" : ""}">${esc(b.warning)}</p>` : ""}
    <form data-global-budget-form class="form"><label><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}> 开启预算</label>
      <div class="field"><label>上限（USD）</label><input name="limitUsd" type="number" min="0" max="1000000000" step="0.01" required value="${esc(s.limitUsd)}"></div>
      <div class="field"><label>周期</label><select name="period"><option value="day" ${s.period === "day" ? "selected" : ""}>UTC 每日</option><option value="month" ${s.period === "month" ? "selected" : ""}>UTC 每月</option></select></div>
      <div class="field"><label>超额后</label><select name="action"><option value="warn" ${s.action === "warn" ? "selected" : ""}>仅提醒，继续请求</option><option value="stop" ${s.action === "stop" ? "selected" : ""}>暂停新的推理请求</option></select></div>
      <div class="controls"><button class="btn" type="submit" ${budgetSaving ? "disabled" : ""}>${budgetSaving ? "保存中…" : "保存预算"}</button></div></form>
    <p class="hint">${esc(b.limitations)} 通用来源探测目前不完整计费，开启暂停请求预算时会禁止探测；不能当作供应商硬限额。</p>
    <p class="hint">${b.unknownCostCalls} 次请求缺少完整成本信息；下一周期 ${esc(new Date(b.resetsAt).toLocaleString())} 开始。</p></div>`;
}

document.addEventListener("click", async event => {
  const revoke = event.target.closest?.("[data-session-revoke]");
  if (!revoke) return;
  event.stopImmediatePropagation();
  if (revoke.disabled) return; revoke.disabled = true;
  try { await call("DELETE", `/api/gateway/sessions/${encodeURIComponent(revoke.dataset.sessionRevoke)}`); if (guideData?.session?.id === revoke.dataset.sessionRevoke) { guideData = null; guideOpen = null; } await refresh(true); }
  catch (error) { toast(error.message); revoke.disabled = false; }
});
document.addEventListener("submit", async event => {
  if (!event.target.matches?.("[data-global-budget-form]")) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (budgetSaving) return;
  const form = event.target; const f = new FormData(form);
  const settings = { enabled: f.get("enabled") === "on", limitUsd: Number(f.get("limitUsd")), period: f.get("period"), action: f.get("action"), warnAt: state.budget.settings.warnAt };
  if (!Number.isFinite(settings.limitUsd) || settings.limitUsd < 0) { toast("请填写有效的美元上限"); return; }
  budgetSaving = true; form.querySelectorAll("button,input,select").forEach(el => { el.disabled = true; });
  try { await call("PUT", "/api/budget", settings); await refresh(true); toast("预算已保存"); }
  catch (error) { toast(error.message); }
  finally { budgetSaving = false; form.querySelectorAll("button,input,select").forEach(el => { el.disabled = false; }); }
});

function subscriptionSupportCard() {
  const rows = planInfo?.subscriptionSupport ?? [];
  if (!rows.length) return "";
  const states = { "official-api-key": "已有专用 Key 通道", "not-implemented": "官方接法未实现", "not-verified": "通用模型接口未核实", "blocked-terms": "个人条款限制" };
  const link = url => /^https:\/\//.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">官方说明</a>` : "";
  return `<details class="card" style="padding:16px;margin-top:12px"><summary>订阅与官方 agent 接入核对（${rows.length} 家）</summary><p class="hint">这里说明官方支持依据。已有 B20 适配器单独保留，新增订阅默认关闭；文档核对和假服务测试不等于真实账号验收。</p>
    ${rows.map(row => `<div class="row"><div class="grow"><div class="title">${esc(row.label)} <span class="chip">${esc(states[row.modelSource.state] ?? row.modelSource.state)}</span></div><p class="sub">${esc(row.modelSource.reason)}</p>${(row.apiRoutes ?? []).map(route => `<p class="hint">${esc(route.label)}：${esc(route.auth)}；${esc(route.billing)}</p>`).join("")}<div class="sub">${row.sources.map(link).filter(Boolean).join(" · ")}</div></div></div>`).join("")}</details>`;
}
