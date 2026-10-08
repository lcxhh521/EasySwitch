import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";
import vm from "node:vm";

// All transport is a delayed in-memory fixture. No server, subprocess, account or model is used.
type Handler = (event: any) => unknown;
type Kind = "quick" | "full";
const test = (name: string, fn: () => Promise<void>) => nodeTest(name, { timeout: 10_000 }, fn);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const record = (id: string, status = "running") => ({ id, task: `Fixture ${id}`, agent: "hermes", from: "console", model: "fixture/model", at: 1, status, output: status === "done" ? `Output ${id}` : "", elapsedMs: 1, usage: { unknownCost: true } });

function ui(initial: Kind = "full", modules: string[] = []) {
  const handlers: Record<string, Handler[]> = {}, windowHandlers: Record<string, Handler[]> = {};
  const requests: Array<{ method: string; path: string; body?: any }> = [], messages: string[] = [], history: string[] = [], focused: string[] = [];
  const timers = new Map<number, { callback: () => void; delay: number }>(); let timerId = 0;
  const pending: Array<{ resolve: (value: any) => void; reject: (error: any) => void }> = [];
  const location = { search: "", hash: initial === "quick" ? "#agents" : "#tasks" };
  let html = "", currentForm: Form | null = null, taskNodes: any[] = [];
  const added: any[] = [];
  const element = () => ({ textContent: "", className: "", children: [] as any[], events: {} as Record<string, Handler>,
    append(...nodes: any[]) { this.children.push(...nodes); }, addEventListener(name: string, handler: Handler) { this.events[name] = handler; }, remove() {} });
  let delayReads = false, finishRead: (() => void) | null = null;
  let serverTasks = { tasks: [] as any[], tree: [] as any[], running: 0 };
  const serverState = { providers: [{ id: "fixture", name: "Fixture", models: ["model"], supportedProtocols: ["chat"], hasKey: true }], rules: [], bindings: {}, prefs: {}, pools: [] };
  class Form {
    dataset: Record<string, string>;
    attrs: Record<string, string> = {};
    elements: Record<string, any>;
    button: any;
    kind: Kind;
    constructor(kind: Kind, values: Record<string, string>, busy: boolean) {
      this.kind = kind;
      this.dataset = kind === "quick" ? { quickTask: "" } : { taskForm: "" };
      this.elements = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, { name, value, closest: (s: string) => this.closest(s), matches: () => false }]));
      this.button = { disabled: busy, textContent: busy ? "正在派发…" : kind === "quick" ? "派出去（自动选）" : "派出去", setAttribute() {}, removeAttribute() {} };
    }
    matches(selector: string) { return selector.split(",").some(s => s.trim() === (this.kind === "quick" ? "[data-quick-task]" : "[data-task-form]") || s.trim() === (this.kind === "quick" ? "form[data-quick-task]" : "form[data-task-form]")); }
    closest(selector: string) { return this.matches(selector) ? this : null; }
    querySelector(selector: string) { return selector.includes("submit") ? this.button : selector.startsWith("[data-task-agent]") ? { dataset: { taskAgent: "hermes" } } : null; }
    querySelectorAll(selector: string) { return selector.includes("submit") ? [this.button] : []; }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    removeAttribute(name: string) { delete this.attrs[name]; }
  }
  const document = {
    activeElement: null, createElement: element, body: { append(node: any) { added.push(node); } },
    addEventListener(name: string, handler: Handler) { (handlers[name] ??= []).push(handler); },
    querySelector(selector: string) { return currentForm?.matches(selector) ? currentForm : null; },
    querySelectorAll(selector: string) {
      if (selector.includes("data-task-progress-id") || selector.includes("data-task-toggle")) return taskNodes;
      return currentForm?.matches(selector) ? [currentForm] : [];
    },
  };
  const context = vm.createContext({ URLSearchParams, console, location, document,
    window: { addEventListener(name: string, handler: Handler) { (windowHandlers[name] ??= []).push(handler); } },
    history: { replaceState(_state: unknown, _title: string, hash: string) { history.push(hash); location.hash = hash; } },
    localStorage: { getItem: () => null, setItem() {} },
    FormData: class { form: Form; constructor(form: Form) { this.form = form; } get(name: string) { const field = this.form.elements[name]; return field?.omitFromFormData ? null : field?.value ?? null; } },
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id: number) { timers.delete(id); }, requestAnimationFrame: () => 0,
    fetch() { throw new Error("Real transport is forbidden"); },
  });
  const run = (source: string): any => vm.runInContext(source, context);
  for (const name of ["errors", "task-progress", ...modules]) run(readFileSync(new URL(`../../web/${name}.js`, import.meta.url), "utf8"));
  const app = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  run(app.slice(0, app.lastIndexOf('fetch("icons/manifest.json")')));
  context.fixtureState = serverState;
  context.fixtureCall = async (method: string, path: string, body?: any) => {
    requests.push({ method, path, ...(body ? { body: JSON.parse(JSON.stringify(body)) } : {}) });
    if (method === "POST") {
      assert.equal(path, "/api/tasks");
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    }
    if (path === "/api/state") return serverState;
    if (path === "/api/tasks") {
      const snapshot = JSON.parse(JSON.stringify(serverTasks));
      if (delayReads) { delayReads = false; await new Promise<void>(resolve => { finishRead = resolve; }); }
      return snapshot;
    }
    if (path === "/api/plan") return { accounts: [] };
    if (path === "/api/doctor") return { findings: [], notice: "Fixture diagnostics" };
    if (path === "/api/chatgpt" || path === "/api/claude-desktop") return null;
    throw new Error(`Unexpected fixture route: ${method} ${path}`);
  };
  context.fixtureToast = (message: string) => messages.push(message);
  context.fixtureRender = (view: string, rendered: string) => {
    html = rendered;
    currentForm = view === "tasks" ? new Form("full", JSON.parse(run("JSON.stringify(taskForm)")), /data-task-form[^>]*aria-busy="true"/.test(html))
      : view === "agents" ? new Form("quick", { task: run('typeof quickTaskDraft === "undefined" ? "" : quickTaskDraft') }, /data-quick-task[^>]*aria-busy="true"/.test(html)) : null;
    taskNodes = [...html.matchAll(/data-task-(progress-id|toggle)="([^"]+)"/g)].map(match => ({
      dataset: match[1] === "progress-id" ? { taskProgressId: match[2] } : { taskToggle: match[2] },
      setAttribute() {}, focus() { focused.push(match[2]!); }, scrollIntoView() {},
    }));
  };
  run(`state=fixtureState;presets=[{}];agentList=[{id:"hermes",name:"Fixture agent",installed:true,can:{headless:true,efforts:["high"]}}];
    taskList={tasks:[],tree:[],running:0};call=fixtureCall;globalThis.fixtureOriginalToast=toast;toast=fixtureToast;renderHeader=()=>{};
    render=()=>fixtureRender(page,page==="tasks"?renderTasks():page==="agents"?quickTask():"Other page");render();`);
  const dispatch = async (name: string, target: any) => {
    let stopped = false;
    for (const handler of handlers[name] ?? []) {
      await handler({ target, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
      if (stopped) break;
    }
  };
  const form = () => { assert.ok(currentForm); return currentForm; };
  const edit = async (values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values)) {
      form().elements[name] ??= { name, closest: (s: string) => form().closest(s), matches: () => false };
      form().elements[name].value = value;
      await dispatch(name === "model" ? "change" : "input", form().elements[name]);
    }
  };
  const nav = async (page: string) => {
    const node = { dataset: { page }, closest: (s: string) => s === "#nav button, [data-go]" ? node : null };
    await dispatch("click", node);
  };
  const action = (kind: "first" | "doctor", name: string) => {
    const node = { dataset: { [kind === "first" ? "firstAction" : "doctorAction"]: name }, closest: (s: string) => s === `[data-${kind}-action]` ? node : null };
    return dispatch("click", node);
  };
  const errorToast = (target: string) => {
    run(`fixtureOriginalToast("Fixture issue", { action: { label: "Go", target: ${JSON.stringify(target)} }, details: {} })`);
    const button = added.at(-1).children[0];
    return () => button.events.click({});
  };
  return { run, requests, messages, history, focused, form, edit, nav, action, errorToast,
    html: () => html, render: () => run("render()"), refresh: () => run("refresh(true)"),
    submit: (target = form()) => dispatch("submit", target),
    hash: async (hash: string) => { location.hash = hash; for (const handler of windowHandlers.hashchange ?? []) await handler({}); await turn(); },
    finish: (id: string, status = "running", extras: any[] = []) => { const task = record(id, status); serverTasks = { tasks: [...extras, task], tree: [...extras, task], running: status === "running" ? 1 : 0 }; pending.shift()!.resolve({ task }); },
    fail: (error: any) => pending.shift()!.reject(error),
    malformed: () => pending.shift()!.resolve({}),
    expire: async (delay: number) => {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry, `Expected a ${delay}ms wait deadline`); timers.delete(entry[0]); entry[1].callback(); await turn();
    },
    delayRead: () => { delayReads = true; }, finishRead: () => { assert.ok(finishRead); finishRead(); },
  };
}

