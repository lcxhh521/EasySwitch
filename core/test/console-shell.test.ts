import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

function shell(options: { hash?: string; panel?: boolean; bridge?: boolean; stored?: string; storage?: "getter" | "methods" | "write" } = {}) {
  const documentHandlers: Record<string, Handler[]> = {}, windowHandlers: Record<string, Handler[]> = {};
  const requests: Array<{ method: string; path: string; body?: any }> = [];
  const writes: Array<[string, string]> = [];
  const storage = new Map(options.stored === undefined ? [] : [["easyswitch.theme", options.stored]]);
  const location = { search: options.panel ? "?panel=1" : "", hash: options.hash ?? "#agents" };
  const history: string[] = [];
  const visits = [location.hash];
  let visit = 0;
  const messages: string[] = [];
  const bridgeMessages: string[] = [];
  let activeElement: Element | null = null;
  class Element {
    tag: string;
    attrs: Record<string, string>;
    dataset: Record<string, string>;
    disabled: boolean;
    parentElement: Element | null = null;
    get tagName() { return this.tag.toUpperCase(); }
    contains(node: Element | null): boolean { return node === this || this.children.includes(node!); }
    textContent = "";
    value = "";
    className = "";
    removed = false;
    values: Record<string, string> = {};
    children: Element[] = [];
    listeners: Record<string, Handler[]> = {};
    append(...children: Element[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    addEventListener(name: string, handler: Handler) { (this.listeners[name] ??= []).push(handler); }
    async emit(name: string) { for (const handler of this.listeners[name] ?? []) await handler({ target: this }); }
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
      for (const child of this.children) if (!child.parentElement) child.parentElement = this;
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
        if (s.startsWith(".")) return (this.attrs.class ?? "").split(/\s+/).includes(s.slice(1));
        if (s.startsWith("#")) return this.id === s.slice(1);
        const match = /^(\w+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(s);
        return !!match && (!match[1] || this.tag === match[1]) && (!match[2] || match[2] in this.attrs && (match[3] === undefined || this.attrs[match[2]] === match[3]));
      });
    }
    closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    querySelectorAll(selector: string): Element[] { const nodes = new Set<Element>(); const visit = (node: Element) => { for (const child of node.children) { if (!nodes.has(child)) { nodes.add(child); visit(child); } } }; visit(this); return [...nodes].filter(node => node.matches(selector)); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  function parseElements(html: string) {
    const result: Element[] = [], stack: Element[] = [];
    for (const match of html.matchAll(/<(\/?)([a-z][\w-]*)\b([^>]*)>/g)) {
      const tag = match[2]!;
      if (match[1]) { const at = stack.findLastIndex(node => node.tag === tag); if (at >= 0) stack.length = at; continue; }
      const node = new Element(tag, attributes(match[3]!)); node.parentElement = stack.at(-1) ?? null; node.parentElement?.children.push(node); result.push(node);
      if (tag === "option") node.value = node.attrs.value ?? html.slice(match.index! + match[0].length).split("<")[0]!.trim();
      if (!["input", "img", "br", "hr", "meta", "link"].includes(tag)) stack.push(node);
    }
    for (const node of result) if (node.tag === "select") { const options = node.querySelectorAll("option"); node.value = (options.find(option => "selected" in option.attrs) ?? options[0])?.value ?? ""; }
    return result;
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
    createElement: (tag: string) => new Element(tag),
  };
  const fixtureState = {
    version: "shell-fixture", native: [], sessions: [], sessionDetails: [], log: [], bindings: {}, prefs: {}, profiles: [], pools: [], gatewaySessions: [],
    poolSuggestions: [{ id: "pool-suggestion-0123456789abcdef01234567", model: "fixture-model", members: [{ providerName: "Fixture source" }, { providerName: "Second fixture" }] }],
    providers: [{ id: "fixture", name: "Fixture source", icon: "letter:F", models: ["fixture-model"], usedBy: [], hasKey: true, baseUrl: "http://127.0.0.1:1/v1", supportedProtocols: ["chat"] }],
    accounts: [{ id: "codex-fixture", label: "Codex fixture", harness: "codex", enabled: true }, { id: "claude-fixture", label: "Claude fixture", harness: "claude", enabled: true }],
    accountSettings: { autoPick: false },
  };
  const fixtureAgent = { id: "pi", name: "Fixture agent", icon: "letter:P", vendor: "Fixture", note: "VM fixture", support: "planned", installed: true, where: "/fixture/pi", can: { interactive: true, headless: true, efforts: ["off", "high"], tiers: [] } };
  const fixtureAgents: any[] = [fixtureAgent];
  const responses: Record<string, unknown> = {
    "/api/overview": { version:"fixture", snapshotAt:new Date().toISOString(), display:{currency:"USD"}, activity:{observedSince:new Date().toISOString(),activeRequests:0,sessions:[]},sources:[],month:{estimatedCostUsd:0,unknownCostCalls:0,calls:0,startsAt:new Date().toISOString(),resetsAt:new Date().toISOString(),timezone:"UTC"},budget:{settings:{enabled:false}} },
    "/api/state": fixtureState,
    "/api/agents": { agents: fixtureAgents },
    "/api/chatgpt": null, "/api/claude-desktop": null,
    "/api/plan": { accounts: [{ id: "plan-fixture", label: "Plan fixture", kind: "codex", planUsage: true, needsSignIn: false, on: false }] },
    "/api/doctor": { notice: "Read-only fixture report", findings: [] },
    "/api/usage?range=7d": { range: "7d", totals: { calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, errors: 0, costUsd: 0, unpriced: 0 }, byProvider: {}, byHarness: {}, days: [] },
  };
  const sandbox: Record<string, unknown> = { URLSearchParams, URL, AbortController, console, location, document,
    history: {
      replaceState(_state: unknown, _title: string, hash: string) { location.hash = hash; history.push(hash); visits[visit] = hash; },
      pushState(_state: unknown, _title: string, hash: string) { location.hash = hash; history.push(hash); visits.splice(++visit, Infinity, hash); },
    },
    window: { addEventListener(name: string, handler: Handler) { (windowHandlers[name] ??= []).push(handler); },
      ...(options.bridge ? { webkit: { messageHandlers: { easyswitch: { postMessage(message: string) { bridgeMessages.push(message); } } } } } : {}),
    },
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: () => 0,
    FormData: class { form: Element; constructor(form: Element) { this.form = form; } get(name: string) { return this.form.values[name] ?? null; } [Symbol.iterator]() { return Object.entries(this.form.values)[Symbol.iterator](); } },
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
  for (const file of ["theme.js", "controls.js", "doctor.js", "pool-suggestions.js", "usage-display.js", "overview.js", "provider-import.js"]) run(web(file));
  const app = web("app.js"), startup = app.lastIndexOf('fetch("icons/manifest.json")');
  assert.ok(startup > 0, "Load all app handlers and panel setup, excluding startup polling and icon fetch");
  run(app.slice(0, startup));
  context.fixtureMessages = messages;
  run("globalThis.actualToast=toast;toast = message => fixtureMessages.push(message)");
  const dispatch = async (handlers: Record<string, Handler[]>, name: string, target?: Element) => {
    let stopped = false;
    for (const handler of handlers[name] ?? []) { await handler({ target, preventDefault() {}, stopImmediatePropagation() { stopped = true; } }); if (stopped) break; }
    // hashchange intentionally starts refresh without awaiting it.
    await new Promise(resolve => setImmediate(resolve));
  };
  const node = (selector: string) => { const found = document.querySelector(selector); assert.ok(found, `Rendered control must exist: ${selector}`); return found; };
  return { run, requests, writes, storage, root, body, page, document, history, location, fixtureState, fixtureAgents, bridgeMessages,
    node, html: () => page.innerHTML,
    refresh: () => run("refresh(true)"),
    click: (selector: string) => dispatch(documentHandlers, "click", node(selector)),
    submit: (selector: string, values: Record<string, string>) => { const form = node(selector); form.values = values; return dispatch(documentHandlers, "submit", form); },
    hash: async (hash: string) => { location.hash = hash; visits.splice(++visit, Infinity, hash); await dispatch(windowHandlers, "hashchange"); },
    visits: () => visits.slice(), visit: () => visit,
    traverse: async (offset: number) => { const next = visit + offset; if (next < 0 || next >= visits.length) return; visit = next; location.hash = visits[visit]!; await dispatch(windowHandlers, "hashchange"); },
    toastAction: async (target: string) => { run(`actualToast("Fixture issue", {action:{label:"Open",target:${JSON.stringify(target)}},details:{}})`); await body.children.at(-1)!.children[0]!.emit("click"); },
  };
}

test("shell uses the approved navigation hierarchy, stable brand and pre-paint theme", () => {
  const primary = index.match(/class="nav-primary"[\s\S]*?<\/div>/)![0];
  const secondary = index.match(/class="nav-secondary"[\s\S]*?<\/div>/)![0];
  const pages = (html: string) => [...html.matchAll(/data-page="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(pages(primary), ["overview", "agents", "providers"]);
  assert.deepEqual(pages(secondary), ["usage", "sessions", "doctor", "settings"]);
  assert.doesNotMatch(primary, /data-page="overview"[^>]*disabled/);
  assert.doesNotMatch(primary, /待接入/);
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
  assert.match(app.html(), /data-agent-launch="pi"/);
  assert.doesNotMatch(app.html(), /data-quick-task|data-task-/);
  const pages = [
    ["providers", "模型", /data-pool-suggestion=/],
    ["usage", "用量", /data-range="7d"/], ["sessions", "会话记录", /id="flow"/],
    ["doctor", "自检", /Read-only fixture report/], ["settings", "设置", /订阅账号/],
  ] as const;
  for (const [page, title, content] of pages) {
    const nav = app.node(`[data-page="${page}"]`);
    nav.focus(); await app.click(`[data-page="${page}"]`);
    assert.equal(app.run("page"), page); assert.equal(app.location.hash, `#${page}`);
    assert.equal(app.node("#page-title").textContent, title); assert.match(app.html(), content);
    if (page === "usage") { assert.equal(app.run("usage?.range"), "7d"); assert.equal(app.run("usageError"), ""); }
    assert.equal(nav.getAttribute("aria-current"), "page"); assert.equal(app.document.activeElement, nav);
    assert.equal(app.document.querySelectorAll("#nav button").filter(node => node.getAttribute("aria-current") === "page").length, 1);
  }
  for (const id of ["codex-fixture", "claude-fixture"]) for (const action of ["launch", "rest", "toggle", "del"]) app.node(`[data-acc-${action}="${id}"]`);
  for (const harness of ["codex", "claude"]) { app.node(`form[data-add-account="${harness}"]`); assert.equal(app.node(`[data-acc-auto="${harness}"]`).disabled, true); }
  assert.match(app.html(), /data-theme-choice="system"/);
  assert.equal(app.requests.every(request => request.method === "GET"), true, "Navigating never triggers a mutating operation");
  const count = app.requests.length; await app.click('[data-page="overview"]');
  assert.equal(app.run("page"), "overview"); assert.deepEqual(app.requests.slice(count).map(r => r.path), ["/api/overview"]);
});

test("legacy and invalid deep links resolve safely, including later hash navigation", async () => {
  for (const [hash, expected] of [["#accounts", "settings"], ["#tasks", "agents"], ["#overview", "overview"], ["#unknown", "agents"], ["", "overview"]]) {
    const app = shell({ hash }); await app.refresh(); assert.equal(app.run("page"), expected);
    if (expected === "settings") assert.match(app.html(), /data-add-account="codex"/);
    if (hash) assert.equal(app.location.hash, `#${expected}`);
  }
  const app = shell(); await app.refresh();
  await app.hash("#accounts"); assert.equal(app.run("page"), "settings"); assert.match(app.html(), /订阅账号/);
  await app.hash("#tasks"); assert.equal(app.run("page"), "agents"); assert.equal(app.location.hash, "#agents"); assert.doesNotMatch(app.html(), /data-task-form/);
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

test("all-resting accounts disable automatic launch with a marked expiry, not a quota promise", async () => {
  const app = shell({ hash: "#settings" });
  app.fixtureState.accountSettings.autoPick = true;
  Object.assign(app.fixtureState.accounts[0]!, { restUntil: "2099-10-21T20:00:00+08:00", resting: true });
  app.fixtureState.accounts.push({ ...app.fixtureState.accounts[0]!, id: "codex-later", ...{ restUntil: "2099-10-21T13:00:00Z" } });
  app.fixtureState.accounts.push({ ...app.fixtureState.accounts[0]!, id: "codex-disabled", enabled: false, ...{ restUntil: undefined } });
  await app.refresh();
  assert.equal(app.node('[data-acc-auto="codex"]').disabled, true);
  assert.equal(app.node('[data-acc-auto="claude"]').disabled, false, "another client's ready account is independent");
  assert.equal(app.node('[data-account-readiness="codex"]').getAttribute("data-acc-retry-at"), "2099-10-21T12:00:00.000Z");
  assert.match(app.html(), /标记时间不代表实际额度恢复/);
  assert.match(app.html(), /手动启动或清除休息标记/);
  assert.doesNotMatch(app.html(), /限额中|最早恢复的这个/);
  assert.equal(app.node('[data-acc-launch="codex-fixture"]').disabled, false);
  assert.equal(app.node('[data-acc-rest="codex-fixture"]').dataset.on, "0");
  await app.click('[data-acc-auto="codex"]');
  assert.equal(app.requests.filter(r => r.method !== "GET").length, 0, "even synthetic clicks cannot auto-launch a disabled control");
  await app.click('[data-acc-launch="codex-fixture"]');
  assert.deepEqual(app.requests.filter(r => r.method !== "GET")[0]?.body, { harness: "codex", accountId: "codex-fixture" });
  await app.click('[data-acc-rest="codex-fixture"]');
  assert.deepEqual(app.requests.filter(r => r.method !== "GET")[1]?.body, { rest: false });
});

test("account UI reevaluates exact expiry instead of trusting a stale resting boolean", async () => {
  const app = shell({ hash: "#settings" });
  app.run('Date.now = () => Date.parse("2026-10-21T12:00:00Z")');
  app.fixtureState.accountSettings.autoPick = true;
  Object.assign(app.fixtureState.accounts[0]!, { restUntil: "2026-10-21T12:00:00Z", resting: true });
  await app.refresh();
  assert.equal(app.node('[data-acc-auto="codex"]').disabled, false);
  assert.equal(app.node('[data-acc-rest="codex-fixture"]').dataset.on, "1");
  assert.match(app.html(), /未标记休息/);
  assert.doesNotMatch(app.html(), /data-acc-retry-at=/);
});

test("a stale automatic launch refusal shows recovery wording and refreshes without a success toast", async () => {
  const app = shell({ hash: "#settings" }); app.run(web("errors.js"));
  app.fixtureState.accountSettings.autoPick = true; await app.refresh();
  app.run(`const fixtureFetch = fetch; fetch = async (path, init) => {
    const response = await fixtureFetch(path, init);
    if (path !== "/api/accounts/launch") return response;
    state.accounts[0].restUntil = "2099-10-21T12:00:00Z";
    return { ok: false, status: 409, json: async () => ({ code: "account_resting", error: "untrusted detail", uiError: {code:"account_resting", action:{target:"evil"}} }) };
  }`);
  const reads = app.requests.filter(r => r.method === "GET").length;
  await app.click('[data-acc-auto="codex"]');
  assert.equal(app.node('[data-acc-auto="codex"]').disabled, true);
  assert.ok(app.requests.filter(r => r.method === "GET").length > reads);
  const messages = Array.from(app.run("fixtureMessages")) as string[];
  assert.equal(messages.length, 1); assert.match(messages[0]!, /已暂停自动启动.*到设置检查休息标记/);
  assert.doesNotMatch(messages[0]!, /自动选了|untrusted|evil/);
  await app.toastAction("settings"); assert.equal(app.run("page"), "settings");
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
  assert.equal(app.node('[data-page="overview"]').disabled, false);
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

test("menu-bar panel reads only overview and subscription metadata and keeps native actions separate", async () => {
  const app = shell({ panel: true, hash: "#settings", stored: "dark" }); await app.refresh();
  assert.equal(app.run("page"), "agents"); assert.ok(app.body.classes.has("panel"));
  assert.equal(app.document.querySelector("#nav"), null); assert.equal(app.document.querySelector("#refresh"), null);
  assert.doesNotMatch(app.html(), /data-launch|data-pick|原生配置未被改动/);
  assert.match(app.html(), /data-bridge="openConsole"/); assert.match(app.html(), /data-plan-switch="plan-fixture"/);
  assert.deepEqual(app.requests.map(r => r.path).sort(), ["/api/overview", "/api/plan"]);
  assert.ok(app.requests.every(r => r.method === "GET"));
  assert.doesNotMatch(app.html(), /data-bridge="backToNative"|data-bridge="quit"/);
  assert.doesNotMatch(app.html(), /data-theme-choice|data-add-account/);
  await app.hash("#accounts"); assert.equal(app.run("page"), "agents"); assert.equal(app.history.length, 0);
  assert.equal(app.root.getAttribute("data-theme"), "dark");
  assert.match(css, /body\.panel \.sidebar[^{}]*\{[^}]*display:\s*none/);
  assert.match(css, /body\.panel main\s*\{[^}]*margin:\s*0/);
});

test("menu-bar summary counts inference sessions and treats unknown sources separately", async () => {
  const app = shell({ panel: true }); await app.refresh();
  app.run(`overviewSnapshot.activity={activeRequests:7,sessions:[{id:'one'},{id:'two'}]}; overviewSnapshot.sources=[{status:'disabled'},{status:'unknown'},{status:'budget'},{status:'quota'},{status:'no_models'},{status:'unavailable'},{status:'ready'}]; render()`);
  assert.match(app.html(), /<strong>2<\/strong><span>正在请求的增强会话/);
  assert.match(app.html(), /<strong>4<\/strong><span>待处理来源/);
  assert.match(app.html(), /7 个在途请求 · 1 个来源尚未验证/);
  assert.match(app.html(), /空闲窗口和原生请求不计入/);
});

test("menu-bar polling keeps the subscription list at the user's scroll position", async () => {
  const app = shell({ panel: true }); await app.refresh();
  app.run(`document.querySelector('.panel-scroll').scrollTop=180`);
  await app.refresh();
  assert.equal(app.run(`document.querySelector('.panel-scroll').scrollTop`), 180);
});

test("menu-bar read failure hides stale counts and switches but preserves native recovery actions", async () => {
  const app = shell({ panel: true, bridge: true }); await app.refresh();
  app.run(`overviewSnapshot.activity={activeRequests:9,sessions:[{id:'one'}]}; call=async()=>{throw new Error('fixture-offline')}`);
  assert.equal(await app.refresh(), false);
  assert.match(app.html(), /状态暂未更新|上次读取于/);
  assert.match(app.html(), /<strong>—<\/strong>/);
  assert.doesNotMatch(app.html(), /9 个在途请求|data-plan-switch/);
  assert.match(app.html(), /订阅状态暂不可用/);
  await app.click('[data-bridge="backToNative"]');
  await app.click('[data-bridge="openConsole"]');
  await app.click('[data-bridge="quit"]');
  assert.deepEqual(app.bridgeMessages, ["backToNative", "openConsole", "quit"]);
  assert.equal(app.requests.length, 2, "Recovery bridge actions never call the unavailable gateway");
});

test("menu-bar initial failure and stalled reads settle without overlapping polling", async () => {
  const app = shell({ panel: true, bridge: true });
  app.run(`globalThis.reads=[];setTimeout=fn=>{globalThis.expirePanel=fn;return 1};call=(m,p,b,o)=>{reads.push({p,signal:o.signal});return new Promise(()=>{})}`);
  const first = app.refresh(), second = app.refresh();
  assert.equal(app.run("reads.length"), 2);
  app.run("expirePanel()");
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(app.run("reads.every(r=>r.signal.aborted)"), true);
  assert.match(app.html(), /状态暂未更新/);
  assert.doesNotMatch(app.html(), /<strong>0<\/strong>|data-plan-switch/);
  assert.match(app.html(), /data-bridge="backToNative"/);
});

test("menu-bar subscription failure does not discard a fresh overview or reuse stale switches", async () => {
  const app = shell({ panel: true }); await app.refresh();
  app.run(`call=async(m,p)=>{if(p==='/api/plan')throw new Error('fixture');return {...overviewSnapshot,activity:{activeRequests:3,sessions:[{id:'one'}]}}}`);
  assert.equal(await app.refresh(), false);
  assert.match(app.html(), /3 个在途请求/);
  assert.doesNotMatch(app.html(), /data-plan-switch/);
  assert.match(app.html(), /订阅状态暂不可用/);
});

test("menu-bar subscription save blocks duplicates and ignores a pre-save read arriving late", async () => {
  const app = shell({ panel: true }); await app.refresh();
  app.run(`globalThis.reads=[];globalThis.writes=[];globalThis.oldPlan=JSON.parse(JSON.stringify(planInfo));globalThis.oldOverview=overviewSnapshot;
    call=(m,p,b,o)=>{if(m==='GET')return new Promise(resolve=>reads.push({p,resolve,signal:o.signal}));writes.push({p,b});return new Promise(resolve=>globalThis.finishSave=resolve)}`);
  const oldRead = app.refresh();
  const save = app.click('[data-plan-switch="plan-fixture"]');
  await new Promise(resolve => setImmediate(resolve));
  await app.click('[data-plan-switch="plan-fixture"]');
  await app.refresh();
  assert.equal(app.run("writes.length"), 1);
  assert.equal(app.run("writes[0].b.on"), true);
  assert.equal(app.run("reads.length"), 2);
  assert.equal(app.run("reads.every(r=>r.signal.aborted)"), true);
  assert.match(app.html(), /保存中/);
  app.run(`call=async(m,p)=>p==='/api/plan'?{accounts:oldPlan.accounts.map(a=>({...a,on:true}))}:oldOverview;finishSave({ok:true})`);
  await save;
  app.run(`reads.forEach(r=>r.resolve(r.p==='/api/plan'?oldPlan:oldOverview))`);
  await oldRead;
  assert.equal(app.node('[data-plan-switch="plan-fixture"]').dataset.on, "1");
  assert.equal(app.node('[data-plan-switch="plan-fixture"]').disabled, false);
});

test("menu-bar failed switch restores recorded state and expired enabled accounts can still be turned off", async () => {
  const app = shell({ panel: true }); await app.refresh();
  app.run(`planInfo.accounts[0].needsSignIn=true; planInfo.accounts[0].on=true;render();globalThis.puts=[];
    call=async(m,p,b)=>{if(m==='PUT'){puts.push(b);throw new Error('fixture-save-failed')}return p==='/api/plan'?planInfo:overviewSnapshot}`);
  assert.equal(app.node('[data-plan-switch="plan-fixture"]').disabled, false);
  await app.click('[data-plan-switch="plan-fixture"]');
  assert.equal(app.run("puts[0].on"), false);
  assert.equal(app.node('[data-plan-switch="plan-fixture"]').dataset.on, "1");
  assert.equal(app.node('[data-plan-switch="plan-fixture"]').disabled, false);
  app.run("planInfo.accounts[0].on=false;render()");
  assert.equal(app.node('[data-plan-switch="plan-fixture"]').disabled, true);
});


test("polling refreshes data while restoring the same ordinary control focus", async () => {
  const app = shell({ hash: "#settings" }); await app.refresh();
  const old = app.node('[data-acc-launch="codex-fixture"]'); old.focus();
  app.fixtureState.accounts[0]!.label = "Updated fixture label";
  const reads = app.requests.length;
  await app.run("refresh()");
  assert.ok(app.requests.length > reads); assert.match(app.html(), /Updated fixture label/);
  const replacement = app.node('[data-acc-launch="codex-fixture"]');
  assert.notEqual(replacement, old); assert.equal(app.document.activeElement, replacement);
  await app.run("refresh()"); assert.equal(app.document.activeElement, app.node('[data-acc-launch="codex-fixture"]'));
});

test("removed, disabled or ambiguous focus targets never transfer to another action", async () => {
  for (const replacement of ['', '<button data-action="one" disabled>Disabled</button>', '<button data-action="one" aria-disabled="true">Disabled</button>', '<button data-action="one" hidden>Hidden</button>', '<button data-action="one">A</button><button data-action="one">B</button>']) {
    const app = shell({ hash: "#settings" });
    app.run(`globalThis.reviewHTML = '<button data-action="one">Original</button><button data-action="two">Other</button>'; renderSettings = () => reviewHTML`);
    await app.refresh(); app.node('[data-action="one"]').focus();
    app.run(`reviewHTML = ${JSON.stringify(replacement)}`); await app.run("refresh()");
    assert.equal(app.document.activeElement, null);
  }
});

test("stable disclosure and link identities keep focus but navigation does not transfer it", async () => {
  const app = shell({ hash: "#settings" });
  app.run(`renderSettings = () => '<details data-keep="fixture-section"><summary>More</summary><a href="/fixture-help">Help</a></details>'`);
  await app.refresh();
  for (const selector of ['summary', 'a']) { app.node(selector).focus(); await app.run("refresh()"); assert.equal(app.document.activeElement, app.node(selector)); }
  app.run('renderAgents = renderSettings'); await app.hash("#agents");
  assert.equal(app.document.activeElement, null, "A similar control on a different page must not receive old focus");
});

test("manual refresh reports core failure accurately and succeeds after recovery", async () => {
  const app = shell({ hash: "#settings" }); await app.refresh();
  app.run('globalThis.goodCall = call; call = async () => { throw new Error("fixture offline") }');
  await app.click("#refresh"); assert.match(app.html(), /连不上 EasySwitch/);
  assert.match(app.run('fixtureMessages.at(-1)'), /未刷新|失败/);
  assert.equal(await app.run("refresh()"), false);
  app.run('call = goodCall'); await app.click("#refresh");
  assert.match(app.run('fixtureMessages.at(-1)'), /核心状态已刷新/);
  assert.equal(await app.run("refresh()"), true);
});

test("doctor refresh failure cannot announce success and active checks are not refreshed", async () => {
  const app = shell({ hash: "#doctor" }); await app.refresh();
  app.run('call = async () => { throw new Error("fixture offline") }');
  await app.click("#refresh"); assert.doesNotMatch(app.run('fixtureMessages.at(-1)'), /已刷新/);
  assert.equal(await app.run("refresh()"), false);
  app.run('doctorBusy = true'); assert.equal(await app.run("refresh(true)"), false);
});


test("late manual refresh does not announce success or move focus after navigation", async () => {
  const app = shell({ hash: "#settings" }); await app.refresh();
  app.run('globalThis.originalCall = call; globalThis.finishRefresh = null; call = (method, path, ...args) => path === "/api/state" ? new Promise(resolve => { finishRefresh = resolve; }) : originalCall(method, path, ...args)');
  const pending = app.click("#refresh");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.run("typeof finishRefresh"), "function");
  await app.hash("#doctor");
  const button = app.node('[data-doctor-action="refresh-doctor"]'); button.focus();
  app.run('finishRefresh(state)'); await pending;
  assert.equal(app.run("page"), "doctor"); assert.equal(app.document.activeElement, button);
  assert.equal(app.run("fixtureMessages.length"), 0);
});


test("profile action focus is not restored onto a different selected profile", async () => {
  for (const action of ["data-profile-apply", "data-profile-del"]) {
    const app = shell({ hash: "#settings" });
    app.run('state = null; renderSettings = profileBar');
    app.run('globalThis.reviewProfiles = [{id:"profile-a",name:"A",agents:1},{id:"profile-b",name:"B",agents:1}]');
    await app.refresh(); app.run('state.profiles = reviewProfiles; render()');
    assert.equal(app.node('[data-profile-pick]').value, "profile-a");
    app.node('[data-profile-pick]').value = "profile-b";
    app.node(`[${action}]`).focus(); await app.run("refresh()");
    assert.equal(app.node('[data-profile-pick]').value, "profile-a");
    assert.equal(app.document.activeElement, null, "Enter must not activate the changed target A");
    assert.equal(app.requests.some(request => request.method !== "GET"), false);
  }
});

test("probe action focus includes the selected model rather than only provider identity", async () => {
  const app = shell({ hash: "#settings" });
  app.fixtureState.providers[0]!.models = ["model-a", "model-b"];
  app.run('openProvider = "fixture"; renderSettings = () => providerRow(state.providers[0])');
  await app.refresh(); assert.equal(app.node('.probe-model').value, "model-a");
  app.node('.probe-model').value = "model-b"; app.node('[data-probe]').focus();
  await app.run("refresh()"); assert.equal(app.node('.probe-model').value, "model-a");
  assert.equal(app.document.activeElement, null, "Enter must not probe the changed model A");
  assert.equal(app.requests.some(request => request.method !== "GET"), false);
});


test("retired dispatch assets, controls, callbacks and API polling are absent", async () => {
  for (const file of ["task-progress.js", "feedback.js", "parallel.js"]) {
    assert.equal(existsSync(new URL(`../../web/${file}`, import.meta.url)), false);
    assert.ok(!index.includes(`src="${file}"`));
  }
  for (const file of readdirSync(new URL("../../web/", import.meta.url)).filter(name => name.endsWith(".js"))) {
    assert.doesNotMatch(web(file), /\/api\/(?:tasks|task-groups|rules|suggestions)(?:[\/"`?]|$)|data-(?:task-|quick-task|rule-|parallel-)|agentCalls|allowMcp/, file);
  }
  const app = shell({ hash: "#tasks" });
  await app.refresh(); await app.run("refresh()");
  assert.equal(app.run("page"), "agents");
  assert.equal(app.location.hash, "#agents");
  for (const name of ["renderTasks", "submitConsoleTask", "taskForm", "ruleForm", "loadParallel", "taskProgressCard", "taskFeedbackControls"]) {
    assert.equal(app.run(`typeof ${name}`), "undefined", name);
  }
  assert.ok(app.requests.some(request => request.path === "/api/agents"));
  assert.ok(app.requests.every(request => request.method === "GET" && !/\/(?:tasks|task-groups|rules|suggestions)(?:\/|$)/.test(request.path)));
  assert.equal(app.run("typeof poolSuggestionsCard"), "function");
  assert.equal(app.run("typeof gatewaySessionsCard"), "function");
});

test("navigation retains browser visits, ignores same-page clicks and restores Back/Forward without adding entries", async () => {
  const app = shell({ hash: "#agents" }); await app.refresh();
  await app.click('[data-page="providers"]'); await app.click('[data-page="settings"]');
  assert.deepEqual(app.visits(), ["#agents", "#providers", "#settings"]);
  const reads = app.requests.length;
  await app.click('[data-page="settings"]');
  assert.deepEqual(app.visits(), ["#agents", "#providers", "#settings"]);
  assert.equal(app.requests.length, reads);
  await app.traverse(-1); assert.equal(app.run("page"), "providers"); assert.match(app.html(), /Fixture source/);
  await app.traverse(-1); assert.equal(app.run("page"), "agents"); assert.match(app.html(), /data-agent-launch="pi"/);
  await app.traverse(1); assert.equal(app.run("page"), "providers");
  await app.traverse(1); assert.equal(app.run("page"), "settings"); assert.match(app.html(), /订阅账号/);
  assert.deepEqual(app.visits(), ["#agents", "#providers", "#settings"]);
  assert.deepEqual(app.history, ["#providers", "#settings"], "traversal must not push or replace supported visits");
  await app.traverse(-1); await app.click('[data-page="sessions"]');
  assert.deepEqual(app.visits(), ["#agents", "#providers", "#sessions"], "a new visit discards the old forward branch");
});

test("error-toast navigation uses the same guarded history and removed routes normalize in place", async () => {
  const app = shell({ hash: "#agents" }); await app.refresh();
  await app.toastAction("settings"); await app.toastAction("settings"); await app.toastAction("current");
  assert.deepEqual(app.visits(), ["#agents", "#settings"]);
  await app.toastAction("tasks"); assert.equal(app.run("page"), "agents");
  assert.deepEqual(app.visits(), ["#agents", "#settings", "#agents"]);
  await app.hash("#tasks"); assert.equal(app.run("page"), "agents"); assert.equal(app.location.hash, "#agents");
  assert.deepEqual(app.visits(), ["#agents", "#settings", "#agents", "#agents"], "normalization replaces the stale bookmark, not another visit");
  await app.traverse(-1); await app.traverse(-1); assert.equal(app.run("page"), "settings");
  await app.traverse(1); assert.equal(app.run("page"), "agents");
  assert.ok(app.requests.every(request => request.method === "GET"));
});

test("narrow provider rows reserve identity width before wrapping badges and actions", async () => {
  const app = shell({ hash: "#providers" }); await app.refresh();
  assert.match(app.html(), /class="row clickable [^"]*" data-toggle="fixture"/);
  const mobile = css.slice(css.indexOf("@media (max-width: 600px)"), css.indexOf("@media (prefers-reduced-motion: reduce) { *"));
  assert.match(mobile, /\.row\[data-toggle\] > \.grow\s*\{[^}]*flex:\s*1 1 calc\(100% - 48px\)/);
  assert.match(mobile, /\.row\[data-toggle\] \.title\s*\{[^}]*overflow-wrap:\s*anywhere/);
  assert.match(mobile, /\.row\[data-toggle\] \.sub\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/);
  assert.match(mobile, /\.detail\[data-provider\] \.hint\s*\{[^}]*overflow-wrap:\s*anywhere/);
});


test("Back/Forward closes desktop launch confirmation so the destination can keep refreshing", async () => {
  const app = shell({ hash: "#agents" }); await app.refresh();
  await app.click('[data-page="settings"]'); await app.traverse(-1);
  app.run("claudeDesktopConfirm=true"); assert.equal(app.run("Boolean(busy())"), true);
  await app.traverse(1);
  assert.equal(app.run("page"), "settings"); assert.equal(app.run("claudeDesktopConfirm"), false);
  assert.equal(app.run("Boolean(busy())"), false);
});

test("overview default uses only its read-only snapshot and keeps onboarding reachable", async () => {
  const app = shell({hash:""}); await app.refresh();
  assert.equal(app.run("page"),"overview"); assert.deepEqual(app.requests.map(r=>r.path),["/api/overview"]);
  assert.match(app.html(),/开始首次设置/); assert.match(app.node("#guard-chip").innerHTML,/只读总览/);
  await app.click('[data-go="agents"]'); assert.equal(app.run("page"),"agents");
});
test("overview keeps old snapshot visibly stale after failure and discards a cancelled late response", async () => {
  const app=shell({hash:"#overview"});await app.refresh();
  app.run('globalThis.originalCall=call;call=async()=>{throw new Error("offline")};');await app.refresh();
  assert.match(app.html(),/上次读取的快照/);assert.match(app.html(),/暂时无法更新/);
  app.run('call=originalCall;globalThis.delayedOverview=null;globalThis.overviewSignal=null;call=(method,path,body,options)=>path==="/api/overview"?new Promise(resolve=>{delayedOverview=resolve;overviewSignal=options.signal;}):originalCall(method,path,body,options);');
  const pending=app.run("refresh()");await app.hash("#settings");
  assert.equal(app.run("overviewSignal.aborted"),true);
  app.run('delayedOverview({version:"late"})');await pending;
  assert.equal(app.run("page"),"settings");assert.notEqual(app.run("overviewSnapshot.version"),"late");
});


test("client cards retain ID selection across refresh and filtering never launches or loses bindings", async () => {
  const app = shell();
  app.fixtureAgents.push({...app.fixtureAgents[0], id:"aider", name:"Aider"}, {...app.fixtureAgents[0], id:"gemini-cli", name:"Gemini CLI", installed:false});
  await app.refresh();
  await app.click('[data-agent-select="aider"]');
  assert.equal(app.run("selectedAgent"), "aider");
  app.fixtureAgents.reverse(); await app.refresh();
  assert.equal(app.run("selectedAgent"), "aider");
  assert.match(app.html(), /aria-label="Aider 设置"/);
  app.run('chatgptConfirm="enhance";claudeDesktopConfirm=true;state.bindings.aider={providerId:"missing",model:"saved-model"}');
  await app.click('[data-agent-segment="available"]');
  assert.equal(app.run("selectedAgent"), "gemini-cli");
  assert.equal(app.run("chatgptConfirm"), null);
  assert.equal(app.run("claudeDesktopConfirm"), false);
  assert.equal(app.run("state.bindings.aider.model"), "saved-model");
  assert.equal(app.requests.filter(r=>r.method!=="GET").length,0);
  app.fixtureAgents.forEach(a=>a.installed=false); await app.refresh();
  await app.click('[data-agent-segment="installed"]');
  assert.equal(app.run("agentSegment"), "installed");
  assert.match(app.html(), /还没有检测到客户端/);
});

test("client detail keeps unavailable effort and model values until explicit selection", async () => {
  const app = shell(); await app.refresh();
  app.run('state.bindings.pi={providerId:"missing",model:"saved-model"};state.prefs.pi={effort:"ultra",tiers:{small:"missing/tiny"}};state.modelEfforts={"missing/saved-model":["high","low"]};agentList[0].can.tiers=[{id:"small",label:"小模型",hint:"test"}];render()');
  assert.match(app.html(), /来源已不存在/);
  assert.match(app.html(), /已保存 ultra，当前模型与客户端不支持/);
  assert.match(app.html(), /data-pick="pi@small"/);
  assert.match(app.html(), /data-effort-choice="pi" data-value="high"/);
  assert.doesNotMatch(app.html(), /data-effort-choice="pi" data-value="low"/);
  assert.equal(app.run('state.prefs.pi.effort'), "ultra");
  app.run('globalThis.effortWrites=[];call=async(method,path,body)=>{effortWrites.push({method,path,body});return {}};refresh=async()=>{}');
  await app.click('[data-value="high"]');
  assert.equal(app.run('JSON.stringify(effortWrites)'), '[{"method":"PUT","path":"/api/bindings/pi/effort","body":{"effort":"high"}}]');
});

test("client command copy is inert and profiles open only from the toolbar", async () => {
  const app = shell(); await app.refresh();
  assert.doesNotMatch(app.html(), /data-profile-new/);
  app.run('globalThis.copied=[];globalThis.navigator={clipboard:{writeText:async text=>copied.push(text)}}');
  await app.click('[data-copy="es pi"]');
  assert.equal(app.run('JSON.stringify(copied)'), '["es pi"]');
  assert.equal(app.requests.filter(r=>r.method!=="GET").length,0);
  await app.click('[data-profiles-toggle]');
  assert.match(app.html(), /data-profile-new/);
  assert.match(app.html(), /不会结束已有增强会话/);
});


test("source filters use stored account links and keep same-label unlinked accounts", async () => {
  const app = shell({hash:"#providers"}); await app.refresh();
  app.run(`state.providers.push({id:"subscription-p",name:"Linked source",models:["m"],billing:"subscription",off:true,plan:{kind:"codex",accountId:"account-a"}});
    planInfo={accounts:[{id:"account-a",kind:"codex",label:"Same label",on:false,planUsage:true},{id:"account-b",kind:"codex",label:"Same label",on:false,planUsage:true}]};
    state.pools=[{id:"pool-one",name:"One pool",strategy:"order",members:["fixture/fixture-model"],live:["fixture/fixture-model"]}];render();`);
  assert.equal(app.document.querySelectorAll('[data-plan-switch="account-a"]').length,1);
  assert.equal(app.document.querySelectorAll('[data-plan-switch="account-b"]').length,1);
  await app.click('[data-source-segment="subscriptions"]');
  assert.match(app.html(), /Linked source/); assert.doesNotMatch(app.html(), /data-toggle="fixture"|data-pool-edit/);
  await app.click('[data-source-segment="pools"]');
  assert.match(app.html(), /data-pool-edit="pool-one"/); assert.doesNotMatch(app.html(), /data-plan-switch/);
  assert.equal(app.requests.filter(r=>r.method!=="GET").length,0);
});

test("opening source workflows never imports, signs in or probes and import starts with no choices", async () => {
  const app = shell({hash:"#providers"}); await app.refresh();
  assert.equal(app.document.querySelectorAll("[data-plan-signin]").length,0);
  await app.click('[data-source-add-open]');
  await app.click('[data-source-add-mode="subscription"]');
  assert.match(app.html(), /data-plan-signin/);
  await app.click('[data-source-add-mode="import"]');
  assert.match(app.html(), /data-provider-import-scan/);
  assert.equal(app.run("providerImportSources.size"),0);
  assert.equal(app.run("providerImportChosen.size"),0);
  assert.equal(app.node('[data-provider-import-source="opencodex"]').attrs.checked,undefined);
  await app.click('[data-source-add-close]');
  assert.equal(app.run("providerImportOpen"),false);
  assert.equal(app.requests.filter(r=>r.method!=="GET").length,0);
});

test("source summaries distinguish missing accounting, unpriced calls and metadata health", async () => {
  const app = shell({hash:"#providers"}); await app.refresh();
  assert.match(app.html(), /本月费用未知/);
  app.run('providerOverview={snapshotAt:new Date().toISOString(),month:{timezone:"UTC"},sources:[{id:"fixture",monthly:{calls:3,estimatedCostUsd:1.25,unknownCostCalls:2}}]};state.providers[0].sourceHealth={status:"healthy"};render()');
  assert.match(app.html(), /本月已记录约 \$1.25/); assert.match(app.html(), /2 次成本未知/);
  assert.match(app.html(), /模型列表检查通过/); assert.match(app.html(), /额度未知/);
  app.run('providerOverview.month.accountingUnavailable=true;render()');
  assert.match(app.html(), /本月费用未知/);
});

test("subscription start is single-flight and closing an active sign-in explicitly cancels it", async () => {
  const app = shell({hash:"#providers"}); await app.refresh();
  app.run('globalThis.signInWrites=[];call=async(method,path,body)=>{signInWrites.push({method,path,body});return new Promise(resolve=>globalThis.finishSignIn=resolve)};refresh=async()=>{}');
  const first = app.run('startSubscription("/api/cursor/signin")');
  await app.run('startSubscription("/api/cursor/signin")');
  assert.equal(app.run('signInWrites.length'),1);
  app.run('finishSignIn({});planInfo.signIn={status:"waiting"}'); await first;
  app.run('call=async(method,path,body)=>{signInWrites.push({method,path,body});return {}};render()');
  assert.match(app.html(), /取消登录并关闭/);
  await app.click('[data-source-add-close]');
  assert.equal(app.run('JSON.stringify(signInWrites[1])'),'{"method":"POST","path":"/api/plan/signin","body":{"cancelOnly":true}}');
  assert.equal(app.run('sourceAddOpen'),false);
});

test("API source submission cannot duplicate a pending create and keeps saved source when probe fails", async () => {
  const app = shell({hash:"#providers"}); await app.refresh();
  app.run('sourceAddOpen=true;sourceAddMode="api";addForm={preset:null};presets=[];globalThis.sourceWrites=[];call=async(method,path,body)=>{sourceWrites.push({method,path});return new Promise(resolve=>globalThis.finishSource=resolve)};refresh=async()=>{};render()');
  const first=app.submit('#add-form',{name:"Fixture",baseUrl:"http://127.0.0.1:1/v1",apiKey:"fixture-only-key"});
  await app.submit('#add-form',{name:"Fixture"});
  assert.equal(app.run('sourceWrites.length'),1);
  app.run('call=async(method,path)=>{sourceWrites.push({method,path});throw new Error("probe failed")};finishSource({id:"new",name:"Fixture",models:["one"]})'); await first;
  assert.equal(app.run('sourceWrites.length'),2);
  assert.equal(app.run('addForm'),null);
  assert.equal(app.run('sourceAddBusy'),false);
});

test("B130 compact visual contract keeps explicit theme parity and accessible contrast", () => {
  assert.match(css, /--bg:\s*#f4f4f6/);
  assert.equal((css.match(/--bg:\s*#1a1a1e/g) ?? []).length, 2, "auto and explicit dark use the same surface");
  assert.match(css, /font:\s*13px\/1\.4 var\(--font\)/);
  assert.match(css, /--sidebar-width:\s*212px/);
  assert.match(css, /--control-height:\s*28px/);
  assert.match(css, /--row-height:\s*48px/);
  assert.match(css, /\.shell-nav button\.on::before\s*\{\s*content:\s*none/);
  assert.match(css, /@media\s*\(pointer:\s*coarse\)\s*\{[^]*--control-height:\s*40px/);
  assert.match(css, /body:not\(\.panel\) \.ctl \.popbtn/);
  assert.match(css, /100vw - var\(--sidebar-width\) - 1200px/);
  const luminance = (hex: string) => {
    const c = hex.match(/[0-9a-f]{2}/gi)!.map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return c[0]! * .2126 + c[1]! * .7152 + c[2]! * .0722;
  };
  const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
  const themeValues = (selector: RegExp) => {
    const block = css.match(selector)?.[1]; assert.ok(block, "theme block exists");
    const values = Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*#([0-9a-f]{6})\b/gi)].map(m => [m[1]!, m[2]!]));
    for (const key of ["muted", "bg", "card", "pill"]) assert.ok(values[key], `theme has ${key}`);
    return values;
  };
  for (const values of [themeValues(/:root\s*\{([^]*?)\n\}/), themeValues(/:root\[data-theme="dark"\]\s*\{([^]*?)\n\}/)]) {
    for (const key of ["bg", "card", "pill"]) assert.ok(contrast(values.muted!, values[key]!) >= 4.5, `CSS secondary text on ${key}`);
  }
  assert.match(css, /Magpie internal\/gui\/assets\/app\.css, MIT, Copyright \(c\) 2026 yetone/);
  assert.match(web("favicon.svg"), /svg/); // Brand asset is retained, not replaced by upstream's bird.
});

test("B130 usage metrics keep inner spacing and long accounting evidence readable", () => {
  // Usage is a section inside main: main's grid gap does not space its children.
  assert.match(css, /#usage-content\s*\{[^}]*display:\s*grid;[^}]*gap:\s*14px/);
  assert.match(css, /#usage-content details:has\(> \.tbl\)\s*\{\s*overflow-x:\s*auto/);
  assert.match(css, /#usage-content \.tiles\s*\{[^}]*repeat\(5, minmax\(0, 1fr\)\)[^}]*gap:\s*1px/);
  assert.match(css, /#usage-content \.tile\s*\{[^}]*min-width:\s*0[^}]*padding:\s*12px 14px 11px[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /#usage-content \.tile \.v\s*\{[^}]*font-size:\s*20px[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /#usage-content \.tile\s*\{[^}]*border-left:\s*0/);
  assert.match(css, /#usage-content \.tiles > \.tile:last-child:nth-child\(odd\)\s*\{\s*grid-column:\s*1 \/ -1/);
  const app = shell({ hash: "#usage" });
  app.run(`state={display:{currency:'USD'}};usage={totals:{calls:2,inputTokens:100,outputTokens:20,cachedTokens:0,errors:0,recordedCostCalls:1,missingCostCalls:1,costUsd:0.2,pricingSources:{user:1}},byProvider:{},byHarness:{},days:[]};render()`);
  assert.match(app.page.innerHTML, /另有 1 次费用缺失/);
  assert.match(app.page.innerHTML, /用户自填价 1 次/);
  assert.match(app.page.innerHTML, /非供应商账单/);
});

test("picker Escape restores only a live enabled trigger, ordinary dismissal does not steal focus", () => {
  const app = shell();
  app.run(`globalThis.focusReturns=0;globalThis.removals=0;globalThis.anchor={isConnected:true,disabled:false,focus(){focusReturns++}};
    pickerReturnFocus=anchor;popover={remove(){removals++}};closePopover(true)`);
  assert.equal(app.run("focusReturns"), 1);
  assert.equal(app.run("removals"), 1);
  app.run("closePopover(true)");
  assert.equal(app.run("focusReturns"), 1, "bubbled Escape does not refocus twice");
  app.run("pickerReturnFocus=anchor;closePopover()");
  assert.equal(app.run("focusReturns"), 1, "outside click or navigation keeps its new focus");
  app.run("anchor.isConnected=false;pickerReturnFocus=anchor;closePopover(true)");
  app.run("anchor.isConnected=true;anchor.disabled=true;pickerReturnFocus=anchor;closePopover(true)");
  assert.equal(app.run("focusReturns"), 1);
  assert.match(web("app.js"), /pickerReturnFocus = anchor/);
  assert.match(web("app.js"), /e.key === "Escape"\) closePopover\(true\)/);
});

test("pool membership eligibility remains readable beside long source names", () => {
  assert.match(css, /\.pool-row \.sub\s*\{\s*white-space:\s*normal;\s*overflow-wrap:\s*anywhere/);
  const app = shell();
  app.run(`state={providers:[{id:'p',name:'Very-long-synthetic-source-name',models:['m']}],pools:[{id:'pool',name:'Pool',members:['p/m'],strategy:'order',memberStates:[{member:'p/m',reason:'budget_blocked'}]}]}`);
  const rendered = app.run("poolsCard({tools:false,suggestions:false})");
  assert.match(rendered, /class="row pool-row"/);
  assert.match(rendered, /预算暂停，请检查预算和记账状态/);
});
