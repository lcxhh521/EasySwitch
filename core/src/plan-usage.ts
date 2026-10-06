import { recordWindows, type QuotaWindow } from "./quota.ts";
import type { Provider } from "./types.ts";

/**
 * What is left of a coding plan that is used with a key (Kimi, MiniMax): these vendors answer a question about it,
 * unlike the plans that put it on every reply. The key is sent only to the vendor's own host named here, and only
 * for a provider whose address is that host's.
 *
 * The shapes below come from reading opencodex's readers (MIT); they have not been checked against a live account,
 * so each is read leniently and a shape that is not recognised simply shows nothing.
 */

type Json = Record<string, any>;

interface Reader { host: RegExp; url: (provider: Provider) => string; parse: (body: Json, now: number) => QuotaWindow[] }

const number = (v: unknown): number | undefined => { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : undefined; };

function timeOf(v: unknown): number | undefined {
  if (typeof v === "string" && Number.isNaN(Number(v))) { const t = Date.parse(v); return Number.isNaN(t) ? undefined : t; }
  const n = number(v);
  return n === undefined ? undefined : n < 1e11 ? n * 1000 : n;
}

/** One window from an object that says limit and remaining (or used), and when it resets. */
function windowOf(id: QuotaWindow["id"], o: Json | undefined, minutes?: number): QuotaWindow | undefined {
  if (!o || typeof o !== "object") return undefined;
  const limit = number(o.limit);
  const remaining = number(o.remaining);
  const used = number(o.used);
  let percent: number | undefined;
  if (limit && limit > 0) percent = remaining !== undefined ? ((limit - remaining) / limit) * 100 : used !== undefined ? (used / limit) * 100 : undefined;
  if (percent === undefined) return undefined;
  const resetAt = timeOf(o.resetTime ?? o.reset_time ?? o.resetAt ?? o.reset_at);
  return { id, usedPercent: Math.max(0, Math.min(100, percent)), ...(resetAt ? { resetAt } : {}), ...(minutes ? { windowMinutes: minutes } : {}) };
}

function minutesOf(window: Json | undefined): number | undefined {
  const duration = number(window?.duration);
  if (!duration) return undefined;
  const unit = String(window?.timeUnit ?? window?.time_unit ?? "");
  return /MINUTE/i.test(unit) ? duration : /HOUR/i.test(unit) ? duration * 60 : /DAY/i.test(unit) ? duration * 1440 : undefined;
}

const READERS: Reader[] = [
  {
    // Kimi Code: `usage` is the weekly total, `limits[]` the shorter windows (each with a `window` and a `detail`).
    host: /^api\.kimi\.(com|ai)$/,
    url: p => `${new URL(p.baseUrl).origin}/coding/v1/usages`,
    parse: body => {
      const limits = Array.isArray(body.limits) ? (body.limits as Json[]) : [];
      const short = limits.map(l => windowOf("primary", l.detail ?? l, minutesOf(l.window))).filter((w): w is QuotaWindow => !!w).sort((a, b) => (a.windowMinutes ?? 1e9) - (b.windowMinutes ?? 1e9))[0];
      const weekly = windowOf(short ? "secondary" : "primary", body.usage, 10080);
      return [short, weekly].filter((w): w is QuotaWindow => !!w);
    },
  },
  {
    // MiniMax Token Plan: the remaining share of the five-hour window and, when there is one, of the weekly window.
    host: /^api\.(?:minimax\.io|minimaxi\.com)$/,
    url: p => `${new URL(p.baseUrl).origin}/v1/api/openplatform/coding_plan/remains`,
    parse: body => {
      if (number(body.base_resp?.status_code) !== 0) return [];
      const row = (Array.isArray(body.model_remains) ? (body.model_remains as Json[]) : []).find(r => r.model_name === "general");
      if (!row) return [];
      const out: QuotaWindow[] = [];
      const left = number(row.current_interval_remaining_percent);
      if (left !== undefined) { const resetAt = timeOf(row.end_time); out.push({ id: "primary", usedPercent: Math.max(0, Math.min(100, 100 - left)), windowMinutes: 300, ...(resetAt ? { resetAt } : {}) }); }
      const weeklyLeft = number(row.current_weekly_remaining_percent);
      if (number(row.current_weekly_status) === 1 && weeklyLeft !== undefined) { const resetAt = timeOf(row.weekly_end_time); out.push({ id: "secondary", usedPercent: Math.max(0, Math.min(100, 100 - weeklyLeft)), windowMinutes: 10080, ...(resetAt ? { resetAt } : {}) }); }
      return out;
    },
  },
];

function readerFor(provider: Provider): Reader | undefined {
  if (provider.plan || provider.kiro || provider.cursor || provider.antigravity || provider.vertex || provider.mimoFree) return undefined;
  try {
    const url = new URL(provider.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return undefined;
    if (provider.kimi && !/^api\.kimi\.(com|ai)$/.test(url.hostname)) return undefined;
    return READERS.find(r => r.host.test(url.hostname));
  } catch { return undefined; }
}

export const hasPlanUsage = (provider: Provider): boolean => readerFor(provider) !== undefined;

/** Asks the vendor how much of the plan is left and remembers the answer (the pools skip a plan that is used up). */
export async function refreshPlanUsage(provider: Provider, apiKey: string | undefined, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<QuotaWindow[] | undefined> {
  const reader = readerFor(provider);
  if (!reader || !apiKey) return undefined;
  try {
    const response = await fetchFn(reader.url(provider), { redirect: "error", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) { await response.body?.cancel(); return undefined; }
    const windows = reader.parse((await response.json()) as Json, now);
    if (!windows.length) return undefined;
    recordWindows(provider.id, windows, now);
    return windows;
  } catch { return undefined; }
}
