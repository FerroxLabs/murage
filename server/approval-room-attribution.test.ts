// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DATA_DIR } from './config.ts';
import { closeDatabase, database } from './database.ts';
import { lookupApproval } from './decision/index.ts';
import { Store } from './store.ts';
import { openFixtureApproval } from './testing/approval-card.ts';
import { removeTempDirSync } from './testing/cleanup.ts';

beforeEach(() => {
  closeDatabase();
  removeTempDirSync(DATA_DIR);
  mkdirSync(DATA_DIR, { recursive: true });
});
afterEach(() => closeDatabase());

it('a registered room card names its requesting member rather than the default responder', () => {
  const store = new Store();
  const lead = store.createBot({ name: 'Room lead' });
  const requester = store.createBot({ name: 'Requesting member' });
  const room = store.createGroup('Approval fixture', [lead.id, requester.id], false, undefined,
    { defaultResponder: { kind: 'member', botId: lead.id }, completed: true });
  const db = database();
  const seeded = openFixtureApproval(db, room.threadId, {
    id: 'room-permission', kind: 'options',
    card: { title: 'Approval needed', subtitle: 'Read fixture notes', requestId: 'room-request', tool: 'Read', options: ['Allow', 'Deny'] },
  });
  db.prepare('UPDATE approval_records SET bot_id=? WHERE thread_id=? AND chat_message_id=?')
    .run(requester.id, room.threadId, seeded.id);
  const record = lookupApproval(room.threadId, seeded.id)!;
  const message = store.appendApprovalCard(room.threadId, record.ref,
    { title: seeded.card.title, subtitle: seeded.card.subtitle });

  expect(message.from).toEqual({ botId: requester.id, name: requester.name, color: requester.color });
  expect(store.messageById(room.threadId, message.id)?.from).toEqual(message.from);
  expect(message.card?.approvalId).toBe(record.ref.approvalId);
  expect(message.card?.actionHash).toBe(record.actionHash);
});
