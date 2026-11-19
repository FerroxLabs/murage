// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { baseCard, d, fixture } from './fixture.ts';
import { isWorkspaceOwner, threadHumanPrincipal } from '../human-principals.ts';
import { turnAudienceIsOwner } from '../owner-audience.ts';
import { serviceNoLimits } from '../service-no-limits.ts';

const initiators: d.Initiator[] = [
  { k: 'owner-typed' }, { k: 'owner-channel-dm', channel: 'fixture' }, { k: 'webhook' }, { k: 'peer', fromBotId: 'source' }, { k: 'delegation' },
  { k: 'routine-run', form: 'run', sourceRunId: 'run', sourceBotId: 'b', recipientGeneration: 'g', trigger: 'schedule' },
];

function bind(initiator: d.Initiator, owner: boolean, principal = 'owner', roomOwnerOnly = true) {
  d.installProvenanceReader({
    turnGenerationFor: () => 'g',
    provenance: () => ({ generation: 'g', threadId: 't', botId: 'b', principal, roomOwnerOnly, at: 1, initiator }),
    live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner, level: 'unlimited',
      routine: { sourceRunId: 'run', sourceBotId: 'b', recipientGeneration: 'g', owner: true } }),
  });
}

for (const initiator of initiators) {
  it.each([
    ['live non-owner', false, 'owner', true],
    ['non-owner principal', true, 'guest', true],
    ['non-owner root', true, 'owner', false],
  ] as const)(`No limits ${initiator.k} refuses %s through the real readers`, (_name, owner, principal, root) => {
    const f = fixture();
    try {
      bind(initiator, owner, principal, root);
      const base = vi.fn((_registration: d.Registration) => baseCard());
      expect.soft(d.readTurnPolicy({ threadId: 't', generation: 'g' })).toMatchObject({ level: 'ask' });
      expect.soft(d.readTurnPolicy({ threadId: 't', generation: 'g' })?.permission.noLimits).not.toBe(true);
      expect.soft(serviceNoLimits('g', 't', 'b')).toBe(false);
      expect.soft(d.decide(f.open('non-owner'), base).kind).toBe('card');
      expect(base).toHaveBeenCalledOnce();
      expect(base.mock.calls[0][0].level).toBe('ask');
    } finally { f.dispose(); }
  });

  it(`No limits ${initiator.k} real owner still runs without a card`, () => {
    const f = fixture();
    try {
      bind(initiator, true);
      const base = vi.fn(baseCard);
      expect(d.readTurnPolicy({ threadId: 't', generation: 'g' })?.permission.noLimits).toBe(true);
      expect(serviceNoLimits('g', 't', 'b')).toBe(true);
      expect(d.decide(f.open('owner'), base).kind).toBe('run');
      expect(base).not.toHaveBeenCalled();
      expect(d.openApprovals('t')).toHaveLength(0);
    } finally { f.dispose(); }
  });
}

it('a consistent guest stays Ask on a No limits bot', () => {
  const f = fixture('unlimited', { k: 'guest' });
  try {
    d.installProvenanceReader({ turnGenerationFor: () => 'g',
      provenance: () => ({ generation: 'g', threadId: 't', botId: 'b', principal: 'guest', roomOwnerOnly: false, at: 1, initiator: { k: 'guest' } }),
      live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'guest', owner: false, level: 'unlimited' }) });
    expect(d.readTurnPolicy({ threadId: 't', generation: 'g' })).toMatchObject({ level: 'ask' });
    expect(d.decide(f.open('guest'), baseCard).kind).toBe('card');
  } finally { f.dispose(); }
});

it('an unbound thread defaults to the owner principal without proving the live turn is owner', () => {
  const f = fixture();
  try {
    const principal = threadHumanPrincipal('t', f.db);
    expect(isWorkspaceOwner(principal)).toBe(true);
    const owner = turnAudienceIsOwner('t', { origin: 'unproven' }, f.db);
    expect(owner).toBe(false);
    d.installProvenanceReader({ turnGenerationFor: () => 'g',
      provenance: () => ({ generation: 'g', threadId: 't', botId: 'b', principal: JSON.stringify(principal), roomOwnerOnly: true, at: 1, initiator: { k: 'webhook' } }),
      live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: JSON.stringify(principal), owner, level: 'unlimited' }) });
    expect(d.readTurnPolicy({ threadId: 't', generation: 'g' })).toMatchObject({ level: 'ask' });
    expect(d.decide(f.open('unbound'), baseCard).kind).toBe('card');
  } finally { f.dispose(); }
});
