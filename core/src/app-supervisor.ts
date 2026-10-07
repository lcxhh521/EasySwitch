import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CoreSupervisor } from "./core-supervisor.ts";

const entry = fileURLToPath(import.meta.url);

/** The parent must keep stdin open. Closing it is the ownership signal, not an unauthenticated HTTP API. */
export async function runAppSupervisor(deps:{spawn?:typeof spawn;input?:Pick<NodeJS.ReadStream,"once"|"off"|"resume"|"pause">;signals?:Pick<NodeJS.Process,"once"|"off">;homeDir?:string;execPath?:string;out?:(line:string)=>void}={}): Promise<number> {
  const appRoot = dirname(dirname(dirname(entry)));
  const dataHome = join(deps.homeDir ?? homedir(), "Library", "Application Support", "EasySwitch");
  const input=deps.input ?? process.stdin,signals=deps.signals ?? process;
  return new Promise<number>(resolve => {
    let finishing = false; let failed = false;
    const supervisor = new CoreSupervisor({
      spawn: () => (deps.spawn ?? spawn)(deps.execPath ?? process.execPath, [entry, "--core"], {
        cwd: appRoot, env: { ...process.env, EASYSWITCH_HOME: dataHome },
        stdio: ["pipe", "ignore", "ignore"],
      }),
      changed: status => {
        // Status codes only; child stdout/errors could contain provider-controlled text.
        (deps.out ?? (line=>process.stdout.write(line)))(JSON.stringify(status) + "\n");
        if (status.state === "failed" && !finishing) { failed = true; void stop(); }
      },
    });
    const stop = async () => {
      if (finishing) return; finishing = true;
      try { await supervisor.stop(); resolve(failed ? 1 : 0); } catch { resolve(1); }
      finally {
        input.off("end", stop); input.off("close", stop);
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) signals.off(signal, stop);
        input.pause();
      }
    };
    input.once("end", stop); input.once("close", stop);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) signals.once(signal, stop);
    supervisor.start(); input.resume();
  });
}

async function runOwnedCore(): Promise<void> {
  let closing = false;
  const parentEnded = () => {
    if (closing) return; closing = true;
    // main.ts already has graceful SIGTERM cleanup. Bound the orphan path if a request never drains.
    process.kill(process.pid, "SIGTERM");
    setTimeout(() => process.exit(1), 4_000).unref();
  };
  await import("./main.ts");
  process.stdin.once("end", parentEnded); process.stdin.once("close", parentEnded); process.stdin.resume();
}

const direct = (() => { try { return Boolean(process.argv[1]) && realpathSync(process.argv[1]!) === realpathSync(entry); } catch { return false; } })();
if (direct) {
  if (process.argv[2] === "--core") await runOwnedCore();
  else process.exit(await runAppSupervisor());
}
