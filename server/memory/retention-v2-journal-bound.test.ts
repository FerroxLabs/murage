// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: lane I (memory V2 migration runner, G-BOUNDED witness; KILLSUITE R-bounded). Lane A owns the journal trim and the build hold
// it respects (recall-view.ts trimRecallJournalPage / recallJournalTrimStep); lane J the day fixture (testing/memv2-retention-fixture.ts).
// R-bounded cells "a build held over a prefix" and "catch-up on build completion" (designs/memv2-I/KILLSUITE.md, Restart equality and
// boundedness). The no-build cell is G-BOUNDED in retention-v2.test.ts. This file imports only what the runner exported before M3 was
// registered (14ff784487, parent of 2aa2ef6ded), so on that sha it fails at its own assertions, not at load: no M3, no hold, no trim.
import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DATA_DIR } from "../config.ts";
import { closeDatabase, database } from "../database.ts";
import { removeTempDirSync } from "../testing/cleanup.ts";
import { type MemoryRoster, reconcileMemoryRoster } from "./policy.ts";
import { readMarker, resetMigrationV2ForTests, runMigrationSlice } from "./migration-v2.ts";
import { prepareRecallContext, prepareRecallContextSync, RECALL_FLUSH_ROWS } from "./recall-view.ts";
import { captureTurn, FIXTURE_BOT, fixtureRoster, importNotebook } from "./testing/memv2-retention-fixture.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-12-01T00:00:00Z");
const viewRoster = { ...fixtureRoster, memoryRosterRevision: 1 } as unknown as MemoryRoster;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0);
  closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true });
  reconcileMemoryRoster(fixtureRoster); database().exec("UPDATE memory_meta SET mode='active'");
  resetMigrationV2ForTests();
});
afterEach(() => { vi.useRealTimers(); resetMigrationV2ForTests(); });

const count = (sql: string, ...args: Array<string | number>) => Number(database().prepare(sql).get(...args)!.n);
const journalIds = () => database().prepare("SELECT sequence,object_id FROM memory_recall_changes ORDER BY sequence").all().map(r => `${r.sequence}:${r.object_id}`);
const floor = () => count("SELECT projection_floor AS n FROM memory_recall_epoch WHERE id=1");
const lowReady = () => count("SELECT min(v.watermark) AS n FROM memory_recall_views v JOIN memory_recall_epoch e ON e.id=1 WHERE v.state='ready' AND v.watermark>=e.projection_floor");

it("G-BOUNDED (journal, build held): a build in flight holds the M3 trim over its prefix; on its completion the runner catches up to <= 4,096", async () => {
  // The same simulated day as G-BOUNDED: 1,440 notebook appends (one a minute) and 500 turns.
  const APPENDS = 1440, TURNS = 500;
  for (let i = 0; i < APPENDS; i++) {
    vi.setSystemTime(T0 + i * 60_000);
    importNotebook(8 + i);
    if (i % Math.ceil(APPENDS / TURNS) === 0) captureTurn(i);
    if (i % 10 === 9) database().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  }
  for (let n = 0; count("SELECT count(*) AS n FROM memory_sources WHERE id LIKE 'turn-source-%'") < TURNS; n++) captureTurn(APPENDS + n);
  const now = T0 + 8 * DAY + 1; vi.setSystemTime(now);
  // View A: a real ready context over the whole day (its watermark is the journal's newest row).
  reconcileMemoryRoster(viewRoster); prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster);
  // Build B: a second context (the not-owner audience of the same thread) started on the real async path and NOT awaited. Its first
  // step ran synchronously (startBuild + activeBuild): it is in flight, its snapshot is the journal's newest row now.
  const snapshotB = count("SELECT max(sequence) AS n FROM memory_recall_changes");
  const buildB = prepareRecallContext(FIXTURE_BOT, "thread-a", viewRoster, true);
  // Ten rows written while B is in flight: above both A's watermark and B's snapshot, so B holds the trim over a prefix of the journal.
  database().exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10) INSERT INTO memory_recall_changes(kind,object_id,version) SELECT 'record','owed-'||i,1 FROM n");
  const journal = journalIds(), newest = count("SELECT max(sequence) AS n FROM memory_recall_changes"), floorBefore = floor();
  expect([journal.length > 2 * RECALL_FLUSH_ROWS, count("SELECT count(*) AS n FROM memory_recall_views WHERE state='building'"), lowReady() >= snapshotB, newest - snapshotB],
    "a long day's journal, B in flight, A ready at or above B's snapshot, ten rows owed above it").toEqual([true, 1, true, 10]);

  // HELD: the runner (no awaits, so B stays in flight throughout) reaches M3 and backs off instead of trimming under the build: the M3
  // batch rolls back as no progress (stalled), its marker is not done, not one journal row is deleted and the floor does not move above
  // B's snapshot (B's fence would refuse its own publication).
  let held: ReturnType<typeof runMigrationSlice> | undefined;
  for (let slices = 0; slices < 10_000; slices++) { held = runMigrationSlice({ now }); if (held.stalled || !held.more) break; }
  expect.soft({ stalled: held?.stalled, m3Done: readMarker(database(), "M3")?.done === true, deleted: journal.length - count("SELECT count(*) AS n FROM memory_recall_changes"),
    journalSame: journalIds().join(" ") === journal.join(" "), floorAtOrBelowB: floor() <= snapshotB, floorMoved: floor() !== floorBefore }, "held by build B")
    .toEqual({ stalled: "M3", m3Done: false, deleted: 0, journalSame: true, floorAtOrBelowB: true, floorMoved: false });

  // CATCH-UP: B completes on its own path and publishes a ready view at its snapshot; the next runner pass (the stall back-off's re-run)
  // trims the journal to the no-build bound, keeps the newest row and every row above the lowest ready watermark (the ten owed rows
  // exactly), leaves the floor at or below B's watermark, and B stays a valid ready view (its context is served without a new build).
  await buildB;
  const viewsAfterB = count("SELECT count(*) AS n FROM memory_recall_views WHERE state='ready'"), low = lowReady();
  for (let slices = 0; slices < 10_000; slices++) if (!runMigrationSlice({ now }).more) break;
  const journalAfter = count("SELECT count(*) AS n FROM memory_recall_changes");
  console.log(`GATE-MEASURE G-BOUNDED held-build memory_recall_changes ${journal.length} -> held ${journal.length} -> caught-up ${journalAfter} bound=${RECALL_FLUSH_ROWS}`);
  prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster, true);
  expect({ m3Done: readMarker(database(), "M3")?.done === true, bounded: journalAfter <= RECALL_FLUSH_ROWS,
    newestKept: count("SELECT count(*) AS n FROM memory_recall_changes WHERE sequence=?", newest),
    // (the rows above it before the pass, exactly and first; M5's own job-delete rows come after them)
    owedKept: (above => journalIds().filter(id => Number(id.split(":")[0]) > low).slice(0, above.length).join(" ") === above.join(" "))(journal.filter(id => Number(id.split(":")[0]) > low)),
    floorAtOrBelowLow: floor() <= low, readyViews: [viewsAfterB, count("SELECT count(*) AS n FROM memory_recall_views WHERE state='ready'")] },
  `caught up after build B: journal ${journal.length} -> ${journalAfter}`)
    .toEqual({ m3Done: true, bounded: true, newestKept: 1, owedKept: true, floorAtOrBelowLow: true, readyViews: [2, 2] });
}, 1_200_000);

