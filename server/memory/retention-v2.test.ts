// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane I (memory V2 retention, MEMORY-V2-DESIGN 4.10 and section 5 M5). Gate rows: G-BOUNDED (memory_jobs and the recall
// journal bound over a real ready view; lane A owns the trim it holds; the revoke rows are printed, lane C's), RET-W parts 2 and 3.
// RED on f6ae52c670: nothing ever deletes a terminal memory_jobs row (the retention module does not exist), so a simulated
// day leaves every dead job in place for ever.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { ensureWorkspace } from "../workspace.ts";
import { commitMemoryImport, previewMemoryImport } from "./import.ts";
import { forgetMemory } from "./forget.ts";
import { ownerMemoryTicket, readCorrectionTarget } from "./authority.ts";
import { reconcileMemoryRoster } from "./policy.ts";
import { LAP_DELAY_MS, MIGRATION_TOPIC, openRetentionLap, PACE_RATIO, SLICE_MS, registerMigrationStep, resetMigrationV2ForTests, retentionLapDue, runMigrationSlice, readMarker, RETENTION_LAP_TOPIC, startMigrationV2, STALL_MIN_MS } from "./migration-v2.ts";
import { deadlineOf, wakeStats } from "./wake.ts";
import { RETENTION_AGE_MS, stubPayloadsPage } from "./retention-v2.ts";
import { threadCheckpointId } from "./checkpoints.ts";
import { captureSource } from "./capture.ts";
import { bringInToProject } from "./bring-in.ts";
import { storeAnchorMessage } from "./testing/anchor-message.ts";
import { captureTurn, FIXTURE_BOT, fixtureRoster, importNotebook, notebookLine, protectedDigest } from "./testing/memv2-retention-fixture.ts";
import { viewRoster } from "./testing/memv2-psuite-kill.ts";
import { prepareRecallContextSync, RECALL_FLUSH_ROWS } from "./recall-view.ts";

const DAY = 24 * 60 * 60 * 1000;
// Each test starts 30 days after the last one: import previews are process state and expire 10 minutes after they are made.
let T0 = Date.parse("2026-09-01T00:00:00Z");
beforeEach(() => {
  T0 += 30 * DAY;
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(fixtureRoster); database().exec("UPDATE memory_meta SET mode='active'");
  resetMigrationV2ForTests();
});
afterEach(() => { vi.useRealTimers(); resetMigrationV2ForTests(); });

function runToEnd(now = Date.now()) {
  for (let slices = 0; slices < 10_000; slices++) if (!runMigrationSlice({ now }).more) return slices + 1;
  throw new Error("migration did not finish");
}
const count = (sql: string, ...args: Array<string | number>) => Number(database().prepare(sql).get(...args)!.n);

