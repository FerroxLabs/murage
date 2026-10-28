// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Real Store deletion, revocation, SQLite projections and receipt handling in
// the throwaway HOME supplied by server/testing/setup.ts. No engine or model.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { ConversationDeletions, runConversationDeletion } from "../conversation-deletion.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import { Store } from "../store.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { stopWalMaintenance, walMaintenanceReady, walScrubPending } from "../wal-maintenance.ts";
import { ensureAgeTables } from "./age-index.ts";
import { captureWork } from "./chunks.ts";
import { DELETE_SCRUB_MERGE_PAGES, MemoryIndex, type IndexedMemory } from "./index.ts";
import { claimMemoryJob, publishMemoryWork } from "./jobs.ts";
import { INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { pendingProjectionRecords } from "./projection.ts";
import { setMemoryMode } from "./repository.ts";
import { MemoryWorkerController } from "./worker-controller.ts";

const indexFile = () => join(DATA_DIR, "memory-index.db");
const inline = { ...INLINE_REVOCATION };
let index: MemoryIndex, deletions: ConversationDeletions, controller: MemoryWorkerController;
let reader: DatabaseSync | undefined;
type Internals = {
  child: unknown; ready: boolean; indexing: boolean; indexRequestId: string | null; indexSent: Map<string, string>; indexRolled: Set<string>;
  onWorkerMessage(child: unknown, message: unknown): void;
};
let internals: Internals;

const bytes = (file: string) => existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
const copies = (file: string, marker: string) => [file, `${file}-wal`, `${file}-shm`].map(path => ({ path, found: bytes(path).includes(Buffer.from(marker)) }));
function absent(marker: string) {
  for (const file of [indexFile(), join(DATA_DIR, "messages.db")]) {
    for (const copy of copies(file, marker)) expect(copy.found, copy.path).toBe(false);
  }
}

beforeEach(async () => {
  closeDatabase(); await stopWalMaintenance();
  removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  setMemoryMode("capture");
  await vi.waitFor(() => expect(walMaintenanceReady()).toBe(true), { timeout: 10_000 });
  // Force the asynchronous path, then drive its durable jobs explicitly.
  INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0;
  stopMemoryRevocation();
  index = new MemoryIndex(indexFile());
  deletions = new ConversationDeletions({ dataDir: DATA_DIR, database, retryDelaysMs: [] });
  controller = new MemoryWorkerController();
  internals = controller as unknown as Internals;
  internals.child = { connected: true }; internals.ready = true;
});
afterEach(async () => {
  reader?.close(); reader = undefined;
  deletions.dispose();
  internals.child = null; await controller.stop();
  index.close(); stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline);
  closeDatabase(); await stopWalMaintenance();
});

/** Same SQLite batch and real controller receipt handler as the helper: the batch is acknowledged at once (MEMDEL-SIMPLIFY-109); a
 * forget's scrub is the index's own durable debt, stepped separately (scrub below). The worker test pins the helper's timer itself. */
async function project(): Promise<void> {
  const pending = pendingProjectionRecords(database(), 16);
  const records: IndexedMemory[] = pending.map(row => ({
    id: String(row.id), version: Number(row.version), scopeId: String(row.scopeId),
    text: row.state === "deleted" ? "" : String(row.text), deleted: row.state === "deleted",
    archived: row.state !== "active", rolled: Number(row.rolled) === 1,
    ageKey: row.ageKey === null || row.ageKey === undefined ? null : Number(row.ageKey),
  }));
  index.upsert(records);
  const requestId = randomUUID();
  internals.indexing = true; internals.indexRequestId = requestId;
  internals.indexSent = new Map(pending.map(row => [`${row.id}\u0000${row.version}`, String(row.state)]));
  internals.indexRolled = new Set(records.filter(row => row.rolled).map(row => `${row.id}\u0000${row.version}`));
  internals.onWorkerMessage(internals.child, {
    type: "index-result", requestId, embeddingStatus: "unavailable", scrubOwed: index.deletionScrubPending(),
    records: records.map(({ id, version, deleted }) => ({ id, version, deleted })),
  });
  await vi.waitFor(() => expect(internals.indexing).toBe(false));
}
/** Every pending receipt projected, batch after batch. */
async function projectAll(): Promise<void> {
  for (let n = 0; pendingProjectionRecords(database(), 1).length && n < 50; n++) await project();
  expect(pendingProjectionRecords(database(), 1)).toEqual([]);
}
/** The helper's scrub timer, stepped directly until the debt is paid (true) or a reader blocks the checkpoint (false). Never live data. */
function scrubUntilBlocked(): boolean {
  for (let step = 0; step < 25_000; step++) {
    if (index.scrubDeleted()) return true;
    if (index.scrubBlocked) return false;
  }
  throw new Error("fixture scrub did not finish");
}

