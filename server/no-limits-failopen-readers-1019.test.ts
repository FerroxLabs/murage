// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { d, fixture } from './decision/fixture.ts';
import { wiring } from './decision-wiring/fixture.ts';
import { DATA_DIR } from './config.ts';
import { noLimitsAppliesTo } from './no-limits-origin.ts';
import { applyResolvedRoutineCeilings, applyRoutinePermissionMode, effectiveRoutinePermissionMode } from './routine-permissions.ts';
import { createBrowserExtensionService } from './browser-extension-service.ts';
import { serviceThreadNoLimitsPolicy } from './service-no-limits.ts';
import { ownerNoLimitsSource } from './execution-audience.ts';
import { privateTestDirectorySync } from './testing/private-test-dir.ts';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello, ExtensionObject } from '../shared/browser-extension-protocol.ts';

function liveReader(initiator: d.Initiator = { k: 'owner-typed' }) {
  const state = { owner: false, principal: 'owner', root: true, generation: 'g', present: true };
  d.installProvenanceReader({
    turnGenerationFor: () => state.present ? state.generation : undefined,
    provenance: () => ({ generation: state.generation, threadId: 't', botId: 'b', principal: state.principal,
      roomOwnerOnly: state.root, at: 1, initiator }),
    live: () => state.present ? { botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: state.owner, level: 'unlimited' } : undefined,
  });
  return state;
}

function browserReadTurn(ceiling: 'routine' | 'peer' | 'ask') {
  const settings = { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true };
  // Capture the options at the real BrowserExtensionIntegration constructor.
  // Both readTurn and ownPermissionFacts are evaluated from production index.ts.
  const api = wiring(['browserExtensionRuntime', 'ownPermissionFacts'], {
    BrowserExtensionIntegration: class { constructor(options: object) { return options; } },
    browserExtension: undefined, DATA_DIR, join, createHash,
    browserExtensionRuntimeDir: () => DATA_DIR, approvalBus: {}, store: {},
    createPanelAvatars: () => ({}), helperEncode: () => ({}), panelAvatarSource: () => ({}),
    attachmentRemovalState() {}, probeServedImage() {}, readAttachment() {}, ATTACHMENTS_HOME: DATA_DIR,
    runningProviderTurnOf: () => 'turn', PORT: 1,
    routineThreadSignal: () => () => false, isUnattended: () => false,
    internalCapabilities: { activeGeneration: () => 'g' },
    peerContactSettings: () => settings,
    routineRunLevel: () => ceiling === 'peer' ? null : { mode: ceiling === 'ask' ? 'ask' : 'unlimited' },
    routinePeerSources: new Map(ceiling === 'peer' ? [['t', { permissionMode: 'unlimited' }]] : []),
    decisionProvenance: new Map([['g', { initiator: { k: 'owner-typed' } }]]),
    decisionNoLimitsOrigin: () => 'owner', readTurnPolicy: d.readTurnPolicy,
    applyRoutinePermissionMode, applyResolvedRoutineCeilings, effectiveRoutinePermissionMode, noLimitsAppliesTo,
  });
  return api.browserExtensionRuntime().readTurn as (botId: string, threadId: string) => { noLimits: boolean; origin: 'owner' };
}

it.each(['routine', 'peer'] as const)('browser readTurn keeps a live refusal under an unlimited %s mode', ceiling => {
  const f = fixture();
  try {
    const state = liveReader();
    const readTurn = browserReadTurn(ceiling);
    expect(d.readTurnPolicy({ threadId: 't', generation: 'g' })).toMatchObject({ level: 'ask' });
    expect.soft(readTurn('b', 't').noLimits).toBe(false);
    state.owner = true;
    expect(readTurn('b', 't').noLimits).toBe(true);
    state.owner = false;
    expect(readTurn('b', 't').noLimits).toBe(false);
  } finally { f.dispose(); }
});

it('browser readTurn also respects a stricter routine on a real owner turn', () => {
  const f = fixture();
  try { liveReader().owner = true; expect(browserReadTurn('ask')('b', 't').noLimits).toBe(false); }
  finally { f.dispose(); }
});

