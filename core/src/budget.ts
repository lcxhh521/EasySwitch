import type { GatewayLogEntry, Provider } from "./types.ts";

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
  start: Date;
  end: Date;
}

/** Also validate injected readers: invalid values must never reduce the budget total. */
function validEntry(entry: GatewayLogEntry): boolean {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.at !== "string" || !Number.isFinite(Date.parse(entry.at))) return false;
  if (typeof entry.model !== "string" || typeof entry.route !== "string" || !Number.isInteger(entry.status) || !Number.isFinite(entry.ms)) return false;
  if (entry.providerId !== undefined && (typeof entry.providerId !== "string" || !entry.providerId)) return false;
  for (const field of ["costUsd", "inputTokens", "outputTokens", "cachedTokens"] as const) {
    const value = entry[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return false;
  }
  return entry.costNote === undefined || entry.costNote === "subscription" || entry.costNote === "unpriced";
}

/**
 * Each server owns one controller and supplies its durable Ledger.readForBudget reader.
 * There is no process-global spend or truncated startup snapshot: every decision sees all
 * durable entries, including append failures. This module never probes a source or reads a key.
 */
export class ProviderBudgetController {
  #readEntries: (since: Date) => GatewayLogEntry[];
  #now: () => Date;

  constructor(options: { readEntries: (since: Date) => GatewayLogEntry[]; now?: () => Date }) {
    this.#readEntries = options.readEntries;
    this.#now = options.now ?? (() => new Date());
  }

  #month(now: Date): MonthAccounting {
    const { start, end } = monthWindow(now);
    const result: MonthAccounting = { spent: new Map(), unknownCostCalls: new Map(), unavailable: false, start, end };
    let entries: GatewayLogEntry[];
    try {
      entries = this.#readEntries(start);
      if (!Array.isArray(entries)) throw new Error("Invalid usage ledger");
    } catch { result.unavailable = true; return result; }
    for (const entry of entries) {
      if (!validEntry(entry)) { result.unavailable = true; continue; }
      const at = Date.parse(entry.at);
      if (at < start.getTime() || at >= end.getTime() || at > now.getTime()) continue;
      // A flat subscription's fee must never become per-call spend.
      if (entry.costNote === "subscription") continue;
      // Legacy entries may omit providerId; their exposed model still identifies the source.
      const slash = entry.model.indexOf("/");
      const id = entry.providerId ?? (slash > 0 ? entry.model.slice(0, slash) : undefined);
      if (!id) {
        if (entry.costUsd !== undefined && entry.costUsd > 0) result.unavailable = true;
        continue;
      }
      const priced = entry.costUsd !== undefined && entry.costNote !== "unpriced";
      const metered = entry.inputTokens !== undefined && entry.outputTokens !== undefined;
      if (priced) {
        const total = (result.spent.get(id) ?? 0) + entry.costUsd!;
        if (!Number.isFinite(total)) result.unavailable = true;
        result.spent.set(id, Number.isFinite(total) ? total : Number.MAX_VALUE);
      }
      if (!priced || !metered) result.unknownCostCalls.set(id, (result.unknownCostCalls.get(id) ?? 0) + 1);
    }
    return result;
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
    try { settings = validateProviderBudget(provider.budget); } catch { /* Invalid persisted controls fail closed. */ }
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
    return {
      spent, limit, ratio, level, stop, blocked, accountingUnavailable: month.unavailable, configurationInvalid,
      unknownCostCalls, startsAt: month.start.toISOString(), resetsAt: month.end.toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(warning ? { warning } : {}), limitations: LIMITATIONS,
    };
  }

  isBudgetStopped(provider: BudgetProvider): boolean {
    return this.budgetStatus(provider)?.blocked ?? false;
  }
}
