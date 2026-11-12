// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import * as search from './testing/search-index-compat.ts';
import { initializeMessageTables } from './message-tables.ts';

const cleanup: Array<() => unknown> = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean, timeout = 3000) {
  const end = performance.now() + timeout;
  while (!check() && performance.now() < end) await pause(10);
  expect(check(), 'production scheduler reached the required state').toBe(true);
}
afterEach(async () => {
  search.searchIndexTestHooks.event = null;
  await search.stopSearchIndex();
  for (const close of cleanup.splice(0).reverse()) await close();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'murage-round4-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'messages.db'), db = new DatabaseSync(file);
  cleanup.push(() => db.close());
  db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
  initializeMessageTables(db);
  db.exec("INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES('t','m',1,'user','text','quokka recovery marker','{}')");
  search.syncMessageSearchRow(db, 1, 'quokka recovery marker');
  search.startSearchIndex(db, file);
  return { db, dir };
}
function settled(db: DatabaseSync) {
  return search.messageSearchIndexReady(db) && !search.searchCleanupPending(db);
}
it('AF1: consecutive successful schema resets never exhaust recovery', { timeout: 20000 }, async () => {
  const { db, dir } = fixture();
  await until(() => settled(db));
  let ready = 0;
  search.searchIndexTestHooks.event = event => { if (event.type === 'ready') ready++; };
  for (let i = 1; i <= search.SEARCH_RECOVERY_ATTEMPTS + 2; i++) {
    db.exec(`CREATE TABLE invalidation_${i}(v)`);
    await until(() => ready === i && settled(db));
    expect(search.readMessageSearchCandidates(db, search.trigramQuery('quokka'), 10)).toEqual({ rowids: [1], partial: false });
  }
  const reader = new DatabaseSync(join(dir, 'search.db'), { readOnly: true });
  try { expect(reader.prepare('PRAGMA quick_check').get()!.quick_check).toBe('ok'); }
  finally { reader.close(); }
  console.log('AF1 successful resets', ready);
});
it('AF2: a pinned reader backs off scrub retries through the production scheduler', { timeout: 15000 }, async () => {
  const { db, dir } = fixture();
  await until(() => settled(db));
  // Pin the real search WAL before a real drop creates scrub debt.
  const reader = new DatabaseSync(join(dir, 'search.db'), { readOnly: true });
  cleanup.push(() => reader.close());
  reader.exec('BEGIN'); reader.prepare('SELECT COUNT(*) FROM docs').get();
  const attempts: number[] = [], steps: number[] = [];
  search.searchIndexTestHooks.event = event => {
    if (event.type === 'scrub-busy') attempts.push(performance.now());
    if (event.type === 'stepped') steps.push(performance.now());
  };
  db.exec('BEGIN'); search.dropThreadSearchRows(db, 't'); db.exec('DELETE FROM messages; COMMIT');
  await pause(1400);
  expect(steps.length, 'busy scrub must not spin at 10 ms').toBeLessThan(15);
  expect(attempts.length, 'observed real busy TRUNCATE attempts').toBeGreaterThanOrEqual(3);
  expect(search.searchCleanupPending(db), 'busy scrub retains its debt').toBe(true);
  expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(45);
  expect(attempts[2] - attempts[1]).toBeGreaterThanOrEqual(90);
  console.log('AF2 pinned-reader retry gaps', attempts.slice(1).map((at, i) => at - attempts[i]), 'steps', steps.length);
  reader.exec('COMMIT');
  await until(() => settled(db), 6000);
  expect(search.readMessageSearchCandidates(db, search.trigramQuery('quokka'), 10)).toEqual({ rowids: [], partial: false });
});
