#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keychainSigningRequirement } from "../core/src/native-keychain.ts";
import { hasNonAdhocSignature, validateMachO, type MacArchitecture } from "../core/src/macos-package.ts";

export interface NativeInputs { architecture:MacArchitecture; menubarBinary:string; keychainHelper:string; output:string }
export type SignatureInspector = (command:string,args:string[])=>string;
/** Verifies already-built inputs. Never builds, signs, selects a new identity, or changes Keychain. */
export function prepareMacInputs(input:NativeInputs,deps:{platform?:NodeJS.Platform;inspect?:SignatureInspector}={}):void {
  if((deps.platform ?? process.platform)!=="darwin")throw new Error("Native attestation requires a Mac");
  const read=(path:string)=>{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.size>100*1024*1024)throw new Error("Invalid native input");return readFileSync(path);};
  const menu=read(input.menubarBinary),helper=read(input.keychainHelper);
  validateMachO(menu,input.architecture);validateMachO(helper,input.architecture);
  if(!hasNonAdhocSignature(helper))throw new Error("Keychain helper needs a stable signature");
  const inspect=deps.inspect ?? ((command,args)=>{try{return execFileSync(command,args,{encoding:"utf8",timeout:5000,maxBuffer:65536,stdio:["ignore","pipe","pipe"]});}catch{throw new Error("Native signature validation failed");}});
  // codesign --display writes its result to stderr, so the default display call captures both channels.
  let displayed:string;
  if(deps.inspect)displayed=inspect("/usr/bin/codesign",["--display","--requirements","-",input.keychainHelper]);
  else {
    const result=spawnSync("/usr/bin/codesign",["--display","--requirements","-",input.keychainHelper],{encoding:"utf8",timeout:5000,maxBuffer:65536});
    if(result.error||result.status!==0)throw new Error("Native signature display failed");displayed=result.stdout+result.stderr;
  }
  const requirement=keychainSigningRequirement(displayed);if(!requirement)throw new Error("Keychain designated identity is not stable");
  inspect("/usr/bin/codesign",["--verify","--strict","-R",requirement,input.keychainHelper]);
  const identity=/H"([a-f0-9]{40})"/i.exec(requirement)?.[1];if(!identity)throw new Error("Missing signing identity");
  const digest=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
  // Exact bytes were checked above. Re-read to reject a build output replaced during verification.
  if(!read(input.menubarBinary).equals(menu)||!read(input.keychainHelper).equals(helper))throw new Error("Native input changed during verification");
  writeFileSync(input.output,JSON.stringify({version:1,architecture:input.architecture,menubarSha256:digest(menu),keychain:{sha256:digest(helper),identifier:"com.easyswitch.keychain",signingIdentity:identity,stableSignatureChecked:true}},null,2)+"\n",{flag:"wx",mode:0o600});
}
const direct=(()=>{try{return Boolean(process.argv[1])&&realpathSync(process.argv[1]!)===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}})();
if(direct){
  const [architecture,menubarBinary,keychainHelper,output]=process.argv.slice(2);
  if(process.argv.includes("--help"))console.log("node scripts/prepare-macos-inputs.ts arm64|x64 MENUBAR_MACH_O STABLY_SIGNED_KEYCHAIN_MACH_O NEW_MANIFEST_JSON\nChecks existing signatures on a Mac; does not build or sign.");
  else try {if(!architecture||!menubarBinary||!keychainHelper||!output)throw new Error();prepareMacInputs({architecture:architecture as MacArchitecture,menubarBinary,keychainHelper,output});console.log("Native input hashes and the existing Keychain identity were verified.");}
  catch{console.error("Native input verification failed. Use matching Mac binaries and the existing stable Keychain signing identity.");process.exitCode=1;}
}
