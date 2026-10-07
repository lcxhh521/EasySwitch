import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

// Pure browser-script fixtures: no server, agent, credentials, native HOME or real fetch.
const web = (file: string) => readFileSync(new URL(`../../web/${file}`, import.meta.url), "utf8");
const index = web("index.html");
const css = web("style.css");
type Handler = (event: any) => unknown;

function attributes(source: string) {
  return Object.fromEntries([...source.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(m => [m[1]!, m[2] ?? ""]));
}

function shell(options: { hash?: string; panel?: boolean; stored?: string; storage?: "getter" | "methods" | "write" } = {}) {
  const documentHandlers: Record<string, Handler[]> = {}, windowHandlers: Record<string, Handler[]> = {};
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const writes: Array<[string, string]> = [];
  const storage = new Map(options.stored === undefined ? [] : [["easyswitch.theme", options.stored]]);
  const location = { search: options.panel ? "?panel=1" : "", hash: options.hash ?? "" };
  const history: string[] = [];
  const messages: string[] = [];
  let activeElement: Element | null = null;
  class Element {
    tag: string;
    attrs: Record<string, string>;
    dataset: Record<string, string>;
    disabled: boolean;
    textContent = "";
    className = "";
    removed = false;
    values: Record<string, string> = {};
    children: Element[] = [];
    private html = "";
    constructor(tag: string, attrs: Record<string, string> = {}) {
      this.tag = tag; this.attrs = attrs; this.disabled = "disabled" in attrs;
      this.dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith("data-")).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), v]));
    }
    get id() { return this.attrs.id; }
    get innerHTML() { return this.html; }
    set innerHTML(value: string) {
      // Browser focus is lost when innerHTML detaches the active control.
      if (activeElement && this.children.includes(activeElement)) activeElement = null;
      this.html = value; this.children = parseElements(value);
    }
    classes = new Set<string>();
    classList = { add: (name: string) => { this.classes.add(name); }, toggle: (name: string, on: boolean) => { if (on) this.classes.add(name); else this.classes.delete(name); } };
    getAttribute(name: string) { return this.attrs[name] ?? null; }
    setAttribute(name: string, value: string) { this.attrs[name] = value; }
    removeAttribute(name: string) { delete this.attrs[name]; }
    focus() { activeElement = this; }
    remove() { this.removed = true; }
    matches(selector: string): boolean {
      return selector.split(",").some(part => {
        const s = part.trim();
        if (s === "#nav button") return this.tag === "button" && "data-page" in this.attrs;
        if (s.startsWith("#")) return this.id === s.slice(1);
        const match = /^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(s);
        return !!match && (!match[1] || this.tag === match[1]) && (!match[2] || match[2] in this.attrs && (match[3] === undefined || this.attrs[match[2]] === match[3]));
      });
    }
    closest(selector: string) { return this.matches(selector) ? this : null; }
    querySelectorAll(selector: string) { return this.children.filter(node => node.matches(selector)); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  function parseElements(html: string) {
    return [...html.matchAll(/<(button|main|div|small|h1|p|nav|form|input|select|textarea)\b([^>]*)>/g)].map(m => new Element(m[1]!, attributes(m[2]!)));
  }
  const staticNodes = parseElements(index);
  const page = staticNodes.find(node => node.id === "page")!;
  const root = new Element("html");
  const body = new Element("body");
  const nodes = () => [...staticNodes, ...page.children].filter(node => !node.removed);
  const querySelectorAll = (selector: string) => nodes().filter(node => node.matches(selector));
  const document = { documentElement: root, body, get activeElement() { return activeElement; }, querySelectorAll,
    querySelector: (selector: string) => querySelectorAll(selector)[0] ?? null,
    addEventListener: (name: string, handler: Handler) => { (documentHandlers[name] ??= []).push(handler); },
  };
  const fixtureState = {
    version: "shell-fixture", native: [], sessions: [], sessionDetails: [], log: [], bindings: {}, prefs: {}, profiles: [], pools: [], rules: [], gatewaySessions: [],
    providers: [{ id: "fixture", name: "Fixture source", icon: "letter:F", models: ["fixture-model"], usedBy: [], hasKey: true, baseUrl: "http://127.0.0.1:1/v1", supportedProtocols: ["chat"] }],
    accounts: [{ id: "codex-fixture", label: "Codex fixture", harness: "codex", enabled: true }, { id: "claude-fixture", label: "Claude fixture", harness: "claude", enabled: true }],
    accountSettings: { autoPick: false },
  };
  const fixtureAgent = { id: "pi", name: "Fixture agent", icon: "letter:P", vendor: "Fixture", note: "VM fixture", support: "planned", installed: true, where: "/fixture/pi", can: { interactive: true, headless: true, efforts: ["off", "high"], tiers: [] } };
  const responses: Record<string, unknown> = {
    "/api/state": fixtureState,
    "/api/agents": { agents: [fixtureAgent] },
    "/api/chatgpt": null, "/api/claude-desktop": null,
    "/api/tasks": { tasks: [] },
    "/api/plan": { accounts: [{ id: "plan-fixture", label: "Plan fixture", kind: "codex", planUsage: true, needsSignIn: false, on: false }] },
    "/api/doctor": { notice: "Read-only fixture report", findings: [] },
    "/api/usage?range=7d": { totals: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, errors: 0, costUsd: 0, unpriced: 0 }, byProvider: {}, byHarness: {}, days: [] },
  };
  const sandbox: Record<string, unknown> = { URLSearchParams, URL, console, location, document,
    history: { replaceState(_state: unknown, _title: string, hash: string) { location.hash = hash; history.push(hash); } },
    window: { addEventListener(name: string, handler: Handler) { (windowHandlers[name] ??= []).push(handler); } },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0,
    FormData: class { form: Element; constructor(form: Element) { this.form = form; } get(name: string) { return this.form.values[name] ?? null; } },
    fetch: async (path: string, init: { method: string; body?: string }) => {
      // Never forwards a request, including actions that would launch an agent in production.
      const request = { method: init.method, path, ...(init.body ? { body: JSON.parse(init.body) } : {}) };
      requests.push(request);
      if (init.method === "GET") {
        assert.ok(Object.hasOwn(responses, path), `Unexpected fixture read: ${path}`);
        return { ok: true, json: async () => responses[path] };
      }
      assert.match(path, /^\/api\/accounts(?:\/|$)/, "Only explicitly exercised account actions have fixture responses");
      return { ok: true, json: async () => ({ account: { label: "Fixture" }, keptDirectory: "/fixture/kept" }) };
    },
  };
  const localStorage = {
    getItem(key: string) { if (options.storage === "methods") throw new Error("Storage denied"); return storage.get(key) ?? null; },
    setItem(key: string, value: string) { if (options.storage === "methods" || options.storage === "write") throw new Error("Storage denied"); writes.push([key, value]); storage.set(key, value); },
  };
  sandbox.localStorage = localStorage;
  const context = vm.createContext(sandbox);
  const run = (source: string) => vm.runInContext(source, context);
  // Define a throwing browser getter inside the VM: its global proxy suppresses
  // exceptions from host-defined accessors and would otherwise test undefined.
  if (options.storage === "getter") run('Object.defineProperty(globalThis, "localStorage", { get() { throw new Error("Storage denied"); } })');
  for (const file of ["theme.js", "controls.js", "doctor.js"]) run(web(file));
  const app = web("app.js"), startup = app.lastIndexOf('fetch("icons/manifest.json")');
  assert.ok(startup > 0, "Load all app handlers and panel setup, excluding startup polling and icon fetch");
  run(app.slice(0, startup));
  context.fixtureMessages = messages;
  run("toast = message => fixtureMessages.push(message)");
  const dispatch = async (handlers: Record<string, Handler[]>, name: string, target?: Element) => {
    let stopped = false;
    for (const handler of handlers[name] ?? []) { await handler({ target, preventDefault() {}, stopImmediatePropagation() { stopped = true; } }); if (stopped) break; }
    // hashchange intentionally starts refresh without awaiting it.
    await new Promise(resolve => setImmediate(resolve));
  };
  const node = (selector: string) => { const found = document.querySelector(selector); assert.ok(found, `Rendered control must exist: ${selector}`); return found; };
  return { run, requests, writes, storage, root, body, page, document, history, location, fixtureState,
    node, html: () => page.innerHTML,
    refresh: () => run("refresh(true)"),
    click: (selector: string) => dispatch(documentHandlers, "click", node(selector)),
    submit: (selector: string, values: Record<string, string>) => { const form = node(selector); form.values = values; return dispatch(documentHandlers, "submit", form); },
    hash: async (hash: string) => { location.hash = hash; await dispatch(windowHandlers, "hashchange"); },
  };
}

