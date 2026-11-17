// SPDX-License-Identifier: AGPL-3.0-or-later
// Notification fixture consumer owner: c4-misc-a. Canonical record producer owner: c3-decision.
import type { ApprovalNotificationRecord } from '../approval-notification-state.ts';

export function approvalNotificationFixture<T extends { botId: string; threadId: string; requestId: string; messageId: string }>(input: T) {
  const identity = { approvalId: `approval-${input.messageId}`, requestRef: `native-${input.requestId}`, actionHash: 'a'.repeat(64) };
  const payload = { ...input, ...identity };
  const record: ApprovalNotificationRecord = {
    ref: { approvalId: identity.approvalId } as ApprovalNotificationRecord['ref'], state: 'open',
    botId: input.botId, threadId: input.threadId, chatMessageId: input.messageId,
    requestId: identity.requestRef, actionHash: identity.actionHash,
  };
  return { payload, identity, record };
}
