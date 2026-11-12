// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.ts";
import { database, transaction } from "./database.ts";
import { appendMessage, closeMessageDb, deleteThread, insertMessage, insertMessageAfter, insertMessageBefore, searchMessagesWithMeta, setActiveLeaf, updateMessage } from "./message-db.ts";
import { prepareThreadSummaryBackfill, readThreadSummary, resetThreadSummaries, stepThreadSummaryBackfill, syncThreadSummary, threadSummaryPending } from "./thread-summary.ts";
import { finishBackgroundUpgradeWorkNow } from "./database.ts";
import { forgottenMessages } from "./memory/memory-revocation.ts";
import { removeTempDirSync } from "./testing/cleanup.ts";
import type { Message } from "./store.ts";

const msg = (id: string, text: string, parentId: string | null = null, extra: Partial<Message> = {}): Message => ({ id, at: Number(id.replace(/\D/g, "")) || 1, role: "user", kind: "text", text, parentId, ...extra });
const summary = (thread = "t") => readThreadSummary(database(), thread);
beforeEach(() => { closeMessageDb(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { closeMessageDb(); });

it("keeps inserts, replacements, streamed updates and branch switches in step", () => {
  insertMessage("t", msg("m1", "first"));
  expect(summary()?.snippet).toBe("first");
  insertMessage("t", msg("m1", "replacement"));
  expect(summary()?.snippet).toBe("replacement");
  appendMessage("t", msg("m2", "latest", "m1"));
  updateMessage("t", msg("m2", "updated latest", "m1"));
  expect(summary()).toMatchObject({ snippet: "updated latest", last_at: 2, last_role: "user" });
  insertMessage("t", msg("m9", "inactive fork", "m1"));
  expect(summary()?.snippet).toBe("updated latest");
  setActiveLeaf("t", "m9");
  expect(summary()?.snippet).toBe("inactive fork");
  setActiveLeaf("t", "m2");
  expect(summary()?.snippet).toBe("updated latest");
});

it("recomputes after both splice paths and forgetting the newest visible line", () => {
  appendMessage("t", msg("m1", "root"));
  appendMessage("t", msg("m3", "forgotten newest", "m1", { withheldFromBots: "forgotten" }));
  insertMessageBefore("t", msg("m2", "inserted before", "m1"), msg("m3", "forgotten newest", "m2", { withheldFromBots: "forgotten" }));
  expect(summary()?.snippet).toBe("inserted before");
  insertMessageAfter("t", msg("m4", "inserted after", "m2"), "m2", [], [msg("m3", "forgotten newest", "m4", { withheldFromBots: "forgotten" })]);
  expect(summary()?.snippet).toBe("inserted after");
  updateMessage("t", msg("m4", "inserted after", "m2", { withheldFromBots: "forgotten" }));
  expect(summary()?.snippet).toBe("inserted before");
  expect(searchMessagesWithMeta("forgotten newest", 40, ["t"], { owner: true, excludeForgotten: true }).hits).toEqual([]);
});

it("commits the summary with the write, rolls it back together, and deletes it with the thread", () => {
  appendMessage("t", msg("m1", "original"));
  expect(() => appendMessage("t", msg("m2", "rolled back", "m1"), () => {
    expect(summary()?.snippet).toBe("rolled back");
    throw new Error("fixture rollback");
  })).toThrow("fixture rollback");
  expect(summary()?.snippet).toBe("original");
  expect(database().prepare("SELECT 1 FROM messages WHERE id='m2'").get()).toBeUndefined();
  deleteThread("t");
  expect(summary()).toBeUndefined();
  expect(searchMessagesWithMeta("original", 40, ["t"], { owner: true, excludeForgotten: true }).hits).toEqual([]);
});

it("excludes memory tombstones in the forget transaction even without a registered UI hook", () => {
  appendMessage("t", msg("m1", "kept"));
  appendMessage("t", msg("m2", "forgotten source", "m1"));
  transaction(db => {
    db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES('summary-scope','conversation','owner', '[]',0)").run();
    db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES('message:t:m2','summary-scope','t','m2',NULL,1,'h','message','owner','captured',NULL,'deleted') ON CONFLICT(id) DO UPDATE SET state='deleted'").run();
    db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('summary-forget','source','message:t:m2',NULL,NULL,1,'owner-forget',1)").run();
    forgottenMessages(db, ["message:t:m2"]);
    expect(summary()?.snippet).toBe("kept");
  });
  expect(searchMessagesWithMeta("forgotten source", 40, ["t"], { owner: true, excludeForgotten: true }).hits).toEqual([]);
});

it("skips a line under a source tombstone of any reason and tells open views to ask again", async () => {
  appendMessage("t", msg("m1", "kept"));
  appendMessage("t", msg("m2", "bot deleted line", "m1"));
  let told = 0;
  const dispose = registerChatsGenPublisher(database(), () => { told++; });
  try {
    transaction(db => {
      db.prepare("INSERT OR IGNORE INTO memory_scopes VALUES('summary-scope','conversation','owner', '[]',0)").run();
      db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,turn_id,revision,content_hash,kind,speaker,outcome,branch_id,state) VALUES('message:t:m2','summary-scope','t','m2',NULL,1,'h','message','owner','captured',NULL,'active') ON CONFLICT(id) DO NOTHING").run();
      db.prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,content_hash,epoch,reason,created_at) VALUES('summary-other','source','message:t:m2',NULL,NULL,1,'bot-deleted',1)").run();
      forgottenMessages(db, ["message:t:m2"]);
    });
    await new Promise(resolve => setTimeout(resolve, 300));
  } finally { dispose(); }
  expect(summary()?.snippet).toBe("kept");
  expect(told).toBe(1);
  expect(searchMessagesWithMeta("bot deleted line", 40, ["t"], { owner: true, excludeForgotten: true }).hits).toEqual([]);
});

