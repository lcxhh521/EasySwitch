/**
 * What is left of a subscription, learned from what the subscription itself says.
 *
 * ChatGPT / Codex plans put their usage on every answer as headers (`x-codex-primary-used-percent`,
 * `-secondary-`, with the window length and the moment it resets), and answer 429 when the plan is used
 * up. Nothing is asked of the account on the side: this only reads what already passed through the
 * gateway. It is kept in memory (a restart forgets it and the next answer teaches it again).
 *
 * The state feeds two things: the console shows how much is left and when it comes back, and the
 * pools stop trying a member whose plan is used up until it is back, instead of resting it a fixed
 * minute and hitting the same wall again.
 */

export interface QuotaWindow {
  /** "primary" is the short window the plan reports first, "secondary" the longer one. */
  id: "primary" | "secondary";
  usedPercent: number;
  /** When it resets, ms since the epoch. */
  resetAt?: number;
  windowMinutes?: number;
}

export interface QuotaState {
  windows: QuotaWindow[];
  /** The plan said it is used up; no request is sent to it before this moment. */
  exhaustedUntil?: number;
  /** True only when a full reported window supplies the reset; otherwise this is a local retry time. */
  exhaustionResetKnown?: boolean;
  updatedAt: number;
}

/** Plans that refuse without saying when they come back: try again after this long. */
export const DEFAULT_EXHAUSTED_MS = 30 * 60_000;
/** A window at or above this is treated as used up even before the plan says no. */
export const FULL_PERCENT = 99.5;

const states = new Map<string, QuotaState>();

function num(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Reset moments arrive as epoch seconds (or ms): both become ms. */
export function toMs(value: number): number {
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

export function parseQuotaHeaders(headers: Headers, now = Date.now()): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  for (const id of ["primary", "secondary"] as const) {
    const used = num(headers.get(`x-codex-${id}-used-percent`));
    if (used === undefined) continue;
    const reset = num(headers.get(`x-codex-${id}-reset-at`));
    const after = num(headers.get(`x-codex-${id}-reset-after-seconds`));
    const minutes = num(headers.get(`x-codex-${id}-window-minutes`));
    const resetAt = reset !== undefined ? toMs(reset) : after !== undefined ? now + after * 1000 : undefined;
    windows.push({ id, usedPercent: Math.min(100, used), ...(resetAt !== undefined ? { resetAt } : {}), ...(minutes !== undefined ? { windowMinutes: minutes } : {}) });
  }
  return windows;
}

/** Remembers the windows a plan reported; a full one means it will refuse until that window resets. */
export function recordWindows(providerId: string, windows: QuotaWindow[], now = Date.now()): void {
  if (!windows.length) return;
  const before = states.get(providerId);
  const state: QuotaState = { windows, updatedAt: now, ...(before?.exhaustedUntil && before.exhaustedUntil > now ? { exhaustedUntil: before.exhaustedUntil, exhaustionResetKnown: before.exhaustionResetKnown } : {}) };
  const full = windows.filter(w => w.usedPercent >= FULL_PERCENT && w.resetAt && w.resetAt > now);
  if (full.length) { state.exhaustedUntil = Math.max(...full.map(w => w.resetAt!)); state.exhaustionResetKnown = true; }
  else if (state.exhaustedUntil && windows.every(w => w.usedPercent < FULL_PERCENT)) { delete state.exhaustedUntil; delete state.exhaustionResetKnown; }
  states.set(providerId, state);
}

/** Remembers what an answer from this provider said about its quota (any status). */
export function recordQuotaHeaders(providerId: string, headers: Headers, now = Date.now()): void {
  recordWindows(providerId, parseQuotaHeaders(headers, now), now);
}

/** Does this refusal mean "the plan is used up" (and not "slow down a moment" or a bad key)? */
export function isUsageLimit(status: number, bodyText: string): boolean {
  if (status !== 429) return false;
  // "rate_limit_exceeded" is the per-minute kind (wait a moment); this is about the plan itself being used up.
  if (/rate_limit_exceeded|requests per min|tokens per min/i.test(bodyText)) return false;
  return /usage[_ ]limit|insufficient_quota|quota (exceeded|reached)|exhaust|used up|hit your .{0,24}limit/i.test(bodyText);
}

/** The plan refused because it is used up: no more requests until it is back. */
export function recordLimitReached(providerId: string, now = Date.now()): void {
  const before = states.get(providerId);
  const known = before?.windows.filter(w => w.usedPercent >= FULL_PERCENT && w.resetAt && w.resetAt > now).map(w => w.resetAt!) ?? [];
  const resetHints = before?.windows.map(w => w.resetAt).filter((t): t is number => typeof t === "number" && t > now) ?? [];
  // The full window's reset if known; otherwise the soonest reset the plan mentioned; otherwise a wait.
  const until = known.length ? Math.max(...known) : resetHints.length ? Math.min(...resetHints) : now + DEFAULT_EXHAUSTED_MS;
  states.set(providerId, { windows: before?.windows ?? [], updatedAt: now, exhaustedUntil: until, exhaustionResetKnown: known.length > 0 });
}

export function isExhausted(providerId: string, now = Date.now()): boolean {
  const until = states.get(providerId)?.exhaustedUntil;
  return until !== undefined && until > now;
}

export function exhaustedUntil(providerId: string, now = Date.now()): number | undefined {
  const until = states.get(providerId)?.exhaustedUntil;
  return until !== undefined && until > now ? until : undefined;
}

export function quotaOf(providerId: string): QuotaState | undefined {
  return states.get(providerId);
}

export function clearQuota(): void {
  states.clear();
}

/** One line for people: "已用 62%（5 小时窗口），14:30 恢复" or "已用完，14:30 恢复". */
export function describeQuota(state: QuotaState | undefined, now = Date.now()): string | undefined {
  if (!state) return undefined;
  const clock = (ms: number) => {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date(now).toDateString();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  const until = state.exhaustedUntil && state.exhaustedUntil > now ? state.exhaustedUntil : undefined;
  if (until) return state.exhaustionResetKnown ? `已用完，${clock(until)} 恢复` : `额度暂不可用，${clock(until)} 后可重试（恢复时间未知）`;
  const shown = [...state.windows].sort((a, b) => b.usedPercent - a.usedPercent)[0];
  if (!shown) return undefined;
  const length = shown.windowMinutes ? (shown.windowMinutes >= 1440 ? `${Math.round(shown.windowMinutes / 1440)} 天` : `${Math.round(shown.windowMinutes / 60)} 小时`) : undefined;
  return `已用 ${Math.round(shown.usedPercent)}%${length ? `（${length}窗口）` : ""}${shown.resetAt ? `，${clock(shown.resetAt)} 恢复` : ""}`;
}

/** Kimi Code documents these quota refusals as 403; other 403s (including concurrency) are not quota. */
export function isKimiUsageLimit(status: number, bodyText: string): boolean {
  if (status !== 403) return isUsageLimit(status, bodyText);
  if (bodyText.length > 16_384) return false;
  let message = bodyText.trim();
  try {
    const body = JSON.parse(message) as { error?: { message?: unknown }; message?: unknown };
    const value = body?.error?.message ?? body?.message;
    if (typeof value !== "string") return false;
    message = value;
  } catch { /* The documented human-readable refusal is also accepted as plain text. */ }
  return /^You've reached your (?:5-hour|weekly \(7-day\)) usage limit\.(?:\s|$)/.test(message)
    || /^You've reached your monthly usage limit for this billing cycle\.(?:\s|$)/.test(message);
}
