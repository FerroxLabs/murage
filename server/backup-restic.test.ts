import {fileURLToPath} from "node:url";
import { constants,copyFileSync,fstatSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,readSync,realpathSync,renameSync,symlinkSync,truncateSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,sep } from "node:path";
import { createHash,randomBytes,randomUUID } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import { safeWipeSync } from "./testing/safe-wipe.mjs";
import { BackupRestic,type ResticRunner } from "./backup-restic.ts";
vi.mock("node:fs",async importOriginal=>{const actual=await importOriginal<typeof import("node:fs")>();return {...actual,openSync:vi.fn(actual.openSync),readSync:vi.fn(actual.readSync),readFileSync:vi.fn(actual.readFileSync)};});
const actualFs=await vi.importActual<typeof import("node:fs")>("node:fs");
const roots:string[]=[];afterEach(()=>{vi.mocked(openSync).mockImplementation(actualFs.openSync);vi.mocked(readSync).mockImplementation(actualFs.readSync);vi.mocked(readFileSync).mockImplementation(actualFs.readFileSync);vi.clearAllMocks();for(const root of roots.splice(0))safeWipeSync(root);});
function fixture(runner?:ResticRunner,bytes=Buffer.from("age-encryption.org/v1\nSynthetic opaque storage fixture, not new crypto proof.\n")){const root=realpathSync.native(mkdtempSync(join(tmpdir(),"murage-restic-local-")));roots.push(root);const input=join(root,"synthetic.age");writeFileSync(input,bytes,{mode:0o600});const password=randomBytes(32).toString("hex");const receipt={jobId:"b".repeat(64),installationRef:"installation",destinationRef:"destination",selectionHash:"c".repeat(64),snapshotId:randomUUID(),artifactRef:"artifact",sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,verifiedAt:1};
 const options={executable:fileURLToPath(new URL("../dist-native/backup-restic/arm64/restic",import.meta.url)),repository:join(root,"repository"),workDirectory:join(root,"work"),password:async()=>Buffer.from(password),runner};return {root,input,bytes,password,receipt,options,adapter:new BackupRestic(options)};}
