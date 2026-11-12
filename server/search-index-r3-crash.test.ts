import { removeTempDirSync } from "./testing/cleanup.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import * as search from "./testing/search-index-compat.ts";
import { MESSAGE_SEARCH_DDL } from './testing/search-index-compat.ts';
import { mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,dirname } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync,backup } from "node:sqlite";
import { afterEach,it } from "vitest";
import { expect } from "./testing/search-index-oracle.ts";
import { initializeMessageTables } from "./message-tables.ts";
const cleanups:Array<()=>unknown>=[];
afterEach(async()=>{for(const f of cleanups.splice(0).reverse())await f();});
function fixture(){const dir=mkdtempSync(join(tmpdir(),"murage-search-crash-"));cleanups.push(()=>removeTempDirSync(dir));const file=join(dir,"messages.db"),db=new DatabaseSync(file);cleanups.push(()=>db.close());db.exec("PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;PRAGMA secure_delete=ON");initializeMessageTables(db);return{dir,file,db};}
async function killAt(file:string,mode:string){
  const child=spawn(process.execPath,["--experimental-strip-types","server/testing/search-index-r3-crash-child.ts",file,mode],{stdio:["ignore","pipe","pipe"]});
  let output="",error="";child.stdout.on("data",b=>output+=String(b));child.stderr.on("data",b=>error+=String(b));
  cleanups.push(()=>{if(child.exitCode===null)child.kill("SIGKILL");});
  const exit=once(child,"exit");const deadline=Date.now()+10_000;
  while(!output.includes("BARRIER")){if(child.exitCode!==null||Date.now()>deadline)throw Error("barrier "+mode+": "+output+error);await new Promise(r=>setTimeout(r,10));}
  // Capture both files and WALs BEFORE kill, connection close, or repair.
  const captured=join(process.cwd(),".fts-r3-evidence","crash",mode);mkdirSync(captured,{recursive:true});
  for(const name of ["messages.db","messages.db-wal","search.db","search.db-wal"]){
    const path=join(dirname(file),name);if(existsSync(path))writeFileSync(join(captured,name),readFileSync(path));
  }
  child.kill("SIGKILL");await exit;
}
for(const [id,mode,committed,drop] of [["C1","owner-sync-before",false,false],["C2","owner-sync-after",true,false],["C3","owner-drop-before",false,true],["C4","owner-drop-after",true,true]] as const){
  it(`${id}: SIGKILL ${mode} preserves exactly the committed message/intent pair`,async()=>{
    const {file,db}=fixture();if(drop)db.exec("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','old',1,'user','text','secret','{}')");
    await killAt(file,mode);
    expect(db.prepare("PRAGMA quick_check").get()!.quick_check, 'ORACLE:'+id).toBe("ok");
    expect(search.intentCount(db), 'ORACLE:'+id).toBe(committed?1:0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()!.n, 'ORACLE:'+id).toBe(drop?(committed?0:1):(committed?1:0));
    if(drop&&committed){
      const captured=readFileSync(join(".fts-r3-evidence","crash",mode,"messages.db-wal"));expect(captured.includes(Buffer.from("secret")), 'ORACLE:'+id).toBe(true);
      const scrub=db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!;expect(scrub.busy, 'ORACLE:'+id).toBe(0);
      expect(readFileSync(file).includes(Buffer.from("secret")), 'ORACLE:'+id).toBe(false);
      const copy=file+".published";db.prepare("VACUUM INTO ?").run(copy);expect(readFileSync(copy).includes(Buffer.from("secret")), 'ORACLE:'+id).toBe(false);
    }
  });
}
// Integration gates: B2 owns restore, copy scrubbing and offline downgrade.
// These are deliberately not reported GREEN on a core-only SHA.
// TEST is preserved by the ambient-runtime environment scrubber.
const merged=!!(process.env.MURAGE_TEST_FTS_MERGED_SHA ?? process.env.MURAGE_FTS_MERGED_SHA);
for(const id of ["C16","C18"])it.skipIf(!merged)(`${id}: same-owner restore / downgrade return resets a killed worker's stale index (merged SHA)`,async()=>{
  const {dir,file,db}=fixture();
  // Exact legacy writer: no intent emission; its CREATE is the downgrade signal.
  db.exec("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','old',1,'user','text','originalcanary','{}')");
  db.prepare("INSERT INTO transcript_index_state(name,done,cursor,skipped) VALUES('search_owner','same-owner',0,0)").run();
  const saved=join(dir,"backup.db");await backup(db,saved);
  const original=readFileSync(saved);
  const api=await import("./testing/search-index-compat.ts");api.startSearchIndex(db,file);
  const settled=async()=>{const until=Date.now()+15000;while(api.searchCleanupPending(db)){if(Date.now()>until)throw Error("integration rebuild timeout");await new Promise(r=>setTimeout(r,20));}};
  await settled();
  const state=()=>{const a=new DatabaseSync(join(dir,"search.db"),{readOnly:true});try{return a.prepare("SELECT v FROM search_state WHERE k='index_id'").get()!.v;}finally{a.close();}};
  const before=state();db.exec("BEGIN;UPDATE messages SET text='editedcanary' WHERE rowid=1");api.syncMessageSearchRow(db,1,"editedcanary");db.exec("COMMIT");await settled();await api.stopSearchIndex();
  if(id==="C16"){
    // Close main before file replacement. This is an isolated retained backup.
    db.close();cleanups[1]=()=>{};
    for(const suffix of ["-wal","-shm"])rmSync(file+suffix,{force:true});writeFileSync(file,original);
  }else{
    db.exec(MESSAGE_SEARCH_DDL);db.exec("DELETE FROM messages;INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','new',2,'user','text','originalcanary','{}')");
    api.settleInheritedSearchMerge(db,false);db.close();cleanups[1]=()=>{};
  }
  const reopened=new DatabaseSync(file);cleanups.push(()=>reopened.close());api.startSearchIndex(reopened,file);cleanups.push(()=>api.stopSearchIndex());
  const until=Date.now()+15000;
  while(!api.messageSearchIndexReady(reopened)||api.readMessageSearchCandidates(reopened,api.trigramQuery("originalcanary"),10).partial){if(Date.now()>until)throw Error("integration reset timeout");await new Promise(r=>setTimeout(r,20));}
  expect(state(), 'ORACLE:'+id).not.toBe(before);
  expect(api.readMessageSearchCandidates(reopened,api.trigramQuery("editedcanary"),10).rowids, 'ORACLE:'+id).toEqual([]);
  expect(api.readMessageSearchCandidates(reopened,api.trigramQuery("originalcanary"),10).rowids, 'ORACLE:'+id).toHaveLength(1);
},45000);

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { stopDataWriters } from "./data-writers.ts";
it("T-WIPE-LIVE / M32: lease release joins the actual recreating search worker",async()=>{
  const {dir,db}=fixture();
  const worker=new Worker("const{parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');const tick=()=>fs.writeFileSync(workerData,'postings');tick();const timer=setInterval(tick,5);parentPort.postMessage('ready');parentPort.on('message',()=>setTimeout(()=>{clearInterval(timer);parentPort.close();},50));",{eval:true,workerData:join(dir,"search.db")});
  cleanups.push(()=>worker.terminate());await once(worker,"message");let exited=false;
  const exit=once(worker,"exit").then(()=>{exited=true;return true;});
  const ok=await stopDataWriters({closeDatabase:()=>{db.close();},stopEngineHistory:async()=>true,stopWalMaintenance:async()=>true,stopSearchIndex:()=>{worker.postMessage("stop");return exit;}});
  expect(ok, "ORACLE:T-WIPE-LIVE").toBe(true);expect(exited, "ORACLE:T-WIPE-LIVE").toBe(true);
  rmSync(join(dir,"search.db"),{force:true});await new Promise(r=>setTimeout(r,30));expect(existsSync(join(dir,"search.db")), "ORACLE:T-WIPE-LIVE").toBe(false);
  // The explicit close above is part of the shutdown oracle.
  cleanups[1]=()=>{};
});

