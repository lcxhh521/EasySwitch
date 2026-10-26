import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

// Exercises the real console's renderer/event handlers without a browser, a
// network connection, or an installed agent. Startup polling is omitted.
function ui() {
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const handlers: Record<string, Array<(event: unknown) => unknown>> = {};
  const context = vm.createContext({
    URLSearchParams,
    location: { search: "", hash: "#agents" },
    window: { addEventListener() {}, webkit: undefined },
    document: { addEventListener(name: string, fn: (event: unknown) => unknown) { (handlers[name] ??= []).push(fn); }, activeElement: null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {} },
    history: { replaceState() {} },
    console,
    setTimeout: () => 0,
    clearTimeout() {},
    fetch() { throw new Error("UI tests must not make network calls"); },
  });
  vm.runInContext(readFileSync(new URL("../../web/overview.js", import.meta.url), "utf8"), context);
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  vm.runInContext(`
    state = { providers: [{id:'mock', name:'Mock', models:['echo']}], pools: [], bindings: {} };
    claudeDesktopInfo = {installed:true, launchBlocked:false, sessions:[]};
    claudeDesktopModel = 'mock/echo';
    // This behavior fixture intentionally has no page/header DOM.
    render = () => {};
    renderPageTransition = () => {};
    refresh = async () => {};
    toast = () => {};
    globalThis.requests = [];
    call = async (method, path, body) => { requests.push({method,path,body}); return {}; };
  `, context);
  return {
    run: (source: string) => vm.runInContext(source, context),
    async click(selector: string, dataset: Record<string, string> = {}) {
      const target = { dataset, matches: (query: string) => query === selector, closest: (query: string) => query === selector ? target : null };
      let stopped=false; for(const handler of handlers.click ?? []) {await handler({target,preventDefault(){},stopImmediatePropagation(){stopped=true;}});if(stopped)break;}
    },
    async change(selector: string, value: string) {
      const target = { value, matches: (query: string) => query === selector, closest: (query: string) => query === selector ? target : null };
      let stopped=false; for(const handler of handlers.change ?? []) {await handler({target,preventDefault(){},stopImmediatePropagation(){stopped=true;}});if(stopped)break;}
    },
    async escape() { await handlers.keydown![0]!({ key: "Escape" }); },
    async toggle(open: boolean) { for (const handler of handlers.toggle ?? []) await handler({ target: { dataset: { keep: "experimental-agents" }, open } }); },
  };
}

test("desktop UI labels mock-only coverage, escapes server text, and disables unavailable actions", () => {
  const app = ui();
  let html = app.run("claudeDesktopCard()") as string;
  assert.match(html, /实验性 · 仅模拟测试/);
  assert.match(html, /尚未实测/);
  assert.match(html, /打开独立窗口/);
  app.run("claudeDesktopInfo = {installed:false, launchBlocked:false, sessions:[]}");
  html = app.run("claudeDesktopCard()") as string;
  assert.match(html, /data-claude-desktop-ask disabled/);
  assert.match(html, /未检测到应用/);
  app.run("claudeDesktopInfo = {installed:true,launchBlocked:false,sessions:[{id:'x',state:'cleanup-blocked',cleaned:false,error:'<script>bad</script>'}]}");
  html = app.run("claudeDesktopCard()") as string;
  assert.match(html, /退出或清理待处理/);
  assert.match(html, /这次操作没有完成/); assert.doesNotMatch(html, /script&gt;bad|<script>bad/);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /停止并清理/);
});

test("known isolation blocker disables real launch and cannot be bypassed by a stale consent control", async () => {
  const app = ui();
  app.run("claudeDesktopInfo = {installed:true,launchBlocked:true,sessions:[],note:'签名版忽略独立目录覆盖'}; claudeDesktopConfirm = true");
  const html = app.run("claudeDesktopCard()") as string;
  assert.match(html, /真实启动已暂停/);
  assert.match(html, /data-claude-desktop-ask disabled/);
  assert.match(html, /签名版忽略独立目录覆盖/);
  await app.click("[data-claude-desktop-start]");
  await app.click("[data-claude-desktop-ask]");
  assert.equal(app.run("requests.length"), 0);
});

