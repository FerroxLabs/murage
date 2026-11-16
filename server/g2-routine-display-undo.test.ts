// SPDX-License-Identifier: AGPL-3.0-or-later
// Opaque service HTTP consumer: tri3-g2. Display projection producer: l5a.
import { expect, it } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';
it.each(['applied', 'no-record', 'other-queue', 'other-thread', 'other-card', 'other-request', 'other-action', 'forged-handle', 'extra-field', 'not-routine'])(
  'resolves only the durable routine Undo identity: %s', mode => {
    const row: any = { id: 'host-card', card: { requestId: 'private-request', actionHash: 'action', routineRequest: {} } };
    const record: any = { threadId: 'thread', chatMessageId: row.id, requestId: row.card.requestId,
      actionHash: 'action', queue: { kind: 'routine' }, state: 'answered', delivery: 'accepted' };
    if (mode === 'other-queue') record.queue.kind = 'engine';
    if (mode === 'other-thread') record.threadId = 'other';
    if (mode === 'other-card') record.chatMessageId = 'other';
    if (mode === 'other-request') record.requestId = 'other';
    if (mode === 'other-action') record.actionHash = 'other';
    if (mode === 'not-routine') delete row.card.routineRequest;
    const body: any = { requestHandle: mode === 'forged-handle' ? 'p.other' : 'p.host-card', action: 'undo' };
    if (mode === 'extra-field') body.requestId = 'forged';
    const { routineDisplayUndo } = wiring(['routineDisplayUndo'], { lookupApproval: () => mode === 'no-record' ? undefined : record });
    const resolved = routineDisplayUndo('thread', row, body);
    if (mode === 'applied') expect(resolved).toEqual({ ok: true, body: { requestId: 'private-request', behavior: 'undo' } });
    else expect(resolved).toMatchObject({ ok: false, status: mode === 'forged-handle' || mode === 'extra-field' ? 400 : 409 });
  });
