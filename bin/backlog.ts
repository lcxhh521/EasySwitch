#!/usr/bin/env node
// Reads BACKLOG.md and checks it. Used by hand (`npm run backlog`) and by the two Claude Code hooks.
//
//   backlog.ts            print the open items, grouped, plus a one-line tally
//   backlog.ts --check    exit 1 if the file is malformed or a finished item has no evidence
//   backlog.ts --hook-prompt   (UserPromptSubmit) remind the agent to log new requests first
//   backlog.ts --hook-stop     (Stop) refuse to stop while the file is malformed or items are half-done
//
// An item is one line:  - [ ] B12 · title — 来源：「the user's words」（10-06）· 备注
//   [ ] open   [~] in progress   [x] done (must say 验证： what proves it)   [-] not doing / parked (must say 原因：)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "BACKLOG.md");
const LINE = /^- \[([ ~x-])\] (B\d+) · (.+)$/;

export interface Item { mark: string; id: string; text: string; line: number; section: string }

export function parse(markdown: string): { items: Item[]; problems: string[] } {
  const items: Item[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let section = "";
  markdown.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (raw.startsWith("## ")) section = raw.slice(3).trim();
    if (!raw.startsWith("- [")) return;
    const m = LINE.exec(raw);
    if (!m) return void problems.push(`第 ${line} 行：条目格式不对（要 “- [ ] B12 · 标题 — 来源：…”）`);
    const [, mark, id, text] = m as unknown as [string, string, string, string];
    if (seen.has(id)) problems.push(`第 ${line} 行：编号 ${id} 重复`);
    seen.add(id);
    if (!text.includes("来源：")) problems.push(`第 ${line} 行 ${id}：没写来源（用户原话或哪次讨论）`);
    if (mark === "x" && !text.includes("验证：")) problems.push(`第 ${line} 行 ${id}：标了完成但没写“验证：”（提交号、测试名或实测结果）`);
    if (mark === "-" && !text.includes("原因：")) problems.push(`第 ${line} 行 ${id}：标了不做/暂缓但没写“原因：”`);
    items.push({ mark: mark!, id: id!, text: text!, line, section });
  });
  return { items, problems };
}

function load() {
  try { return parse(readFileSync(FILE, "utf8")); }
  catch { return { items: [] as Item[], problems: ["找不到 BACKLOG.md（项目根目录）"] }; }
}

function tally(items: Item[]): string {
  const n = (m: string) => items.filter(i => i.mark === m).length;
  return `待办 ${n(" ")} · 进行中 ${n("~")} · 已完成 ${n("x")} · 不做/暂缓 ${n("-")}`;
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
const { items, problems } = load();

if (mode === "--hook-prompt") {
  // Printed into the agent's context on every user message.
  console.log(`[待办规则] 这条消息里如果有新的需求、变更或决定，先写进 BACKLOG.md（一条一行，带用户原话和日期），再动手做。当前：${tally(items)}。`);
  process.exit(0);
}

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

if (mode === "--check") {
  if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
  console.log(`BACKLOG.md 格式正常。${tally(items)}`);
  process.exit(0);
}

console.log(tally(items) + "\n" + show(items));
if (problems.length) { console.error("\n格式问题：\n- " + problems.join("\n- ")); process.exit(1); }
