// SPDX-License-Identifier: AGPL-3.0-or-later
// T20: task access. A grant is (binding, task, site, level), held in server state, and ends with the task. Spec 2.3, 2.4, 2.7.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createBrowserExtensionService } from './browser-extension-service.ts';
import { BrowserExtensionPolicy } from './browser-extension-policy.ts';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from '../shared/browser-extension-protocol.ts';
import { privateTestDirectory } from "./testing/private-test-dir.ts";

const A = 'https://fixture.test';
const B = 'https://other.test';
const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
/** M3: an ended task only restarts after a new owner message. */
let ownerMessage = 1;
async function fixture(extra: Record<string, unknown> = {}) {
  const { root: directoryRoot, directory } = await privateTestDirectory(path.resolve('.tasks-')); cleanup.push(directoryRoot);
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
    ownerInstruction: () => ({ id: `m${ownerMessage}`, text: 'please type hello into the notes box' }),
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
type F = Awaited<ReturnType<typeof fixture>>;
const statusOf = (f: F) => f.service.status().bindings[0] as any;
const approved = (f: F) => ((f.lastBind()?.params as any)?.approvedOrigins ?? []) as string[];
const MIN = 60_000;

describe('T20 task access: grants', () => {
  it('the site card grants the site for this task only, and is not remembered as Allow always', async () => {
    const f = await fixture();
    await f.run('agent_browser_snapshot'); await f.run('agent_browser_snapshot');
    expect(f.siteAsked).toEqual([A]);
    expect(statusOf(f).sites[A]).toBeUndefined();
    expect(f.service.taskInfo(f.id)?.sites).toEqual([{ origin: A, l1: true, l2: false }]);
    expect(approved(f)).toContain(A);
  });
  it('the first Level 2 action on a site asks, then the same site is silent for the task', async () => {
    const f = await fixture();
    await f.fill(); expect(f.cards).toHaveLength(1); expect(f.inputs()).toBe(1);
    await f.fill(); await f.fill(); expect(f.cards).toHaveLength(1); expect(f.inputs()).toBe(3);
    expect(f.service.taskInfo(f.id)?.sites).toEqual([{ origin: A, l1: true, l2: true }]);
  });
  it('Level 3 always asks, even with a Level 2 grant', async () => {
    const f = await fixture();
    await f.fill(); const before = f.cards.length;
    f.setFacts({ tag: 'button', role: 'button', name: 'Send message' });
    await f.run('agent_browser_click', { selector: 'button' }); await f.run('agent_browser_click', { selector: 'button' });
    expect(f.cards.length).toBe(before + 2);
  });
  it('a grant never crosses sites: another origin needs its own site card and its own Level 2 card', async () => {
    const f = await fixture();
    await f.fill(); expect(f.cards).toHaveLength(1);
    f.goTo(B);
    await f.fill();
    expect(f.siteAsked).toEqual([A, B]); expect(f.cards).toHaveLength(2);
    f.goTo(A);
    await f.fill(); expect(f.cards).toHaveLength(2);
    expect(f.service.taskInfo(f.id)?.sites.map(site => site.origin).sort()).toEqual([A, B]);
  });
  it('a grant never crosses tasks: End task, then the site card and the Level 2 card come back', async () => {
    const f = await fixture();
    await f.fill(); const first = f.service.taskInfo(f.id)!.taskId;
    await f.service.endTask(f.id);
    expect(approved(f)).not.toContain(A);
    ownerMessage++;
    await f.fill();
    expect(f.siteAsked).toEqual([A, A]); expect(f.cards).toHaveLength(2);
    expect(f.service.taskInfo(f.id)!.taskId).not.toBe(first);
  });
  it('Revoke takes effect on the very next action: the extension loses the site and both cards return', async () => {
    const f = await fixture();
    await f.fill(); expect(approved(f)).toContain(A);
    await f.service.revoke(f.id, A);
    expect(approved(f)).not.toContain(A);
    expect(f.service.taskInfo(f.id)?.sites ?? []).toEqual([]);
    await f.fill();
    expect(f.siteAsked).toEqual([A, A]); expect(f.cards).toHaveLength(2);
  });
  it('Revoke also lowers an Allow always site, so it cannot be a silent no-op', async () => {
    const f = await fixture();
    await f.service.setSiteAccess(f.id, A, 'allow');
    await f.fill();
    expect(f.siteAsked).toEqual([]);
    await f.service.revoke(f.id, A);
    expect(statusOf(f).sites[A]).toBe('ask');
    await f.fill(); expect(f.siteAsked).toEqual([A]);
  });
  it('Revoke fences an action in flight', async () => {
    let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = 0;
    const f = await fixture({ askAction: async () => { entered++; await gate; return true; } });
    await f.run('agent_browser_snapshot');
    const pending = f.fill().catch(error => error as Error);
    await vi.waitFor(() => expect(entered).toBe(1));
    await f.service.revoke(f.id, A); release();
    const result = await pending;
    expect(result).toBeInstanceOf(Error); expect(f.inputs()).toBe(0);
  });
  it('Never in the middle of a task refuses the next action and drops the grant', async () => {
    const f = await fixture();
    await f.fill();
    await f.service.setSiteAccess(f.id, A, 'never');
    await expect(f.fill()).rejects.toThrow(/site_denied|not approved|NOT DONE/);
    expect(f.service.taskInfo(f.id)?.sites ?? []).toEqual([]);
    expect(f.inputs()).toBe(1);
  });
  it('a quiet Not now never creates a grant', async () => {
    const f = await fixture({ askSite: async () => 'ask' as const });
    await expect(f.run('agent_browser_snapshot')).rejects.toThrow('site_denied');
    expect(f.service.taskInfo(f.id)?.sites ?? []).toEqual([]);
  });
});

describe('T20 task access: lifetime and the end-of-task signal', () => {
  it('30 minutes idle ends the task and its grants; the next call is a new task', async () => {
    const f = await fixture();
    await f.fill(); const first = f.service.taskInfo(f.id)!.taskId;
    f.advance(29 * MIN); await f.service.expireTasks(); expect(f.service.taskInfo(f.id)?.taskId).toBe(first);
    f.advance(31 * MIN); await f.service.expireTasks();
    expect(f.service.taskInfo(f.id)).toBeUndefined();
    expect(f.ended.map(item => item.reason)).toEqual(['idle']);
    expect(approved(f)).not.toContain(A);
    ownerMessage++;
    await f.fill(); expect(f.siteAsked).toEqual([A, A]); expect(f.cards).toHaveLength(2);
  });
  it('activity inside the window keeps the task, but 8 hours is the hard end', async () => {
    const f = await fixture();
    await f.fill(); const first = f.service.taskInfo(f.id)!.taskId;
    for (let i = 0; i < 15; i++) { f.advance(25 * MIN); await f.fill(); }
    expect(f.service.taskInfo(f.id)!.taskId).toBe(first);
    for (let i = 0; i < 6; i++) { f.advance(25 * MIN); try { await f.fill(); } catch { ownerMessage++; await f.fill(); } }
    expect(f.ended.map(item => item.reason)).toContain('limit');
    expect(f.service.taskInfo(f.id)!.taskId).not.toBe(first);
  });
  it('End task, Stop and expiry each emit the signal once; the status carries taskEnded until a new task starts', async () => {
    const f = await fixture();
    expect(statusOf(f).taskEnded).toBeUndefined();
    await f.fill();
    await f.service.endTask(f.id);
    expect(f.ended.map(item => item.reason)).toEqual(['owner']);
    expect(statusOf(f)).toMatchObject({ taskEnded: true, state: 'active' });
    await f.service.endTask(f.id); expect(f.ended).toHaveLength(1);
    ownerMessage++;
    await f.fill(); expect(statusOf(f).taskEnded).toBeUndefined();
    await f.service.stop(f.id);
    expect(f.ended.map(item => item.reason)).toEqual(['owner', 'stop']);
    expect(statusOf(f).taskEnded).toBe(true);
  });
  it('Stop ends the grants', async () => {
    const f = await fixture();
    await f.fill(); await f.service.stop(f.id);
    expect(f.service.taskInfo(f.id)).toBeUndefined();
  });
  it('a takeover or disconnect ends the grants; a plain owner pause and resume keeps them', async () => {
    const f = await fixture();
    await f.fill();
    await f.service.pause(f.id);
    const b = f.bindings.get(f.id)!; b.state = 'active'; b.generation++;
    await f.service.handleMessage('profile', { version: 1, type: 'event', bindingId: f.id, generation: b.generation, event: 'resumed', data: {} } as never);
    expect(f.service.taskInfo(f.id)?.sites).toEqual([{ origin: A, l1: true, l2: true }]);
    b.generation++; b.state = 'paused';
    await f.service.handleMessage('profile', { version: 1, type: 'event', bindingId: f.id, generation: b.generation, event: 'takeover', data: {} } as never);
    expect(f.service.taskInfo(f.id)).toBeUndefined();
    expect(f.ended.map(item => item.reason)).toEqual(['takeover']);
  });
});

describe('T20 task access: the floor and the checker still decide', () => {
  it('a floor step is still handed to the owner with grants present, and no input is sent', async () => {
    const f = await fixture();
    await f.fill(); const before = f.inputs();
    f.setFacts({ tag: 'input', type: 'checkbox', role: 'checkbox', name: 'I agree to the terms and conditions' });
    await expect(f.run('agent_browser_click', { selector: 'input' })).rejects.toThrow(/^YOUR TURN:/);
    expect(f.inputs()).toBe(before); expect(statusOf(f).pausedReason).toBe('handoff');
  });
  it('the checker is called on every Level 2 action even when the site is granted', async () => {
    const f = await fixture();
    await f.fill(); await f.fill(); await f.fill();
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it('a checker that asks turns a granted Level 2 action back into a card; a block is refused or carded, never silent', async () => {
    const f = await fixture();
    await f.fill(); expect(f.cards).toHaveLength(1);
    f.setVerdict('ask'); await f.fill(); expect(f.cards).toHaveLength(2);
    f.setVerdict('block'); await f.fill().catch(() => {}); expect(f.cards.length).toBeGreaterThanOrEqual(3);
  });
  it('without a checker a granted site is Ask each step, as before', async () => {
    const f = await fixture({ checker: () => undefined });
    await f.fill(); await f.fill(); expect(f.cards).toHaveLength(2);
  });
  it('Ask each step mode keeps a card for every action with grants present', async () => {
    const f = await fixture({ approvalMode: () => 'step' as const });
    await f.fill(); await f.fill(); expect(f.cards).toHaveLength(2);
    expect(f.service.taskInfo(f.id)?.sites).toEqual([{ origin: A, l1: true, l2: false }]);
  });
});

describe('T20 task access: routines and the owner surfaces', () => {
  it('a routine never mints a grant: no site card, no action card, nothing held', async () => {
    const f = await fixture({ routine: () => true });
    await expect(f.fill()).rejects.toThrow();
    await expect(f.run('agent_browser_snapshot')).rejects.toThrow();
    expect(f.siteAsked).toEqual([]); expect(f.cards).toEqual([]); expect(f.inputs()).toBe(0);
    expect(f.service.taskInfo(f.id)?.sites ?? []).toEqual([]);
  });
  it('a routine on an Allow always site works without cards and still holds no card-made grant', async () => {
    const f = await fixture({ routine: () => true });
    await f.service.setSiteAccess(f.id, A, 'allow');
    await f.fill();
    expect(f.siteAsked).toEqual([]); expect(f.cards).toEqual([]); expect(f.inputs()).toBe(1);
  });
});

describe('T20 L12: the approved origins follow the grants and a failed bind fails closed', () => {
  it('a failed bind after Revoke pauses the binding instead of leaving the origin approved', async () => {
    const f = await fixture();
    await f.fill();
    f.failBinds(true);
    await expect(f.service.revoke(f.id, A)).rejects.toBeDefined();
    expect(statusOf(f).state).toBe('paused');
    await expect(f.fill()).rejects.toBeDefined();
  });
  it('a failed bind when a site card is granted takes the grant back', async () => {
    const f = await fixture(); f.failBinds(true);
    await expect(f.run('agent_browser_snapshot')).rejects.toBeDefined();
    expect(f.service.taskInfo(f.id)?.sites ?? []).toEqual([]);
  });
});

describe('T20 policy level exemption', () => {
  const identity = { bindingId: 'b1', workspaceId: 'w', botId: 'bot', threadId: 't', clientId: 'c', profileId: 'p' };
  const doc = { profileId: 'p', tabId: 1, frameId: 0, navigationEpoch: 1, origin: A };
  const action = (level?: 'L2' | 'L3') => ({ operation: 'fill', document: doc, targetDigest: 'a'.repeat(64), params: {}, ...(level ? { level } : {}) });
  const setup = () => { const p = new BrowserExtensionPolicy(); const c = p.bind(identity); p.share(c, doc, A + '/'); p.setSiteAccess(c, A, 'allow'); return { p, c }; };
  it('a mutation needs approval unless its level is L2 and the origin holds an L2 grant', () => {
    const { p, c } = setup();
    expect(p.check(c, action('L2') as never).requiresApproval).toBe(true);
    p.grantL2(c, A);
    expect(p.check(c, action('L2') as never).requiresApproval).toBe(false);
    expect(p.check(c, action('L3') as never).requiresApproval).toBe(true);
    expect(p.check(c, action() as never).requiresApproval).toBe(true);
    expect(p.check(c, action('L2') as never).mutation).toBe(true);
  });
  it('an L2 grant needs the site to be allowed, and lowering the site or stopping clears it', () => {
    const p = new BrowserExtensionPolicy(); const c = p.bind(identity); p.share(c, doc, A + '/');
    expect(() => p.grantL2(c, A)).toThrow();
    p.setSiteAccess(c, A, 'allow'); p.grantL2(c, A);
    p.setSiteAccess(c, A, 'ask'); p.setSiteAccess(c, A, 'allow');
    expect(p.check(c, action('L2') as never).requiresApproval).toBe(true);
    p.grantL2(c, A); const stopped = p.stop(c); p.resume(stopped, [doc]);
    expect(p.check(p.status('b1').context, action('L2') as never).requiresApproval).toBe(true);
  });
});
