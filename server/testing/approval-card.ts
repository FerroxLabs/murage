// SPDX-License-Identifier: AGPL-3.0-or-later
// Offline archive fixtures have their own database. Open through the same
// production record writer and authorization seam before inserting the card.
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { actionProjection } from '../../shared/permission-card.ts';
import { hash } from '../decision/bounds.ts';
import { assertCardAuthorized, initializeApprovals, insertRecord, isPermission } from '../decision/records.ts';

export function openFixtureApproval<T extends {id:string; kind:string; card?:unknown}>(db:DatabaseSync, threadId:string, message:T):T {
  if (!isPermission(message)) return message;
  initializeApprovals(db);
  const id = randomUUID(), request = (message.card as {requestId?:string}).requestId ?? id;
  const action = {...(message.card as object), approvalId:id, requestRef:request};
  const actionHash = hash(actionProjection(action));
  const result = {...message, card:{...action, actionHash}};
  insertRecord(db, {id, source_kind:'engine', service:null, thread_id:threadId, request_key:request, request_id:request,
    bot_id:'bot', generation:'fixture', actor_kind:'owner', actor_via:'owner-typed', level:'ask', why:'base',
    evidence:JSON.stringify({items:[],action:result.card,initiator:{k:'owner-typed'}}), registration_hash:hash(request), deny_rev:'[]',
    input_hash:hash({}), action_hash:actionHash, presented_action:null, chat_message_id:message.id, queue_kind:null, queue_ref:null,
    state:'open', answer:null, answer_id:null, delivery:'none', created_at:1, settled_at:null});
  assertCardAuthorized(db, threadId, result);
  return result as T;
}
