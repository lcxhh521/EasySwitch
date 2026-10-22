import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

/** Exercise the actual console without network, app startup, or a browser process. */
function ui() {
  const source = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
  const handlers: Record<string, Array<(event: any) => unknown>> = {};
  const context = vm.createContext({
    URLSearchParams, location: { search: "", hash: "#providers" },
    window: { addEventListener() {}, webkit: undefined },
    document: { addEventListener(name: string, fn: (event: any) => unknown) { (handlers[name] ??= []).push(fn); }, activeElement: null, querySelector: () => null, querySelectorAll: () => [] },
    localStorage: { getItem: () => null, setItem() {} }, history: { replaceState() {} }, console,
    setTimeout: () => 0, clearTimeout() {}, fetch() { throw new Error("No network in UI tests"); },
    FormData: class { form: any; constructor(form: any) { this.form = form; } get(name: string) { return this.form.values[name]; } getAll(name: string) { return this.form.values[name]; } },
  });
  vm.runInContext(source.slice(0, source.lastIndexOf('fetch("icons/manifest.json")')), context);
  vm.runInContext(`
    state = {providers:[], pools:[], bindings:{}};
    globalThis.requests = []; globalThis.messages = [];
    refresh = async () => {}; toast = message => messages.push(message);
    call = async (method,path,body) => { requests.push({method,path,body}); return {}; };
  `, context);
  const run = (source: string) => vm.runInContext(source, context);
  function form(protocols: string[], model = "") {
    const controls = [{ disabled: false }, { disabled: false }];
    const detail = { dataset: { provider: "source" }, querySelectorAll: () => controls, querySelector: (_selector: string): any => null };
    return { dataset: {} as Record<string, string>, values: { protocols, model }, controls, detail,
      matches: (selector: string) => selector === "[data-protocol-form]", querySelectorAll: () => controls,
      closest: () => detail };
  }
  const dispatch = async (name: string, target: any) => { for (const handler of handlers[name] ?? []) await handler({ target, preventDefault() {} }); };
  return { run, form, dispatch, submit: (target: ReturnType<typeof form>) => dispatch("submit", target) };
}

test("protocol choices prefer model override, then source order, then detected defaults", () => {
  const app = ui();
  const model = app.run(`protocolOptions({modelProtocols:{m:['messages']},protocols:['responses'],supportedProtocols:['chat']},'m')`) as string;
  assert.match(model, /value="messages" checked/); assert.doesNotMatch(model, /value="responses" checked/);
  const source = app.run(`protocolOptions({protocols:['responses','chat'],supportedProtocols:['messages']})`) as string;
  assert.ok(source.indexOf('value="responses"') < source.indexOf('value="chat"'));
  assert.match(source, /value="responses" checked/); assert.match(source, /value="chat" checked/);
  const fallback = app.run(`protocolOptions({supportedProtocols:['gemini']})`) as string;
  assert.match(fallback, /value="gemini" checked/);
});

test("empty protocol selection never submits or disables the form", async () => {
  const app = ui(); const form = app.form([]);
  await app.submit(form); assert.equal(app.run("requests.length"), 0);
  assert.equal(form.controls[0]!.disabled, false); assert.match(app.run("messages[0]"), /至少选择/);
});

test("protocol save submits the exact model and suppresses duplicate requests", async () => {
  const app = ui(); const form = app.form(["messages", "responses"], "m");
  app.run("call = async (method,path,body) => { requests.push({method,path,body}); return new Promise(resolve => { globalThis.finishSave = resolve; }); }");
  const pending = app.submit(form); assert.equal(form.controls[0]!.disabled, true);
  await app.submit(form); assert.equal(app.run("requests.length"), 1);
  assert.equal(app.run("requests[0].path"), "/api/providers/source/protocols");
  assert.equal(app.run("JSON.stringify(requests[0].body)"), '{"protocols":["messages","responses"],"model":"m"}');
  app.run("finishSave({})"); await pending;
  assert.equal(form.dataset.saving, undefined); assert.equal(form.controls[0]!.disabled, false);
});

test("a failed protocol save keeps the chosen values and permits retry", async () => {
  const app = ui(); const form = app.form(["gemini"]);
  app.run("call = async () => { throw new Error('fixture failure'); }");
  await app.submit(form); assert.equal(form.dataset.saving, undefined); assert.equal(form.controls[0]!.disabled, false);
  assert.deepEqual(form.values.protocols, ["gemini"]); assert.match(app.run("messages[0]"), /这次操作没有完成/); assert.doesNotMatch(app.run("messages[0]"), /fixture failure/);
  app.run("call = async (method,path,body) => { requests.push({method,path,body}); return {}; }");
  await app.submit(form); assert.equal(app.run("requests.length"), 1);
});

function provider(app: ReturnType<typeof ui>) {
  app.run(`state.providers=[{id:'source',name:'Fixture',icon:'letter:F',baseUrl:'https://fixture.invalid',models:['m'],usedBy:[],billing:'subscription',hasKey:true,supportedProtocols:['chat']}];openProvider='source';`);
}

