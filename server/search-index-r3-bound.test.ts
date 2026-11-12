// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "./testing/cleanup.ts";
import { mkdtempSync, readFileSync, statSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, it } from "vitest";
import { expect } from "./testing/search-index-oracle.ts";
import { initializeMessageTables } from "./message-tables.ts";
import * as search from "./testing/search-index-compat.ts";
import * as wal from "./wal-maintenance.ts";

const cleanup:Array<()=>unknown>=[];
afterEach(async()=>{await wal.stopWalMaintenance(100,1000);for(const f of cleanup.splice(0).reverse())await f();});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),"murage-search-bound-")); cleanup.push(()=>removeTempDirSync(dir));
  const file=join(dir,"messages.db"),db=new DatabaseSync(file);cleanup.push(()=>db.close());
  db.exec("PRAGMA journal_mode=WAL;PRAGMA secure_delete=ON;PRAGMA wal_autocheckpoint=0;PRAGMA journal_size_limit=0");
  initializeMessageTables(db);return{db,file,dir};
}
it("T-BOUND: 1k vs 1.04M history changes neither added statements nor owner FTS work",()=>{
  const observations:Array<{statements:number;frames:number}>=[];
  for(const n of [1000,1_040_000]) {
    const {db,file}=fixture();
    db.prepare("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'history',CAST(x AS TEXT),x,'user','text','common trigram repeated','{}' FROM n").run(n);
    const before=statSync(file+"-wal").size;let statements=0;
    const ownerSql:string[]=[];const prepare=db.prepare.bind(db);db.prepare=(sql:string)=>{statements++;ownerSql.push(sql);return prepare(sql);};
    db.exec("BEGIN IMMEDIATE");search.syncMessageSearchRow(db,n+1,"x");search.pruneMessageSearchIntents(db);db.exec("COMMIT");
    expect(ownerSql, "ORACLE:T-BOUND").not.toContainEqual(expect.stringMatching(/messages_fts|checkpoint|optimize|merge/i));
    const frames=(statSync(file+"-wal").size-before)/4120;
    observations.push({statements,frames}); db.prepare=prepare;
    const queryPlan=db.prepare("EXPLAIN QUERY PLAN "+search.PRUNE_SQL).all(100,2).map(row=>String(row.detail)).join(" ");
    expect(queryPlan, "ORACLE:T-BOUND").not.toMatch(/SCAN (?:messages|search_intents|messages_fts)/);
  }
  expect(observations[0].statements, "ORACLE:T-BOUND").toBe(observations[1].statements);
  expect(Math.abs(observations[0].frames-observations[1].frames), "ORACLE:T-BOUND").toBeLessThanOrEqual(2);
},90_000);
it("T-INTENT-SIZE: 72-byte keys have no overflow cells in the queue B-tree",()=>{
  const {db,file}=fixture();
  db.exec("BEGIN");for(let i=0;i<4000;i++)search.dropThreadSearchRows(db,"k".repeat(72));db.exec("COMMIT");
  // Checkpoint only in this offline test oracle, never on a serving connection.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(search.intentCount(db),"ORACLE:T-INTENT-SIZE" + " " + ("fixed references persisted")).toBe(4000);
  const root=Number(db.prepare("SELECT rootpage FROM sqlite_schema WHERE name='search_intents'").get()!.rootpage);
  const bytes=readFileSync(file);const size=bytes.readUInt16BE(16)||65536;
  function varint(offset:number):[bigint,number]{let n=0n;for(let i=0;i<9;i++){const b=bytes[offset+i];n=i===8?(n<<8n)|BigInt(b):(n<<7n)|BigInt(b&127);if(i===8||b<128)return[n,i+1];}throw Error("varint");}
  let rows=0;
  function page(number:number){const base=(number-1)*size,head=base+(number===1?100:0),kind=bytes[head],count=bytes.readUInt16BE(head+3);
    expect([5,13], "ORACLE:T-INTENT-SIZE").toContain(kind);
    for(let i=0;i<count;i++){const cell=base+bytes.readUInt16BE(head+(kind===5?12:8)+i*2);if(kind===5)page(bytes.readUInt32BE(cell));else{const[payload]=varint(cell);expect(Number(payload), "ORACLE:T-INTENT-SIZE").toBeLessThanOrEqual(search.INTENT_MAX_BYTES);rows++;}}
    if(kind===5)page(bytes.readUInt32BE(head+8));
  }
  page(root);expect(rows, "ORACLE:T-INTENT-SIZE").toBe(4000);
});
it("T-CKPT-DOWN / M24: refusal never enables an implicit checkpoint after a 50k-frame reader releases",()=>{
  const {db,file}=fixture();const settings:number[]=[];
  wal.startWalMaintenance(file,{nudge:async()=>false,setAutocheckpoint:pages=>{settings.push(pages);db.exec(`PRAGMA wal_autocheckpoint=${pages}`);},journalSizeLimit:()=>-1,pinJournalSizeLimit:()=>{}});
  expect(settings.length, "ORACLE:T-CKPT-DOWN").toBeGreaterThan(0); expect(settings.every(n=>n===0), "ORACLE:T-CKPT-DOWN").toBe(true);
  const reader=new DatabaseSync(file,{readOnly:true});cleanup.push(()=>reader.close());
  reader.exec("BEGIN");reader.prepare("SELECT * FROM messages LIMIT 1").all();
  db.exec("CREATE TABLE large_wal(x BLOB)");
  db.exec("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000) INSERT INTO large_wal SELECT zeroblob(4096) FROM n");
  const walBytes=statSync(file+"-wal").size;expect(walBytes/4120, "ORACLE:T-CKPT-DOWN").toBeGreaterThan(50000);
  reader.exec("COMMIT");const mainBytes=statSync(file).size;
  search.syncMessageSearchRow(db,1,"x");
  expect(statSync(file).size, "ORACLE:T-CKPT-DOWN").toBe(mainBytes);
  expect(statSync(file+"-wal").size, "ORACLE:T-CKPT-DOWN").toBeGreaterThanOrEqual(walBytes);
  expect(db.prepare("PRAGMA wal_autocheckpoint").get()!.wal_autocheckpoint, "ORACLE:T-CKPT-DOWN").toBe(0);
},90_000);
it("T-CKPT-ADMISSION: failed recovery bounds continued log growth; recovery admits the next turn",()=>{
  const dir=mkdtempSync(join(tmpdir(),"murage-wal-admission-"));cleanup.push(()=>removeTempDirSync(dir));
  const file=join(dir,"messages.db");writeFileSync(file+"-wal","");truncateSync(file+"-wal",wal.WAL_ADMISSION_BYTES);
  expect(()=>search.assertWalWriteAdmission(file), "ORACLE:T-CKPT-ADMISSION").toThrow(/Busy/);
  truncateSync(file+"-wal",0);expect(()=>search.assertWalWriteAdmission(file), "ORACLE:T-CKPT-ADMISSION").not.toThrow();
});
it("T-NO-FTS-MAIN: open/readiness/fallback sites disable autocheckpoint; only migrating-before-listen checkpoint is permitted",()=>{
  const database=readFileSync("server/database.ts","utf8"),maintenance=readFileSync("server/wal-maintenance.ts","utf8");
  expect(database, "ORACLE:T-NO-FTS-MAIN").not.toContain("wal_autocheckpoint=1000");expect(maintenance, "ORACLE:T-NO-FTS-MAIN").not.toMatch(/setAutocheckpoint\(1000\)/);
  expect(database.match(/db.exec\("PRAGMA wal_checkpoint\(TRUNCATE\)"\)/g), "ORACLE:T-NO-FTS-MAIN").toHaveLength(1);
  expect(database, "ORACLE:T-NO-FTS-MAIN").toMatch(/if \(migrating\) \{[\s\S]*?db.exec\("PRAGMA wal_checkpoint\(TRUNCATE\)"\)/);
  expect(maintenance, "ORACLE:T-NO-FTS-MAIN").not.toMatch(/(?:messages_fts|search_merge|merge-slice|merge-prove|scrub-done)/);
  expect(readFileSync("server/message-db.ts","utf8"), "ORACLE:T-NO-FTS-MAIN").not.toMatch(/(?:INSERT INTO|DELETE FROM|UPDATE) messages_fts/);
});
it("T-BOUND-BYTES: a 50k-row drop is applied before a one-character send prunes at most two references",{timeout:90000},async()=>{
  const {db,file}=fixture();
  db.exec("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<50000) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'drop',CAST(x AS TEXT),x,'user','text','drop common trigram','{}' FROM n");
  search.startSearchIndex(db,file);cleanup.push(()=>search.stopSearchIndex());
  const drain=async()=>{const deadline=Date.now()+60000;while(search.searchCleanupPending(db)){if(Date.now()>deadline)throw Error("50k worker drain timeout");await new Promise(r=>setTimeout(r,20));}};
  await drain();db.exec("BEGIN IMMEDIATE");search.dropThreadSearchRows(db,"drop");db.exec("DELETE FROM messages;COMMIT");await drain();
  const count=search.intentCount(db),prepare=db.prepare.bind(db);let statements=0;
  db.prepare=sql=>{statements++;expect(sql, "ORACLE:T-BOUND-BYTES").not.toMatch(/messages_fts|checkpoint|optimize/i);return prepare(sql);};
  db.exec("BEGIN IMMEDIATE");search.syncMessageSearchRow(db,1,"x");search.pruneMessageSearchIntents(db);db.exec("COMMIT");db.prepare=prepare;
  expect(statements, "ORACLE:T-BOUND-BYTES").toBeLessThanOrEqual(4);const after=search.intentCount(db);expect(count+1-after, "ORACLE:T-BOUND-BYTES").toBeLessThanOrEqual(2);
  expect(search.INTENT_MAX_BYTES*4, "ORACLE:T-BOUND-BYTES").toBe(480);
});
