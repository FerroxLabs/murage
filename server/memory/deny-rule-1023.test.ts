// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// 1.0.23 q1023-denyrule, Builder A witnesses (BUILD-PLAN R1, R2, H1, H4). Owner of the deny storage and the per-hit predicate: q1023-denyrule.
// Up to 1.0.22 a revoke wrote one mark per object it reached (one conversation deletion on the 11-26 store: 119,483 memory marks and 47,905
// line marks). From 1.0.23 the marker writes a mark only where the object's place does not already say it, and every reader derives the rest
// at read time (deny-rule.ts), under the same revoke ids.
//
// Entry points: the exported production functions the server's routes call (the container runs no booted server here): deleteThread
// (message-db.ts, the conversation deletion), commitRevoke / undoRevoke / inheritEdges / hideTurnRecord (revoke-commit.ts), the runner's own
// drain runRevocationJobsNow (memory-revocation.ts: markerSlice to completion with every bookkeeping job), and the readers memoryLookup,
// memoryLookupEachSource, denyLookup (deny-read.ts) and plausiblyReadable (readable.ts).
//
// W-A1 is RED on the base (0e6228fcf8) at its row-count assertion: the base writes at least one mark per dependent object. The table names
// are read from sqlite_schema, so the identical file runs on the base. W-A2 and W-A3 are green on the base's own storage too (W-A2 by
// design: the base has an explicit row for every object; W-A3 keeps a 1.0.22 guarantee); they are proved by mutants, not by a base RED.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database, transaction } from "../database.ts";
import * as messages from "../message-db.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { denyLookup, memoryLookup, memoryLookupEachSource } from "./deny-read.ts";
import { memoryRefKey, type MemoryRef } from "./lineage-types.ts";
import { INLINE_REVOCATION, runRevocationJobsNow, stopMemoryRevocation } from "./memory-revocation.ts";
import { ensureScope, reconcileMemoryRoster } from "./policy.ts";
import { plausiblyReadable } from "./readable.ts";
import { noteReceiptOutput } from "./receipt-outputs.ts";
import { setMemoryMode } from "./repository.ts";
import { commitRevoke, hideTurnRecord, inheritEdges, undoRevoke } from "./revoke-commit.ts";
import { markerSlice } from "./revoke-marker.ts";
import { testThreadNo } from "./testing/writetime-fixture.ts";

const inline = { ...INLINE_REVOCATION };
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {}); vi.spyOn(console, "log").mockImplementation(() => {});
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => { stopMemoryRevocation(); Object.assign(INLINE_REVOCATION, inline); vi.restoreAllMocks(); });

/** No marker step inside the commit, no runner: every job stays as committed until the test drains it. */
const stopJobs = () => { INLINE_REVOCATION.rows = 1; INLINE_REVOCATION.ms = 0; stopMemoryRevocation(); };
/** The runner's drain: every marker phase and every bookkeeping job to its end. */
const drain = () => { transaction(db => runRevocationJobsNow(db)); };
const count = (sql: string, ...args: Array<string | number>) => Number(database().prepare(sql).get(...args)!.n);
/** The explicit mark tables under the name this build gives them (1.0.22: memory_deny_memory, memory_deny_line). */
function markTables(): { object: string; point: string } {
  const has = (name: string) => Boolean(database().prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(name));
  return { object: has("memory_deny_object") ? "memory_deny_object" : "memory_deny_memory", point: has("memory_deny_point") ? "memory_deny_point" : "memory_deny_line" };
}
/** Explicit object and line rows written under one revoke. */
function rowsOf(revoke: number): number {
  const t = markTables();
  return count(`SELECT count(*) AS n FROM ${t.object} WHERE revoke_id=?`, revoke) + count(`SELECT count(*) AS n FROM ${t.point} WHERE revoke_id=?`, revoke);
}
const objectRows = (kind: string, id: string) => count(`SELECT count(*) AS n FROM ${markTables().object} WHERE kind=? AND id=?`, kind, id);

