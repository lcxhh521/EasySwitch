import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { summarize } from "../src/ledger.ts";
import type { GatewayLogEntry } from "../src/types.ts";

const NOW = new Date(2026, 9, 8, 12);
const row = (overrides: Partial<GatewayLogEntry> = {}): GatewayLogEntry => ({
  at: NOW.toISOString(), model: "fixture/m", providerId: "fixture", harness: "codex", route: "chat-translate", status: 200,
  ms: 1, inputTokens: 0, outputTokens: 0, usageComplete: true, ...overrides,
});
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function ui(rows: GatewayLogEntry[]) {
  const handlers: Record<string, Array<(event: any) => unknown>> = {}, windowHandlers: Record<string, Array<() => unknown>> = {}, chartHandlers: Record<string, (event: any) => unknown> = {};
  const timers = new Map<number, { callback: () => void; delay: number }>(); let timerId = 0;
  let tip: any, usageMounted = false, pageWrites = 0, usageWrites = 0, html = "", usageHtml = "";
  let usageButtons: any[] = [], usageSummaries: any[] = [];
  let usageKeyRegion: any = null;
  const replaceUsage = (value: string) => {
    if (document.activeElement === usageKeyRegion || usageButtons.includes(document.activeElement) || usageSummaries.includes(document.activeElement)) document.activeElement = null;
    usageHtml = value;
    usageKeyRegion = value.includes('data-usage-key-scroll') ? {dataset:{usageKeyScroll:''},scrollLeft:0,matches:()=>false,focus(){document.activeElement=usageKeyRegion}} : null;
    usageButtons = [...value.matchAll(/<button([^>]*)>/g)].map(match => {
      const attr = /data-([a-z-]+)(?:="([^"]*)")?/.exec(match[1]!);
      const key = attr?.[1]?.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      const node = { dataset: key ? { [key]: attr?.[2] ?? "" } : {}, disabled: /(?:^|\s)disabled(?:\s|=|$)/.test(match[1]!),
        matches: () => false, focus() { if (!node.disabled) document.activeElement = node; } };
      return node;
    });
    usageSummaries = [...value.matchAll(/<details[^>]*data-keep="([^"]+)"/g)].map(match => {
      const summary: any = { tagName: 'SUMMARY', matches: () => false, parentElement: { dataset: { keep: match[1] }, querySelector: () => summary }, focus() { document.activeElement = summary; } };
      return summary;
    });
  };
  const usageNode = { get innerHTML() { return usageHtml; }, set innerHTML(value: string) { replaceUsage(value); usageWrites++; },
    contains: (node: unknown) => usageButtons.includes(node) || usageSummaries.includes(node) || !!usageKeyRegion && node === usageKeyRegion,
    querySelector: (selector: string) => selector === "[data-usage-key-scroll]" ? usageKeyRegion : null,
    querySelectorAll: (selector: string) => selector.startsWith("details") ? usageSummaries.map(summary => summary.parentElement) : usageButtons };
  const main = { querySelector: (selector: string) => usageMounted && selector === "[data-usage-key-scroll]" ? usageKeyRegion : null, get innerHTML() { return html; }, set innerHTML(value: string) {
    html = value; pageWrites++; usageMounted = value.includes('id="usage-content"');
    if (usageMounted) replaceUsage(value.split('<section id="usage-content">')[1]!.split('</section>')[0]!);
  } };
  const chart = { innerHTML: "", clientWidth: 600, append(node: any) { tip = node; }, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    querySelector: () => ({ addEventListener(name: string, handler: (event: any) => unknown) { chartHandlers[name] = handler; } }) };
  const location = { search: "", hash: "#usage" };
  const downloads: any[] = [], blobs: Blob[] = [], revoked: string[] = [];
  let removed = 0;
  const document = { body: { append() {} }, activeElement: null as any, addEventListener(name: string, fn: any) { (handlers[name] ??= []).push(fn); },
    querySelector: (selector: string) => selector === "#page" ? main : selector === "#usage-content" ? usageMounted ? usageNode : null : selector === "#chart" ? chart : null,
    querySelectorAll: () => [], createElement: (tag: string) => tag === "a" ? { href: "", download: "", hidden: false,
      click() { downloads.push({ href: this.href, download: this.download }); }, remove() { removed++; } } : ({ style: {}, hidden: true }) };
  const context = vm.createContext({ URLSearchParams, AbortController, console, location, Blob,
    URL: { createObjectURL(blob: Blob) { blobs.push(blob); return `blob:fixture-${blobs.length}`; }, revokeObjectURL(url: string) { revoked.push(url); } },
    window: { addEventListener(name: string, fn: any) { (windowHandlers[name] ??= []).push(fn); } },
    history: { replaceState(_state: unknown, _title: string, hash: string) { location.hash = hash; } }, document,
    localStorage: { getItem: () => null, setItem() {} },
    setTimeout(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout(id: number) { timers.delete(id); }, requestAnimationFrame() {},
    fetch() { throw new Error("No network in usage VM fixtures"); }, fixtureUsage: summarize(rows, "today", NOW),
  });
  vm.runInContext(readFileSync(new URL("../../web/errors.js", import.meta.url), "utf8"), context);
  vm.runInContext(readFileSync(new URL("../../web/usage-display.js", import.meta.url), "utf8"), context);
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(readFileSync(new URL("../../web/overview.js", import.meta.url), "utf8"), context);
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (code: string): any => vm.runInContext(code, context);
  run(`globalThis.fixtureState={providers:[{id:'fixture',name:'Fixture',icon:'letter:F'}],display:{currency:'USD',usdToCny:8}};
    state=fixtureState; usage=fixtureUsage; usageRange='today'; agentList=[];
    globalThis.requests=[];globalThis.otherRequests=[];globalThis.messages=[];
    renderHeader=()=>{};renderSettings=()=>'<form>Settings draft</form>';
    renderAgents=()=>'<form>Agent settings draft</form>';budgetSettingsCard=()=>'<form>Budget draft</form>';toast=message=>messages.push(message);
    call=(method,path,body,options)=>{
      if(path.startsWith('/api/usage?'))return new Promise((resolve,reject)=>requests.push({method,path,resolve,reject,signal:options?.signal}));
      otherRequests.push({method,path});
      if(path==='/api/state')return Promise.resolve(fixtureState);
      if(path==='/api/chatgpt'||path==='/api/claude-desktop')return Promise.resolve(null);
      throw new Error('Unexpected fixture route: '+path);
    };render();`);
  const click = async (selector: string, dataset: Record<string, string> = {}) => {
    const target: any = { dataset, closest: (s: string) => s === selector ? target : null };
    for (const handler of handlers.click ?? []) await handler({ target, preventDefault() {} });
  };
  return { run, document, downloads, blobs, revoked, removed: () => removed,
    exportCsv: () => click("[data-usage-export]"),
    cleanDownloads: () => { for (const [id, timer] of timers) if (timer.delay === 1000) { timers.delete(id); timer.callback(); } },
    html: (): string => usageMounted ? usageHtml : html, chart, messages: (): string[] => run("messages"),
    clickRange: (range: string) => click("[data-range]", { range }), retry: () => click("[data-usage-retry]"),
    metric: (metric: string) => click("[data-metric]", { metric }),
    nav: (page: string) => click("#nav button, [data-go]", { page }), manualRefresh: () => click("#refresh"),
    hash: async (page: string) => { location.hash = `#${page}`; for (const handler of windowHandlers.hashchange ?? []) await handler(); await turn(); },
    writes: () => ({ page: pageWrites, usage: usageWrites }),
    expire: async () => { const entry = [...timers.entries()].find(([, timer]) => timer.delay === 10_000); assert.ok(entry); timers.delete(entry[0]); entry[1].callback(); await turn(); },
    timerCount: () => timers.size,
    keyRegion: () => usageKeyRegion,
    focusSummary: (key = "usage-days") => { const summary = usageSummaries.find(summary => summary.parentElement.dataset.keep === key); assert.ok(summary); summary.focus(); },
    focusUsage: (key: string, value: string) => { const button = usageButtons.find(button => Object.hasOwn(button.dataset, key) && button.dataset[key] === value); assert.ok(button); button.focus(); },
    hover: (index = 0) => { chartHandlers.mousemove?.({ target: { closest: () => ({ dataset: { i: String(index) } }) }, clientX: 50, clientY: 60 }); return tip?.innerHTML as string; },
  };
}

