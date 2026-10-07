// Pure rendering only. The application owns explicit settings/check actions.
"use strict";
function sourceHealthEscape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function sourceHealthSupported(provider) {
  if (!provider || provider.sourceHealth?.blockedReason === "unsupported" || provider.plan || provider.vertex || provider.cliTextBridge || provider.antigravity || provider.kimi || provider.cursor || provider.kiro || provider.mimoFree) return false;
  try {
    const base = String(provider.baseUrl ?? "").replace(/\{([A-Za-z0-9_-]+)\}/g, (_match, name) => {
      const value = provider.urlParams?.[name]?.trim(); if (!value) throw new Error(); return encodeURIComponent(value);
    });
    const path = provider.wire?.paths?.models ?? "models";
    if (typeof path !== "string") return false;
    const url = new URL(path === "" ? base : `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || (url.protocol === "http:" && local)) && !url.username && !url.password && !url.hash && /\/models\/?$/.test(url.pathname);
  } catch { return false; }
}
function sourceHealthCard(provider) {
  if (!sourceHealthSupported(provider)) return "";
  const health = provider.sourceHealth ?? {}, enabled = provider.healthMonitor?.enabled === true;
  const qualified = health.eligible === true, verified = health.verified === true;
  const next = typeof health.nextCheckAt === "number" && Number.isFinite(new Date(health.nextCheckAt).getTime()) ? health.nextCheckAt : undefined;
  const cooling = next !== undefined && next > Date.now();
  const disabled = !enabled || !qualified || provider.off === true || cooling;
  let status = "状态未知", detail = "尚未取得可用的轻量检查结果。";
  if (provider.off === true) { status = "来源已关闭"; detail = "先打开来源，才能进行轻量检查。"; }
  else if (!enabled) { status = "轻量检查未开启"; detail = "默认关闭；勾选许可后，可以点击“检查一次”验证模型列表。"; }
  else if (!qualified) { detail = "尚未获得当前来源的检查资格，请核对来源设置。"; }
  else if (health.status === "healthy" && verified) { status = "模型列表检查正常"; detail = "最近一次模型列表返回有效；这不代表生成请求一定可用。"; }
  else if (health.status === "unavailable" && verified) { status = "模型列表检查不可用"; detail = "连续轻量检查失败，可作为已配置备用模型的选择依据。"; }
  else if (health.reason === "rate_limited") { detail = "模型列表检查受到限流，正在退避；不会据此认定模型额度耗尽。"; }
  else if (health.reason === "stale") { detail = "之前的检查结果已过期，需要新的检查结果。"; }
  else if (!verified) { detail = "首次验证尚未完成；只有有效模型列表返回后，才会开始周期检查。"; }
  const e = sourceHealthEscape;
  const cooldown = cooling ? `<p class="hint">冷却中，下次可检查：${e(new Date(next).toLocaleString("zh-CN"))}。重复点击不会绕过等待。</p>` : "";
  return `<div class="source-health" style="margin-top:10px"><p class="hint" role="status">${e(status)} · ${e(detail)}</p><div class="controls"><label class="hint"><input type="checkbox" data-source-health="${e(provider.id)}" aria-label="允许检查 ${e(provider.name ?? provider.id)} 的模型列表" ${enabled ? "checked" : ""} ${provider.off === true ? "disabled" : ""}>允许定期读取模型列表</label><button class="btn secondary" data-source-health-check="${e(provider.id)}" ${disabled ? "disabled" : ""}>检查一次</button></div>${cooldown}<p class="hint">仅发送 GET 模型列表，不发送生成请求，也不验证推理或额度。部分厂商可能限流或计费；开启表示允许按此方式检查。成功验证后至少间隔五分钟，连续三次明确失败才标记检查不可用。</p></div>`;
}
