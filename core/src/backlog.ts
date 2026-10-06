/**
 * The backlog file format (BACKLOG.md) as pure functions, so the checker, the hooks and the tests share one reader.
 *
 * An item is one line:  - [ ] B12 · title — 来源：「the user's words」（10-06）· 备注
 *   [ ] open   [~] in progress   [x] done (must say 验证：)   [-] not doing / parked (must say 原因：)
 * Finished items are moved to BACKLOG-DONE.md by `archive`; their numbers are never used again.
 */

export interface Item { mark: string; id: string; text: string; line: number; section: string }

const LINE = /^- \[([ ~x-])\] (B\d+) · (.+)$/;

export function parse(markdown: string, known: ReadonlySet<string> = new Set()): { items: Item[]; problems: string[] } {
  const items: Item[] = [];
  const problems: string[] = [];
  const seen = new Set<string>(known);
  let section = "";
  markdown.split("\n").forEach((raw, i) => {
    const line = i + 1;
    if (raw.startsWith("## ")) section = raw.slice(3).trim();
    if (!raw.startsWith("- [")) return;
    const m = LINE.exec(raw);
    if (!m) return void problems.push(`第 ${line} 行：条目格式不对（要 “- [ ] B12 · 标题 — 来源：…”）`);
    const [, mark, id, text] = m as unknown as [string, string, string, string];
    if (seen.has(id)) problems.push(`第 ${line} 行：编号 ${id} 重复（归档里的编号也不能再用）`);
    seen.add(id);
    if (!text.includes("来源：")) problems.push(`第 ${line} 行 ${id}：没写来源（用户原话或哪次讨论）`);
    if (mark === "x" && !text.includes("验证：")) problems.push(`第 ${line} 行 ${id}：标了完成但没写“验证：”（提交号、测试名或实测结果）`);
    if (mark === "-" && !text.includes("原因：")) problems.push(`第 ${line} 行 ${id}：标了不做/暂缓但没写“原因：”`);
    items.push({ mark: mark!, id: id!, text: text!, line, section });
  });
  return { items, problems };
}

/**
 * Takes the finished items out of the list. Returns the list without them (a section left with nothing in it goes
 * too) and the lines that were taken, in their order. Nothing else in the file is touched.
 */
export function archive(markdown: string): { kept: string; moved: string[] } {
  const moved: string[] = [];
  const isDone = (l: string) => /^- \[x\] B\d+ · /.test(l);
  // Blocks: the text before the first heading, then one block per "## " section.
  const blocks: string[][] = [[]];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) blocks.push([line]); else blocks.at(-1)!.push(line);
  }
  const kept = blocks.flatMap((block, index) => {
    const taken = block.filter(isDone);
    const rest = block.filter(l => !isDone(l));
    moved.push(...taken);
    // A section the move emptied (only blank lines are left under its heading) goes with it.
    if (index > 0 && taken.length && rest.slice(1).every(l => l.trim() === "")) return [];
    return rest;
  });
  return { kept: kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"), moved };
}

export function tally(items: Item[], archived = 0): string {
  const n = (m: string) => items.filter(i => i.mark === m).length;
  return `待办 ${n(" ")} · 进行中 ${n("~")} · 已完成 ${n("x") + archived} · 不做/暂缓 ${n("-")}`;
}