test("all existing usage views keep exact recorded zero, including chart overlay and tooltip", () => {
  const app = ui([row({ costUsd: 0 })]);
  assert.equal((app.html().match(/\$0\.00/g) ?? []).length, 4, "tile, provider, harness and daily table show zero");
  assert.doesNotMatch(app.html(), /全部已计量|按各家公开|套餐内|data-range="all"[^>]*>全部</);
  assert.match(app.html(), /data-range="all"[^>]*>已有记录</);
  app.run("chartMetric='cost';drawChart()");
  assert.match(app.chart.innerHTML, /已记录估算 \$0\.00/); assert.doesNotMatch(app.chart.innerHTML, /没有可估价/);
  assert.match(app.chart.innerHTML, /pointer-events:none/, "zero overlay must not intercept chart hover targets");
  assert.match(app.hover(), /已记录估算 \$0\.00/); assert.match(app.hover(), /历史出处未记录/);
});

test("known, missing, partial and subscription evidence stays consistent across tables, card and tooltip", () => {
  const app = ui([row({ costUsd: 0.2, usageComplete: false }), row({ inputTokens: undefined }), row({ costNote: "subscription" })]);
  assert.equal((app.html().match(/另有 1 次费用缺失/g) ?? []).length, 4);
  assert.equal((app.html().match(/已记录金额中 1 次费用或用量信息不完整/g) ?? []).length, 4);
  assert.equal((app.html().match(/1 次订阅调用，不计单次费用/g) ?? []).length, 4);
  assert.equal((app.html().match(/\$0\.200/g) ?? []).length, 4);
  app.run("chartMetric='cost';drawChart()");
  assert.match(app.hover(), /已记录估算 \$0\.200 · 另有 1 次费用缺失 · 已记录金额中 1 次费用或用量信息不完整 · 1 次订阅调用，不计单次费用/);
  const unknown = ui([row({ inputTokens: undefined })]);
  assert.equal((unknown.html().match(/费用未知/g) ?? []).length, 4);
  assert.doesNotMatch(unknown.html(), /\$0\.00/);
  unknown.run("chartMetric='cost';drawChart()"); assert.match(unknown.chart.innerHTML, /费用未知/); assert.match(unknown.hover(), /费用未知/);
});

