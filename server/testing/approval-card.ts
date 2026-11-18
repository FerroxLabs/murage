// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline archive fixtures have their own database. Open through the same
// production record writer and authorization seam before inserting the card.
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { insertMessage, appendMessage, readMessage, updateMessage } from '../message-db.ts';
import { database } from '../database.ts';
import type { Store, Message } from '../store.ts';
import { actionProjection } from '../../shared/permission-card.ts';
import { hash } from '../decision/bounds.ts';
import { assertCardAuthorized, initializeApprovals, insertRecord, isPermission, isTerminal, lookupRecord, updateRecord } from '../decision/records.ts';

export function openFixtureApproval<T extends {id:string; kind:string; card?:unknown}>(db:DatabaseSync, threadId:string, message:T):T {
  if (!isPermission(message) || isTerminal(message)) return message;
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='approval_records'").get()) initializeApprovals(db);
  const id = randomUUID(), request = (message.card as {requestId?:string}).requestId ?? id;
  const action = {...(message.card as object), approvalId:id, requestRef:request};
  const actionHash = hash(actionProjection(action));
  const result = {...message, card:{...action, actionHash}};
  insertRecord(db, {id, source_kind:'engine', service:null, thread_id:threadId, request_key:message.id, request_id:request,
    bot_id:'bot', generation:'fixture', actor_kind:'owner', actor_via:'owner-typed', level:'ask', why:'base',
    evidence:JSON.stringify({items:[],action:result.card,initiator:{k:'owner-typed'}}), registration_hash:hash(request), deny_rev:'[]',
    input_hash:hash({}), action_hash:actionHash, presented_action:null, chat_message_id:message.id, queue_kind:null, queue_ref:null,
    state:'open', answer:null, answer_id:null, delivery:'none', created_at:1, settled_at:null});
  assertCardAuthorized(db, threadId, result);
  return result as T;
}

/** Seed the authorization, then let the real Store perform the write. */
export function appendFixtureMessage(store:Store, threadId:string, input:Parameters<Store['appendMessage']>[1], stableId=randomUUID(), expectedCard?:(card:NonNullable<Message['card']>)=>NonNullable<Message['card']>):Message {
  const message = openFixtureApproval(database(), threadId, {id:stableId, ...input, ...(expectedCard && input.card ? {card:expectedCard(input.card)} : {})});
  // Redaction tests seed the expected persisted action but still give Store the
  // original bytes. A missed scrub then fails the real action-hash guard.
  if (expectedCard && input.card && message.card) message.card={...input.card,approvalId:message.card.approvalId,requestRef:message.card.requestRef,actionHash:message.card.actionHash};
  return store.appendMessage(threadId, message, stableId);
}

/** Settle the record before a fixture writes its same-action terminal card. */
export function settleFixtureApproval(db:DatabaseSync, threadId:string, messageId:string):void {
  const record = lookupRecord(db, threadId, messageId);
  if (record) updateRecord(db, record.id, {state:'answered', settled_at:Date.now()});
}

/** SQL scale fixtures stage their rows, seed records, then cross the unchanged
 * INSERT guard. No triggers are removed and no unregistered card is persisted.
 * Record seeding here avoids the live cache: insertRecord's live cache is
 * for real pending requests, not hundreds of thousands of synthetic cards. */
