import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRuleSuggestions, DEFAULT_SUGGESTION_POLICY, type TaskUsage } from "../src/suggestions.ts";
import { chooseRule, type DispatchRule } from "../src/dispatch.ts";
import type { Task } from "../src/tasks.ts";
import type { TaskFeedback } from "../src/feedback.ts";

const NOW = new Date("2026-10-06T12:10:00Z");
function fixture(a = 5, b = 5) {
  const rules: DispatchRule[] = [{ id: "r-review", name: "代码审查", enabled: true, when: { anyWords: ["review"], minChars: 10, cwdPrefix: "/project/", from: "console" }, then: { agent: "claude", model: "p/a", effort: "high" } }];
  const tasks: Task[] = [], feedback: TaskFeedback[] = [], usage: TaskUsage[] = [];
  for (const [agent, model, count, cost] of [["claude", "p/a", a, 1], ["codex", "p/b", b, 0.4]] as const) for (let i = 0; i < count; i++) {
    const id = `${agent}-${i}`;
    tasks.push({ id, at: "2026-10-06T12:00:00Z", agent, model, from: "console", task: "review sensitive-body-not-for-report " + "x".repeat(70), cwd: "/project/src", effort: "high", status: "done", exitCode: 0 });
    feedback.push({ taskId: id, rating: "good", at: "2026-10-06T12:05:00Z" });
    usage.push({ taskId: id, costUsd: cost, unknownCost: false });
  }
  return { tasks, feedback, usage, rules, now: NOW };
}

test("zero feedback returns no suggestions or notices, so the existing rules page can remain unchanged", () => {
  const f = fixture(); f.feedback = [];
  assert.deepEqual(buildRuleSuggestions(f), { suggestions: [], evaluatedRatings: 0, insufficient: [] });
});

test("five valid rated tasks per candidate can yield an editable explicitly scoped rule with transparent evidence", () => {
  const f = fixture(), before = JSON.stringify(f);
  const report = buildRuleSuggestions(f);
  assert.equal(report.suggestions.length, 1);
  const s = report.suggestions[0]!;
  assert.equal(s.evidence.baseline.samples, 5); assert.equal(s.evidence.candidate.samples, 5);
  assert.equal(s.evidence.savingsRate, 0.6); assert.equal(s.evidence.candidate.goodRate, 1);
  assert.deepEqual(s.draft.when, f.rules[0]!.when);
  assert.deepEqual(s.draft.then, { agent: "codex", model: "p/b", effort: "high" });
  assert.equal(s.draft.enabled, true); assert.equal(s.insertBeforeRuleId, "r-review");
  assert.equal(chooseRule([{ id: "accepted", ...s.draft }, ...f.rules], f.tasks[0]!)?.then.agent, "codex");
  assert.match(s.summary, /低约 60%/);
  assert.match(s.caveats.join(""), /不是统计显著性检验/);
  assert.equal(JSON.stringify(report).includes("sensitive-body-not-for-report"), false);
  assert.equal(JSON.stringify(f), before, "the pure suggestion builder never changes tasks or rules");
});

test("four ratings on either side do not satisfy the five-task minimum", () => {
  for (const f of [fixture(4, 5), fixture(5, 4)]) assert.equal(buildRuleSuggestions(f).suggestions.length, 0);
});

test("a cheaper but meaningfully worse observed good rate is not recommended", () => {
  const f = fixture(); f.feedback.find(r => r.taskId === "codex-0")!.rating = "bad";
  const report = buildRuleSuggestions(f);
  assert.equal(report.suggestions.length, 0); assert.ok(report.insufficient.some(i => i.code === "quality"));
});

test("equally low quality is not enough, while equal observed eighty-percent rates can pass", () => {
  const low = fixture(); low.feedback.forEach((r, i) => { if (i % 5 !== 0) r.rating = "bad"; });
  assert.equal(buildRuleSuggestions(low).suggestions.length, 0);
  const equal = fixture(); equal.feedback.find(r => r.taskId === "claude-0")!.rating = "bad"; equal.feedback.find(r => r.taskId === "codex-0")!.rating = "bad";
  assert.equal(buildRuleSuggestions(equal).suggestions.length, 1);
});

test("unknown, subscription-like zero, missing or duplicate task totals never count as free comparable work", () => {
  const cases = [
    (f: ReturnType<typeof fixture>) => { f.usage.find(u => u.taskId === "codex-0")!.unknownCost = true; },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.usage.find(u => u.taskId === "codex-0")!, { costUsd: 0, unknownCost: true }); },
    (f: ReturnType<typeof fixture>) => { f.usage = f.usage.filter(u => u.taskId !== "codex-0"); },
    (f: ReturnType<typeof fixture>) => { f.usage.push({ ...f.usage.find(u => u.taskId === "codex-0")! }); },
    (f: ReturnType<typeof fixture>) => { f.usage.find(u => u.taskId === "codex-0")!.costUsd = -1; },
  ];
  for (const change of cases) { const f = fixture(); change(f); assert.equal(buildRuleSuggestions(f).suggestions.length, 0); }
  const baseline = fixture(); baseline.usage[0]!.unknownCost = true;
  assert.ok(buildRuleSuggestions(baseline).insufficient.some(i => i.code === "baseline_cost"));
});