test("current provider edits, billing changes and removal never reclassify historical money or provenance", () => {
  const app = ui([row({ costUsd: 1.25 })]);
  const before = app.run("costCell(usage.totals)");
  app.run("state.providers[0].billing='subscription';state.providers[0].prices={m:{input:999}};render()");
  assert.equal(app.run("costCell(usage.totals, state.providers[0])"), before);
  assert.equal((app.html().match(/\$1\.25/g) ?? []).length, 4); assert.doesNotMatch(app.html(), /包月|套餐内|用户自填价/);
  app.run("state.providers=[];render()");
  assert.equal((app.html().match(/\$1\.25/g) ?? []).length, 4); assert.match(app.html(), /fixture/);
});

test("configured CNY conversion and tiny positive amounts are explicit without changing stored summary", () => {
  const app = ui([row({ costUsd: 0.00000001 })]);
  const before = app.run("JSON.stringify(usage)");
  assert.equal((app.html().match(/小于 \$0\.001/g) ?? []).length, 4);
  app.run("state.display.currency='CNY';render();chartMetric='cost';drawChart()");
  assert.equal((app.html().match(/小于 ¥0\.001/g) ?? []).length, 4);
  assert.match(app.html(), /按设置汇率 1 USD = 8 CNY 换算，非实时汇率/); assert.match(app.hover(), /小于 ¥0\.001/);
  assert.equal(app.run("JSON.stringify(usage)"), before);
});

test("latest selected range wins immediately and cancels older successful or failed reads", async () => {
  for (const staleFails of [false, true]) {
    const app = ui([row({ costUsd: 1 })]);
    const first = app.clickRange("7d"), second = app.clickRange("30d");
    assert.equal(app.run("requests.length"), 2);
    assert.equal(app.run("requests[0].path"), "/api/usage?range=7d"); assert.equal(app.run("requests[1].path"), "/api/usage?range=30d");
    assert.equal(app.run("requests[0].signal.aborted"), true);
    assert.equal(app.run("requests.filter(r=>!r.signal.aborted).length"), 1);
    assert.match(app.html(), /data-range="30d" class="on"/); assert.match(app.html(), /正在读取用量/);
    assert.doesNotMatch(app.html(), /\$1\.00/, "a new range must not label an old range's money");
    app.run("requests[1].resolve({...fixtureUsage,range:'30d'})"); await second;
    app.run(staleFails ? "requests[0].reject(new Error('stale fixture failure'))" : "requests[0].resolve({...fixtureUsage,range:'7d'})"); await first; await turn();
    assert.equal(app.run("usage.range"), "30d"); assert.match(app.html(), /data-range="30d" class="on"/);
    assert.doesNotMatch(app.html(), /读取用量失败|正在读取用量/); assert.equal(app.timerCount(), 0);
  }
});

test("older response cannot fill a newer pending range or erase its explicit retry state", async () => {
  for (const olderFirst of [true, false]) {
    const app = ui([row({ costUsd: 1 })]);
    const first = app.clickRange("7d"), second = app.clickRange("30d");
    if (olderFirst) { app.run("requests[0].resolve({...fixtureUsage,range:'7d'})"); await first; assert.equal(app.run("usage"), null); }
    app.run("requests[1].reject(new Error('current fixture failure'))"); await second;
    if (!olderFirst) { app.run("requests[0].resolve({...fixtureUsage,range:'7d'})"); await first; }
    assert.equal(app.run("usage"), null); assert.match(app.html(), /读取用量失败/); assert.match(app.html(), /data-usage-retry[^>]*>重试/);
    assert.match(app.html(), /data-range="30d" class="on"/); assert.doesNotMatch(app.html(), /正在读取用量|current fixture failure/);
  }
});

test("same-range repeated clicks and retry events share one bounded read", async () => {
  const app = ui([row({ costUsd: 1 })]);
  const first = app.clickRange("today"), second = app.clickRange("today"), third = app.retry();
  assert.equal(app.run("requests.length"), 1); assert.equal(app.timerCount(), 1);
  assert.match(app.html(), /data-usage-retry aria-disabled="true"/); assert.match(app.html(), /正在刷新用量/);
  app.run("requests[0].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:2}})"); await Promise.all([first, second, third]);
  assert.equal(app.run("usage.totals.costUsd"), 2); assert.match(app.html(), /\$2\.00/); assert.equal(app.timerCount(), 0);
});

test("first load visibly transitions from loading to a safe failure and retry success", async () => {
  const app = ui([]); app.run("usage=null;render()");
  const first = app.retry(); assert.match(app.html(), /正在读取用量/); assert.match(app.html(), /data-usage-retry aria-disabled="true"/);
  app.run("requests[0].reject(new Error('<img src=x>secret network detail'))"); await first;
  assert.match(app.html(), /读取用量失败/); assert.doesNotMatch(app.html(), /正在读取|secret|<img src=x>/);
  const retry = app.retry(); assert.equal(app.run("requests.length"), 2);
  app.run("requests[1].resolve(fixtureUsage)"); await retry;
  assert.match(app.html(), /无调用/); assert.doesNotMatch(app.html(), /读取用量失败|正在读取用量/);
});

