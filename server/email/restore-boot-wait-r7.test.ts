import { existsSync, readFileSync, readdirSync, mkdtempSync, statSync, unlinkSync, writeFileSync, copyFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import vm from "node:vm";
import ts from "typescript";
import { afterEach, expect, it } from "vitest";
import { RestoreJobStore, runRestoreBootRecovery, RESTORE_BACKUP_LINE } from "./restore-job.ts";
import * as effects from "./restore-job-effects.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";

const roots: string[]=[];
afterEach(() => {for(const p of roots.splice(0)) removeTempDirSync(p);});
const dir = () => {const p=mkdtempSync(join(tmpdir(),"j4d3-row-"));roots.push(p);return p;};
const flush = () => new Promise<void>(r=>setImmediate(r));
const sleep = (ms:number) => new Promise<void>(r=>setTimeout(r,ms));
const W=1_800_000_000_000,U=1000,TTL=86_400_000;
const DDL="CREATE TABLE IF NOT EXISTS restore_boot_wait (id INTEGER PRIMARY KEY CHECK (id = 1), job_id TEXT NOT NULL, cause TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, boot_id TEXT NOT NULL, up_ms INTEGER NOT NULL, db_dev TEXT NOT NULL, db_ino TEXT NOT NULL)";
const row = (over:Record<string,unknown>={}) => ({id:1,job_id:"A",cause:"backup",elapsed_ms:3000,outcome:"freed",at:W,boot_id:"boot-A",up_ms:U,db_dev:"1",db_ino:"2",...over});
function fake() {const marks={swapped:"A" as string|null,prepared:null as string|null,blind:null};return {marks:()=>marks,stage:()=>({blind:false}),install:(j:any)=>{marks.swapped=j.id;},prepare:(j:any)=>{marks.prepared=j.id;}};}
function setup(extra:any={}) {
  const root=dir(),fx=fake();let m=0,n=0;
  writeFileSync(join(root,"restore-job.json"),JSON.stringify({version:1,id:"A",archiveId:"arc",source:"owner",phase:"swapped",at:W}));
  const s:any=new RestoreJobStore({dir:root,isLocalArchive:()=>true,captureCarry:()=>({}),effects:fx,now:()=>W,mono:()=>m,bootTime:()=>U,bootId:()=>"boot-A",sleepSync:ms=>{m+=ms;},dataOpsLock:{acquire:()=>++n>1,release:()=>{}},log:()=>{},...extra});
  return {root,fx,s};
}
function reader(r:any=row(),extra:any={},prepared:string|null="A") {
 const root=dir();writeFileSync(join(root,"restore-boot-wait.json"),JSON.stringify({version:1,jobId:"A",cause:"backup",elapsedMs:3000,outcome:"freed",at:W}));
 return {root,s:new RestoreJobStore({dir:root,isLocalArchive:()=>true,captureCarry:()=>({}),effects:{...fake(),bootWait:()=>({row:r,prepared,dev:"1",ino:"2"})},now:()=>W,bootId:()=>"boot-A",bootTime:()=>U,...extra} as any)};
}
function dbFixture() {const root=dir(),path=join(root,"messages.db"),db=new DatabaseSync(path);db.exec("CREATE TABLE restore_job_marks (kind TEXT PRIMARY KEY, job_id TEXT NOT NULL); INSERT INTO restore_job_marks VALUES ('prepared','A')");db.close();return {root,path,req:{dbPath:path,jobId:"A",cause:"backup",elapsedMs:3000,outcome:"freed" as const,at:W,bootId:"boot-A",upMs:U}};}
const open=(p:string,o?:any)=>new DatabaseSync(p,o ?? {});
function count(path:string) {const db=open(path);try{return db.prepare("SELECT 1 FROM sqlite_master WHERE name='restore_boot_wait'").get()?Number(db.prepare("SELECT count(*) n FROM restore_boot_wait").get()!.n):0;}finally{db.close();}}
const saved=()=>{const result=Promise.resolve("saved");return {result,terminate:()=>{},exited:result.then(()=>{})};};

it.each([false,true])("T1 off-stack record and publication, gave_up=%s",async gaveUp=>{
 const calls:string[]=[],trace:string[]=[];let acquired=0;
 const f=setup({bootId:undefined,bootTime:undefined,recoverLockWaitMs:1000,dataOpsLock:{acquire:()=>gaveUp?false:++acquired>1,release:()=>{}},writeRecord:async()=>{calls.push("record");},publish:()=>{calls.push("publish");return saved();},publishTrace:(s:string)=>trace.push(s),readProc:()=>{calls.push("proc");return "1";},remove:(p:string)=>{calls.push(p.split("/").at(-1)!);try{unlinkSync(p);}catch{} }});
 expect(f.s.recover()).toEqual({action:gaveUp?"stuck":"prepared"});
 expect(calls).toEqual(gaveUp?[]:["restore-carry.json","restore-job.json"]);
 expect(f.s.publishReserved()).toBe(!gaveUp);expect(trace).toEqual(gaveUp?[]:["reserve"]);
 await Promise.resolve();expect(calls).toEqual(gaveUp?[]:["restore-carry.json","restore-job.json"]);
 await flush();expect(calls.filter(x=>x==="record")).toHaveLength(1);expect(calls.filter(x=>x==="publish")).toHaveLength(gaveUp?0:1);
 await f.s.publishSettled();expect(f.s.publishReserved()).toBe(false);expect(trace).toEqual(gaveUp?[]:["reserve","enter","call","idle"]);
});
it.each(["block","throw","hang"])("T2 stuck spool precedes %s writer",async mode=>{
 const order:string[]=[];const f=setup({recoverLockWaitMs:1000,dataOpsLock:{acquire:()=>false,release:()=>{}},writeRecord:()=>{order.push("writer");if(mode==="block")Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);if(mode==="throw")throw Error("fault");return mode==="hang"?new Promise(()=>{}):Promise.resolve();}});
 const t=performance.now();expect(runRestoreBootRecovery(f.s,()=>order.push("spool"))).toEqual({stuck:true});expect(performance.now()-t).toBeLessThan(100);expect(order).toEqual(["spool"]);await flush();expect(order).toEqual(["spool","writer"]);
});
it("NL1 desktop without lock performs no wait or publication",async()=>{
 let reads=0,sleeps=0,pubs=0,writes=0;const trace:string[]=[];
 const f=setup({dataOpsLock:undefined,mono:()=>{reads++;return sleeps*250;},sleepSync:()=>{sleeps++;},publish:()=>{pubs++;return saved();},writeRecord:async()=>{writes++;},publishTrace:(x:string)=>trace.push(x)});
 expect(f.s.recover()).toEqual({action:"prepared"});expect([reads,sleeps]).toEqual([0,0]);expect(f.fx.marks().prepared).toBe("A");expect(existsSync(join(f.root,"restore-job.json"))).toBe(false);
 expect(f.s.publishReserved()).toBe(false);await flush();await f.s.publishSettled();expect([pubs,writes]).toEqual([0,0]);expect(trace).toEqual([]);expect(f.s.arm({archiveId:"arc",source:"owner"}).ok).toBe(true);f.s.abort();
});
it("GATE1 reservation refuses arm in the recovery tick",async()=>{
 const f=setup({publish:saved});expect(f.s.recover()).toEqual({action:"prepared"});
 expect(f.s.arm({archiveId:"arc",source:"owner"})).toEqual({ok:false,code:"backup_running",line:RESTORE_BACKUP_LINE});expect(existsSync(join(f.root,"restore-job.json"))).toBe(false);
 await f.s.publishSettled();expect(f.s.arm({archiveId:"arc",source:"owner"}).ok).toBe(true);f.s.abort();
});
it("GATE2 a competing journal supersedes publication after a positive control",async()=>{
 for(const competitor of [false,true]) {let pubs=0;const trace:string[]=[];const f=setup({publish:()=>{pubs++;return saved();},publishTrace:(x:string)=>trace.push(x)});f.s.recover();
 if(competitor) new RestoreJobStore({dir:f.root,isLocalArchive:()=>true,captureCarry:()=>({})}).arm({archiveId:"arc",source:"owner"});
 await f.s.publishSettled();expect(pubs).toBe(competitor?0:1);expect(trace).toEqual(competitor?["reserve","enter","superseded","idle"]:["reserve","enter","call","idle"]);expect(f.s.publishReserved()).toBe(false);}
});
it("H1t termination keeps admission reserved until worker exit",async()=>{
 let terminate=0,exit!:()=>void;const trace:string[]=[];const f=setup({publishCapMs:200,publishTrace:(x:string)=>trace.push(x),publish:()=>({result:new Promise(()=>{}),terminate:()=>{terminate++;},exited:new Promise<void>(r=>{exit=r;})})});f.s.recover();
 await sleep(100);expect(terminate).toBe(0);expect(f.s.arm({archiveId:"arc",source:"owner"}).code).toBe("backup_running");await sleep(150);expect(terminate).toBe(1);expect(f.s.publishReserved()).toBe(true);expect(f.s.arm({archiveId:"arc",source:"owner"})).toEqual({ok:false,code:"backup_running",line:RESTORE_BACKUP_LINE});expect(f.s.state()).toBe("none");await sleep(350);expect(terminate).toBe(1);expect(trace.filter(x=>x==="terminate")).toHaveLength(1);exit();await f.s.publishSettled();expect(f.s.publishReserved()).toBe(false);expect(f.s.arm({archiveId:"arc",source:"owner"}).ok).toBe(true);f.s.abort();
});
it.each([['E1a',TTL-1,TTL-1,true],['E1b',TTL,TTL,false],['E1c',TTL,23*3600000,false],['E1c-b',TTL-1,23*3600000,true],['E1d',3600000,TTL+1,false],['E1e',3600000,TTL+120000,false],['E1f',23*3600000,TTL,false],['E2a',12*3600000,TTL,false],['E2b',-360000,3600000,false],['E2c',-240000,3600000,true]])("%s exact age rule",(_id,wall,boot,shown)=>{
 const f=reader(row(),{now:()=>W+Number(wall),bootTime:()=>U+Number(boot)});expect(f.s.bootWaitLine()!==null).toBe(shown);
});
it("E2d clock correction reveals retained notice",()=>{let w=W+25*3600000;const f=reader(row(),{now:()=>w,bootTime:()=>U+3600000});expect(f.s.bootWaitLine()).toBeNull();w=W+3600000;expect(f.s.bootWaitLine()).toContain("waited 3 seconds");expect(existsSync(join(f.root,"restore-boot-wait.json"))).toBe(true);});
it.each([{bootId:()=>"boot-B"},{bootId:()=>""},{bootTime:()=>U-1},{bootTime:()=>NaN}])("E3 hides across boot identity and invalid uptime",extra=>{expect(reader(row(),extra).s.bootWaitLine()).toBeNull();});
it.each(["B",null])("T6r prepared mark must match, %s",prepared=>{expect(reader(row(),{},prepared).s.bootWaitLine()).toBeNull();});
it.each([1,2])("G2 ops record version %i never drives owner line",version=>{const f=reader(null);writeFileSync(join(f.root,"restore-boot-wait.json"),JSON.stringify({version,jobId:"A",cause:"backup",elapsedMs:3000,outcome:"freed",at:W,bootId:"boot-A",upMs:U}));expect(f.s.bootWaitLine()).toBeNull();});
it("G2 source scan confines the operations path to its deferred writer",()=>{
 const files:string[]=[];
 const collect=(root:string):void=>{for(const entry of readdirSync(root,{withFileTypes:true})){if(entry.name==="test-support")continue;const path=join(root,entry.name);if(entry.isDirectory())collect(path);else if(path.endsWith(".ts")&&!path.endsWith(".test.ts"))files.push(path);}};collect("server");
 const references=files.filter(file=>{const sf=ts.createSourceFile(file,readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);let found=false;const scan=(n:ts.Node):void=>{if(ts.isStringLiteral(n)&&n.text==="restore-boot-wait.json")found=true;ts.forEachChild(n,scan);};scan(sf);return found;});
 expect(references).toEqual(["server/email/restore-job.ts"]);
 const source=readFileSync(new URL("./restore-job.ts",import.meta.url),"utf8"),sf=ts.createSourceFile("restore-job.ts",source,ts.ScriptTarget.Latest,true);
 const helpers=new Set<string>(),uses:Array<{callee:string;owner:string}>=[];
 const walk=(n:ts.Node,owner=""):void=>{
  if(ts.isMethodDeclaration(n))owner=n.name.getText(sf);
  if(ts.isStringLiteral(n)&&n.text==="restore-boot-wait.json")helpers.add(owner);
  if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.expression.kind===ts.SyntaxKind.ThisKeyword)uses.push({callee:n.expression.name.text,owner});
  ts.forEachChild(n,c=>walk(c,owner));
 };walk(sf);expect(helpers.size).toBe(1);
 expect(uses.filter(u=>helpers.has(u.callee))).toEqual([{callee:[...helpers][0],owner:"scheduleRecord"}]);
});
it("T8r read fault hides only that poll without deleting or caching",()=>{
 const f=dbFixture(),db=open(f.path);db.exec(DDL);const id=statSync(f.path,{bigint:true});db.prepare("INSERT INTO restore_boot_wait VALUES(1,?,?,?,?,?,?,?,?,?)").run("A","backup",3000,"freed",W,"boot-A",U,String(id.dev),String(id.ino));db.close();
 writeFileSync(join(f.root,"restore-boot-wait.json"),JSON.stringify({version:1,jobId:"A",cause:"backup",elapsedMs:3000,outcome:"freed",at:W}));
 const base=effects.sqliteRestoreEffects({liveDb:f.path,archivesDir:f.root});let n=0;const fx={...base,bootWait:()=>{if(++n===2)throw Error("RESTORE_MARKS_UNREADABLE");return base.bootWait!();}};
 const s=new RestoreJobStore({dir:f.root,isLocalArchive:()=>true,captureCarry:()=>({}),effects:fx,now:()=>W,bootId:()=>"boot-A",bootTime:()=>U} as any);
 expect(s.bootWaitLine()).toContain("waited");expect(s.bootWaitLine()).toBeNull();expect(s.bootWaitLine()).toContain("waited");expect(count(f.path)).toBe(1);
});
it.each([{at:Infinity},{at:-Infinity},{at:-5},{at:"1"},{at:null},{elapsed_ms:Infinity},{elapsed_ms:-5},{elapsed_ms:"3"},{elapsed_ms:30*86400000}])("R1 validation rejects malformed row %j",over=>{expect(reader(row(over)).s.bootWaitLine()).toBeNull();});
it("ID1 publisher rejects a path identity change",()=>{const f=dbFixture();let n=0;expect((effects as any).publishBootWaitRow(open,()=>({dev:1n,ino:++n===1?2n:3n}),f.req)).toBe("superseded");expect(count(f.path)).toBe(0);expect((effects as any).publishBootWaitRow(open,()=>({dev:1n,ino:2n}),f.req)).toBe("saved");expect(count(f.path)).toBe(1);});
it("T5a publisher ignores a superseded job",()=>{const f=dbFixture();expect((effects as any).publishBootWaitRow(open,statSync,{...f.req,jobId:"B"})).toBe("superseded");expect(count(f.path)).toBe(0);});
it("D6 publisher executes in an empty context and carries exact DDL",()=>{const f=dbFixture(),src=(effects as any).publishBootWaitRow.toString();expect((effects as any).RESTORE_BOOT_WAIT_DDL).toBe(DDL);expect(src).toContain(JSON.stringify(DDL));expect(vm.runInNewContext(`(${src})`,{})(open,statSync,f.req)).toBe("saved");expect(count(f.path)).toBe(1);});
it("F2 trigger rollback is isolated to the worker publication",async()=>{const f=dbFixture(),db=open(f.path);db.exec(DDL);db.exec("CREATE TRIGGER t BEFORE INSERT ON restore_boot_wait BEGIN SELECT RAISE(ROLLBACK, 'x'); END");db.close();const h=(effects as any).workerPublish(f.req);expect(await h.result).toBe("failed:SQLITE_CONSTRAINT");await h.exited;expect(count(f.path)).toBe(0);});
it("H1w worker termination keeps the store reserved until exit and closes the connection",async()=>{
 const f=dbFixture(),db=open(f.path);db.exec("BEGIN IMMEDIATE");let prepared=false,n=0,m=0,terminations=0,exited=false;
 writeFileSync(join(f.root,"restore-job.json"),JSON.stringify({version:1,id:"A",archiveId:"arc",source:"owner",phase:"swapped",at:W}));
 const fx={...effects.sqliteRestoreEffects({liveDb:f.path,archivesDir:f.root}),marks:()=>({swapped:"A",prepared:prepared?"A":null,blind:null}),prepare:()=>{prepared=true;}};
 const s:any=new RestoreJobStore({dir:f.root,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),dataOpsLock:{acquire:()=>++n>1,release:()=>{}},mono:()=>m,sleepSync:(ms:number)=>{m+=ms;},publishCapMs:200,log:()=>{},publish:(req:any)=>{const h=(effects as any).workerPublish(req);void h.exited.then(()=>{exited=true;});return {...h,terminate:()=>{terminations++;h.terminate();}};}} as any);
 try{expect(s.recover()).toEqual({action:"prepared"});await sleep(100);expect(exited).toBe(false);expect(s.arm({archiveId:"arc",source:"owner"}).code).toBe("backup_running");await s.publishSettled();expect(terminations).toBe(1);expect(exited).toBe(true);expect(s.publishReserved()).toBe(false);expect(s.arm({archiveId:"arc",source:"owner"}).ok).toBe(true);s.abort();}finally{db.exec("ROLLBACK");db.close();}
 const next=open(f.path,{timeout:0});try{next.exec("BEGIN EXCLUSIVE; ROLLBACK");}finally{next.close();}
});
it("P3 copied bytes cannot carry another inode's notice",()=>{const f=dbFixture();expect((effects as any).publishBootWaitRow(open,statSync,f.req)).toBe("saved");const fx=effects.sqliteRestoreEffects({liveDb:f.path,archivesDir:f.root});const s=new RestoreJobStore({dir:f.root,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),now:()=>W,bootId:()=>"boot-A",bootTime:()=>U} as any);expect(s.bootWaitLine()).toContain("waited");copyFileSync(f.path,f.path+".copy");renameSync(f.path,f.path+".original");renameSync(f.path+".copy",f.path);expect(s.bootWaitLine()).toBeNull();renameSync(f.path+".original",f.path);expect(s.bootWaitLine()).toContain("waited");});
it("RD1 reader rejects replacement during the second stat",()=>{const f=dbFixture();(effects as any).publishBootWaitRow(open,statSync,f.req);copyFileSync(f.path,f.path+".copy");renameSync(f.path,f.path+".original");renameSync(f.path+".copy",f.path);const fx=effects.sqliteRestoreEffects({liveDb:f.path,archivesDir:f.root,openLive:(p:string,o:any)=>{const db=open(p,o);if(existsSync(f.path+".original"))renameSync(f.path+".original",f.path);return db;}} as any);const s=new RestoreJobStore({dir:f.root,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),now:()=>W,bootId:()=>"boot-A",bootTime:()=>U} as any);expect(s.bootWaitLine()).toBeNull();expect(s.bootWaitLine()).toContain("waited");});

