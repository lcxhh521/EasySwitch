// Compile independent official facts; explicit paths, no HOME discovery or network.
import { readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { compileOfficialPrices } from "../core/src/pricing/official-table.ts";

export function buildPrices(source, output) {
  if (!source || !output || resolve(source) === resolve(output)) throw new Error("Provide distinct explicit facts and output paths.");
  const destination = join(realpathSync(dirname(resolve(output))), basename(output));
  const legacy = realpathSync(fileURLToPath(new URL("../core/src/pricing/prices.json", import.meta.url)));
  if (destination === legacy || destination === realpathSync(source)) throw new Error("The staged generator cannot overwrite the legacy runtime table or its facts input.");
  const result = compileOfficialPrices(readFileSync(source, "utf8"));
  const temporary = `${output}.${process.pid}.tmp`;
  let created = false;
  try { writeFileSync(temporary, result, { flag: "wx" }); created = true; renameSync(temporary, output); }
  finally { if (created) rmSync(temporary, { force: true }); }
  return result;
}
export function main(args) {
  if (args.length !== 2) throw new Error("Usage: node scripts/build-prices.mjs <official-facts.json> <official-prices.json>");
  buildPrices(args[0], args[1]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch { console.error("Price generation failed; check explicit paths and the supported official facts schema."); process.exitCode = 1; }
}
