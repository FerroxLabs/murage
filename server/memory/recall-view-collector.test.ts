// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (view reclamation throughput); consumer owner: r12fix-s3b (roster churn witness).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { threadHumanPrincipal } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import * as views from './recall-view.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { views.stopRecallViewMaintenance(); vi.useRealTimers(); closeDatabase(); });

// MAIN RULING 1117T01:23Z (b): roster churn rebuilds every context. Over four full rebuilds of 41 contexts (164 builds, more than the
// 128-view cap) with four builds between maintenance ticks, the collector keeps up: no build hits the cap, which stays 128.
it('roster churn past 128 view builds never reaches the storage cap', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const threads = ['direct', ...Array.from({ length: 40 }, (_, n) => `churn-${n}`)];
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), count = () => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  views.startRecallViewMaintenance();
  let builds = 0, peak = 0;
  for (let round = 0; round < 4; round++) {
    roster.memoryRosterRevision!++;
    reconcileMemoryRoster(roster);
    for (const thread of threads) {
      views.prepareRecallContextSync('reader', thread, roster);
      builds++; peak = Math.max(peak, count());
      if (builds % 4 === 0) vi.advanceTimersByTime(50);
    }
  }
  expect(builds).toBeGreaterThan(128);
  expect(peak).toBeLessThan(128);
  expect(Number(db.prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n)).toBe(threads.length);
});

// Review H1 (arev-r12fix-s3b6): more than 128 contexts demanded in one roster. Every context needs a view, so at the 128 cap a waiting build
// must reclaim an idle context's slot on the spot (never raising the cap) instead of failing and leaving the demand to a later tick.
it('a roster with more than 128 contexts builds every demanded context without hitting the storage cap', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const threads = ['direct', ...Array.from({ length: 139 }, (_, n) => `wide-${n}`)];
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: threads.slice(1).map(threadId => ({ threadId })) }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), count = () => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  views.startRecallViewMaintenance();
  let peak = 0;
  for (let round = 0; round < 2; round++) {
    roster.memoryRosterRevision!++;
    reconcileMemoryRoster(roster);
    for (const thread of threads) {
      expect(() => views.prepareRecallContextSync('reader', thread, roster)).not.toThrow();
      peak = Math.max(peak, count());
      expect(db.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(views.recallContextKey({ botId: 'reader', threadId: thread, humanPrincipal: threadHumanPrincipal(thread), notOwnerAudience: false }))).toBeTruthy();
    }
  }
  expect(threads.length).toBeGreaterThan(128);
  expect(peak).toBeLessThanOrEqual(128);
});

// Review H1 (arev-salvrow-r12fix-s3b-r12fix-s3b2): at the cap the idle victim can hold more rows than one bounded batch frees
// (here 17,000 term rows, more than 64 slices of 256). The deferred build must keep the eviction and the rows it already freed, so
// the next waiting build finishes the reclamation. No maintenance tick runs in this test: progress comes from the waiting builds alone.
it('a waiting build at the cap keeps its reclamation progress when the idle victim is larger than one batch', () => {
  const threads = ['direct', ...Array.from({ length: 127 }, (_, n) => `full-${n}`)];
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct', tasks: [...threads.slice(1), 'late'].map(threadId => ({ threadId })) }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), count = () => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  const key = (thread: string) => views.recallContextKey({ botId: 'reader', threadId: thread, humanPrincipal: threadHumanPrincipal(thread), notOwnerAudience: false });
  for (const thread of threads) views.prepareRecallContextSync('reader', thread, roster);
  expect(count()).toBe(128);
  const victim = db.prepare('SELECT view_id,generation FROM memory_recall_contexts WHERE context_key=?').get(key('direct'))!;
  const add = db.prepare('INSERT INTO memory_recall_view_terms VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN');
  for (let n = 0; n < 17_000; n++) add.run(victim.view_id, victim.generation, `term-${n}`, n, 'record', 1);
  db.exec('COMMIT');
  const left = () => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms WHERE view_id=? AND generation=?').get(victim.view_id, victim.generation)!.n);
  const errors: string[] = [], remaining: number[] = [];
  let built = false;
  for (let attempt = 0; attempt < 4 && !built; attempt++) {
    try { views.prepareRecallContextSync('reader', 'late', roster); built = true; }
    catch (error) { errors.push((error as Error).message); remaining.push(left()); }
  }
  // One deferral is allowed (the victim outsizes a batch); it must be the cap code, and it must have freed a full batch for good.
  expect(errors).toEqual(['MEMORY_RECALL_STORAGE_LIMIT']);
  expect(remaining).toHaveLength(1);
  expect(remaining[0]).toBeGreaterThan(0);
  expect(remaining[0]).toBeLessThanOrEqual(17_000 - 60 * 256);
  expect(built).toBe(true);
  expect(left()).toBe(0);
  expect(count()).toBeLessThanOrEqual(128);
  expect(db.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(key('late'))).toBeTruthy();
  expect(db.prepare('SELECT 1 FROM memory_recall_contexts WHERE context_key=?').get(key('direct'))).toBeUndefined();
});