function contextForm(app: ReturnType<typeof ui>, tokens: string, model = "m") {
  const form: any = app.form([], model);
  form.values = { model, tokens };
  form.matches = (selector: string) => selector === "[data-context-form]";
  form.querySelector = () => ({ set value(value: string) { form.values.tokens = value; } });
  return form;
}

test("context settings start folded and distinguish manual values, unknown and partial pools", () => {
  const app = ui(); provider(app);
  let html = app.run("providerRow(state.providers[0])") as string;
  assert.match(html, /上下文窗口 · 高级设置/);
  assert.doesNotMatch(html, /data-keep="context:source" open/);
  assert.match(html, /name="tokens"[^>]*value=""/);
  assert.match(html, /不代表模型实际支持/);
  app.run("state.providers[0].modelContextWindows = {m:32000}");
  html = app.run("providerRow(state.providers[0])");
  assert.match(html, /name="tokens"[^>]*value="32000"/);
  assert.match(app.run("poolContextDetails({id:'p',context:{tokens:512000,source:'partial-pool'}})"), /部分成员窗口未知.*较小值/);
  assert.match(app.run("poolContextDetails({id:'p',context:null})"), /窗口未知/);
  assert.equal(app.run("requests.length"), 0);
});

test("context save sends the selected model once and clearing explicitly sends null", async () => {
  const app = ui(), form = contextForm(app, "64000", "m");
  app.run("call = async (method,path,body) => { requests.push({method,path,body}); return new Promise(resolve => { globalThis.finishSave = resolve; }); }");
  const pending = app.dispatch("submit", form);
  await app.dispatch("submit", form);
  assert.equal(app.run("requests.length"), 1); assert.equal(form.controls[0].disabled, true);
  assert.equal(app.run("requests[0].path"), "/api/providers/source/model-context");
  assert.equal(app.run("JSON.stringify(requests[0].body)"), '{"model":"m","tokens":64000}');
  app.run("finishSave({})"); await pending;
  assert.equal(form.controls[0].disabled, false);
  app.run("call = async (method,path,body) => { requests.push({method,path,body}); return {}; }");
  await app.dispatch("submit", contextForm(app, ""));
  assert.equal(app.run("JSON.stringify(requests[1].body)"), '{"model":"m","tokens":null}');
});

test("context editing survives redraw and failed saves; changing model loads that model's own value", async () => {
  const app = ui(); provider(app);
  const form = contextForm(app, "48000");
  await app.dispatch("input", { closest: () => form });
  assert.match(app.run("providerRow(state.providers[0])"), /name="tokens"[^>]*value="48000"/);
  app.run("call = async () => { throw new Error('fixture failure'); }");
  await app.dispatch("submit", form);
  assert.equal(form.controls[0].disabled, false);
  assert.match(app.run("providerRow(state.providers[0])"), /name="tokens"[^>]*value="48000"/);
  app.run("state.providers[0].models.push('other'); state.providers[0].modelContextWindows = {other:96000}");
  await app.dispatch("change", { matches: (s: string) => s === "[data-context-model]", value: "other", closest: () => form });
  assert.equal(form.values.tokens, 96000);
  assert.equal(app.run("contextDrafts.get('source').model"), "other");
});

test("invalid context input does not send a request or disable the form", async () => {
  const app = ui();
  for (const value of ["0", "-2", "3.5", "not-a-number"]) {
    const form = contextForm(app, value); await app.dispatch("submit", form);
    assert.equal(form.controls[0].disabled, false);
  }
  assert.equal(app.run("requests.length"), 0);
});
function buttonFor(form: ReturnType<ReturnType<typeof ui>["form"]>, attribute: string, model = "m") {
  const button = { disabled: false, type: "button", textContent: attribute === "data-probe" ? "检测一下" : "恢复默认",
    hasAttribute: (name: string) => name === attribute,
    closest: (selector: string): any => selector === "button" ? button : selector === ".detail" ? form.detail : null };
  form.controls.push(button);
  form.detail.querySelector = selector => selector === "[data-protocol-form]" ? form : selector === ".probe-model" ? { value: model } : selector === "[data-protocol-model]" ? { value: form.values.model } : null;
  return button;
}

test("protocol editing starts folded without hiding detection, overrides or reset", async () => {
  const app = ui(); provider(app);
  let html = app.run("providerRow(state.providers[0])") as string;
  const tag = html.match(/<details data-keep="protocols:source"[^>]*>/)?.[0];
  assert.ok(tag); assert.doesNotMatch(tag, /\bopen\b/);
  assert.match(html, /协议设置 · 通常不用动/); assert.match(html, /检测一下/);
  assert.match(html, /可能产生费用/); assert.match(html, /不覆盖 Gemini/);
  assert.match(html, /data-protocol-form/); assert.match(html, /data-protocol-auto/);
  await app.dispatch("toggle", { dataset: { keep: "protocols:source" }, open: true });
  html = app.run("providerRow(state.providers[0])");
  assert.match(html, /data-keep="protocols:source" open/);
  await app.dispatch("toggle", { dataset: { keep: "protocols:source" }, open: false });
  assert.doesNotMatch(app.run("providerRow(state.providers[0])"), /data-keep="protocols:source" open/);
  assert.equal(app.run("requests.length"), 0);
});

