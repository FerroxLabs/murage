// SPDX-License-Identifier: AGPL-3.0-or-later
// T21: modes and categories in admission. Spec 2.2, 2.3, 2.7, 9.7 (D3). The mode is read per action, never reaches the floor, and nothing a bot can send sets it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBrowserExtensionService } from './browser-extension-service.ts';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from '../shared/browser-extension-protocol.ts';
import { privateTestDirectory } from "./testing/private-test-dir.ts";

const A = 'https://fixture.test';
const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

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
      if (!b) { b = { generation: 1, state: 'active', tabs: [{ tabId: 1, navigationEpoch: 1, origin: A, url: A + '/' }] }; bindings.set(command.bindingId, b); }
      if (command.operation === 'stop' || command.operation === 'pause') { b.generation++; b.state = command.operation === 'stop' ? 'stopped' : 'paused'; }
      let result: any = b;
      if (command.operation === 'cdp') {
        const { method, params } = command.params as any; let value: any = {};
        if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: 'frame', loaderId: 'L' } } };
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
  const service = await createBrowserExtensionService(options as never);
  const binding = await service.ensureBinding({ botId: 'bot', threadId: 'thread', profileId: 'profile' });
  const id = binding.bindingId;
  const run = (name: string, args: Record<string, unknown> = {}) => service.dispatch(id, name, args, () => true);
  let typed = 0; const fill = () => run('agent_browser_fill', { selector: 'textarea', text: `hello ${++typed}` });
  const inputs = () => calls.filter(call => call.operation === 'cdp' && String((call.params as any).method).startsWith('Input.')).length;
  const goTo = (origin: string) => { const b = bindings.get(id)!; const t = b.tabs[0]; b.tabs[0] = { ...t, navigationEpoch: t.navigationEpoch + 1, origin, url: origin + '/' }; };
  const lastBind = () => [...calls].reverse().find(call => call.operation === 'bind');
  return { service, id, calls, siteAsked, cards, ended, transport, run, fill, inputs, goTo, lastBind, bindings, options,
    setFacts: (v: Record<string, unknown>) => { facts = v; }, failBinds: (v: boolean) => { failBind = v; }, advance: (ms: number) => { clock += ms; }, setVerdict: (v: string) => { verdict = v; } };
}
const BANK = 'https://www.chase.com';
const VAULT = 'https://vault.bitwarden.com';
const ADULT = 'https://www.pornhub.com';
type Mode = 'step' | 'task' | 'full';
const withMode = async (mode: Mode, extra: Record<string, unknown> = {}) => { const box = { mode }; const f = await fixture({ approvalMode: () => box.mode, ...extra }); return { ...f, box }; };
const SEND = { tag: 'button', role: 'button', name: 'Send message' };
const AGREE = { tag: 'input', type: 'checkbox', role: 'checkbox', name: 'I agree to the terms of service' };

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
  it('Full permissive: Level 3 passes only on the checker allow, and a flag brings the card back', async () => {
    const f = await withMode('full');
    f.setFacts(SEND);
    await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards).toEqual([]); expect(f.inputs()).toBe(2);
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
  it('an owner-allowed Never-by-default site works, and a handover site cannot be opened by any setting', async () => {
    const siteSetting = (_c: unknown, origin: string) => ({ rule: 'allow' as const, ...(origin === ADULT || origin === VAULT ? {} : {}) });
    const adult = await withMode('task', { siteSetting }); adult.goTo(ADULT);
    await adult.fill(); expect(adult.inputs()).toBe(1);
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