for (const kind of ["quick", "full"] as const) {
  test(`${kind} submission locks repeated events and rerendered forms until exact task is selected`, async () => {
    const app = ui(kind); await app.edit({ task: "Run fixture task" });
    const original = app.form(), first = app.submit(); await turn();
    assert.equal(original.button.disabled, true);
    await app.submit(original); app.render(); await app.submit();
    assert.equal(app.form().button.disabled, true);
    assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
    app.finish("t-requested", "running", [record("t-unrelated")]); await first;
    assert.equal(app.run("page"), "tasks");
    assert.equal(app.run('taskOpenIds.has("t-requested")'), true);
    assert.equal(app.run('taskOpenIds.has("t-unrelated")'), false);
    assert.deepEqual(app.focused, ["t-requested"]);
    assert.equal(app.form().button.disabled, false);
    assert.match(app.html(), /data-task-progress-id="t-requested"/);
    assert.match(app.html(), /费用未知/);
  });

  test(`${kind} submission preserves drafts on uncertain failure and only retries explicitly`, async () => {
    const app = ui(kind);
    if (kind === "full") app.run('taskForm.agent="hermes";taskForm.effort="high";');
    await app.edit({ task: "  Keep exact draft\nline two  ", ...(kind === "full" ? { model: "fixture/model", cwd: "/fixture/project" } : {}) });
    const first = app.submit(); await turn();
    app.fail(new TypeError("Failed to fetch at private-secret.invalid")); await first;
    assert.equal(app.form().elements.task.value, "  Keep exact draft\nline two  ");
    if (kind === "full") {
      assert.equal(app.form().elements.model.value, "fixture/model"); assert.equal(app.form().elements.cwd.value, "/fixture/project");
      assert.equal(app.run("taskForm.effort"), "high"); assert.equal(app.run("taskForm.agent"), "hermes");
    }
    assert.equal(app.form().button.disabled, false);
    assert.match(app.html(), /确认|任务记录/); assert.doesNotMatch(app.html(), /private-secret/);
    await app.refresh();
    assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
    const retry = app.submit(); await turn(); assert.equal(app.requests.filter(r => r.method === "POST").length, 2);
    app.finish("t-retry", "done"); await retry;
    assert.equal(app.form().elements.task.value, ""); assert.match(app.html(), /Output t-retry/);
    assert.deepEqual(app.focused, ["t-retry"]);
  });

  test(`${kind} success keeps newer text entered while waiting`, async () => {
    const app = ui(kind); await app.edit({ task: "Original" });
    const first = app.submit(); await turn(); await app.edit({ task: "New draft during request" });
    const liveForm = app.form(), liveInput = liveForm.elements.task;
    app.finish("t-first"); await first;
    assert.equal(app.run("page"), kind === "quick" ? "agents" : "tasks");
    assert.equal(app.form(), liveForm); assert.equal(app.form().elements.task, liveInput);
    assert.deepEqual(app.focused, []); assert.equal(app.history.includes("#tasks"), false);
    assert.equal(app.form().elements.task.value, "New draft during request");
    assert.equal(app.run('taskOpenIds.has("t-first")'), true);
  });
}

