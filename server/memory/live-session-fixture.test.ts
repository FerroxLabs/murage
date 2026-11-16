// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// MAIN RULING 1115-RECALL-R7 (GrokBuild)
// Producer owner: recall-r7-a; consumer owner: MAIN (live birth and ordinary S1 controls).
import { beforeEach, expect, it, vi } from 'vitest';
import { database } from '../database.ts';
import { MemoryDispatchReceipt } from './dispatch.ts';
import * as bundleReader from './bundle.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { assertMemoryAccess, type MemoryAccess } from './policy.ts';
import { proveRetainedSession } from './session-proof.ts';
import { sessionKeyOf } from './session-incarnation.ts';
import { stampFreshSession } from './testing/writetime-fixture.ts';
import { storeLiveAnchor, startLiveSession } from './testing/live-session-fixture.ts';
import { accessFor, captureAndPublish, freshDataDir, THREAD } from './testing/recall-fixture.ts';

beforeEach(() => freshDataDir('active'));
function evidence(text: string) {
  const source = captureAndPublish(text);
  const row = database().prepare('SELECT message_id FROM memory_sources WHERE id=?').get(source.sourceId)!;
  storeLiveAnchor(database(), THREAD, String(row.message_id), text);
}
const key = () => sessionKeyOf(THREAD, 'fixture-engine', 'fixture-session');
async function frame(access: MemoryAccess) {
  const row = database().prepare("SELECT id,version FROM memory_records WHERE kind='source' ORDER BY rowid DESC LIMIT 1").get()!;
  const bundle = await bundleReader.buildMemoryBundle('fixture', access, { search: async () => ({ hits: [{ id: String(row.id), version: Number(row.version), score: 1 }], vectorRows: 0 }) }, { allowance: LineageAllowance.tool() });
  expect(bundle.recordVersions).toContainEqual({ id: row.id, version: row.version });
  return new MemoryDispatchReceipt(bundle, access, 'fixture-engine');
}
it('R7 a real live start confirms this generation and accepts its actual first frame', async () => {
  const { access } = accessFor(); evidence('Fixture original evidence.');
  const confirmation = startLiveSession(access, 'fixture-engine', 'fixture-session');
  expect(confirmation?.firstFrameSessionCurrent(key(), access.generation)).toBe(true);
  const receipt = await frame(access);
  receipt.sessionStarted('fixture-session', true, confirmation); receipt.accepted();
  expect(proveRetainedSession(LineageAllowance.tool(), key(), { access })).toEqual({ kind: 'resume' });
});
it('R7 a legacy stamp and hand-restored first-frame state cannot acquire a reader checkpoint', async () => {
  const { access } = accessFor(); evidence('Fixture historical evidence.');
  stampFreshSession(database(), THREAD, 'fixture-engine', 'fixture-session');
  const receipt = await frame(access); receipt.sessionStarted('fixture-session', true); receipt.accepted();
  expect(startLiveSession(access, 'fixture-engine', 'fixture-session')).toBeUndefined();
  expect(proveRetainedSession(LineageAllowance.tool(), key(), { access }).kind).toBe('fresh');
  expect(database().prepare('SELECT count(*) n FROM memory_session_checks').get()!.n).toBe(0);
});
it('R7 a dead generation cannot hydrate the later frame that an independent live owner can prove', async () => {
  const original = accessFor(); evidence('Fixture first evidence.');
  const confirmation = startLiveSession(original.access, 'fixture-engine', 'fixture-session');
  const first = await frame(original.access); first.sessionStarted('fixture-session', true, confirmation); first.accepted();
  original.registry.revokeGeneration(THREAD, original.access.generation);
  const later = accessFor(); evidence('Fixture later evidence.');
  const second = await frame(later.access); second.sessionStarted('fixture-session'); second.accepted();
  const hydrated = vi.spyOn(bundleReader, 'hydrateDisclosedMemoryRecord');
  try {
    expect(() => assertMemoryAccess(original.access)).toThrow('MEMORY_UNAUTHORIZED');
    expect(proveRetainedSession(LineageAllowance.tool(), key(), { access: original.access }).kind).toBe('fresh');
    expect(hydrated).not.toHaveBeenCalled();
    expect(proveRetainedSession(LineageAllowance.tool(), key(), { access: later.access })).toEqual({ kind: 'resume' });
    expect(hydrated.mock.calls.length).toBeGreaterThan(0);
  } finally { hydrated.mockRestore(); }
});