it("G-BOUNDED (memory_jobs): a simulated day of notebook appends and turns leaves no dead job once it is 7 days old", () => {
  // The design's day: 1,440 notebook appends (one a minute) and 500 turns (ASTRA r3 H5: the r3 gate ran 360).
  const APPENDS = 1440, TURNS = 500;
  for (let i = 0; i < APPENDS; i++) {
    vi.setSystemTime(T0 + i * 60_000);
    importNotebook(8 + i);
    if (i % Math.ceil(APPENDS / TURNS) === 0) captureTurn(i);
    // The app's checkpointer worker keeps the log short; a unit test has none, so the write admission would refuse.
    if (i % 10 === 9) {
      const result = database().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (i % 200 === 199) console.log(`G-BOUNDED progress i=${i} checkpoint=${JSON.stringify(result)}`);
    }
  }
  for (let n = 0; count("SELECT count(*) AS n FROM memory_sources WHERE id LIKE 'turn-source-%'") < TURNS; n++) captureTurn(APPENDS + n);
  // A second day of turns that stays younger than 7 days at the check.
  vi.setSystemTime(T0 + 7 * DAY); for (let n = 0; n < 20; n++) captureTurn(100_000 + n);
  const now = T0 + 8 * DAY + 1; vi.setSystemTime(now);
  // (KILLSUITE R-bounded, FABLE d070b56610 H3) a real ready recall context over the day's journal, built by the real recall path after
  // the day (no build in flight at the run: the 4,096 bound with no build allowance). Its watermark is the journal's newest row.
  reconcileMemoryRoster(viewRoster); prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster);
  // ten rows written after the view was prepared: above its watermark, not applied by it, so no trim may take them (Opus r10 H1: without
  // them the watermark is the newest row and the "unapplied kept" check holds whatever the trim does with the watermark)
  database().exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10) INSERT INTO memory_recall_changes(kind,object_id,version) SELECT 'record','unapplied-'||i,1 FROM n");
  const db = database(), before = protectedDigest(db), jobsBefore = count("SELECT count(*) AS n FROM memory_jobs");
  // The oracle is per row and by construction, not the retention rule again: the fixture publishes no record, so after the run exactly
  // the jobs of each source's live revision and every job of the second day's (young) turns are left; every other job (each settled
  // turn's draft revision, each superseded notebook revision, all from the first day) is gone.
  const jobKey = "source_id||':'||source_revision||':'||stage||':'||status";
  const keep = db.prepare(`SELECT ${jobKey} AS k FROM memory_jobs j WHERE source_id LIKE 'turn-source-1000%'
    OR source_revision=(SELECT revision FROM memory_sources s WHERE s.id=j.source_id) ORDER BY 1`).all().map(row => String(row.k));
  const deadBefore = jobsBefore - keep.length;
  const journal = count("SELECT count(*) AS n FROM memory_recall_changes"), newest = count("SELECT max(sequence) AS n FROM memory_recall_changes");
  const low = count(`SELECT min(v.watermark) AS n FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1 WHERE v.state='ready' AND v.watermark>=e.projection_floor`);
  const unapplied = () => db.prepare("SELECT sequence,object_id FROM memory_recall_changes WHERE sequence>? ORDER BY sequence").all(low).map(r => `${r.sequence}:${r.object_id}`);
  const unappliedBefore = unapplied();
  expect([journal > 2 * RECALL_FLUSH_ROWS, low > 0, unappliedBefore.length, newest > low], "the day's journal is long, a ready view stands over it, ten rows above it").toEqual([true, true, 10, true]);
  const revoke = count("SELECT count(*) AS n FROM memory_revoke_jobs");
  expect(deadBefore).toBeGreaterThan(TURNS - 1); // every settled turn left its draft revision's cancelled job behind
  const slices = runToEnd(now);
  const jobsAfter = count("SELECT count(*) AS n FROM memory_jobs");
  const payloadBytes = count("SELECT coalesce(sum(octet_length(payload)),0) AS n FROM memory_source_versions WHERE source_id>='legacy:' AND source_id<'legacy;'");
  const journalAfter = count("SELECT count(*) AS n FROM memory_recall_changes");
  console.log(`GATE-MEASURE G-BOUNDED memory_jobs before=${jobsBefore} after=${jobsAfter} dead ${deadBefore} -> ${jobsAfter - keep.length} bound=0 slices=${slices}`);
  console.log(`GATE-MEASURE G-BOUNDED memory_recall_changes ${journal} -> ${journalAfter} bound=${RECALL_FLUSH_ROWS} (no build in flight) memory_revoke_jobs=${revoke} (lane C) notebook_payload_bytes=${payloadBytes} (stub off: named not bounded)`);
  expect(db.prepare(`SELECT ${jobKey} AS k FROM memory_jobs ORDER BY 1`).all().map(row => String(row.k))).toEqual(keep);
  expect(count("SELECT count(*) AS n FROM memory_jobs WHERE source_id LIKE 'turn-source-1000%'")).toBe(40);
  expect(protectedDigest(db)).toEqual(before);
  expect(readMarker(db, "M5")).toMatchObject({ done: true });
  // The journal bound (KILLSUITE R-bounded): at most 4,096 rows with no build in flight, its newest row kept, and no row a ready view
  // has not applied lost (every row above the lowest ready watermark is still there, gap-free up to the newest)
  // (the ten unapplied rows exactly, then M5's own job-delete rows after them)
  expect({ bounded: journalAfter <= RECALL_FLUSH_ROWS, newestKept: count("SELECT count(*) AS n FROM memory_recall_changes WHERE sequence=?", newest),
    unappliedKept: unapplied().slice(0, unappliedBefore.length).join(" ") === unappliedBefore.join(" "),
    floorAtOrBelowLow: count("SELECT projection_floor AS n FROM memory_recall_epoch WHERE id=1") <= low }, `journal ${journal} -> ${journalAfter}`)
    .toEqual({ bounded: true, newestKept: 1, unappliedKept: true, floorAtOrBelowLow: true });
}, 1_200_000);

