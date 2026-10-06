import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GatewayLogEntry } from "./types.ts";

export interface BudgetSettings {
  enabled: boolean;
  /** Estimated pay-as-you-go USD; not a vendor invoice or a prepaid account balance. */
  limitUsd: number;
  period: "day" | "month";
  action: "warn" | "stop";
  /** Fraction of the limit at which a reminder is shown, in (0, 1]. */
  warnAt: number;
}

export interface BudgetStatus {
  settings: BudgetSettings;
  timezone: "UTC";
  startsAt: string;
  resetsAt: string;
  estimatedCostUsd: number;
  remainingUsd: number;
  calls: number;
  unpricedCalls: number;
  unmeteredCalls: number;
  subscriptionCalls: number;
  /** Union of unpriced and unmetered non-subscription calls, not their sum. */
  unknownCostCalls: number;
  accountingUnavailable: boolean;
  configurationInvalid: boolean;
  exceeded: boolean;
  blocked: boolean;
  warning?: string;
  limitations: string;
}

export const DEFAULT_BUDGET: Readonly<BudgetSettings> = Object.freeze({ enabled: false, limitUsd: 10, period: "month", action: "warn", warnAt: 0.8 });
const LIMITATIONS = "按 UTC 日/月累计已记录的美元估算费用，不是供应商账单。未知价格、缺少用量、正在进行的请求和网关外的调用可能使实际费用超过预算；订阅月费不计入。停用仅阻止之后的新推理请求。";

/** Validate without coercion: malformed or misspelled controls must not silently weaken a stop. */
export function validateBudgetSettings(value: unknown): BudgetSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("需要完整的预算设置");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["enabled", "limitUsd", "period", "action", "warnAt"]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw new TypeError("预算设置含未知字段");
  if (typeof input.enabled !== "boolean") throw new TypeError("请选择是否开启预算");
  if (typeof input.limitUsd !== "number" || !Number.isFinite(input.limitUsd) || input.limitUsd < 0 || input.limitUsd > 1_000_000_000) throw new TypeError("美元预算必须是 0 到 10 亿之间的数字");
  if (input.period !== "day" && input.period !== "month") throw new TypeError("预算周期只能是 day 或 month");
  if (input.action !== "warn" && input.action !== "stop") throw new TypeError("超额动作只能是 warn 或 stop");
  if (typeof input.warnAt !== "number" || !Number.isFinite(input.warnAt) || input.warnAt <= 0 || input.warnAt > 1) throw new TypeError("提醒比例必须大于 0 且不超过 1");
  return { enabled: input.enabled, limitUsd: input.limitUsd, period: input.period, action: input.action, warnAt: input.warnAt };
}

