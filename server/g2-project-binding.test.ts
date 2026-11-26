// SPDX-License-Identifier: AGPL-3.0-or-later
// Project dispatch producer owner: tri3-g2. Native adapter owner: tri3-g1.
import { expect, it, vi } from 'vitest';
import { LimitTurns } from './limit-continuation.ts';
import { wiring } from './decision-wiring/fixture.ts';
import { isFluxHost } from './flux-usage-tags.ts';
import { isFluxModel } from './flux-surface.ts';
import { assertRecallDispatch } from './memory/recall-readiness.ts';

it.each(['admitted', 'resumed', 'missing-owner', 'missing-retained', 'missing-admission'])('project writer is built only after consuming admission: %s', async mode => {
  const events: string[] = [];
  const binding = { identity: { botId: 'bot', threadId: 'thread', dispatchGeneration: 'generation' } };
  const owner = { botId: 'bot', generation: 'generation', ownerAudience: true };
  const lease = { admissionNotLaunched: () => {} };
  const system = 'Fixture persona';
  const built = {
    threadId: 'thread', text: 'Fixture', warmIdentity: {}, background: false, usageFeature: 'chat', fluxCaptureHold: true,
    recall: 'off', system, recallPrepared: { system, integrations: [], historyPrepared: mode === 'resumed', resumed: mode === 'resumed' },
  };
  const fence = { retained: mode === 'missing-retained' ? undefined : {}, invoked: () => events.push('invoked') };
  const sourceContext = { attachment: {} };
  const assertEngineInput = vi.fn((input: unknown) => { expect(input).toBe(fence); });
  const instance = { instanceId: 'fixture-instance', driverKind: 'fixture', adapter: { sendTurn: async (input: object) => {
    events.push('send'); expect(input).toMatchObject({ releaseBinding: binding, mountAdmission: { admitted: true } });
    expect(input).toMatchObject({ sourceContext });
    return { turnId: 'native-turn' };
  } } };
  const { sendProjectUsageTurn } = wiring(['sendProjectUsageTurn', 'spawnFolder', 'dispatchSpendTurn', 'claimOwnerLimitDispatch', 'validateOwnerLimitDispatch', 'retainInternalResponseBinding'], {
    limitTurns: new LimitTurns(), limitActiveDispatches: new Map(),
    // Actual spend dispatch wrapper; these fixture turns use a native engine.
    isFluxHost, isFluxModel, fluxKey: () => { throw new Error('Native fixture requested a Flux key'); },
    process: { env: {} }, PORT: 12345, homeExecutionGate: undefined,
    assertConsumingBinding: (actual: unknown) => { expect(actual).toBe(binding); },
    assertEngineInput, assertRecallDispatch, bus: { admitNewTurn: (instanceId: string, threadId: string) => {
      expect(instanceId).toBe('fixture-instance'); expect(threadId).toBe('thread'); return sourceContext;
    } },
    internalTurnOwners: new Map(mode === 'missing-owner' ? [] : [['thread', owner]]),
    checkedOpenTurns: () => [{ turnId: 'lineage' }],
    bindConsumingTurn: (options: any) => {
      events.push('bind');
      expect(options.identity).toEqual({ botId: 'bot', threadId: 'thread', dispatchGeneration: 'generation', lineageTurnIds: ['lineage'], adapterLeaseId: 'generation' });
      return binding;
    },
    database: () => ({}), internalCapabilities: { activeGeneration: () => 'generation' }, providerRouteIsCurrent: () => true,
    refuseRetainedTurn: () => {}, internalResponseBindings: new Map(),
    admittedLedgerLeases: new Map(mode === 'missing-admission' ? [] : [['generation', lease]]),
    ledgerCompletionSources: new WeakMap([[lease, sourceContext]]),
    refuseConsumingTurn: () => { throw new Error('MEMORY_CONTEXT_REVOKED'); },
    createMcpMountAdmission: (actual: object) => { expect(actual).toBe(binding); return { admitted: true }; }, proxyReleaseAuthority: {},
    fencedTurnInput: (input: any) => {
      events.push('fence'); expect(input.releaseBinding).toBe(binding); expect(input.admissionNotLaunched).toBe(lease.admissionNotLaunched);
      return input;
    },
    turnRequestByGeneration: new Map(), delegationWatch: new Map(), syncAskRequests: new Map(),
    turnIsBackground: () => false, engineLimitText: () => null, engineLimitLine: () => '',
    fluxFirstTokenProbe: { begin: () => {} }, fluxMemoryCapture: { begin: () => {} },
    projectGroupForThread: () => null, sharedOwnerUsageTurn: () => null, store: {},
  });
  if (mode === 'admitted' || mode === 'resumed') {
    expect(await sendProjectUsageTurn(instance, built, fence)).toEqual({ turnId: 'native-turn' });
    expect(events).toEqual(['bind', 'fence', 'invoked', 'send']);
  } else {
    await expect(sendProjectUsageTurn(instance, built, fence)).rejects.toThrow('MEMORY_CONTEXT_REVOKED');
    expect(events).not.toContain('fence'); expect(events).not.toContain('send');
  }
});
