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
    return { dataset: {} as Record<string, string>, values: { protocols, model }, controls,
      matches: (selector: string) => selector === "[data-protocol-form]", querySelectorAll: () => controls,
      closest: () => ({ dataset: { provider: "source" } }) };
  }
  return { run, form, submit: async (target: ReturnType<typeof form>) => { for (const handler of handlers.submit ?? []) await handler({ target, preventDefault() {} }); } };
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
  assert.deepEqual(form.values.protocols, ["gemini"]); assert.equal(app.run("messages[0]"), "fixture failure");
  app.run("call = async (method,path,body) => { requests.push({method,path,body}); return {}; }");
  await app.submit(form); assert.equal(app.run("requests.length"), 1);
});