it("I5: a finished M5 run again changes 0 rows and opens no transaction", () => {
  for (let n = 0; n < 5; n++) captureTurn(n);
  vi.setSystemTime(T0 + 8 * DAY); runToEnd();
  const db = database(), changes = Number(db.prepare("SELECT total_changes() AS n").get()!.n);
  expect(runMigrationSlice()).toEqual({ ran: undefined, more: false, waitLive: false });
  expect(Number(db.prepare("SELECT total_changes() AS n").get()!.n)).toBe(changes);
});

it("M5 keeps a terminal job younger than 7 days and the live revision's complete capture job", () => {
  for (let n = 0; n < 3; n++) captureTurn(n);
  const db = database();
  db.exec("UPDATE memory_jobs SET status='complete' WHERE status='pending'"); // a settled, extracted turn: the learnability proof
  vi.setSystemTime(T0 + 6 * DAY); runToEnd();
  expect(count("SELECT count(*) AS n FROM memory_jobs")).toBe(6);
  resetMigrationV2ForTests(); db.exec("DELETE FROM memory_scope_bindings WHERE id LIKE 'memory-v2:%'");
  vi.setSystemTime(T0 + 8 * DAY); runToEnd();
  // the cancelled draft jobs go; the complete capture of each live revision stays (learnable.ts:16 reads it)
  expect(db.prepare("SELECT source_revision AS r,status FROM memory_jobs ORDER BY source_id").all()).toEqual([1, 2, 3].map(() => ({ r: 2, status: "complete" })));
});

it("M5 keeps a retired source's jobs: a branch switched away for 8 days can come back and still be learnable", () => {
  for (let n = 0; n < 2; n++) captureTurn(n);
  const db = database();
  db.exec("UPDATE memory_jobs SET status='complete' WHERE status='pending'");
  db.exec("UPDATE memory_sources SET state='retired' WHERE id='turn-source-0'");
  vi.setSystemTime(T0 + 8 * DAY); runToEnd();
  // only the two cancelled drafts of superseded revisions go; the retired source's live-revision capture proof stays
  expect(db.prepare("SELECT source_id,source_revision AS r,status FROM memory_jobs ORDER BY source_id").all())
    .toEqual([{ source_id: "turn-source-0", r: 2, status: "complete" }, { source_id: "turn-source-1", r: 2, status: "complete" }]);
});

it("M5 keeps a job its checkpoint-debt marker names (CONTRACT-REQ I 1518): deleting it would strand a debt no roll can clear", () => {
  for (let n = 0; n < 2; n++) captureTurn(n);
  const db = database(), scope = String(db.prepare("SELECT id FROM memory_scopes LIMIT 1").get()!.id);
  db.exec("UPDATE memory_jobs SET status='complete' WHERE status='pending'");
  // An older build's per-job debt row on turn 0's first revision (its roll never ran before the turn was settled to revision 2).
  const owed = db.prepare("SELECT id FROM memory_jobs WHERE source_id='turn-source-0' AND source_revision=1").get()!.id;
  db.prepare("INSERT INTO memory_scope_bindings VALUES(?,?,'system','checkpoint-pending',0,'granted',?)")
    .run(`checkpoint-debt:${owed}`, scope, JSON.stringify({ jobId: owed, sourceId: "turn-source-0", revision: 1 }));
  vi.setSystemTime(T0 + 8 * DAY); runToEnd();
  // turn 1's dead draft goes; turn 0's draft stays while its marker exists, and so does the marker
  expect(db.prepare("SELECT source_id,source_revision AS r FROM memory_jobs WHERE source_revision=1 ORDER BY source_id").all())
    .toEqual([{ source_id: "turn-source-0", r: 1 }]);
  expect(count("SELECT count(*) AS n FROM memory_scope_bindings WHERE id=?", `checkpoint-debt:${owed}`)).toBe(1);
});

