// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: recallcap-1020-n5b (bounded view for big threads, MAIN 1.0.20 ruling: the 512 MiB quota stays; the view is bounded instead).
// A thread whose word index alone would take most of the quota (the owner copy: one view P = 436 MB of 512 MiB) gets a view that holds the words of
// its newest records within RECALL_VIEW_TERM_BUDGET. Older records keep their record rows, so paged recall still reaches them, and a word search
// on the view says it is bounded.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { OWNER } from '../human-principals.ts';
import { RecallPreparationPending } from './recall-recovery.ts';

// The ruled budget, written out so a tree without the bound fails on bytes, not on a missing name.
const TERM_BUDGET = 64 * 1024 * 1024;

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { (await import('./recall-view.ts')).stopRecallViewMaintenance(); closeDatabase(); });

it('W-BOUND a big thread view stays within the term budget: newest words indexed, oldest records pageable, search says bounded', async () => {
  const views = await import('./recall-view.ts'), index = await import('./recall-view-index.ts');
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active');
  const db = database(), scope = ensureScope('conversation', 'direct');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)");
  // 4000 records of 48 distinct words: about 4000*48*560 = 107 MB of word rows unbounded, well past the 64 MiB budget.
  const RECORDS = 4000, words = (n: number) => Array.from({ length: 48 }, (_, k) => `w${n}q${k}`).join(' ');
  db.exec('SAVEPOINT fixture_records');
  for (let n = 0; n < RECORDS; n++) put.run(`record-${String(n).padStart(6, '0')}`, scope, n === 0 ? `oldestzephyr ${words(n)}` : n === RECORDS - 1 ? `newestzephyr ${words(n)}` : words(n));
  db.exec('RELEASE fixture_records');
  const projected = views.projectedRecallViewBytes(db, [scope], 0);
  expect(projected).toBeLessThanOrEqual(512 * (1 + RECORDS) + TERM_BUDGET);
  await views.prepareRecallContext('reader', 'direct', roster); views.stopRecallViewMaintenance();
  const registry = new InternalCapabilities(); registry.begin('reader', 'direct', 'generation');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'generation', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const termRows = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms WHERE view_id=? AND generation=?').get(access.view.viewId, access.view.generation)!.n);
  const recordRows = Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_records WHERE view_id=? AND generation=?').get(access.view.viewId, access.view.generation)!.n);
  const stored = Number(db.prepare('SELECT bytes FROM memory_recall_storage WHERE id=1').get()!.bytes);
  console.log('W-BOUND', JSON.stringify({ projected, termRows, recordRows, stored }));
  // The view is bounded: stored bytes stay within the term budget plus the record rows (not the ~107 MB an unbounded index takes).
  expect(stored).toBeLessThanOrEqual(TERM_BUDGET + 2048 * (RECORDS + 2));
  expect(termRows).toBeLessThan(RECORDS * 48);
  // Every record is still in the view: paged recall reaches the oldest.
  expect(recordRows).toBe(RECORDS);
  expect(index.eligibleViewPage(db, access.view, '', 1).map(ref => ref.id)).toEqual(['record-000000']);
  // Newest first: the newest record's words are indexed; the oldest one's are not, and the search says it read a bounded window.
  const newest = index.lexicalViewPage(db, 'newestzephyr', access.view, 20, 0, new index.RecallWorkBudget());
  expect(newest.hits.map(hit => hit.id)).toEqual([`record-${String(RECORDS - 1).padStart(6, '0')}`]);
  expect(newest.bounded).toBe(true);
  const oldest = index.lexicalViewPage(db, 'oldestzephyr', access.view, 20, 0, new index.RecallWorkBudget());
  expect(oldest.hits).toEqual([]);
  expect(oldest.bounded).toBe(true);
}, 180_000);

it('W-PACE a waiting reader\'s build is charged to the shared reclaim bucket: with the bucket spent and no refill it waits, then finishes once time refills it', async () => {
  const views = await import('./recall-view.ts');
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active'); views.stopRecallViewMaintenance();
  const db = database(), scope = ensureScope('conversation', 'direct');
  db.prepare("INSERT INTO memory_records VALUES('only',1,?,'constraint','zephyr fixture memory','owner-statement','active',0,1,NULL,NULL,1)").run(scope);
  // Every meter read reports 200 MB more written (the owner copy's recall-build minute was 798 MB); time stands still, so the bucket never refills.
  let now = Date.now(), frozen = true, written = 0;
  views.setRecallReclaimClockForTest({ now: () => (frozen ? now : (now += 60_000)), written: () => (written += 200_000_000) });
  const ready = () => Number(db.prepare("SELECT count(*) AS n FROM memory_recall_contexts c JOIN memory_recall_views v USING(view_id,generation) WHERE v.state='ready'").get()!.n);
  try {
    expect(() => views.resolveRecallView({ botId: 'reader', threadId: 'direct', humanPrincipal: OWNER, notOwnerAudience: false }, roster)).toThrow(RecallPreparationPending);
    await new Promise(resolve => setTimeout(resolve, 1500));
    // Unpaced, the build publishes within a few immediates; charged, its first 200 MB slice spends the bucket and it waits.
    expect(ready()).toBe(0);
    frozen = false;
    await views.waitForRecallConstructionIdleForTest(roster);
    expect(ready()).toBe(1);
  } finally { views.setRecallReclaimClockForTest(); }
}, 60_000);