/** Explicit UTC boundaries make desktop timezone changes unable to reset a budget early. */
export function budgetWindow(period: BudgetSettings["period"], now: Date): { start: Date; end: Date } {
  const year = now.getUTCFullYear(), month = now.getUTCMonth(), day = now.getUTCDate();
  return period === "day"
    ? { start: new Date(Date.UTC(year, month, day)), end: new Date(Date.UTC(year, month, day + 1)) }
    : { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

export class BudgetExceededError extends Error {
  readonly status = 429;
  readonly code = "budget_exceeded";
  readonly budget: BudgetStatus;
  constructor(budget: BudgetStatus) {
    super(budget.warning ?? "已达到估算预算，新推理请求已暂停");
    this.name = "BudgetExceededError";
    this.budget = budget;
  }
}

/**
 * The caller supplies the durable ledger reader (or an in-memory reader in tests).
 * This module never probes a provider, launches an agent or reads a credential.
 * Integrate assertAllowed immediately before every inference route, outside pool retries.
 */
export class BudgetController {
  #file: string;
  #settings: BudgetSettings = { ...DEFAULT_BUDGET };
  #configurationInvalid = false;
  #readEntries: (since: Date) => GatewayLogEntry[];
  #now: () => Date;

  constructor(dir: string, options: { readEntries: (since: Date) => GatewayLogEntry[]; now?: () => Date }) {
    mkdirSync(dir, { recursive: true });
    this.#file = join(dir, "budget.json");
    this.#readEntries = options.readEntries;
    this.#now = options.now ?? (() => new Date());
    if (existsSync(this.#file)) {
      try {
        const raw = readFileSync(this.#file, "utf8");
        if (raw.length > 65_536) throw new Error("Oversized budget settings");
        this.#settings = validateBudgetSettings(JSON.parse(raw));
      } catch { this.#configurationInvalid = true; }
    }
  }

  settings(): BudgetSettings { return { ...this.#settings }; }

  setSettings(value: unknown): BudgetSettings {
    const settings = validateBudgetSettings(value);
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      renameSync(temp, this.#file);
    } finally { rmSync(temp, { force: true }); }
    this.#settings = settings;
    this.#configurationInvalid = false;
    return this.settings();
  }

  status(): BudgetStatus {
    const settings = this.settings();
    const now = this.#now();
    const { start, end } = budgetWindow(settings.period, now);
    let entries: GatewayLogEntry[] = [], accountingUnavailable = false;
    try {
      entries = this.#readEntries(start);
      if (!Array.isArray(entries)) throw new Error("Invalid ledger");
    } catch { accountingUnavailable = true; }
    let estimatedCostUsd = 0, calls = 0, unpricedCalls = 0, unmeteredCalls = 0, subscriptionCalls = 0, unknownCostCalls = 0;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || !Number.isFinite(Date.parse(entry.at))) { accountingUnavailable = true; continue; }
      const at = Date.parse(entry.at);
      if (at < start.getTime() || at >= end.getTime() || at > now.getTime()) continue;
      calls++;
      // A flat subscription's tokens are useful, but its monthly fee is not a per-call expense.
      if (entry.costNote === "subscription") { subscriptionCalls++; continue; }
      const metered = [entry.inputTokens, entry.outputTokens].some(n => typeof n === "number" && Number.isFinite(n) && n >= 0);
      const priced = typeof entry.costUsd === "number" && Number.isFinite(entry.costUsd) && entry.costUsd >= 0 && entry.costNote !== "unpriced";
      if (priced) estimatedCostUsd += entry.costUsd!;
      else unpricedCalls++;
      if (!metered) unmeteredCalls++;
      if (!priced || !metered) unknownCostCalls++;
    }
    if (!Number.isFinite(estimatedCostUsd)) { estimatedCostUsd = Number.MAX_VALUE; accountingUnavailable = true; }
    const exceeded = settings.enabled && estimatedCostUsd >= settings.limitUsd;
    const blocked = this.#configurationInvalid || (settings.enabled && settings.action === "stop" && (exceeded || accountingUnavailable));
    let warning: string | undefined;
    if (this.#configurationInvalid) warning = "预算设置无法读取；新推理请求已暂停，请在控制台重新保存预算设置";
    else if (settings.enabled && accountingUnavailable) warning = settings.action === "stop" ? "用量记录无法完整读取；新推理请求已暂停" : "用量记录无法完整读取，预算估算可能不完整";
    else if (exceeded) warning = settings.action === "stop" ? "已达到估算预算，新推理请求已暂停" : "已达到估算预算；当前为仅提醒，仍会继续请求";
    else if (settings.enabled && estimatedCostUsd >= settings.limitUsd * settings.warnAt) warning = "已接近估算预算";
    else if (settings.enabled && unknownCostCalls) warning = "有请求缺少价格或用量，实际费用可能高于当前估算";
    return {
      settings, timezone: "UTC", startsAt: start.toISOString(), resetsAt: end.toISOString(), estimatedCostUsd,
      remainingUsd: Math.max(0, settings.limitUsd - estimatedCostUsd), calls, unpricedCalls, unmeteredCalls,
      subscriptionCalls, unknownCostCalls, accountingUnavailable, configurationInvalid: this.#configurationInvalid,
      exceeded, blocked, ...(warning ? { warning } : {}), limitations: LIMITATIONS,
    };
  }

  assertAllowed(): BudgetStatus {
    const status = this.status();
    if (status.blocked) throw new BudgetExceededError(status);
    return status;
  }
}