it("G-BOUNDED (journal, no build): with no build in flight the runner trims the day's journal to <= 4,096, newest kept, no unapplied row lost", () => {
  // The no-build cell of R-bounded on the same day (retention-v2.test.ts G-BOUNDED asserts it next to the jobs bound; this copy imports
  // only what the runner exported before M3 was registered, so its base run reaches this assertion: ASTRA 15d82fb800 base RED).
  const APPENDS = 1440, TURNS = 500;
  for (let i = 0; i < APPENDS; i++) {
    vi.setSystemTime(T0 + i * 60_000);
    importNotebook(8 + i);
    if (i % Math.ceil(APPENDS / TURNS) === 0) captureTurn(i);
    if (i % 10 === 9) database().prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  }
  for (let n = 0; count("SELECT count(*) AS n FROM memory_sources WHERE id LIKE 'turn-source-%'") < TURNS; n++) captureTurn(APPENDS + n);
  const now = T0 + 8 * DAY + 1; vi.setSystemTime(now);
  reconcileMemoryRoster(viewRoster); prepareRecallContextSync(FIXTURE_BOT, "thread-a", viewRoster);
  database().exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10) INSERT INTO memory_recall_changes(kind,object_id,version) SELECT 'record','unapplied-'||i,1 FROM n");
  const journal = journalIds(), newest = count("SELECT max(sequence) AS n FROM memory_recall_changes"), low = lowReady();
  const above = journal.filter(id => Number(id.split(":")[0]) > low);
  expect([journal.length > 2 * RECALL_FLUSH_ROWS, count("SELECT count(*) AS n FROM memory_recall_views WHERE state='building'"), above.length],
    "a long day's journal, no build in flight, ten rows above the ready watermark").toEqual([true, 0, 10]);
  for (let slices = 0; slices < 10_000; slices++) if (!runMigrationSlice({ now }).more) break;
  const journalAfter = count("SELECT count(*) AS n FROM memory_recall_changes");
  console.log(`GATE-MEASURE G-BOUNDED no-build memory_recall_changes ${journal.length} -> ${journalAfter} bound=${RECALL_FLUSH_ROWS}`);
  // A1, the row's own assertion: the bound (on 14ff784487 the runner runs to rest without M3 and the journal stays as it was)
  expect(journalAfter, `no build: journal ${journal.length} -> ${journalAfter} (bound ${RECALL_FLUSH_ROWS})`).toBeLessThanOrEqual(RECALL_FLUSH_ROWS);
  expect({ m3Done: readMarker(database(), "M3")?.done === true, bounded: journalAfter <= RECALL_FLUSH_ROWS,
    newestKept: count("SELECT count(*) AS n FROM memory_recall_changes WHERE sequence=?", newest),
    unappliedKept: journalIds().filter(id => Number(id.split(":")[0]) > low).slice(0, above.length).join(" ") === above.join(" "),
    floorAtOrBelowLow: floor() <= low }, `no build: journal ${journal.length} -> ${journalAfter}`)
    .toEqual({ m3Done: true, bounded: true, newestKept: 1, unappliedKept: true, floorAtOrBelowLow: true });
}, 1_200_000);
