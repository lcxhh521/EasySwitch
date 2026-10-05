// Writes web/icons/manifest.json: which icons are single-colour (they fill with
// currentColor and are drawn through a mask so they follow the theme) and which
// carry their own colours (drawn as images). The file content decides, not the name.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = new URL("../web/icons/", import.meta.url).pathname;
/** Perceived brightness 0..1 of a CSS colour, or null when it is not a plain colour. */
function brightness(value) {
  const v = value.trim().toLowerCase();
  if (v === "black") return 0;
  if (v === "white") return 1;
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join("") : m[1];
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  m = /^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/.exec(v);
  if (m) return (0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3]) / 255;
  return null;
}

/**
 * Single-colour means it can be drawn through a mask and follow the theme: every
 * fill is currentColor, unset, or a dark colour, and nothing is light, since a
 * light shape on a dark tile would turn into a solid block through a mask.
 */
function isMono(svg) {
  if (/<(linear|radial)Gradient/i.test(svg)) return false;
  const fills = [...svg.matchAll(/fill\s*[=:]\s*["']?\s*([^"';\s>]+)/gi)].map(m => m[1]);
  return fills.every(f => {
    if (/^(currentcolor|none|inherit)$/i.test(f)) return true;
    const b = brightness(f);
    return b !== null && b < 0.3;
  });
}

const mono = readdirSync(dir)
  .filter(f => f.endsWith(".svg"))
  .filter(f => isMono(readFileSync(join(dir, f), "utf8")))
  .map(f => f.slice(0, -4))
  .sort();
writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ mono }, null, 1)}\n`);
console.log(`${mono.length} single-colour icons`);