export function insertFixtureRows(db:DatabaseSync, sql:string, ...args:Array<string|number|null>):void {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS fixture_card_rows AS SELECT * FROM messages WHERE 0; DELETE FROM fixture_card_rows');
  db.prepare(sql.replace(/INTO messages\b/i, 'INTO fixture_card_rows')).run(...args);
  const columns = Object.keys(db.prepare('SELECT * FROM fixture_card_rows LIMIT 1').get() ?? {});
  if (!columns.length) return;
  const rows = db.prepare("SELECT rowid AS fixture_rowid, thread_id, json FROM fixture_card_rows WHERE kind='options'");
  const update = db.prepare('UPDATE fixture_card_rows SET json=? WHERE rowid=?');
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='approval_records'").get()) initializeApprovals(db);
  // Build exactly the same hash-bound action as openFixtureApproval, while
  // avoiding its per-request live-cache bookkeeping for these bulk rows.
  const insert = db.prepare(`INSERT INTO approval_records(id,source_kind,thread_id,request_key,request_id,bot_id,generation,actor_kind,actor_via,level,why,evidence,registration_hash,deny_rev,input_hash,action_hash,chat_message_id,state,created_at) VALUES(?,'engine',?,?,?,'bot','fixture','owner','owner-typed','ask','base',?,?,'[]',?,?,?,'open',1)`);
  for (const row of rows.iterate()) {
    let message;
    try { message=JSON.parse(String(row.json)); } catch { continue; }
    if (!isPermission(message) || isTerminal(message)) continue;
    const id=randomUUID(), request=message.card.requestId ?? id;
    const action={...message.card,approvalId:id,requestRef:request};
    const actionHash=hash(actionProjection(action));
    message.card={...action,actionHash};
    insert.run(id,String(row.thread_id),message.id,request,JSON.stringify({items:[],action:message.card,initiator:{k:'owner-typed'}}),hash(request),hash({}),actionHash,message.id);
    update.run(JSON.stringify(message),row.fixture_rowid);
  }
  db.exec(`INSERT INTO messages(${columns.join(',')}) SELECT ${columns.join(',')} FROM fixture_card_rows ORDER BY rowid; DELETE FROM fixture_card_rows`);
}

// Direct message-db fixtures still exercise its actual write and lineage path.
export function insertFixtureMessage(threadId:string, message:Message, ...rest:Parameters<typeof insertMessage> extends [string,Message,...infer R] ? R : never):void {
  insertMessage(threadId, openFixtureApproval(database(), threadId, message), ...rest);
}
export function appendFixtureDbMessage(threadId:string, message:Message, ...rest:Parameters<typeof appendMessage> extends [string,Message,...infer R] ? R : never):void {
  appendMessage(threadId, openFixtureApproval(database(), threadId, message), ...rest);
}

export function answerFixtureMessage(threadId:string, messageId:string, terminal:{answered:string; dismissed?:boolean}):void {
  const message=readMessage(threadId,messageId)!;
  settleFixtureApproval(database(),threadId,messageId);
  updateMessage(threadId,{...message,card:{...message.card!,...terminal}});
}
export function answerFixtureStoreMessage(store:Store, threadId:string, messageId:string, terminal:{answered:string; dismissed?:boolean}):Message|null {
  const message=store.messageById(threadId,messageId)!;
  settleFixtureApproval(database(),threadId,messageId);
  return store.patchMessage(threadId,messageId,{card:{...message.card!,...terminal}});
}

/** Model a historical 1.0.18 writer, as decision/rollback-1019.test.ts does.
 * Its connection has no 1.0.19 marker; the inherited triggers remain installed.
 * Only fixtures specifically exercising legacy restart cleanup use this path. */
export function withLegacyFixtureDb<T>(db:DatabaseSync, write:(legacy:DatabaseSync)=>T):T {
  const file=db.prepare('PRAGMA database_list').all().find(row=>row.name==='main')?.file;
  if (!file) throw new Error('Legacy history requires a file-backed fixture database');
  const legacy=new DatabaseSync(String(file));
  try { return write(legacy); } finally { legacy.close(); }
}
export function insertLegacyFixtureMessage(threadId:string, message:Message):void {
  withLegacyFixtureDb(database(), legacy=>legacy.prepare('INSERT INTO messages(thread_id,id,at,role,kind,text,json) VALUES(?,?,?,?,?,?,?)').run(threadId,message.id,message.at,message.role,message.kind,message.text??null,JSON.stringify(message)));
  // The current writer may update an inherited card without changing its action;
  // this also keeps the real open-card and branch indexes in step for the test.
  updateMessage(threadId,message);
}
export function appendLegacyFixtureMessage(store:Store, threadId:string, input:Parameters<Store['appendMessage']>[1]):Message {
  const message=store.appendMessage(threadId,{...input,card:undefined});
  const inherited={...message,card:input.card};
  withLegacyFixtureDb(database(), legacy=>legacy.prepare('UPDATE messages SET json=? WHERE thread_id=? AND id=?').run(JSON.stringify(inherited),threadId,message.id));
  Object.assign(message,inherited);
  updateMessage(threadId,message);
  return message;
}
