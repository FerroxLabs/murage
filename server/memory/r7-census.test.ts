import { sqlWork } from './testing/sql-work.ts';
// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
// Producer owner: recall-r7-a; consumer owner: MAIN (family and authoritative-pin controls).
import { beforeEach, expect, it } from 'vitest';
import { database } from '../database.ts';
import { buildMemoryBundle } from './bundle.ts';
import { captureSource } from './capture.ts';
import { captureWork } from './chunks.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { claimMemoryJob, publishMemoryWork } from './jobs.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { ensureScope, reconcileMemoryRoster } from './policy.ts';
import { storeAnchorMessage } from './testing/anchor-message.ts';
import { checkpointHead, checkpointSnapshot, assertCheckpointRetained } from './testing/checkpoint-head-fixture.ts';
import { accessFor, emptyBridge, freshDataDir, THREAD } from './testing/recall-fixture.ts';

beforeEach(() => freshDataDir('active'));
function publish(thread: string, message: string, text: string) {
  const db = database(); storeAnchorMessage(db, thread, message, text);
  captureSource(db, { id: `message:${thread}:${message}`, threadId: thread, messageId: message, kind: 'text', speaker: 'owner', outcome: 'recorded', text });
  const work = claimMemoryJob('fixture-worker')!;
  expect(work).toBeTruthy(); publishMemoryWork(work, 'fixture-worker', captureWork(work));
  const checked = sqlWork(db, () => refreshMemoryCheckpoint(work.id));
  expect(checked.result.status).toBe('updated');
  return checked.work;
}
it('R7 selects only the dispatched family head while retaining its exact old evidence', async () => {
  const roster = { memoryRosterRevision: 1, bots: [{ id: 'bot', threadId: THREAD, tasks: [{ threadId: 'fixture-sibling' }] }], groups: [] };
  reconcileMemoryRoster(roster);
  publish('fixture-sibling', 'foreign', 'FOREIGN_CHECKPOINT_CANARY');
  publish(THREAD, 'original', 'Fixture original evidence.');
  const old = checkpointSnapshot(THREAD);
  publish(THREAD, 'later', 'Fixture later evidence.');
  const bundle = await buildMemoryBundle('', accessFor(roster).access, emptyBridge, { allowance: LineageAllowance.tool() });
  expect(bundle.checkpoint.map(row => ({ id: row.id, version: row.version }))).toEqual([checkpointHead(THREAD)]);
  expect(bundle.recordVersions).not.toContainEqual(checkpointHead('fixture-sibling'));
  expect(bundle.text).not.toContain('FOREIGN_CHECKPOINT_CANARY');
  assertCheckpointRetained(old);
});
it('R7 excludes a forgotten authoritative pin even while its active row and cached reference remain', async () => {
  const db = database(), scope = ensureScope('bot', 'bot');
  db.prepare("INSERT INTO memory_records VALUES('fixture-pin',1,?,'constraint','Fixture constraint','owner-statement','active',1,1,NULL,NULL,1)").run(scope);
  const { access } = accessFor(), bundle = () => buildMemoryBundle('', access, emptyBridge, { allowance: LineageAllowance.tool() });
  expect((await bundle()).pinned.map(row => row.id)).toEqual(['fixture-pin']);
  db.exec("INSERT INTO memory_tombstones VALUES('fixture-forget','record','fixture-pin',NULL,NULL,0,'forgotten',1)");
  expect(db.prepare("SELECT state FROM memory_records WHERE id='fixture-pin'").get()!.state).toBe('active');
  expect((await bundle()).pinned).toEqual([]);
});

it('R7 checkpoint work stays flat while every earlier source remains retained', () => {
  let small: ReturnType<typeof publish> | undefined, large: ReturnType<typeof publish> | undefined;
  for (let n = 0; n < 256; n++) {
    const work = publish(THREAD, `fixture-${n}`, `Fixture factual evidence ${n}.`);
    if (n === 31) small = work;
    if (n === 255) large = work;
  }
  expect(database().prepare('SELECT count(*) n FROM memory_sources').get()!.n).toBe(256);
  expect(large!.returned).toBeLessThanOrEqual(small!.returned + 8);
  expect(large!.statements).toBeLessThanOrEqual(small!.statements + 8);
});
