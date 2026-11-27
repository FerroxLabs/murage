// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner of these witnesses and the reclaim meter/debt fix: reclaim-1020-n5. Owner of the reclaimer and its bucket: recallcap-1020-n3c.
// Owner of the recall-reclaim admission class (server/io-budget.ts): recallcap-1020-n3c. Publication and authority fences: recall-scope.
// FINAL6 storm (23:11Z): io-budget reported 9457.9 MB/min for recall-reclaim while the OS counted 991 MB. These witnesses read the same
// meter io-budget reports (ioBudget.pendingBytes('recall-reclaim')) and hold every 60 s window under 1000 MB.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { threadHumanPrincipal } from '../human-principals.ts';
import * as io from '../io-budget.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import * as views from './recall-view.ts';

type Row = Record<string, SQLInputValue>;
const MB = 1_000_000;
beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { views.stopRecallViewMaintenance(); views.setRecallReclaimClockForTest(); vi.restoreAllMocks(); closeDatabase(); });

function seed(): { db: DatabaseSync; source: Row } {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'main', tasks: [] }], groups: [] };
  reconcileMemoryRoster(roster);
  views.prepareRecallContextSync('reader', 'main', roster);
  const db = database();
  const binding = { botId: 'reader', threadId: 'main', humanPrincipal: threadHumanPrincipal('main'), notOwnerAudience: false };
  return { db, source: db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(views.recallContextKey(binding)) as Row };
}
/** A crash leftover (class A: always reclaimed) holding `n` term rows and `n` job rows, so its reclaim covers the terms and view_jobs phases. */
function leftover(db: DatabaseSync, source: Row, n: number): void {
  const view = { view_id: randomUUID(), generation: randomUUID() };
  db.prepare(`INSERT INTO memory_recall_views SELECT ?,?,authority_epoch,roster_revision,'building',scope_count,digest,room_reader,watermark FROM memory_recall_views WHERE view_id=? AND generation=?`)
    .run(view.view_id, view.generation, source.view_id, source.generation);
  const term = db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)'), job = db.prepare('INSERT INTO memory_recall_view_jobs VALUES(?,?,?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) { term.run(view.view_id, view.generation, `t${i}`, i, `r-${i}`, 1); job.run(view.view_id, view.generation, i, `j-${view.view_id}-${i}`); }
  db.exec('COMMIT');
}
const noted = () => io.ioBudget.pendingBytes(io.RECALL_RECLAIM_SOURCE);
/** Largest metered recall-reclaim bytes inside any 60 s window of the samples (time, cumulative bytes). */
function worstMinute(samples: Array<[number, number]>): number {
  let worst = 0;
  for (let i = 0; i < samples.length; i++) for (let j = i; j < samples.length && samples[j]![0] - samples[i]![0] <= 60_000; j++) worst = Math.max(worst, samples[j]![1] - samples[i]![1]);
  return worst;
}

it('W-N5-METER: a reading with an unknown OS count never charges the gap between the lifetime OS and VFS counters (FINAL6 23:11Z)', () => {
  const { db, source } = seed();
  for (let n = 0; n < 6; n++) leftover(db, source, 3000);
  // The owner Mac: lifetime OS bytes 60 GB, VFS meter 12 GB; each reading the process really wrote 1 MB more. Every third reading the
  // engine-exclusion helper's diskWritten could not be read (osKnown false, fsWriteBlocks 0), as the 23:11Z minute had.
  let calls = 0, real = 0;
  const read = () => {
    calls++; real += MB;
    const unknown = calls % 3 === 0;
    return { at: Date.now(), cpuMicros: 0, fsWriteBlocks: unknown ? 0 : (60_000 * MB + real) / io.BLOCK_BYTES, meterBytes: 12_000 * MB + real, ...(unknown ? { osKnown: false } : {}) };
  };
  // A clock one second further on each step; the written meter is the production processClock's (recallReclaimWrittenMeter over readProcess),
  // fed this reading sequence in readProcess's shape.
  let now = Date.now();
  views.setRecallReclaimClockForTest({ now: () => (now += 1000), written: views.recallReclaimWrittenMeter(read) });
  const before = noted();
  for (let n = 0; n < 200 && views.recallReclaimStep(db); n++) { /* drain */ }
  const charged = noted() - before;
  expect(calls).toBeGreaterThan(10);
  // Charged at most what the process really wrote across the run (1 MB per reading), never the 48 GB gap.
  expect(charged).toBeLessThanOrEqual(real);
  expect(charged).toBeLessThan(1000 * MB);
  expect(Number(db.prepare("SELECT count(*) AS n FROM memory_recall_views WHERE state='building'").get()!.n)).toBe(0);
});