test("submission guard is shared across the two entry points, but allows later intentional repeats", async () => {
  const app = ui("quick"); await app.edit({ task: "Same requested task" });
  const first = app.submit(); await turn(); await app.nav("tasks"); await app.edit({ task: "Same requested task" });
  await app.submit(); assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
  app.finish("t-one"); await first;
  assert.equal(app.run("page"), "tasks"); assert.deepEqual(app.focused, []);
  const next = app.submit(); await turn(); assert.equal(app.requests.filter(r => r.method === "POST").length, 2);
  app.finish("t-two"); await next;
  assert.deepEqual(app.focused, ["t-two"]);
});

for (const navigation of ["away", "away-back", "hash-away-back"] as const) {
  test(`late quick submission success respects ${navigation} navigation`, async () => {
    const app = ui("quick"); await app.edit({ task: "Original" }); const first = app.submit(); await turn();
    if (navigation === "hash-away-back") { await app.hash("#settings"); await app.hash("#agents"); }
    else { await app.nav("settings"); if (navigation === "away-back") await app.nav("agents"); }
    app.finish("t-late"); await first;
    assert.equal(app.run("page"), navigation === "away" ? "settings" : "agents");
    assert.deepEqual(app.focused, []); assert.equal(app.history.includes("#tasks"), false);
  });
}