it.each([
  ["the receipt-ref index", "UPDATE memory_revocation_index_build SET ready=?"],
  ["the by-source evidence lookup", "UPDATE memory_late_build SET ready=? WHERE name='evidence'"],
])("M5 deletes no job while %s is still building (it would miss a keep reason): it backs off and resumes once ready", (_name, flip) => {
  for (let n = 0; n < 2; n++) captureTurn(n);
  const db = database(), drafts = "SELECT count(*) AS n FROM memory_jobs WHERE source_revision=1";
  db.prepare(flip).run(0);
  vi.setSystemTime(T0 + 8 * DAY);
  let outcome = runMigrationSlice({ budgetMs: 1000 });
  for (let n = 0; n < 10 && outcome.stalled === undefined; n++) outcome = runMigrationSlice({ budgetMs: 1000 });
  expect([outcome.stalled, count(drafts)]).toEqual(["M5", 2]);
  db.prepare(flip).run(1);
  runToEnd();
  expect(count(drafts)).toBe(0);
});

it("M5 keeps a job that has a checkpoint publication (4.10: the checkpoint row and the job it names stay)", () => {
  for (let n = 0; n < 2; n++) captureTurn(n);
  const db = database();
  const job = db.prepare("SELECT j.id,s.scope_id AS scope,s.thread_id AS thread FROM memory_jobs j JOIN memory_sources s ON s.id=j.source_id WHERE j.source_id='turn-source-0' AND j.source_revision=1").get()!;
  // the family and row consolidate.ts writes for a job it rolled into its thread's notes
  const family = threadCheckpointId(String(job.scope), String(job.thread));
  db.prepare("INSERT OR IGNORE INTO memory_checkpoint_heads(family_id,scope_id,thread_id) VALUES(?,?,?)").run(family, job.scope, job.thread);
  db.prepare("INSERT INTO memory_checkpoint_publications VALUES(?,?,'checkpoint-record',1)").run(family, job.id);
  vi.setSystemTime(T0 + 8 * DAY); runToEnd();
  expect(db.prepare("SELECT source_id,source_revision AS r FROM memory_jobs WHERE source_revision=1 ORDER BY source_id").all())
    .toEqual([{ source_id: "turn-source-0", r: 1 }]);
});

it("M5 never deletes the newest job row (a reused max rowid would hide the next job from rows-since readers)", () => {
  for (let n = 0; n < 2; n++) captureTurn(n);
  const db = database();
  db.exec("UPDATE memory_jobs SET status='complete' WHERE status='pending'");
  db.exec("UPDATE memory_sources SET state='deleted' WHERE id='turn-source-1'"); // every job of turn 1 is dead, its last one the newest row
  const newest = Number(db.prepare("SELECT max(rowid) AS n FROM memory_jobs").get()!.n);
  vi.setSystemTime(T0 + 8 * DAY); runToEnd();
  expect(db.prepare("SELECT rowid AS r,source_id FROM memory_jobs WHERE source_id='turn-source-1'").all()).toEqual([{ r: newest, source_id: "turn-source-1" }]);
});

// ---- RET-W ([P], 4.10). The stub pass is OFF in the runner (PAYLOAD_STUB_ENABLED) until all four parts are GREEN; these
// witnesses drive stubPayloadsPage directly on rows the real import wrote. ----
function revisedNotebook(revisions: number) {
  for (let i = 0; i < revisions; i++) { vi.setSystemTime(T0 + i * 11 * 60_000); importNotebook(4 + i); }
  vi.setSystemTime(T0 + 8 * DAY);
}
const stubAll = () => { const db = database(); let after = 0; for (let n = 0; n < 1000; n++) { const page = stubPayloadsPage(db, after, Date.now()); after = page.cursor; if (page.done) return; } throw new Error("stub pass did not finish (refs index not ready?)"); };