test("direct initial usage entry renders loading and retry independently of slow general state", async () => {
  const app = ui([]);
  app.run("usage=null;state=null;document.querySelector('#page').innerHTML='';globalThis.originalCall=call;call=(m,p,b,o)=>p==='/api/state'?new Promise(resolve=>globalThis.finishState=()=>resolve(fixtureState)):originalCall(m,p,b,o)");
  const refresh = app.run("refresh(true)");
  assert.match(app.html(), /正在读取用量/); assert.match(app.html(), /data-range="today" class="on"/);
  app.run("requests[0].reject(new Error('fixture failure'))"); await turn();
  assert.match(app.html(), /读取用量失败/); assert.match(app.html(), /data-usage-retry[^>]*>重试/);
  app.run("finishState()"); await refresh; assert.match(app.html(), /读取用量失败/);
});

test("usage loaded before display settings consistently labels and selects its USD fallback", async () => {
  const app = ui([row({ costUsd: 1 })]); app.run("usage=null;state=null;render()");
  const read = app.retry(); app.run("requests[0].resolve(fixtureUsage)"); await read;
  assert.match(app.html(), /data-currency="USD" class="on"/); assert.doesNotMatch(app.html(), /data-currency="CNY" class="on"/);
  assert.match(app.html(), /\$1\.00/); assert.match(app.html(), /金额以 USD 记录/);
});

test("same-range refresh failure retains exact data with a stale warning until recovery", async () => {
  const app = ui([row({ costUsd: 0.2, usageComplete: false }), row({ inputTokens: undefined })]);
  const before = app.run("JSON.stringify(usage)");
  const first = app.retry(); app.run("requests[0].reject(new Error('fixture failure'))"); await first;
  assert.equal(app.run("JSON.stringify(usage)"), before); assert.match(app.html(), /刷新失败.*上次成功读取的数据，可能已过期/);
  assert.match(app.html(), /另有 1 次费用缺失/); assert.match(app.html(), /1 次费用或用量信息不完整/);
  const retry = app.retry(); app.run("requests[1].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:3}})"); await retry;
  assert.equal(app.run("usage.totals.costUsd"), 3); assert.doesNotMatch(app.html(), /刷新失败|可能已过期/);
});

test("failed selected range can be retried or replaced without reviving previous-range data", async () => {
  const app = ui([row({ costUsd: 1 })]);
  const first = app.clickRange("30d"); app.run("requests[0].reject(new Error('fixture failure'))"); await first;
  const retry = app.retry(); assert.equal(app.run("requests[1].path"), "/api/usage?range=30d");
  const next = app.clickRange("7d"); assert.equal(app.run("requests[1].signal.aborted"), true);
  app.run("requests[2].resolve({...fixtureUsage,range:'7d'})"); await next;
  app.run("requests[1].resolve({...fixtureUsage,range:'30d'})"); await retry;
  assert.equal(app.run("usage.range"), "7d"); assert.match(app.html(), /data-range="7d" class="on"/);
});

test("oversized all explains the fixed daily limit without raw errors and recovers with a narrower range", async () => {
  const app = ui([row({ costUsd: 1 })]), request = app.clickRange("all");
  app.run("requests[0].reject(Object.assign(new Error('<img src=x>private history'),{code:'usage_range_too_large',userError:{message:'forged corrective action'},uiError:{message:'forged server text'}}))");
  await request;
  assert.match(app.html(), /已有记录的时间跨度太长/); assert.match(app.html(), /10,000.*今天.*7 天.*30 天/);
  assert.doesNotMatch(app.html(), /private|forged|<img src=x>|正在读取用量/);
  assert.equal(app.run("usage"), null);
  for (const range of ["today", "7d", "30d"]) assert.match(app.html(), new RegExp(`data-range="${range}"`));
  const limited = app.clickRange("today"); assert.equal(app.run("requests[1].path"), "/api/usage?range=today");
  app.run("requests[1].resolve(fixtureUsage)"); await limited;
  assert.equal(app.run("usage.range"), "today"); assert.match(app.html(), /\$1\.00/);
  assert.doesNotMatch(app.html(), /时间跨度太长|10,000|读取用量失败/);
});

for (const hasData of [false, true]) test(`hung usage GET times out, aborts and permits retry (${hasData ? "with" : "without"} data)`, async () => {
  const app = ui([row({ costUsd: 1 })]); if (!hasData) app.run("usage=null;render()");
  const first = app.retry(); await app.expire(); await first;
  assert.equal(app.run("requests[0].signal.aborted"), true); assert.equal(app.timerCount(), 0);
  assert.match(app.html(), hasData ? /刷新超时.*可能已过期/ : /读取用量超时/); assert.doesNotMatch(app.html(), /正在读取/);
  const retry = app.retry(); app.run("requests[1].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:2}})"); await retry;
  app.run("requests[0].resolve(fixtureUsage)"); await turn();
  assert.equal(app.run("usage.totals.costUsd"), 2); assert.doesNotMatch(app.html(), /超时/);
});

