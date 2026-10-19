import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { gunzipSync } from "node:zlib";

export type MacArchitecture = "arm64" | "x64";
export interface NodeRuntimeLock { version:string; platform:"darwin"; archives:Record<MacArchitecture,{filename:string;url:string;sha256:string}> }
export const PINNED_NODE_RUNTIME: NodeRuntimeLock = JSON.parse(readFileSync(new URL("../../packaging/node-runtime.json", import.meta.url),"utf8"));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const xml = (value: string) => value.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"})[c]!);
const regular = (path: string, max: number): Buffer => { const s=lstatSync(path);if(!s.isFile() || s.isSymbolicLink() || s.size>max)throw new Error("Expected a bounded regular input file");return readFileSync(path); };

export function validateMachO(bytes: Buffer, arch: MacArchitecture): void {
  if(bytes.length<32 || bytes.readUInt32LE(0)!==0xfeedfacf || bytes.readUInt32LE(4)!==(arch==="arm64" ? 0x0100000c : 0x01000007) || bytes.readUInt32LE(12)!==2)throw new Error("Native input must be a thin 64-bit Mach-O executable for the selected architecture");
  const count=bytes.readUInt32LE(16),end=32+bytes.readUInt32LE(20);let at=32,entry=false;
  if(count>4096 || end>bytes.length)throw new Error("Invalid Mach-O command table");
  for(let i=0;i<count;i++){if(at+8>end)throw new Error("Invalid Mach-O command table");const command=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+4);if(size<8||at+size>end)throw new Error("Invalid Mach-O command table");if(command===0x80000028 || command===5)entry=true;at+=size;}
  if(!entry || at!==end)throw new Error("Native executable has no valid entrypoint table");
}
/** Structural check only. A Mac-generated exact-hash attestation and runtime codesign verification remain required. */
export function hasNonAdhocSignature(bytes: Buffer): boolean {
  if(bytes.length<32)return false;const count=bytes.readUInt32LE(16),length=bytes.readUInt32LE(20);if(count>1024 || 32+length>bytes.length)return false;
  let at=32;
  for(let n=0;n<count;n++){
    if(at+8>32+length)return false;const command=bytes.readUInt32LE(at),size=bytes.readUInt32LE(at+4);if(size<8 || at+size>32+length)return false;
    if(command===0x1d){
      if(size<16)return false;const offset=bytes.readUInt32LE(at+8),sizeOfSignature=bytes.readUInt32LE(at+12);
      if(offset+sizeOfSignature>bytes.length || sizeOfSignature<12)return false;
      const blob=bytes.subarray(offset,offset+sizeOfSignature);if(blob.readUInt32BE(0)!==0xfade0cc0)return false;
      const total=blob.readUInt32BE(4),slots=blob.readUInt32BE(8);if(total>blob.length || slots>64 || 12+slots*8>total)return false;
      let directory=false,cms=false;
      for(let i=0;i<slots;i++){
        const kind=blob.readUInt32BE(12+i*8),start=blob.readUInt32BE(16+i*8);if(start+8>total)return false;
        const magic=blob.readUInt32BE(start),end=start+blob.readUInt32BE(start+4);if(end>total || end<=start+8)return false;
        if(kind===0 && magic===0xfade0c02){if(start+16>end || (blob.readUInt32BE(start+12)&2)!==0)return false;directory=true;}
        if(kind===0x10000 && magic===0xfade0b01)cms=true;
      }
      return directory && cms;
    }
    at+=size;
  }
  return false;
}

/** Read just Node and its complete LICENSE. Never extract archive links, scripts, npm or arbitrary paths. */
export function runtimeFromArchive(archive: Buffer, arch: MacArchitecture, lock: NodeRuntimeLock=PINNED_NODE_RUNTIME): {node:Buffer;license:Buffer} {
  if(archive.length>128*1024*1024 || sha(archive)!==lock.archives[arch].sha256)throw new Error("Node archive does not match the pinned SHA-256");
  const tar=gunzipSync(archive,{maxOutputLength:512*1024*1024});
  const prefix=`node-v${lock.version}-darwin-${arch}/`;const wanted=new Map<string,Buffer>();
  for(let at=0;at+512<=tar.length;){
    const header=tar.subarray(at,at+512);if(header.every(byte=>byte===0))break;
    const field=(start:number,len:number)=>header.subarray(start,start+len).toString("utf8").replace(/\0.*$/s,"");
    const name=(field(345,155) ? field(345,155)+"/" : "")+field(0,100);
    const sizeText=field(124,12).trim();if(!/^[0-7]+$/.test(sizeText))throw new Error("Invalid runtime archive size");
    const size=parseInt(sizeText,8);if(at+512+size>tar.length)throw new Error("Truncated runtime archive");
    const expected=parseInt(field(148,8).trim(),8);let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156 ? 32 : header[i]!;
    if(sum!==expected)throw new Error("Invalid runtime archive checksum");
    if(name===prefix+"bin/node" || name===prefix+"LICENSE"){
      const type=field(156,1);if(type!=="0" && type!=="")throw new Error("Runtime inputs cannot be links");
      if(wanted.has(name))throw new Error("Duplicate runtime archive entry");wanted.set(name,Buffer.from(tar.subarray(at+512,at+512+size)));
    }
    at+=512+Math.ceil(size/512)*512;
  }
  const node=wanted.get(prefix+"bin/node"),license=wanted.get(prefix+"LICENSE");
  if(!node || !license?.length)throw new Error("Pinned runtime archive lacks Node or its license");validateMachO(node,arch);return {node,license};
}

