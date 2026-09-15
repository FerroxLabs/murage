import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { admitBundledGepa, GEPA_RESOURCE_LICENSES, GEPA_RESOURCE_TARGETS, inventoryGepaBundle, verifyGepaBundle, type GepaResourceManifest } from "./gepa-resource.ts";
import { validatePackagedGepa } from "../scripts/after-pack.mjs";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const sha=(bytes:string|Buffer)=>createHash("sha256").update(bytes).digest("hex");
function header(target:string){const bytes=Buffer.alloc(256);if(target.startsWith("darwin")){bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(target.endsWith("arm64")?0x0100000c:0x01000007,4);}else if(target==="linux-x64"){bytes.set([127,69,76,70,2,1]);bytes.writeUInt16LE(0x3e,18);}else{bytes.write("MZ");bytes.writeUInt32LE(64,60);bytes.write("PE\0\0",64);bytes.writeUInt16LE(0x8664,68);}return bytes;}
function fixture(target:typeof GEPA_RESOURCE_TARGETS[number]="darwin-arm64"){
  const resources=mkdtempSync(join(tmpdir(),"murage-gepa-resource-"));roots.push(resources);const directory=join(resources,"gepa-worker");mkdirSync(join(directory,"_internal"),{recursive:true});
  const entrypoint=target==="win32-x64"?"gepa-worker.exe":"gepa-worker";
  writeFileSync(join(directory,entrypoint),header(target),{mode:0o755});writeFileSync(join(directory,"_internal","python-runtime"),"synthetic runtime bytes");
  mkdirSync(join(directory,"licenses"));for(const file of GEPA_RESOURCE_LICENSES)writeFileSync(join(directory,file),"Synthetic license fixture; not production notices.");
  const manifest:GepaResourceManifest={schema:1,protocol:1,target,python:"3.13.15",gepa:"0.1.4",pyinstaller:"6.22.3",pythonSourceSha256:"1e66a7945a48390ee4c2a4268a0e4185884059a13c4aab6d148aa208deea4a76",gepaWheelSha256:"12b971039599625c156d2231f6d72a29c31a22e9c237689459b5f1a3c353f532",workerSourceSha256:"a".repeat(64),buildLockSha256:"b".repeat(64),entrypoint,files:inventoryGepaBundle(directory)};
  const stamp=()=>{const text=JSON.stringify(manifest);writeFileSync(join(directory,"manifest.json"),text);return sha(text);};
  return {resources,directory,manifest,stamp,hash:stamp()};
}
it.each(GEPA_RESOURCE_TARGETS)("admits exact %s header and full inventory (synthetic files only)",target=>{
  const f=fixture(target),[platform,arch]=target.split("-");expect(admitBundledGepa({resourcesPath:f.resources,expectedManifestSha256:f.hash},platform,arch)).toMatchObject({available:true,expectedPythonVersion:"3.13.15",manifestSha256:f.hash});
});
it("requires external manifest trust and refuses PATH/runtime fallback",()=>{
  expect(admitBundledGepa({})).toEqual({available:false,reason:"GEPA_RESOURCE_UNAVAILABLE"});const f=fixture();expect(admitBundledGepa({resourcesPath:f.resources})).toEqual({available:false,reason:"GEPA_RESOURCE_UNPINNED"});
  expect(admitBundledGepa({resourcesPath:f.resources,expectedManifestSha256:"c".repeat(64)},"darwin","arm64")).toEqual({available:false,reason:"GEPA_RESOURCE_MANIFEST_MISMATCH"});
});
it.each(["changed","missing","extra"])("refuses %s onedir resources",change=>{
  const f=fixture(),file=join(f.directory,"_internal","python-runtime");if(change==="changed")writeFileSync(file,"changed");else if(change==="missing")rmSync(file);else writeFileSync(join(f.directory,"extra"),"unexpected");
  expect(()=>verifyGepaBundle(f.directory,"darwin-arm64",f.hash)).toThrow("GEPA_RESOURCE_INVENTORY_MISMATCH");
});
it("preserves safe in-tree symlinks and rejects external symlink targets",()=>{
  const f=fixture();symlinkSync("_internal/python-runtime",join(f.directory,"runtime-link"));f.manifest.files=inventoryGepaBundle(f.directory);const trusted=f.stamp();expect(()=>verifyGepaBundle(f.directory,"darwin-arm64",trusted)).not.toThrow();
  rmSync(join(f.directory,"runtime-link"));writeFileSync(join(f.resources,"outside"),"outside");symlinkSync("../outside",join(f.directory,"runtime-link"));expect(()=>inventoryGepaBundle(f.directory)).toThrow("GEPA_RESOURCE_SYMLINK_ESCAPE");
});
it("refuses a symlinked bundle root, wrong native header, or unsupported target",()=>{
  const f=fixture();expect(()=>verifyGepaBundle(f.directory,"linux-arm64",f.hash)).toThrow("GEPA_RESOURCE_TARGET_UNAVAILABLE");
  writeFileSync(join(f.directory,"gepa-worker"),header("linux-x64"));f.manifest.files=inventoryGepaBundle(f.directory);expect(()=>verifyGepaBundle(f.directory,"darwin-arm64",f.stamp())).toThrow("GEPA_RESOURCE_EXECUTABLE_INVALID");
  const alias=join(f.resources,"alias");symlinkSync(f.directory,alias,process.platform==="win32"?"junction":"dir");expect(()=>verifyGepaBundle(alias,"darwin-arm64",f.hash)).toThrow("GEPA_RESOURCE_INVALID");
});
it("rejects development runtime metadata even under a trusted synthetic manifest hash",()=>{
  const f=fixture(),changed={...f.manifest,python:"3.13.13"};const raw=JSON.stringify(changed);writeFileSync(join(f.directory,"manifest.json"),raw);expect(()=>verifyGepaBundle(f.directory,"darwin-arm64",sha(raw))).toThrow();
});
it("rejects extra Windows executables that the directory copier might re-sign",()=>{
  const f=fixture("win32-x64");writeFileSync(join(f.directory,"_internal","other.exe"),header("win32-x64"));f.manifest.files=inventoryGepaBundle(f.directory);expect(()=>verifyGepaBundle(f.directory,"win32-x64",f.stamp())).toThrow("GEPA_RESOURCE_EXECUTABLE_LAYOUT_INVALID");
});
it.skipIf(process.platform==="win32")("requires the actual bundled executable bit",()=>{
  const f=fixture();chmodSync(join(f.directory,"gepa-worker"),0o644);f.manifest.files=inventoryGepaBundle(f.directory);expect(()=>verifyGepaBundle(f.directory,"darwin-arm64",f.stamp())).toThrow("GEPA_RESOURCE_EXECUTABLE_INVALID");
});
it("resource fixtures contain no real executable or runtime qualification evidence",()=>{
  const f=fixture();expect(readFileSync(join(f.directory,"gepa-worker")).length).toBe(256);
});
it("fails required packaging without a trusted build receipt and never stamps a replacement",()=>{
  const f=fixture();expect(()=>validatePackagedGepa(f.resources,{electronPlatformName:"darwin",arch:"arm64",packager:{config:{}}})).toThrow("GEPA_RESOURCE_BUILD_RECEIPT_REQUIRED");
  expect(()=>validatePackagedGepa(f.resources,{electronPlatformName:"darwin",arch:"arm64",packager:{config:{extraMetadata:{murageGepaManifests:{"darwin-arm64":f.hash}}}}})).not.toThrow();
  expect(sha(readFileSync(join(f.directory,"manifest.json")))).toBe(f.hash);
});
