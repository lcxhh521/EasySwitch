import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { test } from "node:test";
import { PRESETS } from "../src/presets.ts";
import { AGENTS } from "../src/agents.ts";

const directory = new URL("../../web/icons/", import.meta.url);
const filenames = readdirSync(directory).filter(name => name.endsWith(".svg")).sort();
const generatedFiles = [...filenames, "manifest.json"];
const beforeImport = generatedFiles.map(name => statSync(new URL(name, directory)).mtimeMs);
// URL imports exercise the actual .mjs generators without TypeScript declarations
// or executing their CLI entry points. The tested functions only return values.
const generator: {
  providerAvatars: Record<string, readonly [string, string]>;
  avatarHue(label: string): number;
  letterAvatar(label: string, initials: string, colored?: boolean): string;
  generateProviderIcons(): Record<string, string>;
} = await import(new URL("../../scripts/provider-icons.mjs", import.meta.url).href);
const classifier: {
  isMono(svg: string): boolean;
  iconManifest(icons: Record<string, string>): { mono: string[] };
} = await import(new URL("../../scripts/icon-manifest.mjs", import.meta.url).href);

test("avatar and manifest generators are import-safe and leave checked-in files untouched", () => {
  assert.deepEqual(generatedFiles.map(name => statSync(new URL(name, directory)).mtimeMs), beforeImport);
});

test("all 80 supplier and agent asset filenames are retained and reproducible", () => {
  const icons = generator.generateProviderIcons();
  assert.equal(Object.keys(icons).length, 80);
  assert.deepEqual(Object.keys(icons).sort(), filenames);
  assert.deepEqual(icons, generator.generateProviderIcons());
  for (const [name, svg] of Object.entries(icons)) {
    assert.equal(readFileSync(new URL(name, directory), "utf8"), svg, name);
  }
});

test("every generated SVG is an original text avatar with no logo geometry or external resource", () => {
  for (const [name, svg] of Object.entries(generator.generateProviderIcons())) {
    const [label, initials] = generator.providerAvatars[name.slice(0, -4)]!;
    assert.match(svg, /Original EasySwitch letter avatar/);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.ok(svg.includes(`<title>${label} letter avatar</title>`), name);
    assert.ok(svg.includes(`>${initials}</text>`), name);
    assert.equal((svg.match(/<text\b/g) ?? []).length, 1, name);
    assert.doesNotMatch(svg, /<(?:path|polygon|polyline|image|use|script|foreignObject|style|animate|set|defs)\b|\b(?:href|onload)=|url\(/i, name);
  }
});

test("monochrome initials stay transparent for mask fallback; colored initials retain tiles", () => {
  const icons = generator.generateProviderIcons();
  for (const [name, svg] of Object.entries(icons)) {
    const colored = name.endsWith("-color.svg");
    assert.equal(classifier.isMono(svg), !colored, name);
    assert.equal(svg.includes("<rect "), colored, name);
    assert.equal(svg.includes('fill="currentColor"'), !colored, name);
  }
  const manifest = classifier.iconManifest(icons);
  assert.deepEqual(manifest.mono, filenames.filter(name => !name.endsWith("-color.svg")).map(name => name.slice(0, -4)));
  assert.deepEqual(JSON.parse(readFileSync(new URL("manifest.json", directory), "utf8")), manifest);
});

test("letter avatar generation escapes labels, rejects invalid initials and keeps aliases consistent", () => {
  assert.match(generator.letterAvatar('A & <B> "C" \'D\'', "AB", true), /A &amp; &lt;B&gt; &quot;C&quot; &apos;D&apos;/);
  for (const initials of ["", "abc", "<", 'A"', "ABC"]) assert.throws(() => generator.letterAvatar("Example", initials));
  assert.throws(() => generator.letterAvatar(" ", "A"));
  assert.match(generator.letterAvatar("Example", "A"), /font-size="17"/);
  for (const name of ["groq", "kimi", "moonshot", "ollama", "openrouter"]) {
    assert.deepEqual(generator.providerAvatars[name], generator.providerAvatars[`${name}-color`]);
  }
  assert.deepEqual(generator.providerAvatars.lmstudio, generator.providerAvatars["lm-studio-color"]);
  assert.equal(generator.avatarHue("Kimi"), generator.avatarHue("Kimi"));
  assert.notEqual(generator.avatarHue("Kimi"), generator.avatarHue("Codex"));
});

test("all existing preset and agent icon mappings resolve to generated files or runtime letters", () => {
  const icons = generator.generateProviderIcons();
  for (const entry of [...PRESETS, ...AGENTS]) {
    assert.ok(entry.icon.startsWith("letter:") || Object.hasOwn(icons, `${entry.icon}.svg`), `${entry.id}: ${entry.icon}`);
  }
});

test("manifest content classification remains independent of filenames and sorted", () => {
  const mono = '<svg><text fill="currentColor">A</text></svg>';
  const colored = '<svg><rect fill="#fff"/><text fill="#123">A</text></svg>';
  assert.deepEqual(classifier.iconManifest({ "z-color.svg": mono, "a.svg": mono, "color.svg": colored, "ignored.txt": mono }), { mono: ["a", "z-color"] });
  assert.equal(classifier.isMono('<svg><path fill="#111"/></svg>'), true);
  assert.equal(classifier.isMono('<svg><path fill="none"/></svg>'), true);
  assert.equal(classifier.isMono('<svg><linearGradient/></svg>'), false);
  assert.equal(classifier.isMono('<svg><path fill="white"/></svg>'), false);
});
