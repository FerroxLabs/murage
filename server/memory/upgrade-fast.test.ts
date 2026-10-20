// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The fast upgrade (docs: lanes/int102-gate/UPGRADE-DESIGN.md). A 1.0.1 history (memory v6) opens after the structure check and the migration
// alone; the proofs that read rows run in the background pass and hold what depends on them until they pass.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, it } from "vitest";
import { DATA_DIR } from "../config.ts";
import { ancestryUnrepaired, backgroundUpgradeRunning, closeDatabase, database, finishBackgroundUpgradeWorkNow, memoryIntegrityStatus, pendingBackgroundUpgradeWork, startBackgroundUpgrade } from "../database.ts";
import { MEMORY_SCHEMA_VERSION, outputIndexDiffers, validateMemorySchema, migrateMemorySchema, downgradeMemorySchema } from "./schema.ts";
import { readIntegrityPass } from "./integrity-state.ts";
import { stepIntegrityPass } from "./integrity-pass.ts";
import { ancestryWithheld } from "./replay-lineage.ts";
import { memoryState } from "./repository.ts";
import { buildSyntheticV6 } from "./testing/upgrade-fast-fixture.ts";
import { appendMessage } from "../message-db.ts";
import { indexBrowserCheckChunk } from "../message-tables.ts";
import { indexOpenCardsChunk } from "../transcript-backfill.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { settleTestHandles } from "../test-handle-registry.ts";

const FILE = () => join(DATA_DIR, "messages.db");
const SHAPE = { threads: 30, perThread: 40, payloadBytes: 200, receiptsPerThread: 3, setThreads: 3, repliesPerSetThread: 10 };
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
/** A v6 file in the data directory, with `edit` applied to it on a plain connection (the way a 1.0.1 history could have been left). */
function v6(edit: (db: DatabaseSync) => void = () => {}) {
  const built = buildSyntheticV6(FILE(), SHAPE);
  const raw = new DatabaseSync(FILE());
  try { raw.exec("PRAGMA foreign_keys=OFF"); edit(raw); } finally { raw.close(); }
  return built;
}
// closed after each read: a connection left to the GC still holds its file handles, and Windows reports the next writer "database is locked"
const mark = () => {
  const raw = new DatabaseSync(FILE());
  try { return JSON.parse(String(raw.prepare("SELECT intent FROM memory_scope_bindings WHERE id='memory-shape-check'").get()?.intent ?? "null")); }
  finally { raw.close(); }
};
/** Everything that must come out the same whichever way the background work was run. */
function signature(db: DatabaseSync) {
  const rows = (sql: string) => JSON.stringify(db.prepare(sql).all());
  return {
    outputRoots: rows("SELECT thread_id,message_id,set_id FROM memory_output_roots ORDER BY thread_id,message_id"),
    sets: rows("SELECT set_id,size FROM memory_root_sets ORDER BY set_id"),
    memberRows: rows("SELECT count(*) AS n FROM memory_root_set_members"), parents: rows("SELECT set_id,parent_id FROM memory_root_set_parents ORDER BY set_id"),
    openCards: rows("SELECT thread_id,id FROM open_card ORDER BY thread_id,id"), browserChecks: rows("SELECT thread_id,id FROM browser_check_pending ORDER BY thread_id,id"),
    outputIndex: rows("SELECT bundle_id,thread_id,message_id FROM memory_disclosure_outputs ORDER BY bundle_id,message_id"),
    pass: JSON.stringify(readIntegrityPass(db) && { phase: readIntegrityPass(db)!.phase, result: readIntegrityPass(db)!.result }),
  };
}
const killOnce = (after: number) => { let n = 0; return () => { if (++n >= after) throw Object.assign(new Error("killed"), { killed: true }); }; };