// ---- the fixture: conversation T (an earlier captured reply, then the owner line "root", then N captured replies, each with one record
// resting on it) and conversation K in another scope, which nothing touches.
interface Fixture { scope: string; n: number; sources: string[]; records: string[]; pre: { source: string; record: string }; kept: { source: string; record: string } }
const sourceOf = (thread: string, message: string) => `message:${thread}:${message}`;
function build(n: number): Fixture {
  reconcileMemoryRoster({ bots: [{ id: "bot", threadId: "private", section: "team-a" }], groups: [] });
  setMemoryMode("active");
  const scope = ensureScope("bot", "bot");
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO memory_scopes VALUES('k-scope','room','k','[]',0)").run();
  let lsn = Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()!.next);
  const message = db.prepare("INSERT OR REPLACE INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,1,?,'text','',?)");
  const lineage = db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)");
  const source = db.prepare("INSERT INTO memory_sources VALUES(?,?,?,?,NULL,1,?,'text','bot','recorded',NULL,'active')");
  const version = db.prepare("INSERT INTO memory_source_versions VALUES(?,1,?,?,1)");
  const capture = db.prepare("INSERT INTO memory_line_capture VALUES(?,?,?)");
  const record = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'fact','a remembered detail','assistant-inference','active',0,1,NULL,NULL,1)");
  const evidence = db.prepare("INSERT INTO memory_evidence VALUES(?,1,?,1,0,5)");
  let turn = 0;
  const owner = (thread: string, id: string) => { message.run(thread, id, "user", JSON.stringify({ id, role: "user" })); lineage.run(testThreadNo(db, thread), lsn, id, null); turn = lsn++; };
  /** A reply of the turn the last owner line began, captured as a source, with one record resting on it. */
  const reply = (thread: string, id: string, recordId: string, scopeId: string) => {
    message.run(thread, id, "bot", JSON.stringify({ id, role: "bot" }));
    lineage.run(testThreadNo(db, thread), lsn, id, turn);
    const sourceId = sourceOf(thread, id);
    source.run(sourceId, scopeId, thread, id, `h-${sourceId}`); version.run(sourceId, `h-${sourceId}`, JSON.stringify({ text: "words" }));
    capture.run(testThreadNo(db, thread), lsn, sourceId);
    record.run(recordId, scopeId); evidence.run(recordId, sourceId);
    lsn++;
    return { source: sourceId, record: recordId };
  };
  owner("T", "o-pre");
  const pre = reply("T", "pre", "rec-pre", scope);
  owner("T", "root");
  const sources: string[] = [], records: string[] = [];
  for (let i = 0; i < n; i++) { const made = reply("T", `g${i}`, `rec-${i}`, scope); sources.push(made.source); records.push(made.record); }
  owner("K", "k-o");
  const kept = reply("K", "k-g", "rec-kept", "k-scope");
  db.prepare("UPDATE memory_lsn SET next=? WHERE id=1").run(lsn);
  db.exec("COMMIT");
  return { scope, n, sources, records, pre, kept };
}
const CONTENT = { audience: null };
/** The ids whose content verdict is not `state`, read through the production lookup (versioned refs: the batched path). */
function notIn(state: "shown" | "withheld", kind: "source" | "record", ids: readonly string[]): string[] {
  const refs: MemoryRef[] = ids.map(id => ({ kind, id, version: 1 }));
  const verdicts = memoryLookup(database(), refs, CONTENT);
  return refs.filter(ref => verdicts.get(memoryRefKey(ref))?.state !== state).map(ref => ref.id);
}
const allDone = () => {
  expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE state NOT IN ('done','undone')")).toBe(0);
  expect(count("SELECT count(*) AS n FROM memory_deny_pending") + count("SELECT count(*) AS n FROM memory_deny_pending_scope")).toBe(0);
};
const lastRevoke = () => Number(database().prepare("SELECT max(revoke_id) AS r FROM memory_revoke_jobs").get()!.r);

