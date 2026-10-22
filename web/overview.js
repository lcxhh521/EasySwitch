// A dedicated read-only snapshot: visiting this page never reads keys or starts a probe.
"use strict";
let overviewSnapshot = null;
let overviewError = "";
let overviewFlight = null;
function cancelOverviewLoad() {
  if (!overviewFlight) return;
  overviewFlight.controller.abort();
  clearTimeout(overviewFlight.timer);
  overviewFlight = null;
}
async function loadOverview(navigation) {
  if (overviewFlight) return overviewFlight.promise;
  const flight = { controller: new AbortController(), timer: null, promise: null };
  overviewFlight = flight;
  flight.promise = (async () => {
    try {
      const deadline = new Promise((_, reject) => { flight.timer = setTimeout(() => { flight.controller.abort(); reject(new Error("timeout")); }, 10000); });
      const result = await Promise.race([call("GET", "/api/overview", undefined, { signal: flight.controller.signal }), deadline]);
      if (overviewFlight !== flight || page !== "overview" || pageNavigationVersion !== navigation) return false;
      overviewSnapshot = result; overviewError = "";
    } catch {
      if (overviewFlight !== flight || page !== "overview" || pageNavigationVersion !== navigation) return false;
      overviewError = "暂时无法更新总览，请稍后刷新。";
    } finally {
      clearTimeout(flight.timer);
      if (overviewFlight === flight) overviewFlight = null;
    }
    if (page === "overview" && pageNavigationVersion === navigation) render();
    return !overviewError;
  })();
  return flight.promise;
}
const OVERVIEW_SOURCE = { disabled: "已关闭", budget: "预算已暂停", quota: "额度待恢复", no_models: "待配置模型", unavailable: "连接待处理", ready: "模型列表检查正常", unknown: "连接尚未验证" };
function overviewMoney(value) {
  const display = overviewSnapshot.display, cny = display.currency === "CNY";
  return `${cny ? "¥" : "$"}${(value * (cny ? display.usdToCny : 1)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}`;
}
function overviewTime(value, timezone) {
  return new Date(value).toLocaleString("zh-CN", { ...(timezone ? { timeZone: timezone } : {}), month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function renderOverview() {
  const data = overviewSnapshot;
  if (!data) return `<div class="card empty" role="status">${overviewError || "正在读取总览…"}</div>`;
  const { activity, sources, month, budget } = data;
  const attention = sources.filter(s => ["budget", "quota", "no_models", "unavailable"].includes(s.status));
  const selectable = sources.filter(s => s.selectable && !["quota", "unavailable"].includes(s.status));
  const unknown = sources.filter(s => s.status === "unknown").length;
  const date = (value, zone) => esc(overviewTime(value, zone));
  const budgetText = !budget.settings.enabled ? "尚未开启" : budget.blocked ? "新请求已暂停" : `${overviewMoney(budget.estimatedCostUsd)} / ${overviewMoney(budget.settings.limitUsd)}`;
  const sourceRow = source => `<div class="overview-source"><div class="grow"><b>${esc(source.name)}</b><div class="sub">${esc(OVERVIEW_SOURCE[source.status])}${source.sourceHealth.checkedAt ? ` · ${date(source.sourceHealth.checkedAt)} 检查` : ""}</div>${source.quota?.text ? `<div class="sub">${esc(source.quota.text)}</div>` : source.subscription ? '<div class="sub">订阅额度未知</div>' : ""}${source.budget ? `<div class="sub">来源预算 ${overviewMoney(source.budget.spent)} / ${overviewMoney(source.budget.limit)} · ${date(source.budget.resetsAt, source.budget.timezone)} 重置（${esc(source.budget.timezone)}）</div>` : ""}</div><button class="btn secondary" data-overview-source="${esc(source.id)}">查看来源</button></div>`;
  return `<div class="overview-intro"><div><h2>现在的 EasySwitch</h2><p class="hint">${overviewError ? "以下为上次读取的快照" : "状态更新于"} ${date(data.snapshotAt)}</p></div><button class="btn" data-go="agents">选择模型并启动</button></div>
    ${overviewError ? `<div class="card overview-notice" role="status">${overviewError} 当前会话数量可能已变化。</div>` : ""}
    ${!sources.length ? `<div class="card overview-welcome"><h2>接入第一个模型来源</h2><p>跟随首次使用向导，添加来源、选择模型，再打开增强会话。</p><button class="btn" data-go="agents">开始首次设置</button></div>` : ""}
    <div class="overview-metrics">
      <div class="card overview-metric"><span>正在请求的增强会话</span><strong>${activity.sessions.length}</strong><small>${activity.activeRequests} 个在途请求 · 空闲窗口不计入</small></div>
      <div class="card overview-metric"><span>当前可选来源</span><strong>${selectable.length}<small> / ${sources.length}</small></strong><small>${unknown} 个尚未验证连接 · ${attention.length} 个待处理</small></div>
      <div class="card overview-metric"><span>本月已记录估算</span><strong>${month.accountingUnavailable ? "记录不完整" : overviewMoney(month.estimatedCostUsd)}</strong><small>${month.unknownCostCalls} 次费用未完整确定 · ${month.calls} 次已记录尝试</small></div>
      <div class="card overview-metric"><span>全局预算</span><strong class="overview-budget-value">${budgetText}</strong><small>${budget.settings.enabled ? `${date(budget.startsAt, "UTC")} 至 ${date(budget.resetsAt, "UTC")}（UTC）` : "在用量页设置提醒或暂停新请求"}</small></div>
    </div>
    <div class="overview-columns"><section class="card overview-section"><div class="section-head"><h2>正在使用</h2><button class="btn secondary" data-go="sessions">会话记录</button></div>
      ${activity.sessions.length ? activity.sessions.map(s => `<div class="overview-session"><b>${esc(s.agentId)}</b><span class="chip ok">${s.requests} 个请求</span><p>${s.models.map(esc).join(" · ")}</p><small class="hint">本次请求开始于 ${date(s.startedAt)}</small></div>`).join("") : '<div class="empty">当前没有在途的外接请求。<br>已打开但空闲的窗口、原生请求和模型列表查询不计入。</div>'}
      <p class="hint">自 ${date(activity.observedSince)} 起观察本次核心服务；按增强会话去重。</p></section>
    <section class="card overview-section"><div class="section-head"><h2>${attention.length ? "需要处理" : "来源状态"}</h2><button class="btn secondary" data-go="providers">全部来源</button></div>${(attention.length ? attention : sources).slice(0, 6).map(sourceRow).join("") || '<div class="empty">还没有添加来源。</div>'}${attention.length > 6 ? `<p class="hint">还有 ${attention.length - 6} 个待处理来源，请到全部来源查看。</p>` : ""}<p class="hint">可选表示配置允许选择；连接、凭据与推理能力以实际调用为准。</p></section></div>
    <section class="card overview-section"><div class="section-head"><h2>费用与额度</h2><button class="btn secondary" data-go="usage">查看用量与预算</button></div><p class="hint">本月范围：${date(month.startsAt, month.timezone)} 至 ${date(month.resetsAt, month.timezone)}（${esc(month.timezone)}）。这里只累计已记录估算，未知费用、在途请求、订阅月费和网关外调用不包含在金额中。</p>${month.pendingPartialLine ? '<p class="hint">还有一条记录尚未写完整，等待下次更新。</p>' : ""}${budget.warning ? `<p class="hint">${esc(budget.warning)}</p>` : ""}${sources.filter(s => s.subscription).map(sourceRow).join("")}</section>`;
}
