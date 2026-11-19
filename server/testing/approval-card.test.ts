// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { DATA_DIR } from '../config.ts';
import { database, closeDatabase } from '../database.ts';
import { Store } from '../store.ts';
import { removeTempDirSync } from './cleanup.ts';
import { appendFixtureMessage, answerFixtureStoreMessage, insertFixtureRows, settleFixtureApproval } from './approval-card.ts';
import { actionProjection } from '../../shared/permission-card.ts';
import { hash } from '../decision/bounds.ts';

beforeEach(() => { closeDatabase(); removeTempDirSync(DATA_DIR); mkdirSync(DATA_DIR,{recursive:true}); });
const ask = {role:'bot',kind:'options',card:{title:'Run?',requestId:'request',tool:'Bash',options:['Allow','Deny']}} as const;

it('fixture cards have a matching record and still reject unregistered writes and changed actions', () => {
  const store=new Store();
  const thread=store.createBot().threadId;
  expect(() => store.appendMessage(thread, structuredClone(ask) as never)).toThrow('card-without-approval');
  const message=appendFixtureMessage(store,thread,structuredClone(ask) as never);
  const record=database().prepare('SELECT * FROM approval_records WHERE chat_message_id=?').get(message.id)!;
  expect(record.thread_id).toBe(thread);
  expect(record.action_hash).toBe(hash(actionProjection(message.card!)));
  expect(() => store.patchMessage(thread,message.id,{card:{...message.card!,options:['Allow everything']}})).toThrow('card-action-changed');
  expect(() => store.patchMessage(thread,message.id,{card:{...message.card!,answered:'Allowed'}})).toThrow('card-action-changed');
  const answered=answerFixtureStoreMessage(store,thread,message.id,{answered:'Allowed'});
  expect(answered?.card?.options).toEqual(['Allow','Deny']);
  expect(answered?.card?.answered).toBe('Allowed');
  expect(database().prepare('SELECT state FROM approval_records WHERE id=?').get(String(record.id))?.state).toBe('answered');
});

it('bulk fixture records authorize every row without disabling the SQL guards', () => {
  const db=database();
  insertFixtureRows(db, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3)
    INSERT INTO messages(thread_id,id,at,role,kind,json)
    SELECT 't','m'||i,i,'bot','options',json_object('id','m'||i,'kind','options','card',json_object('requestId','r'||i,'options',json_array('Allow','Deny'))) FROM n`);
  const rows=db.prepare('SELECT json FROM messages ORDER BY id').all().map(row=>JSON.parse(String(row.json)));
  expect(rows).toHaveLength(3);
  expect(db.prepare('SELECT count(*) AS n FROM approval_records').get()?.n).toBe(3);
  for (const row of rows) {
    const record=db.prepare('SELECT * FROM approval_records WHERE id=?').get(row.card.approvalId)!;
    expect(record.action_hash).toBe(hash(actionProjection(row.card)));
    expect(record.chat_message_id).toBe(row.id);
  }
  expect(() => db.prepare("INSERT INTO messages(thread_id,id,at,role,kind,json) VALUES('t','raw',1,'bot','options',?)").run(JSON.stringify({...ask,id:'raw'}))).toThrow('card-without-approval');
  expect(() => db.exec("UPDATE messages SET json=json_set(json,'$.card.options',json('[\"Other\"]')) WHERE id='m1'")).toThrow('card-action-changed');
});

it('answer-as-send receipts keep their message binding and cannot authorize or settle an open question', () => {
  const store = new Store(), thread = store.createBot().threadId;
  const message = appendFixtureMessage(store, thread, { role: 'bot', kind: 'options', card: {
    title: 'Question', subtitle: 'Choose', requestId: 'ask-question', answerAsSend: true, options: [],
    questions: [{ id: 'q1', question: 'Choose', options: [{ label: 'One' }], multiSelect: false, allowOther: false }],
  } });
  const receipt = { ...message.card!, sendId: `ask-${message.id}` };
  expect(() => store.patchMessage(thread, message.id, { card: receipt })).toThrow('card-action-changed');
  expect(() => database().prepare("UPDATE messages SET json=json_set(json,'$.card.sentAsMessage',json('true')) WHERE id=?").run(message.id)).toThrow('card-action-changed');
  settleFixtureApproval(database(), thread, message.id);
  expect(() => store.patchMessage(thread, message.id, { card: { ...receipt, answered: 'answer', sendId: 'different-send' } })).toThrow('card-action-changed');
  expect(() => database().prepare("UPDATE messages SET json=json_set(json,'$.card.answered','answer','$.card.sendId','different-send') WHERE id=?").run(message.id)).toThrow('card-action-changed');
  const settled = store.patchMessage(thread, message.id, { card: { ...receipt, answered: 'answer', answers: [{ id: 'q1', selected: ['One'] }] } });
  expect(settled?.card?.sendId).toBe(`ask-${message.id}`);
  expect(hash(actionProjection(settled!.card!))).toBe(hash(actionProjection(message.card!)));
  expect(() => store.patchMessage(thread, message.id, { card: { ...settled!.card!, sentAsMessage: true } })).toThrow('card-action-changed');
  expect(() => store.patchMessage(thread, message.id, { card: { ...settled!.card!, questions: [] } })).toThrow('card-action-changed');
});

it('legacy restart fixtures retain no approval record and leave current guards installed', async () => {
  const { appendLegacyFixtureMessage } = await import('./approval-card.ts');
  const { dismissStalePeerCards } = await import('../peer-approval.ts');
  const store=new Store();
  const thread=store.createBot().threadId;
  const message=appendLegacyFixtureMessage(store,thread,{...structuredClone(ask),card:{...structuredClone(ask.card),tool:'ask_bot'}} as never);
  expect(database().prepare('SELECT count(*) AS n FROM approval_records').get()?.n).toBe(0);
  expect(database().prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='trigger' AND name LIKE 'approval_card_%'").get()?.n).toBe(3);
  expect(dismissStalePeerCards({store} as never)).toBe(1);
  expect(store.messageById(thread,message.id)?.card?.dismissed).toBe(true);
  expect(() => store.appendMessage(thread,structuredClone(ask) as never)).toThrow('card-without-approval');
});