it("RET-W stub rule: only old non-current revisions are stubbed, the row and content_hash stay, and the newest two keep their text", () => {
  revisedNotebook(6);
  const db = database(), before = db.prepare("SELECT source_id,revision,content_hash FROM memory_source_versions WHERE source_id LIKE 'legacy:%' ORDER BY revision").all();
  stubAll();
  const after = db.prepare("SELECT source_id,revision,content_hash,json_extract(payload,'$.pruned') AS pruned,json_extract(payload,'$.text') AS text FROM memory_source_versions WHERE source_id LIKE 'legacy:%' ORDER BY revision").all();
  expect(after.map(row => ({ source_id: row.source_id, revision: row.revision, content_hash: row.content_hash }))).toEqual(before);
  const current = Math.max(...after.map(row => Number(row.revision)));
  for (const row of after) {
    if (Number(row.revision) >= current - 1) expect(row.pruned).toBeNull();
    // a revision cited by a live record is never stubbed
    else if (count("SELECT count(*) AS n FROM memory_evidence_by_source e JOIN memory_records r ON r.id=e.record_id AND r.version=e.record_version WHERE e.source_id=? AND e.source_revision=? AND r.state IN ('active','candidate')", String(row.source_id), Number(row.revision)))
      expect(row.pruned).toBeNull();
    else expect([row.pruned, row.text]).toEqual([1, ""]);
  }
  expect(after.some(row => row.pruned === 1)).toBe(true);
});

it("RET-W part 2: every live record's correction-target verdict and evidence are the same before and after stubbing", () => {
  revisedNotebook(6);
  const db = database(), live = db.prepare("SELECT id,version FROM memory_records WHERE state IN ('active','candidate') ORDER BY id,version").all();
  const verdicts = () => live.map(r => ({ target: readCorrectionTarget(db, String(r.id), Number(r.version)),
    stubbedEvidence: count(`SELECT count(*) AS n FROM memory_evidence e JOIN memory_source_versions v ON v.source_id=e.source_id AND v.revision=e.source_revision
      WHERE e.record_id=? AND e.record_version=? AND json_extract(v.payload,'$.pruned')=1`, String(r.id), Number(r.version)) }));
  const before = verdicts(); stubAll();
  expect(live.length).toBeGreaterThan(0);
  expect(verdicts()).toEqual(before);
  expect(before.every(v => v.stubbedEvidence === 0)).toBe(true);
});

it("RET-W part 3: a source Forget after stubbing tombstones every historical content hash; the old text under another source id is refused", () => {
  revisedNotebook(6);
  const db = database(), source = String(db.prepare("SELECT id FROM memory_sources WHERE id LIKE 'legacy:%'").get()!.id);
  const hashes = db.prepare("SELECT content_hash AS h FROM memory_source_versions WHERE source_id=? ORDER BY revision").all(source).map(row => String(row.h));
  stubAll();
  expect(count("SELECT count(*) AS n FROM memory_source_versions WHERE source_id=? AND json_extract(payload,'$.pruned')=1", source)).toBeGreaterThan(0);
  forgetMemory(ownerMemoryTicket(), { kind: "source", id: source });
  const tombstoned = new Set(db.prepare("SELECT content_hash AS h FROM memory_tombstones WHERE target_type='import'").all().map(row => String(row.h)));
  for (const hash of hashes) expect(tombstoned.has(hash)).toBe(true);
  // The first revision's text (stubbed above) comes back as another file of the same notebook scope: refused by its hash.
  const recordsBefore = count("SELECT count(*) AS n FROM memory_records WHERE state='active'");
  expect(() => importOldCopyUnderOtherSourceId()).toThrow(/MEMORY_IMPORT_FOR/);
  expect(count("SELECT count(*) AS n FROM memory_records WHERE state='active'")).toBe(recordsBefore);
});

function importOldCopyUnderOtherSourceId() {
  // memory/old-copy.md of the same bot: another path, so another source id, in the scope the import tombstones name.
  const dir = join(ensureWorkspace(FIXTURE_BOT), "memory"), ticket = ownerMemoryTicket();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "old-copy.md"), Array.from({ length: 4 }, (_, i) => notebookLine(i)).join("\n") + "\n");
  return commitMemoryImport(ticket, previewMemoryImport(ticket, [{ kind: "bot", botId: FIXTURE_BOT, topic: "old-copy.md" }], fixtureRoster).previewId, fixtureRoster, true);
}