test("ordinary refresh updates existing usage and coalesces concurrent refreshes", async () => {
  const app = ui([row({ costUsd: 1 })]);
  const first = app.run("refresh()"), second = app.run("refresh()"), third = app.manualRefresh(); await turn();
  assert.equal(app.run("requests.length"), 1);
  app.run("requests[0].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:4}})"); await Promise.all([first, second, third]);
  assert.equal(app.run("usage.totals.costUsd"), 4); assert.match(app.html(), /\$4\.00/);
  const again = app.run("refresh()"); assert.equal(app.run("requests.length"), 2);
  app.run("requests[1].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:5}})"); await again;
  assert.match(app.html(), /\$5\.00/);
});

test("repeated initial polls cannot starve a slow read and a timed-out poll can recover", async () => {
  const app = ui([]); app.run("usage=null;render()");
  const polls = [app.run("refresh()"), app.run("refresh()"), app.run("refresh()")]; await turn();
  assert.equal(app.run("requests.length"), 1); assert.equal(app.timerCount(), 1);
  await app.expire(); await Promise.all(polls); assert.match(app.html(), /读取用量超时/);
  const next = app.run("refresh()"); app.run("requests[1].resolve(fixtureUsage)"); await next;
  app.run("requests[0].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,calls:999}})"); await turn();
  assert.equal(app.run("usage.totals.calls"), 0); assert.match(app.html(), /无调用/);
});

test("usage refresh proceeds while the unrelated state request is slow", async () => {
  const app = ui([row({ costUsd: 1 })]);
  app.run("globalThis.originalCall=call;call=(m,p,b,o)=>p==='/api/state'?new Promise(resolve=>globalThis.finishState=()=>resolve(fixtureState)):originalCall(m,p,b,o)");
  const refresh = app.run("refresh()");
  app.run("requests[0].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:2}})"); await turn();
  assert.match(app.html(), /\$2\.00/); app.run("finishState()"); await refresh;
});

test("range changes during a general refresh cannot be overwritten by its completion", async () => {
  const app = ui([row({ costUsd: 1 })]);
  const refresh = app.run("refresh()"), next = app.clickRange("30d");
  app.run("requests[1].resolve({...fixtureUsage,range:'30d',totals:{...fixtureUsage.totals,costUsd:6}})"); await next;
  app.run("requests[0].resolve(fixtureUsage)"); await refresh;
  assert.equal(app.run("usage.range"), "30d"); assert.match(app.html(), /\$6\.00/);
});

for (const method of ["nav", "hash"] as const) test(`${method} navigation cancels usage reads, never fetches off-page and returning loads once`, async () => {
  const app = ui([row({ costUsd: 1 })]);
  const first = app.retry(); await app[method]("settings");
  assert.equal(app.run("requests[0].signal.aborted"), true); const before = app.writes();
  app.run("requests[0].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:9}})"); await first; await turn();
  assert.deepEqual(app.writes(), before); assert.equal(app.run("usage.totals.costUsd"), 1); assert.equal(app.run("page"), "settings");
  await app.run("loadUsage()"); await app.run("refresh()"); assert.equal(app.run("requests.length"), 1);
  const back = app[method]("usage"); await turn(); assert.equal(app.run("requests.length"), 2);
  app.run("requests[1].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:2}})"); await back; await turn();
  assert.equal(app.run("usage.totals.costUsd"), 2); assert.match(app.html(), /\$2\.00/);
});

test("returning to the same usage range before an old reply arrives preserves the new visit", async () => {
  const app = ui([row({ costUsd: 1 })]); const old = app.retry();
  await app.nav("settings"); const back = app.nav("usage"); await turn();
  assert.equal(app.run("requests.length"), 2);
  app.run("requests[1].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:2}})"); await back;
  const before = app.writes(); app.run("requests[0].reject(new Error('old visit failure'))"); await old; await turn();
  assert.deepEqual(app.writes(), before); assert.equal(app.run("usage.totals.costUsd"), 2); assert.doesNotMatch(app.html(), /刷新失败/);
});

test("navigation during initial preset loading prevents old usage refresh from fetching the new page", async () => {
  const app = ui([]);
  app.run("fixtureState.providers=[];globalThis.originalCall=call;globalThis.delayState=true;call=(m,p,b,o)=>p==='/api/presets'?new Promise(resolve=>globalThis.finishPresets=()=>resolve([])):originalCall(m,p,b,o)");
  const refresh = app.run("refresh(true)"); await turn();
  // Subsequent navigation already has its own state/preset result.
  app.run("presets=[{}]"); await app.nav("settings");
  const before = app.run("otherRequests.length"), writes = app.writes();
  app.run("finishPresets();requests[0].resolve(fixtureUsage)"); await refresh;
  assert.equal(app.run("otherRequests.length"), before); assert.deepEqual(app.writes(), writes); assert.equal(app.run("page"), "settings");
});

test("late general refresh never replaces a newer settings page or its focused draft", async () => {
  const app = ui([row({ costUsd: 1 })]);
  app.run("globalThis.originalCall=call;globalThis.delayState=true;call=(m,p,b,o)=>p==='/api/state'&&delayState?(delayState=false,new Promise(resolve=>globalThis.finishState=()=>resolve(fixtureState))):originalCall(m,p,b,o)");
  const refresh = app.run("refresh(true)"); await app.nav("settings");
  const input = { value: "Fresh settings draft", matches: () => true }; app.document.activeElement = input;
  const before = app.writes(); app.run("finishState();requests[0].resolve(fixtureUsage)"); await refresh;
  assert.deepEqual(app.writes(), before); assert.equal(app.document.activeElement, input); assert.equal(input.value, "Fresh settings draft");
  assert.equal(app.run("page"), "settings");
});