test("null protocol metadata and hostile probe fields render as inert text", () => {
  const app = ui(); provider(app);
  assert.match(app.run("protocolOptions(null)"), /value="chat" checked/);
  assert.doesNotMatch(app.run("protocolOptions({protocols:['constructor','<img>']})"), /value="chat" checked|<img>|function Object/);
  app.run(`state.providers[0].models=null;state.providers[0].usedBy=null;state.providers[0].probe={checks:[{status:'" onmouseover="bad',label:'<svg onload=x>',detail:'<&"',latencyMs:'<img src=x>'}]};`);
  const html = app.run("providerRow(state.providers[0])") as string;
  assert.match(html, /&lt;svg onload=x&gt;/); assert.match(html, /&lt;img src=x&gt;/);
  assert.doesNotMatch(html, /onmouseover=|<svg|<img src=x>/);
  assert.match(html, /data-probe disabled/);
});

test("unsaved model choices survive a redraw and failed save", async () => {
  const app = ui(); provider(app); const form = app.form(["messages"], "m");
  const target = { matches: () => false, closest: (selector: string) => selector === "[data-protocol-form]" ? form : null };
  await app.dispatch("change", target);
  let html = app.run("providerRow(state.providers[0])") as string;
  assert.match(html, /option value="m" selected/); assert.match(html, /value="messages" checked/);
  assert.doesNotMatch(html, /value="chat" checked/);
  app.run("call=async()=>{throw new Error('save failed')}");
  await app.submit(form);
  html = app.run("providerRow(state.providers[0])");
  assert.match(html, /value="messages" checked/); assert.equal(form.controls[0]!.disabled, false);
});

test("detection uses the selected model once, locks protocol mutations and preserves disabled controls", async () => {
  const app = ui(); provider(app); const form = app.form(["messages"], "m");
  form.controls[1]!.disabled = true;
  const button = buttonFor(form, "data-probe", "chosen/model");
  app.run("call=async(method,path,body)=>{requests.push({method,path,body});return new Promise((resolve,reject)=>globalThis.failProbe=reject)}");
  const pending = app.dispatch("click", button);
  assert.equal(button.textContent, "检测中…"); assert.equal(button.disabled, true);
  await app.dispatch("click", button); await app.submit(form);
  assert.equal(app.run("requests.length"), 1);
  assert.equal(app.run("requests[0].method"), "POST"); assert.equal(app.run("requests[0].path"), "/api/providers/source/probe");
  assert.equal(app.run("requests[0].body.model"), "chosen/model");
  app.run("failProbe(new Error('fixture unavailable'))"); await pending;
  assert.equal(button.disabled, false); assert.equal(button.textContent, "检测一下");
  assert.equal(form.controls[1]!.disabled, true); assert.equal(app.run("providerOperations.size"), 0);
  assert.match(app.run("providerRow(state.providers[0])"), /value="messages" checked/);
});

test("empty detection and stale disabled buttons never call an endpoint", async () => {
  const app = ui(); provider(app); const form = app.form(["chat"]);
  const button = buttonFor(form, "data-probe", "");
  await app.dispatch("click", button);
  assert.equal(app.run("requests.length"), 0); assert.match(app.run("messages[0]"), /先选一个模型/);
  button.disabled = true; await app.dispatch("click", button);
  assert.equal(app.run("requests.length"), 0);
});

test("reset is scoped, suppresses duplicate clicks, and drops the draft only after success", async () => {
  const app = ui(); provider(app); const form = app.form(["gemini"], "m");
  const button = buttonFor(form, "data-protocol-auto");
  app.run("call=async(method,path,body)=>{requests.push({method,path,body});return new Promise(resolve=>globalThis.finishReset=resolve)}");
  const pending = app.dispatch("click", button); await app.dispatch("click", button);
  assert.equal(app.run("requests.length"), 1); assert.equal(app.run("protocolDrafts.has('source')"), true);
  assert.equal(app.run("JSON.stringify(requests[0].body)"), '{"protocols":null,"model":"m"}');
  app.run("finishReset({})"); await pending;
  assert.equal(app.run("protocolDrafts.has('source')"), false); assert.equal(button.disabled, false);
});


test("provider icon metadata cannot inject image attributes or CSS URLs", () => {
  const app = ui();
  for (const value of ['bad" onerror="alert(1)', "../external", "https://attacker.invalid/mark", null, 42]) {
    const markup = app.run(`icon(${JSON.stringify(value)}, 'sm')`) as string;
    assert.match(markup, /class="ic letter sm"/);
    assert.ok(!markup.includes("onerror") && !markup.includes("attacker") && !markup.includes("<img"));
  }
  const letter = app.run(`icon('letter:<script>', '" onmouseover="alert(1)')`) as string;
  assert.ok(letter.includes("&lt;script&gt;")); assert.ok(!letter.includes("onmouseover"));
});
