// Writes the icon sources in assets/ (scripts/build-icons.sh then renders them):
//   easyswitch.svg       app icon: the mark on a light full-bleed square (macOS applies the rounded shape)
//   easyswitch-mark.svg  the mark alone on a transparent background (README, web/favicon.svg)
//   glyph-on.svg / glyph-off.svg  18 pt menu-bar template images
// The mark: an eight-lobed glass cloud (the same family as the Codex app icon) holding a terminal prompt
// whose underscore is a toggle switch — an agent you can switch. All geometry is computed here; no third-party artwork.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const assets = join(dirname(dirname(fileURLToPath(import.meta.url))), "assets");

/** Cloud outline: a core disc plus n lobe circles, joined by a soft maximum so the valleys stay round. */
function cloud({ cx = 512, cy = 512, R, n = 8, lobe = 0.36, rot = 0.2, k = 10, steps = 720 }) {
  const d = R * (1 - lobe), rc = R - d;
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    let acc = Math.exp(d / k);
    for (let j = 0; j < n; j++) {
      const a = rot + (2 * Math.PI * j) / n, dx = d * Math.cos(a - t), dy = d * Math.sin(a - t), disc = rc * rc - dy * dy;
      acc += Math.exp((disc > 0 ? dx + Math.sqrt(disc) : 0) / k);
    }
    pts.push([t, k * Math.log(acc)]);
  }
  const max = Math.max(...pts.map(([, r]) => r));
  const xy = pts.map(([t, r]) => [cx + (r * R / max) * Math.cos(t), cy + (r * R / max) * Math.sin(t)]);
  return "M" + xy.map((p) => p.map((v) => v.toFixed(1)).join(" ")).join("L") + "Z";
}

const FILTERS = `<filter id="drop" x="-30%" y="-30%" width="160%" height="170%"><feGaussianBlur stdDeviation="26"/></filter>
<filter id="glow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="14"/></filter>
<filter id="rim" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="7"/></filter>`;
// Glass: mint at the top through teal to blue, a highlight from above, a light rim and a darker lower edge.
const GLASS = `<linearGradient id="body" x1="0" y1="150" x2="0" y2="880" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#9af3df"/><stop offset=".5" stop-color="#27b6d4"/><stop offset="1" stop-color="#1d58e8"/></linearGradient>
<radialGradient id="sheen" cx="560" cy="250" r="330" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#d9fff5" stop-opacity=".85"/><stop offset="1" stop-color="#d9fff5" stop-opacity="0"/></radialGradient>
<radialGradient id="inner" cx="420" cy="560" r="260" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>`;

function mark(shape) {
  return `<path d="${shape}" fill="#1d58e8" opacity=".45" filter="url(#drop)" transform="translate(0 26)"/>
<path d="${shape}" fill="url(#body)"/>
<g clip-path="url(#cloud)"><path d="${shape}" fill="url(#sheen)"/><path d="${shape}" fill="url(#inner)"/>
<path d="${shape}" fill="none" stroke="#fff" stroke-opacity=".75" stroke-width="10" filter="url(#rim)"/>
<path d="${shape}" fill="none" stroke="#06205e" stroke-opacity=".25" stroke-width="40" filter="url(#drop)" transform="translate(0 -18)"/></g>
<g filter="url(#glow)" opacity=".9" fill="none" stroke="#d9fff5" stroke-linecap="round" stroke-linejoin="round"><path d="M372 400 L452 472 L372 544" stroke-width="54"/><rect x="500" y="526" width="190" height="92" rx="46" stroke-width="22"/></g>
<path d="M372 400 L452 472 L372 544" fill="none" stroke="#fff" stroke-width="50" stroke-linecap="round" stroke-linejoin="round"/>
<rect x="500" y="526" width="190" height="92" rx="46" fill="#fff" fill-opacity=".22" stroke="#fff" stroke-width="16"/><circle cx="644" cy="572" r="32" fill="#fff"/>`;
}

const shape = cloud({ R: 360 });
const head = (title, defs) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n<title>${title}</title>\n<defs>${FILTERS}${GLASS}<clipPath id="cloud"><path d="${shape}"/></clipPath>${defs}</defs>\n`;

writeFileSync(join(assets, "easyswitch-mark.svg"), head("EasySwitch", "") + mark(shape) + "\n</svg>\n");
// Full-bleed on purpose: a transparent margin gets the icon put on a grey plate by macOS 26.
writeFileSync(join(assets, "easyswitch.svg"), head("EasySwitch", `<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fdfdfe"/><stop offset="1" stop-color="#e6e9f0"/></linearGradient>`) + `<rect width="1024" height="1024" fill="url(#tile)"/>\n` + mark(shape) + "\n</svg>\n");

// Menu-bar glyphs: the cloud solid with the prompt cut out and the knob switched on (right, solid); stopped: the cloud
// is an outline and the knob switched off (left, hollow). Drawn on a 1024 grid, shown at 36 px (scripts/build-icons.sh enlarges width/height).
const g = cloud({ R: 500, k: 14 });
const prompt = `<path d="M300 330 L452 470 L300 610" fill="none" stroke-width="110" stroke-linecap="round" stroke-linejoin="round"/>`;
const track = (fill) => `<rect x="470" y="560" width="300" height="160" rx="80" fill="${fill}" stroke-width="60"/>`;
writeFileSync(join(assets, "glyph-on.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 1024 1024">
<title>EasySwitch menu-bar glyph, running</title>
<defs><mask id="cut"><path d="${g}" fill="#fff"/><g stroke="#000">${prompt}${track("#000")}</g></mask></defs>
<rect width="1024" height="1024" fill="#000" mask="url(#cut)"/>
<circle cx="690" cy="640" r="52" fill="#000"/>
</svg>
`);
writeFileSync(join(assets, "glyph-off.svg"), `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 1024 1024">
<title>EasySwitch menu-bar glyph, core service not running</title>
<path d="${cloud({ R: 470, k: 14 })}" fill="none" stroke="#000" stroke-width="60" stroke-linejoin="round"/>
<g stroke="#000">${prompt}${track("none")}</g>
<circle cx="550" cy="640" r="38" fill="none" stroke="#000" stroke-width="24"/>
</svg>
`);
console.log("wrote assets/easyswitch.svg, easyswitch-mark.svg, glyph-on.svg, glyph-off.svg");