test("background and manual usage refresh preserve focused budget input and its DOM", async () => {
  const app = ui([row({ costUsd: 1 })]);
  const input = { value: "37.50", matches: () => true }; app.document.activeElement = input;
  const before = app.writes(); const background = app.run("refresh()"), manual = app.manualRefresh(); await turn();
  app.run("requests[0].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:8}})"); await Promise.all([background, manual]);
  assert.equal(app.writes().page, before.page); assert.ok(app.writes().usage > before.usage);
  assert.equal(app.document.activeElement, input); assert.equal(input.value, "37.50"); assert.match(app.html(), /\$8\.00/);
});

test("background reads keep keyboard focus on range, currency, metric and retry controls", async () => {
  for (const [key, value] of [["range", "today"], ["metric", "cost"], ["currency", "USD"], ["usageRetry", ""]]) {
    const app = ui([row({ costUsd: 1 })]); app.focusUsage(key!, value!);
    const before = app.writes(); const refresh = app.run("refresh()"); await turn();
    assert.equal(app.document.activeElement?.dataset[key!], value);
    app.run("requests[0].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:2}})"); await refresh;
    assert.equal(app.writes().page, before.page); assert.equal(app.document.activeElement?.dataset[key!], value);
  }
});

test("background reads preserve the daily table summary focus and expanded state", async () => {
  const app = ui([row({ costUsd: 1 })]); app.run("openDetails.add('usage-days');render()"); app.focusSummary();
  const before = app.writes(); const refresh = app.run("refresh()"); await turn();
  assert.equal(app.document.activeElement?.tagName, "SUMMARY");
  app.run("requests[0].resolve(fixtureUsage)"); await refresh;
  assert.equal(app.writes().page, before.page); assert.equal(app.document.activeElement?.parentElement.dataset.keep, "usage-days");
  assert.match(app.html(), /data-keep="usage-days" open/);
});

test("chart metric selection changes only usage content and retains keyboard focus", async () => {
  const app = ui([row({ costUsd: 1 })]); app.focusUsage("metric", "cost"); const before = app.writes();
  await app.metric("cost");
  assert.equal(app.writes().page, before.page); assert.equal(app.document.activeElement?.dataset.metric, "cost");
  assert.match(app.html(), /data-metric="cost" class="on"/); assert.equal(app.run("requests.length"), 0);
});

test("failed manual refresh does not announce a successful refresh", async () => {
  const app = ui([row({ costUsd: 1 })]); const refresh = app.manualRefresh();
  app.run("requests[0].reject(new Error('fixture failure'))"); await refresh;
  assert.match(app.html(), /刷新失败/); assert.equal(app.messages().length, 0);
});

test("malformed or wrong-range responses become retryable failures and keep same-range evidence", async () => {
  for (const response of ["{}", "{...fixtureUsage,range:'30d'}"]) {
    const app = ui([row({ costUsd: 1 })]); const refresh = app.retry(); app.run(`requests[0].resolve(${response})`); await refresh;
    assert.equal(app.run("usage.totals.costUsd"), 1); assert.match(app.html(), /刷新失败.*可能已过期/);
  }
});

test("no calls do not claim a zero bill or a complete history", () => {
  const app = ui([]);
  assert.match(app.html(), /无调用/); assert.match(app.html(), /还没有调用记录/);
  assert.match(app.html(), /50,000 行；无法解析的行会跳过，不代表完整历史/);
  assert.doesNotMatch(app.html(), /\$0\.00|全部已计量/);
  app.run("chartMetric='cost';drawChart()"); assert.match(app.chart.innerHTML, /无调用/);
});

