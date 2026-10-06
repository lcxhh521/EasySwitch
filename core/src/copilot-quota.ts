/** Official Copilot SDK account.getQuota response facts; no SDK, process, account or network access. */
export const COPILOT_QUOTA_DOCS = "https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/usage-and-billing#account-quota-and-premium-interactions";
export type CopilotQuotaKind = "premium_interactions" | "chat" | "completions";
export interface CopilotQuotaSnapshot {
  kind: CopilotQuotaKind;
  entitlementRequests: number;
  usedRequests: number;
  unlimited: boolean;
  remainingPercentage?: number;
  resetAt?: string;
}
const kinds: readonly CopilotQuotaKind[] = ["premium_interactions", "chat", "completions"];
const labels: Record<CopilotQuotaKind, string> = { premium_interactions: "高级请求", chat: "聊天", completions: "代码补全" };

/** A documented contract is not a connected reader. No guessed HTTP endpoint or borrowed native token. */
export function copilotQuotaCapability() {
  return { state: "not-connected" as const, method: "official-sdk" as const, canRefresh: false as const,
    text: "尚未接入官方额度读取，剩余次数和恢复时间未知；请在 Copilot 官方界面查看。", docsUrl: COPILOT_QUOTA_DOCS };
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  try { const field = Object.getOwnPropertyDescriptor(value, key); return field && "value" in field ? field.value : undefined; }
  catch { return undefined; }
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
function resetDate(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 35 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(5, 7)), day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined || day < 1 || day > days) return undefined;
  const time = Date.parse(value); return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

/** Only the three documented categories and their public numeric fields cross this boundary. */
export function parseCopilotQuota(value: unknown): CopilotQuotaSnapshot[] {
  const quota = own(value, "quotaSnapshots"), out: CopilotQuotaSnapshot[] = [];
  for (const kind of kinds) {
    const row = own(quota, kind), entitlement = own(row, "entitlementRequests"), used = own(row, "usedRequests");
    if (!(entitlement === -1 || finite(entitlement)) || !finite(used)) continue;
    const remaining = own(row, "remainingPercentage"), reset = resetDate(own(row, "resetDate"));
    // Missing or invalid percentages remain unknown; counts do not imply a reset schedule or usable model.
    out.push({ kind, entitlementRequests: entitlement, usedRequests: used, unlimited: entitlement === -1,
      ...(entitlement !== -1 && finite(remaining) && remaining <= 100 ? { remainingPercentage: remaining } : {}), ...(reset ? { resetAt: reset } : {}) });
  }
  return out;
}

/** Snapshot-only presentation. Never feed this disconnected snapshot contract into pool routing. */
export function describeCopilotQuota(snapshots: readonly CopilotQuotaSnapshot[]): string | undefined {
  if (!snapshots.length) return undefined;
  return snapshots.map(row => `${labels[row.kind]}：已用 ${row.usedRequests}${row.unlimited ? "，此项不限次数" : ` / ${row.entitlementRequests} 次${row.remainingPercentage !== undefined ? `，剩余 ${row.remainingPercentage}%` : "，剩余比例未知"}`}${row.resetAt ? `，重置时间 ${row.resetAt}` : "，重置时间未知"}`).join("；");
}
