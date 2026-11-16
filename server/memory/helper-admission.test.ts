// SPDX-License-Identifier: AGPL-3.0-or-later
// Test controller owner: scperf-p1. Production helper ticket consumer owner: scperf-p1.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { forgetExclusionAddon } from "../engine-exclusion.ts";
import { IoBudget } from "../io-budget.ts";
import { ioGrantSnapshot, registerBg, resetIoMeterForTest, withBgGrant } from "../io-meter.ts";
import { DatabaseSync } from "../sqlite-open.ts";
import { isBgDeferred } from "../bg-admission.ts";
import { MemoryIndex, type IndexedMemory } from "./index.ts";
import { configureHelperAdmission, acceptHelperTicket, helperAdmissionTestHooks, withHelperGrant } from "./helper-admission.ts";
import { walTestHooks, indexStepFrames, runtimeStepWalBytes, type WalKind } from "./index-wal.ts";
const root = mkdtempSync(join(tmpdir(), "helper-admission-"));
const prior = process.env.MURAGE_ENGINE_EXCLUSION_PATH;
let serial = 0;
beforeAll(() => {
 const binary = join(root, "meter.node");
 execFileSync("cc", ["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",binary], {stdio:"pipe"});
 process.env.MURAGE_ENGINE_EXCLUSION_PATH = binary;forgetExclusionAddon();resetIoMeterForTest();
});
afterEach(() => { delete helperAdmissionTestHooks.capBytes;configureHelperAdmission(undefined);for(const key of Object.keys(walTestHooks))delete (walTestHooks as Record<string,unknown>)[key]; });
afterAll(() => { if(prior===undefined)delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;else process.env.MURAGE_ENGINE_EXCLUSION_PATH=prior;forgetExclusionAddon();resetIoMeterForTest();rmSync(root,{recursive:true,force:true}); });
const MiB=1024*1024;
it("a smaller adaptive offer holds the original write until it replans inside the offered pool",()=>{
 const db=new DatabaseSync(join(root,`replan-${++serial}.db`));
 expect(registerBg(db)).toBe(true);
 let entered=0,requests=0;
 configureHelperAdmission({
  request:(_ceiling,replan)=>{
   expect(replan).toBe(true);requests++;
   acceptHelperTicket({id:"replanned-permit",bytes:8*MiB,stepBytes:8*MiB,expiresAt:Date.now()+60000});
  },
  settle:()=>{},
 });
 const write=()=>{entered++;db.exec("CREATE TABLE accepted(value); INSERT INTO accepted VALUES(1)");};
 try{
  expect(()=>withHelperGrant(MiB,write,db,11*MiB,true)).toThrow("BG_DEFERRED");
  expect(entered).toBe(0);expect(requests).toBe(1);
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='accepted'").get()).toBeUndefined();
  withHelperGrant(MiB,write,db,MiB,true);
  expect(entered).toBe(1);expect(requests).toBe(1);
  expect(db.prepare("SELECT count(*) n FROM accepted").get()?.n).toBe(1);
  expect(ioGrantSnapshot().usedBytes).toBeGreaterThan(0);
  expect(ioGrantSnapshot().usedBytes).toBeLessThanOrEqual(MiB);
 }finally{db.close();}
});
const record=(n:number,bytes=200):IndexedMemory=>({id:`record-${n}`,version:1,scopeId:"fixture-scope",text:`fixture alpha ${n} `+"x".repeat(bytes),deleted:false});
function controller(stepBytes?:number) {
 let at=0, sequence=0;
 const budget=new IoBudget({read:()=>({at,fsWriteBlocks:0,cpuMicros:0}),log:()=>{}});
 const tickets=new Map<string,NonNullable<ReturnType<IoBudget["admit"]>>>();
 const charges:Array<{ceiling:number;used:number;minute:number}>=[];
 const admit=(ceiling:number)=>{
  let ticket=budget.admit("BG",ceiling);
  if(!ticket){at=(Math.floor(at/60000)+1)*60000;ticket=budget.admit("BG",ceiling);}
  expect(ticket,"T9 every step fits one active minute").not.toBeNull();
  return ticket!;
 };
 configureHelperAdmission({
  request:ceiling=>{const ticket=admit(ceiling),id=`permit-${++sequence}`;tickets.set(id,ticket);acceptHelperTicket({...ticket,id,...stepBytes!==undefined&&ticket.bytes>=stepBytes?{stepBytes}:{}});},
  settle:(receipt,used)=>{
   const ticket=tickets.get(receipt.id)!;
   expect(used,"T5 helper charge never exceeds its grant").toBeLessThanOrEqual(ticket.bytes);
   budget.settle(ticket,used);tickets.delete(receipt.id);charges.push({ceiling:ticket.bytes,used,minute:ticket.minute});
   const state=budget.admissionState();expect(state.bg+state.debt+state.reserved,"T5 per-minute BG bound").toBeLessThanOrEqual(12*MiB);
  },
 });
 const open=(file:string)=>{
  const boot=admit(MiB);
  const index=withBgGrant(boot,()=>new MemoryIndex(file,{charge:async()=>true}));
  budget.settle(boot,ioGrantSnapshot().usedBytes);
  return index;
 };
 return {open,charges,budget};
}
async function resume(work:()=>Promise<unknown>,done:()=>boolean,limit=20000) {
 for(let n=0;n<limit;n++){
  const misses=ioGrantSnapshot().ceilingMiss;
  try{await work();}catch(error){if(!isBgDeferred(error))expect(error,"T8 admitted operation never escapes as an unadmitted write").toBeUndefined();}
  expect(ioGrantSnapshot().ceilingMiss,"T4c admitted checkpoint and write ceilings never refuse").toBe(misses);
  if(done())return;
  await new Promise<void>(resolve=>setImmediate(resolve));
 }
 throw new Error("FIXTURE_ADMISSION_DID_NOT_DRAIN");
}
it("T8 admitted open, group, fill, deletion scrub and split merge keep every byte inside grants",async()=>{
 const ctl=controller(),file=join(root,`index-${++serial}.db`),index=ctl.open(file),before=ioGrantSnapshot();
 try{
  await resume(()=>index.init(),()=>index.opened());
  const rows=Array.from({length:200},(_,n)=>record(n,2048));
  let done=false,pending=rows;
  await resume(async()=>{const result=await index.applyBatch(pending);done=result.status==="done";if(result.status==="failed")pending=pending.slice(result.committed);if(!done)await index.maintenanceStep();},()=>done);
  expect(index.search("alpha",rows.map(r=>({id:r.id,version:r.version})),null,"fixture").hits.length,"T8 indexed rows readable").toBeGreaterThan(0);
  const deleted=rows.slice(0,8).map(row=>({...row,text:"",deleted:true}));done=false;pending=deleted;
  await resume(async()=>{const result=await index.applyBatch(pending);done=result.status==="done";if(result.status==="failed")pending=pending.slice(result.committed);if(!done)await index.maintenanceStep();},()=>done);
  await resume(()=>index.scrubDeleted(),()=>!index.deletionScrubPending());
  expect(index.search("alpha",deleted.map(r=>({id:r.id,version:r.version})),null,"fixture").hits,"T8 deleted records remain absent").toEqual([]);
  expect(ctl.charges.length,"T8 multiple separately admitted steps").toBeGreaterThan(5);
  expect(ioGrantSnapshot().refusedWrites,"T4c normal helper steps have zero refusals").toBe(before.refusedWrites);
  expect(ioGrantSnapshot().ceilingMiss,"T4c normal helper ceilings do not miss").toBe(before.ceilingMiss);
 }finally{index.close();}
});
it("T4 refused index commit stays pending, spends no header retry, never exits, then replays",async()=>{
 const ctl=controller(),index=ctl.open(join(root,`refused-${++serial}.db`));let exits=0;
 walTestHooks.exit=()=>{exits++;throw new Error("UNEXPECTED_EXIT");};
 try{
  await resume(()=>index.init(),()=>index.opened());
  const before=ioGrantSnapshot();helperAdmissionTestHooks.capBytes=4096;
  const row=record(500,2048);let result:Awaited<ReturnType<MemoryIndex["applyBatch"]>>|undefined;
  for(let n=0;n<20;n++){result=await index.applyBatch([row]);if(ioGrantSnapshot().refusedWrites>before.refusedWrites)break;}
  expect(result,"T4 job remains pending").toMatchObject({status:"failed",committed:0});
  expect(ioGrantSnapshot().refusedWrites,"T4 real cap refusal").toBeGreaterThan(before.refusedWrites);
  expect(index.writerStopped(),"T4 refusal is not damage").toBe(false);
  expect(index.writerCheckOwed(),"T4 no header retry owed").toBe(false);
  expect(exits,"T4 no exitNow").toBe(0);
  delete helperAdmissionTestHooks.capBytes;
  let done=false;await resume(async()=>{done=(await index.applyBatch([row])).status==="done";if(!done)await index.maintenanceStep();},()=>done);
  expect(index.search("alpha",[{id:row.id,version:1}],null,"fixture").hits.map(r=>r.id),"T4 connection and publication recover").toEqual([row.id]);
 }finally{index.close();}
});
it("T18 14 MiB legacy backlog is quarantined and rebuilt from authoritative records in admitted steps",async()=>{
 const file=join(root,`legacy-${++serial}.db`),rows=[record(700),record(701),record(702)];
 const entry=resolve("server/memory/index.ts");
 execFileSync(process.execPath,["--experimental-strip-types","--input-type=module","-e",`
  import {MemoryIndex} from ${JSON.stringify(entry)};
  const index=await MemoryIndex.create(${JSON.stringify(file)},{charge:async()=>true});
  await index.applyBatch(${JSON.stringify(rows)});
  index.db.exec("PRAGMA wal_autocheckpoint=0; CREATE TABLE legacy_tail(v); INSERT INTO legacy_tail VALUES(zeroblob(14680064))");
  process.exit(0);
 `],{env:{...process.env,MURAGE_BG_BOOT:""},stdio:"pipe"});
 const reader=new DatabaseSync(file,{readOnly:true});
 const beforeRows=reader.prepare("SELECT id,version,text FROM entries ORDER BY id").all();reader.close();
 const ctl=controller(),before=ioGrantSnapshot(),index=ctl.open(file);
 try{
  expect(index.rebuilt,"T18 oversized backlog quarantined before a checkpoint").toBe(true);
  expect(readdirSync(root).some(name=>name.includes(".corrupt-")),"T18 legacy set isolated").toBe(true);
  await resume(()=>index.init(),()=>index.opened());
  let done=false;await resume(async()=>{done=(await index.applyBatch(rows)).status==="done";if(!done)await index.maintenanceStep();},()=>done);
  const actual=new DatabaseSync(file,{readOnly:true});
  try{expect(actual.prepare("SELECT id,version,text FROM entries ORDER BY id").all(),"T18 source replay preserves reads").toEqual(beforeRows);}finally{actual.close();}
  expect(ioGrantSnapshot().ceilingMiss,"T18 no oversized checkpoint or boot cap miss").toBe(before.ceilingMiss);
 }finally{index.close();}
});