async function seed(wholeBot = false) {
  const store = new Store(() => ({ instanceId: "fixture", model: "fixture" }));
  const bot = store.createBot({ name: "Deletion fixture" });
  const task = store.createTask(bot.id, "Chat fixture", false)!;
  reconcileMemoryRoster(store);
  // One lowercase token: it appears in raw text, postings and FTS segments,
  // and is unaffected by the financial-number masker.
  const marker = `memscrub${randomUUID().replaceAll("-", "").replace(/\d/g, digit => String.fromCharCode(107 + Number(digit)))}`;
  store.appendMessage(task.threadId, { role: "user", kind: "text", text: `Remember the fixture word ${marker}.` });
  if (wholeBot) store.appendMessage(bot.threadId, { role: "user", kind: "text", text: `Another chat with ${marker}.` });
  for (let n = 0; n < 50; n++) {
    const work = claimMemoryJob("scrub-fixture");
    if (!work) break;
    publishMemoryWork(work, "scrub-fixture", captureWork(work));
  }
  expect(database().prepare("SELECT 1 FROM memory_records WHERE instr(text,?)>0").get(marker)).toBeTruthy();
  await projectAll();
  expect(copies(indexFile(), marker).some(copy => copy.found)).toBe(true);
  // Keep an unrelated indexed entry to catch a whole-file wipe.
  index.upsert([{ id: "kept", version: 1, scopeId: "kept", text: "unrelated retained words", deleted: false }]);
  return { store, bot, task, marker };
}

const pendingDeletes = () => Number(database().prepare("SELECT count(*) AS n FROM memory_projection_receipts WHERE lexical_status='delete-pending'").get()!.n);
const revoke = () => transaction(db => runRevocationJobsNow(db));

it("a blocked rewrite keeps its merge owed across restart and the successful retry leaves no WAL frames", () => {
  const oldWord = "orchidrewritefixture";
  const row = { id: "rewrite", version: 1, scopeId: "fixture", text: oldWord, deleted: false };
  index.upsert([row]);
  reader = new DatabaseSync(indexFile()); reader.exec("BEGIN"); reader.prepare("SELECT text FROM entries").all();
  index.upsert([{ ...row, text: "retained replacement" }]);
  expect(index.finishRewrite()).toBe(false);
  expect(index.maintenanceOwed()).toBe(true);
  index.close(); index = new MemoryIndex(indexFile());
  expect(index.maintenanceOwed()).toBe(true);
  reader.exec("COMMIT"); reader.close(); reader = undefined;
  expect(index.finishRewrite()).toBe(true);
  expect(index.maintenanceOwed()).toBe(false);
  expect(bytes(`${indexFile()}-wal`).length).toBe(0);
  for (const copy of copies(indexFile(), oldWord)) expect(copy.found, copy.path).toBe(false);
  expect(index.search("replacement", [{ id: row.id, version: 1 }], null, "unused").hits.map(hit => hit.id)).toEqual([row.id]);
});

async function finish(marker: string) {
  expect(pendingDeletes()).toBe(0);
  expect(index.deletionScrubPending()).toBe(false);
  expect(deletions.pending()).toEqual([]);
  // The controller scrubs later authority writes without reopening the chat's journal.
  await vi.waitFor(() => expect(walScrubPending()).toBe(false), { timeout: 10_000 });
  // Inspect while the writer is still open: close must not hide a missed scrub.
  absent(marker);
  const probe = new DatabaseSync(indexFile(), { readOnly: true });
  try {
    expect(probe.prepare("SELECT text FROM entries WHERE id='kept'").get()?.text).toBe("unrelated retained words");
    expect(probe.prepare("SELECT 1 FROM postings WHERE term=?").get(marker)).toBeUndefined();
    expect(probe.prepare("SELECT 1 FROM lexical WHERE lexical MATCH ?").get(marker)).toBeUndefined();
  } finally { probe.close(); }
}

