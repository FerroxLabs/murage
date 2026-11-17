// SPDX-License-Identifier: AGPL-3.0-or-later
// Receipt/current-evidence owner: recall-fix-j. Restart driver owner: recall-prod-x; MAIN integrates.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, transaction } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { ownerMemoryTicket } from './authority.ts';
import { captureBranchChange, captureThreadDeletion } from './capture.ts';
import { refreshMemoryCheckpoint } from './consolidate.ts';
import { forgetMemory } from './forget.ts';
import { assertMemoryAccess } from './policy.ts';
import { setMemoryMode } from './repository.ts';
import { accessFor, freshDataDir, THREAD } from './testing/recall-fixture.ts';

beforeEach(() => {
  freshDataDir('active');
  database().exec("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1");
  database().prepare('INSERT OR REPLACE INTO memory_lineage_thread_ready(thread_id,ready) VALUES(?,1)').run(THREAD);
});

async function crashAt(cut: string) {
  closeDatabase();
  const reached = join(DATA_DIR, 'fixture-cut.json');
  const child = fork(join(import.meta.dirname, 'testing/recall-fix-j-crash-child.ts'), [cut, reached], {
    execArgv: ['--experimental-strip-types', '--no-warnings'], env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code, signal] = await once(child, 'exit').finally(() => clearTimeout(deadline));
  expect({ code, signal }, stderr).toEqual({ code: null, signal: 'SIGKILL' });
  const trace = JSON.parse(readFileSync(reached, 'utf8'));
  expect(trace.cut).toBe(cut);
  expect(new InternalCapabilities().resolve(`Bearer ${trace.token}`)).toBeNull();
  return trace as { jobId: string };
}

for (const cut of ['capture-committed', 'during-checkpoint-commit']) {
  it.each(['unchanged', 'forget', 'memory-off', 'deletion', 'branch-change'])(`${cut}: checkpoint recovery boundary obeys current %s authority`, async change => {
    const { jobId } = await crashAt(cut), db = database();
    const marker = () => db.prepare('SELECT subject_id,state,intent FROM memory_scope_bindings WHERE id=?').get('checkpoint-debt:' + jobId);
    expect(marker()).toMatchObject({ subject_id: 'checkpoint-pending', state: 'granted' });
    expect(db.prepare('SELECT * FROM memory_checkpoint_publications').all()).toEqual([]);
    if (change === 'forget') forgetMemory(ownerMemoryTicket(), { kind: 'source', id: 'fixture-source' });
    if (change === 'memory-off') setMemoryMode('off');
    if (change === 'deletion') transaction(() => captureThreadDeletion(db, THREAD));
    if (change === 'branch-change') transaction(() => captureBranchChange(db, THREAD, null));
    let later: ReturnType<typeof accessFor> | undefined;
    try {
      later = accessFor(); assertMemoryAccess(later.access);
      const result = refreshMemoryCheckpoint(jobId);
      if (change === 'unchanged') expect(result.status).toBe('updated');
      else expect(result.status).toBe('deferred');
    } catch (error) {
      if (change === 'unchanged') throw error;
      expect(String(error)).toMatch(/MEMORY_(?:DISABLED|SCOPE_DENIED|CONTEXT_REVOKED|UNAUTHORIZED|RECALL_UNAVAILABLE|COMPLETED_SOURCE_REQUIRED|SOURCE_UNAVAILABLE)/);
    }
    expect(db.prepare('SELECT * FROM memory_checkpoint_publications').all()).toHaveLength(change === 'unchanged' ? 1 : 0);
    if (change === 'unchanged') expect(marker()).toBeUndefined();
    if (later) { later.registry.revokeThread(THREAD); expect(() => assertMemoryAccess(later!.access)).toThrow('MEMORY_UNAUTHORIZED'); }
  });
}

it('SIGKILL after checkpoint commit before acknowledgement leaves one exact receipt and no debt', async () => {
  const { jobId } = await crashAt('checkpoint-before-ack'), db = database();
  const before = db.prepare('SELECT * FROM memory_checkpoint_publications').all();
  expect(before).toHaveLength(1);
  expect(db.prepare('SELECT id FROM memory_scope_bindings WHERE id=?').get('checkpoint-debt:' + jobId)).toBeUndefined();
  const later = accessFor(); assertMemoryAccess(later.access);
  expect(refreshMemoryCheckpoint(jobId).status).toBe('unchanged');
  expect(db.prepare('SELECT * FROM memory_checkpoint_publications').all()).toEqual(before);
});
