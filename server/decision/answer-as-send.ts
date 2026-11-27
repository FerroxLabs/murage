// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from 'node:crypto';
import { database, transaction } from '../database.ts';
import { afterCommit } from '../tx-scope.ts';
import type { Store } from '../store.ts';
import { deleteContinuation, producerQueue, readApprovalExecution, type ApprovalRef, type ApprovalAnswer, type ContinuationKey } from './index.ts';
import * as records from './records.ts';

/** A host question has no provider reply to deliver. Its only effect is one
 * owner send, committed with its durable answer. A failed send claim leaves
 * both the question and the queue untouched; no machine approval is minted.
 */
export function claimAnswerAsSend(store:Store,ref:ApprovalRef,answer:ApprovalAnswer,late:boolean,claim:()=>void):boolean {
 readApprovalExecution(ref);
 const row=records.readRecord(database(),ref.approvalId);
 if(!row)throw new Error('answer-send-record-missing');
 const payload=JSON.parse(row.evidence),action=payload.action;
 if(row.source_kind!=='service'||row.queue_kind!=='peer'||action.answerAsSend!==true||answer.behavior!=='answer')throw new Error('answer-send-source-mismatch');
 if(row.delivery==='accepted'||(late?!['expired','cancelled'].includes(row.state):row.state!=='open'))return false;
 const s=store,m=records.decisionMessage(database(),s,row,{buildIndex:false});
 if(!m?.card||m.card.approvalId!==row.id)throw new Error('answer-send-card-missing');
 transaction(db=>{
  claim();
  records.updateRecord(db,row.id,{state:'answered',answer:JSON.stringify(answer),answer_id:randomUUID(),delivery:'accepted',settled_at:Date.now()});
  s.patchMessagePoint(row.thread_id,row.chat_message_id,{card:{...m.card!,answered:late?'expired':'answer',dismissed:false,
   answers:answer.answers,sendId:`ask-${m.id}`,...(late?{sentAsMessage:true}:{} )}});
  afterCommit(()=>{
   const q=producerQueue('peer'),item=q.pendingApprovals().find(item=>item.approvalId===row.id);
   if(item)void q.cancel(item,'cancelled').then(async()=>{
    const proof=item.proof as ContinuationKey;
    if(proof.kind==='background-job'&&proof.id.startsWith('question:')
     && !q.pendingApprovals().some(other=>JSON.stringify(other.proof)===JSON.stringify(item.proof)))await deleteContinuation(proof);
   }).catch(()=>{});
  });
 });
 return true;
}
