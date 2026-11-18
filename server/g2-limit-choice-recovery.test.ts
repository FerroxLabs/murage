// SPDX-License-Identifier: AGPL-3.0-or-later
// Limit-choice application and HTTP producer owner: tri3-g2.
import { expect, it, vi } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';
import { limitCardAnswer } from './limit-continuation.ts';
import { LimitFailoverStore } from './limit-failovers.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture as registryFixture, d, card as cardRef, baseCard } from './decision/fixture.ts';

function fixture() {
  const principal = { personId: 'workspace-owner', revision: 1 };
  const choice = { label: 'Backup', selection: { instanceId: 'backup', model: 'model' } };
  const row: any = { id: 'card', card: { title: 'Choose', options: ['Backup'], requestId: 'limit-fixture',
    limitOffer: { from: { instanceId: 'from', model: 'model' }, choices: [choice], sourceMessageId: 'source', resetsAt: null } } };
  const registered: any = { ref: { approvalId: 'approval' }, queue: { kind: 'event-limit', ref: 'queue' }, delivery: 'none' };
  const state = { busy: false, current: true, removed: false };
  const switchThread = vi.fn((): any => ({ rowId: 'move' }));
  const answerRegisteredApproval = vi.fn(async (_ref, answer) => {
    expect(row.limitApplication, 'application intent is durable before consuming the card').toMatchObject({ approvalId: 'approval', principal: JSON.stringify(principal) });
    registered.delivery = 'accepted'; registered.answer = answer;
    row.card.answered = 'Answered'; row.card.dismissed = true; state.removed = true;
    return 'answered';
  });
  const globals = {
    limitAnswersInFlight: new Set(), limitCardPhoneCarry: new Map(), LIMIT_WAIT_OPTION: 'Wait',
    prepareExplicitLimitApplication: (_bot: string, _thread: string, _source: string, to: unknown, rowId: string) => ({ rowId, to }),
    randomUUID: () => 'move', structuredClone, limitCardAnswer, lookupApproval: () => registered, readApprovalExecution: () => registered,
    producerQueue: () => ({ pendingApprovals: () => state.removed ? [] : [{ approvalId: 'approval', call: { tool: 'murage_limit_offer' },
      proof: { kind: 'background-job', id: 'source', botId: 'bot', threadId: 'thread' } }] }),
    serviceQueue: () => ({ pendingApproval: () => state.removed ? undefined : { approvalId: 'approval', call: { tool: 'murage_limit_offer' }, proof: { kind: 'background-job', id: 'source', botId: 'bot', threadId: 'thread' } } }),
    readContinuation: () => ({ principal: JSON.stringify(principal) }),
    threadHumanPrincipal: () => state.current ? principal : { ...principal, revision: 2 }, turnAudienceIsOwner: () => true,
    backupVerdict: () => ({ ok: true }), backupRefusalOf: (reason: string) => reason,
    directThreadBusy: () => state.busy, failOverThread: switchThread, answerRegisteredApproval,
    store: { cardForRequest: () => row, botByThread: () => ({ id: 'bot' }), patchBot: vi.fn(),
      patchMessage: (_thread: string, _id: string, patch: any) => { Object.assign(row, patch); } },
  };
  const api = (body: Record<string, unknown> = { message: 'Backup' }) => wiring(['answerLimitCard'], globals).answerLimitCard('thread', 'limit-fixture', 'answer', body);
  return { row, registered, state, switchThread, answerRegisteredApproval, api };
}

it('retries an accepted choice after application refusal, including a fresh process', async () => {
  const f = fixture();
  f.switchThread.mockReturnValueOnce({ refused: 'hidden' });
  expect(await f.api()).toMatchObject({ status: 409 });
  expect(f.row.limitApplication).toBeDefined();
  expect(await f.api()).toMatchObject({ status: 200, body: { outcome: 'switched' } });
  expect(f.answerRegisteredApproval).toHaveBeenCalledOnce();
  expect(f.switchThread).toHaveBeenCalledTimes(2);
  expect(f.row.limitApplication).toBeUndefined();
});

it('rechecks busy state after accepting the choice and keeps application retryable', async () => {
  const f = fixture(), accept = f.answerRegisteredApproval.getMockImplementation()!;
  f.answerRegisteredApproval.mockImplementation(async (...args) => { const result = await accept(...args); f.state.busy = true; return result; });
  expect(await f.api()).toMatchObject({ status: 409 });
  expect(f.switchThread).not.toHaveBeenCalled();
  f.state.busy = false;
  expect(await f.api()).toMatchObject({ status: 200 });
  expect(f.answerRegisteredApproval).toHaveBeenCalledOnce();
});

