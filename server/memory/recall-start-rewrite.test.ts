// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-scope (startup sweep, recall-view.ts prepareRosterRecallViews). Consumer owner: fix/1020-io-start (fablehunt-1020q T2).
// T2: after every start 12-21 GB were written in ~5 minutes. The startup sweep rebuilt EVERY persisted recall context whose hydration was
// refused (any epoch move, here a display-only rename of a verified sender), and each full build copies every record and term of its scopes.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { observeVerifiedHuman, OWNER } from '../human-principals.ts';
import * as views from './recall-view.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); });
afterEach(() => { views.stopRecallViewMaintenance(); closeDatabase(); vi.restoreAllMocks(); });

const sender = { platform: 'slack' as const, connectionId: 'fixture-connection', authorityId: 'fixture-team', userId: 'fixture-guest' };
const viewIds = () => new Set((database().prepare('SELECT view_id FROM memory_recall_views').all() as Array<{ view_id: string }>).map(row => row.view_id));
const epoch = () => Number(database().prepare('SELECT epoch FROM memory_recall_epoch WHERE id=1').get()!.epoch);
/** Counts the derived rows the recall views write, on the real connection (a TEMP trigger on the main table). */
function termWrites() {
  const db = database();
  db.exec('CREATE TEMP TABLE IF NOT EXISTS fixture_term_writes(n INTEGER NOT NULL); DELETE FROM fixture_term_writes; INSERT INTO fixture_term_writes VALUES(0);');
  db.exec('CREATE TEMP TRIGGER IF NOT EXISTS fixture_term_write AFTER INSERT ON main.memory_recall_view_terms BEGIN UPDATE fixture_term_writes SET n=n+1; END;');
  return () => Number(db.prepare('SELECT n FROM fixture_term_writes').get()!.n);
}
function binding(store: Store, bot = store.bots[0]): views.RecallViewBinding {
  return { botId: bot.id, threadId: bot.threadId, notOwnerAudience: false, humanPrincipal: OWNER };
}

async function firstStart() {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  for (let n = 0; n < 3; n++) {
    const bot = store.createBot({ name: `Reader ${n}` }, { seedMessages: false });
    for (let t = 0; t < 2; t++) store.createTask(bot.id, `Task ${t}`, false);
  }
  observeVerifiedHuman(sender, { name: 'Fixture Guest' });
  const db = database(); let n = 0;
  for (const row of db.prepare("SELECT id FROM memory_scopes WHERE kind='conversation'").all()) for (let k = 0; k < 4; k++)
    db.prepare("INSERT INTO memory_records VALUES(?,1,?,'constraint',?,'owner-statement','active',1,1,NULL,NULL,1)").run(`fixture-record-${n++}`, row.id, `alpha bravo charlie delta echo ${n}`);
  store.finishSharingBoot();
  await views.waitForRecallConstructionIdleForTest(store); views.stopRecallViewMaintenance();
  return store;
}

it('a restart after an epoch move rewrites no persisted recall context; only a demanded context is rebuilt', async () => {
  const first = await firstStart();
  const contexts = Number(database().prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n);
  // Precondition: the first start built every context (3 bots x 3 threads x 2 audiences), with real term rows.
  expect(contexts).toBeGreaterThanOrEqual(18);
  expect(Number(database().prepare('SELECT count(*) AS n FROM memory_recall_view_terms').get()!.n)).toBeGreaterThan(0);
  const before = viewIds(), botCount = first.bots.length;
  closeDatabase(); database();
  const written = termWrites();
  const restarted = new Store(() => ({ instanceId: 'fixture', model: 'model' }));
  // A connector reconnects at boot and sees the sender's new display name: same person, but the binding write moves the recall epoch.
  const moved = epoch(); observeVerifiedHuman(sender, { name: 'Fixture Guest Renamed' }); expect(epoch()).toBeGreaterThan(moved);
  restarted.finishSharingBoot();
  await views.waitForRecallConstructionIdleForTest(restarted); views.stopRecallViewMaintenance();
  const startupBuilt = [...viewIds()].filter(id => !before.has(id)).length;
  console.info('T2 startup sweep', JSON.stringify({ contexts, startupBuilt, termRowsWritten: written() }));
  expect(startupBuilt).toBe(0);
  expect(written()).toBe(0);
  // Fail closed: the stale context is refused, never read; the reader's demand queues its own build and admits after it.
  expect(restarted.bots).toHaveLength(botCount);
  expect(() => views.resolveRecallView(binding(restarted), restarted)).toThrow('MEMORY_RECALL_UNAVAILABLE');
  await views.waitForRecallConstructionIdleForTest(restarted); views.stopRecallViewMaintenance();
  expect(views.resolveRecallView(binding(restarted), restarted).handle.viewId).not.toBe('');
  expect([...viewIds()].filter(id => !before.has(id))).toHaveLength(1);
  expect(written()).toBeGreaterThan(0);
  // Another stale context is still refused until it is demanded.
  expect(() => views.resolveRecallView(binding(restarted, restarted.bots[1]), restarted)).toThrow('MEMORY_RECALL_UNAVAILABLE');
}, 120_000);

it('a first start still builds every context (no persisted view to hydrate)', async () => {
  const written = termWrites();
  const store = await firstStart();
  expect(Number(database().prepare('SELECT count(*) AS n FROM memory_recall_contexts').get()!.n)).toBeGreaterThanOrEqual(18);
  expect(written()).toBeGreaterThan(0);
  for (const bot of store.bots) expect(views.resolveRecallView(binding(store, bot), store).handle.viewId).not.toBe('');
}, 120_000);

