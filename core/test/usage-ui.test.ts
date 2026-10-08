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
function ui(rows: GatewayLogEntry[]) {
  const handlers: Record<string, Array<(event: any) => unknown>> = {}, chartHandlers: Record<string, (event: any) => unknown> = {};
  let tip: any;
  const chart = { innerHTML: "", clientWidth: 600, append(node: any) { tip = node; }, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    querySelector: () => ({ addEventListener(name: string, handler: (event: any) => unknown) { chartHandlers[name] = handler; } }) };
  const context = vm.createContext({ URLSearchParams, console, location: { search: "", hash: "#usage" }, window: { addEventListener() {} }, history: { replaceState() {} },
    document: { activeElement: null, addEventListener(name: string, fn: any) { (handlers[name] ??= []).push(fn); },
      querySelector: (selector: string) => selector === "#chart" ? chart : null, querySelectorAll: () => [], createElement: () => ({ style: {}, hidden: true }) },
    localStorage: { getItem: () => null, setItem() {} }, setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame() {},
    fetch() { throw new Error("No network in usage VM fixtures"); }, fixtureUsage: summarize(rows, "today", NOW),
  });
  vm.runInContext(readFileSync(new URL("../../web/usage-display.js", import.meta.url), "utf8"), context);
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  const run = (code: string): any => vm.runInContext(code, context);
  run(`state={providers:[{id:'fixture',name:'Fixture',icon:'letter:F'}],display:{currency:'USD',usdToCny:8}}; usage=fixtureUsage; usageRange='today';
    globalThis.requests=[];globalThis.html='';render=()=>{html=renderUsage();};
    call=(method,path)=>new Promise((resolve,reject)=>requests.push({method,path,resolve,reject}));render();`);
  const clickRange = async (range: string) => {
    const target: any = { dataset: { range }, closest: (selector: string) => selector === "[data-range]" ? target : null };
    for (const handler of handlers.click ?? []) await handler({ target, preventDefault() {} });
  };
  return { run, html: (): string => run("html"), chart, clickRange,
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

test("latest range wins when older successful or failed requests arrive after a newer response", async () => {
  for (const staleFails of [false, true]) {
    const app = ui([row({ costUsd: 1 })]);
    const first = app.clickRange("7d"), second = app.clickRange("30d");
    assert.equal(app.run("requests.length"), 2);
    assert.equal(app.run("requests[0].path"), "/api/usage?range=7d"); assert.equal(app.run("requests[1].path"), "/api/usage?range=30d");
    app.run("render()"); assert.match(app.html(), /data-range="today" class="on"/, "while pending the active range still describes displayed data");
    app.run("requests[1].resolve({...fixtureUsage,range:'30d'})"); await second;
    app.run(staleFails ? "requests[0].reject(new Error('stale fixture failure'))" : "requests[0].resolve({...fixtureUsage,range:'7d'})"); await first;
    assert.equal(app.run("usage.range"), "30d"); assert.match(app.html(), /data-range="30d" class="on"/);
  }
});

test("older response cannot fill a newer pending range or restore data after that range fails", async () => {
  for (const olderFirst of [true, false]) {
    const app = ui([row({ costUsd: 1 })]);
    const first = app.clickRange("7d"), second = app.clickRange("30d");
    if (olderFirst) {
      app.run("requests[0].resolve({...fixtureUsage,range:'7d'})"); await first;
      assert.equal(app.run("usage.range"), "today");
    }
    app.run("requests[1].reject(new Error('current fixture failure'))"); await second;
    if (!olderFirst) { app.run("requests[0].resolve({...fixtureUsage,range:'7d'})"); await first; }
    assert.equal(app.run("usage"), null);
    // Error-state presentation is a separate slice; stale requests may not
    // revive a successful result from a different range after the failure.
    assert.match(app.html(), /正在读取用量/);
  }
});

test("request sequence also rejects stale refreshes of the same range", async () => {
  const app = ui([row({ costUsd: 1 })]);
  const first = app.clickRange("today"), second = app.clickRange("today");
  app.run("requests[1].resolve({...fixtureUsage,totals:{...fixtureUsage.totals,costUsd:2}})"); await second;
  app.run("requests[0].resolve(fixtureUsage)"); await first;
  assert.equal(app.run("usage.totals.costUsd"), 2);
  assert.match(app.html(), /data-range="today" class="on"/);
});

test("no calls do not claim a zero bill or a complete history", () => {
  const app = ui([]);
  assert.match(app.html(), /无调用/); assert.match(app.html(), /还没有调用记录/);
  assert.match(app.html(), /50,000 行；无法解析的行会跳过，不代表完整历史/);
  assert.doesNotMatch(app.html(), /\$0\.00|全部已计量/);
  app.run("chartMetric='cost';drawChart()"); assert.match(app.chart.innerHTML, /无调用/);
});
