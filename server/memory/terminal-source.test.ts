// SPDX-License-Identifier: AGPL-3.0-or-later
// Producer owner: recall-fix-e. Consumer owner: MAIN (STOP1 and exact terminal source).
import { beforeEach, expect, it } from 'vitest';
import { database } from '../database.ts';
import { Store } from '../store.ts';
import { freshDataDir } from './testing/recall-fixture.ts';
import { recordMemorySettlement } from './settlement.ts';

beforeEach(() => freshDataDir('active'));

it.each(['cancelled', 'failed'] as const)('%s preserves the transcript terminal without producing assistant capture work', outcome => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'fixture' }));
  const bot = store.createBot({}, { seedMessages: false });
  const row = store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'An unfinished intention.', turnId: 'turn-a' });
  const terminal = store.markTerminalAssistantMessage(bot.threadId, 'turn-a', outcome);
  expect(terminal).toMatchObject({ id: row.id, text: row.text, turnTerminal: true });
  expect(database().prepare('SELECT outcome FROM memory_sources WHERE id=?').get(`turn:${bot.threadId}:turn-a`)).toMatchObject({ outcome });
  expect(database().prepare('SELECT id FROM memory_sources WHERE id=?').get(`message:${bot.threadId}:${row.id}`)).toBeUndefined();
  store.patchMessage(bot.threadId, row.id, { text: row.text });
  expect(database().prepare('SELECT id FROM memory_sources WHERE id=?').get(`message:${bot.threadId}:${row.id}`)).toBeUndefined();
});

it('a late terminal marker does not settle a replacement turn', () => {
  const store = new Store(() => ({ instanceId: 'fixture', model: 'fixture' }));
  const bot = store.createBot({}, { seedMessages: false });
  store.appendMessage(bot.threadId, { role: 'bot', kind: 'text', text: 'The old partial reply.', turnId: 'turn-a' });
  recordMemorySettlement(bot.threadId, 'turn-b', 'working');
  store.markTerminalAssistantMessage(bot.threadId, 'turn-a', 'cancelled');
  expect(database().prepare('SELECT outcome FROM memory_sources WHERE id=?').get(`turn:${bot.threadId}:turn-b`)).toMatchObject({ outcome: 'working' });
});
