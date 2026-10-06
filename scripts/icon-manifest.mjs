// Writes web/icons/manifest.json: which icons are single-colour (they fill with
// currentColor and are drawn through a mask so they follow the theme) and which
// carry their own colours (drawn as images). The file content decides, not the name.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../web/icons/", import.meta.url));
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
export function isMono(svg) {
  if (/<(linear|radial)Gradient/i.test(svg)) return false;
  const fills = [...svg.matchAll(/fill\s*[=:]\s*["']?\s*([^"';\s>]+)/gi)].map(m => m[1]);
  return fills.every(f => {
    if (/^(currentcolor|none|inherit)$/i.test(f)) return true;
    const b = brightness(f);
    return b !== null && b < 0.3;
  });
}

/** Pure content classification, also used by the checked-in asset tests. */
export function iconManifest(icons) {
  return { mono: Object.entries(icons)
    .filter(([name, svg]) => name.endsWith(".svg") && isMono(svg))
    .map(([name]) => name.slice(0, -4))
    .sort() };
}

export function writeIconManifest(directory = dir) {
  const icons = Object.fromEntries(readdirSync(directory)
    .filter(name => name.endsWith(".svg"))
    .map(name => [name, readFileSync(join(directory, name), "utf8")]));
  const manifest = iconManifest(icons);
  writeFileSync(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}

// Importing this module is read/write-free; only its explicit CLI regenerates files.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`${writeIconManifest().mono.length} single-colour icons`);
}
