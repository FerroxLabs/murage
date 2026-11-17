// SPDX-License-Identifier: AGPL-3.0-or-later
// Owners: afix-nl-backup-b owns saved continuation admission and its dispatch consumer.
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { wiring } from './decision-wiring/fixture.ts';
import { LimitApplications, OwnerLimitContinuations, type OwnerLimitSnapshot } from './owner-limit-continuation.ts';

const snapshot: OwnerLimitSnapshot = { botId: 'bot', threadId: 'thread', generation: 'owner', sourceMessageId: 'source', sourceDigest: 'digest', principal: 'owner', policy: 'unlimited', epoch: 0 };
const primary = { instanceId: 'primary', model: 'fixture' }, backup = { instanceId: 'backup', model: 'fixture' };

function saved() {
  const db = new DatabaseSync(':memory:'), applications = new LimitApplications(() => db);
  let current = true;
  const tickets = new OwnerLimitContinuations(s => current && applications.epoch(s.threadId) === s.epoch);
  const ticket = tickets.authorizeRaisedCard(snapshot, true)!;
  const turn = { ...snapshot, selection: primary, sendIds: ['original-send'], ownerContinuation: ticket };
  const sent = vi.fn(async () => {}), task: any = { modelSelection: primary };
  let row: any;
  const globals = {
    structuredClone,
    ownerLimitContinuations: tickets, ownerLimitSnapshotCurrent: (s: OwnerLimitSnapshot) => current && applications.epoch(s.threadId) === s.epoch,
    limitApplications: applications, limitDispatches: new Map(), limitAnswersInFlight: new Set(), failoverPhoneCarry: new Map(),
    limitTurns: { observe() {}, get: () => turn, settle: () => turn },
    limitActiveDispatches: new Map(), directRuns: { get: () => ({ generation: 'owner' }) }, internalCapabilities: { activeGeneration: () => 'owner' }, turnSucceeded: () => false, gatewayBusyOfTurn: () => undefined,
    limitRefusalOfTurn: () => ({ until: 100, resetsAt: 100 }), backupVerdict: () => ({ ok: true }),
    limitOutcome: () => ({ kind: 'failover', to: backup }),
    store: { bot: () => ({ id: 'bot', limitBackup: { selection: backup } }), taskByThread: () => task,
      messageById: () => ({ role: 'user', text: 'fixture source', origin: 'owner' }),
      patchTask: (_b: string, _t: string, patch: object) => { Object.assign(task, patch); return task; }, appendMessage() {} },
    limitFailovers: { bySendId: () => undefined, get: () => row,
      startFrom: (_task: unknown, input: any) => row = { ...input, rowId: input.rowId ?? 'legacy', resendSendId: input.resendSendId ?? 'legacy-send', state: 'pending', hop: 1 },
      setState: (_id: string, state: string) => { row.state = state; }, cancel() {} },
    bus: { sourceForExecution() {} }, engineLabelOf: () => 'Fixture', failoverLine: () => 'Fixture continued',
    murageLine: (line: unknown) => line, rememberCarry() {}, failoverSendProof: () => ({}), acceptBotSend: sent,
  };
  const functions = wiring(['observeOwnerLimitProvider', 'onDirectLimitTurnCompleted', 'continueSelectedOwnerLimitTurn', 'failOverThread', 'resendFailover'], globals);
  return { db, applications, tickets, ticket, sent, task, globals, functions, turn, row: () => row, revoke: () => { current = false; } };
}

it('a saved No limits backup persists the captured source application before send acceptance', () => {
  const h = saved();
  try {
    h.functions.onDirectLimitTurnCompleted({ type: 'turn.completed', threadId: 'thread' });
    const application = h.applications.get('thread', 'source');
    expect(application).toMatchObject({ kind: 'automatic', snapshot, to: backup });
    expect(h.row()).toMatchObject({ ownerAuthorized: true, rowId: application!.rowId, resendSendId: application!.sendId });
    expect(h.sent).toHaveBeenCalledOnce();
    expect(h.globals.limitDispatches.get(application!.sendId)).toEqual({ application, ticket: h.ticket });
  } finally { h.db.close(); }
});

it.each(['restart', 'Stop', 'principal-revision'] as const)('saved backup after task commit refuses stale authority: %s', mode => {
  const h = saved();
  // Freeze just before acceptance, then reconstruct the boot resend boundary.
  const accepted = vi.fn(async () => {});
  try {
    h.functions.onDirectLimitTurnCompleted({ type: 'turn.completed', threadId: 'thread' });
    const row = h.row();
    expect(h.task.limitFailover).toBe(row.rowId);
    if (mode === 'Stop') { h.applications.cancel('thread'); h.tickets.cancel('thread'); }
    if (mode === 'principal-revision') h.revoke();
    const restarted = wiring(['resendFailover'], { ...h.globals, acceptBotSend: accepted,
      ...(mode === 'restart' ? { limitDispatches: new Map(), ownerLimitContinuations: new OwnerLimitContinuations(() => true) } : {}),
      readApproval: () => undefined,
    });
    restarted.resendFailover(row);
    expect(accepted).not.toHaveBeenCalled();
  } finally { h.db.close(); }
});

it('the English inventory names every continuation refusal diagnostic', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
  const inventory = readFileSync(new URL('../docs/verification/owner-limit-english.md', import.meta.url), 'utf8');
  const diagnostics = [...source.matchAll(/new DirectTurnSetupCancelled\('(backup continuation[^']+)'\)/g)].map(match => match[1]);
  expect(diagnostics).toHaveLength(3);
  for (const literal of diagnostics) expect(inventory).toContain('`' + literal + '`');
});

it('a failed provider transfer cannot fall back to an unfenced saved backup', () => {
  const h = saved();
  try {
    // A Stop, changed principal or mismatched provider source refuses transfer.
    // The retired ticket must remain attached as a failed authority marker.
    h.functions.observeOwnerLimitProvider({ type: 'turn.completed', threadId: 'thread', providerInstanceId: 'primary', turnId: 'provider-turn' });
    h.functions.onDirectLimitTurnCompleted({ type: 'turn.completed', threadId: 'thread' });
    expect(h.sent).not.toHaveBeenCalled();
    expect(h.applications.get('thread', 'source')).toBeUndefined();
  } finally { h.db.close(); }
});

it('a No limits turn without captured authority never enters the legacy saved-backup path', () => {
  const h = saved();
  try {
    Object.assign(h.turn, { ownerContinuationRequired: true, ownerContinuation: undefined });
    h.functions.onDirectLimitTurnCompleted({ type: 'turn.completed', threadId: 'thread' });
    expect(h.sent).not.toHaveBeenCalled();
    expect(h.applications.get('thread', 'source')).toBeUndefined();
  } finally { h.db.close(); }
});