test("unknown-price bad ratings remain in quality evidence rather than being removed to improve a candidate", () => {
  const f = fixture(5, 6); const rating = f.feedback.find(r => r.taskId === "codex-5")!; rating.rating = "bad";
  f.usage.find(u => u.taskId === rating.taskId)!.unknownCost = true;
  const report = buildRuleSuggestions(f);
  assert.equal(report.evaluatedRatings, 11); assert.equal(report.suggestions.length, 0);
  assert.ok(report.insufficient.some(i => i.code === "cost"));
});

test("different effort or substantially different task lengths cannot justify a price recommendation", () => {
  const effort = fixture(); effort.tasks.filter(t => t.agent === "codex").forEach(t => { t.effort = "low"; });
  assert.equal(buildRuleSuggestions(effort).suggestions.length, 0);
  const sizes = fixture(); sizes.tasks.filter(t => t.agent === "codex").forEach(t => { t.task += "x".repeat(300); });
  assert.ok(buildRuleSuggestions(sizes).insufficient.some(i => i.code === "comparability"));
});

test("price comparisons use medians and require at least twenty-percent observed savings", () => {
  const f = fixture(); f.usage.filter(u => u.taskId.startsWith("codex")).forEach(u => { u.costUsd = 0.9; });
  assert.equal(buildRuleSuggestions(f).suggestions.length, 0);
  const outlier = fixture(); outlier.usage.find(u => u.taskId === "claude-0")!.costUsd = 1000;
  assert.equal(buildRuleSuggestions(outlier).suggestions[0]!.evidence.baseline.medianCostUsd, 1);
  const free = fixture(); free.usage.filter(u => u.taskId.startsWith("claude")).forEach(u => { u.costUsd = 0; });
  assert.ok(buildRuleSuggestions(free).insufficient.some(i => i.code === "zero_baseline"));
});

test("existing equivalent target rules, even disabled ones, suppress duplicate suggestions", () => {
  for (const enabled of [true, false]) {
    const f = fixture(); f.rules.push({ ...structuredClone(f.rules[0]!), id: "r-already", enabled, when: { ...f.rules[0]!.when, anyWords: ["REVIEW", "review"] }, then: { agent: "codex", model: "p/b", effort: "high" } });
    const report = buildRuleSuggestions(f);
    assert.equal(report.suggestions.length, 0); assert.ok(report.insufficient.some(i => i.code === "existing_rule"));
  }
});

test("repeated votes and duplicate task records do not inflate the sample count", () => {
  const f = fixture(5, 4);
  f.feedback.push(...f.feedback.map(r => ({ ...r }))); f.tasks.push(...f.tasks.map(t => ({ ...t })));
  assert.equal(buildRuleSuggestions(f).suggestions.length, 0);
  assert.equal(buildRuleSuggestions(f).evaluatedRatings, 9);
});

test("later corrections replace earlier votes and conflicting latest votes are not usable", () => {
  const f = fixture(); f.feedback.push({ taskId: "codex-0", rating: "bad", at: "2026-10-06T12:06:00Z" });
  assert.equal(buildRuleSuggestions(f).suggestions.length, 0);
  const conflict = fixture(); conflict.feedback.push({ taskId: "codex-0", rating: "bad", at: "2026-10-06T12:05:00Z" });
  assert.equal(buildRuleSuggestions(conflict).suggestions.length, 0);
  assert.equal(buildRuleSuggestions(conflict).evaluatedRatings, 9);
});

test("running, stopped, stale and temporally invalid task feedback is excluded with an honest evidence gap", () => {
  for (const status of ["running", "stopped"] as const) { const f = fixture(); f.tasks.filter(t => t.agent === "codex").forEach(t => { t.status = status; }); assert.equal(buildRuleSuggestions(f).suggestions.length, 0); }
  const stale = fixture(); stale.tasks.forEach(t => { t.at = "2025-01-01T00:00:00Z"; });
  assert.ok(buildRuleSuggestions(stale).insufficient.some(i => i.code === "no_valid_samples"));
  const early = fixture(); early.feedback.forEach(r => { r.at = "2026-10-06T11:00:00Z"; });
  assert.equal(buildRuleSuggestions(early).suggestions.length, 0);
});