it('W-N5-DEBT: slices dearer than the burst room (terms and view_jobs phases) stay under 1000 MB in every 60 s window', () => {
  const { db, source } = seed();
  for (let n = 0; n < 40; n++) leftover(db, source, 4000);
  // Every slice really writes 300 MB (a heavy terms/records slice on a big store). The old one-room debt floor forgave all but 58 MB of each,
  // so about six ran a minute (1.8 GB) whatever they wrote.
  let now = Date.now(), written = 0;
  views.setRecallReclaimClockForTest({ now: () => (now += 1000), written: () => (written += 300 * MB) });
  const samples: Array<[number, number]> = [[now, noted()]];
  for (let n = 0; n < 600 && now - samples[0]![0] < 5 * 60_000; n++) { if (!views.recallReclaimStep(db)) break; samples.push([now, noted()]); }
  const total = samples[samples.length - 1]![1] - samples[0]![1];
  expect(total).toBeGreaterThan(1500 * MB); // the run really spans several minutes of heavy slices
  expect(worstMinute(samples)).toBeLessThan(1000 * MB);
});

it('W-N5-REBUILD: a forced full rebuild over 200k jobs is paced in every phase under 1000 MB a minute and search still answers', async () => {
  const { db, source } = seed();
  // 200k jobs in the reader's own scope, so the jobs phase really projects (and writes view_jobs rows for) every one of them.
  const scope = String((db.prepare('SELECT scope_id FROM memory_recall_view_scopes WHERE view_id=? AND generation=? AND lineage_only=0 LIMIT 1').get(source.view_id, source.generation) as Row).scope_id);
  db.exec('PRAGMA foreign_keys=OFF');
  db.prepare("INSERT INTO memory_sources(id,scope_id,thread_id,message_id,revision,content_hash,kind,speaker,outcome,state) VALUES('n5-src',?,'main','m0',1,'h','text','owner','recorded','active')").run(scope);
  db.exec(`WITH RECURSIVE c(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM c WHERE i<199999)
    INSERT INTO memory_jobs(id,source_id,source_revision,stage,stage_version,status,policy_revision,deletion_epoch) SELECT 'job-'||i,'n5-src',1,'s'||i,'v1','complete',1,0 FROM c`);
  db.exec('PRAGMA foreign_keys=ON');
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_jobs').get()!.n)).toBeGreaterThanOrEqual(200_000);
  // Forced full rebuild: the published view is withdrawn (as a fence move leaves it), so nothing can be adopted and every phase runs.
  db.prepare('DELETE FROM memory_recall_contexts WHERE view_id=? AND generation=?').run(source.view_id, source.generation);
  db.prepare("UPDATE memory_recall_views SET state='building' WHERE view_id=? AND generation=?").run(source.view_id, source.generation);
  // Each slice of every phase (oracle, scopes, records, jobs, changes) really writes 200 MB, dearer than the 58 MB burst room: 782 jobs slices
  // alone are 156 GB, so only the shared bucket's carried debt keeps a minute under 1000 MB (the old floor let ~6 a minute through, 1.2 GB).
  let now = Date.now(), written = 0;
  const samples: Array<[number, number]> = [];
  views.setRecallReclaimClockForTest({ now: () => (now += 250), written: () => (written += 200 * MB) });
  const roster: MemoryRoster = { memoryRosterRevision: 2, bots: [{ id: 'reader', threadId: 'main', tasks: [] }], groups: [] };
  reconcileMemoryRoster(roster);
  samples.push([now, noted()]);
  const done = views.prepareRecallContext('reader', 'main', roster);
  let finished = false; void done.then(() => { finished = true; }, () => { finished = true; });
  while (!finished) { await new Promise<void>(resolve => setImmediate(resolve)); samples.push([now, noted()]); }
  await done;
  expect(worstMinute(samples)).toBeLessThan(1000 * MB);
  const built = db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(views.recallContextKey({ botId: 'reader', threadId: 'main', humanPrincipal: threadHumanPrincipal('main'), notOwnerAudience: false })) as Row;
  // The rebuild really walked the history: every job is in the new view, and the run spanned many paced minutes.
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_jobs WHERE view_id=? AND generation=?').get(built.view_id, built.generation)!.n)).toBe(200_000);
  expect(samples[samples.length - 1]![1] - samples[0]![1]).toBeGreaterThan(100_000 * MB);
  const binding = { botId: 'reader', threadId: 'main', humanPrincipal: threadHumanPrincipal('main'), notOwnerAudience: false };
  expect(db.prepare("SELECT 1 FROM memory_recall_contexts c JOIN memory_recall_views v ON v.view_id=c.view_id AND v.generation=c.generation WHERE c.context_key=? AND v.state='ready'").get(views.recallContextKey(binding))).toBeTruthy();
}, 600_000);