it("a v6 file opens on the structure check and the migration alone: no proof reads rows, the pass is recorded, replay is withheld", () => {
  v6();
  const db = database();
  expect(db.prepare("SELECT schema_version FROM memory_meta").get()!.schema_version).toBe(MEMORY_SCHEMA_VERSION);
  const row = readIntegrityPass(db)!;
  expect(row.finishedAt).toBeNull();
  expect(memoryIntegrityStatus()).toMatchObject({ replayHeld: true, hold: null });
  expect(ancestryUnrepaired(db)).toBe(true);
  expect(ancestryWithheld(db, "t0")).toBe(true);
  // the derived work is all still ahead
  // v10: the root-set repair ("lineage") and the root-set conversion ("storage") are retired; the write-time certificate ("writetime") replaces them
  expect(pendingBackgroundUpgradeWork()).toEqual(expect.arrayContaining(["integrity", "writetime", "message-index"]));
  expect(pendingBackgroundUpgradeWork()).not.toContain("lineage");
  expect(pendingBackgroundUpgradeWork()).not.toContain("storage");
});

it("an orphaned reference does not stop a v6 upgrade: it is found in the background and sets the hold, nothing is deleted, chats still work", () => {
  v6(raw => raw.exec("INSERT INTO memory_scope_bindings VALUES('orphan','no-such-scope','system','x',0,'granted','{}')"));
  const db = database(); // before this lane the whole-file reference sweep threw INVALID_MEMORY_REFERENCE here
  const ours = () => Number(db.prepare("SELECT count(*) AS n FROM memory_scope_bindings WHERE id NOT LIKE 'memory-%'").get()!.n);
  const rowsBefore = ours();
  expect(memoryState().mode).toBe("active"); // not yet known
  finishBackgroundUpgradeWorkNow();
  expect(readIntegrityPass(db)!.result).toBe("held:INVALID_MEMORY_REFERENCE");
  expect(memoryIntegrityStatus()).toMatchObject({ hold: "INVALID_MEMORY_REFERENCE", replayHeld: true });
  expect(memoryIntegrityStatus().holdMessage).toMatch(/installation-recovery/);
  expect(memoryState().mode).toBe("paused");
  expect(ancestryWithheld(db, "t0")).toBe(true);
  expect(ours()).toBe(rowsBefore);
  // the hold survives a restart without the pass running again
  closeDatabase();
  const again = database();
  expect(memoryState().mode).toBe("paused");
  expect(readIntegrityPass(again)!.result).toBe("held:INVALID_MEMORY_REFERENCE");
  // a chat message is still written
  expect(() => appendMessage("t1", { id: "chat-after", at: Date.now(), role: "user", kind: "text", text: "still here", parentId: null } as never)).not.toThrow();
  expect(again.prepare("SELECT 1 FROM messages WHERE thread_id='t1' AND id='chat-after'").get()).toBeTruthy();
});

it("a ledger event that points at no scope sets the hold", () => {
  v6(raw => raw.exec("INSERT INTO memory_learning_events(id,scope_id,kind,detail,created_at) VALUES('ev','no-such-scope','settings-migrated','{}',1)"));
  const db = database();
  finishBackgroundUpgradeWorkNow();
  expect(readIntegrityPass(db)!.result).toBe("held:INVALID_MEMORY_LEARNING_EVENT");
  expect(memoryState().mode).toBe("paused");
});

it("an output-index row that is missing is rewritten from the receipts' JSON, replay stays withheld until the pass ends, and the re-check passes", () => {
  v6(raw => raw.exec("DELETE FROM memory_disclosure_outputs WHERE rowid IN (SELECT rowid FROM memory_disclosure_outputs LIMIT 5)"));
  const db = database();
  expect(outputIndexDiffers(db, { lo: null, hi: null })).toBe(true);
  // run the pass a slice at a time: replay is withheld at every point before the end
  let guard = 0;
  for (;;) {
    expect(ancestryWithheld(db, "t0")).toBe(true);
    const step = stepIntegrityPass(db, { budgetMs: 0, receiptSlice: 7, referenceSlice: 50 });
    if (!step.more) break;
    expect(++guard).toBeLessThan(10_000);
  }
  expect(readIntegrityPass(db)).toMatchObject({ result: "passed" });
  expect(readIntegrityPass(db)!.repaired).toBeGreaterThanOrEqual(5);
  expect(outputIndexDiffers(db, { lo: null, hi: null })).toBe(false);
});