it.each([3,11,12,1])("non-success exit %s preserves input and never automatically uploads again",async code=>{
 const run=vi.fn<ResticRunner>(async()=>({code,stdout:JSON.stringify({message_type:"summary",snapshot_id:"d".repeat(64)})}));const f=fixture(run);
 expect((await f.adapter.store(f.input,f.receipt)).state).toBe("needs-review");await f.adapter.store(f.input,f.receipt);expect(run).toHaveBeenCalledTimes(1);expect(readFileSync(f.input)).toEqual(f.bytes);
 expect(run.mock.calls[0][0].args).not.toContain(f.password);expect(run.mock.calls[0][0].password.every(byte=>byte===0)).toBe(true);
 expect(run.mock.calls[0][0].args.some(arg=>["prune","forget","unlock","--stdin","--password-file"].includes(arg))).toBe(false);
});
it("unknown upload and mismatched snapshot never become verified",async()=>{
 const run=vi.fn<ResticRunner>().mockResolvedValueOnce({code:0,stdout:JSON.stringify({message_type:"summary",snapshot_id:"d".repeat(64)})}).mockResolvedValueOnce({code:0,stdout:JSON.stringify([{id:"e".repeat(64),tags:[],paths:[]}])});const f=fixture(run);expect(await f.adapter.store(f.input,f.receipt)).toMatchObject({state:"needs-review",error:"snapshot-mismatch"});expect(run).toHaveBeenCalledTimes(2);
});
it("an interrupted journal is retained for review rather than recaptured",async()=>{
 const run=vi.fn<ResticRunner>(async()=>({code:0,stdout:"",uncertain:true}));const f=fixture(run);await f.adapter.store(f.input,f.receipt);
 const journal=join(f.options.workDirectory,f.receipt.jobId+".json"),state=JSON.parse(readFileSync(journal,"utf8"));state.state="uploading";writeFileSync(journal,JSON.stringify(state));
 expect(await new BackupRestic(f.options).store(f.input,f.receipt)).toMatchObject({state:"needs-review",error:"upload-uncertain"});expect(run).toHaveBeenCalledTimes(1);
});
it("rejects changed archive and remote repository before any runner action",async()=>{
 const run=vi.fn<ResticRunner>();const f=fixture(run);writeFileSync(f.input,"changed");await expect(f.adapter.store(f.input,f.receipt)).rejects.toThrow("VERIFIED_ARCHIVE");expect(run).not.toHaveBeenCalled();expect(()=>new BackupRestic({...f.options,repository:"s3:private-bucket"})).toThrow("LOCAL_PATH");
});
it("refuses a repository and work directory that share a tree, however spelled",()=>{
 // Murage writes receipts, restic-target.json and mkdtemp'd restore trees into
 // workDirectory. Either nesting puts that scratch inside a live restic
 // repository, or the repository inside Murage's scratch. The old check
 // compared two resolve()d strings, so only the exact-equal case was caught.
 const f=fixture();const work=f.options.workDirectory;
 const overlapping=[
  {repository:join(work,"repo"),workDirectory:work},   // repository under the work directory
  {repository:f.root,workDirectory:work},              // work directory under the repository
  {repository:work,workDirectory:work},                // the same directory
  {repository:work+sep,workDirectory:work},            // ...spelled with a trailing separator
 ];
 for(const override of overlapping){
  expect(()=>new BackupRestic({...f.options,...override})).toThrow("SEPARATE_DIRECTORIES");
 }
 // A sibling whose name merely starts with the other's is a different tree and
 // must still be allowed, or a legitimate layout becomes unusable.
 expect(()=>new BackupRestic({...f.options,repository:work+"-repository",workDirectory:work})).not.toThrow();
 // A symlinked spelling of the work directory is the same tree; the old check
 // compared strings the JavaScript realpath never settled.
 mkdirSync(work,{recursive:true});
 const alias=join(f.root,"work-alias");symlinkSync(work,alias,process.platform==="win32"?"junction":"dir");
 expect(()=>new BackupRestic({...f.options,repository:join(alias,"repo"),workDirectory:work})).toThrow("SEPARATE_DIRECTORIES");
});
function restoredFixture(afterRestore?:(path:string)=>void){
 const id="d".repeat(64),bytes=Buffer.alloc(3*65536+17,37);let restoredPath="";
 const run=vi.fn<ResticRunner>(async({args,cwd})=>{
  if(args[4]==="backup")return{code:0,stdout:JSON.stringify({message_type:"summary",snapshot_id:id})};
  if(args[4]==="snapshots")return{code:0,stdout:JSON.stringify([{id,tags:[`murage-job:${"b".repeat(64)}`],paths:[join(cwd,"backup.age"),join(cwd,"receipt.json")]}])};
  if(args[4]==="restore"){const target=args[args.indexOf("--target")+1];restoredPath=join(target,"backup.age");copyFileSync(join(cwd,"backup.age"),restoredPath);copyFileSync(join(cwd,"receipt.json"),join(target,"receipt.json"));afterRestore?.(restoredPath);return{code:0,stdout:""};}
  throw Error("Unexpected synthetic operation");
 });
 const f=fixture(run,bytes);return{...f,run,restoredPath:()=>restoredPath};
}
function trackRestoredReads(onRead?:(path:string)=>void,onOpen?:(path:string)=>void){
 let fd=-1,path="",mutated=false;const reads:{length:number;buffer:unknown}[]=[];
 vi.mocked(openSync).mockImplementation((file,flags,mode)=>{
  const restored=typeof file==="string"&&file.includes("/restore-")&&file.endsWith("/backup.age");if(restored){path=file;onOpen?.(path);expect(Number(flags)&constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);}
  const opened=actualFs.openSync(file,flags,mode);if(restored)fd=opened;return opened;
 });
 vi.mocked(readSync).mockImplementation((...args:any[])=>{
  const length=Reflect.apply(actualFs.readSync,actualFs,args) as number;
  if(args[0]===fd){reads.push({length:args[3],buffer:args[1]});if(!mutated){mutated=true;onRead?.(path);}}
  return length;
 });
 vi.mocked(readFileSync).mockImplementation((...args:any[])=>{if(typeof args[0]==="string"&&args[0].includes("/restore-")&&args[0].endsWith("/backup.age"))throw Error("Whole restored archive read is forbidden");return Reflect.apply(actualFs.readFileSync,actualFs,args);});
 return{reads,fd:()=>fd};
}
it("restored archive hash uses one 64KiB buffer and bounded reads, never a whole-file read",async()=>{
 const f=restoredFixture(),tracked=trackRestoredReads();expect(await f.adapter.store(f.input,f.receipt)).toMatchObject({state:"verified"});expect(tracked.reads.map(read=>read.length)).toEqual([65536,65536,65536,17]);expect(new Set(tracked.reads.map(read=>read.buffer)).size).toBe(1);expect(()=>fstatSync(tracked.fd())).toThrow();expect(f.run).toHaveBeenCalledTimes(3);
});
it("restored short, oversized and wrong-digest data never becomes verified",async()=>{
 for(const mode of ["short","long","digest"]){const f=restoredFixture(path=>{if(mode==="digest")writeFileSync(path,Buffer.alloc(3*65536+17,38));else truncateSync(path,3*65536+17+(mode==="short"?-1:1));});expect(await f.adapter.store(f.input,f.receipt)).toMatchObject({state:"needs-review",error:mode==="digest"?"restore-mismatch":"operation-failed"});expect(readFileSync(f.input)).toEqual(f.bytes);}
});
it("held restored fd detects same-byte same-size mutation through identity timestamps",async()=>{
 const f=restoredFixture(),tracked=trackRestoredReads(path=>writeFileSync(path,f.bytes));expect(await f.adapter.store(f.input,f.receipt)).toMatchObject({state:"needs-review",error:"operation-failed"});expect(tracked.reads.length).toBeGreaterThan(0);expect(()=>fstatSync(tracked.fd())).toThrow();
});
it("held restored fd rejects pathname replacement after opening despite matching bytes",async()=>{
 const f=restoredFixture(),tracked=trackRestoredReads(path=>{renameSync(path,path+".held");writeFileSync(path,f.bytes);});expect(await f.adapter.store(f.input,f.receipt)).toMatchObject({state:"needs-review",error:"operation-failed"});expect(()=>fstatSync(tracked.fd())).toThrow();
});
it("restored open identity must match the pre-open path identity",async()=>{
 const f=restoredFixture(),tracked=trackRestoredReads(undefined,path=>{renameSync(path,path+".prior");writeFileSync(path,f.bytes);});expect(await f.adapter.store(f.input,f.receipt)).toMatchObject({state:"needs-review",error:"operation-failed"});expect(tracked.reads).toHaveLength(0);expect(()=>fstatSync(tracked.fd())).toThrow();
});
it.skipIf(process.platform!=="darwin"||process.arch!=="arm64")("real pinned restic uses private stdin and verifies exact local snapshot/restored bytes",async()=>{
 const f=fixture();try{
  expect(await f.adapter.initialize()).toEqual({initialized:true});const result=await f.adapter.store(f.input,f.receipt);expect(result,JSON.stringify(result)).toMatchObject({state:"verified",snapshotId:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(await f.adapter.store(f.input,f.receipt)).toEqual(result);expect(readFileSync(f.input)).toEqual(f.bytes);
  const journal=readFileSync(join(f.options.workDirectory,f.receipt.jobId+".json"),"utf8");expect(journal).not.toContain(f.password);
 }catch(error){
  roots.splice(roots.indexOf(f.root),1);
  writeFileSync(join(f.root,"safe-failure-tree.json"),JSON.stringify({files:readdirSync(f.root,{recursive:true}).filter(name=>typeof name==="string")},null,2),{mode:0o600});
  console.warn("Retained synthetic restic failure tree:",f.root);throw error;
 }
},60000);
