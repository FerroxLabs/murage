// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The first check of a resumed session (nothing remembered yet: a restart, or the epoch moved) on a session of 80 receipts of
// about 30 entries each. It used to hydrate every cited record twice (once for the receipts, once more inside the lineage
// check), re-read the memory settings for each assertion, prepare the same statements tens of thousands of times and ask SQLite
// for total_changes() at every memo lookup: 3.5 s on the 60,000-source store. The wall-clock figure is gated in memory-perf.test.ts
// (MEMORY_PERF=1); this file pins the work done, which does not depend on the machine.
import { afterEach, beforeEach, expect, it } from "vitest";
import { afterEach as thawAfterEach, beforeEach as thawBeforeEach } from "vitest";
import { thawRootSetWritesForTest } from "./replay-lineage.ts";
import { closeDatabase, database } from "../database.ts";
import { stopSearchIndex } from "../message-search-index.ts";
import { stopWalMaintenance } from "../wal-maintenance.ts";
import { ioBudget } from "../io-budget.ts";
import { continuationMemoryRevoked, resetSessionHolds } from "./disclosures.ts";
import { closeMemoryIndexReader } from "./index-reader.ts";
import { outputRootsFor, recordSessionRoots, setTurnLineageNodesForTest } from "./replay-lineage.ts";
import { buildPerfFixture } from "./testing/perf-fixture.ts";
import { THREAD, accessFor, freshDataDir } from "./testing/recall-fixture.ts";
import { LineageAllowance } from "./lineage-allowance.ts";
import { stampFreshSession, testThreadNo } from "./testing/writetime-fixture.ts";
import { forceReadTimeJudgeForTest } from "./read-time-retired.ts";
import { noteSessionFrame } from "./session-proof-schema.ts";
// 1.0.2: this test models a 1.0.1 file (legacy root-set rows) for the read-time judge, which still decides legacy data until S6.
// The retained-session proof (session-proof.ts) never proves a session without a checkpoint once the judge has retired ("cold-withhold-unproven"),
// so the judge is kept deciding on the file (read-time-retired.ts forceReadTimeJudgeForTest), as the other tests of the retired machinery do.
thawBeforeEach(() => { thawRootSetWritesForTest(true); forceReadTimeJudgeForTest(true); });
thawAfterEach(() => { thawRootSetWritesForTest(false); forceReadTimeJudgeForTest(false); });

const SESSION = "session-0";
const RECORDS = 500;
/** closeDatabase() only starts stopping the search index and the WAL checkpointer: wait for both, so no writer of the last store is left
 * when the next seed wipes the data directory (search-index-review-bound.test.ts does the same) */
async function quiesce() { await stopSearchIndex(); closeDatabase(); await stopWalMaintenance(); }
/** the 80-receipt session over `cited` records, with `unrelated` more sources and pending jobs no receipt cites */
async function seed(cited: number, unrelated = 0) {
  // These pin what a check hydrates and prepares on a session of 80 receipts citing 500 records, which costs more than the allowance of one turn
  // (a cold first turn resets such a session for warming: lineage-cold-turn.test.ts, and the two tests at the end of this file), so the check is given room to finish.
  setTurnLineageNodesForTest(1_000_000_000);
  await quiesce();
  freshDataDir("active"); resetSessionHolds();
  // awaited: the fixture writes the index file after the store; the next seed must not reset the directory under it
  await buildPerfFixture({ sources: cited + 40 + unrelated, indexedRecords: cited, cited, active: 300, waiting: 0, extraWaiting: 0, deferredJobs: 0, pendingJobs: unrelated, disclosures: 80, disclosureEntries: 30 });
  // the fixture closes and reopens the store: its stops are waited for too, before this seed writes on
  database(); await stopSearchIndex(); await stopWalMaintenance();
  // every stored line carries its lineage row (lineage-write.ts; lineage-backfill.ts for older lines): the proof looks up the message behind
  // each cited source by it, and a cited message with none ends the check as "cold-withhold-unproven" before the work pinned below is done
  {
    const db = database(), no = testThreadNo(db, THREAD);
    const line = db.prepare("INSERT INTO memory_line_lineage(thread_no,lsn,message_id,turn_lsn,mem_lsn,footprint) VALUES(?,?,?,?,NULL,NULL)");
    let lsn = Number(db.prepare("SELECT next FROM memory_lsn WHERE id=1").get()?.next ?? 1);
    db.exec("BEGIN");
    for (const message of db.prepare("SELECT id,role FROM messages WHERE thread_id=? ORDER BY at,id").all(THREAD)) { line.run(no, lsn, String(message.id), message.role === "user" ? null : lsn - 1); lsn++; }
    db.prepare("UPDATE memory_lsn SET next=max(next,?) WHERE id=1").run(lsn);
    db.exec("COMMIT");
  }
  // sessions this build wrote carry a lineage row, stamped as a 1.0.3 fresh start leaves it (S6 rule 26)
  for (const r of database().prepare("SELECT DISTINCT thread_id,driver_instance,native_session FROM memory_disclosures WHERE native_session IS NOT NULL").all()) {
    recordSessionRoots(String(r.thread_id), String(r.driver_instance), String(r.native_session), outputRootsFor(LineageAllowance.tool(1_000_000_000), []));
    stampFreshSession(database(), String(r.thread_id), String(r.driver_instance), String(r.native_session));
    // and the frame bit dispatch writes when it hands a session its first recall frame (session-proof-schema.ts noteSessionFrame): a session
    // holding receipts with none reads as one an older build left and is reset as "upgrade-session-holds-recall" before any record is read
    noteSessionFrame(database(), { threadId: String(r.thread_id), driverInstance: String(r.driver_instance), nativeSession: String(r.native_session) }, true);
  }
}
beforeEach(() => seed(RECORDS));
afterEach(async () => { closeMemoryIndexReader(); resetSessionHolds(); setTurnLineageNodesForTest(null); await quiesce(); });

