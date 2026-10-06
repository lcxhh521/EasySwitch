import assert from "node:assert/strict";
import { test } from "node:test";
import { archive, parse, tally } from "../src/backlog.ts";

const SAMPLE = `# 待办

规则说明。

## 主线

- [ ] B1 · 还没做 — 来源：「甲」（10-06）
- [x] B2 · 做完了 — 来源：「乙」（10-06）· 验证：提交 abc
- [~] B3 · 做一半 — 来源：「丙」（10-06）

## 全做完的一节

- [x] B4 · 也做完了 — 来源：「丁」（10-06）· 验证：测试 t

## 另一节

- [-] B5 · 不做 — 来源：「戊」（10-06）· 原因：太贵
`;

test("finished items are taken out with their evidence, the rest of the file is untouched, and a section that was emptied goes too", () => {
  const { kept, moved } = archive(SAMPLE);
  assert.deepEqual(moved.map(l => /B\d+/.exec(l)![0]), ["B2", "B4"]);
  assert.ok(moved[0]!.includes("验证：提交 abc") && moved[0]!.includes("乙"), "the evidence and the user's words travel with it");
  assert.ok(!kept.includes("B2") && !kept.includes("B4"));
  assert.ok(kept.includes("规则说明。") && kept.includes("B1") && kept.includes("B3") && kept.includes("B5"));
  assert.ok(!kept.includes("全做完的一节"), "a section with nothing left is removed");
  assert.ok(kept.includes("## 主线") && kept.includes("## 另一节"));
  assert.ok(kept.endsWith("\n") && !kept.includes("\n\n\n"));
  // Archiving twice moves nothing more.
  assert.deepEqual(archive(kept).moved, []);
});

test("an archived number can never be used again, and an unfinished claim of 'done' is caught", () => {
  const archived = parse("- [x] B2 · 旧的 — 来源：「乙」（10-06）· 验证：x\n").items.map(i => i.id);
  const again = parse("- [ ] B2 · 又用了同一个编号 — 来源：「甲」（10-06）\n", new Set(archived));
  assert.ok(again.problems.some(p => /编号 B2 重复/.test(p)));
  const noProof = parse("- [x] B9 · 没有证据 — 来源：「甲」（10-06）\n");
  assert.ok(noProof.problems.some(p => /验证/.test(p)));
  assert.equal(tally(parse(SAMPLE).items, 3), "待办 1 · 进行中 1 · 已完成 5 · 不做/暂缓 1", "the tally counts what was archived");
});
