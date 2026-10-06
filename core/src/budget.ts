import type { GatewayLogEntry, Provider } from "./types.ts";

/**
 * A monthly budget for a model source. What each call cost (the estimate the ledger already makes at the vendor's own
 * prices) is added up per source for the current calendar month; a source that has a budget shows how much of it is
 * gone, and one that is set to stop is used nowhere (like a switched-off subscription) until the month turns.
 * The totals live in memory and are rebuilt from the ledger at start, so a restart does not forget the month.
 */

const monthOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
let current = monthOf(new Date());
const spend = new Map<string, number>();

function roll(now: Date): void {
  const m = monthOf(now);
  if (m !== current) { current = m; spend.clear(); }
}

export function addSpend(providerId: string, usd: number, at: Date = new Date()): void {
  if (!(usd > 0)) return;
  roll(new Date());
  if (monthOf(at) !== current) return;
  spend.set(providerId, (spend.get(providerId) ?? 0) + usd);
}

/** Rebuilds this month's totals from what the ledger holds. */
export function loadMonth(entries: GatewayLogEntry[], now: Date = new Date()): void {
  current = monthOf(now);
  spend.clear();
  for (const e of entries) if (e.providerId && e.costUsd && monthOf(new Date(e.at)) === current) spend.set(e.providerId, (spend.get(e.providerId) ?? 0) + e.costUsd);
}

export function monthStart(now: Date = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

export function spentThisMonth(providerId: string, now: Date = new Date()): number {
  roll(now);
  return spend.get(providerId) ?? 0;
}

export interface BudgetStatus {
  spent: number;
  limit: number;
  /** 0..: how much of the budget is gone. */
  ratio: number;
  /** ok under 80%, near from 80%, over from 100%. */
  level: "ok" | "near" | "over";
  stop: boolean;
}

export function budgetStatus(provider: Pick<Provider, "id" | "budget">, now: Date = new Date()): BudgetStatus | undefined {
  const b = provider.budget;
  if (!b || !(b.monthlyUsd > 0)) return undefined;
  const spent = spentThisMonth(provider.id, now);
  const ratio = spent / b.monthlyUsd;
  return { spent, limit: b.monthlyUsd, ratio, level: ratio >= 1 ? "over" : ratio >= 0.8 ? "near" : "ok", stop: b.stop === true };
}

/** A source set to stop whose month's budget is gone: used nowhere until the month turns. */
export function isBudgetStopped(provider: Pick<Provider, "id" | "budget">, now: Date = new Date()): boolean {
  const s = budgetStatus(provider, now);
  return Boolean(s && s.stop && s.level === "over");
}

export function clearSpend(): void { spend.clear(); current = monthOf(new Date()); }
