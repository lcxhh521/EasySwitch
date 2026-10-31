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

  /** Local daily summary export. A strict allowlist excludes identifiers, prompts,
   * credentials and arbitrary text; numeric unknowns must never become zero. */
  function usageDailyCsv(summary) {
    const ranges = { today: "今天", "7d": "近7天", "30d": "近30天", all: "已有记录" };
    if (!summary || !Object.hasOwn(ranges, summary.range) || !Array.isArray(summary.days)
        || !summary.days.length || summary.days.length > 10000) throw new Error("Invalid usage export");
    const fields = ["calls", "errors", "inputTokens", "outputTokens", "cachedTokens", "unmetered", "unpriced",
      "subscription", "recordedCostCalls", "missingCostCalls", "partialCostCalls", "usageIncompleteCalls", "usageCompletenessUnknownCalls"];
    const sources = ["user", "legacy", "unpriced", "subscription", "unknown"];
    const header = ["行类型", "日期（核心服务本地日历）", "范围", "调用次数", "失败次数", "已记录输入Token", "已记录输出Token",
      "已记录缓存Token", "未报告用量次数", "未定价次数", "订阅次数", "有记录金额次数", "费用缺失次数", "部分费用次数",
      "用量不完整次数", "用量完整性未知次数", "已记录估算USD（空白表示无金额记录）", "自填价次数", "旧参考价次数", "未定价出处次数", "订阅出处次数", "出处未知次数", "说明"];
    const note = "仅为已记录估算，非供应商账单；不保证包含全部费用。原始USD，不使用显示汇率。已有记录最多读取日志末尾50000行，无法解析行跳过，不代表完整历史。";
    const metrics = value => {
      if (!value || fields.some(key => !Number.isFinite(value[key]) || value[key] < 0
          || (!key.endsWith("Tokens") && !Number.isSafeInteger(value[key])))
          || sources.some(key => !Number.isSafeInteger(value.pricingSources?.[key]) || value.pricingSources[key] < 0)
          || !Number.isFinite(value.costUsd) || value.costUsd < 0) throw new Error("Invalid usage metrics");
      return [...fields.map(key => value[key]), value.recordedCostCalls > 0 ? value.costUsd : "", ...sources.map(key => value.pricingSources[key])];
    };
    let previous = "";
    const rows = summary.days.map(day => {
      if (typeof day?.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.day) || day.day <= previous
          || !Number.isFinite(Date.parse(day.day + "T00:00:00Z"))
          || new Date(day.day + "T00:00:00Z").toISOString().slice(0,10) !== day.day) throw new Error("Invalid usage day");
      previous = day.day;
      return ["每日", day.day, ranges[summary.range], ...metrics(day), note];
    });
    rows.unshift(["合计", "", ranges[summary.range], ...metrics(summary.totals), note]);
    // Every string is fixed copy or a validated date. Quoting preserves CSV
    // structure; no untrusted names/formulas or raw object fields are exported.
    return "\uFEFF" + [header, ...rows].map(row => row.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(",")).join("\r\n") + "\r\n";
  }

  Object.assign(globalThis, { usageMoney, usageCostPresentation, usageCoverage, usageDisplayLimits, usageDailyCsv });
})();