it.each(["chat", "bot"] as const)("%s deletion scrubs both databases and their WAL/SHM bytes after asynchronous removal", async kind => {
  const { store, bot, task, marker } = await seed(kind === "bot");
  const result = await runConversationDeletion(deletions, {
    threadIds: kind === "bot" ? [bot.threadId, task.threadId] : [task.threadId],
    ...(kind === "bot" ? { botIds: [bot.id] } : {}),
  }, () => kind === "bot" ? store.deleteBot(bot.id) : store.deleteTask(bot.id, task.threadId));
  expect(result.result).toBeTruthy();
  expect(result.report.failed).toEqual([]);
  expect(result.report.leftovers).toContainEqual({ what: "Removed; finishing cleanup", where: "local memory; Murage retries automatically" });
  expect(deletions.pending()).toEqual([]);
  revoke();
  expect(pendingDeletes()).toBeGreaterThan(0);
  await projectAll();
  expect(pendingDeletes()).toBe(0);
  expect(index.deletionScrubPending()).toBe(true);
  expect(scrubUntilBlocked()).toBe(true);
  await finish(marker);
}, 30_000);

it("a pinned reader keeps the index's scrub owed while receipts and chat removal finish, then retry clears it without repeating the merge", async () => {
  const { store, bot, task, marker } = await seed();
  reader = new DatabaseSync(indexFile());
  reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM entries").get();
  expect(bytes(`${indexFile()}-wal`).includes(marker)).toBe(true);
  await runConversationDeletion(deletions, { threadIds: [task.threadId] }, () => store.deleteTask(bot.id, task.threadId));
  revoke();
  await projectAll();
  expect(scrubUntilBlocked()).toBe(false);
  // Acknowledged: no receipt waits on the scrub, which stays the index's own durable debt.
  expect(pendingDeletes()).toBe(0);
  expect(index.deletionScrubPending()).toBe(true);
  expect(deletions.pending()).toEqual([]);
  // A second blocked attempt keeps the completed merge, rather than optimizing again.
  const exec = vi.spyOn((index as unknown as { db: DatabaseSync }).db, "exec");
  try {
    expect(scrubUntilBlocked()).toBe(false);
    expect(exec.mock.calls.some(([sql]) => sql.includes("'optimize'"))).toBe(false);
  } finally { exec.mockRestore(); }
  const probe = new DatabaseSync(indexFile());
  try { expect(probe.prepare("SELECT value FROM index_meta WHERE key='delete_scrub_owed'").get()?.value).toBe("truncate"); }
  finally { probe.close(); }
  expect(bytes(`${indexFile()}-wal`).includes(marker)).toBe(true);
  reader.exec("COMMIT"); reader.close(); reader = undefined;
  expect(scrubUntilBlocked()).toBe(true);
  await finish(marker);
}, 30_000);

it("an unprojected deletion leaves a visible cleanup state and cannot hold the next chat deletion", async () => {
  const { store, bot, task, marker } = await seed();
  const first = await runConversationDeletion(deletions, { threadIds: [task.threadId] }, () => store.deleteTask(bot.id, task.threadId));
  revoke();
  const owed = pendingDeletes();
  expect(owed).toBeGreaterThan(0);
  // No project() or acknowledgement: the first deletion's receipts stay owed.
  const next = store.createTask(bot.id, "Next chat fixture", false)!;
  const second = await runConversationDeletion(deletions, { threadIds: [next.threadId] }, () => store.deleteTask(bot.id, next.threadId));
  for (const result of [first, second]) {
    expect(result.result).toBeTruthy();
    expect(result.report.failed).toEqual([]);
    expect(result.report.leftovers).toContainEqual({ what: "Removed; finishing cleanup", where: "local memory; Murage retries automatically" });
  }
  expect(deletions.pending()).toEqual([]);
  expect(pendingDeletes()).toBeGreaterThanOrEqual(owed);
  // A restart owes cleanup but does not resurrect either removed chat.
  deletions.dispose(); deletions = new ConversationDeletions({ dataDir: DATA_DIR, database, retryDelaysMs: [] });
  expect(await deletions.reconcile(() => false, () => { throw new Error("removed chat was replayed"); })).toBe(0);
  expect(pendingDeletes()).toBeGreaterThanOrEqual(owed);
  revoke();
  await projectAll();
  expect(scrubUntilBlocked()).toBe(true);
  await finish(marker);
}, 30_000);

