import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { collectLocalReport, validateLocalReport } from "../../bin/test-local-report.ts";

const file = "/fixture/example.test.ts";
const row = (number = 1, extra = {}) => ({ name: `test ${number}`, number, nesting: 0, type: "test", status: "pass", skipped: false, todo: false, cancelled: false, ...extra });
const report = (extra = {}) => ({ version: 1, file, complete: true, plans: [1], results: [row()], ...extra });
const check = (value: unknown) => validateLocalReport(JSON.stringify(value), file);

test("local reports count completed tests, skips and nested suites from structured results", () => {
  assert.deepEqual(check(report()), { tests: 1, pass: 1, skipped: 0, todo: 0 });
  assert.deepEqual(check(report({ plans: [2], results: [row(1, { nesting: 1 }), row(2, { nesting: 1, skipped: true }), row(1, { type: "suite" }), row(2, { todo: true })] })), { tests: 3, pass: 1, skipped: 1, todo: 1 });
});
test("local reports reject absent, malformed, truncated and extra JSON content", () => {
  for (const raw of ["", "{", JSON.stringify(report()).slice(0, -1), `${JSON.stringify(report())}\n{}`, "null", "[]"]) assert.throws(() => validateLocalReport(raw, file));
});
test("local reports reject missing completion, unknown schemas and another file's report", () => {
  for (const extra of [{ complete: false }, { complete: undefined }, { version: 2 }, { file: "/other.test.ts" }, { extra: true }, { results: null }]) assert.throws(() => check(report(extra)));
});
test("local reports reject absent, duplicate, invalid and mismatched terminal plans", () => {
  for (const plans of [[], [1, 1], [2], [-1], [1.5], ["1"]]) assert.throws(() => check(report({ plans })));
  assert.throws(() => check(report({ plans: [0], results: [] })));
});
test("local reports reject missing and duplicated top-level outcomes instead of accepting exit zero", () => {
  for (const results of [[], [row(2)], [row(), row()], [row(1, { nesting: 1 })]]) assert.throws(() => check(report({ results })));
});
test("local reports reject failures, cancellations and failed todo cases", () => {
  for (const extra of [{ status: "fail" }, { cancelled: true }, { status: "fail", todo: true }, { status: "fail", skipped: true }]) assert.throws(() => check(report({ results: [row(1, extra)] })));
});
test("local reports reject malformed outcome fields and do not coerce truthy values", () => {
  for (const extra of [{ skipped: "false" }, { cancelled: 0 }, { todo: null }, { status: "ok" }, { status: ["fail"] }, { status: ["pass"] }, { status: {} }, { type: ["test"] }, { type: {} }, { type: "unknown" }, { nesting: -1 }, { number: 1.1 }, { name: "" }, { unknown: true }]) assert.throws(() => check(report({ results: [row(1, extra)] })));
});
test("local reporter emits completion only after the official stream ends", async () => {
  async function* events() {
    yield { type: "test:pass", data: { name: "one", testNumber: 1, nesting: 0, details: { type: "test" } } };
    yield { type: "test:plan", data: { nesting: 0, count: 1 } };
  }
  assert.deepEqual(check(await collectLocalReport(events(), file)), { tests: 1, pass: 1, skipped: 0, todo: 0 });
  async function* interrupted() { yield { type: "test:plan", data: { nesting: 0, count: 1 } }; throw new Error("fixture interruption"); }
  await assert.rejects(collectLocalReport(interrupted(), file), /fixture interruption/);
});
test("local reporter records cancelled tests and ignores nested plans for file completeness", async () => {
  async function* events() {
    yield { type: "test:plan", data: { nesting: 1, count: 3 } };
    yield { type: "test:fail", data: { name: "cancelled", testNumber: 1, nesting: 0, details: { type: "test", error: { failureType: "cancelledByParent" } } } };
    yield { type: "test:plan", data: { nesting: 0, count: 1 } };
  }
  const result = await collectLocalReport(events(), file);
  assert.deepEqual(result.plans, [1]); assert.equal(result.results[0]!.cancelled, true); assert.throws(() => check(result));
});
test("local runner keeps the audited guard, forced exit, private environment and desktop-only hash exception", () => {
  const source = readFileSync(new URL("../../bin/test-local.ts", import.meta.url), "utf8");
  assert.ok(source.includes('"--import", "./core/test/local-only-guard.ts", "--test-force-exit"'));
  assert.ok(source.includes('NODE_TEST_CONTEXT: "easyswitch-local"'));
  assert.ok(source.includes('name === "claude-desktop" ? { ...env, EASYSWITCH_TEST_DESKTOP_FIXTURES: "1" } : env'));
  assert.ok(source.includes('"a REAL|a task sent to auto|a dry run says|the backlog hooks|the icon manifest is current"'));
  assert.ok(!source.includes('...process.env')); assert.ok(!source.includes('_handle'));
  assert.ok(source.includes('validateLocalReport(readFileSync(report, "utf8"), file)'));
});