test("cancel, Escape, model change and navigation all dismiss launch consent without starting", async () => {
  const app = ui();
  await app.click("[data-claude-desktop-ask]");
  assert.equal(app.run("claudeDesktopConfirm"), true);
  await app.click("[data-claude-desktop-cancel]");
  assert.equal(app.run("claudeDesktopConfirm"), false);
  await app.click("[data-claude-desktop-start]");
  assert.equal(app.run("requests.length"), 0);
  await app.click("[data-claude-desktop-ask]"); await app.escape();
  assert.equal(app.run("claudeDesktopConfirm"), false);
  await app.click("[data-claude-desktop-ask]"); await app.change("[data-claude-desktop-model]", "mock/next");
  assert.equal(app.run("claudeDesktopConfirm"), false);
  await app.click("[data-claude-desktop-ask]"); await app.click("#nav button, [data-go]", { page: "providers" });
  assert.equal(app.run("claudeDesktopConfirm"), false);
  assert.equal(app.run("requests.length"), 0);
});

test("desktop start requires current consent, suppresses duplicate clicks and shows a retryable failure", async () => {
  const app = ui();
  app.run("call = async (method,path,body) => { requests.push({method,path,body}); return new Promise((resolve,reject) => { globalThis.rejectStart = reject; }); }");
  await app.click("[data-claude-desktop-ask]");
  const first = app.click("[data-claude-desktop-start]");
  assert.equal(app.run("claudeDesktopBusy"), true);
  await app.click("[data-claude-desktop-start]");
  assert.equal(app.run("requests.length"), 1);
  assert.equal(app.run("requests[0].body.experimental"), true);
  assert.equal(app.run("requests[0].body.model"), "mock/echo");
  app.run("rejectStart(new Error('mock launch failed'))"); await first;
  assert.equal(app.run("claudeDesktopBusy"), false);
  assert.equal(app.run("claudeDesktopConfirm"), false);
  assert.match(app.run("claudeDesktopCard()"), /这次操作没有完成/); assert.doesNotMatch(app.run("claudeDesktopCard()"), /mock launch failed/);
  await app.click("[data-claude-desktop-start]");
  assert.equal(app.run("requests.length"), 1, "failed start needs a fresh explicit click through the notice");
});

test("stop targets only the selected desktop session, never the generic native process endpoint", async () => {
  const app = ui();
  await app.click("[data-claude-desktop-stop]", { claudeDesktopStop: "owned-session" });
  assert.equal(app.run("requests[0].path"), "/api/claude-desktop/sessions/owned-session/stop");
  assert.equal(app.run("requests[0].method"), "POST");
  assert.equal(app.run("claudeDesktopBusy"), false);
});

test("desktop stays in collapsed experiments while pending cleanup remains visible in the summary", async () => {
  const app = ui();
  app.run("claudeDesktopInfo={installed:true,launchBlocked:true,sessions:[{id:'s',state:'failed',cleaned:false}]}");
  let html = app.run("experimentalAgentsCard()") as string;
  assert.doesNotMatch(html.match(/<details[^>]*>/)?.[0] ?? "", /\bopen\b/);
  assert.match(html, /实验功能/); assert.match(html, /1 个会话待停止或清理/);
  assert.match(html, /data-claude-desktop-stop="s"/); assert.match(html, /data-claude-desktop-ask disabled/);
  await app.toggle(true); html = app.run("experimentalAgentsCard()");
  assert.match(html, /data-keep="experimental-agents" open/);
  app.run("claudeDesktopConfirm=true"); await app.toggle(false);
  assert.equal(app.run("claudeDesktopConfirm"), false);
  assert.equal(app.run("requests.length"), 0);
});

test("experimental desktop tolerates unloaded state without implying launch is available", () => {
  const app = ui(); app.run("state=null;claudeDesktopInfo=null");
  const html = app.run("experimentalAgentsCard()") as string;
  assert.match(html, /独立窗口暂未开放/); assert.match(html, /状态读取中/);
  assert.match(html, /data-claude-desktop-ask disabled/);
});