// memdel r1 (Grok memscrub r2 High): batches are read from the durable receipts in their own order, delete-pending first, with no
// cursor. A forget queued while ordinary rows keep arriving after the last batch's position goes in the very next batch.
it("a forget queued behind the last batch, while new rows keep arriving, is in the very next batch", async () => {
  const {store,bot}=await seed();
  const db=database();
  const scope=String(db.prepare("SELECT scope_id FROM memory_records LIMIT 1").get()!.scope_id);
  let next=0;
  const live=()=>{
    const id=`live-${String(next++).padStart(4,"0")}`;
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?,1,?,'fact','retained','observed','active',0,0)").run(id,scope);
    db.prepare("INSERT INTO memory_projection_receipts VALUES(?,1,0,'pending','pending',NULL)").run(id);
  };
  transaction(()=>{for(let n=0;n<40;n++)live();});
  const other=store.createTask(bot.id,"Other chat fixture",false)!;
  store.appendMessage(other.threadId,{role:"user",kind:"text",text:"Remember the retained capture fixture."});
  const batches:string[][]=[];
  internals.child={connected:true,send(message: {type:string;requestId:string;records:IndexedMemory[];stage?:string}){
    if(message.type==='index'){
      batches.push(message.records.map(row=>row.id));
      // Capture keeps adding ordinary rows after this batch's position: a forward-only pass would never run dry.
      if(batches.length<6)transaction(()=>{for(let n=0;n<16;n++)live();});
      // The owner forgets a memory whose receipt sorts before everything this batch took.
      if(batches.length===1)transaction(()=>{
        db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES('aaa-forgotten',1,?,'fact','','observed','deleted',0,0)").run(scope);
        db.prepare("INSERT INTO memory_projection_receipts VALUES('aaa-forgotten',1,0,'delete-pending','delete-pending',NULL)").run();
      });
      internals.onWorkerMessage(internals.child,{type:"index-result",requestId:message.requestId,embeddingStatus:"indexed",records:message.records});
    }else if(message.stage==='capture'){
      const work=message as unknown as Parameters<typeof captureWork>[0];
      internals.onWorkerMessage(internals.child,{type:"result",result:captureWork(work)});
    }
  }};
  vi.useFakeTimers({toFake:["setTimeout","clearTimeout","setImmediate","clearImmediate","Date","performance"]});
  try{
    controller.start();
    for(let n=0;n<400&&batches.length<2;n++)await vi.advanceTimersByTimeAsync(50);
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0]).not.toContain("aaa-forgotten");
    expect(batches[1][0]).toBe("aaa-forgotten");
    await vi.waitFor(()=>expect(db.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id='aaa-forgotten'").get()?.lexical_status).toBe("deleted"));
  }finally{vi.useRealTimers();}
},30_000);

it("a crash mid-scrub keeps the index's scrub owed, and a restarted helper resumes that merge and erases the bytes", async () => {
  const { store, bot, task, marker } = await seed();
  await runConversationDeletion(deletions, { threadIds: [task.threadId] }, () => store.deleteTask(bot.id, task.threadId));
  revoke();
  await projectAll();
  expect(pendingDeletes()).toBe(0);
  // One merge step committed, then the helper dies: no last-close checkpoint (an open reader keeps the log as it was).
  expect(index.scrubDeleted()).toBe(false);
  expect(index.deletionScrubPending()).toBe(true);
  expect(copies(indexFile(), marker).some(copy => copy.found)).toBe(true);
  reader = new DatabaseSync(indexFile()); reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM entries").get();
  index.close();
  reader.exec("COMMIT"); reader.close(); reader = undefined;
  // Restart: only the index's own marker is left, and it is enough.
  index = new MemoryIndex(indexFile());
  expect(index.deletionScrubPending()).toBe(true);
  expect(scrubUntilBlocked()).toBe(true);
  await finish(marker);
}, 30_000);

it("startup settles a blocked scrub, including lexical_age shadow tables, before receipts are replayed", async () => {
  const { store, bot, task, marker } = await seed();
  // Reproduce an index midway through its age-order fill.
  const setup = new DatabaseSync(indexFile());
  try {
    setup.exec("DELETE FROM index_meta WHERE key='lexical_rowids'");
    ensureAgeTables(setup);
    setup.exec("INSERT INTO lexical_age SELECT id,version,text FROM lexical; INSERT INTO lexical_age_keys SELECT id,CAST(version AS INTEGER),rowid FROM lexical_age");
  } finally { setup.close(); }
  index.close(); index = new MemoryIndex(indexFile());
  reader = new DatabaseSync(indexFile()); reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM lexical_age").get();
  await runConversationDeletion(deletions, { threadIds: [task.threadId] }, () => store.deleteTask(bot.id, task.threadId));
  revoke(); await projectAll(); expect(scrubUntilBlocked()).toBe(false);
  expect(index.deletionScrubPending()).toBe(true);
  // Keep another connection open so closing the writer cannot scrub on last close.
  index.close();
  reader.exec("COMMIT");
  index = new MemoryIndex(indexFile());
  expect(index.deletionScrubPending()).toBe(false);
  expect(copies(indexFile(), marker).some(copy => copy.found)).toBe(false);
  expect(reader.prepare("SELECT 1 FROM lexical_age WHERE lexical_age MATCH ?").get(marker)).toBeUndefined();
  reader.close(); reader = undefined;
  expect(pendingDeletes()).toBe(0);
  await finish(marker);
}, 30_000);

