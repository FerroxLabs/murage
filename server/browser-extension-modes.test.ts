// SPDX-License-Identifier: AGPL-3.0-or-later
// T21: modes and categories in admission. Spec 2.2, 2.3, 2.7, 9.7 (D3). The mode is read per action, never reaches the floor, and nothing a bot can send sets it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { closeSync, readFileSync, writeSync } from 'node:fs';
import { createBrowserExtensionService } from './browser-extension-service.ts';
import { BrowserActivityStore, configureBrowserActivity } from './browser-extension-activity.ts';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from '../shared/browser-extension-protocol.ts';
import { privateTestDirectory } from "./testing/private-test-dir.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { BrowserExtensionIntegration } from './browser-extension-integration.ts';
import * as serviceModule from './browser-extension-service.ts';
import * as brokerModule from './browser-extension-broker.ts';
import * as connectionModule from './browser-action-checker-connection.ts';
import * as fluxConfigModule from './flux-config.ts';
import { resetFluxKeyModelsForTests, setFluxKeyCatalog } from './flux-key-models.ts';
import type { BotRecord } from './store.ts';
import type { ProviderInstance } from './contracts.ts';

const A = 'https://fixture.test';
const cleanup: string[] = [];
// Close every service before its folder goes: a save still in flight would recreate state.json mid-removal (ENOTEMPTY on macOS).
const services: { close(): Promise<void> }[] = [];
const track = <T extends { close(): Promise<void> }>(service: T): T => { services.push(service); return service; };
afterEach(async () => { for (const service of services.splice(0)) await service.close().catch(() => {}); for (const directory of cleanup.splice(0)) await removeTempDir(directory); });

type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
async function fixture(extra: Record<string, unknown> = {}) {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve('.modes-')); cleanup.push(directoryRoot);
  const bindings = new Map<string, { generation: number; state: string; tabs: Tab[] }>();
  const calls: BrowserExtensionCommand[] = [];
  const siteAsked: string[] = []; const cards: string[] = []; const ended: { reason: string; taskId: string }[] = [];
  let facts: Record<string, unknown> = { tag: 'textarea', role: 'textbox', name: 'Notes' }; let failBind = false; let clock = 1_000_000; let verdict = 'allow';
  const broker = {
    profiles: (): BrowserExtensionHello[] => [{ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: '1.0', capabilities: ['scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'engine_cdp_v1', 'unexpected_input_pause', 'ordered_requests_v1'] }],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      calls.push(command);
      if (failBind && command.operation === 'bind') throw Error('host_offline');
      let b = bindings.get(command.bindingId);
      // Each binding shares its own tab (the first gets tabId 1), so a second binding on the profile is not tab_already_shared.
      if (!b) { b = { generation: 1, state: 'active', tabs: [{ tabId: bindings.size + 1, navigationEpoch: 1, origin: A, url: A + '/' }] }; bindings.set(command.bindingId, b); }
      if (command.operation === 'stop' || command.operation === 'pause') { b.generation++; b.state = command.operation === 'stop' ? 'stopped' : 'paused'; }
      let result: any = b;
      if (command.operation === 'cdp') {
        const { method, params } = command.params as any; let value: any = {};
        if (method === "Murage.getAllFrames") value = { frames: [{ frameId: 0, parentFrameId: -1, url: b.tabs[0].url }] };
        if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: 'frame', loaderId: 'L' } } };
        if (method === "Murage.getAllFrames") value = { frames: [{ frameId: 0, parentFrameId: -1 }] };
        if (method === 'Page.createIsolatedWorld') value = { executionContextId: 7 };
        if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
        if (method === 'DOM.describeNode') value = { node: { backendNodeId: 12 } };
        if (method === 'DOM.resolveNode') value = { object: { objectId: 'target' } };
        if (method === 'Runtime.evaluate') value = { result: { value: String(params.expression).includes('__murageGuard()') ? false : 'page', objectId: 'target' } };
        if (method === 'Runtime.callFunctionOn') value = { result: { value: String(params.functionDeclaration).includes('elementFromPoint') ? true : JSON.stringify({ display: { tag: 'BUTTON', text: 'x', label: 'x' }, bound: null }) } };
        result = { result: value, ...b.tabs[0] };
      }
      return { version: 1, type: 'response', id: command.id, bindingId: command.bindingId, generation: command.generation, result: structuredClone(result) };
    },
  };
  const transport = vi.fn(async (request: { model: string }) => request.model === 's1' ? (verdict === 'allow' ? 'ALLOW' : 'FLAG') : JSON.stringify({ decision: verdict, reason: 'ok' }));
  const options = {
    collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, ...facts, visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } }) as never,
    createEngine: (engine: import('./browser-extension-engine.ts').BrowserExtensionEngineOptions) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string, args: Record<string, unknown>) {
        const document = await engine.transport.selected();
        if (name === 'agent_browser_click') { for (const type of ['mousePressed', 'mouseReleased']) { const params = { type, x: 1, y: 1, button: 'left', clickCount: 1 }; await engine.beforeCommand(document, 'Input.dispatchMouseEvent', params); await engine.transport.send('Input.dispatchMouseEvent', params, document); } return { content: [{ type: 'text', text: 'clicked' }] }; }
        const method = name === 'agent_browser_fill' ? 'Input.insertText' : 'Accessibility.getFullAXTree'; const params = name === 'agent_browser_fill' ? { text: args.text } : {};
        await engine.beforeCommand(document, method, params); await engine.transport.send(method, params, document); return { content: [{ type: 'text', text: 'ok' }] };
      },
    }) as never,
    broker, workspaceId: 'workspace', stateFile: path.join(directory, 'state.json'),
    askSite: async (_c: unknown, origin: string) => { siteAsked.push(origin); return 'allow' as const; },
    askAction: async (_c: unknown, a: { summary: string }) => { cards.push(a.summary); return true; },
    ownerInstruction: () => ({ id: 'm1', text: 'please type hello into the notes box' }),
    approvalMode: () => 'task' as const, checker: () => ({ deps: { transport, models: { stage1: 's1', stage2: 's2' } } }),
    now: () => clock, onTaskEnded: (info: { reason: string; taskId: string }) => { ended.push({ reason: info.reason, taskId: info.taskId }); },
    ...extra,
  };
  const service = track(await createBrowserExtensionService(options as never));
  const binding = await service.ensureBinding({ botId: 'bot', threadId: 'thread', profileId: 'profile' });
  const id = binding.bindingId;
  const run = (name: string, args: Record<string, unknown> = {}) => service.dispatch(id, name, args, () => true);
  let typed = 0; const fill = () => run('agent_browser_fill', { selector: 'textarea', text: `hello ${++typed}` });
  const inputs = () => calls.filter(call => call.operation === 'cdp' && String((call.params as any).method).startsWith('Input.')).length;
  const goTo = (origin: string) => { const b = bindings.get(id)!; const t = b.tabs[0]; b.tabs[0] = { ...t, navigationEpoch: t.navigationEpoch + 1, origin, url: origin + '/' }; };
  const lastBind = () => [...calls].reverse().find(call => call.operation === 'bind');
  return { service, id, directory, calls, siteAsked, cards, ended, transport, run, fill, inputs, goTo, lastBind, bindings, options,
    setFacts: (v: Record<string, unknown>) => { facts = v; }, failBinds: (v: boolean) => { failBind = v; }, advance: (ms: number) => { clock += ms; }, setVerdict: (v: string) => { verdict = v; } };
}
const BANK = 'https://www.chase.com';
const VAULT = 'https://vault.bitwarden.com';
const ADULT = 'https://www.pornhub.com';
type Mode = 'step' | 'task' | 'full';
const withMode = async (mode: Mode, extra: Record<string, unknown> = {}) => { const box = { mode }; const f = await fixture({ approvalMode: () => box.mode, ...extra }); return { ...f, box }; };
const SEND = { tag: 'button', role: 'button', name: 'Send message' };
const AGREE = { tag: 'input', type: 'checkbox', role: 'checkbox', name: 'I agree to the terms of service' };

