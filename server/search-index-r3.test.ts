// SPDX-License-Identifier: AGPL-3.0-or-later
import { removeTempDirSync } from "./testing/cleanup.ts";
import { mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { afterEach, it, vi } from "vitest";
import { expect } from "./testing/search-index-oracle.ts";
import * as search from "./testing/search-index-compat.ts";
import { initializeMessageTables } from "./message-tables.ts";

vi.hoisted(()=>vi.resetModules());
vi.mock('node:worker_threads',async original=>{
 const module=await original<typeof import('node:worker_threads')>();
 return {...module,Worker:class extends module.Worker {
  constructor(source:string,options:import('node:worker_threads').WorkerOptions){
   // Instrument the reviewed worker's real busy checkpoint. No behaviour changes;
   // the amendment must be RED on its retry cadence, not absent event plumbing.
   if(!source.includes("send('scrub-busy'"))source=source.replace("    const r = a.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();", "    const r = a.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();if(Number(r.busy)!==0 || Number(r.log)!==Number(r.checkpointed))send('scrub-busy',{n:1,retryInMs:50});");
   super(source,options);
  }
 }};
});
const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "murage-search-r3-"));
  cleanups.push(() => removeTempDirSync(dir));
  const db = new DatabaseSync(join(dir, "messages.db"));
  cleanups.push(() => db.close());
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA secure_delete=ON");
  initializeMessageTables(db);
  return { dir, db };
}
it("T-BOUND-BYTES / T-NO-FTS-MAIN: owner sync writes a reference, never FTS", () => {
  const { db } = fixture();
  db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m',1,'user','text','secret','{}')").run();
  search.syncMessageSearchRow(db, 1, "secret");
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='messages_fts'").get(), "ORACLE:T-BOUND-BYTES ORACLE:T-NO-FTS-MAIN").toBeUndefined();
  expect(db.prepare("SELECT rowid,thread_key FROM search_intents").all(), "ORACLE:T-BOUND-BYTES ORACLE:T-NO-FTS-MAIN").toMatchObject([{ rowid: 1, thread_key: null }]);
  expect(db.prepare("PRAGMA table_info(search_intents)").all().map(row => row.name), "ORACLE:T-BOUND-BYTES ORACLE:T-NO-FTS-MAIN").not.toContain("text");
});
it("T-INTENT-SIZE / T-NO-PLAINTEXT: a large drop is one fixed-size reference", () => {
  const { db } = fixture();
  search.dropThreadSearchRows(db, "a".repeat(100_000));
  expect(search.intentCount(db), "ORACLE:T-INTENT-SIZE ORACLE:T-NO-PLAINTEXT").toBe(1);
  const row = db.prepare("SELECT seq,CAST(nonce AS TEXT) AS nonce,rowid,thread_key FROM search_intents").get()!;
  expect(Buffer.byteLength(String(row.thread_key)), "ORACLE:T-INTENT-SIZE ORACLE:T-NO-PLAINTEXT").toBeLessThanOrEqual(72);
  expect(Object.keys(row).sort(), "ORACLE:T-INTENT-SIZE ORACLE:T-NO-PLAINTEXT").toEqual(["nonce", "rowid", "seq", "thread_key"]);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='messages_fts'").get(), "ORACLE:T-INTENT-SIZE ORACLE:T-NO-PLAINTEXT").toBeUndefined();
});
it("C1 / C3: enqueue failure aborts the owner's transaction", () => {
  const { db } = fixture();
  db.exec("DROP TABLE IF EXISTS search_intents; BEGIN IMMEDIATE");
  try { expect(() => search.syncMessageSearchRow(db, 1, "secret"), "ORACLE:C1 ORACLE:C3").toThrow(); }
  finally { db.exec("ROLLBACK"); }
});
it("T-RETIRE: legacy FTS is inert; no optimize or shadow teardown on main", () => {
  const { db } = fixture();
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(t, tokenize='trigram',content='',contentless_delete=1,detail=none)");
  db.exec("INSERT INTO messages_fts(rowid,t) VALUES(1,'legacy qzv')");
  search.settleInheritedSearchMerge(db, false);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='messages_fts'").get(), "ORACLE:T-RETIRE").toBeUndefined();
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='messages_fts_retired'").get(), "ORACLE:T-RETIRE").toBeDefined();
  expect(db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get(), "ORACLE:T-RETIRE").toBeDefined();
});

import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { randomUUID,randomBytes } from "node:crypto";
import { SEARCH_INDEX_WORKER_SOURCE } from "./testing/search-index-compat.ts";
import { MESSAGE_SEARCH_DDL } from "./testing/search-index-compat.ts";

async function until(test: () => boolean, why = "worker progress"): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!test() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(test(), why).toBe(true);
}
function add(db: DatabaseSync, rowid: number, text: string, thread = "t") {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT OR REPLACE INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?,?)")
      .run(rowid, thread, "m" + rowid, rowid, "user", "text", text, JSON.stringify({ id: "m" + rowid, role: "user", kind: "text", text, at: rowid }));
    search.syncMessageSearchRow(db, rowid, text); db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
