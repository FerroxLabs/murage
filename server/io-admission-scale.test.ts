// SPDX-License-Identifier: AGPL-3.0-or-later
// Server/ledger owner: scperf-p1. Checked index writer owner: scperf-p1. Qualification runner owner: MAIN.
import {execFileSync} from "node:child_process";
import {mkdtempSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {beforeAll,afterAll,expect,it} from "vitest";
import {DATA_DIR} from "./config.ts";
import {database,closeDatabase,transaction} from "./database.ts";
import {forgetExclusionAddon} from "./engine-exclusion.ts";
import {ioGrantSnapshot,registerBg,resetIoMeterForTest} from "./io-meter.ts";
import {ioBudget} from "./io-budget.ts";
import {appendMessage,turnRows,TURN_ROWS_SQL} from "./message-db.ts";
import {prepareThreadSync} from "./branch-store.ts";
import {setMemoryMode} from "./memory/repository.ts";
import {captureScopeId} from "./memory/capture.ts";
import {claimMemoryJob,publishMemoryWork} from "./memory/jobs.ts";
import {captureWork} from "./memory/chunks.ts";
import {MemoryIndex,type IndexedMemory} from "./memory/index.ts";
import {configureHelperAdmission,acceptHelperTicket} from "./memory/helper-admission.ts";
import {isBgDeferred} from "./bg-admission.ts";
import {stopWalMaintenance} from "./wal-maintenance.ts";
import {stopSearchIndex} from "./message-search-index.ts";
import {removeTempDirSync} from "./testing/cleanup.ts";
const root=mkdtempSync(join(tmpdir(),"admission-scale-")),prior=process.env.MURAGE_ENGINE_EXCLUSION_PATH;
beforeAll(()=>{
 const binary=join(root,"meter.node");execFileSync("cc",["-std=c11","-D_GNU_SOURCE","-O2","-Wall","-Werror","-fPIC","-shared","-DNAPI_VERSION=9","-I",resolve(dirname(process.execPath),"../include/node"),"native/engine-exclusion/exclusion.c","native/engine-exclusion/meter.c","-o",binary],{stdio:"pipe"});
 process.env.MURAGE_ENGINE_EXCLUSION_PATH=binary;forgetExclusionAddon();resetIoMeterForTest();
});
afterAll(()=>{closeDatabase();if(prior===undefined)delete process.env.MURAGE_ENGINE_EXCLUSION_PATH;else process.env.MURAGE_ENGINE_EXCLUSION_PATH=prior;forgetExclusionAddon();resetIoMeterForTest();rmSync(root,{recursive:true,force:true});});
async function seedIndex(index:MemoryIndex,count:number){
 for(let from=0;from<count;from+=16){
  let rows=Array.from({length:Math.min(16,count-from)},(_,n)=>({id:`corpus-${String(from+n).padStart(6,"0")}`,version:1,scopeId:"fixture-scope",text:"fixture history alpha "+"x".repeat(180),deleted:false}));
  for(let tries=0;rows.length;tries++){
   expect(tries,"SCALE seed drains through bounded steps").toBeLessThan(1000);
   const r=await index.applyBatch(rows);if(r.status==="done")break;rows=rows.slice(r.committed);
   if(r.reason==="drain")await index.sealAndTruncate();else await index.maintenanceStep();
  }
 }
 await index.sealAndTruncate();
}
async function sample(history:number,corpus:number){
 closeDatabase();await stopWalMaintenance();await stopSearchIndex();removeTempDirSync(DATA_DIR);mkdirSync(DATA_DIR,{recursive:true});setMemoryMode("capture");
 const db=database(),scope=captureScopeId(db,"fixture-thread");
 transaction(()=>{
  const message=db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,'bot','text',?,?)");
  for(let n=0;n<history;n++){const id=`history-${String(n).padStart(6,"0")}`,m={id,at:1,role:"bot",kind:"text",text:"h".repeat(200),turnId:`old-${n}`};message.run("fixture-thread",id,m.text,JSON.stringify(m));}
  const record=db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact',?,'owner-statement','active',0,0)");
  for(let n=0;n<corpus;n++)record.run(`corpus-${String(n).padStart(6,"0")}`,scope,"fixture history alpha "+"x".repeat(180));
 });
 prepareThreadSync("fixture-thread");await stopSearchIndex();await stopWalMaintenance();
 const index=await MemoryIndex.create(join(root,`index-${history}.db`),{charge:async()=>true});await seedIndex(index,corpus);
 const handle=(index as unknown as {db:ReturnType<typeof database>}).db;
 db.exec("PRAGMA shrink_memory");handle.exec("PRAGMA shrink_memory");expect(registerBg(handle)).toBe(true);
 const read=Reflect.get(ioBudget,"read") as ()=>unknown;let at=0,serial=0;
 Reflect.set(ioBudget,"read",()=>({at,fsWriteBlocks:0,cpuMicros:0}));ioBudget.resetAdmissionForFixture();ioBudget.setIsIdle(()=>false);
 const tickets=new Map<string,NonNullable<ReturnType<typeof ioBudget.admit>>>();
 configureHelperAdmission({request:ceiling=>{
  let ticket=ioBudget.admit("BG",ceiling);if(!ticket){at+=60000;ticket=ioBudget.admit("BG",ceiling);}expect(ticket,"SCALE index allowance").not.toBeNull();
  const id=`permit-${++serial}`;tickets.set(id,ticket!);acceptHelperTicket({...ticket!,id});
 },settle:(r,used)=>{ioBudget.settle(tickets.get(r.id)!,used);tickets.delete(r.id);}});
 try{
  const before=ioGrantSnapshot(),written=before.threadRawBytes;
  appendMessage("fixture-thread",{id:"current-owner",at:2,role:"user",kind:"text",text:"A constant fixture preference "+"a".repeat(180),turnId:"current-turn"});
  expect(turnRows("fixture-thread","current-turn").map(r=>r.id),"SCALE exact turn rows").toEqual(["current-owner"]);
  ioBudget.withSource("memory-worker",()=>{
   const work=claimMemoryJob("fixture-worker");expect(work,"SCALE captured work exists").not.toBeNull();
   publishMemoryWork(work!,"fixture-worker",captureWork(work!));
  });
  let done=false;const row:IndexedMemory={id:"current-index",version:1,scopeId:"fixture-scope",text:"A constant fixture preference "+"a".repeat(180),deleted:false};
  for(let tries=0;!done;tries++){
   expect(tries,"SCALE per-turn checked step drains").toBeLessThan(1000);
   try{const r=await index.applyBatch([row]);done=r.status==="done";if(!done)await index.maintenanceStep();}catch(error){if(!isBgDeferred(error))throw error;}
  }
  const after=ioGrantSnapshot(),bytes=after.threadRawBytes-written,reads=after.threadReadBytes-before.threadReadBytes;
  const plan=db.prepare("EXPLAIN QUERY PLAN "+TURN_ROWS_SQL).all("fixture-thread","current-turn").map(r=>String(r.detail)).join(" ");
  expect(after.ceilingMiss,"SCALE no admission ceiling miss").toBe(before.ceilingMiss);
  return {reads,bytes,plan};
 }finally{configureHelperAdmission(undefined);index.close();Reflect.set(ioBudget,"read",read);closeDatabase();ioBudget.resetAdmissionForFixture();}
}
it("SCALE per-turn xRead and xWrite remain bounded at H=1k/100k and memory=6k/60k",async()=>{
 // Both selected handles execute on this thread, including the awaited index check.
 // Other worker threads can copy unrelated logs; their process counters are outside this per-turn measurement.
 const small=await sample(1000,6000),large=await sample(100000,60000);
 console.log(JSON.stringify({small:{reads:small.reads,bytes:small.bytes},large:{reads:large.reads,bytes:large.bytes}}));
 expect(small.reads,"SCALE real xRead measurement").toBeGreaterThan(0);expect(small.bytes,"SCALE real xWrite measurement").toBeGreaterThan(0);
 expect(large.reads/small.reads,"SCALE xRead ratio <= 1.25").toBeLessThanOrEqual(1.25);
 expect(large.bytes/small.bytes,"SCALE xWrite ratio <= 1.1").toBeLessThanOrEqual(1.1);
 expect(small.plan,"SCALE small EQP uses messages_turn").toContain("USING INDEX messages_turn");
 expect(large.plan,"SCALE large EQP uses messages_turn").toContain("USING INDEX messages_turn");
},180000);