test("shell uses the approved navigation hierarchy, stable brand and pre-paint theme", () => {
  const primary = index.match(/class="nav-primary"[\s\S]*?<\/div>/)![0];
  const secondary = index.match(/class="nav-secondary"[\s\S]*?<\/div>/)![0];
  const pages = (html: string) => [...html.matchAll(/data-page="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(pages(primary), ["overview", "agents", "providers", "tasks"]);
  assert.deepEqual(pages(secondary), ["usage", "sessions", "doctor", "settings"]);
  assert.match(primary, /data-page="overview"[^>]*disabled[^>]*aria-disabled="true"/);
  assert.match(primary, /待接入/);
  assert.doesNotMatch(index, /data-page="accounts"/);
  assert.match(index, /class="logo" src="favicon.svg"/);
  assert.ok(index.indexOf('src="theme.js"') < index.indexOf('href="style.css"'));
  assert.match(index, /<nav[^>]*aria-label="主导航"/);
  assert.match(index, /<main id="page" tabindex="-1"/);
});

test("real sidebar navigation renders every existing page and preserves settings account controls", async () => {
  const app = shell();
  await app.refresh();
  assert.equal(app.run("page"), "agents");
  assert.match(app.html(), /data-quick-task|data-launch-agent/);
  const pages = [
    ["providers", "模型", /Fixture source/], ["tasks", "任务", /data-task-form/],
    ["usage", "用量", /data-range="7d"/], ["sessions", "会话记录", /id="flow"/],
    ["doctor", "自检", /Read-only fixture report/], ["settings", "设置", /订阅账号/],
  ] as const;
  for (const [page, title, content] of pages) {
    const nav = app.node(`[data-page="${page}"]`);
    nav.focus(); await app.click(`[data-page="${page}"]`);
    assert.equal(app.run("page"), page); assert.equal(app.location.hash, `#${page}`);
    assert.equal(app.node("#page-title").textContent, title); assert.match(app.html(), content);
    assert.equal(nav.getAttribute("aria-current"), "page"); assert.equal(app.document.activeElement, nav);
    assert.equal(app.document.querySelectorAll("#nav button").filter(node => node.getAttribute("aria-current") === "page").length, 1);
  }
  for (const id of ["codex-fixture", "claude-fixture"]) for (const action of ["launch", "rest", "toggle", "del"]) app.node(`[data-acc-${action}="${id}"]`);
  for (const harness of ["codex", "claude"]) { app.node(`form[data-add-account="${harness}"]`); assert.equal(app.node(`[data-acc-auto="${harness}"]`).disabled, true); }
  assert.match(app.html(), /data-theme-choice="system"/);
  assert.equal(app.requests.every(request => request.method === "GET"), true, "Navigating never triggers a mutating operation");
  const count = app.requests.length; await app.click('[data-page="overview"]');
  assert.equal(app.run("page"), "settings"); assert.equal(app.requests.length, count);
});

test("legacy and invalid deep links resolve safely, including later hash navigation", async () => {
  for (const [hash, expected] of [["#accounts", "settings"], ["#overview", "agents"], ["#unknown", "agents"], ["", "agents"]]) {
    const app = shell({ hash }); await app.refresh(); assert.equal(app.run("page"), expected);
    if (expected === "settings") assert.match(app.html(), /data-add-account="codex"/);
  }
  const app = shell(); await app.refresh();
  await app.hash("#accounts"); assert.equal(app.run("page"), "settings"); assert.match(app.html(), /订阅账号/);
  await app.hash("#tasks"); assert.equal(app.run("page"), "tasks"); assert.match(app.html(), /data-task-form/);
  await app.hash("#unknown"); assert.equal(app.run("page"), "agents");
});

test("account controls in settings still dispatch their original actions without executing them", async () => {
  const app = shell({ hash: "#accounts" }); await app.refresh();
  const changes = () => app.requests.filter(request => request.method !== "GET");
  await app.click('[data-acc-launch="codex-fixture"]');
  await app.click('[data-acc-rest="codex-fixture"]');
  await app.click('[data-acc-toggle="claude-fixture"]');
  await app.click('[data-acc-del="claude-fixture"]');
  await app.submit('form[data-add-account="claude"]', { label: "New fixture" });
  await app.click('[data-acc-autopick="ask"]');
  assert.match(app.html(), /我已了解，开启/); assert.equal(changes().length, 5);
  await app.click('[data-acc-autopick="cancel"]'); assert.doesNotMatch(app.html(), /我已了解，开启/);
  await app.click('[data-acc-autopick="ask"]'); await app.click('[data-acc-autopick="on"]');
  app.fixtureState.accountSettings.autoPick = true; await app.refresh();
  assert.equal(app.node('[data-acc-auto="codex"]').disabled, false);
  await app.click('[data-acc-auto="codex"]'); await app.click('[data-acc-autopick="off"]');
  assert.deepEqual(changes(), [
    { method: "POST", path: "/api/accounts/launch", body: { harness: "codex", accountId: "codex-fixture" } },
    { method: "PATCH", path: "/api/accounts/codex-fixture", body: { rest: true } },
    { method: "PATCH", path: "/api/accounts/claude-fixture", body: { enabled: false } },
    { method: "DELETE", path: "/api/accounts/claude-fixture" },
    { method: "POST", path: "/api/accounts", body: { harness: "claude", label: "New fixture" } },
    { method: "PUT", path: "/api/accounts/settings", body: { autoPick: true } },
    { method: "POST", path: "/api/accounts/launch", body: { harness: "codex" } },
    { method: "PUT", path: "/api/accounts/settings", body: { autoPick: false } },
  ]);
  assert.equal(app.writes.length, 0, "Account actions do not write browser preferences or secrets");
});

test("theme defaults to system and manual/system choices persist only their appearance key without HTTP", async () => {
  const app = shell({ hash: "#settings" }); await app.refresh();
  assert.equal(app.run("EasySwitchTheme.get()"), "system"); assert.equal(app.root.getAttribute("data-theme"), null); assert.equal(app.writes.length, 0);
  const count = app.requests.length;
  for (const choice of ["dark", "light", "system"]) {
    const button = app.node(`[data-theme-choice="${choice}"]`); button.focus();
    await app.click(`[data-theme-choice="${choice}"]`);
    assert.equal(app.run("EasySwitchTheme.get()"), choice);
    assert.equal(app.root.getAttribute("data-theme"), choice === "system" ? null : choice);
    assert.equal(button.getAttribute("aria-pressed"), "true"); assert.equal(app.document.activeElement, button);
    assert.equal(app.document.querySelectorAll("[data-theme-choice]").filter(node => node.getAttribute("aria-pressed") === "true").length, 1);
    assert.equal(app.requests.length, count); assert.equal(app.storage.get("easyswitch.theme"), choice);
    const reload = shell({ stored: choice }); assert.equal(reload.run("EasySwitchTheme.get()"), choice);
  }
  assert.deepEqual(app.writes, [["easyswitch.theme", "dark"], ["easyswitch.theme", "light"], ["easyswitch.theme", "system"]]);
  assert.equal(app.run('EasySwitchTheme.set("unexpected")'), false); assert.equal(app.writes.length, 3);
  assert.equal(app.root.getAttribute("data-theme"), null);
});

test("invalid or inaccessible storage preserves usable theme controls even with no core state", async () => {
  const invalid = shell({ stored: "<script>bad</script>" });
  assert.equal(invalid.run("EasySwitchTheme.get()"), "system"); assert.equal(invalid.root.getAttribute("data-theme"), null); assert.equal(invalid.writes.length, 0);
  for (const storage of ["getter", "methods", "write"] as const) {
    const app = shell({ hash: "#settings", storage }); app.run("render()");
    assert.match(app.html(), /连不上 EasySwitch/); assert.match(app.html(), /data-theme-choice="system"/);
    if (storage !== "write") assert.match(app.html(), /当前选择仅对本页面生效/);
    await app.click('[data-theme-choice="dark"]'); assert.equal(app.root.getAttribute("data-theme"), "dark");
    assert.match(app.node("[data-theme-note]").textContent, /当前选择仅对本页面生效/);
    assert.doesNotMatch(app.node("[data-theme-note]").textContent, /Storage denied/);
    await app.click('[data-theme-choice="system"]'); assert.equal(app.root.getAttribute("data-theme"), null);
    assert.equal(app.requests.length, 0); assert.equal(app.writes.length, 0);
  }
});

test("native keyboard controls retain navigation focus and the skip button focuses main content", async () => {
  const app = shell(); await app.refresh();
  assert.equal(app.node('[data-page="agents"]').tag, "button");
  assert.equal(app.node('[data-page="overview"]').disabled, true);
  await app.click("[data-skip-content]"); assert.equal(app.document.activeElement, app.page);
  assert.match(css, /button:focus-visible[^{}]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  assert.match(css, /\.skip-link:focus\s*\{[^}]*transform:\s*none/);
  for (const tag of ["a", "input", "select", "textarea", "summary"]) assert.ok(css.includes(`${tag}:focus-visible`), `${tag} has a visible focus treatment`);
});

test("routine polling preserves a focused theme control for uninterrupted keyboard selection", async () => {
  const app = shell({ hash: "#settings" }); await app.refresh();
  const button = app.node('[data-theme-choice="dark"]'); button.focus();
  await app.run("refresh()");
  assert.equal(app.document.activeElement, button, "The three-second refresh must not detach a focused theme button");
  await app.click('[data-theme-choice="dark"]');
  assert.equal(app.root.getAttribute("data-theme"), "dark");
});

function contrast(foreground: string, background: string) {
  const luminance = (color: string) => color.slice(1).match(/../g)!.map(v => parseInt(v, 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
  return (a! + 0.05) / (b! + 0.05);
}

test("light and dark shell text, selected navigation, status chips and focus rings meet contrast thresholds", () => {
  const tokens = (selector: string) => {
    const start = css.indexOf(selector); assert.ok(start >= 0);
    const block = css.slice(start, css.indexOf("}", start));
    return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(m => [m[1]!, m[2]!]));
  };
  const light = tokens(":root {"), dark = tokens(':root[data-theme="dark"] {');
  assert.deepEqual(tokens(':root:not([data-theme="light"]) {'), dark, "System dark and explicit dark use the same palette");
  for (const [name, palette] of [["light", light], ["dark", dark]] as const) {
    for (const [fg, bg] of [["fg", "bg"], ["fg", "card"], ["muted", "paper"], ["muted", "bg"], ["muted", "card"], ["muted", "seg-track"], ["accent", "accent-soft"], ["accent-fg", "accent"], ["green", "green-soft"], ["red", "red-soft"], ["amber", "amber-soft"]]) {
      assert.ok(contrast(palette[fg!]!, palette[bg!]!) >= 4.5, `${name} ${fg}/${bg} text must reach 4.5:1`);
    }
    for (const background of ["bg", "paper", "card"]) assert.ok(contrast(palette.accent!, palette[background]!) >= 3, `${name} focus ring on ${background} must reach 3:1`);
  }
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*dark\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test("narrow shell keeps both navigation groups scrollable and content free of a sidebar offset", () => {
  const narrow = css.slice(css.indexOf("@media (max-width: 900px)"), css.indexOf("@media (max-width: 600px)"));
  assert.match(narrow, /\.sidebar\s*\{[^}]*width:\s*100%/);
  assert.match(narrow, /\.shell-nav\s*\{[^}]*flex-direction:\s*row[^}]*overflow-x:\s*auto/);
  assert.match(narrow, /\.nav-primary,\s*\.nav-secondary\s*\{[^}]*display:\s*flex[^}]*flex:\s*none/);
  assert.match(narrow, /main\s*\{[^}]*margin:\s*0/);
  assert.match(css, /main\s*\{[^}]*min-width:\s*0/);
  assert.match(css, /\.row\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /\.theme-choice button\s*\{[^}]*flex:\s*1/);
});

test("menu-bar panel still opens on agents and keeps its native launch and subscription controls", async () => {
  const app = shell({ panel: true, hash: "#settings", stored: "dark" }); await app.refresh();
  assert.equal(app.run("page"), "agents"); assert.ok(app.body.classes.has("panel"));
  assert.equal(app.document.querySelector("#nav"), null); assert.equal(app.document.querySelector("#refresh"), null);
  assert.match(app.html(), /data-launch="codex"/); assert.match(app.html(), /data-launch="claude"/);
  assert.match(app.html(), /data-bridge="openConsole"/); assert.match(app.html(), /data-plan-switch="plan-fixture"/);
  assert.doesNotMatch(app.html(), /data-theme-choice|data-add-account/);
  await app.hash("#accounts"); assert.equal(app.run("page"), "agents"); assert.equal(app.history.length, 0);
  assert.equal(app.root.getAttribute("data-theme"), "dark");
  assert.match(css, /body\.panel \.sidebar[^{}]*\{[^}]*display:\s*none/);
  assert.match(css, /body\.panel main\s*\{[^}]*margin:\s*0/);
});