test("first-match classification is preserved and unsupported regexes are never executed or ignored", () => {
  const f = fixture(); f.rules.unshift({ id: "r-regex", name: "regex", enabled: true, when: { regex: "(a+)+$" }, then: { agent: "claude" } });
  const report = buildRuleSuggestions(f);
  assert.equal(report.suggestions.length, 0); assert.ok(report.insufficient.some(i => i.code === "classification_unavailable"));
  const catchall = fixture(); catchall.rules.unshift({ id: "catchall", name: "all", enabled: true, when: {}, then: { agent: "claude" } });
  assert.equal(buildRuleSuggestions(catchall).suggestions.length, 0);
});

test("suggestion ids change with evidence, unavailable targets are suppressed, and policies only tighten", () => {
  const f = fixture(), first = buildRuleSuggestions(f).suggestions[0]!;
  const more = fixture(6, 6); assert.notEqual(buildRuleSuggestions(more).suggestions[0]!.id, first.id);
  assert.equal(buildRuleSuggestions({ ...f, isTargetAvailable: () => false }).suggestions.length, 0);
  assert.throws(() => buildRuleSuggestions({ ...f, policy: { minSamples: 4 } }));
  assert.throws(() => buildRuleSuggestions({ ...f, policy: { maxGoodRateDrop: 0.2 } }));
  assert.equal(buildRuleSuggestions({ ...f, policy: { ...DEFAULT_SUGGESTION_POLICY, minSamples: 6 } }).suggestions.length, 0);
});

test("implicit defaults need current configuration rather than selecting an expensive historical baseline", () => {
  const f = fixture(); f.rules[0]!.then = { agent: "claude" };
  assert.ok(buildRuleSuggestions(f).insufficient.some(i => i.code === "baseline_configuration"));
  const resolved = buildRuleSuggestions({ ...f, resolveRuleTarget: () => ({ agent: "claude", model: "p/a", effort: "high" }) });
  assert.equal(resolved.suggestions.length, 1);
  const changed = buildRuleSuggestions({ ...f, resolveRuleTarget: () => ({ agent: "claude", model: "p/new-cheaper-default", effort: "high" }) });
  assert.equal(changed.suggestions.length, 0); assert.ok(changed.insufficient.some(i => i.code === "baseline_samples"));
  const noEffort = fixture(); delete noEffort.rules[0]!.then.effort;
  assert.equal(buildRuleSuggestions(noEffort).suggestions.length, 0, "unset current effort is not any historical effort");
});

test("a now-cheaper current default is not replaced based on an older expensive model's more numerous ratings", () => {
  const f = fixture(6, 5); f.rules[0]!.then = { agent: "claude" };
  for (let i = 0; i < 5; i++) {
    const id = `claude-current-${i}`;
    f.tasks.push({ ...f.tasks[0]!, id, model: "p/current" });
    f.feedback.push({ taskId: id, rating: "good", at: "2026-10-06T12:05:00Z" });
    f.usage.push({ taskId: id, costUsd: 0.1, unknownCost: false });
  }
  const report = buildRuleSuggestions({ ...f, resolveRuleTarget: () => ({ agent: "claude", model: "p/current", effort: "high" }) });
  assert.equal(report.suggestions.length, 0);
  assert.ok(report.insufficient.some(i => i.code === "savings"));
});

test("a low median cannot hide an expensive tail that makes the average task cost higher", () => {
  const f = fixture();
  f.usage.filter(u => u.taskId.startsWith("codex")).forEach(u => { u.costUsd = 0; });
  f.usage.find(u => u.taskId === "codex-4")!.costUsd = 100;
  const report = buildRuleSuggestions(f);
  assert.equal(report.suggestions.length, 0);
  assert.ok(report.insufficient.some(i => i.code === "price_variability"));
});

test("an implicit default is not a wildcard that suppresses a different model on the same agent", () => {
  const f = fixture(); f.rules[0]!.then = { agent: "claude" };
  f.tasks.filter(t => t.agent === "codex").forEach(t => { t.agent = "claude"; });
  const report = buildRuleSuggestions({ ...f, resolveRuleTarget: () => ({ agent: "claude", model: "p/a", effort: "high" }) });
  assert.equal(report.suggestions.length, 1);
  assert.deepEqual(report.suggestions[0]!.draft.then, { agent: "claude", model: "p/b", effort: "high" });
});

test("a zero minimum length does not create a new category or evade equivalent-rule deduplication", () => {
  const f = fixture(); delete f.rules[0]!.when.minChars;
  f.rules.push({ ...structuredClone(f.rules[0]!), id: "r-existing", enabled: false, when: { ...f.rules[0]!.when, minChars: 0 }, then: { agent: "codex", model: "p/b", effort: "high" } });
  assert.equal(buildRuleSuggestions(f).suggestions.length, 0);
  assert.ok(buildRuleSuggestions(f).insufficient.some(i => i.code === "existing_rule"));
});