/** The most explicit object and line rows one revoke may write, whatever rests on it: its root's own rows and one row per line it enters a
 * conversation at. Every trigger below writes at most 3. The base writes at least one per dependent object. */
const ROW_BOUND = 4;

interface Trigger {
  name: string;
  /** Commits the owner action; returns its revoke id. */
  act(f: Fixture): number;
  /** What rests on it: withheld for a content reader once the marker has finished. Everything else of the fixture stays shown. */
  withheld(f: Fixture): { sources: string[]; records: string[] };
  /** Whether an undo is allowed (restores exactly the withheld set) or refused. */
  undo: "restores" | "refused" | "rows-only";
  /** Whether the revoke's row count is independent of N (position decides). A scope deny reaches its records by scope, with no place to
   * read the verdict from: one explicit row per record, as before (BUILD-PLAN R2). */
  bounded: boolean;
}
const TRIGGERS: Trigger[] = [
  { name: "conversation deleted", undo: "refused", bounded: true,
    act: () => { messages.deleteThread("T"); return lastRevoke(); },
    withheld: f => ({ sources: [f.pre.source, ...f.sources], records: [f.pre.record, ...f.records] }) },
  { name: "line forgotten", undo: "restores", bounded: true,
    act: () => transaction(tx => commitRevoke(tx, { kind: "line", threadId: "T", messageIds: ["root"], cause: "forget" })),
    withheld: f => ({ sources: f.sources, records: f.records }) },
  { name: "source forgotten", undo: "restores", bounded: true,
    act: f => transaction(tx => commitRevoke(tx, { kind: "memory", ref: { kind: "source", id: f.sources[0]! }, cause: "forget" })),
    withheld: f => ({ sources: f.sources, records: f.records }) },
  { name: "record forgotten", undo: "restores", bounded: true,
    act: f => transaction(tx => commitRevoke(tx, { kind: "memory", ref: { kind: "record", id: f.records[0]!, version: 1, scopeId: f.scope }, cause: "forget" })),
    withheld: f => ({ sources: f.sources, records: f.records }) },
  // (undo: the revoke's rows go, the scope's own deny fact stays, memory_deny kind 'scope', so its objects stay withheld: 1.0.22 does the same)
  { name: "scope denied", undo: "rows-only", bounded: false,
    act: f => transaction(tx => commitRevoke(tx, { kind: "scope", scopeId: f.scope, cause: "scope-deny" })),
    // (a denied scope withholds its sources by the scope fact itself, DENIED_SOURCE, on 1.0.22 as here; the marker's rows are the records')
    withheld: f => ({ sources: [f.pre.source, ...f.sources], records: [f.pre.record, ...f.records] }) },
];

