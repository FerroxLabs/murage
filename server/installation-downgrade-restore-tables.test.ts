import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";
import {afterEach,expect,it} from "vitest";
import {DATA_DIR} from "./config.ts";
import {database,closeDatabase} from "./database.ts";
import {stopWalMaintenance} from "./wal-maintenance.ts";
import {RestoreJobStore} from "./email/restore-job.ts";
import * as effects from "./email/restore-job-effects.ts";
import {APP_SCHEMA_102_ADDITIONS,CARD_TABLES_AFTER_117,SPEECH_TABLES_AFTER_117} from "./installation-app-schema-downgrade.ts";
import {ADDED_TABLE_LIFECYCLE} from "./added-table-lifecycle.ts";
import {registeredSnapshotObjects} from "./installation-database-snapshot.ts";
import {downgradeInstallationMemorySchema} from "./installation-memory-downgrade.ts";
import {discardInboxProjection} from "./inbox.ts";
import {haveV101,realV101} from "./testing/pm-sends-v101.ts";
import {removeTempDirSync} from "./testing/cleanup.ts";
const names=["restore_boot_wait","restore_job_marks"];
const roots:string[]=[];
afterEach(async()=>{closeDatabase();await stopWalMaintenance();for(const p of roots.splice(0))removeTempDirSync(p);});
it("DG1 A both restore tables stay off downgrade lists and lifecycle",()=>{
 for(const name of names){for(const list of [APP_SCHEMA_102_ADDITIONS.tables,APP_SCHEMA_102_ADDITIONS.indexes,APP_SCHEMA_102_ADDITIONS.triggers,CARD_TABLES_AFTER_117.tables,SPEECH_TABLES_AFTER_117])expect(list).not.toContain(name);expect(ADDED_TABLE_LIFECYCLE).not.toHaveProperty(name);}
 const source=readFileSync(new URL("./installation-app-schema-downgrade.ts",import.meta.url),"utf8");
 for(const name of names)expect(source).not.toContain(`"${name}"`);
});
it("DG1 B snapshot registration does not alter downgrade lists",()=>{for(const name of names)expect(registeredSnapshotObjects().has(name),name).toBe(true);});
async function home(){
 const root=mkdtempSync(join(tmpdir(),"j4d3-dg-"));roots.push(root);const data=join(root,"home"),archives=join(root,"archives");mkdirSync(data);mkdirSync(join(archives,"arc"),{recursive:true});mkdirSync(DATA_DIR,{recursive:true});database();closeDatabase();await stopWalMaintenance();copyFileSync(join(DATA_DIR,"messages.db"),join(data,"messages.db"));copyFileSync(join(data,"messages.db"),join(archives,"arc","messages.db"));
 const fx=effects.sqliteRestoreEffects({liveDb:join(data,"messages.db"),archivesDir:archives}),job={version:1 as const,id:"DG1",archiveId:"arc",source:"owner",phase:"swapped" as const,at:1};fx.stage(job);fx.install(job);writeFileSync(join(data,"restore-job.json"),JSON.stringify(job));let n=0,m=0;
 const s:any=new RestoreJobStore({dir:data,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),dataOpsLock:{acquire:()=>++n>1,release:()=>{}},mono:()=>m,sleepSync:(ms:number)=>{m+=ms;},log:()=>{},publish:(req:any)=>{const result=Promise.resolve().then(()=>(effects as any).publishBootWaitRow((p:string,o:any)=>new DatabaseSync(p,o),statSync,req));return {result,terminate:()=>{},exited:result.then(()=>{})};}} as any);
 expect(s.recover()).toEqual({action:"prepared"});await s.publishSettled();return {root,data};
}
import {statSync} from "node:fs";
it("DG1 C both target downgrades execute and retain both tables",async()=>{
 const f=await home();for(const to of [6,13] as const){const dest=join(f.root,`target${to}`);mkdirSync(dest);copyFileSync(join(f.data,"messages.db"),join(dest,"messages.db"));expect(downgradeInstallationMemorySchema(dest,to,to===6?{testOnlyBefore102:true}:{})).toMatchObject({status:"downgraded",to});const db=new DatabaseSync(join(dest,"messages.db"));try{expect(db.prepare("SELECT count(*) n FROM restore_job_marks").get()!.n).toBe(2);expect(db.prepare("SELECT count(*) n FROM restore_boot_wait").get()!.n).toBe(1);}finally{db.close();}}
});
it("DG1 D real 1.0.1 four-case ledger uses DATABASE_SCHEMA_UNSUPPORTED",async()=>{
 expect(haveV101).toBe(true);const old=await realV101(),f=await home();downgradeInstallationMemorySchema(f.data,6,{testOnlyBefore102:true});
 const ledger:Array<{inspector:string;case:string;restoreTables:unknown[];result:unknown}>=[];
 for(const kind of ["control","marks-only","notice-only","both"]){const db=new DatabaseSync(join(f.data,"messages.db")),path=join(f.root,kind+".db");db.prepare("VACUUM INTO ?").run(path);db.close();const copy=new DatabaseSync(path);
 try{if(kind==="control"||kind==="marks-only")copy.exec("DROP TABLE restore_boot_wait");if(kind==="control"||kind==="notice-only")copy.exec("DROP TABLE restore_job_marks");discardInboxProjection(copy);
 const restoreTables=copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'restore_*' ORDER BY name").all().map(r=>r.name);let result:unknown="accepted";try{old.inspectInstallationDatabase(copy);}catch(e){result={code:(e as any).code};}
 ledger.push({inspector:"d950cbf67",case:kind,restoreTables,result});
 }finally{copy.close();}}
 console.log("DG1 ledger",JSON.stringify(ledger));
 expect(ledger).toEqual([
 {inspector:"d950cbf67",case:"control",restoreTables:[],result:"accepted"},
 {inspector:"d950cbf67",case:"marks-only",restoreTables:["restore_job_marks"],result:{code:"DATABASE_SCHEMA_UNSUPPORTED"}},
 {inspector:"d950cbf67",case:"notice-only",restoreTables:["restore_boot_wait"],result:{code:"DATABASE_SCHEMA_UNSUPPORTED"}},
 {inspector:"d950cbf67",case:"both",restoreTables:["restore_boot_wait","restore_job_marks"],result:{code:"DATABASE_SCHEMA_UNSUPPORTED"}}
 ]);
});

