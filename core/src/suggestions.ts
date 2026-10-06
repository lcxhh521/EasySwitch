import { createHash } from "node:crypto";
import { ruleMatches, type DispatchRule, type DispatchThen, type DispatchWhen } from "./dispatch.ts";
import { validTaskFeedback, type TaskFeedback } from "./feedback.ts";
import type { Task } from "./tasks.ts";

/** Only exact, complete task attribution belongs here; never infer from agent/time overlap. */
export interface TaskUsage { taskId: string; costUsd?: number; unknownCost: boolean }
export interface SuggestionPolicy {
  minSamples: number;
  minGoodRate: number;
  maxGoodRateDrop: number;
  minSavingsRate: number;
  maxMedianSizeRatio: number;
  maxAgeDays: number;
}
export const DEFAULT_SUGGESTION_POLICY: Readonly<SuggestionPolicy> = Object.freeze({ minSamples: 5, minGoodRate: 0.8, maxGoodRateDrop: 0.05, minSavingsRate: 0.2, maxMedianSizeRatio: 1.5, maxAgeDays: 90 });
export interface CandidateEvidence {
  target: Required<Pick<DispatchThen, "agent" | "model">> & Pick<DispatchThen, "effort">;
  samples: number;
  good: number;
  goodRate: number;
  pricedSamples: number;
  medianCostUsd?: number;
  meanCostUsd?: number;
  medianTaskChars: number;
}
export interface RuleSuggestion {
  id: string;
  sourceRuleId: string;
  insertBeforeRuleId: string;
  draft: Omit<DispatchRule, "id">;
  evidence: { baseline: CandidateEvidence; candidate: CandidateEvidence; savingsRate: number; qualityRateDrop: number; policy: SuggestionPolicy };
  summary: string;
  caveats: string[];
}
export interface SuggestionIssue { ruleId?: string; code: string; message: string; samples?: number }
export interface SuggestionReport { suggestions: RuleSuggestion[]; evaluatedRatings: number; insufficient: SuggestionIssue[] }

const EPS = 1e-12;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
const targetKey = (target: DispatchThen) => JSON.stringify([target.agent, target.model ?? "", target.effort ?? ""]);
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : sorted[mid - 1]! + (sorted[mid]! - sorted[mid - 1]!) / 2;
};
const mean = (values: number[]): number => values.reduce((average, value, i) => average + (value - average) / (i + 1), 0);

function policyOf(value: Partial<SuggestionPolicy> | undefined): SuggestionPolicy {
  const p = { ...DEFAULT_SUGGESTION_POLICY, ...value };
  if (Object.keys(p).some(k => !(k in DEFAULT_SUGGESTION_POLICY)) || !Number.isInteger(p.minSamples) || p.minSamples < 5 || p.minSamples > 10_000
    || !Number.isFinite(p.minGoodRate) || p.minGoodRate < 0.8 || p.minGoodRate > 1
    || !Number.isFinite(p.maxGoodRateDrop) || p.maxGoodRateDrop < 0 || p.maxGoodRateDrop > 0.05
    || !Number.isFinite(p.minSavingsRate) || p.minSavingsRate < 0.2 || p.minSavingsRate > 1
    || !Number.isFinite(p.maxMedianSizeRatio) || p.maxMedianSizeRatio < 1 || p.maxMedianSizeRatio > 1.5
    || !Number.isFinite(p.maxAgeDays) || p.maxAgeDays <= 0 || p.maxAgeDays > 90) throw new TypeError("建议阈值只能在默认保守范围内收紧");
  return p;
}

/** Canonicalize equivalent simple conditions; an unsupported condition is never silently dropped. */
function condition(when: DispatchWhen): { when: DispatchWhen; key: string; categorized: boolean } | undefined {
  if (!when || typeof when !== "object" || Array.isArray(when) || Object.keys(when).some(k => !["anyWords", "regex", "minChars", "maxChars", "cwdPrefix", "from"].includes(k))) return undefined;
  if (when.regex !== undefined && when.regex !== "") return undefined;
  const normalized: DispatchWhen = {};
  if (when.anyWords !== undefined) {
    if (!Array.isArray(when.anyWords) || when.anyWords.some(w => typeof w !== "string")) return undefined;
    const words = [...new Set(when.anyWords.filter(Boolean).map(w => w.toLowerCase()))].sort();
    if (words.length) normalized.anyWords = words;
  }
  for (const key of ["minChars", "maxChars"] as const) {
    const n = when[key];
    if (n !== undefined) { if (!Number.isInteger(n) || n < 0) return undefined; if (key !== "minChars" || n !== 0) normalized[key] = n; }
  }
  if (normalized.minChars !== undefined && normalized.maxChars !== undefined && normalized.minChars > normalized.maxChars) return undefined;
  if (when.cwdPrefix !== undefined) { if (typeof when.cwdPrefix !== "string" || !when.cwdPrefix.startsWith("/")) return undefined; normalized.cwdPrefix = when.cwdPrefix; }
  if (when.from !== undefined) { if (typeof when.from !== "string") return undefined; if (when.from) normalized.from = when.from; }
  return { when: normalized, key: hash(normalized), categorized: Boolean(normalized.anyWords?.length || normalized.minChars !== undefined || normalized.maxChars !== undefined || normalized.cwdPrefix) };
}