export interface MacPackageOptions {
  sourceRoot:string; outputDir:string; architecture:MacArchitecture; nodeArchive:string;
  menubarBinary:string; keychainHelper:string; nativeManifest:string;
}
export interface MacPackageResult { appPath:string; archivePath:string; version:string; nodeVersion:string; fixtureOnly:boolean }
export interface MacPackageTestInputs { fixtureOnly:true; runtimeLock:NodeRuntimeLock }

/** Resolve existing ancestors before comparing paths that may not have been created yet. */
function canonicalTarget(path:string):string {
  let ancestor=resolve(path);const missing:string[]=[];
  for(;;){
    try { lstatSync(ancestor); }
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT" || dirname(ancestor)===ancestor)throw error;
      missing.unshift(basename(ancestor));ancestor=dirname(ancestor);continue;
    }
    // A dangling link must fail closed, rather than being treated as a missing directory.
    return resolve(realpathSync(ancestor),...missing);
  }
}

/** Native artifacts are supplied, not compiled/executed/downloaded/signed by this builder. */
export function packageMacApp(options: MacPackageOptions, fixture?: MacPackageTestInputs): MacPackageResult {
  const root=realpathSync(options.sourceRoot),output=canonicalTarget(options.outputDir),arch=options.architecture;
  if(arch!=="arm64" && arch!=="x64")throw new Error("Select arm64 or x64");
  const payloadRoots=["core/src","web","bin","menubar/Resources","third_party"].map(path=>canonicalTarget(join(root,path)));
  if(payloadRoots.some(path=>output===path || output.startsWith(path+sep)))throw new Error("Output cannot be inside the copied payload");
  const lock=fixture?.runtimeLock ?? PINNED_NODE_RUNTIME;
  if(!/^\d+\.\d+\.\d+$/.test(lock.version) || lock.platform!=="darwin")throw new Error("Invalid runtime lock");
  const pkg=JSON.parse(regular(join(root,"package.json"),64*1024).toString("utf8"));
  if(!/^\d+\.\d+\.\d+$/.test(pkg.version))throw new Error("Invalid application version");
  const runtime=runtimeFromArchive(regular(options.nodeArchive,128*1024*1024),arch,lock);
  const menubar=regular(options.menubarBinary,100*1024*1024),helper=regular(options.keychainHelper,100*1024*1024);
  validateMachO(menubar,arch);validateMachO(helper,arch);
  const native=JSON.parse(regular(options.nativeManifest,64*1024).toString("utf8"));
  if(native.version!==1 || native.architecture!==arch || native.menubarSha256!==sha(menubar) || native.keychain?.sha256!==sha(helper)
    || native.keychain.identifier!=="com.easyswitch.keychain" || native.keychain.stableSignatureChecked!==true || !/^[a-f0-9]{40}$/i.test(native.keychain.signingIdentity ?? ""))throw new Error("Native inputs need a matching Mac-generated stable-signature attestation");
  if(!fixture && !hasNonAdhocSignature(helper))throw new Error("Keychain helper is unsigned or ad-hoc; a stable signature is required");
  const appName=fixture ? "EasySwitch-STRUCTURE-ONLY.app" : "EasySwitch.app";
  const appPath=join(output,appName),archivePath=join(output,`EasySwitch-${pkg.version}-darwin-${arch}${fixture ? "-STRUCTURE-ONLY" : ""}.zip`);
  if(existsSync(appPath)||existsSync(archivePath))throw new Error("Output already exists; choose an empty build directory");
  mkdirSync(output,{recursive:true});mkdirSync(appPath);
  const resources=join(appPath,"Contents","Resources"),app=join(resources,"app");
  const put=(path:string,data:Buffer|string,mode=0o644)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,data,{flag:"wx",mode});};
  try {
    put(join(appPath,"Contents","MacOS","EasySwitch"),menubar,0o755);
    put(join(resources,"node","bin","node"),runtime.node,0o755);put(join(resources,"node","LICENSE"),runtime.license);
    const copyTree=(source:string,dest:string,allow:(name:string)=>boolean)=>{
      for(const name of readdirSync(source).sort()){
        if(name.startsWith("."))continue;
        const from=join(source,name),to=join(dest,name),s=lstatSync(from);if(s.isSymbolicLink())throw new Error("App source payload cannot contain symbolic links");
        if(s.isDirectory())copyTree(from,to,allow);else if(s.isFile()&&allow(name))put(to,regular(from,32*1024*1024));
      }
    };
    copyTree(join(root,"core","src"),join(app,"core","src"),name=>/\.(ts|json)$/.test(name));
    copyTree(join(root,"web"),join(app,"web"),name=>/\.(js|css|html|json|svg|png|ico)$/.test(name));
    for(const name of ["es.ts"])put(join(app,"bin",name),regular(join(root,"bin",name),1024*1024));
    put(join(app,"core","native","build","easyswitch-keychain"),helper,0o755);
    put(join(app,"package.json"),JSON.stringify({name:"easyswitch",version:pkg.version,type:"module",private:true}));
    put(join(app,"LICENSE"),regular(join(root,"LICENSE"),1024*1024));
    if(existsSync(join(root,"third_party")))copyTree(join(root,"third_party"),join(app,"third_party"),name=>/^(LICENSE|NOTICE)(\..*)?$/.test(name));
    for(const name of ["AppIcon.icns","MenubarOn.png","MenubarOn@2x.png","MenubarOff.png","MenubarOff@2x.png"])put(join(resources,name),regular(join(root,"menubar","Resources",name),16*1024*1024));
    for(const needed of ["core/src/main.ts","core/src/app-supervisor.ts","core/src/core-supervisor.ts","web/index.html","web/errors.js"])if(!existsSync(join(app,needed)))throw new Error("Application payload is incomplete");
    const metadata={version:1,applicationVersion:pkg.version,architecture:arch,nodeVersion:lock.version,nodeArchiveSha256:lock.archives[arch].sha256,nodeBinarySha256:sha(runtime.node),nativeInputs:{menubarSha256:native.menubarSha256,keychain:{sha256:native.keychain.sha256,identifier:"com.easyswitch.keychain",stableSignatureChecked:true,signingIdentity:native.keychain.signingIdentity}},fixtureOnly:Boolean(fixture),signed:false,notarized:false,loginItemDefault:false};
    put(join(resources,"runtime-manifest.json"),JSON.stringify(metadata,null,2)+"\n");
    const fields:Record<string,string>={CFBundleName:"EasySwitch",CFBundleDisplayName:fixture ? "EasySwitch STRUCTURE ONLY" : "EasySwitch",CFBundleIdentifier:"dev.easyswitch.menubar",CFBundleExecutable:"EasySwitch",CFBundleIconFile:"AppIcon",CFBundlePackageType:"APPL",CFBundleShortVersionString:pkg.version,CFBundleVersion:pkg.version,LSMinimumSystemVersion:"13.5",EasySwitchRuntime:"node/bin/node",EasySwitchCore:"app/core/src/main.ts",EasySwitchSupervisor:"app/core/src/app-supervisor.ts",EasySwitchCLI:"app/bin/es.ts",EasySwitchInstallCLI:"app/core/src/user-cli-install.ts",EasySwitchNodeVersion:lock.version,EasySwitchArchitecture:arch};
    put(join(appPath,"Contents","Info.plist"),`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(fields).map(([k,v])=>`<key>${k}</key><string>${xml(v)}</string>`).join("\n")}\n<key>LSUIElement</key><true/><key>EasySwitchLoginItemDefault</key><false/><key>EasySwitchFixtureOnly</key><${fixture ? "true" : "false"}/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>\n</dict></plist>\n`);
    if(fixture)put(join(resources,"STRUCTURE-ONLY.txt"),"Synthetic test inputs. Not a runnable, signed or distributable application.\n");
    writeFileSync(archivePath,zipTree(appPath),{flag:"wx"});
    return {appPath,archivePath,version:pkg.version,nodeVersion:lock.version,fixtureOnly:Boolean(fixture)};
  } catch(error){rmSync(appPath,{recursive:true,force:true});throw error;}
}