it('recovers after a crash between the accepted receipt and the application', async () => {
  const f = fixture();
  f.switchThread.mockImplementationOnce(() => { throw new Error('fixture crash'); });
  await expect(f.api()).rejects.toThrow('fixture crash');
  expect(await f.api()).toMatchObject({ status: 200 });
  expect(f.answerRegisteredApproval).toHaveBeenCalledOnce();
});

it('never applies an accepted choice after its principal changes', async () => {
  const f = fixture(), accept = f.answerRegisteredApproval.getMockImplementation()!;
  f.answerRegisteredApproval.mockImplementation(async (...args) => { const result = await accept(...args); f.state.current = false; return result; });
  expect(await f.api()).toMatchObject({ status: 409 });
  expect(f.switchThread).not.toHaveBeenCalled();
  expect(await f.api()).toMatchObject({ status: 409 });
});

it('clears an unconfirmed application after terminal delivery failure', async () => {
  const f = fixture();
  f.answerRegisteredApproval.mockImplementation(async () => { f.registered.delivery = 'failed'; return 'unavailable'; });
  expect(await f.api()).toMatchObject({ status: 503 });
  expect(f.row.limitApplication).toBeUndefined();
  expect(f.switchThread).not.toHaveBeenCalled();
});

it('reuses one durable failover row and send id across an interrupted task save', () => {
  const dir = mkdtempSync(join(tmpdir(), 'limit-application-'));
  try {
    const moves = new LimitFailoverStore(() => dir), resend = vi.fn();
    let task: any = {};
    const patchTask = vi.fn((_bot, _thread, patch) => { task = { ...task, ...patch }; return true; });
    patchTask.mockImplementationOnce(() => { throw new Error('fixture save interrupted'); });
    const { failOverThread } = wiring(['failOverThread'], {
      backupVerdict: () => ({ ok: true }), limitFailovers: moves, structuredClone,
      settleCarriedRefusal: () => true, failoverRefusalSteps: () => ({}),
      murageLine: (row: unknown) => row, failoverLine: () => 'Switched', engineLabelOf: () => 'Fixture',
      rememberCarry: vi.fn(), failoverPhoneCarry: new Map(), resendFailover: resend,
      store: { messageById: () => ({}), taskByThread: () => task, patchTask, appendMessage: vi.fn() },
    });
    const turn = { botId: 'bot', threadId: 'thread', sourceMessageId: 'source', selection: { instanceId: 'from', model: 'model' }, rowId: 'move' };
    const to = { instanceId: 'backup', model: 'model' };
    expect(() => failOverThread(turn, to, null, 1)).toThrow('fixture save interrupted');
    const first = moves.get('move')!;
    expect(failOverThread(turn, to, null, 2)).toMatchObject({ rowId: first.rowId, resendSendId: first.resendSendId });
    expect(failOverThread(turn, to, null, 3)).toMatchObject({ rowId: first.rowId, resendSendId: first.resendSendId });
    expect(moves.list()).toHaveLength(1);
    expect(resend.mock.calls.every(([row]) => row.resendSendId === first.resendSendId)).toBe(true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('keeps application state durable without changing the signed card action', async () => {
  const f = registryFixture('ask');
  try {
    const ref = cardRef(d.decide(f.open(), baseCard));
    await d.presentApproval(ref, { title: 'Fixture', subtitle: 'Fixture' });
    const record = d.readApproval(ref.approvalId)!;
    const before = f.store.messageById('t', record.chatMessageId)!;
    const intent = { approvalId: ref.approvalId, principal: 'owner', rowId: 'move', answer: {
      kind: 'engine' as const, choice: { label: 'Backup', selection: { instanceId: 'backup', model: 'model' }, billing: 'own-key' as const }, nextTime: true, routines: false } };
    f.store.patchMessage('t', before.id, { limitApplication: intent });
    await d.answerApproval(ref, { behavior: 'allow' });
    const after = f.store.messageById('t', before.id)!;
    expect(after.limitApplication).toEqual(intent);
    expect(after.card?.actionHash).toBe(before.card?.actionHash);
    expect(after.card?.answered).toBeTruthy();
    expect(d.readApprovalExecution(ref).delivery).toBe('accepted');
    // The SQL/action boundary still rejects application data inside the card.
    expect(() => f.store.patchMessage('t', before.id, { card: { ...after.card!, limitApplication: intent } as any })).toThrow();
  } finally { f.dispose(); }
});

it('retries the accepted flags after a refreshed client loses its checkbox state', async () => {
  const f = fixture();
  f.switchThread.mockReturnValueOnce({ refused: 'hidden' });
  expect(await f.api({ message: 'Backup', limitNextTime: true, limitRoutines: true })).toMatchObject({ status: 409 });
  expect(f.row.limitApplication.answer).toMatchObject({ nextTime: true, routines: true });
  expect(await f.api()).toMatchObject({ status: 200 });
  expect(f.answerRegisteredApproval).toHaveBeenCalledOnce();
});