it("the pass is resumable: killed after any number of slices, the final state equals an uninterrupted run", async () => {
  v6(); // the uninterrupted run
  let db = database();
  finishBackgroundUpgradeWorkNow();
  const whole = signature(db);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  for (const kill of [1, 3, 9]) {
    closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
    v6();
    db = database();
    // slices of one receipt-run, one-row reference runs and a zero-length repair slice, so every job has many slices to be killed between
    const handle = startBackgroundUpgrade({ afterSlice: killOnce(kill), integrity: { receiptSlice: 5, referenceSlice: 40, learningSlice: 5 }, sliceMs: 0, pauseMs: 1, busy: () => false });
    await handle.done;
    closeDatabase();
    db = database(); // a new process would find the committed places
    finishBackgroundUpgradeWorkNow();
    expect(signature(db), `killed after ${kill} slices`).toEqual(whole);
    expect(pendingBackgroundUpgradeWork()).toEqual([]);
    expect(ancestryUnrepaired(db)).toBe(false);
  }
});

it("a kill in the middle of each derived fill resumes from its place: open cards and the pending browser-check table", () => {
  v6();
  const db = database();
  // enough rows that the fills take several chunks
  indexOpenCardsChunk(db, 100); indexBrowserCheckChunk(db, 100);
  closeDatabase();
  const again = database();
  finishBackgroundUpgradeWorkNow();
  const resumed = signature(again);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  v6();
  const fresh = database();
  finishBackgroundUpgradeWorkNow();
  expect(signature(fresh)).toEqual(resumed);
});

it("the second launch after the upgrade reads no row of a shaped column again: the marks were carried to the new version", async () => {
  v6();
  const before = mark();
  expect(before.schema).toBe(6);
  database();
  const carried = mark();
  expect(carried.schema).toBe(MEMORY_SCHEMA_VERSION);
  expect(carried.shapes).toBe(before.shapes);
  // (the marker names itself in the one table it lives in, so that entry may have moved up by its own row)
  expect({ ...carried.marks, "memory_scope_bindings.intent": 0 }).toEqual({ ...before.marks, "memory_scope_bindings.intent": 0 });
  finishBackgroundUpgradeWorkNow();
  // closeDatabase, then the WAL checkpointer's own connection leaves the file (wal-maintenance.ts): a raw writer waits for both
  await settleTestHandles(DATA_DIR);
  // A row below the mark that is no longer the right shape is invisible to an incremental read; a full read would stop on it.
  const raw = new DatabaseSync(FILE());
  raw.exec("PRAGMA foreign_keys=OFF; UPDATE memory_disclosures SET record_versions='{}' WHERE rowid=1");
  raw.close();
  expect(() => database()).not.toThrow(); // incremental: not read
  await settleTestHandles(DATA_DIR);
  const stripped = new DatabaseSync(FILE());
  stripped.exec("DELETE FROM memory_scope_bindings WHERE id='memory-shape-check'");
  stripped.close();
  expect(() => database()).toThrow(/INVALID_MEMORY_JSON_SHAPE|MEMORY_SCHEMA_UNSUPPORTED/); // no mark: read in full
});

it("an upgrade from before v6 still proves every row before it commits (the steps transform data there)", () => {
  // a v5 file with an orphaned reference is refused outright, as before this lane
  const raw = new DatabaseSync(FILE());
  raw.exec("PRAGMA journal_mode=WAL");
  migrateMemorySchema(raw, "active");
  downgradeMemorySchema(raw, 5);
  const installation = raw.prepare("SELECT installation_id FROM memory_meta").get()!.installation_id;
  raw.prepare("INSERT INTO memory_scopes VALUES('s','workspace',?,'[]',0)").run(installation);
  raw.exec("PRAGMA foreign_keys=OFF; INSERT INTO memory_scope_bindings VALUES('orphan','no-such-scope','system','x',0,'granted','{}')");
  raw.close();
  expect(() => database()).toThrow(/INVALID_MEMORY_REFERENCE/);
});

it("a full validation (the one restore, merge and downgrade call) still reads every row and finds the same defect", () => {
  v6(raw => raw.exec("INSERT INTO memory_scope_bindings VALUES('orphan','no-such-scope','system','x',0,'granted','{}')"));
  const raw = new DatabaseSync(FILE());
  try { expect(() => validateMemorySchema(raw)).toThrow(/INVALID_MEMORY_REFERENCE/); } finally { raw.close(); }
});

