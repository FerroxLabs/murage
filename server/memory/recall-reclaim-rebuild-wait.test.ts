// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// RECLAIM-WAIT (owners: in-place reclamation at the view cap = fix/1019-salvrow-recall-prod-z (recall-view.ts collectRecallViewSlice);
// the rebuild's own view wait = fix/1019-ma-rebuild (RecallReadiness rebuildAccess); this witness = fix/1019-nc-ma-integ).
// Both designs stay: a waiting build at the cap reclaims an idle context's view in place, and each rebuild waits for its own view. A view
// reclaimed between its publication and the waiting rebuild's wake is never handed to that rebuild: the wake only wakes, the read is fresh.
// A view the rebuild was handed and holds is never reclaimed by a later waiting build.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { threadHumanPrincipal } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { RecallReadiness } from './recall-readiness.ts';
import * as views from './recall-view.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { views.stopRecallViewMaintenance(); closeDatabase(); });

it('RECLAIM-WAIT a view reclaimed before the waiting rebuild wakes is never handed to it, and the view it holds is never reclaimed', async () => {
  // 129 contexts, cap 128: 127 held by live readers, X (the rebuild's own) and Y (a later waiting build that must reclaim at the cap)
  const others = ['direct', ...Array.from({ length: 126 }, (_, n) => `held-${n}`)];
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct',
    tasks: [...others.slice(1), 'rebuild-x', 'waiting-y'].map(threadId => ({ threadId })) }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), bind = (threadId: string) => ({ botId: 'reader', threadId, humanPrincipal: threadHumanPrincipal(threadId), notOwnerAudience: false });
  const viewOf = (threadId: string) => db.prepare('SELECT view_id AS v FROM memory_recall_contexts WHERE context_key=?').get(views.recallContextKey(bind(threadId)))?.v as string | undefined;
  const viewRow = (viewId: string) => db.prepare('SELECT 1 FROM memory_recall_views WHERE view_id=?').get(viewId);
  const viewCount = () => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
  views.startRecallViewMaintenance();
  const releases: (() => void)[] = [];
  try {
    for (const thread of others) {
      views.prepareRecallContextSync('reader', thread, roster);
      releases.push(views.retainRecallView(views.resolveRecallView(bind(thread), roster).handle, bind(thread), () => true));
    }
    // the rebuild of X waits for its own view (no context yet: its first read queues the build and waits for a publication)
    const handed: string[] = [];
    const rebuild = new RecallReadiness().access(() => { const held = views.resolveRecallView(bind('rebuild-x'), roster); handed.push(held.handle.viewId); return held; },
      new AbortController().signal, undefined, { rebuild: true, publications: views.subscribeRecallViewPublication });
    views.prepareRecallContextSync('reader', 'rebuild-x', roster);
    const first = viewOf('rebuild-x')!;
    expect(first, 'X was published at the cap').toBeTruthy();
    expect(viewCount()).toBe(128);
    // before the publication wakes the rebuild, a waiting build of Y at the cap reclaims the only idle context: X
    views.prepareRecallContextSync('reader', 'waiting-y', roster);
    expect(viewOf('rebuild-x'), 'reclamation took X in place').toBeUndefined();
    expect(viewRow(first), 'the reclaimed view is gone').toBeUndefined();
    expect(viewCount()).toBeLessThanOrEqual(128);
    const got = await rebuild;
    expect(handed, 'the reclaimed view is never handed to the rebuild still waiting on it').not.toContain(first);
    expect(got.handle.viewId).not.toBe(first);
    expect(() => views.assertRecallView(db, got.handle, bind('rebuild-x')), 'the rebuild holds a live, current view of its own context').not.toThrow();
    // the handed view is held: with every view at the cap held, a later waiting build refuses rather than reclaim one (Y's own idle view went
    // to X's rebuild); once another reader lets go, that one is reclaimed, never the rebuild's
    releases.push(views.retainRecallView(got.handle, bind('rebuild-x'), () => true));
    expect(viewOf('waiting-y'), "X's rebuild reclaimed the idle Y in place").toBeUndefined();
    expect(() => views.prepareRecallContextSync('reader', 'waiting-y', roster)).toThrow('MEMORY_RECALL_STORAGE_LIMIT');
    expect(viewRow(got.handle.viewId), 'the held view is never reclaimed').toBeTruthy();
    const freed = viewOf('direct')!;
    releases.shift()!();
    views.prepareRecallContextSync('reader', 'waiting-y', roster);
    expect(viewOf('waiting-y'), 'Y built in the slot of the released reader').toBeTruthy();
    expect(viewRow(freed), 'the released reader\'s idle view was the one reclaimed').toBeUndefined();
    expect(viewOf('rebuild-x'), 'the held view stays the context of X').toBe(got.handle.viewId);
    expect(viewRow(got.handle.viewId), 'the held view is never reclaimed').toBeTruthy();
    expect(viewCount()).toBeLessThanOrEqual(128);
  } finally { for (const release of releases) release(); }
}, 20000);
