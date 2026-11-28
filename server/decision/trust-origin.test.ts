import { afterEach, expect, it, vi } from 'vitest';
import { d, fixture } from './fixture.ts';
import { folderTrustNoLimitsOwner, folderTrustOwner, trustOriginNow } from './trust-origin.ts';
import type { Initiator, ProvenanceReader } from './types.ts';

afterEach(() => vi.restoreAllMocks());
const identity = { threadId: 't', generation: 'g', botId: 'b' };
function bind(initiator: Initiator, overrides: Partial<ProvenanceReader> = {}) {
  d.installProvenanceReader({
    turnGenerationFor: () => 'g',
    provenance: () => ({ ...identity, principal: 'owner', roomOwnerOnly: true, at: 1, initiator }),
    live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: true, level: 'unlimited',
      routine: { sourceRunId: 'run', sourceBotId: 'source', recipientGeneration: 'g', owner: true } }),
    ...overrides,
  });
}
const routine = (k: 'routine-run' | 'routine-wake' | 'routine-webhook' | 'routine-peer' | 'project-room-routine', trigger: 'manual' | 'schedule' | 'webhook' = 'schedule'): Initiator =>
  ({ k, form: 'run', sourceRunId: 'run', sourceBotId: 'source', recipientGeneration: 'g', trigger }) as unknown as Initiator;

it.each([{ k: 'owner-typed' }, { k: 'owner-channel-dm', channel: 'fixture' }] as Initiator[])(
  'W-K0-1 owner-typed live owner -> owner-direct ($k)', initiator => {
    const f = fixture();
    try {
      bind(initiator);
      expect(trustOriginNow(identity)).toEqual({ kind: 'owner-direct', level: 'unlimited', noLimits: true,
        authorityGeneration: 'g', threadId: 't', botId: 'b' });
      f.setLevel('ask');
      d.installProvenanceReader({ turnGenerationFor: () => 'g', provenance: () => ({ ...identity, principal: 'owner', roomOwnerOnly: true, at: 1, initiator }),
        live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: true, level: 'ask' }) });
      expect(trustOriginNow(identity)).toMatchObject({ kind: 'owner-direct', level: 'ask', noLimits: false });
    } finally { f.dispose(); }
  });

it.each(['routine-run', 'routine-wake'] as const)('G3 owner-proven %s distinguishes manual and schedule', k => {
  const f = fixture();
  try {
    for (const trigger of ['manual', 'schedule'] as const) {
      bind(routine(k, trigger));
      expect(trustOriginNow(identity)).toMatchObject({ kind: trigger === 'manual' ? 'owner-routine-manual' : 'owner-routine-scheduled', noLimits: true });
    }
  } finally { f.dispose(); }
});

it.each([
  { k: 'guest' }, { k: 'other-human' }, { k: 'webhook' }, { k: 'delegation' }, { k: 'peer', fromBotId: 'source' },
  routine('routine-webhook'), routine('routine-peer'), routine('project-room-routine'), routine('routine-run', 'webhook'),
  { k: 'unproven' }, { k: 'routine' },
] as Initiator[])('W-K0-2 each ineligible kind -> ineligible ($k)', initiator => {
  const f = fixture();
  try {
    bind(initiator);
    expect(trustOriginNow(identity)).toMatchObject({ kind: 'ineligible', noLimits: false });
  } finally { f.dispose(); }
});

it.each(['stale', 'thread', 'bot', 'missing', 'provenance-throw', 'generation-throw', 'live-throw', 'non-owner', 'routine-unbound'])(
  'W-K0-3 stale generation / lookup throw -> ineligible (%s)', fault => {
    const f = fixture();
    try {
      const fail = () => { throw new Error('fixture-lookup'); };
      bind(fault === 'routine-unbound' ? routine('routine-run') : { k: 'owner-typed' }, {
        ...(fault === 'stale' ? { turnGenerationFor: () => 'new-generation' } : {}),
        ...(fault === 'missing' ? { provenance: () => undefined } : {}),
        ...(fault === 'provenance-throw' ? { provenance: fail } : {}),
        ...(fault === 'generation-throw' ? { turnGenerationFor: fail } : {}),
        ...(fault === 'live-throw' ? { live: fail } : {}),
        ...(fault === 'non-owner' || fault === 'routine-unbound' ? { live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: fault !== 'non-owner', level: 'unlimited' }) } : {}),
      });
      const q = { ...identity, ...(fault === 'thread' ? { threadId: 'elsewhere' } : {}), ...(fault === 'bot' ? { botId: 'elsewhere' } : {}) };
      expect(trustOriginNow(q)).toMatchObject({ kind: 'ineligible', noLimits: false });
    } finally { f.dispose(); }
  });

it('W-K0-3 noLimits flag alone -> ineligible', () => {
  const f = fixture();
  try {
    bind({ k: 'webhook' });
    const permissionNow = vi.fn(() => ({ noLimits: true }));
    expect(trustOriginNow({ ...identity, permissionNow } as typeof identity)).toMatchObject({ kind: 'ineligible', noLimits: false });
    expect(permissionNow).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});

// OVERREACH #8: the producer's owner fact, read through the real registered turn, is per initiator and independent of the access level.
it.each([
  ['owner-direct typed, Ask', { k: 'owner-typed' }, 'ask', true],
  ['owner-direct typed, Auto', { k: 'owner-typed' }, 'auto', true],
  ['owner-direct typed, Full', { k: 'owner-typed' }, 'full', true],
  ['owner-direct channel DM, Ask', { k: 'owner-channel-dm', channel: 'fixture' }, 'ask', true],
  ['scheduled routine, Ask', routine('routine-run', 'schedule'), 'ask', false],
  ['manual routine, Full', routine('routine-run', 'manual'), 'full', false],
  ['scheduled routine, No limits', routine('routine-run', 'schedule'), 'unlimited', true],
  ['guest, No limits', { k: 'guest' }, 'unlimited', false],
  ['guest, Ask', { k: 'guest' }, 'ask', false],
] as Array<[string, Initiator, 'ask' | 'auto' | 'full' | 'unlimited', boolean]>)('OVERREACH #8 owner fact: %s -> %s', (_name, initiator, level, owner) => {
  const f = fixture();
  try {
    d.installProvenanceReader({ turnGenerationFor: () => 'g', provenance: () => ({ ...identity, principal: 'owner', roomOwnerOnly: true, at: 1, initiator }),
      live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: true, level,
        routine: { sourceRunId: 'run', sourceBotId: 'source', recipientGeneration: 'g', owner: true } }) });
    expect(folderTrustOwner(trustOriginNow(identity))).toBe(owner);
    // the isolated-home gate (noCardPickKeys) reads the No limits fact alone: an owner turn below No limits keeps the real home
    expect(folderTrustNoLimitsOwner(trustOriginNow(identity))).toBe(level === 'unlimited' && owner);
  } finally { f.dispose(); }
});