function usableTask(task: Task, now: number, oldest: number): boolean {
  return Boolean(task && typeof task.id === "string" && typeof task.agent === "string" && task.agent && task.agent !== "auto"
    && typeof task.model === "string" && task.model && typeof task.task === "string" && task.task.trim()
    && typeof task.from === "string" && (task.cwd === undefined || typeof task.cwd === "string")
    && (task.effort === undefined || typeof task.effort === "string")
    && ["done", "failed", "timeout"].includes(task.status) && Number.isFinite(Date.parse(task.at)) && Date.parse(task.at) >= oldest && Date.parse(task.at) <= now);
}

interface Sample { task: Task; feedback: TaskFeedback; usage?: TaskUsage }
function evidence(samples: Sample[]): CandidateEvidence {
  const task = samples[0]!.task;
  const prices = samples.filter(s => s.usage?.unknownCost === false && typeof s.usage.costUsd === "number" && Number.isFinite(s.usage.costUsd) && s.usage.costUsd >= 0).map(s => s.usage!.costUsd!);
  const good = samples.filter(s => s.feedback.rating === "good").length;
  return {
    target: { agent: task.agent, model: task.model, ...(task.effort ? { effort: task.effort } : {}) }, samples: samples.length,
    good, goodRate: good / samples.length, pricedSamples: prices.length,
    ...(prices.length ? { medianCostUsd: median(prices), meanCostUsd: mean(prices) } : {}), medianTaskChars: median(samples.map(s => s.task.task.length)),
  };
}

function duplicates(rule: DispatchRule, whenKey: string, target: CandidateEvidence["target"], resolved: DispatchThen | undefined): boolean {
  return condition(rule.when)?.key === whenKey && Boolean(resolved?.model) && targetKey(resolved!) === targetKey(target);
}

/**
 * Local descriptive evidence, not a statistical significance or causal-quality claim.
 * No I/O and no model calls. Prompts are inspected only to reuse existing rule
 * conditions and compare task sizes; neither prompts nor outputs enter the result.
 */
