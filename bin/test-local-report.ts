/** Test-only reporter. File destinations are closed by Node before --test-force-exit. */
import { resolve } from "node:path";

type Result = {
  name: string; number: number; nesting: number; type: "test" | "suite";
  status: "pass" | "fail"; skipped: boolean; todo: boolean; cancelled: boolean;
};
type Report = { version: 1; file: string; complete: true; plans: number[]; results: Result[] };
type Event = { type: string; data: { name?: string; testNumber?: number; nesting?: number; count?: number; skip?: unknown; todo?: unknown; details?: { type?: string; error?: { failureType?: string } } } };

export async function collectLocalReport(source: AsyncIterable<Event>, file: string): Promise<Report> {
  const plans: number[] = [], results: Result[] = [];
  for await (const event of source) {
    const data = event.data;
    if (event.type === "test:plan" && data.nesting === 0) plans.push(data.count!);
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    results.push({ name: data.name!, number: data.testNumber!, nesting: data.nesting!,
      type: (data.details?.type ?? "test") as Result["type"],
      status: event.type === "test:pass" ? "pass" : "fail", skipped: data.skip !== undefined,
      todo: data.todo !== undefined,
      cancelled: ["cancelledByParent", "testTimeoutFailure", "testAborted"].includes(data.details?.error?.failureType ?? ""),
    });
  }
  // Written only after the official TestsStream ends, never from an exit hook.
  return { version: 1, file, complete: true, plans, results };
}
export default async function* reporter(source: AsyncIterable<Event>) {
  yield `${JSON.stringify(await collectLocalReport(source, resolve(process.argv[1]!)))}\n`;
}

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, expected: string[]) { return Object.keys(value).sort().join() === [...expected].sort().join(); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }

/** Fail closed on missing, truncated, foreign, inconsistent or unsuccessful reports. */
export function validateLocalReport(raw: string, expectedFile: string) {
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error("Local test report is too large");
  let report: unknown;
  try { report = JSON.parse(raw); } catch { throw new Error("Local test report is missing or corrupt"); }
  if (!record(report) || !keys(report, ["version", "file", "complete", "plans", "results"]) || report.version !== 1 || report.file !== expectedFile || report.complete !== true || !Array.isArray(report.plans) || report.plans.length !== 1 || !integer(report.plans[0]) || !Array.isArray(report.results)) throw new Error("Local test report has no valid completion record");
  const results: Result[] = [];
  for (const row of report.results) {
    if (!record(row) || !keys(row, ["name", "number", "nesting", "type", "status", "skipped", "todo", "cancelled"]) || typeof row.name !== "string" || !row.name || !integer(row.number) || row.number < 1 || !integer(row.nesting) || (row.type !== "test" && row.type !== "suite") || (row.status !== "pass" && row.status !== "fail") || typeof row.skipped !== "boolean" || typeof row.todo !== "boolean" || typeof row.cancelled !== "boolean") throw new Error("Local test report has an invalid result");
    results.push(row as Result);
  }
  const top = results.filter(row => row.nesting === 0);
  if (top.length !== report.plans[0] || top.length === 0 || top.some((row, index) => row.number !== index + 1)) throw new Error("Local test report is incomplete or has duplicate results");
  if (results.some(row => row.status === "fail" || row.cancelled)) throw new Error("Local test report contains failed or cancelled tests");
  const tests = results.filter(row => row.type === "test");
  return { tests: tests.length, pass: tests.filter(row => !row.skipped && !row.todo).length,
    skipped: tests.filter(row => row.skipped).length, todo: tests.filter(row => row.todo && !row.skipped).length };
}