test("navigation during the success refresh also prevents task focus", async () => {
  const app = ui("quick"); await app.edit({ task: "Original" }); const first = app.submit(); await turn();
  app.delayRead(); app.finish("t-late-refresh"); await turn(); await app.nav("settings"); app.finishRead(); await first;
  assert.equal(app.run("page"), "settings"); assert.deepEqual(app.focused, []);
});

test("malformed accepted response preserves the draft without an automatic retry", async () => {
  const app = ui("quick"); await app.edit({ task: "Keep this until confirmed" }); const first = app.submit(); await turn();
  app.malformed(); await first;
  assert.equal(app.run("page"), "agents"); assert.equal(app.form().elements.task.value, "Keep this until confirmed");
  assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
  assert.deepEqual(app.focused, []); assert.match(app.html(), /确认|任务记录/);
});


test("a stale disabled model omitted by native FormData cannot silently submit the default", async () => {
  const app = ui("full");
  app.run('taskForm.agent="hermes";taskForm.effort="high";');
  await app.edit({ task: "Keep selected model explicit", model: "fixture/model", cwd: "/fixture/project" });
  app.run("state.providers[0].off=true"); app.render();
  // A select still exposes its disabled selected option via .value, but FormData omits it.
  app.form().elements.model.omitFromFormData = true;
  await app.submit();
  assert.equal(app.requests.filter(r => r.method === "POST").length, 0);
  assert.equal(app.form().elements.model.value, "fixture/model");
  assert.equal(app.form().elements.task.value, "Keep selected model explicit");
  assert.equal(app.form().elements.cwd.value, "/fixture/project");
  assert.equal(app.run("taskForm.effort"), "high");
  assert.match(app.html(), /重新选择模型/);
});