export function buildRuleSuggestions(input: {
  tasks: readonly Task[]; feedback: readonly TaskFeedback[]; rules: readonly DispatchRule[]; usage: readonly TaskUsage[];
  now?: Date; policy?: Partial<SuggestionPolicy>;
  isTargetAvailable?: (target: CandidateEvidence["target"]) => boolean;
  /** Resolve omitted model/effort from current configuration, never from historical popularity. */
  resolveRuleTarget?: (rule: DispatchRule) => DispatchThen | undefined;
}): SuggestionReport {
  const report: SuggestionReport = { suggestions: [], evaluatedRatings: 0, insufficient: [] };
  if (!input.feedback.length) return report;
  const policy = policyOf(input.policy), now = (input.now ?? new Date()).getTime(), oldest = now - policy.maxAgeDays * 86_400_000;
  if (!Number.isFinite(now)) throw new TypeError("需要有效的比较时间");
  const resolvedTargets = new Map<DispatchRule, DispatchThen | undefined>();
  const resolveTarget = (rule: DispatchRule): DispatchThen | undefined => {
    if (resolvedTargets.has(rule)) return resolvedTargets.get(rule);
    const value = input.resolveRuleTarget ? input.resolveRuleTarget(rule) : rule.then;
    const valid = value && value.agent === rule.then.agent && typeof value.model === "string" && value.model
      && (value.effort === undefined || typeof value.effort === "string")
      && (!rule.then.model || value.model === rule.then.model) && (!rule.then.effort || value.effort === rule.then.effort);
    const target = valid ? { agent: value.agent, model: value.model!, ...(value.effort ? { effort: value.effort } : {}) } : undefined;
    resolvedTargets.set(rule, target); return target;
  };
  const ratings = new Map<string, TaskFeedback>(), invalidRatings = new Set<string>();
  for (const rating of input.feedback) {
    if (!validTaskFeedback(rating) || Date.parse(rating.at) > now) continue;
    const existing = ratings.get(rating.taskId);
    if (existing && Date.parse(existing.at) === Date.parse(rating.at) && existing.rating !== rating.rating) invalidRatings.add(rating.taskId);
    if (!existing || Date.parse(existing.at) < Date.parse(rating.at)) { ratings.set(rating.taskId, rating); invalidRatings.delete(rating.taskId); }
  }
  const tasks = new Map<string, Task>(), ambiguousTasks = new Set<string>();
  for (const task of input.tasks) {
    if (!usableTask(task, now, oldest)) continue;
    const existing = tasks.get(task.id);
    if (existing && hash([existing.agent, existing.model, existing.effort, existing.at, existing.status, existing.task, existing.cwd, existing.from]) !== hash([task.agent, task.model, task.effort, task.at, task.status, task.task, task.cwd, task.from])) ambiguousTasks.add(task.id);
    else tasks.set(task.id, task);
  }
  const usages = new Map<string, TaskUsage>(), ambiguousUsage = new Set<string>();
  for (const usage of input.usage) {
    if (!usage || typeof usage.taskId !== "string") continue;
    const existing = usages.get(usage.taskId);
    // Several request rows are not one task total, even if their costs happen
    // to match. The integration must aggregate exact attribution first.
    if (existing) ambiguousUsage.add(usage.taskId);
    else usages.set(usage.taskId, usage);
  }
  const categories = input.rules.map(rule => ({ rule, condition: condition(rule.when) }));
  const groups = new Map<string, { rule: DispatchRule; condition: NonNullable<ReturnType<typeof condition>>; samples: Map<string, Sample[]> }>();
  let unclassified = 0;
  for (const [id, feedback] of ratings) {
    const task = tasks.get(id);
    if (!task || invalidRatings.has(id) || ambiguousTasks.has(id) || Date.parse(feedback.at) < Date.parse(task.at)) continue;
    report.evaluatedRatings++;
    let found: typeof categories[number] | undefined;
    for (const category of categories) {
      if (!category.rule.enabled) continue;
      // Do not run arbitrary regular expressions or pretend a later rule was
      // the first match when a preceding unsupported condition might catch it.
      if (!category.condition) break;
      if (ruleMatches(category.rule, { task: task.task, from: task.from, ...(task.cwd ? { cwd: task.cwd } : {}) })) { if (category.condition.categorized) found = category; break; }
    }
    if (!found?.condition) { unclassified++; continue; }
    let group = groups.get(found.condition.key);
    if (!group) groups.set(found.condition.key, group = { rule: found.rule, condition: found.condition, samples: new Map() });
    const key = targetKey({ agent: task.agent, model: task.model, ...(task.effort ? { effort: task.effort } : {}) });
    const samples = group.samples.get(key) ?? []; group.samples.set(key, samples);
    samples.push({ task, feedback, ...(!ambiguousUsage.has(id) && usages.has(id) ? { usage: usages.get(id)! } : {}) });
  }
  if (ratings.size && !report.evaluatedRatings) report.insufficient.push({ code: "no_valid_samples", message: "暂时没有可比较的有效评价任务；已停止、过旧、尚未结束或缺失的任务不参与建议" });
  if (unclassified) report.insufficient.push({ code: "classification_unavailable", samples: unclassified, message: "部分评价没有可比较的关键词、字数或文件夹分类；不会猜测正则规则或改用更靠后的条件" });
  for (const group of groups.values()) {
    const candidates = [...group.samples.values()].map(evidence).sort((a, b) => b.samples - a.samples || targetKey(a.target).localeCompare(targetKey(b.target)));
    const issue = (code: string, message: string) => report.insufficient.push({ ruleId: group.rule.id, code, message, samples: candidates.reduce((n, c) => n + c.samples, 0) });
    const current = resolveTarget(group.rule);
    if (!current) {
      issue("baseline_configuration", "当前规则的默认模型或档位还不明确，不能拿历史中最常用的设置代替比较"); continue;
    }
    const baseline = candidates.find(c => targetKey(c.target) === targetKey(current));
    if (!baseline || baseline.samples < policy.minSamples) { issue("baseline_samples", `当前规则的接收方还不足 ${policy.minSamples} 条有效评价`); continue; }
    if (baseline.pricedSamples !== baseline.samples || baseline.medianCostUsd === undefined) { issue("baseline_cost", "当前接收方的部分费用未知，无法给出便宜多少的比较"); continue; }
    if (baseline.medianCostUsd <= 0) { issue("zero_baseline", "当前接收方的已记录费用中位数为零，没有可证明更便宜的候选"); continue; }
    const eligible: CandidateEvidence[] = [];
    const rejected = new Set<string>();
    for (const candidate of candidates) {
      if (targetKey(candidate.target) === targetKey(baseline.target)) continue;
      if (candidate.samples < policy.minSamples) { rejected.add("samples"); continue; }
      if (candidate.pricedSamples !== candidate.samples || candidate.medianCostUsd === undefined) { rejected.add("cost"); continue; }
      if ((candidate.target.effort ?? "") !== (baseline.target.effort ?? "") || Math.max(candidate.medianTaskChars, baseline.medianTaskChars) / Math.max(1, Math.min(candidate.medianTaskChars, baseline.medianTaskChars)) > policy.maxMedianSizeRatio) { rejected.add("comparability"); continue; }
      if (candidate.goodRate + EPS < policy.minGoodRate || baseline.goodRate - candidate.goodRate > policy.maxGoodRateDrop + EPS) { rejected.add("quality"); continue; }
      if ((baseline.medianCostUsd - candidate.medianCostUsd) / baseline.medianCostUsd + EPS < policy.minSavingsRate) { rejected.add("savings"); continue; }
      if (!baseline.meanCostUsd || candidate.meanCostUsd === undefined || (baseline.meanCostUsd - candidate.meanCostUsd) / baseline.meanCostUsd + EPS < policy.minSavingsRate) { rejected.add("price_variability"); continue; }
      if (input.rules.some(rule => duplicates(rule, group.condition.key, candidate.target, resolveTarget(rule)))) { rejected.add("existing_rule"); continue; }
      if (input.isTargetAvailable && !input.isTargetAvailable(candidate.target)) { rejected.add("unavailable_target"); continue; }
      eligible.push(candidate);
    }
    eligible.sort((a, b) => a.medianCostUsd! - b.medianCostUsd! || b.goodRate - a.goodRate || b.samples - a.samples || targetKey(a.target).localeCompare(targetKey(b.target)));
    const candidate = eligible[0];
    if (!candidate) {
      const messages: Record<string, string> = { samples: "其他候选的有效评价还不足最低样本数", cost: "其他候选有未知或不完整费用，不能比较价格", comparability: "候选档位或任务字数差异较大，暂不比较", quality: "候选没有达到保守的观察好评率要求", savings: "尚未观察到足够的费用下降", price_variability: "虽然费用中位数较低，但平均费用未同样下降，暂不推荐", existing_rule: "相同条件和接收目标已有规则，包含已关闭的规则，不重复生成", unavailable_target: "候选当前不可用，暂不建议" };
      if (!rejected.size) issue("candidate_samples", "还没有另一个具备足够评价的候选");
      for (const reason of rejected) issue(reason, messages[reason]!);
      continue;
    }
    const savingsRate = (baseline.medianCostUsd - candidate.medianCostUsd!) / baseline.medianCostUsd;
    report.suggestions.push({
      id: `suggestion-${hash([group.condition.key, group.rule.id, group.rule.then, baseline, candidate, policy])}`,
      sourceRuleId: group.rule.id, insertBeforeRuleId: group.rule.id,
      draft: { name: `把「${group.rule.name.slice(0, 80)}」交给 ${candidate.target.agent}`, enabled: true, when: structuredClone(group.rule.when), then: { ...candidate.target } },
      evidence: { baseline, candidate, savingsRate, qualityRateDrop: baseline.goodRate - candidate.goodRate, policy: { ...policy } },
      summary: `已评价的同类任务中，${candidate.target.agent} 的单次估算费用中位数低约 ${Math.round(savingsRate * 100)}%；好评 ${candidate.good}/${candidate.samples}，当前接收方 ${baseline.good}/${baseline.samples}`,
      caveats: ["这是本机已有评价的观察结果，不是统计显著性检验，也不保证未来质量相同", "只比较相同档位、相近任务字数与完整归属费用；同一规则条件不代表任务难度完全一样", "中位和平均费用都需达到节省门槛，避免少数昂贵任务被低中位数掩盖", "费用为历史美元估算，订阅、未知价格和不完整费用不能视作免费；未来费率可能变化"],
    });
  }
  return report;
}