for(const [id,barrier,phase]of [["C6","drop-after-commit","0"],["C7b","drop-last",undefined],["C8","merge-prove","0"],["C9","merge-after-commit","1"],["C10","after-scrub","1"]]as const)it(`${id}: SIGKILL search worker process at ${barrier} retains exact durable cursor/debt`,{timeout:30000},async()=>{
  const {dir,file,db}=fixture(),api=await import("./testing/search-index-compat.ts");
  for(let i=1;i<=(id==="C7b"?300:1);i++){db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t',?,?, 'user','text','qzvxkjw','{}')").run("m"+i,i);api.syncMessageSearchRow(db,i,"qzvxkjw");}
  api.startSearchIndex(db,file);const wait=async()=>{const until=Date.now()+15000;while(api.searchCleanupPending(db)){if(Date.now()>until)throw Error("seed index timeout");await new Promise(r=>setTimeout(r,20));}};
  await wait();await api.stopSearchIndex();
  db.exec("BEGIN");api.dropThreadSearchRows(db,"t");db.exec("DELETE FROM messages;COMMIT");
  expect(search.intentCount(db),'ORACLE:'+id + " " + ("drop/reset recovery reference survives before process termination")).toBeGreaterThan(0);
  await killAt(file,barrier);
  if(id==="C10")expect(readFileSync(join(".fts-r3-evidence","crash",barrier,"search.db-wal")).length, 'ORACLE:'+id).toBe(0);
  const a=new DatabaseSync(join(dir,"search.db"));
  try{
    const state=Object.fromEntries(a.prepare("SELECT k,v FROM search_state").all().map(r=>[String(r.k),String(r.v)]));
    if(id==="C7b"){expect(state.drop_cursor, 'ORACLE:'+id).toBe("256");expect(state.debt, 'ORACLE:'+id).toBeUndefined();}
    else{expect(state.drop_cursor, 'ORACLE:'+id).toBeUndefined();expect(state.debt, 'ORACLE:'+id).toMatch(new RegExp(":"+phase+"$"));}
    expect(a.prepare("PRAGMA quick_check").get()!.quick_check, 'ORACLE:'+id).toBe("ok");a.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
  }finally{a.close();}
  api.startSearchIndex(db,file);cleanups.push(()=>api.stopSearchIndex());await wait();
  const repaired=new DatabaseSync(join(dir,"search.db"),{readOnly:true});try{expect(repaired.prepare("SELECT 1 FROM docs LIMIT 1").get(), 'ORACLE:'+id).toBeUndefined();expect(repaired.prepare("SELECT v FROM search_state WHERE k='debt'").get(), 'ORACLE:'+id).toBeUndefined();}finally{repaired.close();}
});
for(const barrier of ["reset-before-delete","reset-after-wal-delete"])it(`C15': SIGKILL ${barrier} never replays stale WAL into a new index`,async()=>{
  const {dir,file,db}=fixture();
  const stale=new DatabaseSync(join(dir,"search.db"));
  stale.exec(MESSAGE_SEARCH_DDL);stale.exec("CREATE TABLE search_state(k TEXT PRIMARY KEY,v TEXT NOT NULL);INSERT INTO search_state VALUES('owner','stale-owner');INSERT INTO search_state VALUES('index_id','stale-index');INSERT INTO messages_fts(rowid,t) VALUES(99,'stalecanary')");stale.close();
  search.syncMessageSearchRow(db,0,null);
  expect(search.intentCount(db),"ORACLE:C15'" + " " + ("reset lineage reference survives before unlink")).toBeGreaterThan(0);
  await killAt(file,barrier);
  const api=await import("./testing/search-index-compat.ts");api.startSearchIndex(db,file);cleanups.push(()=>api.stopSearchIndex());
  const until=Date.now()+15000;while(!api.messageSearchIndexReady(db)||api.searchCleanupPending(db)){if(Date.now()>until)throw Error("reset crash recovery timeout");await new Promise(r=>setTimeout(r,20));}
  const a=new DatabaseSync(join(dir,"search.db"),{readOnly:true});try{expect(a.prepare("PRAGMA quick_check").get()!.quick_check, "ORACLE:C15'").toBe("ok");expect(a.prepare("SELECT 1 FROM docs LIMIT 1").get(), "ORACLE:C15'").toBeUndefined();expect(a.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(api.trigramQuery("stalecanary")), "ORACLE:C15'").toEqual([]);}finally{a.close();}
});
it("C12: SIGKILL after R0 COMMIT preserves the inert table and rotated identity",async()=>{
  const {file,db}=fixture();db.exec(MESSAGE_SEARCH_DDL);db.exec("INSERT INTO messages_fts(rowid,t) VALUES(1,'legacy marker')");
  await killAt(file,"retire-after-commit");
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts'").get(), "ORACLE:C12").toBeUndefined();expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts_retired'").get(), "ORACLE:C12").toBeDefined();
  const owner=db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done;
  const api=await import("./testing/search-index-compat.ts");api.settleInheritedSearchMerge(db,false);expect(db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done, "ORACLE:C12").toBe(owner);expect(api.searchRetirementPending(db), "ORACLE:C12").toBe(true);
});