describe('Flux routing changes during a browser step are not owner settings changes', () => {
  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); resetFluxKeyModelsForTests();
  });

  async function checkerFixture(extra: Record<string, unknown> = {}) {
    type Checker = NonNullable<Parameters<typeof createBrowserExtensionService>[0]['checker']>;
    let checker!: Checker;
    const fences: (string | undefined)[] = [];
    const f = await fixture({ ...extra, checker: (context: Parameters<Checker>[0]) => {
      const wiring = checker(context);
      fences.push(wiring?.key);
      return wiring;
    } });
    const bot = { id: 'bot', browserActionCheck: 'flux', modelSelection: { instanceId: 'engine' } } as BotRecord;
    const models: { stage1: string; stage2: string } = { ...connectionModule.DEFAULT_CHECKER_MODELS };
    const review = vi.fn(async () => JSON.stringify({ decision: 'allow', reason: 'Matches the request' }));
    const instances = ['engine', 'other-engine'].map(instanceId => ({ instanceId, enabled: true, reviewPermission: review }) as unknown as ProviderInstance);
    const resolve = connectionModule.resolveCheckerConnection;
    const sources: string[] = [];
    let key: string | null = 'fixture_flux_key_not_real';
    const readKey = vi.spyOn(fluxConfigModule, 'fluxKey').mockImplementation(() => key);
    const record = vi.fn();
    vi.spyOn(connectionModule, 'resolveCheckerConnection').mockImplementation(input => {
      const connection = resolve({ ...input, readKey, models, record });
      if (connection) sources.push(connection.source);
      return connection;
    });
    // Capture the actual integration callback; reuse the isolated service and fake browser above.
    vi.spyOn(brokerModule, 'startBrowserExtensionBroker').mockResolvedValue({ close: async () => {}, profiles: () => [] } as never);
    vi.spyOn(serviceModule, 'createBrowserExtensionService').mockImplementationOnce(async options => {
      checker = options.checker!;
      return f.service;
    });
    const integration = new BrowserExtensionIntegration({
      dataDir: f.directory, socketDir: f.directory, workspaceId: 'workspace', protectedOrigins: [],
      approvalBus: { store: { bots: [], groups: [], messagesFor: () => [] } } as never,
      bot: () => bot, checkerInstances: () => instances,
    });
    // The outer fixture cleanup closes the integration (and its service/timer) before deleting its directory.
    services[services.indexOf(f.service)] = integration;
    await integration.start();
    return { ...f, bot, models, sources, review, fences, record, setKey: (value: string | null) => { key = value; } };
  }

  it.each(['removed', 'rotated paid to free'] as const)('a Flux key %s during the check drops the step without exposing the key', async change => {
    const f = await checkerFixture();
    const paidKey = 'fixture_paid_flux_key_not_real';
    const freeKey = 'fixture_free_flux_key_not_real';
    f.setKey(paidKey);
    setFluxKeyCatalog(key => key === paidKey ? ['flux-auto', 'flux-fast', f.models.stage1, f.models.stage2] : ['flux-auto', 'flux-fast']);
    const fetch = vi.fn(async () => {
      f.setKey(change === 'removed' ? null : freeKey);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ALLOW' } }] }), { headers: { 'x-flux-no-retain': 'applied' } });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await f.fill().then(() => 'done', (error: Error) => error.message);
    expect(result).toContain("The owner changed this browser's approval settings");
    expect(f.inputs()).toBe(0);
    expect(f.sources[0]).toBe('flux'); expect(f.sources.at(-1)).toBe('bot');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.cards).toEqual([]);
    expect(f.record).toHaveBeenCalledWith({ kind: 'call', model: f.models.stage1, ok: true });
    for (const rawKey of [paidKey, freeKey]) {
      expect(JSON.stringify({ error: result, cards: f.cards, events: f.record.mock.calls, fences: f.fences })).not.toContain(rawKey);
    }
  });

  it('a free catalog arriving during stage one continues stage two on the bot engine', async () => {
    const f = await checkerFixture();
    // A paid catalog lists both pins, so the step starts on Flux; the free catalog lands while stage one is in flight.
    setFluxKeyCatalog(() => ['flux-auto', 'flux-fast', f.models.stage1, f.models.stage2]);
    const fetch = vi.fn(async () => {
      setFluxKeyCatalog(() => ['flux-auto', 'flux-fast']);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'FLAG' } }] }), { headers: { 'x-flux-no-retain': 'applied' } });
    });
    vi.stubGlobal('fetch', fetch);
    await expect(f.fill()).resolves.toBeDefined();
    expect(f.sources[0]).toBe('flux'); expect(f.sources.at(-1)).toBe('bot');
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.review).toHaveBeenCalledTimes(1);
    expect(f.inputs()).toBe(1);
  });

  it('an in-flight 403 that flips routing to the bot engine is not read as an owner settings change', async () => {
    const f = await checkerFixture();
    setFluxKeyCatalog(() => ['flux-auto', 'flux-fast', f.models.stage1, f.models.stage2]);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { param: 'model', type: 'auth_error', message: 'key not allowed to access model' } }), { status: 403 }));
    vi.stubGlobal('fetch', fetch);
    const result = await f.fill().then(() => 'done', (error: Error) => error.message);
    // The checker could not use the pin, so the step goes the checker-outage way (the owner's card, allowed here); it is never
    // dropped as an owner change, because the owner changed nothing.
    expect(result).not.toContain("The owner changed this browser's approval settings");
    expect(result).toBe('done');
    expect(f.sources[0]).toBe('flux'); expect(f.sources.at(-1)).toBe('bot');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(['switch', 'instance', 'stage1', 'stage2'] as const)('a real owner %s change during the check still aborts', async change => {
    const f = await checkerFixture();
    // Keep both routes on the bot engine: even a switch hidden by Flux fallback is an owner change.
    setFluxKeyCatalog(() => ['flux-auto', 'flux-fast']);
    f.review.mockImplementation(async () => {
      if (change === 'switch') f.bot.browserActionCheck = 'bot';
      else if (change === 'instance') f.bot.modelSelection!.instanceId = 'other-engine';
      else f.models[change] = 'flux-pinned-other-model';
      return 'ALLOW';
    });
    await expect(f.fill()).rejects.toThrow("The owner changed this browser's approval settings");
    expect(f.review).toHaveBeenCalledTimes(1); expect(f.inputs()).toBe(0);
  });
});