// ---- the steady-state lap (Opus review H2 of round 1: rows below the done cursor that were too young at the run were never revisited) ----

it("lap: a job too young at the first pass goes once it is 7 days old, though it sits below the finished cursor", () => {
  for (let n = 0; n < 3; n++) captureTurn(n);           // day 0: three turns, each leaves a cancelled draft job
  vi.setSystemTime(T0 + 5 * DAY); runToEnd();             // first pass: all three drafts are only 5 days old
  const db = database(), drafts = "SELECT count(*) AS n FROM memory_jobs WHERE source_revision=1";
  expect(count(drafts)).toBe(3);
  expect(readMarker(db, "M5")).toMatchObject({ done: true });
  // the next lap is due exactly when the oldest of them turns 7 days old: one deadline, no timer before it
  expect(retentionLapDue(db, Date.now())).toBe(T0 + RETENTION_AGE_MS);
  vi.setSystemTime(T0 + RETENTION_AGE_MS - 1); expect(openRetentionLap(Date.now())).toBe(false);
  vi.setSystemTime(T0 + RETENTION_AGE_MS + 1); expect(openRetentionLap(Date.now())).toBe(true);
  runToEnd();
  expect(count(drafts)).toBe(0);
  expect(count("SELECT count(*) AS n FROM memory_jobs WHERE source_revision=2")).toBe(3);
  // nothing left to wait for and no job written since: no lap is due (nothing armed at rest)
  expect(retentionLapDue(db, Date.now())).toBeUndefined();
});

it("lap: a job written after the pass makes a lap due a day after that pass started (a fixed time), and the chain reaches its deletion", () => {
  captureTurn(0); const pass = T0 + 8 * DAY; vi.setSystemTime(pass); runToEnd();
  const db = database(), drafts = "SELECT count(*) AS n FROM memory_jobs WHERE source_revision=1";
  expect(count(drafts)).toBe(0);
  expect(retentionLapDue(db, Date.now())).toBeUndefined(); // nothing written, nothing young: nothing armed at rest
  captureTurn(1);                                            // a new turn: its draft job will be dead once 7 days old
  expect(count(drafts)).toBe(1);
  // the due time does not move with the clock (a deadline re-armed from "now" would never come due)
  expect(retentionLapDue(db, pass + 1000)).toBe(pass + LAP_DELAY_MS);
  vi.setSystemTime(pass + LAP_DELAY_MS - 1); expect(retentionLapDue(db, Date.now())).toBe(pass + LAP_DELAY_MS);
  expect(openRetentionLap(Date.now())).toBe(false);
  vi.setSystemTime(pass + LAP_DELAY_MS + 1); expect(openRetentionLap(Date.now())).toBe(true);
  runToEnd();
  expect(count(drafts)).toBe(1);                             // one day old: kept, and remembered as the youngest candidate
  expect(retentionLapDue(db, Date.now())).toBe(pass + RETENTION_AGE_MS);
  vi.setSystemTime(pass + RETENTION_AGE_MS + 1); expect(openRetentionLap(Date.now())).toBe(true);
  runToEnd();
  expect(count(drafts)).toBe(0);
  expect(retentionLapDue(db, Date.now())).toBeUndefined();
});

it("stall: a step that is not done and moves nothing backs off; later tasks wait their turn (design order)", () => {
  let calls = 0;
  registerMigrationStep("M2", () => { calls++; return { cursor: { pending: true }, done: false }; });
  const first = runMigrationSlice({ budgetMs: 1000 });
  expect(first).toEqual({ ran: "M2", more: false, stalled: "M2" });
  expect(calls).toBe(2); // the first batch moved the cursor from nothing, the second moved nothing
  expect(readMarker(database(), "M3")).toBeUndefined();
});

