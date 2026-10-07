#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { packageMacApp, type MacArchitecture } from "../core/src/macos-package.ts";

export function packageArguments(args:string[]):Record<string,string> {
  const result:Record<string,string>={};const allowed=new Set(["--source","--output","--arch","--node-archive","--menubar","--keychain-helper","--native-manifest"]);
  for(let i=0;i<args.length;i+=2){const key=args[i]!,value=args[i+1];if(!allowed.has(key)||!value||value.startsWith("--")||result[key])throw new Error("Invalid package arguments");result[key]=value;}
  if([...allowed].some(k=>!result[k]))throw new Error("All package inputs must be explicit");return result;
}
const direct=(()=>{try{return Boolean(process.argv[1])&&realpathSync(process.argv[1]!)===realpathSync(fileURLToPath(import.meta.url));}catch{return false;}})();
if(direct){
  if(process.argv.includes("--help"))console.log("node scripts/package-macos.ts --source REPO --output EMPTY_DIR --arch arm64|x64 --node-archive OFFICIAL_PINNED_TAR_GZ --menubar MACH_O --keychain-helper STABLY_SIGNED_MACH_O --native-manifest MAC_VERIFIED_JSON\nNo download, compilation, execution, signing, notarization or installation is performed.");
  else try {
    const a=packageArguments(process.argv.slice(2));
    const result=packageMacApp({sourceRoot:a["--source"]!,outputDir:a["--output"]!,architecture:a["--arch"]! as MacArchitecture,nodeArchive:a["--node-archive"]!,menubarBinary:a["--menubar"]!,keychainHelper:a["--keychain-helper"]!,nativeManifest:a["--native-manifest"]!});
    console.log(`Assembled unsigned ${result.appPath}\nArchive: ${result.archivePath}\nMac signing, notarization and first-run acceptance are still required.`);
  }catch{console.error("Package preparation failed. Check the explicit input files, architecture, pinned archive and native signature attestation.");process.exitCode=1;}
}
