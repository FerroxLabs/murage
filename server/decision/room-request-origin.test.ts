// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it } from 'vitest';
import { wiring } from '../decision-wiring/fixture.ts';
import { isOwnerOrigin } from '../store.ts';
import { fixture, d, baseCard } from './fixture.ts';

const request = { verb: 'room_turn', fromKind: 'owner', origin: 'desktop' };
const initiatorFor = () => wiring(['decisionRoomRequestInitiator'], { isOwnerOrigin }).decisionRoomRequestInitiator;

it('F4 verified owner room request runs at No limits and a wipe still cards', () => {
  const initiator = initiatorFor()(request, true, 'desktop');
  expect(initiator).toEqual({ k: 'owner-typed' });
  const f = fixture('unlimited', initiator);
  expect(d.readTurnPolicy({ threadId: 't', generation: 'g' })).toMatchObject({ actor: 'owner', level: 'unlimited', permission: { noLimits: true } });
  expect(d.decide(f.open('owner-room', { command: 'touch /fixture/room-note' }), baseCard).kind).toBe('run');
  expect(d.decide(f.open('owner-room-wipe', { command: 'rm -rf ~' }), baseCard).kind).toBe('card');
  f.dispose();
});

it.each([
  ['another human', { ...request }, false, 'desktop', false],
  ['guest', { ...request, origin: 'unproven' }, false, 'unproven', false],
  ['unproven sender in an owner thread', { ...request, origin: 'unproven' }, true, 'unproven', true],
  ['new owner line after an unproven source', { ...request }, true, 'unproven', true],
  ['unproven request with a proven source', { ...request, origin: 'unproven' }, true, 'desktop', true],
  ['missing source proof', { ...request }, true, undefined, true],
] as const)('F4 %s room request stays Ask', (_name, row, audience, origin, liveOwner) => {
  const initiator = initiatorFor()(row, audience, origin);
  expect(initiator).toEqual({ k: 'other-human' });
  const f = fixture('unlimited', initiator);
  f.setOwner(liveOwner);
  expect(d.readTurnPolicy({ threadId: 't', generation: 'g' })).toMatchObject({ level: 'ask', permission: { routeAsks: true, askLevel: true } });
  expect(d.decide(f.open('other-room', { command: 'touch /fixture/room-note' }), baseCard).kind).toBe('card');
  f.dispose();
});

it('F4 peer requests and routine sources keep their own initiator', () => {
  const read = initiatorFor();
  expect(read({ ...request, fromKind: 'bot', fromBotId: 'peer' }, true, 'desktop')).toEqual({ k: 'peer', fromBotId: 'peer' });
  expect(read({ ...request, verb: 'routine' }, true, 'desktop')).toBeUndefined();
  expect(read(undefined, true, 'desktop')).toBeUndefined();
});
