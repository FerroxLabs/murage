import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { z } from "zod";

export const GEPA_RESOURCE_DIRECTORY="gepa-worker";
export const GEPA_MANIFEST_NAME="manifest.json";
export const GEPA_RESOURCE_LICENSES=["licenses/GEPA-LICENSE.txt","licenses/Python-LICENSE.txt","licenses/THIRD-PARTY-NOTICES.txt"] as const;
export const GEPA_RESOURCE_TARGETS=["darwin-arm64","darwin-x64","win32-x64","linux-x64"] as const;
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const pathSchema=z.string().min(1).max(2048).refine(path=>!path.includes("\\")&&!path.includes("\0")&&!isAbsolute(path)&&!win32.isAbsolute(path)&&path.split("/").every(part=>part!==""&&part!=="."&&part!==".."&&!/[\x00-\x1f:*?"<>|]/.test(part)));
const inventoryEntry=z.discriminatedUnion("kind",[
  z.object({path:pathSchema,kind:z.literal("directory")}).strict(),
  z.object({path:pathSchema,kind:z.literal("symlink"),target:z.string().min(1).max(2048)}).strict(),
  z.object({path:pathSchema,kind:z.literal("file"),bytes:z.number().int().nonnegative().max(256*1024**2),sha256:digest,executable:z.boolean()}).strict(),
]);
export const gepaResourceManifestSchema=z.object({
  schema:z.literal(1),protocol:z.literal(1),target:z.enum(GEPA_RESOURCE_TARGETS),
  python:z.literal("3.13.15"),gepa:z.literal("0.1.4"),pyinstaller:z.literal("6.22.3"),
  pythonSourceSha256:z.literal("1e66a7945a48390ee4c2a4268a0e4185884059a13c4aab6d148aa208deea4a76"),
  gepaWheelSha256:z.literal("12b971039599625c156d2231f6d72a29c31a22e9c237689459b5f1a3c353f532"),
  workerSourceSha256:digest,buildLockSha256:digest,
  entrypoint:z.enum(["gepa-worker","gepa-worker.exe"]),files:z.array(inventoryEntry).min(1).max(5000),
}).strict();
export type GepaResourceManifest=z.infer<typeof gepaResourceManifestSchema>;
type InventoryEntry=z.infer<typeof inventoryEntry>;
const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const fail=(code="GEPA_RESOURCE_INVALID"):never=>{throw Error(code);};
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);};
const unchanged=(before:Stats,after:Stats)=>before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&before.nlink===after.nlink;
function observedFile(file:string,maximum:number,retain=false) {
  const before=lstatSync(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>maximum)fail();
  const fd=openSync(file,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
  try{
    if(!unchanged(before,fstatSync(fd)))fail();
    const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let offset=0;const header=Buffer.alloc(retain?before.size:Math.min(4096,before.size));
    for(;;){const count=readSync(fd,buffer,0,Math.min(buffer.length,maximum-offset+1),offset);if(!count)break;if(offset+count>maximum)fail("GEPA_RESOURCE_SIZE_LIMIT");if(offset<header.length)buffer.copy(header,offset,0,Math.min(count,header.length-offset));hash.update(buffer.subarray(0,count));offset+=count;}
    if(offset!==before.size||!unchanged(before,fstatSync(fd))||!unchanged(before,lstatSync(file)))fail("GEPA_RESOURCE_CHANGED");
    return {bytes:offset,sha256:hash.digest("hex"),executable:Boolean(before.mode&0o111),header};
  }finally{closeSync(fd);}
}
/** Pure, bounded inventory; symlinks are recorded but never traversed as directories. */
export function inventoryGepaBundle(directory:string):InventoryEntry[] {
  if(!isAbsolute(directory)||!lstatSync(directory).isDirectory()||lstatSync(directory).isSymbolicLink())fail();
  const root=realpathSync(directory),entries:InventoryEntry[]=[],names=new Set<string>();let bytes=0;
  const visit=(parent:string,prefix="",depth=0)=>{
    if(depth>32)fail("GEPA_RESOURCE_SIZE_LIMIT");const before=lstatSync(parent);
    for(const name of readdirSync(parent).sort()){
      const path=prefix?`${prefix}/${name}`:name;if(path===GEPA_MANIFEST_NAME)continue;
      pathSchema.parse(path);if(names.has(path.toLowerCase())||entries.length>=5000)fail();names.add(path.toLowerCase());
      const file=join(parent,name),stat=lstatSync(file);
      if(stat.isSymbolicLink()){
        const target=readlinkSync(file);
        if(target.includes("\0")||isAbsolute(target)||win32.isAbsolute(target)||!inside(root,resolve(parent,target))||!inside(root,realpathSync(file)))fail("GEPA_RESOURCE_SYMLINK_ESCAPE");
        if(!unchanged(stat,lstatSync(file))||readlinkSync(file)!==target)fail("GEPA_RESOURCE_CHANGED");
        entries.push({path,kind:"symlink",target});
      }else if(stat.isDirectory()){entries.push({path,kind:"directory"});visit(file,path,depth+1);}
      else if(stat.isFile()){
        const item=observedFile(file,256*1024**2);bytes+=item.bytes;if(bytes>512*1024**2)fail("GEPA_RESOURCE_SIZE_LIMIT");
        entries.push({path,kind:"file",bytes:item.bytes,sha256:item.sha256,executable:item.executable});
      }else fail();
    }
    if(!unchanged(before,lstatSync(parent)))fail("GEPA_RESOURCE_CHANGED");
  };
  visit(root);return entries;
}
function executableTarget(bytes:Buffer):string|null {
  if(bytes.length>=8&&bytes.readUInt32LE(0)===0xfeedfacf){if(bytes.readUInt32LE(4)===0x0100000c)return "darwin-arm64";if(bytes.readUInt32LE(4)===0x01000007)return "darwin-x64";}
  if(bytes.length>=20&&bytes.subarray(0,4).equals(Buffer.from([127,69,76,70]))&&bytes[4]===2&&bytes[5]===1&&bytes.readUInt16LE(18)===0x3e)return "linux-x64";
  if(bytes.length>=64&&bytes[0]===77&&bytes[1]===90){const offset=bytes.readUInt32LE(60);if(offset<=bytes.length-6&&bytes.subarray(offset,offset+4).equals(Buffer.from("PE\0\0"))&&bytes.readUInt16LE(offset+4)===0x8664)return "win32-x64";}
  return null;
}
/** expectedManifestSha256 comes from trusted host release metadata, never this directory. */
export function verifyGepaBundle(directory:string,target:string,expectedManifestSha256:string) {
  if(!GEPA_RESOURCE_TARGETS.some(value=>value===target))fail("GEPA_RESOURCE_TARGET_UNAVAILABLE");
  digest.parse(expectedManifestSha256);
  if(!isAbsolute(directory)||lstatSync(directory).isSymbolicLink()||!lstatSync(directory).isDirectory())fail();
  const root=realpathSync(directory),manifestFile=join(root,GEPA_MANIFEST_NAME);
  const observed=observedFile(manifestFile,1024*1024,true);
  if(observed.sha256!==expectedManifestSha256)fail("GEPA_RESOURCE_MANIFEST_MISMATCH");
  const raw=observed.header;if(sha(raw)!==observed.sha256)fail("GEPA_RESOURCE_CHANGED");
  const manifest=gepaResourceManifestSchema.parse(JSON.parse(raw.toString("utf8")));
  const name=target==="win32-x64"?"gepa-worker.exe":"gepa-worker";
  if(manifest.target!==target||manifest.entrypoint!==name)fail("GEPA_RESOURCE_TARGET_MISMATCH");
  const actual=inventoryGepaBundle(root);
  if(JSON.stringify(actual)!==JSON.stringify(manifest.files))fail("GEPA_RESOURCE_INVENTORY_MISMATCH");
  for(const license of GEPA_RESOURCE_LICENSES)if(!actual.some(item=>item.path===license&&item.kind==="file"&&item.bytes>0))fail("GEPA_RESOURCE_LICENSE_UNAVAILABLE");
  if(target==="win32-x64"&&actual.some(item=>item.path.toLowerCase().endsWith(".exe")&&item.path!==name))fail("GEPA_RESOURCE_EXECUTABLE_LAYOUT_INVALID");
  const executable=join(root,name),entry=actual.find(item=>item.path===name);
  if(!entry||entry.kind!=="file"||entry.bytes===0)throw Error("GEPA_RESOURCE_EXECUTABLE_INVALID");
  const binary=observedFile(executable,256*1024**2);
  if(binary.sha256!==entry.sha256||executableTarget(binary.header)!==target)fail("GEPA_RESOURCE_EXECUTABLE_INVALID");
  if(process.platform!=="win32"&&!binary.executable)fail("GEPA_RESOURCE_EXECUTABLE_INVALID");
  if(observedFile(manifestFile,1024*1024).sha256!==expectedManifestSha256)fail("GEPA_RESOURCE_CHANGED");
  return {executable,expectedPythonVersion:"3.13.15" as const,manifestSha256:expectedManifestSha256,manifest};
}
export type GepaResourceAdmission={available:true;executable:string;expectedPythonVersion:"3.13.15";manifestSha256:string}|{available:false;reason:string};
export function admitBundledGepa(host:{resourcesPath?:string;expectedManifestSha256?:string},platform:string=process.platform,arch:string=process.arch):GepaResourceAdmission {
  if(!host.resourcesPath||!isAbsolute(host.resourcesPath))return {available:false,reason:"GEPA_RESOURCE_UNAVAILABLE"};
  if(!host.expectedManifestSha256)return {available:false,reason:"GEPA_RESOURCE_UNPINNED"};
  try{
    if(lstatSync(host.resourcesPath).isSymbolicLink()||!lstatSync(host.resourcesPath).isDirectory())fail();
    const result=verifyGepaBundle(join(host.resourcesPath,GEPA_RESOURCE_DIRECTORY),`${platform}-${arch}`,host.expectedManifestSha256);
    return {available:true,executable:result.executable,expectedPythonVersion:result.expectedPythonVersion,manifestSha256:result.manifestSha256};
  }catch(error){return {available:false,reason:(error as NodeJS.ErrnoException).code==="ENOENT"?"GEPA_RESOURCE_UNAVAILABLE":error instanceof Error&&/^GEPA_RESOURCE_[A-Z_]+$/.test(error.message)?error.message:"GEPA_RESOURCE_INVALID"};}
}