it("an acknowledged rollover is requeued by a real forget and its late acknowledgement cannot clear that debt", async () => {
  const { store, bot, task, marker } = await seed();
  const db = database();
  const row = db.prepare("SELECT id,version,scope_id FROM memory_records WHERE instr(text,?)>0 LIMIT 1").get(marker)!;
  transaction(() => {
    db.prepare("UPDATE memory_records SET state='archived',kind='checkpoint' WHERE id=? AND version=?").run(row.id, row.version);
    db.prepare("INSERT INTO memory_records(id,version,scope_id,kind,text,assertion,state,valid_from,created_at) VALUES(?, ?, ?, 'checkpoint','retained successor','assistant-inference','active',0,0)").run(row.id, Number(row.version) + 1, row.scope_id);
    db.prepare("UPDATE memory_projection_receipts SET lexical_status='deleted',embedding_status='deleted' WHERE record_id=? AND record_version=?").run(row.id, row.version);
  });
  index.upsert([{ id: String(row.id), version: Number(row.version), scopeId: String(row.scope_id), text: "", deleted: true, rolled: true }]);
  expect(index.deletionScrubPending()).toBe(false);
  await runConversationDeletion(deletions, { threadIds: [task.threadId] }, () => store.deleteTask(bot.id, task.threadId));
  revoke();
  const status = () => db.prepare("SELECT lexical_status FROM memory_projection_receipts WHERE record_id=? AND record_version=?").get(row.id, row.version)?.lexical_status;
  expect(status()).toBe("delete-pending");
  internals.indexing = true; internals.indexRequestId = "late-rollover";
  internals.indexRolled = new Set([`${row.id}\u0000${row.version}`]);
  internals.onWorkerMessage(internals.child, { type: "index-result", requestId: "late-rollover", records: [{ id: String(row.id), version: Number(row.version), deleted: true }] });
  await vi.waitFor(() => expect(internals.indexing).toBe(false));
  expect(status()).toBe("delete-pending");
  await projectAll();
  expect(status()).toBe("deleted");
  expect(scrubUntilBlocked()).toBe(true);
  await finish(marker);
}, 30_000);

/** Read the durable phase without closing the writer or implicitly checkpointing it. */
function scrubMeta(key:string):string|undefined{
  const db=(index as unknown as {db:DatabaseSync}).db;
  const value=db.prepare("SELECT value FROM index_meta WHERE key=?").get(key)?.value;
  return value===undefined?undefined:String(value);
}
function mergeToCheckpoint(){
  for(let n=0;n<25_000&&scrubMeta("delete_scrub_owed")==="merge";n++)expect(index.scrubDeleted()).toBe(false);
  expect(scrubMeta("delete_scrub_owed")).toBe("truncate");
}