describe('T21 the 2.2 table at service level', () => {
  it('Ask each step: every Level 2 action is a card, every time', async () => {
    const f = await withMode('step');
    await f.fill(); await f.fill(); await f.fill();
    expect(f.cards).toHaveLength(3); expect(f.inputs()).toBe(3);
  });
  it('Full permissive: a new normal site needs no site card and is logged as allowed for the task', async () => {
    const f = await withMode('full');
    await f.fill();
    expect(f.siteAsked).toEqual([]); expect(f.cards).toEqual([]); expect(f.inputs()).toBe(1);
    expect(f.service.taskInfo(f.id)?.sites.map(site => site.origin)).toEqual([A]);
  });
  // SABLE-LIVE-B: under attended Full an unsure check is advice (no card) and a judged block refuses with no card.
  // The flag still brings the card back in Allow for this task (the next test).
  it('Full permissive: Level 3 passes on the checker allow, an unsure check is advice, and a judged block refuses without a card', async () => {
    const f = await withMode('full');
    f.setFacts(SEND);
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toEqual([]); expect(f.inputs()).toBe(2);
    f.setVerdict('ask');
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toEqual([]); expect(f.inputs()).toBe(4);
    f.setVerdict('block');
    await expect(f.run('agent_browser_click', { selector: 'button' })).rejects.toThrow(/NOT DONE/);
    expect(f.cards).toEqual([]); expect(f.inputs()).toBe(4);
  });
  it('Allow for this task: a flag on Level 3 brings the card back', async () => {
    const f = await withMode('task');
    f.setFacts(SEND);
    f.setVerdict('ask');
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toHaveLength(1);
  });
  it('Full permissive: the floor is still Your turn, with no input and no card', async () => {
    const f = await withMode('full');
    f.setFacts(AGREE);
    await expect(f.run('agent_browser_click', { selector: 'input' })).rejects.toThrow(/YOUR TURN/);
    expect(f.inputs()).toBe(0); expect(f.cards).toEqual([]);
  });
  it('the floor reads the same in every mode', async () => {
    for (const mode of ['step', 'task', 'full'] as const) {
      const f = await withMode(mode);
      f.setFacts(AGREE);
      await expect(f.run('agent_browser_click', { selector: 'input' }), mode).rejects.toThrow(/YOUR TURN/);
      expect(f.inputs(), mode).toBe(0);
    }
  });
});

