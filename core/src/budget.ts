import type { GatewayLogEntry, Provider } from "./types.ts";
import { emptyBudgetSummary, summarizeBudgetEntries, type BudgetSummaryReader } from "./ledger.ts";

/** Per-source budgets use the server's local calendar month; global budgets use their own UTC window. */
export type ProviderBudgetSettings = NonNullable<Provider["budget"]>;
type BudgetProvider = Pick<Provider, "id" | "budget">;

export interface ProviderBudgetStatus {
  spent: number;
  limit: number;
  /** 0..: how much of the budget is gone. */
  ratio: number;
  /** ok under 80%, near from 80%, over from 100%. */
  level: "ok" | "near" | "over";
  /** The configured action, separate from whether requests are currently blocked. */
  stop: boolean;
  blocked: boolean;
  accountingUnavailable: boolean;
  configurationInvalid: boolean;
  unknownCostCalls: number;
  unattributedCalls: number;
  unattributedCostUsd: number;
  pendingPartialLine: boolean;
  startsAt: string;
  resetsAt: string;
  /** The server's local timezone, whose calendar defines this monthly budget. */
  timezone: string;
  warning?: string;
  limitations: string;
}

const LIMITATIONS = "按服务器本地日历月累计这个来源已记录的美元估算费用，不是供应商账单。未知价格、缺少用量、正在进行的请求和网关外的调用可能使实际费用超过预算；订阅月费不计入。停用仅阻止之后的新推理请求。";

/** Validate without coercion so malformed updates cannot silently remove or weaken a stop. */
export function validateProviderBudget(value: unknown): ProviderBudgetSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("需要完整的来源预算设置");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "monthlyUsd" && key !== "stop")) throw new TypeError("来源预算含未知字段");
  if (typeof input.monthlyUsd !== "number" || !Number.isFinite(input.monthlyUsd) || input.monthlyUsd <= 0 || input.monthlyUsd > 1_000_000) {
    throw new TypeError("来源每月预算必须是大于 0 且不超过 100 万的数字（美元）");
  }
  if (input.stop !== undefined && typeof input.stop !== "boolean") throw new TypeError("来源预算的停用设置必须是布尔值");
  return { monthlyUsd: input.monthlyUsd, ...(input.stop !== undefined ? { stop: input.stop } : {}) };
}

/** v0 used monthlyUsd:0 to mean unset. Normalize only that exact, valid legacy shape. */
export function migrateProviderBudget(value: unknown): { version: 1; budget?: ProviderBudgetSettings } {
  if (value === undefined) return { version: 1 };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const old = value as Record<string, unknown>;
    if (old.monthlyUsd === 0 && Object.keys(old).every(key => key === "monthlyUsd" || key === "stop") && (old.stop === undefined || typeof old.stop === "boolean")) return { version: 1 };
  }
  return { version: 1, budget: validateProviderBudget(value) };
}

