// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Message, Store } from '../store.ts';
import type { InternalCapability } from '../internal-capabilities.ts';
import type { ProducerAuthority, PendingQueueApproval } from '../decision/types.ts';
import { readApproval, settle } from '../decision/index.ts';
import { botAccessApprovalQueue } from '../bot-access.ts';
import type { HighLevelActions, ActionReview } from './actions.ts';

/** HighLevel retains its exact desktop digest and held request. Its visible
 * card goes through the same durable access-approval queue as other apps. No
 * CRM field values or credentials are copied into the decision journal. */
export function highlevelDecisionReview(options: {
 store: Store; actions: HighLevelActions;
 authority(claim: InternalCapability): ProducerAuthority | undefined;
}) {
 const pending = new Map<string, PendingQueueApproval>();
 const queue = botAccessApprovalQueue(options.store);
 return {
  present(claim: InternalCapability, row: Omit<Message, 'id' | 'at'>, review: ActionReview & { catastrophe?: boolean }): Message | undefined {
   const { title, subtitle, detail, approvalId: _approvalId, requestRef: _requestRef, actionHash: _actionHash,
    answered: _answered, answeredAt: _answeredAt, dismissed: _dismissed, orphaned: _orphaned, ...action } = row.card!;
   const request = queue.open({ authority: options.authority(claim), ref: String(action.requestId),
    // This annotation is host-derived from the native wipe check. Ordinary
    // deletes retain their real tool name and cannot become bulk-wipe cards.
    tool: review.catastrophe ? 'HIGHLEVEL_DELETE_ALL' : review.tool,
    input: { actionId: review.actionId, operation: review.operation, reviewDigest: review.reviewDigest },
    action, view: { title, subtitle: subtitle ?? '', ...(detail ? { detail } : {}) },
    base: { approve: null, source: 'no-grant' } });
   if (request.outcome.kind === 'run') return;
   if (request.outcome.kind !== 'card') throw Error('HighLevel review authority is unavailable.');
   const item = queue.presentNow(request, request.outcome.ref, (_item, answer) => {
    const current = options.actions.get(review.actionId);
    if (answer.behavior === 'deny') { options.actions.deny(review.actionId); return; }
    if (answer.behavior !== 'allow') throw Error('HighLevel requires an exact approval.');
    if (current?.phase === 'awaiting_approval') options.actions.approve(review.actionId, review.reviewDigest);
    else if (!current || !['approved','dispatching','applied','read_done'].includes(current.phase)) throw Error('HighLevel review has ended.');
   });
   pending.set(review.actionId, item);
   const record = readApproval(item.approvalId);
   return record ? options.store.messageById(claim.threadId, record.chatMessageId) : undefined;
  },
  closed(actionId: string): void {
   const item = pending.get(actionId); if (!item) return;
   pending.delete(actionId);
   const record = readApproval(item.approvalId);
   if (record?.state === 'open') {
    void settle(record.ref, 'cancelled')
     .catch(error => console.error('[highlevel] review close failed', error));
   }
  },
 };
}