describe('T21 categories in admission (2.3)', () => {
  it('a bank is allowed to read after the site card, and every Level 2 action is a card in Ask once per task', async () => {
    const f = await withMode('task'); f.goTo(BANK);
    await f.fill(); await f.fill(); await f.fill();
    expect(f.siteAsked).toEqual([BANK]); expect(f.cards).toHaveLength(3); expect(f.inputs()).toBe(3);
  });
  it('Full permissive on a bank: the site card still comes first, and every step is a card', async () => {
    const f = await withMode('full'); f.goTo(BANK);
    await f.fill(); await f.fill();
    expect(f.siteAsked).toEqual([BANK]); expect(f.cards).toHaveLength(2);
    f.setFacts(SEND);
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toHaveLength(3);
  });
  it('a password manager is refused in every mode: no site card, no card, no input', async () => {
    for (const mode of ['step', 'task', 'full'] as const) {
      const f = await withMode(mode); f.goTo(VAULT);
      await expect(f.fill(), mode).rejects.toThrow(/NOT DONE|handover_required/);
      expect(f.siteAsked, mode).toEqual([]); expect(f.cards, mode).toEqual([]); expect(f.inputs(), mode).toBe(0);
    }
  });
  it('an adult site is refused by default in every mode', async () => {
    for (const mode of ['step', 'task', 'full'] as const) {
      const f = await withMode(mode); f.goTo(ADULT);
      await expect(f.fill(), mode).rejects.toThrow(/NOT DONE/);
      expect(f.inputs(), mode).toBe(0);
    }
  });
  // EXT-RESTART 4.1 (ruling 3) changes this test on purpose: a saved Allow no longer opens a Never-by-default site (nothing loosens from
  // disk). The owner's per-binding Allow in this process still does (EXT-RESTART 21 below). A handover site stays closed to every setting.
  it('a saved Allow does not open a Never-by-default site, and a handover site cannot be opened by any setting', async () => {
    const siteSetting = (_c: unknown, origin: string) => ({ rule: 'allow' as const, ...(origin === ADULT || origin === VAULT ? {} : {}) });
    const adult = await withMode('task', { siteSetting }); adult.goTo(ADULT);
    await expect(adult.fill()).rejects.toThrow(/NOT DONE/); expect(adult.inputs()).toBe(0);
    const vault = await withMode('task', { siteSetting }); vault.goTo(VAULT);
    await expect(vault.fill()).rejects.toThrow(/NOT DONE|handover_required/); expect(vault.inputs()).toBe(0);
  });
  it('an owner-lowered bank is a normal site: one Level 2 card, then silent', async () => {
    const siteSetting = (_c: unknown, origin: string) => origin === BANK ? ({ rule: 'ask' as const, lowered: true as const }) : undefined;
    const f = await withMode('task', { siteSetting }); f.goTo(BANK);
    await f.fill(); await f.fill(); await f.fill();
    expect(f.cards).toHaveLength(1); expect(f.inputs()).toBe(3);
  });
  it('a lowered flag cannot lower a handover or Never-by-default site, and a store Never refuses at once', async () => {
    const lowered = () => ({ rule: 'ask' as const, lowered: true as const });
    const vault = await withMode('task', { siteSetting: lowered }); vault.goTo(VAULT);
    await expect(vault.fill()).rejects.toThrow(/NOT DONE|handover_required/);
    const adult = await withMode('task', { siteSetting: lowered }); adult.goTo(ADULT);
    await expect(adult.fill()).rejects.toThrow(/NOT DONE|handover_required/);
    const never = await withMode('full', { siteSetting: () => ({ rule: 'never' as const }) });
    await expect(never.fill()).rejects.toThrow(/NOT DONE|denied|never/i); expect(never.inputs()).toBe(0);
  });
});

describe('T21 the mode is a per-action read and nothing a bot sends sets it', () => {
  it('a mode change takes effect at the next action, and turning Full off cancels nothing before it', async () => {
    const f = await withMode('full');
    await f.fill(); expect(f.cards).toEqual([]);
    f.box.mode = 'step';
    await f.fill(); expect(f.cards).toHaveLength(1);
    f.box.mode = 'full';
    await f.fill(); expect(f.cards).toHaveLength(1);
  });
  it('tool arguments that name a mode change nothing', async () => {
    const f = await withMode('step');
    await expect(f.run('agent_browser_fill', { selector: 'textarea', text: 'x', mode: 'full', browserApproval: 'full', approvalMode: 'full' })).rejects.toThrow(/not permitted/);
    expect(f.inputs()).toBe(0);
    await f.fill(); expect(f.cards).toHaveLength(1);
  });
  it('the service has no way to set a mode', async () => {
    const f = await withMode('task');
    const names = Object.keys(f.service).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(f.service) ?? {}));
    expect(names.filter(name => /mode|approval/i.test(name))).toEqual([]);
  });
  it('a routine on a site that is not Allow always is left alone even in Full permissive', async () => {
    const f = await withMode('full', { routine: () => true });
    await expect(f.fill()).rejects.toThrow(/NOT DONE|site_consent_required/);
    expect(f.inputs()).toBe(0); expect(f.siteAsked).toEqual([]);
  });
});