test("new model and folder edits during submission preserve the next draft but cannot change the sent body", async () => {
  const app = ui("full"); app.run('taskForm.agent="hermes";taskForm.effort="high";');
  await app.edit({ task: "Original", model: "fixture/model", cwd: "/fixture/original" });
  const first = app.submit(); await turn();
  await app.edit({ model: "", cwd: "/fixture/next" });
  app.finish("t-original"); await first;
  assert.deepEqual(app.requests.find(r => r.method === "POST")!.body, { agent: "hermes", task: "Original", effort: "high", model: "fixture/model", cwd: "/fixture/original" });
  assert.equal(app.form().elements.task.value, "Original");
  assert.equal(app.form().elements.model.value, "");
  assert.equal(app.form().elements.cwd.value, "/fixture/next");
});


test("a retained error toast action invalidates a pending quick submission, including leave and return", async () => {
  const app = ui("quick");
  const goSettings = app.errorToast("settings"), goAgents = app.errorToast("agents");
  await app.edit({ task: "Original" }); const first = app.submit(); await turn();
  await goSettings(); await goAgents();
  app.finish("t-toast-late"); await first;
  assert.equal(app.run("page"), "agents"); assert.deepEqual(app.focused, []);
  assert.deepEqual(app.history, ["#settings", "#agents"]);
  assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
});

test("a current-page toast action preserves existing history and does not invalidate navigation", async () => {
  const app = ui("quick"), dismiss = app.errorToast("current");
  await app.edit({ task: "Original" }); const first = app.submit(); await turn();
  await dismiss(); assert.equal(app.run("pageNavigationVersion"), 0); assert.deepEqual(app.history, []);
  app.finish("t-current-action"); await first;
  assert.equal(app.run("page"), "tasks"); assert.deepEqual(app.focused, ["t-current-action"]);
});

for (const name of ["providers", "subscription", "agents", "resume"]) {
  test(`onboarding ${name} navigation invalidates a pending quick submission`, async () => {
    const app = ui("quick", ["onboarding"]); app.run("firstRun.active=true");
    await app.edit({ task: "Original" }); const first = app.submit(); await turn();
    await app.action("first", name); app.finish("t-wizard-late"); await first;
    const destination = name === "providers" || name === "subscription" ? "providers" : "agents";
    assert.equal(app.run("page"), destination); assert.deepEqual(app.history, [`#${destination}`]);
    assert.deepEqual(app.focused, []); assert.equal(app.run("pageNavigationVersion"), 1);
    assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
  });
}

test("doctor navigation actions invalidate requests and retain their history and confirmation behavior", async () => {
  const app = ui("quick", ["doctor"]); await app.edit({ task: "Original" });
  const first = app.submit(); await turn(); await app.nav("doctor");
  app.run('doctorConfirmation={kind:"provider",id:"fixture"}');
  const previous = app.run("pageNavigationVersion");
  await app.action("doctor", "open-agents");
  assert.equal(app.run("pageNavigationVersion"), previous + 1); assert.equal(app.run("doctorConfirmation"), null);
  app.finish("t-doctor-late"); await first;
  assert.equal(app.run("page"), "agents"); assert.deepEqual(app.history, ["#doctor", "#agents"]);
  assert.deepEqual(app.focused, []); assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
});