test('per-key usage is collapsed by default, read-only and distinguishes duplicate names using complete identities', () => {
 const app=ui([row({keyId:'k-1234abcd',costUsd:1}),row({providerId:'second',keyId:'k-1234abcd',costUsd:2})]);
 app.run("state.providers=[{id:'fixture',name:'Same',keys:[{id:'k-1234abcd',label:'Main',apiKey:'sk-do-not-render'}]},{id:'second',name:'Same',keys:[{id:'k-1234abcd',label:'Main'}]}];render()");
 const html=app.run('usageKeyDetails()');assert.match(html,/data-keep="usage-keys" >/);assert.match(html,/Main/);assert.match(html,/Same · fixture/);assert.match(html,/Same · second/);
 assert.match(html,/\$1\.00/);assert.match(html,/\$2\.00/);assert.match(html,/其中 2 次有 Key 归属，0 次未记录/);assert.doesNotMatch(html,/sk-do-not-render/);
 assert.equal(app.run('otherRequests.length+requests.length'),0);
});
test('per-key history preserves unknown, partial, subscription and recorded zero semantics without allocating unkeyed calls', () => {
 const app=ui([row({keyId:'k-1234abcd',costUsd:0}),row({keyId:'k-1234abcd'}),row({keyId:'k-1234abcd',costUsd:2,usageComplete:false}),row({keyId:'k-abcdef12',costNote:'subscription'}),row({costUsd:5})]);
 const html=app.run('usageKeyDetails()');assert.match(html,/本范围共 5 次调用，其中 4 次有 Key 归属，1 次未记录/);assert.match(html,/另有 1 次费用缺失/);assert.match(html,/不完整/);assert.match(html,/1 次订阅调用/);assert.doesNotMatch(html,/\$5\.00/);
 const zero=ui([row({keyId:'k-1234abcd',costUsd:0})]);assert.match(zero.run('usageKeyDetails()'),/已记录估算 \$0\.00/);
 const unknown=ui([row({keyId:'k-1234abcd'})]);assert.match(unknown.run('usageKeyDetails()'),/费用未知/);assert.doesNotMatch(unknown.run('usageKeyDetails()'),/\$0\.00/);
});
test('per-key rendering never reveals unknown raw group strings or unrelated metadata, and survives deleted or ambiguous identities', () => {
 const app=ui([row({keyId:'sk-hidden-secret',costUsd:1})]);
 app.run("state.providers[0].keys=[{id:'k-unused',label:'Unrelated',apiKey:'private-value'}]");
 let html=app.run('usageKeyDetails()');assert.match(html,/历史 Key（名称不可用）/);assert.doesNotMatch(html,/sk-hidden-secret|private-value|Unrelated/);
 app.run("state.providers=[]");html=app.run('usageKeyDetails()');assert.match(html,/历史来源（名称不可用）/);assert.match(html,/\$1\.00/);assert.doesNotMatch(html,/sk-hidden-secret/);
 app.run("state.providers=[{id:'fixture',name:'Same',keys:[{id:'sk-hidden-secret',label:'Wrong 1'},{id:'sk-hidden-secret',label:'Wrong 2'}]}]");
 assert.doesNotMatch(app.run('usageKeyDetails()'),/Wrong 1|Wrong 2|sk-hidden-secret/);
});
test('per-key display escapes names, keeps CNY conversion historical, and never exposes unrecognized payload fields', () => {
 const app=ui([row({keyId:'k-1234abcd',costUsd:1.25})]);
 app.run("state.providers[0].keys=[{id:'k-1234abcd',label:'<img src=x>',secret:'secret-metadata'}];usage.byKey['fixture#k-1234abcd'].errors='sk-private-error';usage.byKey['fixture#k-1234abcd'].apiKey='private-api-key';state.display.currency='CNY'");
 const before=app.run('JSON.stringify(usage)');const html=app.run('usageKeyDetails()');assert.match(html,/&lt;img src=x&gt;/);assert.match(html,/¥10\.00/);assert.doesNotMatch(html,/<img|sk-private|secret-metadata|private-api-key/);assert.equal(app.run('JSON.stringify(usage)'),before);
});
test('per-key absent, empty and malformed data remain distinct from zero usage', () => {
 const app=ui([row({costUsd:1})]);assert.match(app.run('usageKeyDetails()'),/1 次未记录 Key 归属/);
 app.run('delete usage.byKey');assert.match(app.run('usageKeyDetails()'),/没有 Key 明细，不能据此判断各 Key 用量为零/);
 app.run("usage.byKey={broken:null}");assert.match(app.run('usageKeyDetails()'),/部分 Key 明细格式不可用/);assert.match(app.run('usageKeyDetails()'),/无法核对覆盖次数/);
 const empty=ui([]);assert.match(empty.run('usageKeyDetails()'),/本范围共 0 次调用/);assert.match(empty.run('usageKeyDetails()'),/尚无可按 Key 归属的调用记录/);assert.doesNotMatch(empty.run('usageKeyDetails()'),/\$0\.00/);
});
test('per-key expanded state and keyboard summary focus survive same-range refresh without configuration writes', async () => {
 const app=ui([row({keyId:'k-1234abcd',costUsd:1})]);app.run("openDetails.add('usage-keys');render()");app.focusSummary('usage-keys');
 const pending=app.retry();app.run("requests[0].resolve({...fixtureUsage})");await pending;
 assert.match(app.html(),/data-keep="usage-keys" open/);assert.equal(app.document.activeElement?.parentElement.dataset.keep,'usage-keys');assert.equal(app.run("requests.every(r=>r.method==='GET') && otherRequests.length===0"),true);
});
test('latest date range owns per-key detail; stale successful or failed response cannot replace it', async () => {
 for(const fail of [false,true]){
  const app=ui([row({keyId:'k-1234abcd',costUsd:1})]);const first=app.clickRange('7d'),second=app.clickRange('30d');
  app.run("requests[1].resolve({...fixtureUsage,range:'30d',byKey:{'fixture#k-1234abcd':{...fixtureUsage.totals,costUsd:9}}})");await second;
  app.run(fail?"requests[0].reject(new Error('private stale failure'))":"requests[0].resolve({...fixtureUsage,range:'7d'})");await first;
  assert.match(app.run('usageKeyDetails()'),/\$9\.00/);assert.doesNotMatch(app.run('usageKeyDetails()'),/\$1\.00|private stale/);assert.equal(app.run('usage.range'),'30d');
 }
});
test('deleted key and provider retain validated historical IDs and estimates, not borrowed labels', () => {
 const app=ui([row({keyId:'k-1234abcd',costUsd:1,pricingProvenance:{source:'user',schemaVersion:1,basis:'log-time-config',tariffVerification:'not-established',wholeBillCoverage:'not-established',estimator:'ratesFor-costOf-v1',currency:'USD',cacheCounterAtEstimator:'present',selectedRatesSha256:null}})]);app.run('state.providers=[]');
 const html=app.run('usageKeyDetails()');assert.match(html,/历史来源（名称不可用） · fixture/);assert.match(html,/k-1234abcd/);assert.match(html,/\$1\.00/);assert.match(html,/用户自填价 1 次/);
});
test('per-key horizontal region retains keyboard focus and scroll during loading, response and full redraw', async () => {
 const app=ui([row({keyId:'k-1234abcd',costUsd:1})]);app.run("openDetails.add('usage-keys');render()");
 app.keyRegion().scrollLeft=120;app.keyRegion().focus();
 const pending=app.retry();assert.equal(app.document.activeElement,app.keyRegion());assert.equal(app.keyRegion().scrollLeft,120);
 app.run('requests[0].resolve({...fixtureUsage})');await pending;assert.equal(app.document.activeElement,app.keyRegion());assert.equal(app.keyRegion().scrollLeft,120);
 app.run('render()');assert.equal(app.document.activeElement,app.keyRegion());assert.equal(app.keyRegion().scrollLeft,120);
});
test('per-key scroll restoration never takes focus back after navigation or a new date range', async () => {
 const app=ui([row({keyId:'k-1234abcd',costUsd:1})]);app.keyRegion().scrollLeft=120;app.keyRegion().focus();
 const pending=app.retry();await app.nav('settings');const settingsFocus={matches:()=>false};app.document.activeElement=settingsFocus;
 app.run('requests[0].resolve({...fixtureUsage})');await pending;assert.equal(app.document.activeElement,settingsFocus);assert.match(app.html(),/Settings draft/);
 const rangeApp=ui([row({keyId:'k-1234abcd',costUsd:1})]);rangeApp.keyRegion().scrollLeft=120;rangeApp.keyRegion().focus();
 const change=rangeApp.clickRange('30d');rangeApp.run("requests[0].resolve({...fixtureUsage,range:'30d'})");await change;
 assert.equal(rangeApp.keyRegion().scrollLeft,0);assert.notEqual(rangeApp.document.activeElement,rangeApp.keyRegion());
});


