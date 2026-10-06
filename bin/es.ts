#!/usr/bin/env node
import { humanError } from "../core/src/user-errors.ts";
import { spawn as nodeSpawn } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `es` starts one private agent session, or reads the local console's model catalog.
 * Importing this module never starts a daemon or an agent; tests inject every process boundary.
 */
export interface EsCliDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  spawn?: typeof nodeSpawn;
  out?: (line: string) => void;
  err?: (line: string) => void;
  signals?: Pick<NodeJS.Process, "on" | "removeListener">;
  removeSessionDir?: (path: string) => void;
  wait?: (ms: number) => Promise<void>;
}
type Json = Record<string, any>;
const HEADERS = { "content-type": "application/json", "x-easyswitch": "1" };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const safeText = (value: unknown): string => String(value ?? "").replace(/es-session-[a-z0-9-]+/gi, "[session redacted]").replace(/[\x00-\x1f\x7f]/g, " ");

export async function esMain(argv: string[], deps: EsCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const port = Number(env.EASYSWITCH_PORT ?? 18765);
  const base = `http://127.0.0.1:${port}`;
  const fetch = deps.fetch ?? globalThis.fetch;
  const spawn = deps.spawn ?? nodeSpawn;
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const signals = deps.signals ?? process;
  const remove = deps.removeSessionDir ?? (path => rmSync(path, { recursive: true, force: true }));
  const wait = deps.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const here = dirname(fileURLToPath(import.meta.url));

  async function up(): Promise<boolean> {
    try { return (await fetch(`${base}/health`, { signal: AbortSignal.timeout(800), redirect: "error" })).ok; }
    catch { return false; }
  }
  async function ensureUp(): Promise<boolean> {
    if (await up()) return true;
    const child = spawn(process.execPath, [join(here, "..", "core", "src", "main.ts")], { env, detached: true, stdio: "ignore" });
    // Startup errors should become a readable failure, never an unhandled error event.
    let failed = false; child.once("error", () => { failed = true; }); child.unref();
    for (let i = 0; i < 40 && !failed; i++) { await wait(150); if (await up()) return true; }
    return false;
  }
  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
    const res = await fetch(`${base}${path}`, { method, headers: HEADERS, redirect: "error", signal: AbortSignal.timeout(10_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json: json && typeof json === "object" ? json as Json : {} };
  }
  function check(result: { status: number; json: Json }): Json {
    if (result.status !== 200) throw new Error(`HTTP ${result.status}: ${safeText(result.json.error?.message ?? result.json.error ?? "EasySwitch 请求失败")}`);
    return result.json;
  }
  async function agents(): Promise<Json[]> {
    const json = check(await api("GET", "/api/agents"));
    if (!Array.isArray(json.agents)) throw new Error("EasySwitch 返回了无效的 agent 列表");
    return json.agents;
  }
  async function run(id: string, args: string[]): Promise<number> {
    let model: string | undefined, effort: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--") { rest.push(...args.slice(i + 1)); break; }
      if (["-m", "--model", "-e", "--effort"].includes(a)) {
        const value = args[++i];
        if (!value || value.startsWith("-")) throw new Error(`${a} 后面需要填写一个值`);
        if (a === "-m" || a === "--model") model = value; else effort = value;
      } else rest.push(a);
    }
    if (!(await ensureUp())) throw new Error(`EasySwitch 没有在运行，也没能自动启动（端口 ${port}）`);
    const spec = check(await api("POST", `/api/agents/${encodeURIComponent(id)}/command`, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }));
    const sessionId = typeof spec.session?.id === "string" && UUID.test(spec.session.id) ? spec.session.id : undefined;
    const sessionDir = typeof spec.sessionDir === "string" && isAbsolute(spec.sessionDir) && /^easyswitch-session-[a-z0-9]+$/i.test(basename(spec.sessionDir)) ? spec.sessionDir : undefined;
    let cleanupPromise: Promise<boolean> | undefined;
    const cleanup = (): Promise<boolean> => cleanupPromise ??= (async () => {
      let ok = true;
      try {
        if (!sessionId) throw new Error("missing session id");
        const result = await api("DELETE", `/api/gateway/sessions/${sessionId}`);
        // A revoked/expired session is already absent; other errors must not look like success.
        if (result.status !== 404 && (result.status !== 200 || result.json.ok !== true)) throw new Error(`HTTP ${result.status}`);
      } catch { ok = false; err("es: 会话令牌撤销未确认，请在控制台检查并重试撤销"); }
      finally {
        try { if (!sessionDir) throw new Error("invalid session directory"); remove(sessionDir); }
        catch { ok = false; err("es: 私有会话目录清理失败，请在控制台检查"); }
      }
      return ok;
    })();
    if (!sessionId || !sessionDir || typeof spec.command !== "string" || !spec.command || !Array.isArray(spec.args) || !spec.args.every((a: unknown) => typeof a === "string") || !spec.env || typeof spec.env !== "object" || Array.isArray(spec.env) || Object.values(spec.env).some(v => typeof v !== "string") || (spec.unset !== undefined && (!Array.isArray(spec.unset) || !spec.unset.every((v: unknown) => typeof v === "string")))) {
      await cleanup(); throw new Error("启动命令缺少有效的会话信息，请更新 EasySwitch 后重试");
    }
    const childEnv: NodeJS.ProcessEnv = { ...env, ...spec.env };
    for (const name of spec.unset ?? []) delete childEnv[name];
    err(`EasySwitch · ${safeText(spec.name)} · ${safeText(spec.model)}（只在这一次运行里生效）`);
    let child: ReturnType<typeof nodeSpawn>;
    try { child = spawn(spec.command, [...spec.args, ...rest], { env: childEnv, stdio: "inherit" }); }
    catch { await cleanup(); throw new Error("无法启动 agent 程序，请检查安装路径"); }
    return new Promise<number>(resolve => {
      let finished = false;
      const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map(signal => {
        const handler = () => { try { child.kill(signal); } catch { err("es: 无法转发停止信号，请检查 agent 进程"); } };
        signals.on(signal, handler); return { signal, handler };
      });
      const finish = async (code: number) => {
        if (finished) return; finished = true;
        for (const { signal, handler } of handlers) signals.removeListener(signal, handler);
        const cleaned = await cleanup(); resolve(cleaned ? code : code || 1);
      };
      child.once("error", () => { err("es: 无法启动 agent 程序，请检查安装路径"); void finish(1); });
      child.once("close", (code, signal) => { void finish(code ?? (signal ? 1 : 0)); });
    });
  }

  try {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EASYSWITCH_PORT 必须是有效端口");
    const [cmd, ...args] = argv;
    if (cmd === "doctor") {
      if(args.some(a=>a!=="--json"))throw new Error("自检只接受 --json；主动检测请在控制台明确选择并确认。");
      // Read-only by default: never start a daemon or run an agent/help command.
      try {
        const report=check(await api("GET","/api/doctor"));
        if(report.version!==1||!Array.isArray(report.findings))throw new Error("invalid diagnostic report");
        if(args.includes("--json"))out(JSON.stringify(report));
        else {out("EasySwitch 自检（只读取状态，不调用模型或启动程序）");for(const f of report.findings)out(`${safeText(f.title)}：${safeText(f.message)} ${safeText(f.nextStep)}`);}
        return report.status==="error"?1:0;
      } catch {const view=humanError({code:"service_unavailable"});if(args.includes("--json"))out(JSON.stringify({version:1,status:"error",error:view}));else err(view.message);return 1;}
    }
    if (cmd === "--check") {
      if (!(await up())) return 1;
      const agent = (await agents()).find(a => a.id === args[0]);
      return agent?.installed && agent.can?.interactive ? 0 : 1;
    }
    if (cmd === "-h" || cmd === "--help") {
      out("es              看有哪些 agent 可以启动\nes <agent> [-m 来源/模型] [-e 档位] [-- agent 自己的参数]\nes models       看模型\nes doctor [--json]  只读取本地自检状态，不运行模型或程序\nes shell-init   让直接敲 claude / codex 也走 EasySwitch（需要你自己加进 shell 配置）");
      return 0;
    }
    if (!cmd || cmd === "list" || cmd === "models" || cmd === "shell-init") {
      if (!(await ensureUp())) throw new Error("EasySwitch 没有在运行，也没能自动启动");
      if (cmd === "models") {
        // The guarded console API needs no model-inference capability or account login.
        const catalog = check(await api("GET", "/api/models"));
        if (!Array.isArray(catalog.data) || !catalog.data.every((m: unknown) => m && typeof m === "object" && typeof (m as Json).id === "string")) throw new Error("EasySwitch 返回了无效的模型目录");
        for (const model of catalog.data) out(safeText(model.id));
      } else {
        const mine = (await agents()).filter(a => a.installed && a.can?.interactive);
        if (cmd === "shell-init") {
          const lines = ["# EasySwitch: plain agent commands run on EasySwitch while it is up; EASYSWITCH_OFF=1 skips it.", '# Add to your shell profile:  eval "$(es shell-init)"'];
          for (const agent of mine.filter(a => a.kind === "cli" && /^[a-zA-Z0-9_-]+$/.test(a.bins?.[0] ?? "") && /^[a-z0-9-]+$/.test(a.id))) {
            const bin = String(agent.bins[0]);
            lines.push(`${bin}() { if [ -z "$EASYSWITCH_OFF" ] && es --check ${agent.id}; then es ${agent.id} -- "$@"; else command ${bin} "$@"; fi; }`);
          }
          out(lines.join("\n"));
        } else {
          if (!mine.length) throw new Error("没有找到可以在 EasySwitch 上启动的 agent");
          out("可以这样启动（只在这一次运行里生效）：\n");
          for (const agent of mine) out(`  es ${safeText(agent.id).padEnd(12)} ${safeText(agent.name)}${agent.can.efforts?.length ? `   -e ${safeText(agent.can.efforts.join("|"))}` : ""}`);
          out("\n选模型：es <agent> -m <来源/模型>    看模型：es models");
        }
      }
      return 0;
    }
    return await run(cmd, args);
  } catch (error) { err(`es: ${safeText((error as Error).message)}`); return 1; }
}

// Resolve the entrypoint so an installed symlink still works, while imports remain inert.
const direct = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (direct) process.exit(await esMain(process.argv.slice(2)));
