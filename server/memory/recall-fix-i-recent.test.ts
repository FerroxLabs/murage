// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-i (recent capture). Consumer owner: recall-prod-x (derived work); MAIN integrates.
import { setImmediate } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database } from '../database.ts';
import { captureSource } from './capture.ts';
import * as checkpoint from './consolidate.ts';
import { materializeRecentMemory } from './recent.ts';
import { accessFor, freshDataDir, THREAD } from './testing/recall-fixture.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';

beforeEach(() => {
  freshDataDir('active');
  database().exec("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1");
  database().prepare('INSERT OR REPLACE INTO memory_lineage_thread_ready(thread_id,ready) VALUES(?,1)').run(THREAD);
});
afterEach(() => vi.restoreAllMocks());

function pending() {
  const db = database(), text = 'The fixture gate is green.';
  storeAnchorMessage(db, THREAD, 'message', text);
  captureSource(db, { id: 'fixture-source', threadId: THREAD, messageId: 'message', kind: 'text', speaker: 'owner', outcome: 'recorded', text });
  return accessFor();
}

it('notifies derived work only after an exact checkpoint receipt has committed', async () => {
  const { access } = pending(), completed = vi.fn((id: string) => {
    expect(database().prepare('SELECT job_id FROM memory_checkpoint_publications WHERE job_id=?').get(id)).toBeDefined();
  });
  expect(materializeRecentMemory(access, undefined, completed)).toBe(1);
  expect(completed).not.toHaveBeenCalled();
  await setImmediate();
  expect(completed).toHaveBeenCalledTimes(1);
});

it('evidence still being checked does not notify checkpoint completion', async () => {
  const { access } = pending(), completed = vi.fn();
  vi.spyOn(checkpoint, 'refreshMemoryCheckpoint').mockReturnValue({ status: 'deferred', reason: 'evidence-checking' });
  expect(materializeRecentMemory(access, undefined, completed)).toBe(1);
  await setImmediate();
  expect(completed).not.toHaveBeenCalled();
});

it('checkpoint failure leaves no queued completion callback', async () => {
  const { access } = pending(), completed = vi.fn();
  vi.spyOn(checkpoint, 'refreshMemoryCheckpoint').mockImplementation(() => { throw Error('fixture checkpoint failed'); });
  expect(() => materializeRecentMemory(access, undefined, completed)).toThrow('fixture checkpoint failed');
  await setImmediate();
  expect(completed).not.toHaveBeenCalled();
});