const CRC_TABLE=Array.from({length:256},(_,n)=>{let crc=n;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);return crc>>>0;});
function crc32(bytes:Buffer):number {let crc=0xffffffff;for(const b of bytes)crc=(crc>>>8)^CRC_TABLE[(crc^b)&255]!;return (crc^0xffffffff)>>>0;}
/** Deterministic ZIP_STORE archive: no platform zip executable and no permission-losing shell copy. */
function zipTree(root:string):Buffer {
  const locals:Buffer[]=[],central:Buffer[]=[];let offset=0,count=0;
  const walk=(dir:string)=>{for(const name of readdirSync(dir).sort()){
    const path=join(dir,name),s=lstatSync(path);if(s.isDirectory()){walk(path);continue;}
    if(!s.isFile()||s.isSymbolicLink())throw new Error("Unsupported bundle archive entry");
    const data=readFileSync(path),entry=Buffer.from((basename(root)+"/"+relative(root,path)).split(sep).join("/")),crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(33,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(entry.length,26);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(0x314,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x800,8);record.writeUInt16LE(33,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(entry.length,28);record.writeUInt32LE(((s.mode&0xffff)<<16)>>>0,38);record.writeUInt32LE(offset,42);
    locals.push(local,entry,data);central.push(record,entry);offset+=local.length+entry.length+data.length;count++;
  }};
  walk(root);const directory=Buffer.concat(central);if(count>65535 || offset+directory.length>0xffffffff)throw new Error("Bundle exceeds simple ZIP limits");
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}