describe("W-A1 same verdicts, bounded rows: what rests on a revoke is withheld after the marker finishes, with a row count that does not grow with what rests on it", () => {
  for (const trigger of TRIGGERS) for (const n of [10, 1000]) {
    it(`${trigger.name}, ${n} dependent objects`, { timeout: 240_000 }, () => {
      const f = build(n);
      const everySource = [f.pre.source, ...f.sources, f.kept.source], everyRecord = [f.pre.record, ...f.records, f.kept.record];
      expect(notIn("shown", "source", everySource)).toEqual([]);
      expect(notIn("shown", "record", everyRecord)).toEqual([]);
      stopJobs();
      const revoke = trigger.act(f);
      expect(revoke).toBeGreaterThan(0);
      drain();
      allDone();
      const gone = trigger.withheld(f);
      // every source and record that rests on the revoke is withheld for a content reader; the untouched ones are shown
      expect(notIn("withheld", "source", gone.sources)).toEqual([]);
      expect(notIn("withheld", "record", gone.records)).toEqual([]);
      expect(notIn("shown", "source", everySource.filter(id => !gone.sources.includes(id)))).toEqual([]);
      expect(notIn("shown", "record", everyRecord.filter(id => !gone.records.includes(id)))).toEqual([]);
      // the rows the revoke wrote: a small constant (the base: at least one per dependent object)
      const rows = rowsOf(revoke);
      console.info(`Q23A W-A1 ${trigger.name} n=${n} rows=${rows}`);
      if (trigger.bounded) expect(rows).toBeLessThanOrEqual(ROW_BOUND);
      if (trigger.name === "line forgotten") {
        // late children (written after the walk finished): a record extracted from a source that is withheld only through the rule (no row
        // of its own) inherits the revoke at its write, and so does the record derived from it at its own write (each writer calls
        // inheritEdges for the version it writes: a just-written child has no consumers, revoke-commit.ts inheritMarks)
        transaction(tx => {
          tx.prepare("INSERT INTO memory_records VALUES('late-1',1,?,'fact','late','assistant-inference','active',0,1,NULL,NULL,1)").run(f.scope);
          tx.prepare("INSERT INTO memory_records VALUES('late-2',1,?,'fact','later','assistant-inference','active',0,1,NULL,NULL,1)").run(f.scope);
          tx.prepare("INSERT INTO memory_evidence VALUES('late-1',1,?,1,0,5)").run(f.sources[3]!);
          tx.prepare("INSERT INTO memory_derivations VALUES('late-1',1,'late-2',1)").run();
          inheritEdges(tx, { id: "late-1", version: 1 });
          inheritEdges(tx, { id: "late-2", version: 1 });
        });
        drain();
        allDone();
        expect(notIn("withheld", "record", ["late-1", "late-2"])).toEqual([]);
        gone.records = [...gone.records, "late-1", "late-2"];
      }
      if (trigger.undo === "refused") {
        expect(() => transaction(tx => undoRevoke(tx, revoke))).toThrow("MEMORY_REVOKE_UNDO_BULK");
        expect(notIn("withheld", "record", gone.records)).toEqual([]);
        return;
      }
      // undo restores exactly what the revoke withheld, and leaves no row of it
      transaction(tx => undoRevoke(tx, revoke));
      drain();
      if (trigger.undo === "rows-only") {
        expect(rowsOf(revoke)).toBe(0);
        expect(notIn("withheld", "source", gone.sources)).toEqual([]);
        expect(notIn("withheld", "record", gone.records)).toEqual([]);
        expect(notIn("shown", "source", [f.kept.source])).toEqual([]);
        expect(notIn("shown", "record", [f.kept.record])).toEqual([]);
        return;
      }
      expect(notIn("shown", "source", everySource)).toEqual([]);
      expect(notIn("shown", "record", [...everyRecord, ...gone.records])).toEqual([]);
      expect(rowsOf(revoke)).toBe(0);
    });
  }

  for (const n of [10, 1000]) it(`receipt revoked (audience-only), ${n} dependent objects: audience readers lose its lines, memory stays shown to a content reader`, { timeout: 240_000 }, () => {
    const f = build(n);
    const db = database();
    const lsn = Number(db.prepare("SELECT lsn FROM memory_line_lineage WHERE thread_no=? AND message_id='g0'").get(testThreadNo(db, "T"))!.lsn);
    db.prepare("INSERT INTO memory_disclosures(bundle_id,thread_id,driver_instance,native_session,record_versions,source_versions,output_message_ids,policy_revision,deletion_epoch,token_count,state,created_at) VALUES('bundle-1','T','d','n','[]','[]','[\"g0\"]',0,0,0,'delivered',0)").run();
    noteReceiptOutput(db, "bundle-1", "T", lsn, { driverInstance: "d", nativeSession: "n" });
    stopJobs();
    const revoke = transaction(tx => commitRevoke(tx, { kind: "receipt", bundleId: "bundle-1", cause: "receipt-revoked" }));
    drain();
    allDone();
    // an audience reader loses the receipt's output and every generated line after it
    const audience = { audience: { owner: false, scopeIds: [f.scope] } };
    const lines = denyLookup(db, { threadId: "T", lines: ["g0", "g1", `g${n - 1}`].map(messageId => ({ messageId, author: "generated" as const })) }, audience);
    expect([...lines.values()].map(verdict => verdict.state)).toEqual(["withheld", "withheld", "withheld"]);
    // memory recall is a content reader: an audience-only revoke withholds no source and no record from it
    expect(notIn("shown", "source", [f.pre.source, ...f.sources, f.kept.source])).toEqual([]);
    expect(notIn("shown", "record", [f.pre.record, ...f.records, f.kept.record])).toEqual([]);
    const rows = rowsOf(revoke);
    console.info(`Q23A W-A1 receipt revoked n=${n} rows=${rows}`);
    expect(rows).toBeLessThanOrEqual(ROW_BOUND);
    expect(() => transaction(tx => undoRevoke(tx, revoke))).toThrow("MEMORY_REVOKE_UNDO_BULK");
  });
});

