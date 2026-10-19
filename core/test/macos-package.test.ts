import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { test } from "node:test";
import { hasNonAdhocSignature, packageMacApp, PINNED_NODE_RUNTIME, runtimeFromArchive, validateMachO, type MacArchitecture, type NodeRuntimeLock } from "../src/macos-package.ts";
import { packageArguments } from "../../scripts/package-macos.ts";
import { prepareMacInputs } from "../../scripts/prepare-macos-inputs.ts";

const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
function macho(arch:MacArchitecture,signed=false,adhoc=false):Buffer {
  const b=Buffer.alloc(signed ? 128 : 56);b.writeUInt32LE(0xfeedfacf);b.writeUInt32LE(arch==="arm64" ? 0x0100000c : 0x01000007,4);b.writeUInt32LE(2,12);
  b.writeUInt32LE(signed ? 2 : 1,16);b.writeUInt32LE(signed ? 40 : 24,20);b.writeUInt32LE(0x80000028,32);b.writeUInt32LE(24,36);
  if(signed){b.writeUInt32LE(0x1d,56);b.writeUInt32LE(16,60);b.writeUInt32LE(72,64);b.writeUInt32LE(56,68);b.writeUInt32BE(0xfade0cc0,72);b.writeUInt32BE(56,76);b.writeUInt32BE(2,80);b.writeUInt32BE(0,84);b.writeUInt32BE(28,88);b.writeUInt32BE(0x10000,92);b.writeUInt32BE(44,96);b.writeUInt32BE(0xfade0c02,100);b.writeUInt32BE(16,104);b.writeUInt32BE(adhoc?2:0,112);b.writeUInt32BE(0xfade0b01,116);b.writeUInt32BE(12,120);b.write("FAKE",124);}
  return b;
}
function tar(entries:Array<{name:string;data:Buffer;type?:string}>):Buffer {
  const out:Buffer[]=[];for(const e of entries){const h=Buffer.alloc(512);h.write(e.name);h.write("0000755\0",100);h.write("0000000\0",108);h.write("0000000\0",116);h.write(e.data.length.toString(8).padStart(11,"0")+"\0",124);h.write("00000000000\0",136);h.fill(32,148,156);h.write(e.type ?? "0",156);h.write("ustar\0",257);h.write("00",263);let sum=0;for(const byte of h)sum+=byte;h.write(sum.toString(8).padStart(6,"0")+"\0 ",148);out.push(h,e.data,Buffer.alloc((512-e.data.length%512)%512));}return gzipSync(Buffer.concat([...out,Buffer.alloc(1024)]));
}
function fixture(t:{after(fn:()=>void):void},arch:MacArchitecture="arm64") {
  const root=mkdtempSync(join(realpathSync(tmpdir()),"es-package-"));t.after(()=>rmSync(root,{recursive:true,force:true}));const source=join(root,"source"),out=join(root,"out");
  const put=(name:string,content:string|Buffer)=>{const path=join(source,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);};
  put("package.json",JSON.stringify({version:"1.2.3",type:"module"}));put("LICENSE","Fixture project license");put("third_party/example/LICENSE","Fixture attribution");
  for(const name of ["core/src/main.ts","core/src/app-supervisor.ts","core/src/core-supervisor.ts","core/src/user-cli-install.ts","web/index.html","web/errors.js","bin/es.ts"])put(name,"// fixture only\n");
  put("core/src/.private.json","must not ship");put(".env","must not ship");put("core/test/private.test.ts","must not ship");
  for(const name of ["AppIcon.icns","MenubarOn.png","MenubarOn@2x.png","MenubarOff.png","MenubarOff@2x.png"])put(`menubar/Resources/${name}`,`unchanged icon fixture ${name}`);
  const prefix=`node-v24.21.0-darwin-${arch}/`;const archive=tar([{name:prefix+"bin/node",data:macho(arch)},{name:prefix+"LICENSE",data:Buffer.from("Complete fixture license\nThird party fixture notices\n")}]);
  const lock:NodeRuntimeLock=structuredClone(PINNED_NODE_RUNTIME);lock.archives[arch].sha256=digest(archive);
  const nodeArchive=join(root,"runtime.tar.gz"),menubarBinary=join(root,"menubar"),keychainHelper=join(root,"helper"),nativeManifest=join(root,"native.json");
  writeFileSync(nodeArchive,archive);writeFileSync(menubarBinary,macho(arch));writeFileSync(keychainHelper,macho(arch,true));
  const native={version:1,architecture:arch,menubarSha256:digest(macho(arch)),keychain:{sha256:digest(macho(arch,true)),identifier:"com.easyswitch.keychain",stableSignatureChecked:true,signingIdentity:"a".repeat(40)}};writeFileSync(nativeManifest,JSON.stringify(native));
  return {root,source,out,lock,archive,prefix,native,options:{sourceRoot:source,outputDir:out,architecture:arch,nodeArchive,menubarBinary,keychainHelper,nativeManifest}};
}
function zipEntries(bytes:Buffer):Map<string,Buffer>{const result=new Map<string,Buffer>();let at=0;while(bytes.readUInt32LE(at)===0x04034b50){assert.equal(bytes.readUInt16LE(at+8),0);const size=bytes.readUInt32LE(at+18),nameSize=bytes.readUInt16LE(at+26),extra=bytes.readUInt16LE(at+28),start=at+30+nameSize+extra;result.set(bytes.subarray(at+30,at+30+nameSize).toString(),bytes.subarray(start,start+size));at=start+size;}assert.equal(bytes.readUInt32LE(at),0x02014b50);assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);assert.equal(bytes.readUInt16LE(bytes.length-12),result.size);return result;}