const statements = () => (ioBudget as unknown as { statements: Map<string, { sql: string; calls: number }> }).statements;
const calls = (prefix: string) => [...statements().values()].filter(row => row.sql.startsWith(prefix)).reduce((sum, row) => sum + row.calls, 0);

// 1019-MEM-REALBUG (mem-r03): the access checks of one pass share what they read. Before, every assertion of the check re-read the memory
// settings (502 reads at 500 records). This pins that on the proof as it runs today; the test after it also bounds the statements of the whole check.
it("the first check of 80 receipts citing 500 records keeps the session, hydrates each record once and reads the settings a handful of times", () => {
  const { access } = accessFor();
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE native_session=?").get(SESSION)!.n)).toBe(80);
  statements().clear();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, why)).toBe(false);
  expect(why.reason).toBeUndefined();
  const distinct = Number(database().prepare("SELECT count(*) AS n FROM (SELECT DISTINCT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS v FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.native_session=?)").get(SESSION)!.n);
  expect(distinct).toBe(RECORDS);
  expect(calls("SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'")).toBe(distinct);
  expect(calls("SELECT * FROM memory_meta WHERE id=1")).toBeLessThan(10);
});

it("80 receipts citing 500 records: each record is hydrated once, the settings are read a handful of times, and nothing is prepared twice", () => {
  const { access } = accessFor();
  expect(Number(database().prepare("SELECT count(*) AS n FROM memory_disclosures WHERE native_session=?").get(SESSION)!.n)).toBe(80);
  statements().clear();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, why)).toBe(false);
  expect(why.reason).toBeUndefined();
  const distinct = Number(database().prepare("SELECT count(*) AS n FROM (SELECT DISTINCT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS v FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.native_session=?)").get(SESSION)!.n);
  expect(distinct).toBe(RECORDS);
  expect(calls("SELECT * FROM memory_records WHERE id=? AND version=? AND state='active'")).toBe(distinct);
  expect(calls("SELECT * FROM memory_meta WHERE id=1")).toBeLessThan(10);
  // the retained-session proof's commit lock guard reads total_changes() twice per check (session-proof.ts lockGuard / locked), deliberately:
  // exactly 2, whatever the size of the session (the scaling test below checks 50 to 1000 records)
  expect(calls("SELECT total_changes()")).toBe(PROOF_GUARD_READS);
  expect(total()).toBeLessThan(PROOF_STATEMENTS_FLAT + PROOF_STATEMENTS_PER_RECORD * distinct);
});