import {haveVRel,realVRel} from "./test-support/restore-vrel.ts";
it("DG1 D shipped 1.0.18 four-case ledger uses DATABASE_SCHEMA_UNSUPPORTED",async()=>{
 expect(haveVRel).toBe(true);const old=await realVRel(),f=await home();downgradeInstallationMemorySchema(f.data,13);
 const ledger:Array<{inspector:string;case:string;restoreTables:unknown[];result:unknown}>=[];
 for(const kind of ["control","marks-only","notice-only","both"]){const db=new DatabaseSync(join(f.data,"messages.db")),path=join(f.root,kind+".db");db.prepare("VACUUM INTO ?").run(path);db.close();const copy=new DatabaseSync(path);
 try{if(kind==="control"||kind==="marks-only")copy.exec("DROP TABLE restore_boot_wait");if(kind==="control"||kind==="notice-only")copy.exec("DROP TABLE restore_job_marks");
 const restoreTables=copy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'restore_*' ORDER BY name").all().map(r=>r.name);let result:unknown="accepted";try{old.inspectInstallationDatabase(copy);}catch(e){result={code:(e as any).code};}
 ledger.push({inspector:"fc3782abe834bb0a62c96437bff78ac4dbd96eeb",case:kind,restoreTables,result});
 }finally{copy.close();}}
 console.log("DG1 ledger",JSON.stringify(ledger));
 expect(ledger).toEqual([
 {inspector:"fc3782abe834bb0a62c96437bff78ac4dbd96eeb",case:"control",restoreTables:["restore_holds"],result:"accepted"},
 {inspector:"fc3782abe834bb0a62c96437bff78ac4dbd96eeb",case:"marks-only",restoreTables:["restore_holds","restore_job_marks"],result:{code:"DATABASE_SCHEMA_UNSUPPORTED"}},
 {inspector:"fc3782abe834bb0a62c96437bff78ac4dbd96eeb",case:"notice-only",restoreTables:["restore_boot_wait","restore_holds"],result:{code:"DATABASE_SCHEMA_UNSUPPORTED"}},
 {inspector:"fc3782abe834bb0a62c96437bff78ac4dbd96eeb",case:"both",restoreTables:["restore_boot_wait","restore_holds","restore_job_marks"],result:{code:"DATABASE_SCHEMA_UNSUPPORTED"}}
 ]);
});
