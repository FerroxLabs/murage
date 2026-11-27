// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: q1022-recallperf (item 3, MAIN 1.0.22 MUST-FIX). A view past RECALL_VIEW_TERM_BUDGET (64 MiB of word rows) wrote no terms for its
// older records, so a turn's word search never found older memory. The witness enters through searchMemory (the turn's recall search) on a
// view built by prepareRecallContext with the real budget: the oldest record carries no term rows and is still found by its word; a deleted
// older record is never found.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { searchMemory } from './search.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { RECALL_TEXT_LIMIT, RecallWorkBudget, lexicalViewPage } from './recall-view-index.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(async () => { (await import('./recall-view.ts')).stopRecallViewMaintenance(); closeDatabase(); });

const keywordOnly = { search: async () => ({ hits: [], vectorRows: 0, degradedReason: 'keyword-only' }) };

it('W-OLDTERMS a turn word search finds a record older than the 64 MiB term window; a deleted older record stays gone', async () => {
  const views = await import('./recall-view.ts');
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active');
  const db = database(), scope = ensureScope('conversation', 'direct');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)");
  // 4000 records of 48 distinct words: about 107 MB of word rows unbounded, well past the 64 MiB budget, so the oldest get none.
  const RECORDS = 4000, words = (n: number) => Array.from({ length: 48 }, (_, k) => `w${n}q${k}`).join(' ');
  db.exec('SAVEPOINT fixture_records');
  for (let n = 0; n < RECORDS; n++) put.run(`record-${String(n).padStart(6, '0')}`, scope, n === 0 ? `oldestzephyr ${words(n)}` : n === 1 ? `forgottenzephyr ${words(n)}` : words(n));
  db.exec('RELEASE fixture_records');
  await views.prepareRecallContext('reader', 'direct', roster); views.stopRecallViewMaintenance();
  const registry = new InternalCapabilities(); registry.begin('reader', 'direct', 'generation');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'generation', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const termRows = (id: string) => Number(db.prepare('SELECT count(*) AS n FROM memory_recall_view_terms WHERE view_id=? AND generation=? AND record_id=?').get(access.view.viewId, access.view.generation, id)!.n);
  // Setup facts (not the behaviour): the view is windowed and the two oldest records have no term rows.
  expect(termRows('record-000000')).toBe(0);
  expect(termRows('record-000001')).toBe(0);
  db.prepare("UPDATE memory_records SET state='deleted' WHERE id='record-000001'").run();
  const found = await searchMemory('oldestzephyr', access, keywordOnly, { allowance: LineageAllowance.tool(1_000_000_000) });
  const forgotten = await searchMemory('forgottenzephyr', access, keywordOnly, { allowance: LineageAllowance.tool(1_000_000_000) });
  console.log('W-OLDTERMS', JSON.stringify({ found: found.hits.map(hit => hit.id), coverage: found.coverageComplete, forgotten: forgotten.hits.map(hit => hit.id) }));
  expect({ found: found.hits.map(hit => hit.id), forgotten: forgotten.hits.map(hit => hit.id) }).toEqual({ found: ['record-000000'], forgotten: [] });
}, 180_000);

// W-OLDBOUND (OPUS 8cf662cc4b High, item 3): when the older-records text scan is cut by the request's budget, the word page says bounded;
// when it reads every older record, it does not. Entry: lexicalViewPage, the word page searchMemory reads (search.ts lexicalSource), over a
// real view built by prepareRecallContext, one row per cut site (recall-view-index.ts older.length===room; viewRecordText null). It is not
// driven through searchMemory's coverageComplete: on this view that answer is already partial from another path (MEMORY_RECALL_PARTIAL,
// logs ob-dbg), so a dropped bounded would not show there. The frame budget is the one a turn passes (bundle.ts workBudget: frameWork).
it('W-OLDBOUND the word page over older records says bounded exactly when the request budget cuts the scan', async () => {
  const views = await import('./recall-view.ts');
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster); setMemoryMode('active');
  const db = database(), scope = ensureScope('conversation', 'direct');
  const put = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',0,1,NULL,NULL,1)");
  const RECORDS = 4000, words = (n: number) => Array.from({ length: 48 }, (_, k) => `w${n}q${k}`).join(' ');
  db.exec('SAVEPOINT fixture_records');
  for (let n = 0; n < RECORDS; n++) put.run(`record-${String(n).padStart(6, '0')}`, scope, n === 0 ? `oldestzephyr ${words(n)}` : words(n));
  db.exec('RELEASE fixture_records');
  await views.prepareRecallContext('reader', 'direct', roster); views.stopRecallViewMaintenance();
  const registry = new InternalCapabilities(); registry.begin('reader', 'direct', 'generation');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation: 'generation', depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  const spentBytes = () => { const frame = new RecallWorkBudget(8192); frame.text(RECALL_TEXT_LIMIT - 2048); return frame.reserveCandidates(1024); };
  const rows: Array<[string, () => RecallWorkBudget, boolean]> = [
    ['uncut', () => new RecallWorkBudget(8192).reserveCandidates(1024), false],
    ['row cap', () => new RecallWorkBudget(600).reserveCandidates(300), true],
    ['byte cap', spentBytes, true],
  ];
  const seen: Record<string, { bounded: boolean; found: boolean }> = {};
  for (const [name, frame] of rows) {
    const page = lexicalViewPage(database(), 'oldestzephyr', access.view, 20, 0, frame(), true, false);
    seen[name] = { bounded: page.bounded, found: page.hits.some(hit => hit.id === 'record-000000') };
  }
  console.log('W-OLDBOUND', JSON.stringify(seen));
  expect(seen.uncut, 'uncut: every older record read, the oldest found, not bounded').toEqual({ bounded: false, found: true });
  for (const [name, , bounded] of rows) expect(seen[name]!.bounded, `${name}: bounded`).toBe(bounded);
}, 180_000);
