// Producer owner: recall-prod-y (session proof); consumer owner: recall-fix-h (retained receipt durability).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { buildMemoryBundle } from './bundle.ts';
import { bindMemoryDisclosureSession, deliverMemoryDisclosure, prepareMemoryDisclosure } from './disclosures.ts';
import { assertMemoryAccess } from './policy.ts';
import { FreshReplaySessionConfirmation } from './fresh-replay-session.ts';
import { captureSendReplayProof } from './replay-lineage.ts';
import { noteSessionFrame } from './session-proof-schema.ts';
import { LineageAllowance } from './lineage-allowance.ts';
import { stopRecallViewMaintenance } from './recall-view.ts';
import { proofModule, setupProofFixture } from './session-proof-fixture.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });

it('a receipt delivered to an already retained session advances the durable prefix without fresh initialization', async () => {
  const f = setupProofFixture('direct'), p = await proofModule(), db = database();
  const first = await buildMemoryBundle('', f.access, { async search() { return { hits: [], vectorRows: 0 }; } }, { allowance: LineageAllowance.tool() });
  prepareMemoryDisclosure(first, f.access, f.key.driverInstance);
  const confirmation = new FreshReplaySessionConfirmation(captureSendReplayProof(f.key.threadId, []), f.key.driverInstance, () => assertMemoryAccess(f.access), { generation: f.access.generation });
  confirmation.sessionStarted('first-turn', f.key, true);
  confirmation.engineWritten(); confirmation.accepted('first-turn');
  noteSessionFrame(db, f.key, false);
  p.initializeFreshSessionProof(f.key, f.access, () => {
    bindMemoryDisclosureSession(first.bundleId, f.key.nativeSession);
    deliverMemoryDisclosure(first.bundleId, f.access);
  }, { fresh: true, confirmation });
  expect(p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true })).toEqual({ kind: 'resume' });
  const checkpoint = () => db.prepare('SELECT up_to FROM memory_session_checks WHERE thread_id=? AND driver_instance=? AND native_session=?').get(f.key.threadId, f.key.driverInstance, f.key.nativeSession)!;
  const before = Number(checkpoint().up_to);
  expect(before).toBeGreaterThan(0);
  const bundle = await buildMemoryBundle('', f.access, { async search() { return { hits: [], vectorRows: 0 }; } }, { allowance: LineageAllowance.tool() });
  prepareMemoryDisclosure(bundle, f.access, f.key.driverInstance);
  bindMemoryDisclosureSession(bundle.bundleId, f.key.nativeSession);
  deliverMemoryDisclosure(bundle.bundleId, f.access);
  const rid = Number(db.prepare('SELECT rowid AS rid FROM memory_disclosures WHERE bundle_id=?').get(bundle.bundleId)!.rid);
  expect(rid).toBeGreaterThan(before);
  expect(Number(checkpoint().up_to), 'delivery alone must not initialize a retained proof').toBe(before);
  expect(p.proveRetainedSession(LineageAllowance.tool(), f.key, { access: f.access, disclosed: true })).toEqual({ kind: 'resume' });
  expect(Number(checkpoint().up_to), 'new retained receipt must be committed before resume').toBe(rid);
});