describe("W-H3 (MAIN-RULING OPUS DENYRULE H3) a child written while its parent's revoke is still closing", () => {
  // Entry points: commitRevoke (the owner's forget), the writers' inheritEdges at the child's own write, the marker through
  // runRevocationJobsNow, the reader memoryLookup. The parent source has NO row of its own (the rule withholds it through its anchor line),
  // so the child reaches the revoke only if the write-time inheritance reads the rule's revoke ids (revoke-commit.ts refRevokes).
  it("a record extracted mid-closure, and the record derived from it, are never shown: not while the revoke is in flight, not after it ends; undo restores both", { timeout: 240_000 }, () => {
    const f = build(10);
    stopJobs();
    const revoke = transaction(tx => commitRevoke(tx, { kind: "line", threadId: "T", messageIds: ["root"], cause: "forget" }));
    // the revoke is committed and its walk has not finished: the closing window
    expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=? AND state='active'", revoke)).toBe(1);
    expect(count(`SELECT count(*) AS n FROM ${markTables().object} WHERE kind='source' AND id=?`, f.sources[3]!)).toBe(0);
    transaction(tx => {
      tx.prepare("INSERT INTO memory_records VALUES('mid-1',1,?,'fact','mid','assistant-inference','active',0,1,NULL,NULL,1)").run(f.scope);
      tx.prepare("INSERT INTO memory_records VALUES('mid-2',1,?,'fact','derived','assistant-inference','active',0,1,NULL,NULL,1)").run(f.scope);
      tx.prepare("INSERT INTO memory_evidence VALUES('mid-1',1,?,1,0,5)").run(f.sources[3]!);
      tx.prepare("INSERT INTO memory_derivations VALUES('mid-1',1,'mid-2',1)").run();
      inheritEdges(tx, { id: "mid-1", version: 1 });
      inheritEdges(tx, { id: "mid-2", version: 1 });
    });
    drain(); allDone(); // (then, the walk over: mid-3 is derived from a record that is withheld through the rule alone, with no row to inherit from)
    transaction(tx => { tx.prepare("INSERT INTO memory_records VALUES('mid-3',1,?,'fact','derived','assistant-inference','active',0,1,NULL,NULL,1)").run(f.scope); tx.prepare("INSERT INTO memory_derivations VALUES(?,1,'mid-3',1)").run(f.records[5]!); inheritEdges(tx, { id: "mid-3", version: 1 }); }); drain(); allDone();
    // mid-2 and mid-3 have no evidence source of their own: only the inherited walk withholds them (mid-3's parent record has no row either)
    expect(notIn("withheld", "record", ["mid-1", "mid-2", "mid-3"])).toEqual([]);
    expect(notIn("shown", "record", [f.pre.record, f.kept.record])).toEqual([]);
    transaction(tx => undoRevoke(tx, revoke));
    drain();
    expect(notIn("shown", "record", ["mid-1", "mid-2", "mid-3", ...f.records])).toEqual([]);
  });
});

