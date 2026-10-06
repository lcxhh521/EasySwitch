#!/usr/bin/env node
// Reads BACKLOG.md and checks it. Used by hand (`npm run backlog`) and by the two Claude Code hooks.
//
//   backlog.ts            print the open items, grouped, plus a one-line tally
//   backlog.ts --check    exit 1 if the file is malformed or a finished item has no evidence
//   backlog.ts --archive  move the finished items from BACKLOG.md to BACKLOG-DONE.md (their numbers are never reused)
//   backlog.ts --hook-prompt   (UserPromptSubmit) remind the agent to log new requests first
//   backlog.ts --hook-stop     (Stop) refuse to stop while the file is malformed or items are half-done
//
// An item is one line:  - [ ] B12 · title — 来源：「the user's words」（10-06）· 备注
//   [ ] open   [~] in progress   [x] done (must say 验证： what proves it)   [-] not doing / parked (must say 原因：)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archive, parse, tally, type Item } from "../core/src/backlog.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "BACKLOG.md");
const DONE = join(ROOT, "BACKLOG-DONE.md");

function load() {
  const archived = existsSync(DONE) ? parse(readFileSync(DONE, "utf8")) : { items: [] as Item[], problems: [] as string[] };
  try {
    const main = parse(readFileSync(FILE, "utf8"), new Set(archived.items.map(i => i.id)));
    return { items: main.items, problems: [...main.problems, ...archived.problems.map(p => `BACKLOG-DONE.md ${p}`)], archived: archived.items.length };
  } catch {
    return { items: [] as Item[], problems: ["找不到 BACKLOG.md（项目根目录）"], archived: 0 };
  }
}

function show(items: Item[]): string {
  const open = items.filter(i => i.mark === " " || i.mark === "~");
  const out: string[] = [];
  let last = "";
  for (const it of open) {
    if (it.section !== last) { out.push(`\n## ${it.section}`); last = it.section; }
    out.push(`  ${it.mark === "~" ? "◐" : "○"} ${it.id} ${it.text.split(" — ")[0]}`);
  }
  return out.join("\n");
}

const mode = process.argv[2] ?? "";
const { items, problems, archived } = load();

if (mode === "--hook-prompt") {
  // Printed into the agent's context on every user message.
  console.log(`[待办规则] 这条消息里如果有新的需求、变更或决定，先写进 BACKLOG.md（一条一行，带用户原话和日期），再动手做。当前：${tally(items, archived)}。`);
  process.exit(0);
}

// The hooks are for a person (or an agent) working on this repository. A session that EasySwitch itself
// started (its gateway address or a per-launch session token in the environment) must never be held back
// by them: a headless run inside this directory would otherwise never finish.
const EASYSWITCH_SESSION = /127\.0\.0\.1/.test(process.env.ANTHROPIC_BASE_URL ?? "") || /^es-session-/.test(process.env.ANTHROPIC_AUTH_TOKEN ?? "");
if (mode === "--hook-stop" && EASYSWITCH_SESSION) process.exit(0);

if (mode === "--hook-stop") {
  let active = false;
  try { active = Boolean((JSON.parse(readFileSync(0, "utf8")) as { stop_hook_active?: boolean }).stop_hook_active); } catch { /* no stdin */ }
  if (active) process.exit(0);
  const half = items.filter(i => i.mark === "~");
  const msgs = [...problems, ...half.map(i => `${i.id} 还是“进行中”：收工前要么做完（写验证），要么改回待办或写原因停放`)];
  if (!msgs.length) process.exit(0);
  console.error(`收工前核对 BACKLOG.md 没通过：\n- ${msgs.join("\n- ")}\n先修好再收工；并在最后的回复里说明本次对照待办的结果（做完几条、还剩几条）。`);
  process.exit(2);
}

if (mode === "--archive") {
  if (problems.length) { console.error("先把格式问题修好再归档：\n- " + problems.join("\n- ")); process.exit(1); }
  const { kept, moved } = archive(readFileSync(FILE, "utf8"));
  if (!moved.length) { console.log("没有已完成的条目要归档。"); process.exit(0); }
  const stamp = new Date().toISOString().slice(0, 10);
  const head = existsSync(DONE) ? readFileSync(DONE, "utf8").replace(/\n+$/, "") + "\n" : "# 已完成的待办（归档）\n\n从 BACKLOG.md 移过来的，证据和用户原话都在；编号不会再被用。\n";
  writeFileSync(DONE, `${head}\n## 归档 ${stamp}\n\n${moved.join("\n")}\n`);
  writeFileSync(FILE, kept);
  console.log(`已归档 ${moved.length} 条到 BACKLOG-DONE.md。`);
  process.exit(0);
}

if (mode === "--check") {
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log(`BACKLOG.md 格式正常。${tally(items, archived)}`);
  process.exit(0);
}

console.log(tally(items, archived) + "\n" + show(items));
if (problems.length) { console.error("\n格式问题：\n- " + problems.join("\n- ")); process.exit(1); }
