// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fixg-qi. Consumers: recall-prod-x (recovery/status), MAIN (integration).
import { beforeEach, expect, it, vi } from 'vitest';
import { database } from '../database.ts';
import { captureSource } from './capture.ts';
import { materializeRecentMemory } from './recent.ts';
import { authorityParts } from './authority-epoch.ts';
import * as checkpoints from './consolidate.ts';
import { accessFor, freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { WritetimeFixture } from './testing/writetime-fixture.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';

beforeEach(() => { freshDataDir('active'); new WritetimeFixture(database()).cert(true).ready(THREAD, true); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function pending() {
  const db = database(), text = 'The fixture gate is green.';
  storeAnchorMessage(db, THREAD, 'message', text);
  captureSource(db, { id: 'fixture-source', threadId: THREAD, messageId: 'message', kind: 'text', speaker: 'owner', outcome: 'recorded', text });
  return accessFor().access;
}
const debt = () => database().prepare("SELECT * FROM memory_scope_bindings WHERE subject_type='system' AND subject_id='checkpoint-pending'").all();

it('recent capture does not announce checkpoint completion on a deferred checkpoint', async () => {
  const access = pending(), done = vi.fn();
  const refresh = vi.spyOn(checkpoints, 'refreshMemoryCheckpoint').mockReturnValue({ status: 'deferred', reason: 'evidence-checking' });
  try { expect(materializeRecentMemory(access, undefined, done)).toBe(1); await tick(); }
  finally { refresh.mockRestore(); }
  expect(done).not.toHaveBeenCalled();
  expect(debt()).toHaveLength(1);
  expect(database().prepare('SELECT status FROM memory_jobs').get()?.status).toBe('complete');
});

it('recent checkpoint failure preserves debt and never schedules a success callback', async () => {
  const access = pending(), done = vi.fn();
  const refresh = vi.spyOn(checkpoints, 'refreshMemoryCheckpoint').mockImplementation(() => { throw Error('fixture checkpoint failed'); });
  try { expect(() => materializeRecentMemory(access, undefined, done)).toThrow('fixture checkpoint failed'); await tick(); }
  finally { refresh.mockRestore(); }
  expect(done).not.toHaveBeenCalled();
  expect(debt()).toHaveLength(1);
});

it('recent success acknowledges the exact publication after its debt is consumed', async () => {
  const access = pending(), done = vi.fn(() => {
    expect(debt()).toHaveLength(0);
    expect(database().prepare('SELECT * FROM memory_checkpoint_publications').all()).toHaveLength(1);
  });
  const before = authorityParts()!.hard;
  expect(materializeRecentMemory(access, undefined, done)).toBe(1);
  await tick();
  const job = database().prepare('SELECT id FROM memory_jobs').get()!;
  expect(done).toHaveBeenCalledExactlyOnceWith(job.id);
  expect(authorityParts()!.hard).toBe(before);
  database().prepare("INSERT INTO memory_scope_bindings VALUES('fixture-person',?,'person','fixture-person',0,'granted','{}')").run(database().prepare('SELECT id FROM memory_scopes LIMIT 1').get()!.id);
  expect(authorityParts()!.hard).not.toBe(before);
});