it("allows owner-withheld text, folds whitespace, caps Unicode snippets and stops after 50 ancestors", () => {
  appendMessage("t", msg("m1", "  😀\n".repeat(200), null, { withheldFromBots: true }));
  expect([...summary()!.snippet]).toHaveLength(160);
  expect(summary()?.snippet).not.toContain("\n");
  for (let n = 2; n <= 51; n++) appendMessage("t", msg(`m${n}`, "forgotten", `m${n - 1}`, { withheldFromBots: "forgotten" }));
  expect(summary()?.snippet).toBe("");
});

it("backfills bounded chunks, resumes after reopen and does not skip history behind a live write", () => {
  for (let n = 1; n <= 12; n++) insertMessage(`t${n}`, msg(`m${n}`, `old ${n}`));
  resetThreadSummaries(database());
  const first = stepThreadSummaryBackfill(database(), 2);
  expect(first.more).toBe(true);
  expect(first.done).toBeLessThanOrEqual(2);
  insertMessage("live", msg("m100", "live write"));
  closeMessageDb();
  prepareThreadSummaryBackfill(database());
  expect(threadSummaryPending(database())).toBe(true);
  let steps = 0;
  while (stepThreadSummaryBackfill(database(), 2).more) { expect(++steps).toBeLessThan(20); }
  expect(threadSummaryPending(database())).toBe(false);
  for (let n = 1; n <= 12; n++) expect(summary(`t${n}`)?.snippet).toBe(`old ${n}`);
  expect(summary("live")?.snippet).toBe("live write");
});