describe('T21 I2 fires in production with the recipients fact', () => {
  it('Full permissive: a send to a recipient the owner never named is a card that names the recipient', async () => {
    const f = await withMode('full', { ownerInstruction: () => ({ id: 'm1', text: 'send the notes to ana@example.com' }) });
    f.setFacts({ ...SEND, recipients: ['mallory@evil.example'] });
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toContain('New recipient not in your request: mallory@evil.example');
  });
  it('Full permissive: a send to the recipient the owner named passes', async () => {
    const f = await withMode('full', { ownerInstruction: () => ({ id: 'm1', text: 'send the notes to ana@example.com' }) });
    f.setFacts({ ...SEND, recipients: ['ana@example.com'] });
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toEqual([]);
  });
  it('a look-alike recipient is a new recipient and says so', async () => {
    const f = await withMode('full', { ownerInstruction: () => ({ id: 'm1', text: 'send the notes to ana@example.com' }) });
    f.setFacts({ ...SEND, recipients: ['ana​@example.com'] });
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards[0]).toMatch(/New recipient not in your request/);
  });
});

describe('T22 I2 fail direction at service level', () => {
  const owner = { ownerInstruction: () => ({ id: 'm1', text: 'send the notes to ana@example.com' }) };
  it('Full permissive, attended: a send whose recipient scan failed is a card that says the recipients are unknown', async () => {
    const f = await withMode('full', owner);
    f.setFacts({ ...SEND, recipientScanFailed: true });
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toContain('could not check who this goes to');
  });
  it('Ask each step and Allow for this task also say it', async () => {
    for (const mode of ['step', 'task'] as const) {
      const f = await withMode(mode, owner);
      f.setFacts({ ...SEND, recipientScanFailed: true });
      await f.run('agent_browser_click', { selector: 'button' });
      expect(f.cards.at(-1)).toContain('could not check who this goes to');
    }
  });
  it('unattended (a routine): the same send is refused and nothing reaches the page', async () => {
    const f = await withMode('full', { ...owner, routine: () => true });
    f.setFacts({ ...SEND, recipientScanFailed: true });
    await expect(f.run('agent_browser_click', { selector: 'button' })).rejects.toThrow(/NOT DONE|site_consent_required/);
    expect(f.cards).toEqual([]); expect(f.inputs()).toBe(0);
  });
  it('a working scan with no recipients is not affected', async () => {
    const f = await withMode('full', owner);
    f.setFacts({ ...SEND });
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toEqual([]);
  });
});

// EXT-RESTART design section 4 (Bug 1), tests 17-22, 25-27c, 29. Labels: FAILS = red on base 2fba37df6; PIN = green on base.
const D = 'https://d.example';
const bindsSince = (f: { calls: BrowserExtensionCommand[] }, from: number, id?: string) => f.calls.slice(from).filter(call => call.operation === 'bind' && (id === undefined || call.bindingId === id)).map(call => (call.params as { approvedOrigins: string[] }).approvedOrigins);
const site = (f: { service: { taskInfo(id: string): { sites: { origin: string; l1: boolean; l2: boolean }[] } | undefined } }, id: string, origin: string) => f.service.taskInfo(id)?.sites.find(item => item.origin === origin);
const allow = (f: { service: { settingsAllowed(botId: string, change: { origin: string; profileId: string }): Promise<void> } }, origin: string, profileId = 'profile') => f.service.settingsAllowed('bot', { origin, profileId });

describe('EXT-RESTART 4.2 Settings Allow always reaches only the tasks running at save', () => {
  it('17 (FAILS): Ask mode, a running task: one bind listing the origin, no site card for it this task, taskInfo shows l1 and l2', async () => {
    const f = await withMode('task'); await f.fill();
    const from = f.calls.length; await allow(f, D);
    const binds = bindsSince(f, from); expect(binds).toHaveLength(1); expect(binds[0]).toContain(D);
    expect(site(f, f.id, D)).toEqual({ origin: D, l1: true, l2: true });
    f.goTo(D); await f.fill(); expect(f.siteAsked).not.toContain(D);
  });
  it('18 (PIN): paused, active with no task, or a routine: nothing raised, no bind; the site cards when needed', async () => {
    const paused = await withMode('task'); await paused.fill(); await paused.service.pause(paused.id);
    let from = paused.calls.length; await allow(paused, D);
    expect(bindsSince(paused, from)).toEqual([]); expect(site(paused, paused.id, D)).toBeUndefined();
    const idle = await withMode('task');
    from = idle.calls.length; await allow(idle, D);
    expect(bindsSince(idle, from)).toEqual([]); expect(idle.service.taskInfo(idle.id)).toBeUndefined();
    idle.goTo(D); await idle.fill(); expect(idle.siteAsked).toContain(D);
    const box = { routine: false };
    const routine = await withMode('task', { routine: () => box.routine }); await routine.fill(); box.routine = true;
    from = routine.calls.length; await allow(routine, D);
    expect(bindsSince(routine, from)).toEqual([]); expect(site(routine, routine.id, D)).toBeUndefined();
  });
  it('19 (FAILS first assertion): the raise is for this task only; after End task a new instruction cards the site', async () => {
    const message = { id: 'm1' };
    const f = await withMode('task', { ownerInstruction: () => ({ id: message.id, text: 'please type hello into the notes box' }) }); await f.fill();
    await allow(f, D); expect(site(f, f.id, D)?.l1).toBe(true);
    await f.service.endTask(f.id); message.id = 'm2';
    f.goTo(D); await f.fill(); expect(f.siteAsked).toContain(D);
  });
  it('22 (FAILS, ruling 3): Settings Allow on a Never-by-default site opens it for the running task only; after End task it is refused', async () => {
    const message = { id: 'm1' };
    const f = await withMode('task', { ownerInstruction: () => ({ id: message.id, text: 'please type hello into the notes box' }) }); await f.fill();
    await allow(f, ADULT); f.goTo(ADULT);
    const before = f.inputs(); await f.fill(); expect(f.inputs()).toBe(before + 1);
    await f.service.endTask(f.id); message.id = 'm2';
    const after = f.inputs(); await expect(f.fill()).rejects.toThrow(/NOT DONE/); expect(f.inputs()).toBe(after);
  });
  it('27 (FAILS): an Allow for profile A binds nothing on profile B and gives B no grant', async () => {
    const f = await withMode('task'); await f.fill();
    const broker = (f.options as unknown as { broker: { profiles: () => BrowserExtensionHello[] } }).broker; const own = broker.profiles;
    broker.profiles = () => [...own(), { ...own()[0], profileId: 'other' }];
    const b = await f.service.ensureBinding({ botId: 'bot', threadId: 'thread', profileId: 'other' });
    await f.service.dispatch(b.bindingId, 'agent_browser_fill', { selector: 'textarea', text: 'b' }, () => true);
    const from = f.calls.length; await allow(f, D);
    expect(bindsSince(f, from, f.id)).toHaveLength(1); expect(site(f, f.id, D)?.l1).toBe(true);
    expect(bindsSince(f, from, b.bindingId)).toEqual([]); expect(site(f, b.bindingId, D)).toBeUndefined();
  });
  it('27b (FAILS): a site-card Allow without Level 2 is upgraded once; a second Allow adds nothing', async () => {
    const f = await withMode('step'); await f.fill();
    expect(site(f, f.id, A)).toEqual({ origin: A, l1: true, l2: false });
    let from = f.calls.length; await allow(f, A);
    expect(bindsSince(f, from)).toHaveLength(1); expect(site(f, f.id, A)).toEqual({ origin: A, l1: true, l2: true });
    from = f.calls.length; await allow(f, A); expect(bindsSince(f, from)).toEqual([]);
  });
  it("27c (FAILS): a site Full granted on its own becomes the owner's grant", async () => {
    const f = await withMode('full'); await f.fill();
    expect(f.service.autoGranted(f.id)).toEqual([A]); expect(site(f, f.id, A)?.l2).toBe(false);
    await allow(f, A); expect(f.service.autoGranted(f.id)).toEqual([]); expect(site(f, f.id, A)?.l2).toBe(true);
  });
});

