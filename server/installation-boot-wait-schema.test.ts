import {createHash,randomUUID} from "node:crypto";
import {pipeline} from "node:stream/promises";
import type {Readable} from "node:stream";
import {ZipFile} from "yazl";
import {prepareInstallationRestore} from "./installation-restore-preparation.ts";
import { copyFileSync, readFileSync, createWriteStream, mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database, closeDatabase } from "./database.ts";
import { stopWalMaintenance } from "./wal-maintenance.ts";
import { inspectInstallationDatabase, snapshotInstallationDatabase } from "./installation-database-snapshot.ts";
import { sqliteRestoreEffects } from "./email/restore-job-effects.ts";
import { consumeRestoreMarker } from "./email/restore-marker.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
const roots:string[]=[];
afterEach(async()=>{closeDatabase();await stopWalMaintenance();for(const r of roots.splice(0))removeTempDirSync(r);});
const DDL="CREATE TABLE IF NOT EXISTS restore_boot_wait (id INTEGER PRIMARY KEY CHECK (id = 1), job_id TEXT NOT NULL, cause TEXT NOT NULL, elapsed_ms INTEGER NOT NULL, outcome TEXT NOT NULL, at INTEGER NOT NULL, boot_id TEXT NOT NULL, up_ms INTEGER NOT NULL, db_dev TEXT NOT NULL, db_ino TEXT NOT NULL)";
async function fixture(notice=true) {
 const root=mkdtempSync(join(tmpdir(),"j4d3-schema-"));roots.push(root);const data=join(root,"data"),file=join(data,"messages.db");mkdirSync(data);mkdirSync(DATA_DIR,{recursive:true});database();closeDatabase();await stopWalMaintenance();copyFileSync(join(DATA_DIR,"messages.db"),file);
 const db=new DatabaseSync(file);db.exec("CREATE TABLE IF NOT EXISTS restore_job_marks (kind TEXT PRIMARY KEY, job_id TEXT NOT NULL);DELETE FROM restore_job_marks;INSERT INTO restore_job_marks VALUES ('swapped','B'),('prepared','B')");
 if(notice){db.exec(DDL);db.exec("INSERT INTO restore_boot_wait VALUES (1,'B','backup',3000,'freed',1800000000000,'boot-A',1000,'1','2')");}db.close();return {root,data,file};
}
const tables=(db:DatabaseSync)=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('restore_job_marks','restore_boot_wait') ORDER BY name").all().map(r=>r.name);
it.each([true,false])("S5 S7 snapshot drops restore metadata only from the staged copy, email=%s",async email=>{const f=await fixture();if(!email){const db=new DatabaseSync(f.file);db.exec("DROP TABLE IF EXISTS email_payloads;DROP TABLE IF EXISTS email_events");db.close();}const staged=join(f.root,"staged.db");await snapshotInstallationDatabase(f.data,staged);const db=new DatabaseSync(staged);try{expect(tables(db)).toEqual([]);}finally{db.close();}const live=new DatabaseSync(f.file);try{expect(tables(live)).toEqual(["restore_boot_wait","restore_job_marks"]);expect(live.prepare("SELECT count(*) n FROM restore_job_marks").get()!.n).toBe(2);expect(live.prepare("SELECT count(*) n FROM restore_boot_wait").get()!.n).toBe(1);}finally{live.close();}});
it("S8 marks implicit primary index is accepted",async()=>{const f=await fixture(false),db=new DatabaseSync(f.file);try{expect(()=>inspectInstallationDatabase(db)).not.toThrow();expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='sqlite_autoindex_restore_job_marks_1'").get()!.name).toBe("sqlite_autoindex_restore_job_marks_1");}finally{db.close();}});
it.each(["restore_job_marks","restore_boot_wait"])("S6 rejects additions to %s",async table=>{for(const sql of [`ALTER TABLE ${table} ADD COLUMN extra TEXT`,`CREATE INDEX extra ON ${table}(job_id)`,`CREATE TRIGGER extra AFTER INSERT ON ${table} BEGIN SELECT 1; END`]){const f=await fixture(),db=new DatabaseSync(f.file);try{db.exec(sql);expect(()=>inspectInstallationDatabase(db)).toThrowError(expect.objectContaining({code:"DATABASE_SCHEMA_UNSUPPORTED"}));}finally{db.close();}}});
it("P2 owner stage drops a seeded notice for its own job",async()=>{const f=await fixture();const archives=join(f.root,"archives");mkdirSync(join(archives,"arc"),{recursive:true});copyFileSync(f.file,join(archives,"arc","messages.db"));const fx=sqliteRestoreEffects({liveDb:f.file,archivesDir:archives}),job={version:1 as const,id:"B",archiveId:"arc",source:"owner",phase:"captured" as const,at:1};fx.stage(job);fx.install(job);fx.prepare(job);const db=new DatabaseSync(f.file);try{expect(tables(db)).toEqual(["restore_job_marks"]);}finally{db.close();}});
it("P1 Cloud reset marker drops a copied notice",async()=>{const f=await fixture(),db=new DatabaseSync(f.file);db.exec("CREATE TABLE restore_pending(reset_id TEXT PRIMARY KEY,operation TEXT NOT NULL,at INTEGER NOT NULL);INSERT INTO restore_pending VALUES('reset','undo',1)");db.close();expect(consumeRestoreMarker(f.data)).toBe(true);const after=new DatabaseSync(f.file);try{expect(tables(after)).toEqual(["restore_job_marks"]);}finally{after.close();}});

it("S5p archive preparation drops both metadata tables",async()=>{
 const f=await fixture(),bytes=readFileSync(f.file),hash=createHash("sha256").update(bytes).digest("hex"),archive=join(f.root,"seeded.zip");
 const manifest={format:"murage.installation",version:1,snapshotId:randomUUID(),createdAt:new Date().toISOString(),restorePolicy:"paused-review-required",files:[{path:"messages.db",bytes:bytes.length,sha256:hash}],omitted:[],missing:[],database:{status:"copied",messages:0,threads:0,bytes:bytes.length,sha256:hash}};
 const zip=new ZipFile(),output=pipeline(zip.outputStream as Readable,createWriteStream(archive));zip.addBuffer(Buffer.from(JSON.stringify(manifest)),"manifest.json",{compress:false});zip.addBuffer(bytes,"state/messages.db",{compress:false,mode:0o100600});zip.end();await output;
 const prepared=await prepareInstallationRestore(archive,f.root),db=new DatabaseSync(join(prepared.stateDirectory,"messages.db"));try{expect(tables(db)).toEqual([]);}finally{db.close();}
});

import {EmailStore} from "./email/email-store.ts";
import {RestoreJobStore} from "./email/restore-job.ts";
import * as publishEffects from "./email/restore-job-effects.ts";
import {statSync,unlinkSync,writeFileSync} from "node:fs";
it("F1 full database cannot break preparation or the restored email state",async()=>{
 const results:any[]=[];
 for(const phase of ["control","positive","full"]){
  const f=await fixture(false),db=new DatabaseSync(f.file);new EmailStore(db);db.exec("DELETE FROM restore_job_marks WHERE kind='prepared';INSERT INTO email_bindings(bot_id,state,policy,revision,updated_at) VALUES ('bot','removing','{}',0,1);VACUUM;PRAGMA journal_mode=WAL");expect(db.prepare("PRAGMA freelist_count").get()!.freelist_count).toBe(0);const pages=Number(db.prepare("PRAGMA page_count").get()!.page_count);db.close();
  writeFileSync(join(f.data,"restore-job.json"),JSON.stringify({version:1,id:"B",archiveId:"arc",source:"owner",phase:"swapped",at:1}));
  const opened:Array<{kind:string;cap:number}>=[];
  const open=(kind:string)=>(path:string,opts?:any)=>{const conn=new DatabaseSync(path,opts??{});if(phase!=="positive")conn.exec(`PRAGMA max_page_count=${pages}`);opened.push({kind,cap:Number(conn.prepare("PRAGMA max_page_count").get()!.max_page_count)});return conn;};
  const fx=sqliteRestoreEffects({liveDb:f.file,archivesDir:f.root,now:()=>1800000000000,openLive:open("prepare")});let n=0,m=0;const logs:string[]=[];
  const s:any=new RestoreJobStore({dir:f.data,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),dataOpsLock:{acquire:()=>phase==="control"||++n>1,release:()=>{}},mono:()=>m,sleepSync:(ms:number)=>{m+=ms;},now:()=>1800000000000,bootTime:()=>1000,bootId:()=>"boot-A",log:(l:string)=>logs.push(l),publish:(req:any)=>{const result=Promise.resolve().then(()=>(publishEffects as any).publishBootWaitRow(open("publish"),statSync,req));return {result,terminate:()=>{},exited:result.then(()=>{})};}} as any);
  expect(s.recover(),phase).toEqual({action:"prepared"});await(s.publishSettled?.()??s.recordsSettled());
  if(phase==="full"){expect(opened.map(r=>r.kind)).toEqual(["prepare","publish"]);expect(opened.every(r=>r.cap===pages)).toBe(true);}
  try{unlinkSync(join(f.data,"restore-boot-wait.json"));}catch{}
  const check=new DatabaseSync(f.file);try{const parks=check.prepare("SELECT * FROM email_parks").all().map(({park_id,...r})=>{expect(park_id).toMatch(/^[0-9a-f-]{36}$/);return r;});results.push({parks,bindings:check.prepare("SELECT * FROM email_bindings").all(),marks:check.prepare("SELECT * FROM restore_job_marks ORDER BY kind").all()});expect(check.prepare("SELECT 1 FROM sqlite_master WHERE name='restore_boot_wait'").get()!==undefined).toBe(phase==="positive");}finally{check.close();}
  if(phase==="positive")expect(s.bootWaitLine()).toContain("waited");else expect(s.bootWaitLine()).toBeNull();
  if(phase==="full")expect(logs.filter(l=>l.includes("failed:SQLITE_FULL"))).toHaveLength(1);
 }
 expect(results[2]).toEqual(results[0]);expect(results[1]).toEqual(results[0]);
});

it("F2 rollback trigger cannot break preparation or the restored email state",async()=>{
 const results:any[]=[];
 for(const phase of ["control","positive","full"]){
  const f=await fixture(false),db=new DatabaseSync(f.file);new EmailStore(db);db.exec("DELETE FROM restore_job_marks WHERE kind='prepared';INSERT INTO email_bindings(bot_id,state,policy,revision,updated_at) VALUES ('bot','removing','{}',0,1);VACUUM;PRAGMA journal_mode=WAL");expect(db.prepare("PRAGMA freelist_count").get()!.freelist_count).toBe(0);if(phase!=="positive"){db.exec(DDL);db.exec("CREATE TRIGGER t BEFORE INSERT ON restore_boot_wait BEGIN SELECT RAISE(ROLLBACK, 'x'); END");}db.close();
  writeFileSync(join(f.data,"restore-job.json"),JSON.stringify({version:1,id:"B",archiveId:"arc",source:"owner",phase:"swapped",at:1}));
  const opened:Array<{kind:string;cap:number}>=[];
  const open=(kind:string)=>(path:string,opts?:any)=>{const conn=new DatabaseSync(path,opts??{});opened.push({kind,cap:Number(conn.prepare("PRAGMA max_page_count").get()!.max_page_count)});return conn;};
  const fx=sqliteRestoreEffects({liveDb:f.file,archivesDir:f.root,now:()=>1800000000000,openLive:open("prepare")});let n=0,m=0;const logs:string[]=[];
  const s:any=new RestoreJobStore({dir:f.data,effects:fx,isLocalArchive:()=>true,captureCarry:()=>({}),dataOpsLock:{acquire:()=>phase==="control"||++n>1,release:()=>{}},mono:()=>m,sleepSync:(ms:number)=>{m+=ms;},now:()=>1800000000000,bootTime:()=>1000,bootId:()=>"boot-A",log:(l:string)=>logs.push(l),publish:(req:any)=>(publishEffects as any).workerPublish(req)} as any);
  expect(s.recover(),phase).toEqual({action:"prepared"});await(s.publishSettled?.()??s.recordsSettled());
  if(phase==="full"){expect(opened.map(r=>r.kind)).toEqual(["prepare"]);}
  try{unlinkSync(join(f.data,"restore-boot-wait.json"));}catch{}
  const check=new DatabaseSync(f.file);try{const parks=check.prepare("SELECT * FROM email_parks").all().map(({park_id,...r})=>{expect(park_id).toMatch(/^[0-9a-f-]{36}$/);return r;});results.push({parks,bindings:check.prepare("SELECT * FROM email_bindings").all(),marks:check.prepare("SELECT * FROM restore_job_marks ORDER BY kind").all()});expect(check.prepare("SELECT count(*) n FROM restore_boot_wait").get()!.n).toBe(phase==="positive"?1:0);}finally{check.close();}
  if(phase==="positive")expect(s.bootWaitLine()).toContain("waited");else expect(s.bootWaitLine()).toBeNull();
  if(phase==="full")expect(logs.filter(l=>l.includes("failed:SQLITE_CONSTRAINT"))).toHaveLength(1);
 }
 expect(results[2]).toEqual(results[0]);expect(results[1]).toEqual(results[0]);
});
