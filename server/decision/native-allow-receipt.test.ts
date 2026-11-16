// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { baseCard, baseRun, card, d, fixture } from './fixture.ts';

it.each(['auto', 'full'] as const)('%s keeps a confirmed native Allow receipt when the turn completes before delivery returns', async level => {
  const f = fixture(level);
  try {
    const handle = f.open();
    expect(d.decide(handle, baseRun).kind).toBe('run');
    f.respond.mockImplementation(async () => {
      f.publish({ type: 'request.resolved', threadId: 't', providerInstanceId: 'p', turnId: 'turn', requestId: 'r', behavior: 'allow' });
      f.publish({ type: 'turn.completed', threadId: 't', providerInstanceId: 'p', turnId: 'turn' });
      return { state: 'accepted' };
    });
    await d.deliverRequest(handle);
    expect(d.readRequestExecution(handle)).toEqual({ outcome: 'run', delivery: 'accepted', answer: { behavior: 'allow' } });
    await d.deliverRequest(handle);
    expect(f.respond).toHaveBeenCalledTimes(1);
  } finally { f.dispose(); }
});

it('an unsolicited native Allow cannot confirm an undelivered card', async () => {
  const f = fixture('full');
  try {
    const handle = f.open();
    const ref = card(d.decide(handle, baseCard));
    await d.presentApproval(ref, { title: 'Fixture approval', subtitle: 'Review the fixture action' });
    f.publish({ type: 'request.resolved', threadId: 't', providerInstanceId: 'p', turnId: 'turn', requestId: 'r', behavior: 'allow' });
    await Promise.resolve();
    expect(d.readApproval(ref.approvalId)?.state).toBe('cancelled');
    expect(d.readRequestExecution(handle).delivery).toBe('none');
    expect(f.respond).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