describe('EXT-RESTART 4.1 nothing loosens from disk (ruling 3)', () => {
  it('20 (FAILS): a saved Allow on a Never-by-default site, Full mode, checker present: refused, no grant, no site card', async () => {
    const lines: { action: string; decision: string; outcome: string; site: string }[] = [];
    configureBrowserActivity({ record: (input: { action: string; decision: string; outcome: string; site: string }) => { lines.push(input); return true; } } as never);
    try {
      const f = await withMode('full', { siteSetting: (_c: unknown, origin: string) => origin === ADULT ? { rule: 'allow' as const } : undefined }); f.goTo(ADULT);
      await expect(f.fill()).rejects.toThrow(/NOT DONE/);
      expect(f.siteAsked).toEqual([]); expect(f.inputs()).toBe(0); expect(site(f, f.id, ADULT)).toBeUndefined();
      // Astra r5 M: the refusal comes before admission and is still recorded, exactly once (current page).
      const denied = () => lines.filter(line => line.site === new URL(ADULT).host && line.decision === 'not done' && line.outcome === 'denied');
      expect(denied()).toHaveLength(1);
      // The destination of a step: refused before any card, recorded once with the step's action.
      f.goTo(A); lines.length = 0;
      await expect(f.run('agent_browser_open', { url: ADULT + '/' })).rejects.toThrow(/NOT DONE/);
      expect(f.siteAsked).toEqual([]); expect(denied()).toHaveLength(1); expect(denied()[0].action).toBe('open');
    } finally { configureBrowserActivity(undefined); }
  });
  // EXT-RESTART follow-up (Astra r6 M): a Never-by-default refusal reached after a mutation is admitted is recorded once, by the
  // consent check, and the executor's catch adds no 'not done/failed' line for it. An unrecorded failure after admission keeps its line.
  it('20b: a refusal after mutation admission writes exactly one not-done line, across sites and outcomes', async () => {
    const lines: { action: string; decision: string; outcome: string; site: string }[] = [];
    configureBrowserActivity({ record: (input: { action: string; decision: string; outcome: string; site: string }) => { lines.push(input); return true; } } as never);
    try {
      const box: { at: 'before' | 'after' | 'throw' | ''; to: () => void } = { at: '', to: () => {} };
      const createEngine = (engine: import('./browser-extension-engine.ts').BrowserExtensionEngineOptions) => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
        async call(_name: string, args: Record<string, unknown>) {
          if (box.at === 'before') box.to();
          const document = await engine.transport.selected(); const params = { text: args.text };
          await engine.beforeCommand(document, 'Input.insertText', params); await engine.transport.send('Input.insertText', params, document);
          if (box.at === 'after') box.to();
          if (box.at === 'throw') throw new Error('engine_failed');
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });
      const answer: { site: 'allow' | 'waiting' } = { site: 'allow' };
      const f = await withMode('task', { createEngine, askSite: async () => answer.site });
      box.to = () => f.goTo(ADULT);
      const notDone = () => lines.filter(line => line.decision === 'not done');
      // The page check before the input (executor :393): the tab moved to a Never-by-default site after admission.
      await f.fill(); lines.length = 0;
      box.at = 'before';
      await expect(f.fill()).rejects.toThrow(/NOT DONE/);
      expect(notDone()).toHaveLength(1);
      expect(notDone()[0]).toMatchObject({ site: new URL(ADULT).host, outcome: 'denied' });
      // The resulting-document check after the input (executor :608).
      // The fill happened, so the service answers with the pause text instead of rejecting; the line count is the same rule.
      f.goTo(A); lines.length = 0; box.at = 'after';
      const after = await f.fill().catch((error: unknown) => error);
      expect(`${(after as Error | undefined)?.message ?? ''} ${JSON.stringify(after)}`).toMatch(/not approved for this bot|NOT DONE/);
      expect(notDone()).toHaveLength(1);
      expect(notDone()[0]).toMatchObject({ site: new URL(ADULT).host, outcome: 'denied' });
      // An unrecorded failure after admission still writes its one 'not done/failed' line.
      f.goTo(A); lines.length = 0; box.at = 'throw';
      await expect(f.fill()).rejects.toThrow(/engine_failed/);
      expect(notDone()).toHaveLength(1);
      expect(notDone()[0]).toMatchObject({ site: new URL(A).host, outcome: 'failed' });
      // Refusals marked `recorded` that write no line of their own keep the executor's one line (Astra RESIDUALS r1 M):
      // a site card still waiting for the owner, then a grant whose bind fails, both for a new site found after admission.
      const NEW = 'https://new-site.example';
      box.to = () => f.goTo(NEW);
      f.goTo(A); lines.length = 0; box.at = 'before'; answer.site = 'waiting';
      await expect(f.fill()).rejects.toThrow();
      expect(notDone()).toHaveLength(1);
      expect(notDone()[0]).toMatchObject({ site: new URL(A).host, outcome: 'failed' });
      f.goTo(A); lines.length = 0; answer.site = 'allow'; f.failBinds(true);
      await expect(f.fill()).rejects.toThrow();
      expect(notDone()).toHaveLength(1);
      expect(notDone()[0]).toMatchObject({ site: new URL(A).host, outcome: 'failed' });
    } finally { configureBrowserActivity(undefined); }
  });
  // RESIDUALS-1018 item 1 (Astra r2 M): the consent line's own write can fail (returns false, or throws). The refusal is marked as
  // recorded only after the write succeeded, so a failed write leaves the executor to write its one line: never zero lines.
  it.each([['returns false', 'false'], ['throws', 'throw']] as const)('20c: when the consent line write %s, the executor still writes its one not-done line', async (_name, mode) => {
    const written: { action: string; decision: string; outcome: string; site: string }[] = [];
    configureBrowserActivity({ record: (input: { action: string; decision: string; outcome: string; site: string }) => {
      if (input.outcome === 'denied') { if (mode === 'throw') throw new Error('disk full'); return false; }
      written.push(input); return true;
    } } as never);
    try {
      const box: { at: 'before' | ''; to: () => void } = { at: '', to: () => {} };
      const createEngine = (engine: import('./browser-extension-engine.ts').BrowserExtensionEngineOptions) => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
        async call(_name: string, args: Record<string, unknown>) {
          if (box.at === 'before') box.to();
          const document = await engine.transport.selected(); const params = { text: args.text };
          await engine.beforeCommand(document, 'Input.insertText', params); await engine.transport.send('Input.insertText', params, document);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });
      const f = await withMode('task', { createEngine, askSite: async () => 'allow' as const });
      box.to = () => f.goTo(ADULT);
      const notDone = () => written.filter(line => line.decision === 'not done');
      await f.fill(); written.length = 0;
      box.at = 'before';
      await expect(f.fill()).rejects.toThrow(/NOT DONE/);
      expect(notDone()).toHaveLength(1);
    } finally { configureBrowserActivity(undefined); }
  });
  // RESIDUALS-1018 Astra r5 H: the consent line may have landed although its write reported a failure. The fallback line then carries
  // the same id, and the log (first record per id) shows one line either way.
  it('20d: a refusal whose consent write landed but reported false: the executor line carries the same id', async () => {
    const seen: { id?: string; decision: string; outcome: string }[] = [];
    configureBrowserActivity({ record: (input: { id?: string; decision: string; outcome: string }) => { seen.push(input); return input.outcome === 'denied' ? false : true; } } as never);
    try {
      const box: { at: 'before' | ''; to: () => void } = { at: '', to: () => {} };
      const createEngine = (engine: import('./browser-extension-engine.ts').BrowserExtensionEngineOptions) => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
        async call(_name: string, args: Record<string, unknown>) {
          if (box.at === 'before') box.to();
          const document = await engine.transport.selected(); const params = { text: args.text };
          await engine.beforeCommand(document, 'Input.insertText', params); await engine.transport.send('Input.insertText', params, document);
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });
      const f = await withMode('task', { createEngine, askSite: async () => 'allow' as const });
      box.to = () => f.goTo(ADULT);
      await f.fill(); seen.length = 0; box.at = 'before';
      await expect(f.fill()).rejects.toThrow(/NOT DONE/);
      const notDone = seen.filter(line => line.decision === 'not done');
      expect(notDone).toHaveLength(2);
      expect(notDone[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(notDone[1]!.id).toBe(notDone[0]!.id);
      expect(new Set(notDone.map(line => line.id)).size).toBe(1);
    } finally { configureBrowserActivity(undefined); }
  });
  // The same with the real store and a real file: the consent line lands with its newline cut, both checks of the file fail and the
  // retry fails, so record() says false. The fallback line then lands too, and the log reads as one refusal. Both refusal paths.
  it.each([['before the command', 'before'], ['on the resulting document', 'after']] as const)('20e: a real log shows one refusal when the consent write landed, its retry failed and the file check is forced to fail, %s', async (_name, at) => {
    const { root, directory } = await privateTestDirectory(path.resolve('.modes-')); cleanup.push(root);
    const faults = { armed: false, writes: 0 };
    const write: typeof writeSync = ((fd: number, buffer: Buffer, offset: number, length: number) => {
      if (!faults.armed || !buffer.includes('"decision":"not done"')) return writeSync(fd, buffer, offset, length);
      if (++faults.writes === 1) writeSync(fd, buffer, offset, length - 1);
      if (faults.writes <= 2) throw new Error('EIO');
      return writeSync(fd, buffer, offset, length);
    }) as never;
    const store = new BrowserActivityStore(directory, Date.now, { write, close: closeSync, landed: () => false });
    configureBrowserActivity(store);
    try {
      const box: { at: 'before' | 'after' | ''; to: () => void } = { at: '', to: () => {} };
      const createEngine = (engine: import('./browser-extension-engine.ts').BrowserExtensionEngineOptions) => ({
        resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
        async call(_name: string, args: Record<string, unknown>) {
          if (box.at === 'before') box.to();
          const document = await engine.transport.selected(); const params = { text: args.text };
          await engine.beforeCommand(document, 'Input.insertText', params); await engine.transport.send('Input.insertText', params, document);
          if (box.at === 'after') box.to();
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      });
      const f = await withMode('task', { createEngine, askSite: async () => 'allow' as const });
      box.to = () => f.goTo(ADULT);
      await f.fill();
      box.at = at; faults.armed = true;
      const outcome = await f.fill().catch((error: unknown) => error);
      // After the input the service answers with the pause text instead of rejecting (test 20b).
      expect(`${(outcome as Error | undefined)?.message ?? ''} ${JSON.stringify(outcome)}`).toMatch(/not approved for this bot|NOT DONE/);
      expect(faults.writes).toBeGreaterThanOrEqual(3);
      expect(store.list({ botId: 'bot' }).filter(line => line.decision === 'not done')).toHaveLength(1);
    } finally { configureBrowserActivity(undefined); }
  });
  it('21 (FAILS): the per-binding Allow opens it on that binding; another binding with only the saved row is refused', async () => {
    const f = await withMode('task', { siteSetting: (_c: unknown, origin: string) => origin === ADULT ? { rule: 'allow' as const } : undefined });
    await f.service.setSiteAccess(f.id, ADULT, 'allow'); f.goTo(ADULT);
    await f.fill(); expect(f.inputs()).toBe(1);
    const two = await f.service.ensureBinding({ botId: 'bot', threadId: 'thread-2', profileId: 'profile' });
    const fake = f.bindings.get(two.bindingId)!; fake.tabs[0] = { ...fake.tabs[0], navigationEpoch: 2, origin: ADULT, url: ADULT + '/' };
    await expect(f.service.dispatch(two.bindingId, 'agent_browser_fill', { selector: 'textarea', text: 'x' }, () => true)).rejects.toThrow(/NOT DONE/);
    expect(f.inputs()).toBe(1);
  });
  it('25 (FAILS): a Settings Never row: a new binding refuses it with no site card; restore applies it; a row the policy refuses is skipped with one log line', async () => {
    const logs: string[] = [];
    const f = await withMode('task', { savedNever: () => [D, 'https://x.example/path'], log: (line: string) => { logs.push(line); } });
    expect(f.service.status().bindings[0].sites[D]).toBe('never');
    expect(logs.filter(line => line.includes('https://x.example/path'))).toHaveLength(1);
    f.goTo(D); await expect(f.fill()).rejects.toThrow(/NOT DONE|denied/); expect(f.siteAsked).not.toContain(D); expect(f.inputs()).toBe(0);
    await f.service.close();
    const O2 = 'https://o2.example';
    const again = track(await createBrowserExtensionService({ ...f.options, savedNever: () => [O2] } as never));
    expect(again.status().bindings.find(item => item.bindingId === f.id)?.sites[O2]).toBe('never');
  });
  it('26 (FAILS): the 65th per-binding Allow on one binding is refused allow_limit (409)', async () => {
    const f = await withMode('task');
    for (let i = 0; i < 64; i++) await f.service.setSiteAccess(f.id, `https://s${i}.example`, 'allow');
    await expect(f.service.setSiteAccess(f.id, 'https://s64.example', 'allow')).rejects.toMatchObject({ code: 'allow_limit', status: 409, errorKey: 'browserExt.sites.errorAllowLimit' });
    await f.service.setSiteAccess(f.id, 'https://s3.example', 'allow');
    const en = JSON.parse(readFileSync(new URL('../src/locales/en.json', import.meta.url), 'utf8')) as Record<string, string>;
    expect(en['browserExt.sites.errorAllowLimit']).toBe('This task already has 64 sites allowed always. Remove one, then try again.');
  });
});

describe('EXT-RESTART 29: the Settings route', () => {
  it('desktop POST allow calls settingsAllowed with the profile after the phone guard (FAILS); the phone POST allow stays 403 (PIN, mode-api test)', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const start = source.indexOf('const site = browserSites().set(bot.id, profileId, origin, rule, { lowered });');
    expect(start).toBeGreaterThan(0);
    const guard = source.lastIndexOf('browserExt.sites.errorNeedsDesktop', start);
    expect(guard).toBeGreaterThan(0); expect(start - guard).toBeLessThan(400);
    const route = source.slice(start, start + 600);
    expect(route).toMatch(/if \(rule !== "allow"\) await browserExtension\?\.settingsChanged\(bot\.id, \{ origin: site\.origin \?\? origin, rule \}\);\s*\/\/[^\n]*\n\s*else await browserExtension\?\.settingsAllowed\(bot\.id, \{ origin: site\.origin \?\? origin, profileId \}\);/);
  });
});

