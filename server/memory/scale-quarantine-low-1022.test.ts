// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-scale-fin. Writer side owner: the marker (revoke-marker.ts QUARANTINE_LOW, refreshQuarantineLow, quarantineFailingJobs);
// reader side owner: deny-read.ts rawPending / keyWindows.
// Astra / Opus / Fable eaa1ced165 High (deny-read.ts:108): past 256 pending rows on a key the held window of quarantined jobs was read
// with min(since_lsn) over every quarantined job's rows (a walk of the jobs table where its optional state index is absent), so the work
// inside one turn's statements grew with the quarantined backlog. It is a stored low-water mark now: one primary-key seek.
import { afterEach, expect, it } from "vitest";
import { denyGeneration, denyReadMeter, preparedWindowIdentity, refsLookup, resetDenyReadMeter } from "./deny-read.ts";
import * as marker from "./revoke-marker.ts";
import { memoryRefKey, OWNER_TURN_READER, type LineageRef, type PreparedWindow } from "./lineage-types.ts";
import { stopMemoryRevocation, wakeMemoryRevocation } from "./memory-revocation.ts";
import { resetRevokeWriteBudget } from "./revoke-budget.ts";
import { CONTENT, WritetimeFixture } from "./testing/writetime-fixture.ts";

// bound by name so this file also loads on the pre-fix tree (base RED at the assertions below, not at an import)
const { QUARANTINE_LOW = "memory-revoke-quarantine-low", refreshQuarantineLow = () => {} } = marker as Partial<typeof marker>;
const fixtures: WritetimeFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
const ref = { kind: "record" as const, id: "rec", version: 1 };
const refs: LineageRef[] = [{ kind: "memory", ref }];
/** A scope past the 256-row limit (300 rows of live jobs from lsn 50 up) and `quarantined` quarantined jobs, the first `withRows` of them
 * with one row on it (the whole file stays under the 512-row identity bound of a prepared window); job 7's row starts at lsn 0, below
 * the record. `index` false: the optional jobs state index is not built (a deferred build). */
function seeded(quarantined: number, index = true, withRows = 1) {
  const f = new WritetimeFixture(); fixtures.push(f);
  f.source("src", "s-bot").record("rec", 1, "s-bot", ["src"]);
  const row = f.db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-bot',?,?)");
  for (let i = 0; i < 300; i++) row.run(50 + i, 100000 + i);
  for (let i = 0; i < quarantined; i++) {
    f.job(7 + i, 1); if (i < withRows) row.run(i * 3, 7 + i);
    f.db.prepare("UPDATE memory_revoke_jobs SET state='quarantined' WHERE revoke_id=?").run(7 + i);
  }
  if (!index) f.db.exec("DROP INDEX IF EXISTS memory_revoke_jobs_state_kind_phase");
  refreshQuarantineLow(f.db);
  return f;
}
/** One judged ref, as the send fence judges a ref its turn prepared under the window (past the limit an unprepared ref reads "checking"
 * under the live hold; the held window is what still withholds a prepared one): its verdict, and every plan step of the statements it
 * ran that reads the jobs table or a pending table. */
function judged(f: WritetimeFixture, prepared = true) {
  const window: PreparedWindow = { reader: CONTENT, generation: denyGeneration(f.db), identity: preparedWindowIdentity(f.db), memoryKeys: new Set([memoryRefKey(ref)]), open: true };
  resetDenyReadMeter();
  const verdict = prepared ? refsLookup(f.db, refs, CONTENT, true, window) : refsLookup(f.db, refs, CONTENT, true);
  const meter = denyReadMeter();
  const steps: string[] = [];
  for (const sql of meter.sql) for (const step of f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>) {
    // the pending-row reads (rawPending) and any statement that asks for quarantined jobs; the prepared window's own identity read
    // (deny-read.ts preparedWindowIdentity, capped at 512 rows) is another site with its own bound
    if ((sql.startsWith("WITH raw AS MATERIALIZED") || sql.includes("quarantined")) && /^(SCAN|SEARCH) /.test(step.detail)) steps.push(`${sql.startsWith("WITH raw AS MATERIALIZED") ? "raw" : "other"}: ${step.detail}`);
  }
  return { verdict, statements: meter.statements, rows: meter.rows, steps };
}
/** The steps that may grow with the backlog: anything on the jobs table but a primary-key seek, any walk of a pending table by job (the
 * whole-table pending reads are capped at 257 rows by their LIMIT: deny-read-scale.test.ts audits those). */
const growing = (steps: readonly string[]) => steps.filter(step => (/ j\b|memory_revoke_jobs/.test(step) && !/USING INTEGER PRIMARY KEY \(rowid=\?\)/.test(step))
  // a seek of a pending table by job, or any read of one outside the capped raw read (F3 2912a7b756: a statement of its own that walked the key's rows)
  || /_revoke \(revoke_id=\?\)|^other: (SCAN|SEARCH) (p|memory_deny_pending)/.test(step));

for (const index of [true, false]) {
  it(`W-QLOW-BOUNDED past 256 rows the held read is a seek of the stored mark at 10 and 1000 quarantined jobs (state index ${index ? "built" : "absent"})`, () => {
    const small = judged(seeded(10, index)), large = judged(seeded(1000, index));
    // fail closed kept at both sizes: the record under job 7's window (lsn 0) reads withheld, never shown
    expect(small.verdict).toMatchObject({ state: "withheld", reason: "scope-deny" });
    expect(large.verdict).toMatchObject({ state: "withheld", reason: "scope-deny" });
    // pre-fix eaa1ced165 / F3 2912a7b756: a step over the quarantined jobs (SEARCH j ... state=?, or SCAN j) and one pending seek per job
    expect(growing(large.steps).join(" ; ")).toBe("");
    expect(growing(small.steps).join(" ; ")).toBe("");
    expect(large.steps.length).toBeGreaterThan(0);
    expect(large.statements).toBe(small.statements);
    expect(large.rows).toBe(small.rows);
  });
}