it('browser read consent cannot restore No limits after readTurn refuses it', async () => {
  const f = fixture();
  const state = liveReader();
  const readTurn = browserReadTurn('peer');
  const fetchPage = vi.fn(async () => new Response('Fixture page.', { headers: { 'content-type': 'text/markdown' } }));
  vi.stubGlobal('fetch', fetchPage);
  const askSite = vi.fn(async () => 'waiting' as const);
  const service = await createBrowserExtensionService({
    workspaceId: 'fixture', stateFile: join(privateTestDirectorySync(join(DATA_DIR, 'read-extension-')).directory, 'state.json'),
    readTurn: context => readTurn(context.botId, context.threadId), askSite,
    broker: {
      drop: () => false,
      profiles: (): BrowserExtensionHello[] => [{ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: 'fixture', capabilities: ['scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'engine_cdp_v1', 'unexpected_input_pause', 'ordered_requests_v1'] }],
      async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
        const tab = { tabId: 1, navigationEpoch: 1, origin: 'https://fixture.test', url: 'https://fixture.test/' };
        let value: ExtensionObject = {};
        if (command.operation === 'cdp') {
          const { method, params } = command.params as { method: string; params: Record<string, unknown> };
          if (method === 'Murage.getAllFrames') value = { frames: [{ frameId: 0, parentFrameId: -1, url: tab.url }] };
          if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: 'frame', loaderId: 'fixture' } } };
          if (method === 'Page.createIsolatedWorld') value = { executionContextId: 1 };
          if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
          if (method === 'Runtime.evaluate') value = { result: { value: String(params.expression).includes('__murageGuard()') ? false : '<p>Fixture page.</p>' } };
        }
        return { version: 1, type: 'response', id: command.id, bindingId: command.bindingId, generation: command.generation,
          result: command.operation === 'cdp' ? { result: value, ...tab } : { generation: 1, state: 'active', tabs: [tab] } };
      },
    },
    createEngine: engine => ({ resolveTarget: async () => ({ backendNodeId: 1, document: await engine.transport.selected() }),
      resolveTab: async () => engine.transport.selected(), event() {}, close: async () => {},
      call: async () => ({ content: [{ type: 'text', text: 'Fixture page.' }] }) }),
  });
  try {
    const binding = await service.ensureBinding({ botId: 'b', threadId: 't', profileId: 'profile' });
    await expect(service.dispatch(binding.bindingId, 'agent_browser_read', { url: 'https://fixture.test/page' }, () => true)).rejects.toThrow(/WAITING/);
    expect(askSite).toHaveBeenCalledOnce();
    expect(fetchPage).not.toHaveBeenCalled();
    state.owner = true;
    await service.dispatch(binding.bindingId, 'agent_browser_read', { url: 'https://fixture.test/page' }, () => true);
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(askSite).toHaveBeenCalledOnce();
  } finally { await service.close(); vi.unstubAllGlobals(); f.dispose(); }
});

for (const initiator of [{ k: 'owner-typed' }, { k: 'owner-channel-dm', channel: 'fixture' }] as const) {
  it(`producer/execution audience preserves a rejected live ${initiator.k} binding`, () => {
    const f = fixture();
    const state = liveReader(initiator);
    const saved = { autoApprove: true, fullAccess: true, noLimits: true, permissionExplicit: true };
    const store = { projectBotForTask: () => saved } as unknown as Parameters<typeof ownerNoLimitsSource>[0];
    let bound = true;
    const remove = d.installProducerBindings({
      authorityFor: () => bound ? { claim: f.claim, proof: {}, identity: { threadId: 't', generation: 'g' } } : undefined,
      registerQueue: () => () => {},
    });
    try {
      expect(d.producerAuthorityFor('t', 'b')).toBeUndefined();
      expect.soft(serviceThreadNoLimitsPolicy('t', 'b')).toBe(false);
      expect.soft(ownerNoLimitsSource(store, 'b', 't')).toBe(false);
      state.owner = true;
      expect(d.producerAuthorityFor('t', 'b')).toBeDefined();
      expect(serviceThreadNoLimitsPolicy('t', 'b')).toBe(true);
      expect(ownerNoLimitsSource(store, 'b', 't')).toBe(true);
      state.principal = 'guest';
      expect.soft(ownerNoLimitsSource(store, 'b', 't')).toBe(false);
      state.principal = 'owner'; state.root = false;
      expect.soft(ownerNoLimitsSource(store, 'b', 't')).toBe(false);
      state.root = true; state.owner = false; bound = false;
      // A missing producer record does not erase a present live refusal.
      expect.soft(serviceThreadNoLimitsPolicy('t', 'b')).toBe(false);
      expect.soft(ownerNoLimitsSource(store, 'b', 't')).toBe(false);
      state.present = false;
      expect(serviceThreadNoLimitsPolicy('t', 'b')).toBeUndefined();
      expect(ownerNoLimitsSource(store, 'b', 't')).toBe(true);
    } finally { remove(); f.dispose(); }
  });
}

it('producer policy refuses invalid claims and mismatched identities without a saved fallback', () => {
  const f = fixture();
  liveReader().owner = true;
  let claim = f.claim;
  const remove = d.installProducerBindings({ authorityFor: () => ({ claim, proof: {} }), registerQueue: () => () => {} });
  try {
    expect(serviceThreadNoLimitsPolicy('t', 'b')).toBe(true);
    expect(serviceThreadNoLimitsPolicy('t', 'another-bot')).toBe(false);
    expect(serviceThreadNoLimitsPolicy('another-thread', 'b')).toBe(false);
    claim = {} as d.ExecutionClaim;
    expect(serviceThreadNoLimitsPolicy('t', 'b')).toBe(false);
  } finally { remove(); f.dispose(); }
});

it('producer policy treats an incomplete or unreadable live turn as refusal', () => {
  const f = fixture();
  try {
    d.installProvenanceReader({ turnGenerationFor: () => undefined, provenance: () => undefined,
      live: () => ({ botId: 'b', turnId: 'turn', providerInstanceId: 'p', principal: 'owner', owner: false, level: 'unlimited' }) });
    expect(serviceThreadNoLimitsPolicy('t', 'b')).toBe(false);
    d.installProvenanceReader({ turnGenerationFor: () => { throw new Error('unavailable'); }, provenance: () => undefined, live: () => undefined });
    expect(serviceThreadNoLimitsPolicy('t', 'b')).toBe(false);
  } finally { f.dispose(); }
});