function index(dir: string) { const db = new DatabaseSync(join(dir, "search.db")); cleanups.push(() => db.close()); return db; }
function value(db: DatabaseSync, k: string) { return db.prepare("SELECT v FROM search_state WHERE k=?").get(k)?.v; }
function matches(db: DatabaseSync, text: string) { return db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?").all(search.trigramQuery(text)).map(r => Number(r.rowid)); }
async function controlled(db: DatabaseSync, dir: string, barrier?: { name: string; shared: SharedArrayBuffer },mergePages=64) {
  search.prepareMessageSearchBackfill(db);
  const token = randomUUID();
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  const worker = new Worker(SEARCH_INDEX_WORKER_SOURCE, { eval: true, workerData: { file: join(dir,"messages.db"), searchFile: join(dir,"search.db"), ddl: MESSAGE_SEARCH_DDL, token, barrier, readOnlyProbe:true, mergePages } });
  const errors: string[] = [];
  worker.on("error", error => errors.push(String(error)));
  worker.on("message", event => {
    events.push(event);
    if (event.type === "reset-needed") {
      const nonce = 42;
      const r = db.prepare("INSERT INTO search_intents(nonce,rowid) VALUES(?,0)").run(nonce);
      worker.postMessage({ type: "reset", token, marker: { seq: Number(r.lastInsertRowid), nonce: String(nonce) } });
    }
  });
  cleanups.push(async () => { await worker.terminate(); });
  await until(() => events.some(e => e.type === "ready") || errors.length > 0, "ready: " + JSON.stringify(events));
  expect(errors).toEqual([]);
  return {
    worker, events,
    async step() {
      const before = events.filter(e => e.type === "stepped").length;
      worker.postMessage({ type: "step", token });
      await until(() => events.filter(e => e.type === "stepped").length > before || events.some(e => e.type === "failure"), "step: " + JSON.stringify(events));
      expect(events.filter(e => e.type === "failure")).toEqual([]);
    },
    postStep() { worker.postMessage({ type: "step", token }); },
  };
}
async function automatic(db: DatabaseSync, dir: string) {
  search.searchIndexTestHooks.halted = true;
  search.startSearchIndex(db, join(dir,"messages.db"));
  cleanups.push(async () => { search.searchIndexTestHooks.halted = false; search.searchIndexTestHooks.event = null; search.searchIndexTestHooks.barrier = null; search.searchIndexTestHooks.candidateSnapshot=null; await search.stopSearchIndex(); });
  await until(() => search.messageSearchIndexReady(db));
}

it("T-SEARCH-PENDING / T-SEARCH-INTENT-CAP / T-SEARCH-PARTIAL / C2: pending sync is found while a huge drop backlog is capped before filtering", async () => {
  const { db, dir } = fixture();
  await automatic(db,dir);
  add(db,1,"pending needle");
  const initial=search.readMessageSearchCandidates(db,search.trigramQuery("needle"),10);
  expect(initial.rowids, "ORACLE:T-SEARCH-PENDING ORACLE:T-SEARCH-INTENT-CAP ORACLE:T-SEARCH-PARTIAL ORACLE:C2").toContain(1);expect(initial.partial, "ORACLE:T-SEARCH-PENDING ORACLE:T-SEARCH-INTENT-CAP ORACLE:T-SEARCH-PARTIAL ORACLE:C2").toBe(true);expect(search.messageSearchIndexReady(db), "ORACLE:T-SEARCH-PENDING ORACLE:T-SEARCH-INTENT-CAP ORACLE:T-SEARCH-PARTIAL ORACLE:C2").toBe(true);
  console.log("[fts-partial] rebuilding",initial.partial);
  db.exec("BEGIN"); for (let i=0;i<2100;i++) search.dropThreadSearchRows(db,"d"+i); db.exec("COMMIT");
  const page = search.readMessageSearchCandidates(db,search.trigramQuery("needle"),10);
  expect(page.partial, "ORACLE:T-SEARCH-PENDING ORACLE:T-SEARCH-INTENT-CAP ORACLE:T-SEARCH-PARTIAL ORACLE:C2").toBe(true); expect(page.rowids, "ORACLE:T-SEARCH-PENDING ORACLE:T-SEARCH-INTENT-CAP ORACLE:T-SEARCH-PARTIAL ORACLE:C2").not.toContain(1);
  const plan = db.prepare("EXPLAIN QUERY PLAN " + search.PENDING_SQL).all(0,2001).map(r => String(r.detail)).join(" ");
  expect(plan, "ORACLE:T-SEARCH-PENDING ORACLE:T-SEARCH-INTENT-CAP ORACLE:T-SEARCH-PARTIAL ORACLE:C2").toMatch(/SEARCH search_intents USING INTEGER PRIMARY KEY/); expect(plan, "ORACLE:T-SEARCH-PENDING ORACLE:T-SEARCH-INTENT-CAP ORACLE:T-SEARCH-PARTIAL ORACLE:C2").not.toMatch(/SCAN search_intents/);
});
it("T-SEARCH-REUSE / C6: live verification candidates converge on reused rowids and edited text", async () => {
  const { db,dir }=fixture(); add(db,1,"old alpacas","old");
  const run=await controlled(db,dir); await run.step(); const a=index(dir);
  expect(matches(a,"alpacas"), "ORACLE:T-SEARCH-REUSE ORACLE:C6").toEqual([1]);
  db.exec("BEGIN"); search.dropThreadSearchRows(db,"old"); db.exec("DELETE FROM messages"); db.exec("COMMIT");
  add(db,1,"new llamas","new");
  await run.step(); await run.step();
  expect(matches(a,"alpacas"), "ORACLE:T-SEARCH-REUSE ORACLE:C6").toEqual([]); expect(matches(a,"llamas"), "ORACLE:T-SEARCH-REUSE ORACLE:C6").toEqual([1]);
  expect(a.prepare("SELECT thread_key FROM docs WHERE rowid=1").get()!.thread_key, "ORACLE:T-SEARCH-REUSE ORACLE:C6").toBe(search.threadKey("new"));
});
it("T-IDENTITY-ROLLBACK / C17: pruned lineage in an older surviving search.db forces a fresh index", async () => {
  const { db,dir }=fixture(); add(db,1,"first qzv");
  let run=await controlled(db,dir); await run.step(); const a=index(dir);
  const oldId=value(a,"index_id"), saved=join(dir,"search-old.db");
  await backup(a,saved);
  add(db,2,"second jxk"); await run.step();
  db.prepare("DELETE FROM search_intents WHERE seq < ?").run(value(a,"applied_seq")!);
  await run.worker.terminate();
  // Replace the actual file with an older durable copy, after main pruned past
  // the copy's marker. Close every test handle before replacing sidecars.
  a.close(); cleanups.pop();
  for(const suffix of ["-wal","-shm"])rmSync(join(dir,"search.db")+suffix,{force:true});
  copyFileSync(saved,join(dir,"search.db"));
  run=await controlled(db,dir); expect(run.events.some(e=>e.type==="reset-needed"), "ORACLE:T-IDENTITY-ROLLBACK ORACLE:C17").toBe(true);
  const fresh=index(dir); expect(value(fresh,"index_id"), "ORACLE:T-IDENTITY-ROLLBACK ORACLE:C17").not.toBe(oldId);await run.step();expect(matches(fresh,"second"), "ORACLE:T-IDENTITY-ROLLBACK ORACLE:C17").toEqual([2]);
});
it("T-IDENTITY-ROLLBACK: same owner + reused seq with a different nonce fails lineage", async () => {
  const { db,dir }=fixture(); add(db,1,"first"); const run=await controlled(db,dir); await run.step();
  const a=index(dir); const oldId=value(a,"index_id"); await run.worker.terminate(); a.close(); cleanups.pop();
  // SQLite has no XOR operator: replace the retained marker without changing seq.
  db.exec("UPDATE search_intents SET nonce=7");
  const restarted=await controlled(db,dir); expect(restarted.events.some(e=>e.type==="reset-needed"), "ORACLE:T-IDENTITY-ROLLBACK").toBe(true);
  expect(value(index(dir),"index_id"), "ORACLE:T-IDENTITY-ROLLBACK").not.toBe(oldId);
});
it("T-RETIRE-COLLISION / M18': ninth legacy writer rotates owner even with no rename slots", () => {
  const { db }=fixture();
  search.prepareMessageSearchBackfill(db);
  const initialOwner=db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get();expect(initialOwner,"ORACLE:T-RETIRE-COLLISION" + " " + ("search owner identity is durable")).toBeDefined();
  let before=initialOwner!.done;
  for(let i=1;i<=9;i++) {
    db.exec(MESSAGE_SEARCH_DDL); db.exec("INSERT INTO messages_fts(rowid,t) VALUES(1,'legacy posting')");
    search.settleInheritedSearchMerge(db,false);
    const after=db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done;
    expect(after, "ORACLE:T-RETIRE-COLLISION").not.toBe(before); before=after;
    expect(db.prepare("SELECT cursor,done FROM transcript_index_state WHERE name='search_fts'").get(), "ORACLE:T-RETIRE-COLLISION").toMatchObject({cursor:0,done:0});
    if(i<=8) expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts'").get(), "ORACLE:T-RETIRE-COLLISION").toBeUndefined();
  }
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts'").get(), "ORACLE:T-RETIRE-COLLISION").toBeDefined();
});
it("T-DISPATCH: io/fence refusal preserves age; owner-first is LAST and forced admission posts", () => {
  const foreground=fixture().db,prepare=foreground.prepare.bind(foreground),foregroundSql:string[]=[];
  foreground.prepare=sql=>{foregroundSql.push(sql);return prepare(sql);};
  search.stepMessageSearchBackfill(foreground);
  expect(foregroundSql,"ORACLE:T-DISPATCH" + " " + ("no foreground fill statements while scheduler owns admission")).toEqual([]);
  foreground.prepare=prepare;
  const run: {firstDeferredAt?:number}={}; const order:string[]=[]; let fence=true,defer=0,admit=false,age=0,posts=0;
  const ports={fenced:()=>{order.push("fence");return fence;},deferred:()=>{order.push("io");return defer;},admit:(wait:number)=>{order.push("owner");age=wait;return admit;},post:()=>posts++};
  expect(search.dispatchSearchStep(run,100,ports), "ORACLE:T-DISPATCH").toBe(false); expect(order, "ORACLE:T-DISPATCH").toEqual(["fence"]);
  fence=false;defer=10;order.length=0; expect(search.dispatchSearchStep(run,200,ports), "ORACLE:T-DISPATCH").toBe(false);expect(order, "ORACLE:T-DISPATCH").toEqual(["fence","io"]);
  defer=0;expect(search.dispatchSearchStep(run,400,ports), "ORACLE:T-DISPATCH").toBe(false);expect(age, "ORACLE:T-DISPATCH").toBe(300);
  admit=true;expect(search.dispatchSearchStep(run,800,ports), "ORACLE:T-DISPATCH").toBe(true);expect(age, "ORACLE:T-DISPATCH").toBe(700);expect(posts, "ORACLE:T-DISPATCH").toBe(1);expect(run.firstDeferredAt, "ORACLE:T-DISPATCH").toBeUndefined();
});
it("T-REBUILD-NO-MAIN / T-WARM: 60 worker commits never move main data_version; a foreign writer does", async () => {
  const { db,dir }=fixture(); const run=await controlled(db,dir); await run.step();
  const version=()=>db.prepare("PRAGMA data_version").get()!.data_version;
  const initial=version();
  for(let i=1;i<=60;i++) { add(db,i,"warm repeated token"); await run.step(); expect(version(), "ORACLE:T-REBUILD-NO-MAIN ORACLE:T-WARM").toBe(initial); }
  const foreign=new DatabaseSync(join(dir,"messages.db"));
  foreign.exec("INSERT INTO thread_state(thread_id) VALUES('foreign')"); foreign.close(); expect(version(), "ORACLE:T-REBUILD-NO-MAIN ORACLE:T-WARM").not.toBe(initial);
});
it("C14: rebuild rows and progress roll back together at a real worker termination barrier", async () => {
  const {db,dir}=fixture();for(let i=1;i<=300;i++)add(db,i,"rebuild canary");
  const held={name:"rebuild-before-progress",shared:new SharedArrayBuffer(4)};
  const run=await controlled(db,dir,held);run.postStep();
  await until(()=>Atomics.load(new Int32Array(held.shared),0)===1,'ORACLE:C14');
  const a=index(dir);
  expect(value(a,"built"),"ORACLE:C14").toBe("301");
  expect(a.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n,"ORACLE:C14").toBe(0);
  expect(matches(a,'canary'),"ORACLE:C14").toEqual([]);
  await run.worker.terminate();
  expect(value(a,"built"),"ORACLE:C14").toBe("301");
  expect(a.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n,"ORACLE:C14").toBe(0);
  a.exec("INSERT INTO messages_fts(messages_fts) VALUES('integrity-check')");
  const restarted=await controlled(db,dir);await restarted.step();
  expect(value(a,"built"),"ORACLE:C14").toBe("45");
  expect(a.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n,"ORACLE:C14").toBe(256);
  await restarted.step();expect(value(a,"built"),"ORACLE:C14").toBeUndefined();
  expect(matches(a,'canary'),"ORACLE:C14").toHaveLength(300);
});
it("C6' / C7b: committed drop cursor resumes after termination inside the last chunk", async () => {
  const {db,dir}=fixture(); for(let i=1;i<=300;i++) add(db,i,"drop qzvxkjw");
  let run=await controlled(db,dir); await run.step(); await run.step();
  await run.worker.terminate();
  const held={name:"drop-last",shared:new SharedArrayBuffer(4)};
  db.exec("BEGIN"); search.dropThreadSearchRows(db,"t"); db.exec("DELETE FROM messages; COMMIT");
  run=await controlled(db,dir,held); await run.step(); const a=index(dir);
  expect(value(a,"drop_cursor"), "ORACLE:C6' ORACLE:C7b").toBe("256"); expect(a.prepare("SELECT COUNT(*) AS n FROM docs").get()!.n, "ORACLE:C6' ORACLE:C7b").toBe(44);
  run.postStep(); await until(()=>Atomics.load(new Int32Array(held.shared),0)===1); await run.worker.terminate();
  expect(value(a,"drop_cursor"), "ORACLE:C6' ORACLE:C7b").toBe("256"); expect(value(a,"debt"), "ORACLE:C6' ORACLE:C7b").toBeUndefined();
  const restarted=await controlled(db,dir); await restarted.step();
  expect(a.prepare("SELECT COUNT(*) AS n FROM docs").get()!.n, "ORACLE:C6' ORACLE:C7b").toBe(0);
  expect(value(a,"drop_cursor"), "ORACLE:C6' ORACLE:C7b").toBeUndefined();
});
it("C10b / C11 / C11b: a reader-busy TRUNCATE retains exact debt, then scrub retries and removes raw deleted postings", async () => {
  const {db,dir}=fixture(); add(db,1,"qzvxkjw"); const run=await controlled(db,dir); await run.step(); const a=index(dir);
  a.exec("BEGIN"); a.prepare("SELECT * FROM docs").all();
  db.exec("BEGIN"); search.dropThreadSearchRows(db,"t"); db.exec("DELETE FROM messages; COMMIT");
  await run.step();
  const observer=index(dir);
  for(let i=0;i<30 && !String(value(observer,"debt")).endsWith(":1");i++) await run.step();
  expect(String(value(observer,"debt")), "ORACLE:C10b ORACLE:C11 ORACLE:C11b").toMatch(/:1$/);
  await run.step(); expect(String(value(observer,"debt")), "ORACLE:C10b ORACLE:C11 ORACLE:C11b").toMatch(/:1$/);
  a.exec("COMMIT");
  for(let i=0;i<30 && value(a,"debt")!==undefined;i++) await run.step();
  expect(value(a,"debt"), "ORACLE:C10b ORACLE:C11 ORACLE:C11b").toBeUndefined(); expect(matches(a,"qzvxkjw"), "ORACLE:C10b ORACLE:C11 ORACLE:C11b").toEqual([]);
  expect(readFileSync(join(dir,"search.db")).includes(Buffer.from("qzv")), "ORACLE:C10b ORACLE:C11 ORACLE:C11b").toBe(false);
  try { expect(readFileSync(join(dir,"search.db-wal")).includes(Buffer.from("qzv")), "ORACLE:C10b ORACLE:C11 ORACLE:C11b").toBe(false); } catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
});
it("T-SEARCH-OVERSIZED: bounded fetch skips a >4MiB row, advances, and discloses partial", async () => {
  const {db,dir}=fixture(); add(db,1,"x".repeat(4*1024*1024+1)); add(db,2,"normal needle");
  const run=await controlled(db,dir); await run.step(); await run.step(); const a=index(dir);
  expect(value(a,"built"), "ORACLE:T-SEARCH-OVERSIZED").toBeUndefined();
  expect(a.prepare("SELECT oversized FROM docs WHERE rowid=1").get()!.oversized, "ORACLE:T-SEARCH-OVERSIZED").toBe(1);
  expect(matches(a,"needle"), "ORACLE:T-SEARCH-OVERSIZED").toEqual([2]);
  await run.worker.terminate();await automatic(db,dir);
  const result=search.readMessageSearchCandidates(db,search.trigramQuery("needle"),10);
  expect(result.rowids, "ORACLE:T-SEARCH-OVERSIZED").toEqual([2]);expect(result.partial, "ORACLE:T-SEARCH-OVERSIZED").toBe(true);expect(search.messageSearchIndexReady(db), "ORACLE:T-SEARCH-OVERSIZED").toBe(true);
  console.log("[fts-partial] oversized",result.partial);
});
it("T-RESET-HANDSHAKE / C15 / C15': main reader and prune cache close before worker unlinks sidecars", async () => {
  const {db,dir}=fixture(); await automatic(db,dir); add(db,1,"first needle");
  search.searchIndexTestHooks.halted=false; await until(()=>!search.searchCleanupPending(db));
  search.pruneMessageSearchIntents(db);
  const acks:Array<Record<string,unknown>>=[];
  const events:string[]=[]; search.searchIndexTestHooks.event=e=>{events.push(e.type);if(e.type==="reset-ack")acks.push(e);};
  db.prepare("UPDATE transcript_index_state SET done='rotated' WHERE name='search_owner'").run();
  await until(()=>events.includes("reset-needed") && events.includes("ready"));
  await until(()=>!search.searchCleanupPending(db));
  expect(acks, "ORACLE:T-RESET-HANDSHAKE ORACLE:C15 ORACLE:C15'").toMatchObject([{readerClosed:true,cacheCleared:true}]);
  expect(search.messageSearchIndexReady(db), "ORACLE:T-RESET-HANDSHAKE ORACLE:C15 ORACLE:C15'").toBe(true);
  expect(search.readMessageSearchCandidates(db,search.trigramQuery("needle"),10).rowids, "ORACLE:T-RESET-HANDSHAKE ORACLE:C15 ORACLE:C15'").toContain(1);
});
it("T-PRUNE / C2': owner prune is at most two fixed rows and preserves applied + seen", async () => {
  const {db,dir}=fixture(); await automatic(db,dir); for(let i=1;i<=10;i++) add(db,i,"needle");
  search.searchIndexTestHooks.halted=false; await until(()=>!search.searchCleanupPending(db));
  search.searchIndexTestHooks.halted=true;
  const a=index(dir); const seq=Number(value(a,"applied_seq"));
  const before=Number(db.prepare("SELECT COUNT(*) AS n FROM search_intents").get()!.n);
  search.pruneMessageSearchIntents(db);
  const after=Number(db.prepare("SELECT COUNT(*) AS n FROM search_intents").get()!.n);
  expect(before-after, "ORACLE:T-PRUNE ORACLE:C2'").toBe(Math.min(2,before-1)); expect(db.prepare("SELECT 1 FROM search_intents WHERE seq=?").get(seq), "ORACLE:T-PRUNE ORACLE:C2'").toBeDefined();
  db.prepare("DELETE FROM search_intents WHERE seq<?").run(seq);
  add(db,11,"unapplied"); search.pruneMessageSearchIntents(db);
  expect(db.prepare("SELECT 1 FROM search_intents WHERE seq=?").get(seq), "ORACLE:T-PRUNE ORACLE:C2'").toBeDefined();
  expect(db.prepare("SELECT 1 FROM search_intents WHERE seq>? AND rowid=11").get(seq), "ORACLE:T-PRUNE ORACLE:C2'").toBeDefined();
});
it("T-SCAN-WRITES / T-SCAN-TRIG: closed mutation inventory includes JSON-only and VACUUM sites", () => {
  const inventory:Record<string,string>={
    "message-db.ts":"replaceRow and updateMessage sync; deleteThread drop; attachment paths cannot affect searchableText",
    "transcript-backfill.ts":"seq only",
    "memory/lineage-backfill.ts":"withheldFromBots only; live verification",
    "installation-restore-preparation.ts":"offline candidate; rotated owner",
    "installation-database-snapshot.ts":"offline sanitized copy; lineage reset",
    "memory/lineage-warm-surface.ts":"test seam only, no production callers",
  };
  const files = (dir:string):string[] => {
    const {readdirSync}=requireFs;
    return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(join(dir,entry.name)):[join(dir,entry.name)]);
  };
  for(const path of files("server").filter(p=>p.endsWith(".ts")&&!p.endsWith(".test.ts")&&!p.includes("/testing/"))) {
    const source=readFileSync(path,"utf8");
    if(/(?:INSERT(?: OR \w+)? INTO|REPLACE INTO|UPDATE|DELETE FROM) messages\b/i.test(source)) expect(inventory[path.slice(7)],"ORACLE:T-SCAN-WRITES ORACLE:T-SCAN-TRIG" + " " + (path)).toBeDefined();
  }
  const authority=readFileSync("server/memory/authority-epoch.ts","utf8");
  expect(authority, "ORACLE:T-SCAN-WRITES ORACLE:T-SCAN-TRIG").not.toMatch(/(?:trigger\(|writes\()\s*["'`]?(?:search_intents|messages_fts)/);
  // The production reclaim worker also VACUUMs messages.db. schema_version in
  // worker lineage invalidates it, in addition to B2's offline-file cleanup.
  expect(readFileSync("server/memory/root-set-compaction.ts","utf8"), "ORACLE:T-SCAN-WRITES ORACLE:T-SCAN-TRIG").toContain('db.exec("VACUUM")');
  expect(readFileSync("server/engine-exec.ts","utf8"), "ORACLE:T-SCAN-WRITES ORACLE:T-SCAN-TRIG").toContain('db.exec("VACUUM")');
});
import * as requireFs from "node:fs";
it("T-IDENTITY-REBUILD: a rebuild records the edited snapshot's seen nonce before a same-owner rollback",async()=>{
  const {db,dir}=fixture();for(let i=1;i<=300;i++)add(db,i,"original");
  const held={name:"snapshot-released",shared:new SharedArrayBuffer(4)};
  const run=await controlled(db,dir,held);run.postStep();await until(()=>Atomics.load(new Int32Array(held.shared),0)===1);
  const base=Number(db.prepare("SELECT MAX(seq) AS n FROM search_intents").get()!.n);
  add(db,300,"edited canary");
  Atomics.store(new Int32Array(held.shared),0,0);Atomics.notify(new Int32Array(held.shared),0);
  await until(()=>run.events.some(e=>e.type==="stepped"));
  const a=index(dir);expect(Number(value(a,"seen_seq")), "ORACLE:T-IDENTITY-REBUILD").toBe(base+1);expect(Number(value(a,"applied_seq")), "ORACLE:T-IDENTITY-REBUILD").toBe(base);
  expect(matches(a,"canary"), "ORACLE:T-IDENTITY-REBUILD").toEqual([300]);
  await run.worker.terminate();a.close();cleanups.pop();
  db.exec("BEGIN");db.prepare("DELETE FROM search_intents WHERE seq>?").run(base);db.exec("UPDATE messages SET text='original' WHERE rowid=300; COMMIT");
  const restarted=await controlled(db,dir);expect(restarted.events.some(e=>e.type==="reset-needed"), "ORACLE:T-IDENTITY-REBUILD").toBe(true);await restarted.step();
  expect(matches(index(dir),"canary"), "ORACLE:T-IDENTITY-REBUILD").toEqual([]);
});
it("C5 / C5': terminating after FTS changes but before progress leaves neither row nor applied marker committed",async()=>{
  const {db,dir}=fixture();const held={name:"apply-before-progress",shared:new SharedArrayBuffer(4)};
  const run=await controlled(db,dir,held);const a=index(dir);const before=value(a,"applied_seq");add(db,1,"apply canary");
  run.postStep();await until(()=>Atomics.load(new Int32Array(held.shared),0)===1);
  expect(matches(a,"canary"), "ORACLE:C5 ORACLE:C5'").toEqual([]);expect(value(a,"applied_seq"), "ORACLE:C5 ORACLE:C5'").toBe(before);
  await run.worker.terminate();expect(matches(a,"canary"), "ORACLE:C5 ORACLE:C5'").toEqual([]);expect(value(a,"applied_seq"), "ORACLE:C5 ORACLE:C5'").toBe(before);
  const next=await controlled(db,dir);await next.step();expect(matches(a,"canary"), "ORACLE:C5 ORACLE:C5'").toEqual([1]);expect(Number(value(a,"applied_seq")), "ORACLE:C5 ORACLE:C5'").toBeGreaterThan(Number(before));
});
it("T-SEARCHDB-WAL / T-SEARCHDB-FULL / T-RO: the only main-file worker connection is read-only, synchronous FULL and WAL are asserted",async()=>{
  const {db,dir}=fixture(),run=await controlled(db,dir);
  expect(run.events.filter(e=>e.type==="readonly-probe").every(e=>e.rejected), "ORACLE:T-SEARCHDB-WAL ORACLE:T-SEARCHDB-FULL ORACLE:T-RO").toBe(true);
  expect(run.events.find(e=>e.type==="ready"), "ORACLE:T-SEARCHDB-WAL ORACLE:T-SEARCHDB-FULL ORACLE:T-RO").toMatchObject({synchronous:2,journal_mode:"wal"});
  expect(SEARCH_INDEX_WORKER_SOURCE, "ORACLE:T-SEARCHDB-WAL ORACLE:T-SEARCHDB-FULL ORACLE:T-RO").toContain("new DatabaseSync(file, { readOnly: true })");
  expect(SEARCH_INDEX_WORKER_SOURCE, "ORACLE:T-SEARCHDB-WAL ORACLE:T-SEARCHDB-FULL ORACLE:T-RO").toContain("PRAGMA query_only=ON");
  expect(SEARCH_INDEX_WORKER_SOURCE, "ORACLE:T-SEARCHDB-WAL ORACLE:T-SEARCHDB-FULL ORACLE:T-RO").toContain("source_schema");
  expect(SEARCH_INDEX_WORKER_SOURCE, "ORACLE:T-SEARCHDB-WAL ORACLE:T-SEARCHDB-FULL ORACLE:T-RO").toContain("PRAGMA synchronous=FULL");
  expect(SEARCH_INDEX_WORKER_SOURCE, "ORACLE:T-SEARCHDB-WAL ORACLE:T-SEARCHDB-FULL ORACLE:T-RO").toContain("!== 'wal'");
});
it("T-THREAD-KEY: long ids and raw hash-shaped ids occupy different fixed-size keys",()=>{
 const {db}=fixture(),prepare=db.prepare.bind(db),bound:unknown[]=[];
 db.prepare=sql=>{const stmt=prepare(sql);return new Proxy(stmt,{get(target,key){const v=Reflect.get(target,key,target);return typeof v==='function'?(...args:unknown[])=>{bound.push(...args);return Reflect.apply(v,target,args);}:v;}});};
 search.dropThreadSearchRows(db,'long'.repeat(20000));
 expect(bound.filter(x=>typeof x==='string'&&x.length>72), "ORACLE:T-THREAD-KEY").toEqual([]);
 expect(search.intentCount(db), "ORACLE:T-THREAD-KEY").toBe(1);
 const key=String(prepare('SELECT thread_key FROM search_intents').get()!.thread_key);
 search.dropThreadSearchRows(db,key);
 expect(String(prepare('SELECT thread_key FROM search_intents ORDER BY seq DESC LIMIT 1').get()!.thread_key), "ORACLE:T-THREAD-KEY").not.toBe(key);
});

it("T-RETIRE-OFFLINE: inert indexes remain pending until exclusive offline cleanup",()=>{
  const {db,dir}=fixture();db.exec(MESSAGE_SEARCH_DDL);db.exec("INSERT INTO messages_fts(rowid,t) VALUES(1,'legacy qzv')");search.settleInheritedSearchMerge(db,false);
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts_retired'").get(), "ORACLE:T-RETIRE-OFFLINE").toBeDefined();
  expect(search.searchRetirementPending(db), "ORACLE:T-RETIRE-OFFLINE").toBe(true);expect(()=>search.dropRetiredSearchIndexesOffline(db), "ORACLE:T-RETIRE-OFFLINE").toThrow(/exclusive/);
  expect(db.prepare("SELECT block FROM messages_fts_retired_data").all().some(row=>row.block instanceof Uint8Array&&Buffer.from(row.block).includes(Buffer.from("qzv"))), "ORACLE:T-RETIRE-OFFLINE").toBe(true);
  db.exec("PRAGMA secure_delete=OFF; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE");search.dropRetiredSearchIndexesOffline(db);db.exec("COMMIT");
  expect(db.prepare("PRAGMA secure_delete").get()!.secure_delete, "ORACLE:T-RETIRE-OFFLINE").toBe(1);
  expect(search.searchRetirementPending(db), "ORACLE:T-RETIRE-OFFLINE").toBe(false);db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(readFileSync(join(dir,"messages.db")).includes(Buffer.from("qzv")), "ORACLE:T-RETIRE-OFFLINE").toBe(false);
});
it("C11b: an old scrub completion cannot erase a newer drop's debt",async()=>{
  const {db,dir}=fixture();add(db,1,"qzv");let run=await controlled(db,dir);await run.step();await run.worker.terminate();
  const held={name:"after-scrub",shared:new SharedArrayBuffer(4)};run=await controlled(db,dir,held);const a=index(dir);
  db.exec("BEGIN");search.dropThreadSearchRows(db,"t");db.exec("DELETE FROM messages;COMMIT");
  await run.step();while(!String(value(a,"debt")).endsWith(":1"))await run.step();
  run.postStep();await until(()=>Atomics.load(new Int32Array(held.shared),0)===1);
  // Simulate a delayed old completion after the next drop's durable write.
  a.prepare("UPDATE search_state SET v='999:0' WHERE k='debt'").run();
  const count=run.events.filter(e=>e.type==="stepped").length;
  Atomics.store(new Int32Array(held.shared),0,0);Atomics.notify(new Int32Array(held.shared),0);
  await until(()=>run.events.filter(e=>e.type==="stepped").length>count);
  expect(value(a,"debt"), "ORACLE:C11b").toBe("999:0");
});
it("C14': rebuild rows and cursor are already atomic at the after-COMMIT crash barrier",async()=>{
  const {db,dir}=fixture();for(let i=1;i<=300;i++)add(db,i,"row canary");
  const held={name:"rebuild-after-commit",shared:new SharedArrayBuffer(4)},run=await controlled(db,dir,held);run.postStep();
  await until(()=>Atomics.load(new Int32Array(held.shared),0)===1);const a=index(dir);
  expect(value(a,"built"), "ORACLE:C14'").toBe("45");expect(a.prepare("SELECT COUNT(*) AS n FROM docs").get()!.n, "ORACLE:C14'").toBe(256);
  await run.worker.terminate();const next=await controlled(db,dir);await next.step();expect(value(a,"built"), "ORACLE:C14'").toBeUndefined();expect(a.prepare("SELECT COUNT(*) AS n FROM docs").get()!.n, "ORACLE:C14'").toBe(300);
});
it("T-REBUILD-NO-MAIN: legacy fill entry points execute zero statements",()=>{
  const {db}=fixture(),prepare=db.prepare.bind(db),exec=db.exec.bind(db);const sql:string[]=[];
  db.prepare=s=>{sql.push(s);return prepare(s);};db.exec=s=>{sql.push(s);return exec(s);};
  search.stepMessageSearchBackfill(db);search.backfillMessageSearchIndex(db);expect(sql, "ORACLE:T-REBUILD-NO-MAIN").toEqual([]);
});
it("C7 / C9 / M8: a writing merge crash retains residue and debt until a later no-write proof and scrub",{timeout:120000},async()=>{
  const {db,dir}=fixture(),marker="\ue123\ue124\ue125",keep="surviving "+randomBytes(48000).toString("base64");
  add(db,1,marker+" removed","drop");add(db,2,keep,"keep");
  let run=await controlled(db,dir);await run.step();await run.worker.terminate();const a=index(dir);
  a.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('automerge',0);INSERT INTO messages_fts(messages_fts,rank) VALUES('deletemerge',0);INSERT INTO messages_fts(messages_fts,rank) VALUES('crisismerge',64)");
  // Real segment generations, all describing the SAME live survivor: no orphan
  // rows or invented postings. A 1-page test slice cannot finish this vocabulary.
  for(let i=0;i<3;i++){
    a.exec("BEGIN;DELETE FROM messages_fts WHERE rowid=2");a.prepare("INSERT INTO messages_fts(rowid,t) VALUES(2,?)").run(keep);a.exec("COMMIT");
  }
  expect(Number(a.prepare("SELECT COUNT(DISTINCT segid) AS n FROM messages_fts_idx").get()!.n), "ORACLE:C7 ORACLE:C9").toBeGreaterThanOrEqual(3);
  const residue=()=>a.prepare("SELECT block FROM messages_fts_data").all().some(row=>row.block instanceof Uint8Array&&Buffer.from(row.block).includes(Buffer.from(marker)));
  expect(residue(), "ORACLE:C7 ORACLE:C9").toBe(true);
  db.exec("BEGIN");search.dropThreadSearchRows(db,"drop");db.exec("DELETE FROM messages WHERE thread_id='drop';COMMIT");
  const held={name:"merge-prove",shared:new SharedArrayBuffer(4)};
  run=await controlled(db,dir,held,1);run.postStep();await until(()=>Atomics.load(new Int32Array(held.shared),0)===1);
  expect(String(value(a,"debt")), "ORACLE:C7 ORACLE:C9").toMatch(/:0$/);expect(residue(), "ORACLE:C7 ORACLE:C9").toBe(true);
  await run.worker.terminate();expect(String(value(a,"debt")), "ORACLE:C7 ORACLE:C9").toMatch(/:0$/);expect(residue(), "ORACLE:C7 ORACLE:C9").toBe(true);
  run=await controlled(db,dir,undefined,1);await run.step();
  // Crucial oracle: this was a writing -N and residual deleted postings STILL
  // exist after COMMIT. Treating that write as proof would publish scrub early.
  expect(String(value(a,"debt")), "ORACLE:C7 ORACLE:C9").toMatch(/:0$/);expect(residue(), "ORACLE:C7 ORACLE:C9").toBe(true);
  for(let i=0;i<200&&value(a,"debt")!==undefined;i++)await run.step();
  expect(value(a,"debt"), "ORACLE:C7 ORACLE:C9").toBeUndefined();expect(residue(), "ORACLE:C7 ORACLE:C9").toBe(false);expect(matches(a,marker), "ORACLE:C7 ORACLE:C9").toEqual([]);expect(matches(a,"surviving"), "ORACLE:C7 ORACLE:C9").toEqual([2]);
  expect(readFileSync(join(dir,"search.db")).includes(Buffer.from(marker)), "ORACLE:C7 ORACLE:C9").toBe(false);
});

it("T-SEARCH-SNAPSHOT / M25: a worker commit between candidates and pending cannot hide newly indexed live text",async()=>{
  const {db,dir}=fixture();add(db,1,"old text");await automatic(db,dir);const a=index(dir);
  a.exec("BEGIN;INSERT INTO messages_fts(rowid,t) VALUES(1,'old text');DELETE FROM search_state WHERE k='built'");
  a.prepare("INSERT INTO docs(rowid,thread_key) VALUES(1,?)").run(search.threadKey("t"));a.exec("COMMIT");
  add(db,1,"newneedle");const newest=db.prepare("SELECT seq,CAST(nonce AS TEXT) AS nonce FROM search_intents ORDER BY seq DESC LIMIT 1").get()!;
  search.searchIndexTestHooks.candidateSnapshot=()=>{
    a.exec("BEGIN IMMEDIATE;DELETE FROM messages_fts WHERE rowid=1");a.prepare("INSERT INTO messages_fts(rowid,t) VALUES(1,'newneedle')").run();
    a.prepare("UPDATE search_state SET v=? WHERE k IN ('applied_seq','seen_seq')").run(String(newest.seq));a.prepare("UPDATE search_state SET v=? WHERE k IN ('applied_nonce','seen_nonce')").run(String(newest.nonce));a.exec("COMMIT");
  };
  const result=search.readMessageSearchCandidates(db,search.trigramQuery("newneedle"),10);
  search.searchIndexTestHooks.candidateSnapshot=null;expect(result.rowids, "ORACLE:T-SEARCH-SNAPSHOT").toEqual([1]);
});
it("T-SEARCH-ORDER / M20: a newer sync cannot leap over an older drop",async()=>{
  const {db,dir}=fixture();for(let i=1;i<=3;i++)add(db,i,"oldthread","old");const run=await controlled(db,dir);await run.step();
  db.exec("BEGIN");search.dropThreadSearchRows(db,"old");db.exec("DELETE FROM messages;COMMIT");add(db,10,"newthread","new");
  await run.step();await run.step();const a=index(dir);expect(a.prepare("SELECT rowid FROM docs ORDER BY rowid").all().map(r=>Number(r.rowid)), "ORACLE:T-SEARCH-ORDER").toEqual([10]);
});
it("T-IDENTITY-REOPEN / M32: an immediate reopen serializes activation after the old writer's exit",async()=>{
  const {db,dir}=fixture();await automatic(db,dir);add(db,1,"survivor");
  const stopped=search.stopSearchIndex();
  const next=new DatabaseSync(join(dir,"messages.db"));cleanups.push(()=>next.close());
  search.startSearchIndex(next,join(dir,"messages.db"));await stopped;
  await until(()=>search.messageSearchIndexReady(next));
  expect(search.readMessageSearchCandidates(next,search.trigramQuery("survivor"),10).rowids, "ORACLE:T-IDENTITY-REOPEN").toContain(1);
});
it("T-SEARCH-READER: a disabled reader resets through the close/ack handshake and recovers",async()=>{
  const {db,dir}=fixture();await automatic(db,dir);search.disableMessageSearchIndex(db,new Error("fixture read failure"));
  expect(search.messageSearchIndexReady(db), "ORACLE:T-SEARCH-READER").toBe(false);await until(()=>search.messageSearchIndexReady(db));
});
it("T-LINEAGE-STEADY: pruning a strict prefix and restarting preserves the current index identity",async()=>{
  const {db,dir}=fixture();for(let i=1;i<=10;i++)add(db,i,"stable");const run=await controlled(db,dir);await run.step();const a=index(dir),id=value(a,"index_id");
  db.prepare("DELETE FROM search_intents WHERE seq<?").run(value(a,"applied_seq")!);await run.worker.terminate();a.close();cleanups.pop();
  const next=await controlled(db,dir);expect(next.events.some(e=>e.type==="reset-needed"), "ORACLE:T-LINEAGE-STEADY").toBe(false);expect(value(index(dir),"index_id"), "ORACLE:T-LINEAGE-STEADY").toBe(id);
});

import { ConversationDeletions,runConversationDeletion } from "./conversation-deletion.ts";
it("T-STATUS: the injected database reports inert search cleanup as offline work",async()=>{
  const {db,dir}=fixture();db.exec(MESSAGE_SEARCH_DDL);search.settleInheritedSearchMerge(db,false);
  const service=new ConversationDeletions({dataDir:dir,database:()=>db,retryDelaysMs:[]});
  try{
    const {report}=await runConversationDeletion(service,{threadIds:["t"]},()=>true);
    expect(report.leftovers, "ORACLE:T-STATUS").toContainEqual({what:"Removed; finishing cleanup",where:"local search index; offline cleanup required"});
  }finally{service.dispose();}
});
it("T-SEARCH-START-FAILURE: constructor refusal preserves owner writes and pending search; shutdown cancels its retry",async()=>{
  const {db,dir}=fixture();search.searchIndexTestHooks.failStart=true;
  try{
    expect(()=>search.startSearchIndex(db,join(dir,"messages.db")), "ORACLE:T-SEARCH-START-FAILURE").not.toThrow();add(db,1,"pendingcanary");
    expect(search.readMessageSearchCandidates(db,search.trigramQuery("pendingcanary"),10), "ORACLE:T-SEARCH-START-FAILURE").toEqual({rowids:[1],partial:true});
    expect(await search.stopSearchIndex(), "ORACLE:T-SEARCH-START-FAILURE").toBe(true);
  }finally{search.searchIndexTestHooks.failStart=false;}
  search.startSearchIndex(db,join(dir,"messages.db"));cleanups.push(()=>search.stopSearchIndex());await until(()=>search.messageSearchIndexReady(db));
});
it("T-RETIRE-RENAME-FAILURE: rotation commits even when the rename must roll back",()=>{
  const {db}=fixture();search.prepareMessageSearchBackfill(db);db.exec(MESSAGE_SEARCH_DDL);
  const ownerRow=db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get();expect(ownerRow,"ORACLE:T-RETIRE-RENAME-FAILURE" + " " + ("retirement records an owner identity")).toBeDefined();
  const before=ownerRow!.done,exec=db.exec.bind(db);
  db.exec=sql=>{exec(sql);if(sql.startsWith("ALTER TABLE messages_fts RENAME"))throw Error("injected rename failure");};
  expect(()=>search.settleInheritedSearchMerge(db,false), "ORACLE:T-RETIRE-RENAME-FAILURE").not.toThrow();db.exec=exec;
  expect(db.prepare("SELECT done FROM transcript_index_state WHERE name='search_owner'").get()!.done, "ORACLE:T-RETIRE-RENAME-FAILURE").not.toBe(before);
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts'").get(), "ORACLE:T-RETIRE-RENAME-FAILURE").toBeDefined();
  expect(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='messages_fts_retired'").get(), "ORACLE:T-RETIRE-RENAME-FAILURE").toBeUndefined();expect(search.searchRetirementPending(db), "ORACLE:T-RETIRE-RENAME-FAILURE").toBe(true);
});

import { performance } from 'node:perf_hooks';
async function recoveryUntil(check:()=>boolean,id:string,ms=8000) {
 const end=performance.now()+ms;while(!check()&&performance.now()<end)await new Promise(r=>setTimeout(r,5));
 expect(check(),id.startsWith('T-')?'ORACLE:'+id:id).toBe(true);
}
async function scrubFixture() {
 const {db,dir}=fixture();
 db.exec("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<300) INSERT INTO messages(thread_id,id,at,role,kind,text,json) SELECT 'drop',CAST(x AS TEXT),x,'user','text','\ue123\ue124\ue125 removed canary','{}' FROM n");
 search.startSearchIndex(db,join(dir,'messages.db'));cleanups.push(()=>search.stopSearchIndex());
 await recoveryUntil(()=>search.messageSearchIndexReady(db)&&!search.searchCleanupPending(db),'scrub fixture ready');
 const reader=new DatabaseSync(join(dir,'search.db'),{readOnly:true});cleanups.push(()=>reader.close());
 reader.exec('BEGIN');reader.prepare('SELECT COUNT(*) FROM messages_fts').get();
 return{db,dir,reader,drop:()=>{db.exec('BEGIN');search.dropThreadSearchRows(db,'drop');db.exec("DELETE FROM messages WHERE thread_id='drop';COMMIT");}};
}
it('T-SCRUB-BACKOFF: pinned WAL retries are exponential and busy alone is not work',{timeout:15000},async()=>{
 const {drop}=await scrubFixture();const attempts:Array<{at:number,n:number,delay:number}>=[],busySteps:boolean[]=[];
 search.searchIndexTestHooks.event=e=>{if(e.type==='scrub-busy')attempts.push({at:performance.now(),n:Number(e.n),delay:Number(e.retryInMs)});if(e.type==='stepped'&&e.retryInMs!==undefined)busySteps.push(Boolean(e.worked));};
 drop();await recoveryUntil(()=>attempts.length>0,'T-SCRUB-BACKOFF');
 await new Promise(r=>setTimeout(r,6500));
 expect(attempts.length,'ORACLE:T-SCRUB-BACKOFF').toBeLessThanOrEqual(8);
 expect(attempts.length,'ORACLE:T-SCRUB-BACKOFF').toBeGreaterThanOrEqual(7);
 const gaps=attempts.slice(1).map((x,i)=>x.at-attempts[i].at);
 for(let i=0;i<gaps.length;i++)expect(gaps[i],'ORACLE:T-SCRUB-BACKOFF').toBeGreaterThanOrEqual(.9*search.scrubDelay(attempts[i].n));
 expect(gaps.every((n,i)=>i===0||n>=gaps[i-1]),'ORACLE:T-SCRUB-BACKOFF').toBe(true);
 // The first busy step may have applied the final drop chunk; later steps are cleanup only.
 expect(busySteps.slice(1),'ORACLE:T-SCRUB-BACKOFF').not.toContain(true);
 console.log('SCRUB BACKOFF',JSON.stringify({attempts,gaps,busySteps}));
 search.searchIndexTestHooks.event=null;
});
it('T-SCRUB-NOSTARVE: committed intent application stays live during scrub backoff',{timeout:16000},async()=>{
 const {db,dir,drop}=await scrubFixture();let busy=0;
 search.searchIndexTestHooks.event=e=>{if(e.type==='scrub-busy')busy++;};drop();
 await recoveryUntil(()=>busy>=5,'T-SCRUB-NOSTARVE');
 const a=index(dir),latencies:number[]=[];
 for(let i=0;i<10;i++) {
  const at=performance.now();add(db,1000+i,'freshneedle'+i,'keep');
  await recoveryUntil(()=>matches(a,'freshneedle'+i).includes(1000+i),'T-SCRUB-NOSTARVE',500);
  latencies.push(performance.now()-at);
  await new Promise(r=>setTimeout(r,Math.max(0,200-(performance.now()-at))));
 }
 expect(Math.max(...latencies),'ORACLE:T-SCRUB-NOSTARVE').toBeLessThan(500);
 console.log('SCRUB APPLY MS',latencies);search.searchIndexTestHooks.event=null;
});
it('T-SCRUB-RECOVER: releasing the pin clears debt and the next debt starts at fifty ms',{timeout:15000},async()=>{
 const {db,dir,reader,drop}=await scrubFixture();let lastDelay=0,n=0,attempts=0;
 search.searchIndexTestHooks.event=e=>{if(e.type==='scrub-busy'){attempts++;lastDelay=Number(e.retryInMs);n=Number(e.n);}};drop();
 await recoveryUntil(()=>attempts>=4,'T-SCRUB-RECOVER');const at=performance.now(),allowed=lastDelay+1000;
 reader.exec('COMMIT');await recoveryUntil(()=>!search.searchCleanupPending(db),'T-SCRUB-RECOVER',allowed);
 expect(performance.now()-at,'ORACLE:T-SCRUB-RECOVER').toBeLessThan(allowed);
 const marker=Buffer.from('\ue123\ue124\ue125');
 expect(readFileSync(join(dir,'search.db')).includes(marker),'ORACLE:T-SCRUB-RECOVER').toBe(false);
 const walPath=join(dir,'search.db-wal');
 expect(requireFs.existsSync(walPath)&&readFileSync(walPath).includes(marker),'ORACLE:T-SCRUB-RECOVER').toBe(false);
 add(db,500,'second drop','drop');const a=index(dir);
 await recoveryUntil(()=>matches(a,'second').includes(500),'T-SCRUB-RECOVER');
 reader.exec('BEGIN');reader.prepare('SELECT COUNT(*) FROM messages_fts').get();n=0;
 drop();await recoveryUntil(()=>n>0,'T-SCRUB-RECOVER');
 expect(n,'ORACLE:T-SCRUB-RECOVER').toBe(1);expect(lastDelay,'ORACLE:T-SCRUB-RECOVER').toBe(50);
 search.searchIndexTestHooks.event=null;
});
it('T-SCRUB-CAP: exponential delays cap and scheduler clamps worker input',()=>{
 expect([1,7,11,50].map(search.scrubDelay),'ORACLE:T-SCRUB-CAP').toEqual([50,3200,30000,30000]);
 for(let n=1;n<=100;n++)expect(search.scrubDelay(n),'ORACLE:T-SCRUB-CAP').toBeLessThanOrEqual(30000);
 expect([0,1e9].map(search.searchRetryDelay),'ORACLE:T-SCRUB-CAP').toEqual([10,30000]);
});
it('T-INTENT-NUDGE: an append replaces exactly one scrub timer with a ten ms apply step',{timeout:10000},async()=>{
 const {db,dir,drop}=await scrubFixture();let busy=0;
 search.searchIndexTestHooks.event=e=>{if(e.type==='scrub-busy')busy=Number(e.n);};drop();
 await recoveryUntil(()=>busy>=6,'T-INTENT-NUDGE');
 // Let the busy response install its one delayed main timer.
 await new Promise(r=>setTimeout(r,20));
 const timeout=vi.spyOn(globalThis,'setTimeout'),clear=vi.spyOn(globalThis,'clearTimeout');
 try {
  const a=index(dir);
  db.exec('BEGIN');
  db.prepare("INSERT INTO messages(rowid,thread_id,id,at,role,kind,text,json) VALUES(999,'keep','nudge',1,'user','text','nudgeneedle','{}')").run();
  search.syncMessageSearchRow(db,999,'nudgeneedle');
  expect(clear.mock.calls,'ORACLE:T-INTENT-NUDGE').toHaveLength(1);
  expect(timeout.mock.calls.map(call=>call[1]),'ORACLE:T-INTENT-NUDGE').toEqual([10]);
  expect(matches(a,'nudgeneedle'),'ORACLE:T-INTENT-NUDGE').toEqual([]);
  const at=performance.now();db.exec('COMMIT');
  await recoveryUntil(()=>matches(a,'nudgeneedle').includes(999),'T-INTENT-NUDGE',500);
  expect(performance.now()-at,'ORACLE:T-INTENT-NUDGE').toBeLessThan(500);
  expect(busy,'ORACLE:T-INTENT-NUDGE').toBe(6);
 } finally {if(db.isTransaction)db.exec('ROLLBACK');timeout.mockRestore();clear.mockRestore();search.searchIndexTestHooks.event=null;}
});