test("runtime lock fixes official versions, both architectures and checksums",()=>{
  assert.equal(PINNED_NODE_RUNTIME.version,"24.21.0");assert.deepEqual(Object.keys(PINNED_NODE_RUNTIME.archives).sort(),["arm64","x64"]);
  for(const arch of ["arm64","x64"] as const){const item=PINNED_NODE_RUNTIME.archives[arch];assert.equal(item.url,`https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-${arch}.tar.gz`);assert.match(item.sha256,/^[a-f0-9]{64}$/);}
});
test("both synthetic architecture bundles contain relative paths, core, official icon bytes, license and deterministic ZIP",t=>{
  for(const arch of ["arm64","x64"] as const){const f=fixture(t,arch);const result=packageMacApp(f.options,{fixtureOnly:true,runtimeLock:f.lock});
    assert.equal(result.fixtureOnly,true);assert.match(result.appPath,/STRUCTURE-ONLY\.app$/);const resources=join(result.appPath,"Contents","Resources");
    const plist=readFileSync(join(result.appPath,"Contents","Info.plist"),"utf8");assert.match(plist,/<key>CFBundleShortVersionString<\/key><string>1\.2\.3<\/string>/);assert.match(plist,/<key>LSMinimumSystemVersion<\/key><string>13\.5<\/string>/);
    assert.match(plist,/<key>EasySwitchLoginItemDefault<\/key><false\/>/);assert.match(plist,/app\/core\/src\/app-supervisor\.ts/);assert.match(plist,/app\/core\/src\/user-cli-install\.ts/);assert.ok(!plist.includes(f.root));
    const metadata=JSON.parse(readFileSync(join(resources,"runtime-manifest.json"),"utf8"));assert.equal(metadata.nodeVersion,"24.21.0");assert.equal(metadata.nodeArchiveSha256,digest(f.archive));assert.equal(metadata.signed,false);assert.equal(metadata.notarized,false);
    assert.equal(readFileSync(join(resources,"AppIcon.icns"),"utf8"),"unchanged icon fixture AppIcon.icns");assert.match(readFileSync(join(resources,"node","LICENSE"),"utf8"),/Third party fixture notices/);
    const zipped=zipEntries(readFileSync(result.archivePath));assert.ok([...zipped.keys()].some(p=>p.endsWith("node/bin/node")));assert.ok([...zipped.keys()].some(p=>p.endsWith("app/core/src/main.ts")));assert.ok(![...zipped.keys()].some(p=>p.includes(".env")||p.includes(".private")||p.includes("core/test")));
    const again=packageMacApp({...f.options,outputDir:join(f.root,"out-again")},{fixtureOnly:true,runtimeLock:f.lock});assert.deepEqual(readFileSync(result.archivePath),readFileSync(again.archivePath));
    assert.throws(()=>packageMacApp(f.options,{fixtureOnly:true,runtimeLock:f.lock}),/already exists/);
  }
});
test("production refuses synthetic runtime and unsigned/ad-hoc helpers are not accepted as stable signatures",t=>{
  const f=fixture(t);assert.throws(()=>packageMacApp(f.options),/pinned SHA/);assert.equal(existsSync(f.out),false);
  assert.equal(hasNonAdhocSignature(macho("arm64")),false);assert.equal(hasNonAdhocSignature(macho("arm64",true,true)),false);assert.equal(hasNonAdhocSignature(macho("arm64",true)),true,"structural fixture only, not CMS verification");
  assert.throws(()=>validateMachO(macho("x64"),"arm64"),/selected architecture/);
});
test("archive hash, architecture, missing license and linked runtime inputs fail before output",t=>{
  const f=fixture(t);const changed=Buffer.from(f.archive);changed[changed.length-1]=changed[changed.length-1]!^1;assert.throws(()=>runtimeFromArchive(changed,"arm64",f.lock),/SHA/);
  for(const entries of [[{name:f.prefix+"bin/node",data:macho("arm64")}],[{name:f.prefix+"bin/node",data:macho("arm64"),type:"2"},{name:f.prefix+"LICENSE",data:Buffer.from("license")}],[{name:f.prefix+"bin/node",data:macho("x64")},{name:f.prefix+"LICENSE",data:Buffer.from("license")}]]){
    const bytes=tar(entries),lock=structuredClone(f.lock);lock.archives.arm64.sha256=digest(bytes);assert.throws(()=>runtimeFromArchive(bytes,"arm64",lock));
  }
});
test("native attestation is mandatory and source payload recursion is rejected",t=>{
  const f=fixture(t);f.native.keychain.stableSignatureChecked=false;writeFileSync(f.options.nativeManifest,JSON.stringify(f.native));
  assert.throws(()=>packageMacApp(f.options,{fixtureOnly:true,runtimeLock:f.lock}),/attestation/);assert.equal(existsSync(f.out),false);
  assert.throws(()=>packageMacApp({...f.options,outputDir:join(f.source,"web","output")},{fixtureOnly:true,runtimeLock:f.lock}),/copied payload/);
});
test("every copied payload root rejects nested output before creating any directory",t=>{
  const f=fixture(t);
  for(const tree of ["core/src","web","bin","menubar/Resources","third_party"]){
    const payload=join(f.source,tree),build=join(payload,"build");
    for(const outputDir of [payload,join(build,"new","output")])assert.throws(()=>packageMacApp({...f.options,outputDir},{fixtureOnly:true,runtimeLock:f.lock}),/copied payload/);
    assert.equal(existsSync(build),false);
  }
  // An optional tree must not become recursively copied just because output creation made it exist.
  rmSync(join(f.source,"third_party"),{recursive:true});
  assert.throws(()=>packageMacApp({...f.options,outputDir:join(f.source,"third_party","build")},{fixtureOnly:true,runtimeLock:f.lock}),/copied payload/);
  assert.equal(existsSync(join(f.source,"third_party")),false);
});
test("source and output symlink aliases cannot bypass copied payload rejection",t=>{
  const f=fixture(t),sourceAlias=join(f.root,"source-alias");symlinkSync(f.source,sourceAlias,"dir");
  for(const tree of ["core/src","web","bin","menubar/Resources","third_party"]){
    const payload=join(f.source,tree),alias=join(f.root,tree.replaceAll("/","-")+"-alias"),build=join(payload,"build");symlinkSync(payload,alias,"dir");
    for(const sourceRoot of [f.source,sourceAlias])for(const outputDir of [alias,join(alias,"build","new"),join(payload,"build","new")])assert.throws(()=>packageMacApp({...f.options,sourceRoot,outputDir},{fixtureOnly:true,runtimeLock:f.lock}),/copied payload/);
    assert.equal(existsSync(build),false);
  }
});
test("Mac attestation uses only injected signature inspection and never creates or changes identities",t=>{
  const f=fixture(t);const output=join(f.root,"verified.json"),calls:string[][]=[];
  assert.throws(()=>prepareMacInputs({...f.options,output},{platform:"linux",inspect(){assert.fail("no commands off Mac");}}),/requires a Mac/);
  prepareMacInputs({...f.options,output},{platform:"darwin",inspect(command,args){assert.equal(command,"/usr/bin/codesign");calls.push(args);return args.includes("--display") ? `designated => identifier "com.easyswitch.keychain" and certificate leaf = H"${"a".repeat(40)}"` : "";}});
  assert.equal(calls.length,2);assert.ok(calls.every(args=>!args.includes("--sign")));assert.equal(JSON.parse(readFileSync(output,"utf8")).keychain.stableSignatureChecked,true);
});
test("packaging command requires explicit native/runtime inputs and exposes no fixture bypass",()=>{
  assert.throws(()=>packageArguments(["--fixture","yes"]),/Invalid/);assert.throws(()=>packageArguments([]),/explicit/);
  const args=["--source","/s","--output","/o","--arch","arm64","--node-archive","/n","--menubar","/m","--keychain-helper","/h","--native-manifest","/v"];
  assert.equal(packageArguments(args)["--arch"],"arm64");assert.throws(()=>packageArguments([...args,"--arch","x64"]),/Invalid/);
});