for (const kind of ["quick", "full"] as const) {
  test(`${kind} hanging POST unlocks with an uncertain result and a late success cannot affect a newer submission`, async () => {
    const app = ui(kind); await app.edit({ task: "Unconfirmed original" });
    const first = app.submit(); await turn(); await app.expire(30_000); await first;
    assert.equal(app.form().button.disabled, false);
    assert.equal(app.form().elements.task.value, "Unconfirmed original");
    assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
    assert.match(app.html(), /未能确认提交结果/); assert.deepEqual(app.focused, []);
    await app.edit({ task: "Explicit next submission" }); const second = app.submit(); await turn();
    app.finish("t-late-original"); await turn();
    assert.equal(app.form().button.disabled, true); assert.equal(app.run("taskSubmitPending"), true);
    assert.equal(app.form().elements.task.value, "Explicit next submission");
    assert.equal(app.run('taskOpenIds.has("t-late-original")'), false);
    assert.deepEqual(app.focused, []); assert.equal(app.run("page"), kind === "quick" ? "agents" : "tasks");
    app.finish("t-explicit-next"); await second;
    assert.deepEqual(app.focused, ["t-explicit-next"]); assert.equal(app.form().button.disabled, false);
  });

  test(`${kind} hanging task read-back unlocks without repeating POST or applying its late stale result`, async () => {
    const app = ui(kind); await app.edit({ task: "Confirmed original" });
    const first = app.submit(); await turn(); app.delayRead(); app.finish("t-confirmed"); await turn();
    await app.edit({ task: "Next draft" }); await app.expire(10_000); await first;
    assert.equal(app.form().button.disabled, false); assert.equal(app.form().elements.task.value, "Next draft");
    assert.equal(app.requests.filter(r => r.method === "POST").length, 1);
    assert.ok(app.messages.some(message => message.includes("任务已创建，但暂时没读到最新进度")));
    const second = app.submit(); await turn(); app.finishRead(); await turn();
    assert.equal(app.form().button.disabled, true); assert.equal(app.run("taskSubmitPending"), true);
    assert.equal(app.form().elements.task.value, "Next draft"); assert.deepEqual(app.focused, []);
    assert.equal(app.run('taskList.tasks.some(t=>t.id==="t-confirmed")'), false);
    app.finish("t-confirmed-next"); await second;
    assert.deepEqual(app.focused, ["t-confirmed-next"]); assert.equal(app.form().button.disabled, false);
  });
}


for (const kind of ["quick", "full"] as const) {
  test(`${kind} edits during read-back keep the live input and suppress result focus`, async () => {
    const app = ui(kind); await app.edit({ task: "Original" });
    const first = app.submit(); await turn(); app.delayRead(); app.finish("t-readback-edit"); await turn();
    // An unchanged quick submission has already shown the full task form here.
    await app.edit({ task: "Next draft during read-back" });
    const liveForm = app.form(), liveInput = liveForm.elements.task;
    app.finishRead(); await first;
    assert.equal(app.form(), liveForm); assert.equal(app.form().elements.task, liveInput);
    assert.equal(app.form().elements.task.value, "Next draft during read-back");
    assert.deepEqual(app.focused, []); assert.equal(app.form().button.disabled, false);
    assert.equal(app.run('taskList.tasks.some(t=>t.id==="t-readback-edit")'), true);
  });

  test(`${kind} edit and restore while POST waits still preserves the live input`, async () => {
    const app = ui(kind); await app.edit({ task: "Original" });
    const first = app.submit(); await turn(); await app.edit({ task: "Changed" }); await app.edit({ task: "Original" });
    const liveForm = app.form(), liveInput = liveForm.elements.task;
    app.finish("t-restored-edit"); await first;
    assert.equal(app.form(), liveForm); assert.equal(app.form().elements.task, liveInput);
    assert.equal(app.run("page"), kind === "quick" ? "agents" : "tasks"); assert.deepEqual(app.focused, []);
    assert.equal(app.form().elements.task.value, "Original");
  });
}


for (const kind of ["quick", "full"] as const) {
  test(`${kind} uncertain failure while editing preserves the live input and shows a non-destructive warning`, async () => {
    const app = ui(kind); await app.edit({ task: "Original" }); const first = app.submit(); await turn();
    await app.edit({ task: "New draft" }); const liveForm = app.form(), liveInput = liveForm.elements.task;
    app.fail(new TypeError("Failed to fetch")); await first;
    assert.equal(app.form(), liveForm); assert.equal(app.form().elements.task, liveInput);
    assert.equal(app.form().elements.task.value, "New draft"); assert.deepEqual(app.focused, []);
    assert.ok(app.messages.some(message => message.includes("未能确认提交结果")));
    assert.equal(app.form().button.disabled, false);
  });
}