it("the background run waits for the writer gate and writes nothing while a hold is in force", async () => {
  v6();
  const db = database();
  let held = true;
  const release = new Promise<void>(resolve => setTimeout(() => { held = false; resolve(); }, 120));
  const before = JSON.stringify(readIntegrityPass(db));
  let during: string | null = null;
  setTimeout(() => { during = JSON.stringify(readIntegrityPass(db)); }, 60);
  const handle = startBackgroundUpgrade({ admit: async () => { if (held) await release; }, pauseMs: 1 });
  await handle.done;
  expect(during).toBe(before);
  expect(pendingBackgroundUpgradeWork()).toEqual([]);
  expect(readIntegrityPass(db)!.result).toBe("passed");
});

it("the status carries what the upgrade screen reads: phases, counts, a monotone overall fraction, keepOpen", async () => {
  v6();
  const db = database();
  const seen: number[] = [];
  const handle = startBackgroundUpgrade({ pauseMs: 1, onProgress: progress => seen.push(progress.fraction), sliceMs: 5 });
  await handle.done;
  const status = memoryIntegrityStatus();
  expect(status.pending).toBe(false);
  expect(status.progress).toMatchObject({ stage: "background", fraction: 1 });
  expect(status.progress!.phases.map(p => p.id)).toEqual(expect.arrayContaining(["output-index", "references", "learning", "writetime", "message-index"])); // v10: "lineage" and "storage" are retired (see the pending-work test)
  expect(status.progress!.phases.map(p => p.id)).not.toContain("lineage");
  expect(status.progress!.counts).toMatchObject({ exact: true, conversations: SHAPE.threads });
  expect(status.progress!.counts.messages).toBeGreaterThanOrEqual(SHAPE.threads * SHAPE.perThread);
  expect(seen.every((value, i) => i === 0 || value >= seen[i - 1]!)).toBe(true);
  expect(db.prepare("SELECT 1 FROM memory_meta").get()).toBeTruthy();
});

it("writes made while the pass runs cannot hide a defect: the connection refuses an orphan, and a receipt written mid-pass is covered by the triggers", () => {
  v6();
  const db = database();
  expect(() => db.prepare("INSERT INTO memory_scope_bindings VALUES('late-orphan','no-such-scope','system','x',0,'granted','{}')").run()).toThrow(/FOREIGN KEY/i);
  // half the pass, then a new receipt with outputs (behind the cursor, in a slice already proven), then the rest
  stepIntegrityPass(db, { budgetMs: 0, receiptSlice: 5, referenceSlice: 20 });
  db.prepare(`INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at)
    VALUES('a-new-receipt','t1','claude',NULL,'[]','[]','["m1-1","m1-3"]',0,0,0,'delivered',9)`).run();
  expect(db.prepare("SELECT count(*) AS n FROM memory_disclosure_outputs WHERE bundle_id='a-new-receipt'").get()!.n).toBe(2);
  for (let guard = 0; stepIntegrityPass(db, { budgetMs: 0, receiptSlice: 5, referenceSlice: 20 }).more; guard++) expect(guard).toBeLessThan(10_000);
  expect(readIntegrityPass(db)).toMatchObject({ result: "passed" });
  expect(outputIndexDiffers(db, { lo: null, hi: null })).toBe(false);
});

it("rc13: backgroundUpgradeRunning holds from the start of the history work until it is done, and never on an ordinary start (the idle memory lanes yield to it)", async () => {
  v6();
  database();
  expect(backgroundUpgradeRunning()).toBe(false);
  const handle = startBackgroundUpgrade({ pauseMs: 1 });
  expect(handle.jobs.length).toBeGreaterThan(0);
  expect(backgroundUpgradeRunning()).toBe(true);
  await handle.done;
  await Promise.resolve();
  expect(backgroundUpgradeRunning()).toBe(false);
  startBackgroundUpgrade();
  expect(backgroundUpgradeRunning()).toBe(false);
});
