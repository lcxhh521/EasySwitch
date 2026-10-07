import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { installUserCli, userCliInstallPlan, userCliInstallMain } from "../src/user-cli-install.ts";

function fixture(t:{after(fn:()=>void):void}){const root=mkdtempSync(join(realpathSync(tmpdir()),"es-user-cli-"));t.after(()=>rmSync(root,{recursive:true,force:true}));const home=join(root,"home"),resources=join(root,"App's Space.app","Contents","Resources");mkdirSync(home);for(const path of [join(resources,"node","bin","node"),join(resources,"app","bin","es.ts")]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,"fake not executable content",{mode:0o755});}return {home,resources,root};}
test("explicit installation creates only a user wrapper using bundled Node and quotes spaces and apostrophes",t=>{
  const f=fixture(t);writeFileSync(join(f.home,".zshrc"),"unchanged");const result=installUserCli(f.resources,f.home);assert.equal(result.installed,true);
  const script=readFileSync(result.target,"utf8");assert.match(script,/# EasySwitch owned user command v1/);assert.match(script,/App'\\''s Space\.app/);assert.match(script,/"\$@"/);
  if(process.platform!=="win32")assert.equal(lstatSync(result.target).mode&0o777,0o755);
  assert.equal(readFileSync(join(f.home,".zshrc"),"utf8"),"unchanged");assert.equal(installUserCli(f.resources,f.home).alreadyInstalled,true);assert.match(result.fallbackCommand,/^alias es=/);
});
test("an existing command or symlink is never replaced",t=>{
  const f=fixture(t),plan=userCliInstallPlan(f.resources,f.home);mkdirSync(dirname(plan.target),{recursive:true});writeFileSync(plan.target,"foreign command");
  assert.equal(installUserCli(f.resources,f.home).code,"existing_command");assert.equal(readFileSync(plan.target,"utf8"),"foreign command");rmSync(plan.target);
  symlinkSync(join(f.root,"not-created"),plan.target);assert.equal(installUserCli(f.resources,f.home).code,"existing_command");assert.ok(!existsSync(join(f.root,"not-created")));
});
test("symlinked command directories and missing app payload give a fallback without writing outside home",t=>{
  const f=fixture(t);const outside=join(f.root,"outside");mkdirSync(outside);symlinkSync(outside,join(f.home,".local"));
  assert.equal(installUserCli(f.resources,f.home).code,"unsafe_directory");assert.ok(!existsSync(join(outside,"bin")));
  assert.equal(installUserCli(join(f.root,"missing-app"),f.home).code,"app_incomplete");
  assert.throws(()=>userCliInstallPlan("relative",f.home),/absolute/);assert.throws(()=>userCliInstallPlan(f.resources,f.home+"\n"),/absolute/);
});

test("installer entrypoint requires the exact explicit action and outputs only structured results",t=>{
  const f=fixture(t);const output:string[]=[];let calls=0;
  const deps={resourcesDir:f.resources,homeDir:f.home,out:(line:string)=>output.push(line),install:(resources:string,home:string)=>{calls++;return installUserCli(resources,home);}};
  for(const args of [[],["--help"],["--install","private-token"],["--path",f.root]])assert.equal(userCliInstallMain(args,deps),2);
  assert.equal(calls,0);assert.ok(!output.join("").includes("private-token"));
  assert.equal(userCliInstallMain(["--install"],deps),0);assert.equal(calls,1);assert.equal(JSON.parse(output.at(-1)!).installed,true);
  assert.equal(userCliInstallMain(["--install"],{...deps,install(){throw new Error("do not echo this secret");}}),1);
  assert.equal(JSON.parse(output.at(-1)!).code,"install_failed");assert.ok(!output.join("").includes("secret"));
});
