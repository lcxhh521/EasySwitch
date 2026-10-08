// Offline, stdout-only report. Import has no fixture/HOME discovery, writes or CLI execution.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pricingMigrationReport } from "../core/src/pricing/migration-report.ts";

export function main(args) {
  if (args.length !== 1 || !args[0] || args[0].startsWith("-")) throw new Error("Usage: node scripts/compare-pricing.mjs <synthetic-fixture.json>");
  const info = statSync(args[0]);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Provide a bounded synthetic fixture file.");
  const report = pricingMigrationReport(
    readFileSync(args[0], "utf8"),
    readFileSync(new URL("../core/src/pricing/official-facts.json", import.meta.url), "utf8"),
    readFileSync(new URL("../core/src/pricing/official-prices.json", import.meta.url), "utf8"),
  );
  return `${JSON.stringify(report, null, 2)}\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.stdout.write(main(process.argv.slice(2))); }
  catch { console.error("Pricing comparison failed; provide an explicit synthetic fixture and matching staged tables. No files were changed."); process.exitCode = 1; }
}