describe("W-A2 every reader withholds an object that is denied only through the rule (no explicit row of its own)", () => {
  /** A forgotten line with 10 dependent objects, marker finished; rec-3 and its source have no explicit row. */
  function forgotten(): Fixture {
    const f = build(10);
    stopJobs();
    transaction(tx => commitRevoke(tx, { kind: "line", threadId: "T", messageIds: ["root"], cause: "forget" }));
    drain();
    allDone();
    expect(objectRows("record", "rec-3")).toBe(0);
    expect(objectRows("source", f.sources[3]!)).toBe(0);
    return f;
  }
  const state = (ref: MemoryRef, lookup = memoryLookup) => lookup(database(), [ref], CONTENT).get(memoryRefKey(ref))?.state;

  it("deny-read.ts memoryLookup, a versioned record (batchRecords)", () => {
    forgotten();
    expect(state({ kind: "record", id: "rec-3", version: 1 })).toBe("withheld");
    expect(state({ kind: "record", id: "rec-pre", version: 1 })).toBe("shown");
  });
  it("deny-read.ts memoryLookup, a record with no version (memoryVerdict's own seeks)", () => {
    forgotten();
    expect(state({ kind: "record", id: "rec-3" })).toBe("withheld");
    expect(state({ kind: "record", id: "rec-pre" })).toBe("shown");
  });
  it("deny-read.ts memoryLookup, a versioned source (SOURCE_BATCH)", () => {
    const f = forgotten();
    expect(state({ kind: "source", id: f.sources[3]!, version: 1 })).toBe("withheld");
    expect(state({ kind: "source", id: f.pre.source, version: 1 })).toBe("shown");
  });
  it("deny-read.ts memoryLookup and memoryLookupEachSource, a source read on its own (memoryVerdict's own seeks)", () => {
    const f = forgotten();
    expect(state({ kind: "source", id: f.sources[3]! })).toBe("withheld");
    expect(state({ kind: "source", id: f.sources[3]!, version: 1 }, memoryLookupEachSource)).toBe("withheld");
    expect(state({ kind: "source", id: f.pre.source })).toBe("shown");
    expect(state({ kind: "source", id: f.pre.source, version: 1 }, memoryLookupEachSource)).toBe("shown");
  });
  it("readable.ts plausiblyReadable (the owner's chat and recall's pre-filter)", () => {
    const f = forgotten();
    const refs = [{ id: "rec-3", version: 1 }, { id: "rec-pre", version: 1 }];
    expect([...plausiblyReadable(refs, [f.scope], "current", true)]).toEqual(["rec-pre:1"]);
    expect([...plausiblyReadable(refs, [f.scope], "current", false)]).toEqual(["rec-pre:1"]);
  });
  it("revoke-commit.ts hideTurnRecord: an object already withheld through the rule takes no second, permanent mark", () => {
    const f = forgotten();
    const before = lastRevoke();
    transaction(tx => { hideTurnRecord(tx, { kind: "record", id: "rec-3", version: 1 }); hideTurnRecord(tx, { kind: "source", id: f.sources[3]! }); });
    expect(lastRevoke()).toBe(before);
    expect(objectRows("record", "rec-3") + objectRows("source", f.sources[3]!)).toBe(0);
    // one that is not withheld takes its mark
    transaction(tx => hideTurnRecord(tx, { kind: "record", id: "rec-pre", version: 1 }));
    expect(lastRevoke()).toBe(before + 1);
    expect(state({ kind: "record", id: "rec-pre", version: 1 })).toBe("withheld");
  });
});