it("T18 debt at 8 MiB gives PASSIVE priority over another step and drains within two minutes",async()=>{
 const ctl=controller(),index=ctl.open(join(root,`debt-${++serial}.db`));
 await resume(()=>index.init(),()=>index.opened());
 const core=(index as unknown as {core:{shm:()=>{mxFrame:number;nBackfill:number;salt:string}|null;admit(kind:string,reserve:number):boolean;sealAndTruncate():Promise<{truncated:boolean}>}}).core;
 const original=core.shm,state={mxFrame:2048,nBackfill:0,salt:"fixture"};core.shm=()=>state;
 const modes:string[]=[];
 walTestHooks.checkpoint=(db,mode)=>{
  modes.push(mode);const r=db.prepare(`PRAGMA wal_checkpoint(${mode})`).get()!;
  state.nBackfill=state.mxFrame;return {busy:r.busy,log:r.log,checkpointed:r.checkpointed};
 };
 try{
  expect(core.admit("group",4120),"T18 step cannot pass debt limit").toBe(false);
  let truncated=false;
  await resume(async()=>{truncated=(await core.sealAndTruncate()).truncated;},()=>truncated);
  expect(modes[0],"T18 next admitted operation is whole PASSIVE").toBe("PASSIVE");
  expect(state.nBackfill,"T18 debt drains").toBe(state.mxFrame);
  expect(ctl.charges.every(c=>c.minute<=1),"T18 drains in at most two active minutes").toBe(true);
 }finally{core.shm=original;index.close();}
});

