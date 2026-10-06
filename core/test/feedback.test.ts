import assert from "node:assert/strict";
import fs, { existsSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FeedbackBook, FeedbackStoreError } from "../src/feedback.ts";

const NOW = new Date("2026-10-06T12:00:00Z");
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-feedback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: join(dir, "task-feedback.json"), book: new FeedbackBook(dir, { now: () => NOW }) };
}

test("no feedback stays empty and never rewrites existing task or usage ledgers", t => {
  const { dir, file, book } = fixture(t);
  writeFileSync(join(dir, "tasks.jsonl"), "existing tasks bytes\n");
  writeFileSync(join(dir, "usage.jsonl"), "existing usage bytes\n");
  assert.deepEqual(book.list(), []); assert.equal(book.get("t-1"), undefined); assert.equal(existsSync(file), false);
  assert.equal(book.set({ id: "t-1", status: "done" }, null), undefined);
  assert.equal(existsSync(file), false);
  book.set({ id: "t-1", status: "done" }, "good");
  assert.equal(readFileSync(join(dir, "tasks.jsonl"), "utf8"), "existing tasks bytes\n");
  assert.equal(readFileSync(join(dir, "usage.jsonl"), "utf8"), "existing usage bytes\n");
});

test("ratings persist at 0600 without prompts, outputs, paths or extra task fields", t => {
  const { dir, file, book } = fixture(t);
  const task = { id: "t-private", status: "done" as const, task: "sensitive prompt never copy", output: "private answer", cwd: "/private/project" };
  book.set(task, "good");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(saved, { version: 1, ratings: [{ taskId: task.id, rating: "good", at: NOW.toISOString() }] });
  for (const secret of [task.task, task.output, task.cwd]) assert.equal(readFileSync(file, "utf8").includes(secret), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new FeedbackBook(dir).list(), saved.ratings);
});

test("repeat clicks, corrections and clearing yield at most one current rating per task", t => {
  const { book } = fixture(t), task = { id: "t-1", status: "done" as const };
  book.set(task, "good"); book.set(task, "good");
  assert.equal(book.list().length, 1);
  book.set(task, "bad"); assert.equal(book.get(task.id)?.rating, "bad");
  const copy = book.list(); copy[0]!.rating = "good";
  assert.equal(book.get(task.id)?.rating, "bad");
  book.set(task, null); assert.deepEqual(book.list(), []);
});

test("running tasks, unknown ratings and invalid ids fail without creating a feedback file", t => {
  const { file, book } = fixture(t);
  assert.throws(() => book.set({ id: "t-1", status: "running" }, "good"), /结束/);
  assert.throws(() => book.set({ id: "../escape", status: "done" }, "good"));
  assert.throws(() => book.set({ id: "t-1", status: "done" }, "maybe" as never));
  assert.equal(existsSync(file), false);
});

test("corrupt, duplicate or unsupported version data is preserved and never silently reset", t => {
  const { file, book } = fixture(t);
  const rating = { taskId: "t-1", rating: "good", at: NOW.toISOString() };
  for (const raw of ["broken json", JSON.stringify({ version: 2, ratings: [] }), JSON.stringify({ version: 1, ratings: [rating, rating] }), JSON.stringify({ version: 1, ratings: [{ ...rating, prompt: "must not migrate silently" }] })]) {
    writeFileSync(file, raw, { mode: 0o600 });
    assert.throws(() => book.list(), FeedbackStoreError);
    assert.throws(() => book.set({ id: "t-2", status: "done" }, "bad"), FeedbackStoreError);
    assert.equal(readFileSync(file, "utf8"), raw);
  }
});

test("failed atomic saves preserve the last rating and sanitize errors; retry can succeed", t => {
  const { file, book } = fixture(t), task = { id: "t-1", status: "done" as const };
  book.set(task, "good"); const before = readFileSync(file, "utf8");
  const original = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((path, data, options) => {
    if (typeof path === "string" && path.startsWith(`${file}.`) && path.endsWith(".tmp")) {
      original(path, "partial", options); throw new Error("private low-level failure details");
    }
    return original(path, data, options);
  }) as typeof fs.writeFileSync);
  syncBuiltinESMExports();
  try {
    assert.throws(() => book.set(task, "bad"), error => error instanceof FeedbackStoreError && !error.message.includes("private low-level"));
    assert.equal(readFileSync(file, "utf8"), before);
    assert.equal(book.get(task.id)?.rating, "good");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  book.set(task, "bad"); assert.equal(book.get(task.id)?.rating, "bad");
});

test("feedback refuses a symlink and never modifies its target", t => {
  const { dir, file, book } = fixture(t);
  const target = join(dir, "unrelated.json"); writeFileSync(target, "unrelated", { mode: 0o600 }); symlinkSync(target, file);
  assert.throws(() => book.list(), FeedbackStoreError);
  assert.throws(() => book.set({ id: "t-1", status: "done" }, "good"), FeedbackStoreError);
  assert.equal(readFileSync(target, "utf8"), "unrelated");
  assert.equal(readdirSync(dir).filter(name => name.endsWith(".tmp")).length, 0);
});
