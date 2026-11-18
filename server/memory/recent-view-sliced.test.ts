// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope. Consumer owner: salv-tri-b.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { ensureScope, memoryAccess, reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { prepareRecallContext, stopRecallViewMaintenance } from './recall-view.ts';
import { RecallWorkBudget } from './recall-view-index.ts';
import { recentMemoryHits, recentMemoryHitsSliced, RECENT_VIEW_SLICE } from './recent.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });
async function fixture() {
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots: [{ id: 'reader', threadId: 'direct' }], groups: [] };
  reconcileMemoryRoster(roster);
  const db = database(), scope = ensureScope('bot', 'reader'), foreign = ensureScope('bot', 'other');
  const insert = db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint','zephyr fixture','owner-statement','active',0,1,NULL,NULL,1)");
  for (let n = 0; n < RECENT_VIEW_SLICE + 1; n++) insert.run(`fixture-${n}`, scope);
  insert.run('foreign', foreign);
  await prepareRecallContext('reader', 'direct', roster); stopRecallViewMaintenance();
  const registry = new InternalCapabilities(), generation = registry.begin('reader', 'direct');
  const token = registry.mint({ botId: 'reader', threadId: 'direct', generation, depth: 0, kind: 'memory', skillAuthoring: false });
  const access = memoryAccess(registry, registry.resolve(`Bearer ${token}`)!, () => roster);
  return { access, registry };
}
it('slices the same admitted candidates without enumerating legacy scopes or admitting foreign references', async () => {
  const { access } = await fixture(), expected = recentMemoryHits('zephyr', access);
  const scopes = access.scopeIds;
  const slice = Array.prototype[Symbol.iterator];
  Array.prototype[Symbol.iterator] = function<T>(this: T[]) {
    if (this === scopes) throw new Error('legacy scope enumeration');
    return slice.call(this) as ArrayIterator<T>;
  };
  try {
    const result = await recentMemoryHitsSliced('zephyr', access, { deadlineAt: performance.now() + 5000 });
    expect(result.complete).toBe(true);
    expect(result.hits).toEqual(expected);
    expect(result.hits).toHaveLength(RECENT_VIEW_SLICE + 1);
    expect(result.hits.some(hit => hit.id === 'foreign')).toBe(false);
  } finally { Array.prototype[Symbol.iterator] = slice; }
});
it('uses the supplied candidate and byte allowance and marks exhaustion incomplete', async () => {
  const { access } = await fixture(), workBudget = new RecallWorkBudget(1);
  const result = await recentMemoryHitsSliced('zephyr', access, { workBudget, deadlineAt: performance.now() + 5000 });
  expect(result.complete).toBe(false);
  expect(result.hits).toHaveLength(1);
  expect(workBudget.raw).toBe(1);
  expect(workBudget.bytes).toBe(Buffer.byteLength('zephyr fixture'));
});
it('does no candidate work after its monotonic deadline', async () => {
  const { access } = await fixture(), workBudget = new RecallWorkBudget();
  expect(await recentMemoryHitsSliced('zephyr', access, { workBudget, deadlineAt: performance.now() - 1 })).toEqual({ hits: [], complete: false });
  expect(workBudget.raw).toBe(0);
});
it('refuses all previously collected candidates when authority is revoked between pages', async () => {
  const { access } = await fixture(), workBudget = new RecallWorkBudget();
  const revoke = new Promise<void>(resolve => setImmediate(() => {
    database().exec("UPDATE memory_scope_bindings SET state='pending' WHERE id='memory-roster-policy'"); resolve();
  }));
  await expect(recentMemoryHitsSliced('zephyr', access, { workBudget, deadlineAt: performance.now() + 5000 })).rejects.toThrow();
  await revoke;
  expect(workBudget.raw).toBe(RECENT_VIEW_SLICE);
});
it('honors cancellation between reference pages', async () => {
  const { access } = await fixture(), controller = new AbortController(), workBudget = new RecallWorkBudget();
  setImmediate(() => controller.abort(new Error('fixture cancelled')));
  await expect(recentMemoryHitsSliced('zephyr', access, { workBudget, signal: controller.signal, deadlineAt: performance.now() + 5000 })).rejects.toThrow('fixture cancelled');
  expect(workBudget.raw).toBe(RECENT_VIEW_SLICE);
});