it.each([ ["recovery","open"],["postings fill","fill"],["postings settle","delete"],["age fill","fill"],["age sweep","keys"],["purge","delete"],["index batch","group"],["merge","merge"] ] as const)("T8 %s WAL boundary admits before writing",async(_path,kind)=>{
 const ctl=controller(),index=ctl.open(join(root,`boundary-${++serial}.db`));
 await resume(()=>index.init(),()=>index.opened());
 const core=(index as unknown as {core:{write<T>(kind:WalKind,reserve:number,fn:(put:(key:string,value:string)=>void)=>T):T;check():Promise<void>;checkOwed():boolean}}).core;
 let done=false;
 try{
  await resume(async()=>{core.write(kind,runtimeStepWalBytes(),put=>put("entries_live","0"));await core.check();done=!core.checkOwed();},()=>done);
  expect(done,"T8 admitted path completes its checked transaction").toBe(true);
 }finally{index.close();}
});

it.each([8,9,10])("A3 a real helper consumes an explicitly planned %i MiB step budget",async(roomMiB)=>{
 const room=roomMiB*MiB,ctl=controller(room),index=ctl.open(join(root,`remaining-${++serial}.db`)),before=ioGrantSnapshot();
 try{
  await resume(()=>index.init(),()=>index.opened());
  let pending=Array.from({length:48},(_,n)=>record(n,2048)),done=false;
  await resume(async()=>{const result=await index.applyBatch(pending);done=result.status==="done";if(result.status==="failed")pending=pending.slice(result.committed);if(!done)await index.maintenanceStep();},()=>done);
  expect(runtimeStepWalBytes()/4120,"A3 helper consumes issuer step planning room").toBe(indexStepFrames(4096,ioGrantSnapshot().pageSize,room));
  expect(ioGrantSnapshot().ceilingMiss,"A3 smaller real steps do not miss their ceiling").toBe(before.ceilingMiss);
  expect(ioGrantSnapshot().refusedWrites,"A3 smaller real steps are not refused").toBe(before.refusedWrites);
 }finally{index.close();}
});