it("I5 (ASTRA r3 H4): a stalled batch ends in ROLLBACK; only the batch that moved its cursor commits", () => {
  registerMigrationStep("M2", () => ({ cursor: { pending: true }, done: false }));
  const db = database(), ends: string[] = [], exec = db.exec.bind(db);
  db.exec = (sql: string) => { if (/^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) ends.push(sql.trim().split(/\s/)[0]!.toUpperCase()); return exec(sql); };
  try {
    expect(runMigrationSlice({ budgetMs: 1000 })).toEqual({ ran: "M2", more: false, stalled: "M2" });
    expect(runMigrationSlice({ budgetMs: 1000 })).toEqual({ ran: "M2", more: false, stalled: "M2" });
  } finally { delete (db as { exec?: unknown }).exec; }
  // the first batch wrote the cursor (nothing -> pending); every batch after it moved nothing and committed nothing
  expect(ends).toEqual(["COMMIT", "ROLLBACK", "ROLLBACK"]);
  expect(readMarker(db, "M2")).toEqual({ cursor: { pending: true }, done: false });
});

it("stall: a batch that writes rows but keeps its cursor (a large version continued in place) is progress, not a stall", () => {
  let calls = 0;
  registerMigrationStep("M2", db => {
    calls++;
    if (calls < 4) db.prepare("UPDATE memory_meta SET mode=mode").run();
    return { cursor: { after: 7 }, done: calls >= 4 };
  });
  const outcome = runMigrationSlice({ budgetMs: 1000 });
  expect(outcome.stalled).toBeUndefined();
  expect(calls).toBeGreaterThanOrEqual(4);
  expect(readMarker(database(), "M2")).toMatchObject({ done: true });
});

it("wake: a stalled runner arms ONE back-off deadline; a finished runner leaves nothing armed", async () => {
  vi.useRealTimers();
  const pump = () => new Promise(resolve => setImmediate(resolve));
  let stall = true;
  registerMigrationStep("M2", () => ({ cursor: { pending: stall }, done: !stall }));
  const before = Date.now();
  startMigrationV2();
  for (let n = 0; n < 4 && deadlineOf(MIGRATION_TOPIC) === undefined; n++) await pump();
  const due = deadlineOf(MIGRATION_TOPIC)!;
  expect(due - before).toBeGreaterThanOrEqual(STALL_MIN_MS);
  expect(due - Date.now()).toBeLessThanOrEqual(STALL_MIN_MS);
  stall = false;
  // the wake arrives (here: raised by hand instead of waiting a second); the runner ends and arms nothing
  const { raise } = await import("./wake.ts"); raise(MIGRATION_TOPIC);
  // paced: each next slice is a short deadline (4 x the slice), so wait on real time, not only on the immediate queue
  for (let n = 0; n < 400 && readMarker(database(), "M5")?.done !== true; n++) await new Promise(resolve => setTimeout(resolve, 5));
  await pump();
  expect(readMarker(database(), "M5")).toMatchObject({ done: true });
  expect(deadlineOf(RETENTION_LAP_TOPIC)).toBeUndefined();
  expect(deadlineOf(MIGRATION_TOPIC)).toBeUndefined();
  expect(wakeStats().owed).toBe(0);
});

