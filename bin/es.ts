#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `es` — start any agent on EasySwitch from your own terminal.
 *
 *   es                          what is available
 *   es <agent> [options] [-- agent args]
 *                               run the agent here, on EasySwitch, for this run only
 *   es models                   the models EasySwitch serves
 *   es shell-init               shell functions so plain `claude` / `codex` use EasySwitch (opt-in)
 *
 * Options: -m <provider/model>  -e <effort>
 * Nothing in the agent's own config is written; the environment and flags exist only for this process.
 */

const PORT = Number(process.env.EASYSWITCH_PORT ?? 18765);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADERS = { "content-type": "application/json", "x-easyswitch": "1" };
const here = dirname(fileURLToPath(import.meta.url));

type Json = Record<string, any>;

async function up(): Promise<boolean> {
  try {
    return (await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(800) })).ok;
  } catch {
    return false;
  }
}

/** Starts the core in the background when it is not running, and waits for it. */
async function ensureUp(): Promise<boolean> {
  if (await up()) return true;
  const child = spawn(process.execPath, [join(here, "..", "core", "src", "main.ts")], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 150));
    if (await up()) return true;
  }
  return false;
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: Json }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: HEADERS, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
}

function fail(message: string): never {
  console.error(`es: ${message}`);
  process.exit(1);
}

async function agents(): Promise<Json[]> {
  return ((await api("GET", "/api/agents")).json.agents ?? []) as Json[];
}

async function list(): Promise<void> {
  const mine = (await agents()).filter(a => a.installed && a.can?.interactive);
  if (!mine.length) fail("没有找到可以在 EasySwitch 上启动的 agent");
  console.log("可以这样启动（只在这一次运行里生效）：\n");
  for (const a of mine) console.log(`  es ${String(a.id).padEnd(12)} ${a.name}${a.can.efforts?.length ? `   -e ${a.can.efforts.join("|")}` : ""}`);
  console.log("\n选模型：es <agent> -m <来源/模型>    看模型：es models");
}

async function shellInit(): Promise<void> {
  const mine = (await agents()).filter(a => a.installed && a.can?.interactive && a.kind === "cli" && a.bins?.[0]);
  const lines = [
    "# EasySwitch: plain agent commands run on EasySwitch while it is up; EASYSWITCH_OFF=1 skips it.",
    `# Add to your shell profile:  eval "$(es shell-init)"`,
  ];
  for (const a of mine) {
    const bin = String(a.bins[0]);
    lines.push(`${bin}() { if [ -z "$EASYSWITCH_OFF" ] && es --check ${a.id}; then es ${a.id} -- "$@"; else command ${bin} "$@"; fi; }`);
  }
  console.log(lines.join("\n"));
}

async function run(id: string, args: string[]): Promise<void> {
  let model: string | undefined;
  let effort: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") { rest.push(...args.slice(i + 1)); break; }
    if (a === "-m" || a === "--model") model = args[++i];
    else if (a === "-e" || a === "--effort") effort = args[++i];
    else rest.push(a);
  }
  if (!(await ensureUp())) fail(`EasySwitch 没有在运行，也没能自动启动（端口 ${PORT}）`);
  const { status, json } = await api("POST", `/api/agents/${id}/command`, { ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
  if (status !== 200) fail(String(json.error ?? `HTTP ${status}`));
  const env: NodeJS.ProcessEnv = { ...process.env, ...json.env };
  for (const name of (json.unset ?? []) as string[]) delete env[name];
  console.error(`EasySwitch · ${json.name} · ${json.model}（只在这一次运行里生效）`);
  const child = spawn(String(json.command), [...(json.args as string[]), ...rest], { env, stdio: "inherit" });
  const cleanup = () => rmSync(String(json.sessionDir), { recursive: true, force: true });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  child.on("error", error => { cleanup(); fail(error.message); });
  child.on("close", (code, signal) => { cleanup(); process.exit(code ?? (signal ? 1 : 0)); });
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "--check") {
  // For shell functions: succeed only when EasySwitch is up and can start this agent.
  if (!(await up())) process.exit(1);
  const a = (await agents()).find(x => x.id === args[0]);
  process.exit(a?.installed && a.can?.interactive ? 0 : 1);
} else if (!cmd || cmd === "list") {
  if (!(await ensureUp())) fail(`EasySwitch 没有在运行，也没能自动启动（端口 ${PORT}）`);
  await list();
} else if (cmd === "models") {
  if (!(await ensureUp())) fail("EasySwitch 没有在运行");
  const models = (await (await fetch(`${BASE}/v1/models`)).json()) as { data?: Array<{ id: string }> };
  for (const m of models.data ?? []) console.log(m.id);
} else if (cmd === "shell-init") {
  if (!(await ensureUp())) fail("EasySwitch 没有在运行");
  await shellInit();
} else if (cmd === "-h" || cmd === "--help") {
  console.log("es              看有哪些 agent 可以启动\nes <agent> [-m 来源/模型] [-e 档位] [-- agent 自己的参数]\nes models       看模型\nes shell-init   让直接敲 claude / codex 也走 EasySwitch（需要你自己加进 shell 配置）");
} else {
  await run(cmd, args);
}
