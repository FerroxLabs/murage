// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// Owner: recall-scope (view cap and parked demand); witness for the 1.0.20 canary write storm.
// A waiting build that cannot fit (the 512 MiB view quota trigger) raises the same message as a full view cap. It must be refused once,
// not parked and rebuilt on every upkeep tick: each retry walks every job and then deletes its partial view row by row.
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from '../config.ts';
import { closeDatabase, database } from '../database.ts';
import { OWNER } from '../human-principals.ts';
import { removeTempDirSync } from '../testing/cleanup.ts';
import { reconcileMemoryRoster, type MemoryRoster } from './policy.ts';
import { RecallPreparationPending } from './recall-recovery.ts';
import { OWNER_PIN } from './schema.ts';
import * as views from './recall-view.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR, { recursive: true }); database().exec(OWNER_PIN.sql); });
afterEach(() => { views.stopRecallViewMaintenance(); closeDatabase(); });

const binding = (botId: string, threadId: string) => ({ botId, threadId, humanPrincipal: OWNER, notOwnerAudience: false });
const viewRows = () => Number(database().prepare('SELECT count(*) AS n FROM memory_recall_views').get()!.n);
const builds = () => views.recallViewCounters().oracleComputes;
const settle = (roster: MemoryRoster) => views.waitForRecallConstructionIdleForTest(roster);

it('a build over the view quota at the 128-view cap is refused once, not rebuilt on every upkeep tick', async () => {
  const bots = Array.from({ length: 129 }, (_, n) => ({ id: `bot-${n}`, threadId: `thread-${n}` }));
  const roster: MemoryRoster = { memoryRosterRevision: 1, bots, groups: [] };
  reconcileMemoryRoster(roster);
  views.stopRecallViewMaintenance();
  for (const bot of bots.slice(0, 128)) expect(() => views.resolveRecallView(binding(bot.id, bot.threadId), roster)).toThrow(RecallPreparationPending);
  await settle(roster);
  expect(viewRows()).toBe(128);
  // A large memory: the derived rows already hold the whole quota, so any new view row is aborted by the storage trigger.
  database().prepare('UPDATE memory_recall_storage SET bytes=bytes+600000000 WHERE id=1').run();
  const before = builds();
  expect(() => views.resolveRecallView(binding('bot-128', 'thread-128'), roster)).toThrow(RecallPreparationPending);
  await settle(roster);
  const first = builds() - before;
  expect(first).toBe(1);
  // Thirty upkeep ticks with no new demand: nothing may rebuild the refused context.
  views.startRecallViewMaintenance();
  await new Promise(resolve => setTimeout(resolve, 1500));
  await settle(roster);
  expect(builds() - before).toBe(first);
  expect(viewRows()).toBeLessThanOrEqual(128);
  // The same demand with nothing changed (same authority epoch, roster revision and missing room) stays held without a build:
  // that hold is what stops the rebuild storm, and the reader still gets the typed capacity answer.
  views.stopRecallViewMaintenance();
  expect(() => views.resolveRecallView(binding('bot-128', 'thread-128'), roster)).toThrow(RecallPreparationPending);
  await settle(roster);
  expect(builds() - before).toBe(first);
  // The hold is not permanent: once the room exists again, the next demand builds exactly once and the reader is served.
  database().prepare('UPDATE memory_recall_storage SET bytes=bytes-600000000 WHERE id=1').run();
  expect(() => views.resolveRecallView(binding('bot-128', 'thread-128'), roster)).toThrow(RecallPreparationPending);
  await settle(roster);
  expect(builds() - before).toBe(first + 1);
  expect(views.resolveRecallView(binding('bot-128', 'thread-128'), roster).handle.viewId).toEqual(expect.any(String));
}, 60_000);