import {createServer} from "node:http";
import {once} from "node:events";
import {open as openFile} from "node:fs/promises";
import {vi} from "vitest";
import {writeRecordAtomic} from "./restore-job.ts";
import {writeFileAtomic} from "../atomic.ts";
import {restoreOwnerRoute} from "./restore-owner-routes.ts";
const start = (s:RestoreJobStore,closeForSwap=async()=>true) => restoreOwnerRoute({jobs:s,closeForSwap,restart:()=>{}},{method:"POST",path:"/api/restore-job/start",body:{archiveId:"arc"},surface:"desktop",botCredential:false});
it("T3r owner restore succeeds when only its journal and carry can be written",async()=>{
 const fx=fake();fx.prepare({id:"A"});let held=true;const f=reader(row(),{effects:{...fx,bootWait:()=>({row:row(),prepared:fx.marks().prepared,dev:"1",ino:"2"})},uid:()=>"B",dataOpsLock:{acquire:()=>true,release:()=>{held=false;}},write:(path:string,data:string,opts:any)=>{if(!/restore-(job|carry)\.json$/.test(path))throw Error("write refused");writeFileAtomic(path,data,opts);}});
 expect(await start(f.s)).toEqual({status:200,body:{ok:true,restarting:true}});expect(f.s.state()).toBe("none");expect(f.s.bootWaitLine()).toBeNull();expect(fx.marks().prepared).toBe("B");expect(held).toBe(false);
});
it("T5b delayed operations record cannot revive A after B",async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const f=setup({publish:saved,writeRecord:async(p:string,d:string)=>{await gate;writeFileSync(p,d);}});
 (f.fx as any).bootWait=()=>({row:row(),prepared:f.fx.marks().prepared,dev:"1",ino:"2"});f.s.recover();
 await (f.s.publishIdle?.()??flush());expect(await start(f.s)).toMatchObject({status:200});release();await (f.s.opsSettled?.()??f.s.recordsSettled());
 const ops=JSON.parse(readFileSync(join(f.root,"restore-boot-wait.json"),"utf8"));expect(ops.jobId).toBe("A");expect(ops.at).toBe(W);expect(f.s.bootWaitLine()).toBeNull();expect(f.s.state()).toBe("none");expect(ops.version).toBe(2);
});
it("GATE3 owner clear never schedules a second publisher",async()=>{
 let pubs=0;const trace:string[]=[];const f=setup({publish:()=>{pubs++;return saved();},publishTrace:(e:string)=>trace.push(e)});f.s.recover();await f.s.publishSettled();expect(pubs).toBe(1);
 let release!:()=>void;const gate=new Promise<boolean>(r=>{release=()=>r(true);});const promise=start(f.s,()=>gate);await flush();release();expect(await promise).toMatchObject({status:200});await flush();await f.s.publishSettled();expect(pubs).toBe(1);expect(trace.filter(x=>x==="reserve")).toHaveLength(1);expect(f.s.bootWaitLine()).toBeNull();
});
it("T11 no wait leaves no record, publisher or reservation",async()=>{let records=0,pubs=0;const trace:string[]=[];const f=setup({dataOpsLock:{acquire:()=>true,release:()=>{}},publish:()=>{pubs++;return saved();},writeRecord:async()=>{records++;},publishTrace:(e:string)=>trace.push(e)});expect(f.s.recover()).toEqual({action:"prepared"});await flush();await f.s.publishSettled();expect([records,pubs]).toEqual([0,0]);expect(trace).toEqual([]);expect(f.s.bootWaitLine()).toBeNull();});
it("D1 default wait clock ignores a wall clock jump",async()=>{
 const root=dir(),fx=fake();writeFileSync(join(root,"restore-job.json"),JSON.stringify({version:1,id:"A",archiveId:"arc",source:"owner",phase:"swapped",at:W}));let tries=0,wallReads=0,record:any;
 const spy=vi.spyOn(Date,"now").mockImplementation(()=>W+(wallReads++?86400000:0));
 try{const s:any=new RestoreJobStore({dir:root,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),recoverLockWaitMs:600,dataOpsLock:{acquire:()=>{tries++;return false;},release:()=>{}},writeRecord:async(_p,d)=>{record=JSON.parse(d);},log:()=>{}});expect(s.recover()).toEqual({action:"stuck"});expect(tries).toBeGreaterThanOrEqual(3);await(s.opsSettled?.()??s.recordsSettled());expect(record.elapsedMs).toBeGreaterThanOrEqual(500);}finally{spy.mockRestore();}
});
it("D2 proc uptime stamps include suspend time",async()=>{const paths:string[]=[];let req:any;const f=setup({bootId:undefined,bootTime:undefined,readProc:(p:string)=>{paths.push(p);return p.endsWith("uptime")?"90061.50 1234.00\n":"boot-A\n";},publish:(r:any)=>{req=r;return saved();}});f.s.recover();await f.s.publishSettled();expect(req.upMs).toBe(90061500);expect(req.bootId).toBe("boot-A");expect(paths).toContain("/proc/uptime");expect(paths).toContain("/proc/sys/kernel/random/boot_id");});
it("D3 atomic writer syncs file before rename and directory after",async()=>{const root=dir(),file=join(root,"record.json"),probe=await openFile(join(root,"probe"),"w"),prototype=Object.getPrototypeOf(probe);await probe.close();const original=prototype.sync,seen:Array<{exists:boolean;directory:boolean}>=[];const spy=vi.spyOn(prototype,"sync").mockImplementation(async function(this:any){seen.push({exists:existsSync(file),directory:(await this.stat()).isDirectory()});return original.call(this);});try{await writeRecordAtomic(file,"record");expect(seen).toEqual([{exists:false,directory:false},{exists:true,directory:true}]);}finally{spy.mockRestore();}});
it("D4 waited recovery preserves job ID in both publications",async()=>{let req:any;const f=setup({publish:(r:any)=>{req=r;return saved();}});f.s.recover();await f.s.publishSettled();expect(req.jobId).toBe("A");expect(JSON.parse(readFileSync(join(f.root,"restore-boot-wait.json"),"utf8")).jobId).toBe("A");});
it("H1 real publisher leaves recovery, first health answer and status responsive",async()=>{
 const f=dbFixture();let held:DatabaseSync|undefined,m=0,n=0;const trace:string[]=[];
 writeFileSync(join(f.root,"restore-job.json"),JSON.stringify({version:1,id:"A",archiveId:"arc",source:"owner",phase:"swapped",at:W}));
 let prepared=false;const fx={...effects.sqliteRestoreEffects({liveDb:f.path,archivesDir:f.root}),marks:()=>({swapped:"A",prepared:prepared?"A":null,blind:null}),prepare:()=>{prepared=true;}};
 const s:any=new RestoreJobStore({dir:f.root,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),dataOpsLock:{acquire:()=>++n>1,release:()=>{}},mono:()=>m,sleepSync:ms=>{m+=ms;},remove:p=>{try{unlinkSync(p);}catch{}if(p.endsWith("restore-job.json")){held=open(f.path);held.exec("BEGIN IMMEDIATE");}},log:l=>trace.push(l)});
 const control=setup({dataOpsLock:{acquire:()=>true,release:()=>{}}});const ct=performance.now();expect(control.s.recover()).toEqual({action:"prepared"});const controlRecovery=performance.now()-ct;
 const controlServer=createServer((_req,res)=>res.end("ok"));controlServer.listen(0,"127.0.0.1");await once(controlServer,"listening");const ch=performance.now();expect(await(await fetch(`http://127.0.0.1:${(controlServer.address() as any).port}/api/health`)).text()).toBe("ok");const controlHealth=performance.now()-ch;controlServer.close();
 const server=createServer((_req,res)=>{res.end("ok");});let last=performance.now(),gap=0;const timer=setInterval(()=>{const now=performance.now();gap=Math.max(gap,now-last);last=now;},5);
 try{let recovered:any;const t=performance.now();expect(runRestoreBootRecovery({recover:()=>recovered=s.recover()} as any,()=>{throw Error("spooled");})).toEqual({stuck:false});expect(recovered).toEqual({action:"prepared"});expect(performance.now()-t).toBeLessThan(100);expect(performance.now()-t).toBeLessThan(controlRecovery+50);
 server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as any).port;const health=performance.now();expect(await(await fetch(`http://127.0.0.1:${port}/api/health`)).text()).toBe("ok");expect(performance.now()-health).toBeLessThan(250);expect(performance.now()-health).toBeLessThan(controlHealth+50);expect(await start(s)).toMatchObject({status:409,body:{code:"backup_running",error:RESTORE_BACKUP_LINE}});expect(s.state()).toBe("none");await s.publishSettled();expect(gap).toBeLessThan(50);expect(trace.filter(l=>l.includes("failed:SQLITE_BUSY"))).toHaveLength(1);expect(s.arm({archiveId:"arc",source:"owner"}).ok).toBe(true);s.abort();
 }finally{clearInterval(timer);server.close();held?.exec("ROLLBACK");held?.close();}
});
it("G1 gave_up record stays operations-only after a later unwaited recovery",async()=>{
 const f=setup({recoverLockWaitMs:1000,dataOpsLock:{acquire:()=>false,release:()=>{}}});expect(f.s.recover()).toEqual({action:"stuck"});await(f.s.opsSettled?.()??f.s.recordsSettled());const path=join(f.root,"restore-boot-wait.json");expect(JSON.parse(readFileSync(path,"utf8")).outcome).toBe("gave_up");
 const next:any=new RestoreJobStore({dir:f.root,effects:f.fx,isLocalArchive:()=>true,captureCarry:()=>({}),dataOpsLock:{acquire:()=>true,release:()=>{}},now:()=>W,bootId:()=>"boot-A",bootTime:()=>U} as any);expect(next.recover()).toEqual({action:"prepared"});expect(next.bootWaitLine()).toBeNull();expect(JSON.parse(readFileSync(path,"utf8")).outcome).toBe("gave_up");
 let published:any;const c=setup({publish:(req:any)=>{published=row({job_id:req.jobId,elapsed_ms:req.elapsedMs});return saved();}});(c.fx as any).bootWait=()=>({row:published,prepared:c.fx.marks().prepared,dev:"1",ino:"2"});c.s.recover();await c.s.publishSettled();expect(c.s.bootWaitLine()).toContain("Murage waited");
});
it("E2b a clock correction retains the real row without a write",()=>{
 const f=dbFixture(),db=open(f.path),id=statSync(f.path,{bigint:true});db.exec(DDL);db.prepare("INSERT INTO restore_boot_wait VALUES(1,?,?,?,?,?,?,?,?,?)").run("A","backup",3000,"freed",W,"boot-A",U,String(id.dev),String(id.ino));db.close();let wall=W-360000;
 writeFileSync(join(f.root,"restore-boot-wait.json"),JSON.stringify({version:1,jobId:"A",cause:"backup",elapsedMs:3000,outcome:"freed",at:W}));
 const s=new RestoreJobStore({dir:f.root,effects:effects.sqliteRestoreEffects({liveDb:f.path,archivesDir:f.root}),isLocalArchive:()=>true,captureCarry:()=>({}),now:()=>wall,bootId:()=>"boot-A",bootTime:()=>U+3600000} as any);
 expect(s.bootWaitLine()).toBeNull();expect(count(f.path)).toBe(1);wall=W+3600000;expect(s.bootWaitLine()).toContain("waited");expect(count(f.path)).toBe(1);
});