it("commits its cursor after the time budget and resumes after a failed chunk", () => {
  for (let n = 1; n <= 4; n++) insertMessage(`t${n}`, msg(`m${n}`, `kept ${n}`));
  resetThreadSummaries(database());
  let tick = 0;
  expect(stepThreadSummaryBackfill(database(), 100, () => tick++ * 21)).toMatchObject({ more: true, done: 1 });
  const before = database().prepare("SELECT cursor FROM transcript_index_state WHERE name='thread_summary'").get();
  database().exec("CREATE TRIGGER summary_fixture_failure BEFORE INSERT ON thread_summary BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  try { expect(() => stepThreadSummaryBackfill(database())).toThrow("fixture failure"); }
  finally { database().exec("DROP TRIGGER summary_fixture_failure"); }
  expect(database().prepare("SELECT cursor FROM transcript_index_state WHERE name='thread_summary'").get()).toEqual(before);
  while (stepThreadSummaryBackfill(database()).more) { /* resume */ }
  expect(summary("t4")?.snippet).toBe("kept 4");
});

it("rebuilds restored summaries with background upgrade work and reads previews by primary key only", () => {
  appendMessage("t", msg("m1", "visible"));
  appendMessage("t", msg("m2", "private forgotten", "m1", { withheldFromBots: "forgotten" }));
  database().prepare("UPDATE thread_summary SET snippet='stale archive text'").run();
  resetThreadSummaries(database());
  expect(summary()).toBeUndefined();
  expect(threadSummaryPending(database())).toBe(true);
  finishBackgroundUpgradeWorkNow();
  expect(summary()?.snippet).toBe("visible");
  expect(threadSummaryPending(database())).toBe(false);
  const spy = vi.spyOn(database(), "prepare");
  try {
    summary();
    expect(spy.mock.calls.every(([sql]) => sql.includes("FROM thread_summary WHERE thread_id=?"))).toBe(true);
  } finally { spy.mockRestore(); }
  // No row can be resurrected by a late summary refresh after deletion.
  deleteThread("t"); syncThreadSummary(database(), "t");
  expect(summary()).toBeUndefined();
});

// BF-1: every helper statement belongs to the supplied private file.
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { bumpChatsGen, downgradeChatsPreviewTables, readChatsGen, registerChatsGenPublisher, remintChatsGen, publishChatsGenImmediately } from "./thread-summary.ts";

it.each(["update", "commit", "second drop"])("BF-1 rolls back %s on the candidate without touching serving storage", fault => {
  const candidate = new DatabaseSync(join(DATA_DIR, "candidate.db"));
  const serving = database();
  remintChatsGen(candidate);
  candidate.exec("INSERT INTO thread_summary(thread_id,snippet) VALUES('private','candidate')");
  const original = readChatsGen(candidate), servingGen = readChatsGen(serving);
  const serveExec = vi.spyOn(serving, "exec"), servePrepare = vi.spyOn(serving, "prepare");
  const rawExec = candidate.exec.bind(candidate), rawPrepare = candidate.prepare.bind(candidate);
  const exec = vi.spyOn(candidate, "exec").mockImplementation(sql => {
    if (fault === "commit" && sql === "COMMIT" || fault === "second drop" && sql === "DROP TABLE IF EXISTS chats_gen") throw new Error("injected fault");
    return rawExec(sql);
  });
  const prepare = vi.spyOn(candidate, "prepare").mockImplementation(sql => {
    if (fault === "update" && sql.startsWith("UPDATE chats_gen")) throw new Error("injected fault");
    return rawPrepare(sql);
  });
  try {
    expect(() => fault === "second drop" ? downgradeChatsPreviewTables(candidate) : remintChatsGen(candidate)).toThrow("injected fault");
    expect(serveExec).not.toHaveBeenCalled(); expect(servePrepare).not.toHaveBeenCalled();
    expect(readChatsGen(candidate)).toEqual(original);
    expect(readThreadSummary(candidate, "private")?.snippet).toBe("candidate");
    expect(readChatsGen(serving)).toEqual(servingGen);
  } finally { exec.mockRestore(); prepare.mockRestore(); serveExec.mockRestore(); servePrepare.mockRestore(); candidate.close(); }
});

it("BF-1 keeps the parent transaction when a nested drop fails", () => {
  const candidate = new DatabaseSync(join(DATA_DIR, "nested.db"));
  remintChatsGen(candidate);
  const original = readChatsGen(candidate);
  candidate.exec("CREATE TABLE sentinel(value); BEGIN IMMEDIATE; INSERT INTO sentinel VALUES(42)");
  const raw = candidate.exec.bind(candidate);
  const exec = vi.spyOn(candidate, "exec").mockImplementation(sql => {
    if (sql === "DROP TABLE IF EXISTS chats_gen") throw new Error("second drop failed");
    return raw(sql);
  });
  try {
    expect(() => downgradeChatsPreviewTables(candidate)).toThrow("second drop failed");
    expect(candidate.isTransaction).toBe(true);
    expect(readChatsGen(candidate)).toEqual(original);
    candidate.exec("COMMIT");
    expect(candidate.prepare("SELECT value FROM sentinel").get()?.value).toBe(42);
    expect(candidate.prepare("SELECT name FROM sqlite_schema WHERE name='thread_summary'").get()).toBeDefined();
  } finally { exec.mockRestore(); candidate.close(); }
});

it("publishes only committed generations and cancels work before close", async () => {
  vi.useFakeTimers();
  const candidate = new DatabaseSync(join(DATA_DIR, "publisher.db"));
  remintChatsGen(candidate);
  const original = readChatsGen(candidate), send = vi.fn();
  const dispose = registerChatsGenPublisher(candidate, send);
  try {
    candidate.exec("BEGIN IMMEDIATE"); bumpChatsGen(candidate); candidate.exec("SAVEPOINT child"); bumpChatsGen(candidate); candidate.exec("ROLLBACK TO child; RELEASE child; COMMIT");
    await vi.advanceTimersByTimeAsync(251);
    expect(send).toHaveBeenCalledExactlyOnceWith({ ...original, rev: original.rev + 1 });
    candidate.exec("BEGIN IMMEDIATE"); remintChatsGen(candidate); candidate.exec("ROLLBACK");
    await vi.advanceTimersByTimeAsync(251);
    expect(send).toHaveBeenCalledTimes(1);
    bumpChatsGen(candidate);
    publishChatsGenImmediately(candidate, readChatsGen(candidate));
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(251); expect(send).toHaveBeenCalledTimes(2);
    bumpChatsGen(candidate); dispose(); dispose(); candidate.close();
    await vi.advanceTimersByTimeAsync(1000); expect(send).toHaveBeenCalledTimes(2);
  } finally { dispose(); if (candidate.isOpen) candidate.close(); vi.useRealTimers(); }
});

it("T-PUBLISH never postpones the first frame during a storm and retries failed sends", async () => {
  vi.useFakeTimers();
  const db = database(), original = readChatsGen(db), sent: number[] = [];
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let fail = false;
  const dispose = registerChatsGenPublisher(db, gen => { if (fail) { fail = false; throw Error("sender"); } sent.push(gen.rev); });
  try {
    for (let n = 0; n < 100; n++) { bumpChatsGen(db); await vi.advanceTimersByTimeAsync(4); if (n === 63) expect(sent).toHaveLength(1); }
    await vi.advanceTimersByTimeAsync(251);
    expect(sent).toHaveLength(2); expect(sent[1]).toBe(original.rev + 100);
    fail = true; bumpChatsGen(db); publishChatsGenImmediately(db, readChatsGen(db));
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(sent).toEqual([expect.any(Number), original.rev + 100, original.rev + 101]);
  } finally { dispose(); log.mockRestore(); vi.useRealTimers(); }
});

it("BF-1 nested remint failure preserves parent work and original preview rows", () => {
  const db = database(), original = readChatsGen(db);
  db.exec("CREATE TABLE preview_parent(value); BEGIN; INSERT INTO preview_parent VALUES(7)");
  const raw = db.prepare.bind(db);
  const spy = vi.spyOn(db, "prepare").mockImplementation(sql => { if (sql.startsWith("UPDATE chats_gen SET epoch")) throw Error("update failed"); return raw(sql); });
  try {
    expect(() => remintChatsGen(db)).toThrow("update failed");
    expect(db.isTransaction).toBe(true); expect(readChatsGen(db)).toEqual(original);
    db.exec("COMMIT"); expect(db.prepare("SELECT value FROM preview_parent").get()?.value).toBe(7);
  } finally { spy.mockRestore(); }
});

it("T-DOWNGRADE drops only the supplied handle and repeated drops are harmless", () => {
  const candidate = new DatabaseSync(join(DATA_DIR, "downgrade.db")), serving = database(), original = readChatsGen(serving);
  try {
    remintChatsGen(candidate); downgradeChatsPreviewTables(candidate); downgradeChatsPreviewTables(candidate);
    expect(candidate.prepare("SELECT name FROM sqlite_schema WHERE name IN ('thread_summary','chats_gen')").all()).toEqual([]);
    expect(readChatsGen(serving)).toEqual(original);
    remintChatsGen(candidate); expect(readChatsGen(candidate).epoch).not.toBe(original.epoch);
  } finally { candidate.close(); }
});

import { publishChatsGenHeartbeat, publishChatsGenIfMoved } from "./thread-summary.ts";
it("T-PUBLISH-LIFETIME guards heartbeat and probes before any SQL on an unregistered or disposed handle", async () => {
  vi.useFakeTimers(); const db = new DatabaseSync(join(DATA_DIR,"lifetime.db")); remintChatsGen(db);
  const send = vi.fn(), original = readChatsGen(db);
  const probe = vi.spyOn(db,"prepare");
  publishChatsGenHeartbeat(db); publishChatsGenIfMoved(db); publishChatsGenImmediately(db,original);
  expect(probe).not.toHaveBeenCalled();
  const dispose = registerChatsGenPublisher(db,send); bumpChatsGen(db);
  await vi.advanceTimersByTimeAsync(1); dispose(); probe.mockClear(); db.close();
  publishChatsGenHeartbeat(db); publishChatsGenIfMoved(db); publishChatsGenImmediately(db,original);
  await vi.advanceTimersByTimeAsync(1000); expect(probe).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  probe.mockRestore(); vi.useRealTimers();
});

it("BF-1 preserves both original and cleanup errors when finalization and rollback fail", () => {
  const db = new DatabaseSync(join(DATA_DIR,"cleanup.db")); remintChatsGen(db);
  const raw = db.exec.bind(db);
  const spy = vi.spyOn(db,"exec").mockImplementation(sql => { if (sql === "COMMIT" || sql === "ROLLBACK") throw Error(sql); raw(sql); });
  try {
    let failure: unknown; try { remintChatsGen(db); } catch(error) { failure=error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(error => error.message)).toEqual(["COMMIT","ROLLBACK"]);
  } finally { spy.mockRestore(); db.exec("ROLLBACK"); db.close(); }
});

it("BF-1 nested helper scopes have distinct names and roll back only the failed child", () => {
  const candidate = new DatabaseSync(join(DATA_DIR, "nested-scopes.db"));
  const serving = database(), servingGen = readChatsGen(serving);
  remintChatsGen(candidate);
  const original = readChatsGen(candidate), raw = candidate.exec.bind(candidate);
  const scopes: string[] = []; let inside = false;
  candidate.exec("CREATE TABLE parent_scope(value); BEGIN; INSERT INTO parent_scope VALUES(9)");
  const spy = vi.spyOn(candidate, "exec").mockImplementation(sql => {
    if (sql.startsWith("SAVEPOINT ")) scopes.push(sql.slice(10));
    if (sql === "DROP TABLE IF EXISTS chats_gen" && inside) throw Error("nested child");
    raw(sql);
    if (sql.startsWith("SAVEPOINT ") && !inside) {
      inside = true;
      expect(() => downgradeChatsPreviewTables(candidate)).toThrow("nested child");
      expect(readChatsGen(candidate)).toEqual(original);
      expect(candidate.prepare("SELECT name FROM sqlite_schema WHERE name='thread_summary'").get()).toBeDefined();
    }
  });
  try {
    remintChatsGen(candidate);
    expect(scopes).toHaveLength(2); expect(new Set(scopes).size).toBe(2);
    expect(candidate.isTransaction).toBe(true);
    expect(readChatsGen(candidate).epoch).not.toBe(original.epoch);
    candidate.exec("COMMIT");
    expect(candidate.prepare("SELECT value FROM parent_scope").get()?.value).toBe(9);
    expect(readChatsGen(serving)).toEqual(servingGen);
  } finally { spy.mockRestore(); candidate.close(); }
});

it.each(["open", "release"])("BF-1 %s failure never rolls back the caller's transaction", fault => {
  const db = new DatabaseSync(join(DATA_DIR, `scope-${fault}.db`)); remintChatsGen(db);
  const original = readChatsGen(db); db.exec("CREATE TABLE parent(value); BEGIN; INSERT INTO parent VALUES(8)");
  const raw = db.exec.bind(db), statements: string[] = []; let failed = false;
  const spy = vi.spyOn(db,"exec").mockImplementation(sql => {
    statements.push(sql);
    if (!failed && sql.startsWith(fault === "open" ? "SAVEPOINT " : "RELEASE ")) { failed = true; throw Error(fault); }
    raw(sql);
  });
  try {
    expect(() => remintChatsGen(db)).toThrow(fault);
    expect(db.isTransaction).toBe(true); expect(readChatsGen(db)).toEqual(original);
    expect(statements).not.toContain("ROLLBACK");
    if (fault === "open") expect(statements).toHaveLength(1);
    else expect(statements.some(sql => sql.startsWith("ROLLBACK TO chats_preview_"))).toBe(true);
    db.exec("COMMIT"); expect(db.prepare("SELECT value FROM parent").get()?.value).toBe(8);
  } finally { spy.mockRestore(); db.close(); }
});

it("BF-1 nested remint publishes only after outer commit and unregistered handles schedule nothing",async()=>{
  vi.useFakeTimers();
  const db=database(), send=vi.fn(), dispose=registerChatsGenPublisher(db,send);
  const candidate=new DatabaseSync(join(DATA_DIR,"unregistered-scope.db"));
  try {
    db.exec("BEGIN"); remintChatsGen(db); const gen=readChatsGen(db);
    await vi.advanceTimersByTimeAsync(500);expect(send).not.toHaveBeenCalled();
    db.exec("COMMIT");await vi.advanceTimersByTimeAsync(501);expect(send).toHaveBeenCalledExactlyOnceWith(gen);
    dispose(); await vi.runOnlyPendingTimersAsync();const timers=vi.getTimerCount();
    remintChatsGen(candidate); expect(vi.getTimerCount()).toBe(timers);
    candidate.close();await vi.advanceTimersByTimeAsync(1000);expect(send).toHaveBeenCalledTimes(1);
  } finally {dispose();if(candidate.isOpen)candidate.close();vi.useRealTimers();}
});

import * as servingAccess from "./database.ts";
import { withChatsPreviewTransaction, rebuildThreadSummaries } from "./thread-summary.ts";
it("T-HANDLE-ONLY runs every preview helper with serving acquisition forbidden", async () => {
  servingAccess.closeDatabase();
  const acquire=vi.spyOn(servingAccess,"database").mockImplementation(()=>{throw Error("serving acquisition");});
  const tx=vi.spyOn(servingAccess,"transaction").mockImplementation(()=>{throw Error("serving transaction");});
  const db=new DatabaseSync(join(DATA_DIR,"offline.db"));
  const other=new DatabaseSync(join(DATA_DIR,"offline-other.db"));
  const { initializeMessageTables }=await import("./message-tables.ts");
  initializeMessageTables(db);
  vi.useFakeTimers();
  try {
    const timers=vi.getTimerCount();
    prepareThreadSummaryBackfill(db); const gen=readChatsGen(db);
    expect(withChatsPreviewTransaction(db, supplied=>supplied)).toBe(db);
    syncThreadSummary(db,"absent"); readThreadSummary(db,"absent"); threadSummaryPending(db);
    stepThreadSummaryBackfill(db); resetThreadSummaries(db); rebuildThreadSummaries(db);
    expect(readChatsGen(db)).toEqual({...gen,rev:1});
    bumpChatsGen(db); remintChatsGen(db);
    publishChatsGenIfMoved(db); publishChatsGenImmediately(db,readChatsGen(db)); publishChatsGenHeartbeat(db);
    downgradeChatsPreviewTables(db); downgradeChatsPreviewTables(db);
    expect(other.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
    expect(acquire).not.toHaveBeenCalled(); expect(tx).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(timers);
    db.close(); await vi.runOnlyPendingTimersAsync();
  } finally { if(db.isOpen)db.close();other.close();acquire.mockRestore();tx.mockRestore();vi.useRealTimers(); }
});
it("T-HANDLE-ONLY rejects thenables and rolls back only its acquired scope", () => {
  const db=new DatabaseSync(join(DATA_DIR,"thenable.db")); db.exec("CREATE TABLE sentinel(value)");
  try {
    expect(()=>withChatsPreviewTransaction(db,handle=>{handle.exec("INSERT INTO sentinel VALUES(1)");return {then(){}};})).toThrow("synchronous");
    expect(db.isTransaction).toBe(false);expect(db.prepare("SELECT * FROM sentinel").all()).toEqual([]);
    db.exec("BEGIN; INSERT INTO sentinel VALUES(2)");
    expect(()=>withChatsPreviewTransaction(db,handle=>{handle.exec("INSERT INTO sentinel VALUES(3)");return Promise.resolve();})).toThrow("synchronous");
    expect(db.isTransaction).toBe(true);db.exec("COMMIT");expect(db.prepare("SELECT * FROM sentinel").all()).toEqual([{value:2}]);
    const raw=db.exec.bind(db), calls:string[]=[];
    const spy=vi.spyOn(db,"exec").mockImplementation(sql=>{calls.push(sql);if(sql==="BEGIN IMMEDIATE")throw Error("begin fault");raw(sql);});
    expect(()=>withChatsPreviewTransaction(db,()=>0)).toThrow("begin fault");expect(calls).toEqual(["BEGIN IMMEDIATE"]);spy.mockRestore();
  } finally {db.close();}
});
it("T-HANDLE-ONLY bump finalization failure restores its supplied row",()=>{
  const db=new DatabaseSync(join(DATA_DIR,"bump-failure.db"));remintChatsGen(db);const gen=readChatsGen(db),raw=db.exec.bind(db);
  const spy=vi.spyOn(db,"exec").mockImplementation(sql=>{if(sql==="COMMIT")throw Error("bump commit");raw(sql);});
  try {expect(()=>bumpChatsGen(db)).toThrow("bump commit");expect(readChatsGen(db)).toEqual(gen);expect(db.isTransaction).toBe(false);}
  finally {spy.mockRestore();db.close();}
});

it.each([0, 1])("re-upgrade refills real messages after a retained done=%s marker", done => {
  appendMessage("early", msg("m1", "early preview"));
  appendMessage("late", msg("m2", "late preview"));
  let db = database();
  db.prepare("INSERT OR REPLACE INTO transcript_index_state(name,done,cursor,skipped) VALUES('thread_summary',?,?,0)").run(done, done ? 2 : 1);
  downgradeChatsPreviewTables(db);
  closeMessageDb();
  db = database();
  prepareThreadSummaryBackfill(db);
  while (stepThreadSummaryBackfill(db).more) { /* drain fixture */ }
  expect(readThreadSummary(db, "early")?.snippet).toBe("early preview");
  expect(readThreadSummary(db, "late")?.snippet).toBe("late preview");
  expect(threadSummaryPending(db)).toBe(false);
});

it("C2 rig 6: a missing or damaged active ancestor cannot abort an unrelated insert", () => {
  for (const damaged of [undefined, "null", "42", '"words"', "[1]", "{broken"]) {
    const thread = `broken-${String(damaged)}`;
    appendMessage(thread, msg("m1", "old preview"));
    if (damaged === undefined) database().prepare("DELETE FROM messages WHERE thread_id=? AND id='m1'").run(thread);
    else database().prepare("UPDATE messages SET json=? WHERE thread_id=? AND id='m1'").run(damaged, thread);
    expect(() => insertMessage(thread, msg("m2", "inactive", "missing"))).not.toThrow();
    expect(summary(thread)?.snippet).toBe("");
    expect(database().prepare("SELECT id FROM messages WHERE thread_id=? AND id='m2'").get(thread)?.id).toBe("m2");
  }
});

it("C2 rig 9: a nontext payload patch does no preview work, but kind and parent changes refresh it", () => {
  appendMessage("t", msg("m1", "first"));
  insertMessage("t", msg("m2", "other"));
  const chip = msg("m3", "", "m1", { kind: "activity", tool: { name: "Read" } });
  appendMessage("t", chip);
  expect(summary()?.snippet).toBe("first");
  const spy = vi.spyOn(database(), "prepare");
  try {
    updateMessage("t", { ...chip, text: "card payload changed" });
    expect(spy.mock.calls.filter(([sql]) => /thread_summary/.test(sql))).toEqual([]);
  } finally { spy.mockRestore(); }
  updateMessage("t", { ...chip, parentId: "m2" });
  expect(summary()?.snippet).toBe("other");
  updateMessage("t", msg("m3", "now text", "m2"));
  expect(summary()?.snippet).toBe("now text");
  updateMessage("t", { ...chip, parentId: "m2" });
  expect(summary()?.snippet).toBe("other");
});

it("C2 rig 9: an append refreshes its preview once, after moving the active leaf", () => {
  appendMessage("t", msg("m1", "old leaf"));
  const spy = vi.spyOn(database(), "prepare");
  try {
    appendMessage("t", msg("m2", "new leaf", "m1"));
    expect(spy.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO thread_summary"))).toHaveLength(1);
  } finally { spy.mockRestore(); }
  expect(summary()?.snippet).toBe("new leaf");
});
