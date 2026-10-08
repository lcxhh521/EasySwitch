// Usage-page presentation only. All amounts and evidence come from historical
// summary rows, never current provider settings or budget admission counters.
(() => {
  "use strict";
  const count = value => Number.isInteger(value) && value >= 0 ? value : 0;
  const displayRate = display => Number.isFinite(display?.usdToCny) && display.usdToCny > 0 ? display.usdToCny : 7.2;

  function usageMoney(usd, display, digits) {
    if (!Number.isFinite(usd) || usd < 0) return "金额未知";
    const cny = display?.currency === "CNY";
    const value = usd * (cny ? displayRate(display) : 1);
    if (!Number.isFinite(value)) return "金额超出显示范围";
    const sign = cny ? "¥" : "$";
    const places = digits ?? (value >= 100 ? 0 : value >= 1 ? 2 : value > 0 ? 3 : 2);
    const unit = 10 ** -places;
    const format = number => `${sign}${number.toLocaleString("en-US", { minimumFractionDigits: places, maximumFractionDigits: places })}`;
    // Positive amounts, including conversion underflow, must never impersonate
    // an exact recorded zero. Axis ticks may request their own precision.
    return usd > 0 && value < unit ? `小于 ${format(unit)}` : format(value);
  }

  function usageCostPresentation(totals, display) {
    const t = totals ?? {};
    const recorded = count(t.recordedCostCalls);
    const missing = count(t.missingCostCalls);
    const partial = count(t.partialCostCalls);
    const subscription = count(t.subscription);
    const amount = recorded > 0 ? usageMoney(t.costUsd, display) : null;
    const value = amount ?? (missing ? "费用未知" : subscription ? "订阅" : count(t.calls) ? "费用未知" : "无调用");
    const details = [
      missing ? `${recorded ? "另有 " : ""}${missing} 次费用缺失` : "",
      partial ? `已记录金额中 ${partial} 次费用或用量信息不完整` : "",
      subscription ? `${subscription} 次订阅调用，不计单次费用` : "",
    ].filter(Boolean);
    const sources = t.pricingSources ?? {};
    const provenance = [
      count(sources.user) ? `用户自填价 ${count(sources.user)} 次` : "",
      count(sources.legacy) ? `旧参考表 ${count(sources.legacy)} 次（未按官方现价复核）` : "",
      count(sources.unpriced) ? `记录为未定价 ${count(sources.unpriced)} 次` : "",
      count(sources.subscription) ? `记录为订阅 ${count(sources.subscription)} 次` : "",
      count(sources.unknown) ? `历史出处未记录 ${count(sources.unknown)} 次` : "",
    ].filter(Boolean).join(" · ");
    const headline = amount ? `已记录估算 ${amount}` : value;
    return { value, headline, details, provenance, text: [headline, ...details].join(" · ") };
  }

  function usageCoverage(totals) {
    const t = totals ?? {};
    if (!count(t.calls)) return "还没有调用记录";
    const details = [
      count(t.usageIncompleteCalls) ? `${count(t.usageIncompleteCalls)} 次用量缺失或不完整` : "",
      count(t.usageCompletenessUnknownCalls) ? `${count(t.usageCompletenessUnknownCalls)} 次完整性未记录` : "",
    ].filter(Boolean);
    return details.join(" · ") || "已记录上游用量，不代表完整账单";
  }

  function usageDisplayLimits(display) {
    const currency = display?.currency === "CNY"
      ? `按设置汇率 1 USD = ${displayRate(display)} CNY 换算，非实时汇率。`
      : "金额以 USD 记录。";
    return `${currency}仅为已记录估算，非供应商账单，不保证包含全部费用。日期按核心服务本地日历，7/30 天含今天。已有记录最多读取日志末尾 50,000 行；无法解析的行会跳过，不代表完整历史。`;
  }

  Object.assign(globalThis, { usageMoney, usageCostPresentation, usageCoverage, usageDisplayLimits });
})();
