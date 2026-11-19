// Producer owner: recall-fix-h (issued access); consumer owner: recall-prod-y (deny-only continuation precheck).
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import * as policy from './policy.ts';
import { stopRecallViewMaintenance } from './recall-view.ts';
import { setupProofFixture } from './session-proof-fixture.ts';
import { sqlWork } from './testing/sql-work.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { stopRecallViewMaintenance(); closeDatabase(); });

it('the issued-access gate uses no SQL, rejects forged/dead claims, and never substitutes for read authority', () => {
  const f = setupProofFixture('direct'), db = database();
  expect(typeof policy.assertIssuedMemoryAccess, 'continuation needs a private identity gate').toBe('function');
  const { work } = sqlWork(db, () => policy.assertIssuedMemoryAccess(f.access));
  expect(work.statements, 'issued-access gate performs no SQL').toBe(0);
  expect(() => policy.assertIssuedMemoryAccess({ ...f.access })).toThrow('MEMORY_UNAUTHORIZED');
  expect(() => policy.assertMemoryAccess({ ...f.access })).toThrow('MEMORY_UNAUTHORIZED');
  db.exec('UPDATE memory_meta SET policy_revision=policy_revision+1 WHERE id=1');
  expect(() => policy.assertIssuedMemoryAccess(f.access)).not.toThrow();
  expect(() => policy.assertMemoryAccess(f.access)).toThrow('MEMORY_CONTEXT_REVOKED');
  f.registry.revokeThread('direct');
  expect(() => policy.assertIssuedMemoryAccess(f.access)).toThrow('MEMORY_UNAUTHORIZED');
});