test("daily export downloads only the displayed summary, retains USD and releases its URL", async () => {
  const app = ui([row({costUsd: 0.00000001})]);
  app.run("state.display={currency:'CNY',usdToCny:8}");
  await app.exportCsv();
  assert.deepEqual(app.downloads, [{href:'blob:fixture-1',download:'easyswitch-daily-usage-today.csv'}]);
  const csv = await app.blobs[0]!.text();
  assert.match(csv, /1e-8/); assert.doesNotMatch(csv, /8e-8|fixture|codex/);
  assert.equal(app.removed(), 1); assert.equal(app.revoked.length,0);
  app.cleanDownloads(); assert.deepEqual(app.revoked,['blob:fixture-1']);
  assert.equal(app.run('requests.length+otherRequests.length'),0);
  assert.match(app.messages().at(-1)!, /已请求下载/); assert.doesNotMatch(app.messages().at(-1)!, /已保存/);
});

test("export stays guarded during refresh, failure, range mismatch, no data and navigation", async () => {
  for (const change of ["usageRequest={}", "usageError='failed'", "usageRange='7d'", "usage=null", "page='agents'"]) {
    const app=ui([row({costUsd:0})]); app.run(change); await app.exportCsv();
    assert.equal(app.downloads.length,0,change); assert.equal(app.blobs.length,0,change);
  }
  const app=ui([row({costUsd:0})]);
  const pending=app.retry(); await turn(); await app.exportCsv(); assert.equal(app.downloads.length,0);
  app.run("requests[0].reject(new Error('bad'))"); await pending;
  await app.exportCsv(); assert.equal(app.downloads.length,0);
  const retry=app.retry(); await turn(); app.run("requests[1].resolve(fixtureUsage)"); await retry;
  await app.exportCsv(); assert.equal(app.downloads.length,1);
});

test("export focus survives polling and cleanup runs even when browser click fails", async () => {
  const app=ui([row({costUsd:0})]); app.focusUsage('usageExport','');
  const pending=app.retry(); await turn();
  assert.equal(app.document.activeElement?.dataset.usageExport,'');
  app.run("requests[0].resolve(fixtureUsage)"); await pending;
  assert.equal(app.document.activeElement?.dataset.usageExport,'');
  app.run("document.createElement=()=>({click(){throw new Error('blocked')},remove(){}})");
  await app.exportCsv(); app.cleanDownloads();
  assert.deepEqual(app.revoked,['blob:fixture-1']); assert.match(app.messages().at(-1)!, /未能导出/);
});

test("malformed export fails safely without downloading or exposing payload", async () => {
  const app=ui([row({costUsd:0})]);
  app.run("usage.days[0].day='=WEBSERVICE(secret)'"); await app.exportCsv();
  assert.equal(app.blobs.length,0); assert.equal(app.downloads.length,0);
  assert.doesNotMatch(app.messages().join(' '),/WEBSERVICE|secret/);
});
