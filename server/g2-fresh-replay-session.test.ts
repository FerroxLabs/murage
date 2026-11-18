// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import * as lineage from './memory/replay-lineage.ts';
import { FreshReplaySessionConfirmation } from './memory/fresh-replay-session.ts';
import { sessionKeyOf } from './memory/session-incarnation.ts';
afterEach(() => vi.restoreAllMocks());
import { wiring } from './decision-wiring/fixture.ts';

it('confirms only the written replay of the exact accepted fresh provider turn', () => {
  // MAIN RULING INT-CONFLICT-DEFAULT 124908c920 / 975455bdb9: exercise G7's reviewed accepted-write caller; retain every negative correlation.
  const confirmFreshReplaySession = vi.spyOn(lineage, 'confirmFreshReplaySession').mockImplementation(() => {});
  const proof = { threadId: 'thread', messageIds: ['line'] } as unknown as lineage.SendReplayProof;
  const dispatch = new FreshReplaySessionConfirmation(proof, 'engine', () => {});
  dispatch.accepted('another-turn');
  dispatch.sessionStarted('provider-turn', sessionKeyOf('thread', 'engine', 'incarnation-key'), true);
  expect(confirmFreshReplaySession).not.toHaveBeenCalled();
  dispatch.engineWritten();
  expect(confirmFreshReplaySession).not.toHaveBeenCalled();
  dispatch.accepted('provider-turn');
  expect(confirmFreshReplaySession).toHaveBeenCalledExactlyOnceWith('thread', 'engine', 'incarnation-key', proof);
});

it('leaves a replay revoked after the write unconfirmed', () => {
  const confirmFreshReplaySession = vi.spyOn(lineage, 'confirmFreshReplaySession').mockImplementation(() => { throw new Error('SEND_REPLAY_CHANGED'); });
  const dispatch = new FreshReplaySessionConfirmation({ threadId: 'thread' } as lineage.SendReplayProof, 'engine', () => {});
  dispatch.accepted('provider-turn'); dispatch.engineWritten();
  // MAIN RULING INT-CONFLICT-DEFAULT 124908c920 / 975455bdb9: the reviewed G7 caller propagates refusal before confirmation; it never stamps revoked replay.
  expect(() => dispatch.sessionStarted('provider-turn', sessionKeyOf('thread', 'engine', 'incarnation-key'), true)).toThrow('SEND_REPLAY_CHANGED');
  expect(confirmFreshReplaySession).toHaveBeenCalledOnce();
});

it('keeps the captured native turn and matching engine in the approval display', () => {
  const engine = { instanceId: 'engine', driverKind: 'fixture', model: 'model', capabilityHash: 'fixture-capability' };
  const { decisionEngineView } = wiring(['decisionEngineView'], { turnEngineByThread: new Map([['thread', engine]]), cardDetail: () => 'fixture' });
  const registration = { deny: [], snapshot: { event: { requestType: 'permission', threadId: 'thread', turnId: 'provider-turn', providerInstanceId: 'engine' } } };
  expect(decisionEngineView(registration)).toMatchObject({ turnId: 'provider-turn', engine });
  registration.snapshot.event.providerInstanceId = 'old-engine';
  expect(decisionEngineView(registration)).not.toHaveProperty('engine');
});


it('confirms the exact explicit inputs alongside replayed history', () => {
  const proof = { messageIds: ['history'], copyRoots: new Map() };
  const captured = { ...proof, messageIds: ['history', 'current', 'queued'], excludedIds: new Set() };
  const assertSendReplayProof = vi.fn(), captureSendReplayProof = vi.fn(() => captured), confirmFreshReplaySession = vi.fn();
  const { confirmWrittenReplaySession } = wiring(['confirmWrittenReplaySession'], { assertSendReplayProof, captureSendReplayProof, confirmFreshReplaySession });
  confirmWrittenReplaySession({ threadId: 'thread', instanceId: 'engine', proof, inputs: ['current', 'queued', 'current'], written: true,
    acceptedTurnId: 'provider-turn', session: { turnId: 'provider-turn', key: 'incarnation-key' } });
  expect(assertSendReplayProof).toHaveBeenCalledExactlyOnceWith(proof);
  expect(captureSendReplayProof).toHaveBeenCalledExactlyOnceWith('thread', ['history', 'current', 'queued'], proof.copyRoots);
  expect(confirmFreshReplaySession).toHaveBeenCalledExactlyOnceWith('thread', 'engine', 'incarnation-key', captured);
});

it('does not confirm an explicit input that is still excluded', () => {
  const proof = { messageIds: ['history'], copyRoots: new Map() }, confirmFreshReplaySession = vi.fn();
  const { confirmWrittenReplaySession } = wiring(['confirmWrittenReplaySession'], { assertSendReplayProof: vi.fn(),
    captureSendReplayProof: vi.fn(() => ({ ...proof, excludedIds: new Set(['current']) })), confirmFreshReplaySession });
  confirmWrittenReplaySession({ threadId: 'thread', instanceId: 'engine', proof, inputs: ['current'], written: true,
    acceptedTurnId: 'provider-turn', session: { turnId: 'provider-turn', key: 'incarnation-key' } });
  expect(confirmFreshReplaySession).not.toHaveBeenCalled();
});