it("W-QLOW-STORED the mark is the lowest since of the quarantined jobs' rows, and a start with none left removes it", () => {
  const f = seeded(3, true, 3);
  const mark = () => f.db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(QUARANTINE_LOW)?.intent;
  expect(mark()).toBe('{"s":0}');
  // job 7 (lsn 0) leaves quarantine: the next start's recompute raises the mark to job 8's row (lsn 3)
  f.db.prepare("UPDATE memory_revoke_jobs SET state='active' WHERE revoke_id=7").run();
  refreshQuarantineLow(f.db);
  expect(mark()).toBe('{"s":3}');
  f.db.prepare("UPDATE memory_revoke_jobs SET state='active' WHERE state='quarantined'").run();
  refreshQuarantineLow(f.db);
  expect(mark()).toBeUndefined();
  // no quarantined job and no mark: past the limit the record is held as before ("checking"), not withheld
  expect(judged(f, false).verdict).toMatchObject({ state: "checking" });
  // and a ref prepared under that live window keeps its prepared exception (the held window is gone with the mark)
  expect(judged(f).verdict).toMatchObject({ state: "shown" });
});

// The marker's own entry: the real runner (memory-revocation.ts wakeMemoryRevocation -> quarantineNow -> revoke-marker.ts
// quarantineFailingJobs) quarantines a job that can never step, and writes the mark in that transaction. Setup as revokehealth-1022.test.ts
// W-QUARANTINE (production backoff shortened so ten failures fit a test).
it("W-QLOW-ENTRY the runner's quarantine of a failing job stores the mark, so past 256 rows a prepared ref under its window reads withheld", async () => {
  const f = new WritetimeFixture().cert(true); fixtures.push(f);
  const backoff = { ...marker.JOB_BACKOFF };
  resetRevokeWriteBudget(); marker.JOB_BACKOFF.firstMs = 1; marker.JOB_BACKOFF.capMs = 4;
  const state = () => f.db.prepare("SELECT state FROM memory_revoke_jobs WHERE revoke_id=1").get()?.state;
  try {
    f.source("src", "s-bot").record("rec", 1, "s-bot", ["src"]);
    f.db.exec("UPDATE memory_record_lsn SET created_lsn=50 WHERE id='rec'");
    f.reply("line-1", "reply", 10, { turnLsn: 9 }).job(1, 11).pending("line-1", 1, 1).pendingScope("s-bot", 1, 1);
    f.db.prepare("UPDATE memory_revoke_jobs SET phase='mark' WHERE revoke_id=1").run();
    marker.enqueueNode(f.db, 1, { kind: "line", threadId: "line-1", lsn: 10 });
    // job 1 can never step: its frontier node is unreadable
    f.db.exec("UPDATE memory_revoke_frontier SET node='invalid' WHERE revoke_id=1");
    wakeMemoryRevocation(() => f.db, { busy: () => false, retryMs: 5, pauseMs: 5 });
    const end = Date.now() + 8_000;
    while (Date.now() < end && state() !== "quarantined") await new Promise(resolve => setTimeout(resolve, 20));
  } finally { stopMemoryRevocation(); resetRevokeWriteBudget(); marker.JOB_BACKOFF.firstMs = backoff.firstMs; marker.JOB_BACKOFF.capMs = backoff.capMs; }
  expect(state()).toBe("quarantined");
  // pre-fix eaa1ced165 / F3 2912a7b756: undefined (no stored mark; the readers walked the jobs)
  expect(f.db.prepare("SELECT intent FROM memory_scope_bindings WHERE id=?").get(QUARANTINE_LOW)?.intent).toBe('{"t":1,"s":1}');
  // the scope then passes the limit (300 rows of live jobs above the record): the prepared ref is still withheld, by the stored mark
  const row = f.db.prepare("INSERT INTO memory_deny_pending_scope(scope_id,since_lsn,revoke_id) VALUES('s-bot',?,?)");
  for (let i = 0; i < 300; i++) row.run(60 + i, 100000 + i);
  expect(judged(f).verdict).toMatchObject({ state: "withheld", reason: "scope-deny" });
});

// W-QLOW-START (Astra 7b9de96263 High) lives in scale-quarantine-late-1023.test.ts: here the hoisted stand-in of the version source never
// reached memory-revocation.ts (Fable/Opus a482cd6d07 H3), so the case passed with the old guard restored. It is proven there.

// 1.0.24 q1024-sweep1 (Astra 0e99f99ba2 High, deny-read.ts:652): the owner's own direct turn (LineageReader.settled, MAIN-RULING D2) reads the durable deny
// rows only, so the held window of a quarantined job (or the table-wide stored low past the read limit) never withholds it; the same ref prepared by a
// send fence, and any other reader, still reads withheld there. Same fixture at 10 and 1000 quarantined jobs.
for (const jobs of [10, 1000]) {
  it(`W-QLOW-OWNER the owner's settled turn is shown a record under a quarantined window, a prepared send-fence ref is not (${jobs} quarantined jobs)`, () => {
    const f = seeded(jobs);
    expect(refsLookup(f.db, refs, OWNER_TURN_READER), "the owner's own turn reads durable rows only").toMatchObject({ state: "shown" });
    expect(judged(f).verdict, "a prepared send-fence ref keeps the hold").toMatchObject({ state: "withheld", reason: "scope-deny" });
    expect(refsLookup(f.db, refs, CONTENT), "a reader that is not the owner's turn is still held").not.toMatchObject({ state: "shown" });
  });
}
