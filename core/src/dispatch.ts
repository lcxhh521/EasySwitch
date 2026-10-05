/**
 * Dispatch rules: who gets a task. Instead of choosing an agent by hand for every task, the user
 * writes a few rules in order ("anything mentioning tests goes to Claude Code on a deep setting",
 * "long tasks go to the pool", "small ones to the cheap model"); the first enabled rule whose
 * conditions all hold decides the agent, the model and the thinking level. A task handed to
 * "auto" (from the console, or by another agent through run_agent) goes through them.
 *
 * Pure functions only: the store keeps the rules, the server asks `chooseRule` and records which
 * rule fired, so the task page can say why.
 */

export const AUTO_AGENT = "auto";

export interface DispatchWhen {
  /** Any of these words in the task (case-insensitive). */
  anyWords?: string[];
  /** A regular expression the task text must match. */
  regex?: string;
  /** The task text is at least / at most this many characters. */
  minChars?: number;
  maxChars?: number;
  /** The working folder starts with this path. */
  cwdPrefix?: string;
  /** The task was handed over by this agent id ("console" for the user). */
  from?: string;
}

export interface DispatchThen {
  agent: string;
  /** `<provider>/<model>` or `pool/<id>`; empty means the agent's own model. */
  model?: string;
  effort?: string;
}

export interface DispatchRule {
  id: string;
  name: string;
  enabled: boolean;
  when: DispatchWhen;
  then: DispatchThen;
}

export interface TaskFacts {
  task: string;
  cwd?: string;
  from: string;
}

const MAX_REGEX_LENGTH = 200;

/** A regular expression from the user: bounded, and refused if it does not compile. */
function compileRegex(source: string): RegExp | undefined {
  if (!source || source.length > MAX_REGEX_LENGTH) return undefined;
  try {
    return new RegExp(source, "i");
  } catch {
    return undefined;
  }
}

/** Whether every condition the rule names holds for this task. A rule with no condition matches anything. */
export function ruleMatches(rule: DispatchRule, facts: TaskFacts): boolean {
  const w = rule.when;
  const text = facts.task;
  if (w.anyWords?.length) {
    const lower = text.toLowerCase();
    if (!w.anyWords.some(word => word && lower.includes(word.toLowerCase()))) return false;
  }
  if (w.regex !== undefined && w.regex !== "") {
    const rx = compileRegex(w.regex);
    // A broken expression never matches: a rule that cannot be read must not catch everything.
    if (!rx || !rx.test(text)) return false;
  }
  if (typeof w.minChars === "number" && text.length < w.minChars) return false;
  if (typeof w.maxChars === "number" && text.length > w.maxChars) return false;
  if (w.cwdPrefix && !(facts.cwd ?? "").startsWith(w.cwdPrefix)) return false;
  if (w.from && w.from !== facts.from) return false;
  return true;
}

/** Every enabled rule that holds, in the order the user arranged them. */
export function matchingRules(rules: readonly DispatchRule[], facts: TaskFacts): DispatchRule[] {
  return rules.filter(rule => rule.enabled && ruleMatches(rule, facts));
}

/** The first enabled rule that holds. */
export function chooseRule(rules: readonly DispatchRule[], facts: TaskFacts): DispatchRule | undefined {
  return matchingRules(rules, facts)[0];
}

/** A human sentence for the task page: why this agent got the task. */
export function describeWhen(when: DispatchWhen): string {
  const parts: string[] = [];
  if (when.anyWords?.length) parts.push(`提到「${when.anyWords.join("、")}」`);
  if (when.regex) parts.push(`符合 ${when.regex}`);
  if (typeof when.minChars === "number") parts.push(`任务不少于 ${when.minChars} 字`);
  if (typeof when.maxChars === "number") parts.push(`任务不超过 ${when.maxChars} 字`);
  if (when.cwdPrefix) parts.push(`在 ${when.cwdPrefix} 里`);
  if (when.from) parts.push(`是 ${when.from === "console" ? "你" : when.from} 派的`);
  return parts.length ? parts.join("，且") : "任何任务";
}

export interface RuleInput {
  name?: unknown;
  enabled?: unknown;
  when?: unknown;
  then?: unknown;
}

/** Cleans what the console sent into a rule, or says what is wrong in words the user can act on. */
export function parseRule(input: RuleInput, known: { agents: readonly string[] }): { rule: Omit<DispatchRule, "id"> } | { error: string } {
  const name = String(input.name ?? "").trim();
  if (!name) return { error: "给这条规则取个名字" };
  const w = (input.when && typeof input.when === "object" ? input.when : {}) as Record<string, unknown>;
  const t = (input.then && typeof input.then === "object" ? input.then : {}) as Record<string, unknown>;

  const when: DispatchWhen = {};
  const words = Array.isArray(w.anyWords) ? w.anyWords : typeof w.anyWords === "string" ? w.anyWords.split(/[,，、\n]/) : [];
  const cleanedWords = words.map(x => String(x).trim()).filter(Boolean).slice(0, 30);
  if (cleanedWords.length) when.anyWords = cleanedWords;
  if (typeof w.regex === "string" && w.regex.trim()) {
    if (!compileRegex(w.regex.trim())) return { error: `这个正则读不懂或太长了（最多 ${MAX_REGEX_LENGTH} 个字符）：${w.regex}` };
    when.regex = w.regex.trim();
  }
  for (const key of ["minChars", "maxChars"] as const) {
    const v = w[key];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return { error: "字数要填一个不小于 0 的数" };
    when[key] = Math.floor(n);
  }
  if (when.minChars !== undefined && when.maxChars !== undefined && when.minChars > when.maxChars) return { error: "最少字数不能比最多字数还大" };
  if (typeof w.cwdPrefix === "string" && w.cwdPrefix.trim()) {
    if (!w.cwdPrefix.trim().startsWith("/")) return { error: "文件夹要写绝对路径，以 / 开头" };
    when.cwdPrefix = w.cwdPrefix.trim();
  }
  if (typeof w.from === "string" && w.from.trim()) when.from = w.from.trim();

  const agent = String(t.agent ?? "").trim();
  if (!agent) return { error: "要选一个接活的 agent" };
  if (agent === AUTO_AGENT) return { error: "规则不能再派给「自动」" };
  if (!known.agents.includes(agent)) return { error: `没有这个 agent：${agent}` };
  const then: DispatchThen = { agent };
  if (typeof t.model === "string" && t.model.trim()) then.model = t.model.trim();
  if (typeof t.effort === "string" && t.effort.trim()) then.effort = t.effort.trim();

  return { rule: { name, enabled: input.enabled !== false, when, then } };
}