// MAIN ruling 2026-11-17 (Q1): the work of one check is linear in the records the receipts CITE, with a flat intercept, and does not move when
// unrelated history grows. Measured on the tip's proof at 125, 250, 500 and 1000 distinct cited records (exactly; 50 for the guard):
// 17,037 / 23,289 / 36,564 / 62,494 statements, the same at 10x unrelated history = 52.1 per record + 10,437 flat (least squares).
// Flat bound = that intercept + 10%. The per-record bound stays the 55 set before (under the measured + 10%, 57): never raised.
const PROOF_GUARD_READS = 2;
const PROOF_STATEMENTS_PER_RECORD = 55;
const PROOF_STATEMENTS_FLAT = 11_480;
const total = () => [...statements().values()].reduce((sum, row) => sum + row.calls, 0);
async function measureCheck(cited: number, unrelated: number) {
  await seed(cited, unrelated);
  const { access } = accessFor();
  statements().clear(); resetSessionHolds();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, why)).toBe(false);
  const distinct = Number(database().prepare("SELECT count(*) AS n FROM (SELECT DISTINCT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS v FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.native_session=?)").get(SESSION)!.n);
  // the receipts cite exactly the records asked for, so each size measures what it names
  expect(distinct).toBe(cited);
  return { distinct, statements: total(), guardReads: calls("SELECT total_changes()"), settingsReads: calls("SELECT * FROM memory_meta WHERE id=1") };
}
it("the work of the first check is linear in the cited records with a flat intercept, and the same at 10 times the unrelated history", async () => {
  // one at a time: each measurement resets the data directory
  const runs: Array<Awaited<ReturnType<typeof measureCheck>>> = [];
  for (const cited of [50, 125, 250, 500, 1000]) runs.push(await measureCheck(cited, 0));
  for (const run of runs) {
    expect(run.guardReads).toBe(PROOF_GUARD_READS);
    expect(run.settingsReads).toBeLessThan(10);
    expect(run.statements).toBeLessThan(PROOF_STATEMENTS_FLAT + PROOF_STATEMENTS_PER_RECORD * run.distinct);
  }
  // the guard reads are the same 2 on a small session (50 records) as on the large ones
  expect(runs.map(run => run.guardReads)).toEqual([2, 2, 2, 2, 2]);
  // the slope between 125 and 1000 records: no more than the measured per-record cost + 10%, so a per-record cost cannot hide in the intercept
  const [first, last] = [runs[1], runs[runs.length - 1]];
  expect([first.distinct, last.distinct]).toEqual([125, 1000]);
  expect((last.statements - first.statements) / (last.distinct - first.distinct)).toBeLessThan(PROOF_STATEMENTS_PER_RECORD);
  // and unrelated history (sources and pending jobs nothing cites) 10 times larger costs the check nothing
  for (const [cited, unrelated] of [[125, 1250], [500, 5000]] as const) {
    const alone = runs.find(run => run.distinct === cited)!;
    const grown = await measureCheck(cited, unrelated);
    expect(grown.distinct).toBe(alone.distinct);
    expect(grown.statements).toBe(alone.statements);
    expect(grown.guardReads).toBe(PROOF_GUARD_READS);
  }
});

it("the same pass still refuses the session when a cited record was archived since, and when it was tombstoned", async () => {
  const { access } = accessFor();
  const [first, second] = database().prepare("SELECT DISTINCT json_extract(j.value,'$.id') AS id, json_extract(j.value,'$.version') AS version FROM memory_disclosures d, json_each(d.record_versions) j WHERE d.native_session=? LIMIT 2").all(SESSION) as Array<{ id: string; version: number }>;
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access)).toBe(false);
  database().prepare("UPDATE memory_records SET state='archived' WHERE id=? AND version=?").run(first.id, first.version);
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, why)).toBe(true);
  expect(why.reason).toBe("changed:record");
  resetSessionHolds();
  database().prepare("UPDATE memory_records SET state='active' WHERE id=? AND version=?").run(first.id, first.version);
  database().prepare("UPDATE memory_disclosures SET state='delivered' WHERE native_session=?").run(SESSION);
  // the tip's proof does not read a change undone by hand as no change: the log holds both writes, so the session stays refused (it is reset, not revived)
  const undone: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.tool(), access.threadId, "claude", SESSION, access, undone)).toBe(true);
  expect(undone.reason).toBe("changed:record");
  // a session of the same shape that nothing touched is kept; a tombstone on one of its cited records then refuses it
  await seed(RECORDS);
  resetSessionHolds();
  const { access: fresh } = accessFor();
  expect(continuationMemoryRevoked(LineageAllowance.tool(), fresh.threadId, "claude", SESSION, fresh)).toBe(false);
  database().prepare("INSERT INTO memory_tombstones(id,target_type,target_id,revision,epoch,reason,created_at) VALUES('tomb-test','record',?,NULL,0,'test',?)").run(second.id, Date.now());
  expect(continuationMemoryRevoked(LineageAllowance.tool(), fresh.threadId, "claude", SESSION, fresh)).toBe(true);
});

// 1.0.2 lineage-cold: the receipts of the session are read within the turn's allowance (never every receipt of a session outside it)
it("with no allowance left the first check reads no receipt: the session is unproven and resets for warming", () => {
  const { access } = accessFor();
  statements().clear();
  const why: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(0), access.threadId, "claude", SESSION, access, why)).toBe(true);
  expect(why.reason).toBe("lineage-warming");
  expect(calls("SELECT rowid AS rid,bundle_id")).toBe(0);
});

it("an allowance that pays for fewer receipts than the session holds stops the read at what it pays for and resets for warming; one that pays for them all does not", () => {
  const { access } = accessFor();
  statements().clear();
  const short: { reason?: string } = {};
  // one node pays for 16 rows: the 80 receipts do not fit
  expect(continuationMemoryRevoked(LineageAllowance.turn(1), access.threadId, "claude", SESSION, access, short)).toBe(true);
  expect(short.reason).toBe("lineage-warming");
  resetSessionHolds();
  const enough: { reason?: string } = {};
  expect(continuationMemoryRevoked(LineageAllowance.turn(1_000_000), access.threadId, "claude", SESSION, access, enough)).toBe(false);
  expect(enough.reason).toBeUndefined();
});
