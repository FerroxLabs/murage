// SPDX-License-Identifier: AGPL-3.0-or-later
// Channel-manager unit tests mirror a persisted approval, as the channel
// protocol requires. Keep the real lookup and card authorization guard active.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { DATA_DIR } from '../config.ts';
import { database } from '../database.ts';
import { Store } from '../store.ts';
import type { TelegramApproval } from '../telegram-approvals.ts';
import { openFixtureApproval } from './approval-card.ts';

export function channelApprovalFixture<T extends TelegramApproval>(approval:T):T & Required<Pick<TelegramApproval,'approvalId'|'requestRef'|'actionHash'>> {
  mkdirSync(DATA_DIR,{recursive:true});
  const threadId = randomUUID();
  const message = openFixtureApproval(database(), threadId, {
    id:approval.id, kind:'options' as const, role:'bot' as const,
    card:{title:'Fixture approval',subtitle:approval.summary,requestId:randomUUID(),
      tool:'Write',options:['Allow','Deny'],...(approval.questions?{questions:approval.questions}:{})},
  });
  new Store().appendMessage(threadId,message,message.id);
  const card:unknown=message.card;
  if(!card || typeof card!=='object' || !('approvalId' in card) || typeof card.approvalId!=='string'
    || !('requestRef' in card) || typeof card.requestRef!=='string'
    || !('actionHash' in card) || typeof card.actionHash!=='string')throw new Error('FIXTURE_APPROVAL_AUTHORIZATION_MISSING');
  const {approvalId,requestRef,actionHash}=card;
  return {...approval,approvalId,requestRef,actionHash};
}

// Producer requests now present only after their registered decision/queue
// promises settle. Drain microtasks without advancing a person's wait clock.
export async function flushApprovalPresentation():Promise<void> {
  for(let i=0;i<20;i++)await Promise.resolve();
}
