// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-qual-h. Consumers: recall-fix-g (recent), recall-prod-x (recovery); MAIN integrates.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database, transaction } from '../database.ts';
import { InternalCapabilities } from '../internal-capabilities.ts';
import { captureBranchChange, captureThreadDeletion } from './capture.ts';
import { forgetMemory } from './forget.ts';
import { ownerMemoryTicket } from './authority.ts';
import { setMemoryMode } from './repository.ts';
import { assertMemoryAccess } from './policy.ts';
import { catchUpRecentMemory } from './recent.ts';
import { accessFor, freshDataDir, THREAD } from './testing/recall-fixture.ts';

beforeEach(() => {
  freshDataDir('active');
  database().exec("UPDATE memory_lineage_cert SET ready=1,phase='done' WHERE id=1");
  database().prepare('INSERT OR REPLACE INTO memory_lineage_thread_ready(thread_id,ready) VALUES(?,1)').run(THREAD);
});

it.each(['before-terminal-commit', 'before-source-commit', 'source-committed', 'claim-committed', 'during-capture-commit', 'capture-committed', 'during-checkpoint-commit', 'checkpoint-committed', 'refused-before-notice'])('SIGKILL at %s preserves atomic durable truth and no dispatch authority', async cut => {
  const trace = await crashAt(cut);
  const registry = new InternalCapabilities();
  expect(registry.resolve(`Bearer ${trace.token}`)).toBeNull();
  const db = database();
  expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
  const job = db.prepare('SELECT id,status,cursor,coverage FROM memory_jobs').get();
  const records = db.prepare('SELECT id FROM memory_records').all();
  const publications = db.prepare('SELECT * FROM memory_checkpoint_publications').all();
  if (cut === 'before-terminal-commit') {
    expect(trace.terminal).toMatchObject({ sources: 1, marked: 1 });
    expect(db.prepare("SELECT id FROM memory_sources WHERE thread_id=? AND kind='text'").all(trace.threadId)).toHaveLength(0);
    expect(db.prepare("SELECT json_extract(json,'$.turnTerminal') AS terminal FROM messages WHERE thread_id=? AND role='bot' AND kind='text'").get(trace.threadId)?.terminal).not.toBe(1);
    expect(db.prepare("SELECT outcome FROM memory_sources WHERE thread_id=? AND kind='turn'").all(trace.threadId).every(row => row.outcome !== 'completed')).toBe(true);
  } else if (cut === 'before-source-commit') {
    expect(job).toBeUndefined();
    expect(db.prepare('SELECT id FROM memory_sources').all()).toHaveLength(0);
  } else {
    const captured = ['capture-committed', 'during-checkpoint-commit', 'checkpoint-committed'].includes(cut);
    expect(job).toMatchObject({ status: captured ? 'complete' : ['claim-committed', 'during-capture-commit'].includes(cut) ? 'leased' : 'pending', cursor: captured ? Buffer.byteLength('The fixture gate is green.') : 0 });
    if (captured) {
      const coverage = JSON.parse(String(job!.coverage));
      expect(coverage.throughByte).toBe(coverage.totalBytes);
      expect(records.length).toBeGreaterThan(0);
    }
    if (cut === 'capture-committed' || cut === 'during-checkpoint-commit') {
      expect(db.prepare('SELECT subject_id FROM memory_scope_bindings WHERE id=?').get('checkpoint-debt:' + trace.jobId)).toMatchObject({ subject_id: 'checkpoint-pending' });
    }
    if (cut === 'checkpoint-committed') {
      expect(publications).toHaveLength(1);
      expect(db.prepare('SELECT record_id,record_version FROM memory_checkpoint_heads').get()).toMatchObject({ record_id: publications[0].record_id, record_version: publications[0].record_version });
    }
  }
  if (!['capture-committed', 'during-checkpoint-commit', 'checkpoint-committed'].includes(cut)) expect(records).toHaveLength(0);
  if (cut !== 'checkpoint-committed') expect(publications).toHaveLength(0);
});

async function crashAt(cut: string) {
  closeDatabase();
  const reached = join(DATA_DIR, 'qualification-crash-reached.json');
  const child = fork(join(import.meta.dirname, 'testing/recall-qual-h-crash-child.ts'), [cut, reached], {
    execArgv: ['--experimental-strip-types', '--no-warnings'],
    env: { ...process.env, MURAGE_DATA_DIR: DATA_DIR }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr!.on('data', chunk => { stderr += String(chunk); });
  const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code, signal] = await once(child, 'exit').finally(() => clearTimeout(deadline));
  expect({ code, signal }, stderr).toEqual({ code: null, signal: 'SIGKILL' });
  expect(existsSync(reached), 'the intended transaction cut must be reached').toBe(true);
  const trace = JSON.parse(readFileSync(reached, 'utf8'));
  expect(trace.cut).toBe(cut);
  return trace;
}

it.each(['unchanged', 'forget', 'memory-off', 'deletion', 'branch-change'])('after SIGKILL a later independent live owner obeys current %s authority', async change => {
  const trace = await crashAt('source-committed');
  const db = database();
  const registry = new InternalCapabilities();
  expect(registry.resolve(`Bearer ${trace.token}`)).toBeNull();
  if (change === 'forget') forgetMemory(ownerMemoryTicket(), { kind: 'source', id: 'message:thread:terminal' });
  if (change === 'memory-off') setMemoryMode('off');
  if (change === 'deletion') transaction(() => captureThreadDeletion(db, THREAD));
  if (change === 'branch-change') transaction(() => captureBranchChange(db, THREAD, null));
  let later: ReturnType<typeof accessFor> | undefined;
  try {
    later = accessFor();
    const completed = catchUpRecentMemory(later.access);
    if (change === 'unchanged') expect(completed).toBe(1);
  } catch (error) {
    if (change === 'unchanged') throw error;
    expect(String(error)).toMatch(/MEMORY_(?:DISABLED|SCOPE_DENIED|CONTEXT_REVOKED|UNAUTHORIZED|RECALL_UNAVAILABLE)/);
  }
  const publications = db.prepare('SELECT * FROM memory_checkpoint_publications').all();
  expect(publications).toHaveLength(change === 'unchanged' ? 1 : 0);
  if (change !== 'unchanged') expect(db.prepare('SELECT id FROM memory_records').all()).toHaveLength(0);
  if (later) {
    later.registry.revokeThread(THREAD);
    expect(() => assertMemoryAccess(later.access)).toThrow('MEMORY_UNAUTHORIZED');
  }
});
