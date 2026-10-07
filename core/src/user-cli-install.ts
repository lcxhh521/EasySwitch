import { constants, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const MARKER = "# EasySwitch owned user command v1";
const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
export interface UserCliInstallPlan { target: string; script: string; fallbackCommand: string }
export function userCliInstallPlan(resourcesDir: string, homeDir: string): UserCliInstallPlan {
  if (![resourcesDir, homeDir].every(p => isAbsolute(p) && !/[\x00\r\n]/.test(p))) throw new Error("Expected absolute application and home paths");
  const command = `${quote(join(resourcesDir, "node", "bin", "node"))} ${quote(join(resourcesDir, "app", "bin", "es.ts"))}`;
  return { target: join(homeDir, ".local", "bin", "es"), script: `#!/bin/sh\n${MARKER}\nexec ${command} "$@"\n`, fallbackCommand: `alias es=${quote(command)}` };
}
export interface UserCliInstallResult { installed: boolean; alreadyInstalled?: boolean; target: string; fallbackCommand: string; code?: "existing_command" | "unsafe_directory" | "app_incomplete" | "install_failed" }

/** Explicit product action only. Does not change PATH, shell profiles, login items or administrator settings. */
export function installUserCli(resourcesDir: string, homeDir: string): UserCliInstallResult {
  const home = realpathSync(homeDir);
  const plan = userCliInstallPlan(resourcesDir, home);
  const result = { target: plan.target, fallbackCommand: plan.fallbackCommand };
  const node = join(resourcesDir, "node", "bin", "node"), cli = join(resourcesDir, "app", "bin", "es.ts");
  try {
    for (const file of [node, cli]) { const s = lstatSync(file); if (!s.isFile() || s.isSymbolicLink() || (file===node && process.platform!=="win32" && ((s.mode&0o111)===0 || (s.mode&0o022)!==0))) return { ...result, installed:false, code:"app_incomplete" }; }
  } catch { return { ...result, installed:false, code:"app_incomplete" }; }
  try {
    for (const dir of [join(home, ".local"), join(home, ".local", "bin")]) {
      try { mkdirSync(dir, { mode:0o755 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      const s = lstatSync(dir);
      if (!s.isDirectory() || s.isSymbolicLink() || (process.platform !== "win32" && (s.mode & 0o022) !== 0)) return { ...result, installed:false, code:"unsafe_directory" };
    }
    try {
      const s = lstatSync(plan.target);
      if (s.isFile() && !s.isSymbolicLink() && s.size===Buffer.byteLength(plan.script) && (process.platform==="win32" || (s.mode&0o111)!==0) && readFileSync(plan.target,"utf8") === plan.script) return { ...result, installed:true, alreadyInstalled:true };
      return { ...result, installed:false, code:"existing_command" };
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    const fd = openSync(plan.target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o700);
    try { writeFileSync(fd, plan.script, "utf8"); fsyncSync(fd); fchmodSync(fd,0o755); }
    finally { closeSync(fd); }
    return { ...result, installed:true };
  } catch { return { ...result, installed:false, code:"install_failed" }; }
}

export function userCliInstallMain(args:string[], deps:{resourcesDir?:string;homeDir?:string;out?:(line:string)=>void;install?:typeof installUserCli}={}):number {
  const out=deps.out ?? console.log;
  if(args.length!==1 || args[0]!=="--install") {out(JSON.stringify({installed:false,code:"invalid_arguments",message:"请从应用设置中选择安装命令。"}));return 2;}
  try {
    const result=(deps.install ?? installUserCli)(deps.resourcesDir ?? fileURLToPath(new URL("../../../",import.meta.url)),deps.homeDir ?? homedir());
    out(JSON.stringify(result));return result.installed ? 0 : 1;
  } catch {out(JSON.stringify({installed:false,code:"install_failed",message:"没有完成命令安装，请检查应用位置和用户目录。"}));return 1;}
}
const direct=(()=>{try{return Boolean(process.argv[1]) && realpathSync(process.argv[1]!)===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}})();
if(direct)process.exitCode=userCliInstallMain(process.argv.slice(2));
