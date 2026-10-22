import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { esMain, type EsCliDeps } from "../../bin/es.ts";

// This imports the production CLI entrypoint; it never executes a CLI file or a real child.
const SESSION = "12345678-1234-4234-8234-123456789012";
const TOKEN = "es-session-fixture-0123456789abcdef";
async function fixture(t: TestContext, options: { modelsStatus?: number; catalog?: unknown; revokeStatus?: number; commandStatus?: number; omitSession?: boolean } = {}) {
  const sessionDir = mkdtempSync(join(realpathSync(tmpdir()), "easyswitch-session-"));
  writeFileSync(join(sessionDir, "private-fixture.json"), "{}", { mode: 0o600 });
  const requests: Array<{ method: string; path: string; headers: Record<string, unknown>; body: any }> = [];
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const data of req) raw += String(data);
    const path = req.url!; requests.push({ method: req.method!, path, headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader("content-type", "application/json");
    if (path === "/health") { res.end('{"ok":true}'); return; }
    if (path === "/api/models") {
      assert.equal(req.headers["x-easyswitch"], "1");
      assert.equal(req.headers.authorization, undefined, "catalog access must not borrow native or model credentials");
      res.statusCode = options.modelsStatus ?? 200;
      res.end(JSON.stringify(options.catalog ?? (res.statusCode === 200 ? { data: [{id:"fixture/model"},{id:"pool/shared"}] } : { error: { message: `fixture denied ${TOKEN}` } })));
      return;
    }
    if (path === "/api/agents/fixture/command") {
      res.statusCode = options.commandStatus ?? 200;
      res.end(JSON.stringify(res.statusCode === 200 ? {
        command: "/fixture/agent", args: ["--model", "fixture/model"], env: { EASYSWITCH_GATEWAY_TOKEN: TOKEN }, unset: ["INHERITED_SECRET"],
        sessionDir, model: "fixture/model", name: "Fixture", ...(options.omitSession ? {} : {session:{id:SESSION,expiresAt:"2099-01-01T00:00:00.000Z"}}),
      } : {error:"没有检测到这个 agent 的命令"})); return;
    }
    if (path === `/api/gateway/sessions/${SESSION}` && req.method === "DELETE") {
      assert.equal(req.headers["x-easyswitch"], "1");
      res.statusCode = options.revokeStatus ?? 200; res.end(JSON.stringify({ok:res.statusCode===200,error: res.statusCode===200 ? undefined : TOKEN})); return;
    }
    res.statusCode = 404; res.end('{"error":"unexpected fixture route"}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(sessionDir, {recursive:true,force:true}); });
  const output: string[] = [], errors: string[] = [], spawns: any[][] = [], kills: string[] = [];
  const signals = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {kill(signal: string) { kills.push(signal); return true; },unref() {}});
  let spawned!: () => void; const started = new Promise<void>(resolve => { spawned = resolve; });
  const spawn: EsCliDeps["spawn"] = ((...args: any[]) => { spawns.push(args); spawned(); return child; }) as EsCliDeps["spawn"];
  const deps: EsCliDeps = {
    env: { EASYSWITCH_PORT: String((server.address() as {port:number}).port), INHERITED_SECRET:"do-not-inherit", HOME:sessionDir },
    spawn, signals: signals as unknown as EsCliDeps["signals"], out: line => output.push(line), err: line => errors.push(line),
  };
  return {deps,output,errors,spawns,requests,child,kills,signals,started,sessionDir};
}

test("es models uses guarded console discovery without issuing a model capability or spawning", async t => {
  const f = await fixture(t); assert.equal(await esMain(["models"], f.deps), 0);
  assert.deepEqual(f.output, ["fixture/model","pool/shared"]); assert.deepEqual(f.errors, []); assert.equal(f.spawns.length, 0);
  assert.deepEqual(f.requests.map(r=>r.path), ["/health","/api/models"]);
});

test("models 401 and malformed success are errors, never a falsely empty catalog", async t => {
  for (const options of [{modelsStatus:401},{catalog:{data:[{name:"not-an-id"}]}},{catalog:{}}]) {
    const f = await fixture(t, options); assert.equal(await esMain(["models"], f.deps), 1);
    assert.deepEqual(f.output, []); assert.equal(f.spawns.length, 0);
    assert.match(f.errors.join("\n"), options.modelsStatus ? /连接凭据已失效/ : /无效的模型目录/);
    assert.ok(!f.errors.join("\n").includes(TOKEN));
    assert.doesNotMatch(f.errors.join("\n"), /HTTP|\b[45]\d\d\b/);
  }
});

test("a genuinely empty successful model catalog remains a successful empty list", async t => {
  const f = await fixture(t,{catalog:{data:[]}}); assert.equal(await esMain(["models"], f.deps), 0);
  assert.deepEqual(f.output, []); assert.deepEqual(f.errors, []);
});

test("normal fake child exit revokes exactly its session, clears private files and preserves the exit code", async t => {
  const f = await fixture(t); const pending = esMain(["fixture","-m","fixture/model","-e","low","--","--fake-argument"], f.deps);
  await f.started;
  assert.equal(f.requests.some(r=>r.method==="DELETE"), false); assert.equal(existsSync(f.sessionDir), true);
  assert.equal(f.spawns.length, 1); const [command,args,opts] = f.spawns[0]!;
  assert.equal(command, "/fixture/agent"); assert.deepEqual(args,["--model","fixture/model","--fake-argument"]);
  assert.equal(opts.env.EASYSWITCH_GATEWAY_TOKEN, TOKEN); assert.equal(opts.env.INHERITED_SECRET, undefined);
  assert.ok(!JSON.stringify(args).includes(TOKEN)); assert.ok(!f.errors.join("\n").includes(TOKEN));
  assert.deepEqual(f.requests.find(r=>r.path.endsWith("/command"))!.body, {model:"fixture/model",effort:"low"});
  f.child.emit("close",7,null); assert.equal(await pending,7);
  assert.deepEqual(f.requests.filter(r=>r.method==="DELETE").map(r=>r.path),[`/api/gateway/sessions/${SESSION}`]);
  assert.equal(existsSync(f.sessionDir),false); assert.equal(f.signals.listenerCount("SIGTERM"),0);
});

test("revoke failure still removes files, reports the failure without credentials, and returns nonzero", async t => {
  const f=await fixture(t,{revokeStatus:503}); const pending=esMain(["fixture"],f.deps); await f.started;
  f.child.emit("close",0,null); assert.equal(await pending,1); assert.equal(existsSync(f.sessionDir),false);
  assert.match(f.errors.join("\n"),/撤销未确认/); assert.ok(!f.errors.join("\n").includes(TOKEN));
});

test("a cleanup transport failure is bounded by a signal and cannot leak credentials or skip deletion", async t => {
  const f=await fixture(t); const original=globalThis.fetch;
  const fetch:typeof original=(input,init)=>{
    assert.equal(init?.redirect,"error"); assert.ok(init?.signal);
    if(init?.method==="DELETE") return Promise.reject(new Error(TOKEN));
    return original(input,init);
  };
  const pending=esMain(["fixture"],{...f.deps,fetch}); await f.started; f.child.emit("close",0,null);
  assert.equal(await pending,1); assert.equal(existsSync(f.sessionDir),false);
  assert.match(f.errors.join("\n"),/撤销未确认/); assert.ok(!f.errors.join("\n").includes(TOKEN));
});

test("an already revoked session is harmless and cleanup failures are reported separately", async t => {
  const f=await fixture(t,{revokeStatus:404}); const pending=esMain(["fixture"],f.deps); await f.started; f.child.emit("close",0,null);
  assert.equal(await pending,0); assert.equal(existsSync(f.sessionDir),false);
  const other=await fixture(t); const failed=esMain(["fixture"],{...other.deps,removeSessionDir(){throw new Error(TOKEN);}});
  await other.started; other.child.emit("close",0,null); assert.equal(await failed,1);
  assert.match(other.errors.join("\n"),/目录清理失败/); assert.ok(!other.errors.join("\n").includes(TOKEN));
});

test("sync spawn failure and error-then-close each revoke once and leave no private directory", async t => {
  const first=await fixture(t);
  assert.equal(await esMain(["fixture"],{...first.deps,spawn:(()=>{throw new Error(TOKEN);}) as EsCliDeps["spawn"]}),1);
  assert.equal(existsSync(first.sessionDir),false); assert.equal(first.requests.filter(r=>r.method==="DELETE").length,1);
  assert.ok(!first.errors.join("\n").includes(TOKEN));
  const f=await fixture(t); const pending=esMain(["fixture"],f.deps); await f.started;
  f.child.emit("error",new Error(TOKEN)); f.child.emit("close",-2,null); assert.equal(await pending,1);
  assert.equal(existsSync(f.sessionDir),false); assert.equal(f.requests.filter(r=>r.method==="DELETE").length,1);
});

test("signals go only to the selected child and revocation waits for its terminal event", async t => {
  const f=await fixture(t); const pending=esMain(["fixture"],f.deps); await f.started;
  f.signals.emit("SIGINT"); assert.deepEqual(f.kills,["SIGINT"]);
  assert.equal(f.requests.filter(r=>r.method==="DELETE").length,0);
  f.child.emit("close",null,"SIGINT"); assert.equal(await pending,1);
  for(const signal of ["SIGINT","SIGTERM","SIGHUP"]) assert.equal(f.signals.listenerCount(signal),0);
});

test("missing session identity fails before spawn, and rejected command never tries unrelated cleanup", async t => {
  const f=await fixture(t,{omitSession:true}); assert.equal(await esMain(["fixture"],f.deps),1);
  assert.equal(f.spawns.length,0); assert.equal(existsSync(f.sessionDir),false); assert.match(f.errors.join("\n"),/会话信息/);
  const other=await fixture(t,{commandStatus:404}); assert.equal(await esMain(["fixture"],other.deps),1);
  assert.equal(other.spawns.length,0); assert.equal(other.requests.filter(r=>r.method==="DELETE").length,0);
  assert.equal(existsSync(other.sessionDir),true);
});

test("help and invalid options never start a daemon, use the network, or read native accounts", async () => {
  const output:string[]=[], errors:string[]=[];
  const deps:EsCliDeps={env:{},out:s=>output.push(s),err:s=>errors.push(s),fetch:()=>{throw new Error("unexpected fetch");},spawn:(()=>{assert.fail("unexpected process");}) as EsCliDeps["spawn"]};
  assert.equal(await esMain(["--help"],deps),0); assert.match(output.join("\n"),/es models/);
  assert.equal(await esMain(["fixture","-m"],deps),1); assert.match(errors.join("\n"),/需要填写/);
  assert.equal(await esMain(["models"],{...deps,env:{EASYSWITCH_PORT:"NaN"}}),1);
});

test("real command API keeps unsupported, undetected and model-missing failures distinct without spawning or allocating", async () => {
  const { createEasySwitchServer } = await import("../src/server.ts");
  const { Store } = await import("../src/store.ts");
  const { GatewayTokenAuthority } = await import("../src/gateway-auth.ts");
  for (const scenario of [
    { id: "no-such-agent", bin: undefined, code: "agent_not_integrated", text: /还没有接入交互启动/, status: 409, finds: 0 },
    { id: "hermes", bin: undefined, code: "agent_not_found", text: /没有检测到/, status: 404, finds: 1 },
    { id: "hermes", bin: "/fixture/never-run", code: "model_not_found", text: /没有可用的模型/, status: 409, finds: 1 },
    { id: "hermes", bin: "/fixture/never-run", code: "provider_disabled", text: /来源还没打开/, status: 409, finds: 1, model: "off/m" },
  ]) {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "es-cli-errors-"));
    const store = new Store(dir); store.setSettings({ claudeNative: false });
    if (scenario.model) store.upsertProvider({ id: "off", name: "private-source-name", baseUrl: "http://127.0.0.1:1", models: ["m"], off: true, route: "chat-translate", routePinned: true, protocols: ["chat"], streamUsage: false, createdAt: "" });
    const auth = new GatewayTokenAuthority(); let finds = 0;
    const never = () => { assert.fail("rejected startup must not read secrets, allocate files, or start a process"); };
    const server = createEasySwitchServer({ store, port: 0, gatewayAuth: auth,
      secrets: { get: async () => never(), set: async () => never(), delete: async () => never() },
      interactiveRuntime: { findBinary: async () => { finds++; return scenario.bin; }, newSessionDir: never, launchInTerminal: async () => never() },
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    const errors: string[] = [], output: string[] = []; let result: any;
    try {
      const code = await esMain([scenario.id, ...(scenario.model ? ["-m", scenario.model] : [])], { env: { EASYSWITCH_PORT: String((server.address() as { port: number }).port) },
        fetch: async (input, init) => { const response = await fetch(input, init); if (String(input).endsWith("/command")) result = { status: response.status, body: await response.clone().json() }; return response; },
        spawn: never, err: line => errors.push(line), out: line => output.push(line),
      });
      assert.equal(code, 1); assert.deepEqual(output, []);
      assert.match(errors.join("\n"), scenario.text);
      assert.doesNotMatch(errors.join("\n"), /HTTP|\b[45]\d\d\b|no-such-agent|private-source-name/);
      assert.match(errors.join("\n"), /es list|模型来源/);
      assert.equal(result.status, scenario.status); assert.equal(result.body.code, scenario.code);
      assert.equal(finds, scenario.finds); assert.deepEqual(auth.list(), []);
    } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
  }
});

test("request failures use fixed CLI wording and never echo hostile server prose or status codes", async () => {
  const sensitive = "Bearer fixture-private-value sk-fixture-secret es-session-leak \u001b[31m /Users/private/path";
  for (const [status, body, expected] of [
    [409, { code: "agent_not_integrated", error: sensitive, uiError: { message: sensitive, title: sensitive } }, /还没有接入交互启动/],
    [404, { code: "agent_not_found", error: { message: sensitive }, uiError: { message: sensitive } }, /没有检测到/],
    [500, { code: sensitive, error: sensitive, uiError: { code: sensitive, message: sensitive } }, /这次操作没有完成/],
    [409, { code: "provider_disabled", error: sensitive }, /来源还没打开/],
    [409, { code: "account_resting", error: sensitive }, /已暂停自动启动.*「设置」检查账号和休息标记/],
  ] as const) {
    const errors: string[] = [];
    const code = await esMain(["fixture"], { env: {}, spawn: (() => assert.fail("no process on rejection")) as EsCliDeps["spawn"], out: () => assert.fail("no successful output"), err: line => errors.push(line),
      fetch: async input => String(input).endsWith("/health") ? Response.json({ ok: true }) : Response.json(body, { status }),
    });
    assert.equal(code, 1); assert.match(errors.join("\n"), expected);
    assert.doesNotMatch(errors.join("\n"), /HTTP|\b[45]\d\d\b|fixture-private|fixture-secret|session-leak|Users\/private|\u001b/);
    assert.match(errors.join("\n"), /es list|es doctor|模型来源|「设置」/);
  }
});

test("transport and synchronous daemon-spawn exceptions cannot leak arbitrary messages", async () => {
  const sensitive = "Bearer fixture-private-value sk-fixture-secret /Users/private/path";
  for (const phase of ["request", "daemon"] as const) {
    const errors: string[] = []; let spawns = 0;
    const code = await esMain(["models"], { env: {}, err: line => errors.push(line), out: () => assert.fail("no successful output"),
      fetch: async input => { if (phase === "request" && String(input).endsWith("/health")) return Response.json({ ok: true }); throw new Error(sensitive); },
      spawn: (() => { spawns++; throw new Error(sensitive); }) as EsCliDeps["spawn"],
    });
    assert.equal(code, 1); assert.equal(spawns, phase === "daemon" ? 1 : 0);
    assert.match(errors.join("\n"), /es doctor/); assert.doesNotMatch(errors.join("\n"), /fixture-private|fixture-secret|Users\/private|HTTP/);
  }
});