// SITES (memv2-I SITES.md, class "a memory_jobs row INSERTed in a status the pending trigger does not match"): the grep
// `INSERT.*INTO memory_jobs` over server/memory (tests aside) returns capture.ts:149, capture.ts:154 and bring-in.ts:193. One row per
// site and born-closed status, each driven through that site's own production entry point; `prep` runs before the retention pass.
const roomRoster = { bots: [{ id: FIXTURE_BOT, threadId: "thread-a" }], groups: [{ id: "room", threadId: "room-thread", memberIds: [FIXTURE_BOT] }] };
const BORN_SITES: Array<{ site: string; status: string; prep?: () => void; insert: () => void }> = [
  { site: "capture.ts:154, a turn still running (born cancelled)", status: "cancelled", insert: () => {
    storeAnchorMessage(database(), "thread-a", "turn-message-born", "a draft");
    captureSource(database(), { id: "turn-source-born", threadId: "thread-a", messageId: "turn-message-born", origin: { kind: "attended" }, kind: "text", speaker: "bot", outcome: "working", text: "a draft" });
  } },
  { site: "capture.ts:154, a source left out of memory (born complete)", status: "complete", insert: () => {
    storeAnchorMessage(database(), "thread-a", "turn-message-left-out", "a line left out");
    captureSource(database(), { id: "turn-source-left-out", threadId: "thread-a", messageId: "turn-message-left-out", origin: { kind: "attended" }, kind: "text", speaker: "bot", outcome: "recorded", text: "a line left out", excluded: "unsupported-card" });
  } },
  // (the thread already owes its checkpoint from an earlier settled turn, so this turn adds no debt marker: the marker's own wake,
  // mem_wake_debt_i, does not fire and the job INSERT is the only thing that can wake the lap)
  { site: "capture.ts:149, a settled harness turn on a thread already owed (born complete)", status: "complete",
    prep: () => { captureSource(database(), { id: "turn-owed", threadId: "thread-a", turnId: "turn-owed", kind: "turn", speaker: "harness", outcome: "completed", text: "Completed earlier" }); },
    insert: () => { captureSource(database(), { id: "turn-born", threadId: "thread-a", turnId: "turn-born", kind: "turn", speaker: "harness", outcome: "completed", text: "Completed" }); } },
  { site: "bring-in.ts:193, a line brought into a project (born complete)", status: "complete",
    prep: () => {
      reconcileMemoryRoster(roomRoster);
      storeAnchorMessage(database(), "thread-a", "owner-line", "The owner said: the launch is on Friday at six.", "user");
      captureSource(database(), { id: "message:thread-a:owner-line", threadId: "thread-a", messageId: "owner-line", kind: "text", speaker: "owner", outcome: "recorded", text: "The owner said: the launch is on Friday at six." });
    },
    insert: () => { expect(bringInToProject(database(), { groupId: "room", roomThreadId: "room-thread", botId: FIXTURE_BOT, roster: roomRoster as never, now: Date.now(), sourceMessageId: "owner-line" })).toMatchObject({ ok: true }); } },
];
it.each(BORN_SITES)("lap wake (ASTRA r3 H1) $site: a job INSERTed already closed re-arms the lap through the real wake bus, with M5 finished at rest", async ({ status, prep, insert }) => {
  const pump = () => new Promise(resolve => setImmediate(resolve));
  captureTurn(0); prep?.(); const pass = T0 + 8 * DAY; vi.setSystemTime(pass); runToEnd();
  startMigrationV2();
  for (let n = 0; n < 20; n++) await pump();
  expect(deadlineOf(RETENTION_LAP_TOPIC)).toBeUndefined(); // at rest: nothing written since the pass, nothing young
  // the site's own entry point INSERTs exactly one job, born closed (never pending); no other job is written
  const db = database(), rows = count("SELECT count(*) AS n FROM memory_jobs");
  insert();
  expect(count("SELECT count(*) AS n FROM memory_jobs")).toBe(rows + 1);
  expect(db.prepare("SELECT status FROM memory_jobs ORDER BY rowid DESC LIMIT 1").get()).toEqual({ status });
  for (let n = 0; n < 20 && deadlineOf(RETENTION_LAP_TOPIC) === undefined; n++) await pump();
  expect(deadlineOf(RETENTION_LAP_TOPIC)).toBe(pass + LAP_DELAY_MS);
});

it("pace: a slice that leaves work arms the next one 4x its length later (<= 20% of the main thread), never an immediate re-raise", async () => {
  vi.useRealTimers();
  const pump = () => new Promise(resolve => setImmediate(resolve));
  let calls = 0, sliceEnd = 0;
  registerMigrationStep("M2", () => {
    calls++;
    for (const until = performance.now() + 3; performance.now() < until;) { /* a 3 ms batch */ }
    sliceEnd = Date.now();
    return { cursor: { after: calls }, done: calls >= 10_000 };
  });
  startMigrationV2();
  for (let n = 0; n < 20 && calls === 0; n++) await pump();
  // the slice ran about SLICE_MS of batches; the next one is a deadline at least PACE_RATIO x that later, not a raise
  expect((deadlineOf(MIGRATION_TOPIC) ?? Number.NEGATIVE_INFINITY) - sliceEnd).toBeGreaterThanOrEqual((PACE_RATIO - 1) * SLICE_MS);
});