export function monthStart(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function monthWindow(now: Date = new Date()): { start: Date; end: Date } {
  return { start: monthStart(now), end: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
}

interface MonthAccounting {
  spent: Map<string, number>;
  unknownCostCalls: Map<string, number>;
  unavailable: boolean;
  unattributedCalls: number;
  unattributedCostUsd: number;
  pendingPartialLine: boolean;
  start: Date;
  end: Date;
}

/**
 * Each server owns one controller and supplies its durable Ledger.readForBudget reader.
 * There is no process-global spend or truncated startup snapshot: every decision sees all
 * durable entries, including append failures. This module never probes a source or reads a key.
 */
export class ProviderBudgetController {
  #readEntries?: (since: Date) => GatewayLogEntry[];
  #readSummary?: BudgetSummaryReader;
  #now: () => Date;

  constructor(options: { readEntries?: (since: Date) => GatewayLogEntry[]; readSummary?: BudgetSummaryReader; now?: () => Date }) {
    this.#readEntries = options.readEntries;
    this.#readSummary = options.readSummary;
    this.#now = options.now ?? (() => new Date());
  }

  #month(now: Date): MonthAccounting {
    const { start, end } = monthWindow(now);
    let summary = emptyBudgetSummary();
    try {
      if (this.#readSummary) summary = this.#readSummary(start, end, now);
      else if (this.#readEntries) summary = summarizeBudgetEntries(this.#readEntries(start), start, end, now);
      else throw new Error("No source budget accounting reader");
    } catch { summary.accountingUnavailable = true; }
    return {
      spent: new Map(Object.entries(summary.byProvider).map(([id, totals]) => [id, totals.estimatedCostUsd])),
      unknownCostCalls: new Map(Object.entries(summary.byProvider).map(([id, totals]) => [id, totals.unknownCostCalls])),
      unavailable: summary.accountingUnavailable, unattributedCalls: summary.unattributedCalls,
      unattributedCostUsd: summary.unattributedCostUsd, pendingPartialLine: summary.pendingPartialLine, start, end,
    };
  }

  /** Convenience read for callers that need a total; never returns a falsely complete total. */
  spentThisMonth(providerId: string): number {
    const month = this.#month(this.#now());
    if (month.unavailable) throw new Error("Usage accounting is incomplete");
    return month.spent.get(providerId) ?? 0;
  }

  budgetStatus(provider: BudgetProvider): ProviderBudgetStatus | undefined {
    if (provider.budget === undefined) return undefined;
    let settings: ProviderBudgetSettings | undefined;
    try {
      settings = migrateProviderBudget(provider.budget).budget;
      if (!settings) return undefined;
    } catch { /* Invalid persisted controls fail closed. */ }
    const configurationInvalid = settings === undefined;
    const month = this.#month(this.#now());
    const spent = month.spent.get(provider.id) ?? 0;
    const limit = settings?.monthlyUsd ?? 0;
    const fraction = limit > 0 ? spent / limit : 0;
    const ratio = Number.isFinite(fraction) ? fraction : Number.MAX_VALUE;
    const level = ratio >= 1 ? "over" : ratio >= 0.8 ? "near" : "ok";
    const stop = settings?.stop === true || configurationInvalid;
    const blocked = configurationInvalid || (stop && (level === "over" || month.unavailable));
    const unknownCostCalls = month.unknownCostCalls.get(provider.id) ?? 0;
    let warning: string | undefined;
    if (configurationInvalid) warning = "来源预算设置无法读取；这个来源已暂停，请在控制台重新保存或移除来源预算";
    else if (month.unavailable) warning = stop ? "用量记录无法完整读取；这个来源已暂停" : "用量记录无法完整读取，来源预算估算可能不完整";
    else if (level === "over") warning = stop ? "来源每月估算预算已用完，这个来源已停用到下个月" : "来源每月估算预算已用完；当前为仅提醒，仍会继续请求";
    else if (level === "near") warning = "来源每月估算预算快用完了";
    else if (unknownCostCalls) warning = "这个来源有请求缺少价格或用量，实际费用可能高于当前估算";
    else if (month.unattributedCalls) warning = "旧用量记录中有无法确定来源的费用，已计入全局预算，未分摊给这个来源";
    else if (month.pendingPartialLine) warning = "账本末尾有一条尚未写完整的记录；当前来源估算等待补齐";
    return {
      spent, limit, ratio, level, stop, blocked, accountingUnavailable: month.unavailable, configurationInvalid,
      unknownCostCalls, unattributedCalls: month.unattributedCalls, unattributedCostUsd: month.unattributedCostUsd,
      pendingPartialLine: month.pendingPartialLine, startsAt: month.start.toISOString(), resetsAt: month.end.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(warning ? { warning } : {}), limitations: LIMITATIONS,
    };
  }

  isBudgetStopped(provider: BudgetProvider): boolean {
    return this.budgetStatus(provider)?.blocked ?? false;
  }
}
