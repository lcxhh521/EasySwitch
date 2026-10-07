import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const source = readFileSync(new URL("../../web/task-progress.js", import.meta.url), "utf8");
function ui(withWindow = false) {
  const context = vm.createContext(withWindow ? { window: {} } : {});
  vm.runInContext(source, context);
  return {
    render: (data: unknown): string => { context.data = data; return vm.runInContext("taskProgressCard(data)", context); },
    run: (code: string): any => vm.runInContext(code, context),
  };
}
const task = (id: string, overrides: Record<string, unknown> = {}) => ({ id, agent: "hermes", model: "fixture/main", from: "console", task: `task ${id}`, status: "running", elapsedMs: 1250, usage: { unknownCost: true }, cleanupPending: false, cleanupFailed: 0, children: [], ...overrides });

test("runtime tree shows parent/child agent, model, elapsed and cost exactly once", () => {
  const app = ui();
  const child = task("t-child", { agent: "aider", model: "fixture/child", parentTaskId: "t-parent", from: "hermes", elapsedMs: 65000 });
  const parent = task("t-parent", { status: "done", children: [child], usage: { costUsd: 0.25, unknownCost: true } });
  const historical = task("t-history", { status: "done" });
  const html = app.render({ tree: [parent, historical], tasks: [parent, child, historical] });
  assert.equal((html.match(/data-task-progress-id="t-parent"/g) ?? []).length, 1);
  assert.equal((html.match(/data-task-progress-id="t-child"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /t-history/);
  assert.match(html, /aria-label="子任务"/); assert.match(html, /data-task-parent="t-parent"/);
  assert.match(html, /aider · fixture\/child · 已用 1 分 5 秒/);
  assert.match(html, /已记录估算 \$0\.2500 · 另有费用未知/);
  assert.match(html, /父任务费用包含子任务/); assert.match(html, /取消子任务/);
});

test("running remains cancellable while cancelling disables repeat cancellation and reports unconfirmed cleanup", () => {
  const app = ui();
  const running = app.render({ tree: [task("t-running", { cleanupPending: true })] });
  assert.match(running, /data-task-stop="t-running"/); assert.doesNotMatch(running, /disabled|正在清理/);
  const pending = app.render({ tree: [task("t-stopped", { status: "stopped", cleanupPending: true })] });
  assert.match(pending, /正在清理/); assert.match(pending, /data-task-stop="t-stopped" disabled aria-disabled="true"/);
  const failed = app.render({ tree: [task("t-failed", { status: "stopped", cleanupFailed: 1 })] });
  assert.match(failed, /清理未确认/); assert.match(failed, /进程或令牌的清理尚未确认/);
  assert.doesNotMatch(failed, /data-task-stop=/);
  assert.equal(app.render({ tree: [task("t-complete", { status: "stopped" })] }), "");
});

test("missing and invalid prices remain unknown; measured partial costs never become a free completed total", () => {
  const app = ui();
  for (const usage of [undefined, { costUsd: NaN, unknownCost: false }, { costUsd: -1, unknownCost: false }, { costUsd: Infinity, unknownCost: false }]) {
    const html = app.render({ tree: [task("t-price", { usage })] });
    assert.match(html, /费用未知/); assert.doesNotMatch(html, /\$0\.00|NaN|Infinity/);
  }
  assert.match(app.render({ tree: [task("t-zero", { usage: { costUsd: 0, unknownCost: false } })] }), /已记录估算 \$0\.00 · 另有费用未知/);
  assert.match(app.render({ tree: [task("t-small", { usage: { costUsd: 0.0000001, unknownCost: true } })] }), /小于 \$0\.0001/);
  const knownAncestor = task("t-known", { status: "done", usage: { costUsd: 1.5, unknownCost: false }, children: [task("t-active")] });
  assert.match(app.render({ tree: [knownAncestor] }), /已记录估算 \$1\.5000<\/p>/);
});

test("all dynamic labels and attributes are escaped, invalid action IDs cannot become cancellation targets", () => {
  const app = ui();
  const html = app.render({ tree: [task('bad"><img src=x>', {
    task: "<script>alert('task')</script>", agent: '<img src=x onerror="agent">', model: "<svg onload='model'>",
    parentTaskId: 'parent" onclick="bad', from: "<b>attacker</b>",
    fallbackChanges: [{ fromModel: "<old>", toModel: 'new" model', reason: "<script>" }],
  })] });
  assert.doesNotMatch(html, /<script>|<img|<svg|<b>|data-task-stop=/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&quot; onclick=&quot;bad/);
  assert.match(html, /模型已切换：&lt;old&gt; → new&quot; model/);
});

test("cyclic, duplicate and deeply nested input renders within two levels and a fixed node bound", () => {
  const app = ui();
  const root: any = task("t-root"), child: any = task("t-child"), deep = task("t-deep");
  root.children = [child, root]; child.children = [root, deep];
  const html = app.render({ tree: [root, child] });
  assert.equal((html.match(/data-task-progress-id=/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-task-progress-id="t-deep"/); assert.match(html, /部分任务层级未展开/);
  const many = app.render({ tree: Array.from({ length: 2000 }, (_, i) => task(`t-${i}`)) });
  assert.equal((many.match(/data-task-progress-id=/g) ?? []).length, 200);
  assert.match(many, /部分任务层级未展开/);
});

test("pure module works with globalThis and a separate window, with no DOM or networking dependencies", () => {
  const app = ui(true);
  assert.equal(app.run("typeof globalThis.taskProgressCard"), "function");
  assert.equal(app.run("window.taskProgressCard === globalThis.taskProgressCard"), true);
  for (const data of [null, undefined, {}, { tree: [] }, { tasks: [] }]) assert.equal(app.render(data), "");
  const child = task("t-child", { parentTaskId: "t-parent" });
  const html = app.render({ tasks: [task("t-parent"), child] });
  assert.match(html, /aria-label="子任务"/);
  assert.equal((html.match(/data-task-progress-id="t-child"/g) ?? []).length, 1);
});

test("elapsed handles zero, hours and invalid data; trusted fallback metadata shows only the latest change", () => {
  const app = ui();
  assert.match(app.render({ tree: [task("t-zero", { elapsedMs: 0 })] }), /已用 0 秒/);
  assert.match(app.render({ tree: [task("t-hours", { elapsedMs: 7384000 })] }), /已用 2 小时 3 分 4 秒/);
  assert.match(app.render({ tree: [task("t-bad", { elapsedMs: NaN })] }), /耗时未知/);
  const html = app.render({ tree: [task("t-switch", { fallbackChanges: [{ fromModel: "old/first", toModel: "old/second", reason: "source_unavailable" }, { fromModel: "source/current", toModel: "backup/current", reason: "quota_exhausted" }] })] });
  assert.match(html, /模型已切换：source\/current → backup\/current（来源额度已用尽）/);
  assert.doesNotMatch(html, /old\/first|old\/second/);
});

/** Real app handlers and refresh logic; only browser primitives and HTTP results are fake. */
function integratedUi(data: unknown) {
  const handlers: Record<string, Array<(event: any) => unknown>> = {};
  const context = vm.createContext({ URLSearchParams, console, location: { search: "", hash: "#tasks" },
    window: { addEventListener() {} }, history: { replaceState() {} },
    document: { addEventListener(name: string, handler: any) { (handlers[name] ??= []).push(handler); }, querySelector: () => ({ innerHTML: "", textContent: "", className: "" }), querySelectorAll: () => [], activeElement: null },
    localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {},
    fetch() { throw new Error("no real transport"); }, initialData: data,
  });
  vm.runInContext(source, context);
  const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(appSource.slice(0, appSource.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (code: string): any => vm.runInContext(code, context);
  run(`
    globalThis.requests=[];globalThis.messages=[];globalThis.html="";
    globalThis.serverState={providers:[],rules:[],bindings:{},prefs:{},pools:[]};
    globalThis.serverTasks=JSON.parse(JSON.stringify(initialData));
    state=serverState;agentList=[];presets=[{}];taskList=JSON.parse(JSON.stringify(initialData));
    render=()=>{html=renderTasks();};toast=message=>messages.push(message);showError=()=>messages.push("取消请求未完成");
    call=(method,path,body)=>{
      requests.push({method,path,body});
      if(method==="POST")return new Promise((resolve,reject)=>{globalThis.finishCancel=resolve;globalThis.failCancel=reject;});
      if(path==="/api/state")return Promise.resolve(serverState);
      if(path==="/api/tasks")return Promise.resolve(JSON.parse(JSON.stringify(serverTasks)));
      throw new Error("unexpected fake route");
    };render();
  `);
  const button = (id: string) => { const element: any = { dataset: { taskStop: id }, disabled: false, closest: (selector: string) => selector === "[data-task-stop]" ? element : null }; return element; };
  const click = async (target: any) => {
    let stopped = false;
    for (const handler of handlers.click ?? []) {
      await handler({ target, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
      if (stopped) break;
    }
  };
  return { run, button, click };
}

test("real app sends one cancel for repeated clicks, marks the whole tree pending immediately, and refreshes history after cleanup", async () => {
  const child = task("t-child", { parentTaskId: "t-parent", from: "hermes", agent: "aider" });
  const parent = task("t-parent", { children: [child] });
  const app = integratedUi({ tasks: [parent, child], tree: [parent], running: 2 });
  const button = app.button("t-parent"), pending = app.click(button);
  await new Promise(resolve => setImmediate(resolve));
  await app.click(button); await app.click(app.button("t-parent"));
  assert.equal(app.run('requests.filter(r=>r.method==="POST").length'), 1);
  assert.equal(app.run('requests.find(r=>r.method==="POST").path'), "/api/tasks/t-parent/stop");
  assert.equal(app.run('JSON.stringify(requests.find(r=>r.method==="POST").body)'), "{}");
  assert.equal(app.run('taskList.tasks.every(t=>t.status==="stopped"&&t.cleanupPending)'), true);
  assert.equal(app.run('taskList.tree[0].children[0].cleanupPending'), true);
  assert.equal((app.run("html").match(/disabled aria-disabled="true"/g) ?? []).length, 2);
  assert.doesNotMatch(app.run("html"), /data-task-toggle="t-parent"|data-task-toggle="t-child"/);
  app.run('serverTasks=JSON.parse(JSON.stringify(taskList));serverTasks.running=0;');
  await app.run("refresh()");
  assert.match(app.run("html"), /正在清理/);
  assert.equal(app.run('requests.filter(r=>r.path==="/api/tasks").length'), 1, "refresh still polls cleanup when running is zero");
  app.run('for(const t of serverTasks.tasks)t.cleanupPending=false;serverTasks.tree[0].cleanupPending=false;serverTasks.tree[0].children[0].cleanupPending=false;finishCancel({cleanup:{pending:0,failed:0}});');
  await pending;
  assert.equal(app.run("taskCancelPending.size"), 0);
  assert.equal(app.run("taskProgressCard(taskList)"), "");
  assert.match(app.run("html"), /data-task-toggle="t-parent"/);
  assert.match(app.run("html"), /data-task-toggle="t-child"/);
  assert.doesNotMatch(app.run("html"), /正在清理/);
  assert.equal(app.run('requests.filter(r=>r.path==="/api/tasks").length'), 2);
});

test("real app clears a failed cancel attempt, refreshes authoritative running state, and allows one explicit retry", async () => {
  const active = task("t-active"), app = integratedUi({ tasks: [active], tree: [active], running: 1 });
  const first = app.click(app.button("t-active"));
  await new Promise(resolve => setImmediate(resolve));
  app.run('failCancel(new Error("fixture unavailable"));');
  await first;
  assert.equal(app.run("taskCancelPending.size"), 0);
  assert.equal(app.run("taskList.tasks[0].status"), "running");
  assert.match(app.run("html"), /data-task-stop="t-active"/); assert.doesNotMatch(app.run("html"), /正在清理/);
  assert.equal(app.run("messages[0]"), "取消请求未完成");
  const second = app.click(app.button("t-active"));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.run('requests.filter(r=>r.method==="POST").length'), 2);
  app.run('serverTasks.tasks[0].status="stopped";serverTasks.tree[0].status="stopped";serverTasks.running=0;finishCancel({cleanup:{pending:0,failed:1}});');
  await second;
  assert.match(app.run("messages.at(-1)"), /清理尚未确认/);
});