describe("W-A3 (H1) a deleted conversation's receipt survives: the start-up replay of the deletion writes nothing", () => {
  it("a second deleteThread of the same conversation (the boot reconcile's replay) commits no revoke, before and after the first one's job row is pruned", () => {
    setMemoryMode("capture");
    stopJobs();
    const text = (id: string, words: string) => ({ id, text: words, parentId: null, at: 1, role: "user" as const, kind: "text" as const });
    messages.appendMessage("gone", text("m1", "a detail of the deleted conversation"));
    messages.appendMessage("other", text("m2", "another conversation"));
    messages.deleteThread("gone");
    const revoke = lastRevoke();
    const receipts = () => count(`SELECT count(*) AS n FROM ${markTables().point} WHERE thread_id='gone' AND reason='delete-conversation'`);
    expect(receipts()).toBe(1);
    drain();
    const generation = () => Number(database().prepare("SELECT value FROM memory_lineage_lsn_meta WHERE key='deny_generation'").get()!.value);
    const replay = () => {
      const before = { generation: generation(), revoke: lastRevoke() };
      messages.deleteThread("gone");
      expect(lastRevoke()).toBe(before.revoke);
      expect(generation()).toBe(before.generation);
      expect(receipts()).toBe(1);
    };
    replay();
    // a later deletion prunes the first one's finished job row: the receipt is all that is left of it, and still stops the replay
    messages.deleteThread("other");
    drain();
    expect(count("SELECT count(*) AS n FROM memory_revoke_jobs WHERE revoke_id=?", revoke)).toBe(0);
    replay();
  });
});

describe("W-A4 (H3) a child written while the revoke is still walking is withheld once the walk ends, though its parent has no row of its own", () => {
  // MAIN-RULING OPUS DENYRULE H3. This build keeps the 1.0.22 walk (frontier, pending rows, inheritMarks at write), so a child written in the
  // closing window is found at its own write, under the writer's transaction. What is new: its parent may be withheld only through the rule
  // (no explicit row), so the write-time lookup must read the rule's rows too (revoke-commit.ts refRevokes). late-2 is derived from late-1,
  // whose only evidence is a source withheld through its anchor line: nothing at read time ties late-2 to the revoke except its inherited mark.
  // Green on the base by design (1.0.22 gives every reached object an explicit row); proved by the mutant that drops the rule arms.
  for (const n of [10, 1000]) it(`line forgotten, ${n} dependent objects, child written mid-walk`, { timeout: 240_000 }, () => {
    const f = build(n);
    stopJobs();
    const revoke = transaction(tx => commitRevoke(tx, { kind: "line", threadId: "T", messageIds: ["root"], cause: "forget" }));
    // step the marker one row at a time into the closing window: the walk has read past every node (its frontier is empty, so it will not
    // come back to the parents), the job is still active (past its mark phase, not yet done)
    const window = () => ({ ...database().prepare("SELECT phase,state FROM memory_revoke_jobs WHERE revoke_id=?").get(revoke) as { phase: string; state: string },
      frontier: count("SELECT count(*) AS n FROM memory_revoke_frontier WHERE revoke_id=?", revoke) });
    const seen: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const w = window();
      if (seen.at(-1) !== w.phase) seen.push(w.phase);
      if (w.state !== "active" || (w.phase !== "mark" && w.frontier === 0)) break;
      transaction(db => { markerSlice(db, 1); });
    }
    console.info(`Q23A W-A4 n=${n} phases=${seen.join(">")}`);
    expect({ ...window(), closing: window().phase !== "mark" }).toMatchObject({ state: "active", frontier: 0, closing: true });
    transaction(tx => {
      tx.prepare("INSERT INTO memory_records VALUES('late-1',1,?,'fact','late','assistant-inference','active',0,1,NULL,NULL,1)").run(f.scope);
      tx.prepare("INSERT INTO memory_records VALUES('late-2',1,?,'fact','later','assistant-inference','active',0,1,NULL,NULL,1)").run(f.scope);
      tx.prepare("INSERT INTO memory_evidence VALUES('late-1',1,?,1,0,5)").run(f.sources[3]!);
      tx.prepare("INSERT INTO memory_derivations VALUES('late-1',1,'late-2',1)").run();
      inheritEdges(tx, { id: "late-1", version: 1 });
      inheritEdges(tx, { id: "late-2", version: 1 });
    });
    drain();
    allDone();
    expect(objectRows("source", f.sources[3]!)).toBe(0);
    const late2 = notIn("withheld", "record", ["late-2"]);
    expect(late2).toEqual([]);
    expect(notIn("withheld", "record", ["late-1", ...f.records])).toEqual([]);
    expect(notIn("shown", "record", [f.pre.record, f.kept.record])).toEqual([]);
  });
});