it("a large index uses one-page merge budgets, resumes mid-merge, and erases raw bytes while retaining other rows", () => {
  const marker="orchidlargeindexfixture";
  // Many distinct tokens and retained postings: forcing all segments into one cannot fit in one page.
  for(let batch=0;batch<512;batch++){
    index.upsert(Array.from({length:16},(_,offset)=>{
      const n=batch*16+offset;
      return {id:`large-${n}`,version:1,scopeId:"large-fixture",deleted:false,
        text:Array.from({length:80},(_,word)=>`fixtureterm${n}part${word}`).join(" ")+(n<16?` ${marker}`:"")};
    }));
  }
  index.upsert(Array.from({length:16},(_,n)=>({id:`large-${n}`,version:1,scopeId:"large-fixture",deleted:true,text:""})));
  const budgets:number[]=[],durations:number[]=[];
  let steps=0,restarted=false;
  while(index.deletionScrubPending()&&steps<25_000){
    const db=(index as unknown as {db:DatabaseSync}).db;
    const prepare=db.prepare.bind(db),exec=vi.spyOn(db,"exec");
    let commands=0;
    const restoreRuns:Array<()=>void>=[];
    const spy=vi.spyOn(db,"prepare").mockImplementation(sql=>{
      const statement=prepare(sql);
      if(sql.includes("VALUES('merge',?)")){
        commands++;
        const run=statement.run.bind(statement);
        const runSpy=vi.spyOn(statement,"run").mockImplementation((...parameters)=>{
          budgets.push(Number(parameters[0]));
          return run(...parameters);
        });
        restoreRuns.push(()=>runSpy.mockRestore());
      }
      return statement;
    });
    const began=performance.now();
    try{
      index.scrubDeleted();
      if(commands)durations.push(performance.now()-began);
      expect(commands).toBeLessThanOrEqual(1);
      expect(exec.mock.calls.some(([sql])=>sql.includes("'optimize'"))).toBe(false);
    }finally{for(const restore of restoreRuns)restore();spy.mockRestore();exec.mockRestore();}
    steps++;
    if(steps===3){
      expect(scrubMeta("delete_scrub_owed")).toBe("merge");
      expect(JSON.parse(scrubMeta("delete_scrub_merge")!).started).toBe(true);
      // A keeper connection prevents last-close checkpointing from masking persistence errors.
      reader=new DatabaseSync(indexFile());
      index.close();index=new MemoryIndex(indexFile());restarted=true;
    }
    // A normal search can run between every pair of merge steps.
    expect(index.search("fixtureterm8191part0",[{id:"large-8191",version:1}],null,"unused").hits.map(row=>row.id)).toEqual(["large-8191"]);
  }
  expect(restarted).toBe(true);
  expect(steps).toBeGreaterThan(10);
  expect(index.deletionScrubPending()).toBe(false);
  expect(budgets[0]).toBe(-DELETE_SCRUB_MERGE_PAGES);
  expect(budgets.slice(1).every(pages=>pages===DELETE_SCRUB_MERGE_PAGES)).toBe(true);
  // Wall-clock guard complements the one-command, one-page merge budget on the build box.
  // The final checkpoint has its separate 50 ms reader wait and is not a merge step.
  expect(Math.max(...durations)).toBeLessThan(50);
  for(const copy of copies(indexFile(),marker))expect(copy.found,copy.path).toBe(false);
  // Lost ack replay reuses the completed generation, without opening another merge.
  index.upsert([{id:"large-0",version:1,scopeId:"large-fixture",deleted:true,text:""}]);
  expect(index.deletionScrubPending()).toBe(false);
},120_000);

it.each(["during-merge","awaiting-truncate"] as const)("a rolled-out then forgotten row advances the generation %s", phase => {
  const first="orchidfirstgeneration",later="orchidlatergeneration";
  const row=(id:string,text:string,deleted=false,rolled=false)=>({id,version:1,scopeId:"generation-fixture",text,deleted,rolled});
  index.upsert([row("first",first),row("later",later),row("retained","retained generation fixture")]);
  reader=new DatabaseSync(indexFile());reader.exec("BEGIN");reader.prepare("SELECT text FROM entries").all();
  index.upsert([row("first","",true)]);
  expect(index.scrubDeleted()).toBe(false);
  if(phase==="awaiting-truncate"){
    mergeToCheckpoint();
    expect(index.scrubDeleted()).toBe(false);
    expect(index.scrubBlocked).toBe(true);
  }
  const covered=JSON.parse(scrubMeta("delete_scrub_merge")!).generation;
  index.upsert([row("later","",true,true)]);
  expect(Number(scrubMeta("delete_generation"))).toBeGreaterThan(covered);
  const generation=scrubMeta("delete_generation");
  // The forget itself now finds no row. Replaying it must neither skip nor restart its generation.
  index.upsert([row("later","",true)]);
  expect(scrubMeta("delete_generation")).toBe(generation);
  expect(index.scrubDeleted()).toBe(false);
  expect(scrubMeta("delete_scrub_owed")).toBe("merge");
  mergeToCheckpoint();
  expect(JSON.parse(scrubMeta("delete_scrub_merge")!).generation).toBe(Number(generation));
  expect(index.scrubDeleted()).toBe(false);
  expect(index.scrubBlocked).toBe(true);
  reader.exec("COMMIT");reader.close();reader=undefined;
  expect(index.scrubDeleted()).toBe(true);
  for(const marker of [first,later])for(const copy of copies(indexFile(),marker))expect(copy.found,copy.path).toBe(false);
  expect(index.search("retained",[{id:"retained",version:1}],null,"unused").hits.map(hit=>hit.id)).toEqual(["retained"]);
});
