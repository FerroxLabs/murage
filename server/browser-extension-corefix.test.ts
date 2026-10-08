// SPDX-License-Identifier: AGPL-3.0-or-later
// Opus security review of the Murage for Chrome core (BATCH3-CORE-SECURITY-REVIEW.md): one red test per blocking finding.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { safeWipe } from './testing/safe-wipe.mjs';
import { RoutineManager } from './routines.ts';
import { BrowserExtensionIntegration, routineThreadSignal } from './browser-extension-integration.ts';
import path from 'node:path';
import { createBrowserExtensionService } from './browser-extension-service.ts';
import { FakeNode, h, page, gmailChat, teamsV2, realCollectFacts, runRecipientScan, addLookalikeContact, addSecondWindow } from './testing/chat-dom-fixture.ts';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from '../shared/browser-extension-protocol.ts';
import { privateTestDirectory } from "./testing/private-test-dir.ts";
// Disk-fault injection reaches the writer the product uses on each platform: fs.writeFile of a temp file on
// macOS and Linux, the native helper's private write on Windows (browser-extension-windows.mjs).
const windowsWriteFault = vi.hoisted(() => ({ match: null as null | ((file: string) => boolean) }));
vi.mock('../electron/browser-extension-windows.mjs', async (importOriginal) => {
  const real = await importOriginal<typeof import('../electron/browser-extension-windows.mjs')>();
  return { ...real, writePrivateWindowsJson: (file: string, value: unknown, options?: unknown) => {
    if (windowsWriteFault.match?.(String(file))) throw Object.assign(Error('ENOSPC'), { code: 'ENOSPC' });
    return (real.writePrivateWindowsJson as (f: string, v: unknown, o?: unknown) => void)(file, value, options);
  } };
});
/** Every atomic save fails (ENOSPC) until mockRestore. */
function failAtomicWrites() {
  const real = fs.writeFile.bind(fs);
  const spy = vi.spyOn(fs, 'writeFile').mockImplementation(async (file: any, ...rest: any[]) => { if (String(file).includes('.tmp')) throw Object.assign(Error('ENOSPC'), { code: 'ENOSPC' }); return (real as any)(file, ...rest); });
  windowsWriteFault.match = () => true;
  return { mockRestore: () => { windowsWriteFault.match = null; spy.mockRestore(); } };
}

const A = 'https://fixture.test';
const cleanup: string[] = [];
afterEach(async () => { for (const directory of cleanup.splice(0)) await safeWipe(directory, { within: path.resolve('.') }); });

type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
let engineNode: (() => { backendNodeId: number; frameId?: string }) | undefined;
async function fixture(extra: Record<string, unknown> = {}) {
  engineNode = undefined;
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
        if (method === 'DOM.describeNode') value = { node: { backendNodeId: engineNode?.().backendNodeId ?? 12 } };
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
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected(), ...(engineNode?.() ?? {}) }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
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
  const goUrl = (url: string) => { const b = bindings.get(id)!; const t = b.tabs[0]; b.tabs[0] = { ...t, navigationEpoch: t.navigationEpoch + 1, origin: new URL(url).origin, url }; };
  const lastBind = () => [...calls].reverse().find(call => call.operation === 'bind');
  return { service, id, calls, siteAsked, cards, ended, transport, run, fill, inputs, goTo, goUrl, lastBind, bindings, options,
    setFacts: (v: Record<string, unknown>) => { facts = v; }, failBinds: (v: boolean) => { failBind = v; }, advance: (ms: number) => { clock += ms; }, setVerdict: (v: string) => { verdict = v; } };
}
type Mode = 'step' | 'task' | 'full';
const withMode = async (mode: Mode, extra: Record<string, unknown> = {}) => { const box = { mode }; const f = await fixture({ approvalMode: () => box.mode, ...extra }); return { ...f, box }; };
const SEND = { tag: 'button', role: 'button', name: 'Send message' };
describe('H1: a routine run is never treated as attended', () => {
  /** A REAL RoutineManager with a live run in the thread, and the app's own routine signal, handed to the integration the service asks. */
  async function routineFixture(kind: 'schedule' | 'manual' | 'none' | 'unattended') {
    const directory = await fs.mkdtemp(path.resolve('.modes-')); cleanup.push(directory);
    let now = new Date(2026, 8, 25, 8, 0, 0).getTime();
    const manager = new RoutineManager({ file: path.join(directory, 'routines.json'), now: () => now, botState: () => 'ready', createTask: () => ({ threadId: 'thread' }), startTurn: async () => undefined, interruptTurn: async () => undefined });
    const routine = manager.create({ name: 'Sweep', prompt: 'Sweep', botId: 'bot', schedule: { type: 'interval', everyMinutes: 30, anchorAt: now } } as never);
    if (kind === 'manual') { manager.runNow(routine.id); await manager.tick(); }
    if (kind === 'schedule') { now += 31 * 60_000; await manager.tick(); }
    expect(manager.isActiveThread('thread')).toBe(kind === 'manual' || kind === 'schedule');
    const integration = new BrowserExtensionIntegration({ dataDir: directory, socketDir: directory, workspaceId: 'workspace', approvalBus: { store: { bots: [], groups: [], messagesFor: () => [] } } as never, bot: () => undefined, protectedOrigins: [],
      routine: routineThreadSignal({ isUnattended: threadId => kind === 'unattended' && threadId === 'thread', routines: () => manager }) });
    const f = await withMode('full', { routine: (context: { threadId: string }) => integration.isRoutineThread(context.threadId) });
    return { ...f, manager };
  }
  for (const kind of ['schedule', 'manual', 'unattended'] as const) {
    it(`a ${kind} run in Full permissive on a normal site: no silent site, no grant, no card`, async () => {
      const f = await routineFixture(kind);
      await expect(f.fill()).rejects.toThrow();
      expect(f.siteAsked).toEqual([]);
      expect(f.cards).toEqual([]);
      expect(f.inputs()).toBe(0);
      const status = f.service.status().bindings.find(item => item.bindingId === f.id);
      expect(Object.keys(status?.sites ?? {}).filter(origin => status?.sites?.[origin] === 'allow')).toEqual([]);
    });
  }
  it('control: the same thread with no routine run is attended and Full permissive allows the site', async () => {
    const f = await routineFixture('none');
    await f.fill();
    expect(f.inputs()).toBe(1);
  });
});

// H1b (a turn a routine starts on another bot) is covered through the real ask-bot route in shared-routine-unattended-api.test.ts.

const EVIL = 'https://evil.example';
describe('H2: Full permissive does not follow an injected "open this site" without a card', () => {
  it('a bot-typed open to an origin the owner never named gets the I1 card, and no silent site grant', async () => {
    const f = await withMode('full');
    await f.fill();
    await f.run('agent_browser_open', { url: EVIL + '/' }).catch(() => undefined);
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toMatch(/not part of your request/i);
  });
  it('a site the owner named is still opened without a card', async () => {
    const f = await withMode('full', { ownerInstruction: () => ({ id: 'm1', text: 'please open https://news.test/ and read it' }) });
    await f.run('agent_browser_open', { url: 'https://news.test/' });
    expect(f.cards).toEqual([]);
  });
});
describe('M4: Full permissive without a checker asks about new sites', () => {
  it('no checker transport: the site card is raised', async () => {
    const f = await withMode('full', { checker: () => undefined });
    await f.fill();
    expect(f.siteAsked).toEqual([A]);
  });
});
describe('M3: End task and the task limits hold until the owner writes again', () => {
  const instr = { id: 'm1', text: 'please type hello into the notes box' };
  const setup = () => withMode('full', { ownerInstruction: () => instr });
  it('End task: the next call is refused with a plain line, and a new owner message starts a task', async () => {
    const f = await setup();
    await f.fill();
    await f.service.endTask(f.id, 'owner');
    await expect(f.fill()).rejects.toThrow(/owner ended this browser task/i);
    instr.id = 'm2';
    await f.fill();
    expect(f.inputs()).toBe(2);
    instr.id = 'm1';
  });
  it('a restart keeps the End task: the same owner message still cannot start a task', async () => {
    const f = await setup();
    await f.fill();
    await f.service.endTask(f.id, 'owner');
    await new Promise(resolve => setTimeout(resolve, 50));
    const restarted = await createBrowserExtensionService(f.options as never);
    const b = f.bindings.get(f.id)!; b.state = 'active'; b.generation++;
    await restarted.handleMessage('profile', { version: 1, type: 'event', bindingId: f.id, generation: b.generation, event: 'resumed', data: {} } as never);
    await expect(restarted.dispatch(f.id, 'agent_browser_fill', { selector: 'textarea', text: 'again' }, () => true)).rejects.toThrow(/owner ended this browser task/i);
    expect(f.inputs()).toBe(1);
  });
  it('the idle limit and the 8 hour limit hold the same way, and the refusal names the real reason', async () => {
    for (const [ms, reason] of [[31 * 60_000, /30 minutes/i], [9 * 3_600_000, /8 hours/i]] as const) {
      const f = await setup();
      await f.fill();
      f.advance(ms);
      await expect(f.fill()).rejects.toThrow(reason);
    }
  });
  it('Pause for longer than 30 minutes, then Resume: the task goes on and is not ended as idle', async () => {
    const f = await setup();
    await f.fill();
    await f.service.pause(f.id);
    f.advance(45 * 60_000);
    await f.service.expireTasks();
    const b = f.bindings.get(f.id)!; b.state = 'active'; b.generation++;
    await f.service.handleMessage('profile', { version: 1, type: 'event', bindingId: f.id, generation: b.generation, event: 'resumed', data: {} } as never);
    await f.fill();
    expect(f.inputs()).toBe(2);
    expect(f.ended).toEqual([]);
    // the idle clock restarted at Resume: 31 more quiet minutes still end it
    f.advance(31 * 60_000);
    await expect(f.fill()).rejects.toThrow(/30 minutes/i);
  });
});

describe('M1: a late Allow is not consumed over a checker answer or card that was not there when the owner read the card', () => {
  it('approval recorded under a checker allow, replayed under a checker flag: a fresh card', async () => {
    const saved: string[] = []; let asked = 0;
    const f = await withMode('step', {
      askAction: async (_c: unknown, _a: unknown, binding: unknown) => { asked++; saved.push(JSON.stringify(binding)); return 'waiting' as const; },
      consumeApproval: (_c: unknown, query: { kind: string; binding: unknown }) => query.kind === 'action' && saved.includes(JSON.stringify(query.binding)),
    });
    f.setFacts(SEND);
    const click = () => f.run('agent_browser_click', { selector: 'button' });
    await expect(click()).rejects.toThrow(/waiting/i);
    expect(asked).toBe(1);
    f.setVerdict('ask');
    await click().catch(() => undefined);
    expect(asked).toBe(2);
    expect(f.inputs()).toBe(0);
  });
});
describe('revoke-site: a failed write never lets an Allow always come back', () => {
  it('the revoke throws and a restart does not restore the allowed site', async () => {
    const f = await withMode('task');
    await f.service.setSiteAccess(f.id, A, 'allow');
    const spy = failAtomicWrites();
    await expect(f.service.revoke(f.id, A)).rejects.toThrow();
    spy.mockRestore();
    const restarted = await createBrowserExtensionService(f.options as never);
    const site = restarted.status().bindings.find(item => item.bindingId === f.id)?.sites?.[A];
    expect(site).not.toBe('allow');
  });
});

describe('M8: the 65th site of a task is refused now, not written into a file the next start rejects', () => {
  it('64 sites are held; the next one is refused and the saved file still loads', async () => {
    const f = await withMode('full');
    const visit = async (i: number) => { f.goTo(`https://s${i}.test`); return f.run('agent_browser_snapshot', {}); };
    await f.run('agent_browser_snapshot', {});
    for (let i = 0; i < 63; i++) await visit(i);
    await expect(visit(63)).rejects.toThrow();
    await expect(createBrowserExtensionService(f.options as never)).resolves.toBeDefined();
  });
});

describe('M9: text read from one site and typed into another raises a card in Full permissive', () => {
  const SECRET_TEXT = 'The quarterly merger announcement will be made on the fourteenth of March at nine in the morning.';
  const stubFetch = (body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/markdown' } })));
  afterEach(() => { vi.unstubAllGlobals(); });
  it('read of site B from a tab on site A, then typed on A: the carry card', async () => {
    stubFetch(SECRET_TEXT);
    const f = await withMode('full', { ownerInstruction: () => ({ id: 'm1', text: 'please read https://b.test/memo and type hello into the notes box' }) });
    await f.run('agent_browser_read', { url: 'https://b.test/memo' });
    expect(f.cards).toEqual([]);
    await f.run('agent_browser_fill', { selector: 'textarea', text: SECRET_TEXT });
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toMatch(/b\.test/);
  });
  it('control: text read from the same site and typed on it needs no card', async () => {
    stubFetch(SECRET_TEXT);
    const f = await withMode('full');
    await f.run('agent_browser_read', { url: A + '/memo' });
    await f.run('agent_browser_fill', { selector: 'textarea', text: SECRET_TEXT });
    expect(f.cards).toEqual([]);
  });
});

describe('M6: the owner pressing Continue after a checker pause actually continues', () => {
  const resume = async (f: Awaited<ReturnType<typeof withMode>>) => {
    const b = f.bindings.get(f.id)!; b.state = 'active'; b.generation++;
    await f.service.handleMessage('profile', { version: 1, type: 'event', bindingId: f.id, generation: b.generation, event: 'resumed', data: {} } as never);
  };
  it('three blocks pause the task; Continue lets the next allowed step run', async () => {
    const f = await withMode('task');
    f.setVerdict('block');
    for (let i = 0; i < 3; i++) await f.fill().catch(() => undefined);
    const before = f.inputs();
    await expect(f.fill()).rejects.toThrow();
    expect(f.inputs()).toBe(before);
    await resume(f);
    f.setVerdict('allow');
    await f.fill();
    expect(f.inputs()).toBe(before + 1);
  });
  it('after Continue the checker is asked again, and another block does not pause at once', async () => {
    const f = await withMode('task');
    f.setVerdict('block');
    for (let i = 0; i < 3; i++) await f.fill().catch(() => undefined);
    await resume(f);
    const asked = f.transport.mock.calls.length;
    await f.fill().catch(() => undefined);
    expect(f.transport.mock.calls.length).toBeGreaterThan(asked);
  });
  it('twenty checker outages in a task do not need a human on their own', async () => {
    const { CheckerTally } = await import('./browser-action-checker.ts');
    const tally = new CheckerTally();
    for (let i = 0; i < 25; i++) { tally.record({ decision: 'block', reason: 'r', code: 'checker_unavailable', stage: 1 }); tally.record({ decision: 'allow', reason: 'r', code: 'checker_ok', stage: 1 }); }
    expect(tally.needsHuman).toBe(false);
  });
  it('Continue gives a bounded number of further checks, not an unlimited number', async () => {
    const { CheckerTally } = await import('./browser-action-checker.ts');
    const tally = new CheckerTally(); const blk = { decision: 'block', reason: 'r', code: 'checker_block', stage: 2 } as const; const ok = { decision: 'allow', reason: 'r', code: 'checker_ok', stage: 1 } as const;
    for (let i = 0; i < 20; i++) { tally.record(blk); tally.record(ok); }
    expect(tally.needsHuman).toBe(true);
    tally.reset();
    expect(tally.needsHuman).toBe(false);
    for (let i = 0; i < 19; i++) { tally.record(blk); tally.record(ok); }
    expect(tally.needsHuman).toBe(false);
    tally.record(blk);
    expect(tally.needsHuman).toBe(true);
  });
});

describe('chat composers: a per-task approved conversation', () => {
  const CHAT = { ...SEND, recipientScanFailed: true, recipientNoField: true };
  const click = (f: Awaited<ReturnType<typeof withMode>>) => f.run('agent_browser_click', { selector: 'button' });
  const answer = { allow: true };
  async function chatFixture(extra: Record<string, unknown> = {}) {
    const flags = { routine: false };
    const f = await withMode('full', { askAction: async (_c: unknown, a: { summary: string }) => { f.cards.push(a.summary); return answer.allow; }, routine: () => flags.routine, ...extra });
    f.setFacts(CHAT); f.goUrl(A + '/c/abc123');
    return { ...f, flags };
  }
  it('the first send in a conversation cards, the owner Allow covers later sends there, another conversation cards again', async () => {
    const f = await chatFixture();
    await click(f);
    expect(f.cards).toHaveLength(1);
    expect(f.cards[0]).toMatch(/could not check who this goes to/i);
    await click(f); await click(f);
    expect(f.cards).toHaveLength(1);
    expect(f.inputs()).toBeGreaterThanOrEqual(6);
    f.goUrl(A + '/c/other999');
    await click(f);
    expect(f.cards).toHaveLength(2);
  });
  it('the identity is the exact path + query + fragment: a different query or fragment is another conversation, another origin too', async () => {
    const f = await chatFixture();
    await click(f);
    await click(f);
    expect(f.cards).toHaveLength(1);
    f.goUrl(A + '/c/abc123?tab=2#latest');
    await click(f);
    expect(f.cards).toHaveLength(2);
    await click(f);
    expect(f.cards).toHaveLength(2);
  });
  it('another origin with the same path is a different conversation', async () => {
    const f = await chatFixture();
    await click(f);
    f.goUrl('https://other.test/c/abc123');
    await click(f);
    expect(f.cards).toHaveLength(2);
  });
  it('Gmail Chat keeps the conversation in the fragment: #chat/dm/A and #chat/dm/B are different, and an injected jump to B cards in Full permissive', async () => {
    const f = await chatFixture();
    f.goUrl(A + '/chat/u/0#chat/dm/AAAAq7x9kLm');
    await click(f); await click(f);
    expect(f.cards).toHaveLength(1);
    f.goUrl(A + '/chat/u/0#chat/dm/BBBBr2y8nPq');
    await click(f);
    expect(f.cards).toHaveLength(2);
    expect(f.cards[1]).toMatch(/could not check who this goes to/i);
  });
  it('Google Voice keeps the conversation in the query: ?itemId=A and ?itemId=B are different', async () => {
    const f = await chatFixture();
    f.goUrl(A + '/u/0/messages?itemId=1234567890');
    await click(f); await click(f);
    expect(f.cards).toHaveLength(1);
    f.goUrl(A + '/u/0/messages?itemId=9876543210');
    await click(f);
    expect(f.cards).toHaveLength(2);
  });
  it('a client-state app (Teams at /v2) never qualifies: every send cards', async () => {
    for (const url of [A + '/v2', A + '/v2/', A + '/app/chat', A + '/chat/u/0']) {
      const f = await chatFixture();
      f.goUrl(url);
      await click(f); await click(f);
      expect(f.cards, url).toHaveLength(2);
    }
  });
  it('a denied card sets nothing', async () => {
    const f = await chatFixture();
    answer.allow = false;
    try { await click(f).catch(() => undefined); await click(f).catch(() => undefined); } finally { answer.allow = true; }
    expect(f.cards).toHaveLength(2);
  });
  it('an app with no conversation in its path cards every send', async () => {
    for (const url of [A + '/', A + '/inbox', A + '/?c=ab', A + '/#inbox', A + '/mail/inbox']) {
      const f = await chatFixture();
      f.goUrl(url);
      await click(f); await click(f);
      expect(f.cards, url).toHaveLength(2);
    }
  });
  it('a send where the scan found no field but could not finish (a cap or a frame) gets the normal I2 path, approved conversation or not', async () => {
    const f = await chatFixture();
    await click(f);
    expect(f.cards).toHaveLength(1);
    f.setFacts({ ...SEND, recipientScanFailed: true });
    await click(f);
    expect(f.cards).toHaveLength(2);
  });
  it('a send with a recipient in scope gets the normal I2 path, approved conversation or not', async () => {
    const f = await chatFixture();
    await click(f);
    f.setFacts({ ...SEND, recipients: ['attacker@evil.example'] });
    await click(f);
    expect(f.cards).toHaveLength(2);
    expect(f.cards[1]).toMatch(/attacker@evil\.example/);
  });
  it('round 7: a card number among the facts never reaches the card or the refusal the bot reads', async () => {
    const f = await chatFixture();
    await click(f);
    f.setFacts({ ...SEND, recipients: ['4111 1111 1111 1111', 'attacker@evil.example'] });
    await click(f);
    expect(f.cards[1]).toMatch(/attacker@evil\.example/);
    expect(f.cards.join('\n')).not.toMatch(/4111/);
    f.flags.routine = true;
    const refusal = await click(f).then(() => '', e => String(e?.message ?? e));
    f.flags.routine = false;
    expect(refusal).not.toMatch(/4111/);
  });
  it('a routine never sets it and never uses it', async () => {
    const f = await chatFixture();
    await click(f);
    f.flags.routine = true;
    await expect(click(f)).rejects.toThrow();
    f.flags.routine = false;
    const g = await chatFixture();
    g.flags.routine = true;
    await expect(click(g)).rejects.toThrow();
    g.flags.routine = false;
    await click(g);
    expect(g.cards).toHaveLength(1);
  });
  it('it ends with the task: End task and a new owner message', async () => {
    const instr = { id: 'm1', text: 'please send hello in this chat' };
    const f = await chatFixture({ ownerInstruction: () => instr });
    await click(f);
    await f.service.endTask(f.id, 'owner');
    instr.id = 'm2';
    await click(f);
    expect(f.cards).toHaveLength(2);
  });
  it('it ends with Stop', async () => {
    const f = await chatFixture();
    await click(f);
    await f.service.stop(f.id);
    expect(f.service.taskInfo(f.id)).toBeUndefined();
  });
  it('it ends when the owner revokes the site, or sets it to Ask or Never', async () => {
    for (const how of ['revoke', 'ask', 'never'] as const) {
      const f = await chatFixture();
      await click(f);
      if (how === 'revoke') await f.service.revoke(f.id, A); else await f.service.setSiteAccess(f.id, A, how);
      if (how === 'never') { await expect(click(f)).rejects.toThrow(); continue; }
      await click(f);
      expect(f.cards.filter(c => /could not check who this goes to/i.test(c)), how).toHaveLength(2);
    }
  });
  // Round 4: the approval is for typing in the composer and the send, nothing else on the tab.
  const CONTACT = { tag: 'div', role: 'button', name: 'Bob Smith' };
  const intoFull = async (url: string) => {
    const f = await chatFixture();
    f.goUrl(url);
    await click(f);
    expect(f.cards).toHaveLength(1);
    await click(f);
    expect(f.cards).toHaveLength(1);
    return f;
  };
  const clickElsewhere = async (f: Awaited<ReturnType<typeof chatFixture>>, name = 'agent_browser_click') => {
    f.setFacts(CONTACT);
    await f.run(name, name === 'agent_browser_select' ? { selector: 'select', values: ['bob'] } : { selector: 'div.contact' });
    f.setFacts(CHAT);
  };
  it('Gmail Chat pop-up over #inbox/<id>: the URL does not change when the bubble switches, so a click ends the approval', async () => {
    const f = await intoFull('https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKw7LpWzrBsDq4VzHxM');
    await clickElsewhere(f);
    await click(f);
    expect(f.cards).toHaveLength(2);
    expect(f.cards[1]).toMatch(/could not check who this goes to/i);
  });
  it('Teams ?tenantId=<guid>: the id names the tenant, so a click on another chat ends the approval', async () => {
    const f = await intoFull('https://teams.microsoft.com/v2/?tenantId=4b2a8c1e-7d3f-4e5a-9b6c-1d2e3f4a5b6c');
    await clickElsewhere(f);
    await click(f);
    expect(f.cards).toHaveLength(2);
  });
  it('a click on another contact, then a send, cards in Full permissive', async () => {
    const f = await intoFull(A + '/c/abc123');
    await clickElsewhere(f);
    await click(f);
    expect(f.cards).toHaveLength(2);
  });
});

describe('M8: a saved site the policy now refuses is dropped at startup, not fatal', () => {
  it('the service starts, the site is gone from the list, and one log line says so', async () => {
    const f = await withMode('task');
    await f.service.setSiteAccess(f.id, 'https://old.test', 'allow');
    await f.service.setSiteAccess(f.id, A, 'allow');
    const lines: string[] = [];
    const restarted = await createBrowserExtensionService({ ...f.options, protectedOrigins: ['https://old.test'], log: (line: string) => lines.push(line) } as never);
    const sites = restarted.status().bindings.find(item => item.bindingId === f.id)?.sites ?? {};
    expect(sites['https://old.test']).toBeUndefined();
    expect(sites[A]).toBe('ask'); // round 9 (R8-12): an Allow always read from disk is not trusted
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/old\.test/);
    expect(lines[0]).not.toMatch(/token|secret/i);
  });
  it('a granted task site the policy now refuses is dropped from the task too (round 8: nothing resumes at all)', async () => {
    const f = await withMode('full');
    await f.fill(); f.goTo('https://grant.test'); await f.run('agent_browser_snapshot', {});
    const lines: string[] = [];
    const restarted = await createBrowserExtensionService({ ...f.options, protectedOrigins: ['https://grant.test'], log: (line: string) => lines.push(line) } as never);
    expect(restarted.taskInfo(f.id)?.sites.map(item => item.origin) ?? []).not.toContain('https://grant.test');
    expect(restarted.taskInfo(f.id)).toBeUndefined();
    void lines;
  });
});

describe('revoke-site: the owner is told once when a failed write turned Allow always sites back to Ask', () => {
  it('the restart reports the lowered sites to the owner once, and a second restart does not repeat it', async () => {
    const f = await withMode('task');
    await f.service.setSiteAccess(f.id, A, 'allow');
    await f.service.setSiteAccess(f.id, 'https://second.test', 'allow');
    const spy = failAtomicWrites();
    await expect(f.service.revoke(f.id, A)).rejects.toThrow();
    spy.mockRestore();
    const restarted = await createBrowserExtensionService(f.options as never);
    expect(await restarted.takeLowered('bot')).toEqual(expect.arrayContaining([A, 'https://second.test']));
    expect(await restarted.takeLowered('bot')).toEqual([]);
    const again = await createBrowserExtensionService(f.options as never);
    expect(await again.takeLowered('bot')).toEqual([]);
  });
  it('the note survives a restart until the owner has been told', async () => {
    const f = await withMode('task');
    await f.service.setSiteAccess(f.id, A, 'allow');
    const spy = failAtomicWrites();
    await expect(f.service.revoke(f.id, A)).rejects.toThrow();
    spy.mockRestore();
    await createBrowserExtensionService(f.options as never);
    const second = await createBrowserExtensionService(f.options as never);
    expect(await second.takeLowered('bot')).toEqual([A]);
  });
  it('the lowered note is on the next status poll too, and stays until the sites list takes it', async () => {
    const f = await withMode('task');
    await f.service.setSiteAccess(f.id, A, 'allow');
    const spy = failAtomicWrites();
    await expect(f.service.revoke(f.id, A)).rejects.toThrow();
    spy.mockRestore();
    const restarted = await createBrowserExtensionService(f.options as never);
    expect((restarted.status().bindings.find(item => item.bindingId === f.id) as { sitesLowered?: boolean }).sitesLowered).toBe(true);
    await restarted.takeLowered('bot');
    expect((restarted.status().bindings.find(item => item.bindingId === f.id) as { sitesLowered?: boolean }).sitesLowered).toBeUndefined();
  });
  it('nothing is reported when nothing was lowered', async () => {
    const f = await withMode('task');
    expect(await f.service.takeLowered('bot')).toEqual([]);
  });
});

// Round 5: the same behaviour on pages shaped like the real ones. `recipientNoField` and the target's tag and role come out of the REAL
// recipient scan and collectFloorFacts over a DOM model of Gmail Chat and Teams v2, never from a hand-set fact.
describe('round 5: an approved chat conversation on Gmail Chat and Teams v2 DOM', () => {
  const GMAIL = 'https://mail.google.com/mail/u/0/#inbox/FMfcgzQXKw7LpWzrBsDq4VzHxM';
  const TEAMS = 'https://teams.microsoft.com/v2/?tenantId=4b2a8c1e-7d3f-4e5a-9b6c-1d2e3f4a5b6c';
  async function chatPage(kind: 'gmail' | 'teams') {
    const dom = kind === 'gmail' ? gmailChat() : teamsV2();
    let current: FakeNode = dom.composer;
    const f = await withMode('full', { collectFacts: realCollectFacts(() => current), ownerInstruction: () => ({ id: 'm1', text: 'please tell Alice hello in the chat, and look up bob' }) });
    engineNode = () => ({ backendNodeId: current.nodeId });
    f.goUrl(kind === 'gmail' ? GMAIL : TEAMS);
    const on = (el: FakeNode) => { current = el; };
    const click = (el: FakeNode) => { on(el); return f.run('agent_browser_click', { selector: 'x' }); };
    const fillIn = (el: FakeNode, text = 'hello') => { on(el); return f.run('agent_browser_fill', { selector: 'x', text }); };
    const press = (el: FakeNode, key = 'Enter') => { on(el); return f.run('agent_browser_press', { key }); };
    const sendMessage = async () => { await fillIn(dom.composer); await click(dom.send); };
    const search = kind === 'gmail' ? (dom as ReturnType<typeof gmailChat>).find : (dom as ReturnType<typeof teamsV2>).search;
    const f_select = (el: FakeNode) => { on(el); return f.run('agent_browser_select', { selector: 'select', values: ['bob'] }); };
    const f_open = () => f.run('agent_browser_open', { url: kind === 'gmail' ? GMAIL : TEAMS }).catch(() => undefined);
    const setFrame = (frameId: string | undefined) => { engineNode = () => ({ backendNodeId: current.nodeId, ...(frameId === undefined ? {} : { frameId }) }); };
    return { ...f, dom, search, click, fillIn, press, sendMessage, f_select, f_open, setFrame, replace: (el: FakeNode, by: FakeNode) => { by.parentNode = el.parentNode; el.parentNode!.children[el.parentNode!.children.indexOf(el)] = by; by.ownerDocument = el.ownerDocument; } };
  }
  it.each(['gmail', 'teams'] as const)('%s: the real scan identifies composers only for send-capable activations', async kind => {
    const c = await chatPage(kind);
    for (const el of [c.dom.alice, c.dom.bob, c.search, c.dom.composer, c.dom.send]) {
      const result = runRecipientScan(el);
      if (el === c.dom.send || el.getAttribute('role') === 'button') {
        expect(result.noRecipientField).toBe(false);
        expect(result.composerOnly, el.getAttribute('aria-label') ?? '').toBe(kind === 'gmail');
        if (kind === 'teams') expect(result.incomplete).toBe(true);
      } else expect(result).toMatchObject({ sendCapable: false, incomplete: false });
    }
  });
  it.each(['gmail', 'teams'] as const)('%s: Allow for Alice, click Bob, then send: a card', async kind => {
    const c = await chatPage(kind);
    await c.sendMessage();
    expect(c.cards).toHaveLength(1);
    await c.click(c.dom.bob);
    if (kind === 'gmail') {
      // Script-handled contact buttons now require the same certainty as Send.
      expect(c.cards).toHaveLength(2);
      await expect(c.sendMessage()).rejects.toThrow(/page kept asking/);
    } else await c.sendMessage();
    expect(c.cards).toHaveLength(2);
    expect(c.cards[1]).toMatch(/could not check who this goes to/i);
  });
  it.each(['gmail', 'teams'] as const)('%s: Allow, then Bob, then the send click alone (no new typing): a card', async kind => {
    const c = await chatPage(kind);
    await c.sendMessage();
    await c.click(c.dom.bob);
    if (kind === 'gmail') await expect(c.click(c.dom.send)).rejects.toThrow(/page kept asking/);
    else await c.click(c.dom.send);
    expect(c.cards).toHaveLength(2);
  });
  /** The send is not allowed to go through silently: it raised a card, or it was refused (the task paused after several cards) with no input sent. */
  const sendNeedsCard = async (c: Awaited<ReturnType<typeof chatPage>>) => {
    await c.fillIn(c.dom.composer);
    const cards = c.cards.length, inputs = c.inputs();
    let refused = false;
    await c.click(c.dom.send).catch(() => { refused = true; });
    expect(refused ? c.inputs() === inputs : c.cards.length > cards, `cards ${cards} -> ${c.cards.length}, refused ${refused}`).toBe(true);
  };
  it.each(['gmail', 'teams'] as const)('%s: Allow, fill the search box, Enter, then send: a card', async kind => {
    const c = await chatPage(kind);
    await c.sendMessage();
    expect(c.cards).toHaveLength(1);
    await c.fillIn(c.search, 'bob');
    await c.press(c.search).catch(() => undefined);
    await sendNeedsCard(c);
  });
  it.each(['gmail', 'teams'] as const)('%s: Allow, an Enter in the search box with no typing before it: its own card, and then the send needs one', async kind => {
    const c = await chatPage(kind);
    await c.sendMessage();
    await c.press(c.search).catch(() => undefined);
    expect(c.cards.length).toBeGreaterThanOrEqual(2);
    await sendNeedsCard(c);
  });
  it.each(['gmail', 'teams'] as const)('%s: Allow, a click on the search box, then send: a card', async kind => {
    const c = await chatPage(kind);
    await c.sendMessage();
    await c.click(c.search);
    await sendNeedsCard(c);
  });
  it.each(['gmail', 'teams'] as const)('%s: Allow, a click on another chat, then send: a card', async kind => {
    const c = await chatPage(kind);
    await c.sendMessage();
    await c.click(c.dom.alice);
    await sendNeedsCard(c);
  });
  // Round 6: the approved send and composer are the ELEMENTS the owner allowed (same node, tab, epoch and frame), not anything that looks like them.
  it('gmail: a contact named exactly "Send message": clicking it, then the real send, is a card', async () => {
    const c = await chatPage('gmail');
    const lookalike = addLookalikeContact(c.dom as ReturnType<typeof gmailChat>);
    await c.sendMessage();
    expect(c.cards).toHaveLength(1);
    await c.click(lookalike).catch(() => undefined);
    await sendNeedsCard(c);
  });
  it('gmail: Allow in window A, then fill and send in window B with identical labels: a card', async () => {
    const c = await chatPage('gmail');
    const b = addSecondWindow(c.dom as ReturnType<typeof gmailChat>);
    await c.sendMessage();
    expect(c.cards).toHaveLength(1);
    await c.fillIn(b.composer);
    const cards = c.cards.length, inputs = c.inputs();
    let refused = false;
    await c.click(b.send).catch(() => { refused = true; });
    expect(refused ? c.inputs() === inputs : c.cards.length > cards).toBe(true);
  });
  it('gmail: the composer replaced by an identical clone after Allow: typing and sending cards again', async () => {
    const c = await chatPage('gmail');
    await c.sendMessage();
    expect(c.cards).toHaveLength(1);
    const clone = c.dom.composer.clone(); const sendClone = c.dom.send.clone();
    c.replace(c.dom.composer, clone); c.replace(c.dom.send, sendClone);
    await c.fillIn(clone);
    const cards = c.cards.length;
    await c.click(sendClone).catch(() => undefined);
    expect(c.cards.length).toBeGreaterThan(cards);
  });
  it('gmail: only the send replaced by an identical clone: a card', async () => {
    const c = await chatPage('gmail');
    await c.sendMessage();
    const sendClone = c.dom.send.clone(); c.replace(c.dom.send, sendClone);
    await c.fillIn(c.dom.composer);
    const cards = c.cards.length;
    await c.click(sendClone).catch(() => undefined);
    expect(c.cards.length).toBeGreaterThan(cards);
  });
  it.each([['no frame identity', ''], ['a child frame', 'child-frame-7']])('gmail: a composer and send inside an iframe with %s: refused every time, nothing is sent (C1: the engine names the real frame)', async (_name, frame) => {
    const c = await chatPage('gmail');
    c.setFrame(frame);
    for (let i = 0; i < 3; i++) {
      const inputs = c.inputs();
      await expect(c.sendMessage()).rejects.toThrow(/embedded frame/);
      expect(c.inputs(), `send ${i}`).toBe(inputs);
    }
  });
  it.each(['gmail', 'teams'] as const)('%s: repeated sends reuse only a completely classified conversation', async kind => {
    const c = await chatPage(kind);
    await c.sendMessage();
    expect(c.cards).toHaveLength(1);
    if (kind === 'teams') {
      // Its treeitem contacts have unresolved values, so approval is not reusable.
      await c.sendMessage(); expect(c.cards).toHaveLength(2);
      await c.fillIn(c.dom.composer); const inputs = c.inputs();
      await expect(c.click(c.dom.send)).rejects.toThrow(/page kept asking/);
      expect(c.inputs()).toBe(inputs);
    } else {
      for (let i = 0; i < 4; i++) await c.sendMessage();
      expect(c.cards).toHaveLength(1);
    }
  });
  it.each(['gmail', 'teams'] as const)('%s: Allow, then a select or an open on the tab, then send: a card', async kind => {
    for (const how of ['select', 'open'] as const) {
      const c = await chatPage(kind);
      await c.sendMessage();
      if (how === 'select') await c.f_select(c.dom.bob); else await c.f_open();
      await sendNeedsCard(c);
    }
  });
  it.each(['gmail', 'teams'] as const)('%s: Enter reuses only a complete composer classification and search invalidates it', async kind => {
    const c = await chatPage(kind);
    await c.fillIn(c.dom.composer); await c.press(c.dom.composer);
    expect(c.cards).toHaveLength(1);
    if (kind === 'teams') {
      await c.fillIn(c.dom.composer); await c.press(c.dom.composer); expect(c.cards).toHaveLength(2);
      await c.fillIn(c.dom.composer); const inputs = c.inputs();
      await expect(c.press(c.dom.composer)).rejects.toThrow(/page kept asking/);
      expect(c.inputs()).toBe(inputs); return;
    }
    for (let i = 0; i < 3; i++) { await c.fillIn(c.dom.composer); await c.press(c.dom.composer); }
    expect(c.cards).toHaveLength(1);
    await c.fillIn(c.search, 'bob'); await c.press(c.search).catch(() => undefined);
    await c.fillIn(c.dom.composer);
    const before = c.cards.length, inputs = c.inputs();
    let refused = false;
    await c.press(c.dom.composer).catch(() => { refused = true; });
    expect(refused ? c.inputs() === inputs : c.cards.length > before).toBe(true);
  });
  it('a page that names a contact like the send button is not the approved send: its own card', async () => {
    const c = await chatPage('gmail');
    await c.sendMessage();
    const fake = new FakeNode('div', { role: 'button', 'aria-label': 'Send to Bob Smith' }, []);
    fake.ownerDocument = c.dom.alice.ownerDocument; fake.parentNode = c.dom.alice.parentNode;
    await c.click(fake);
    expect(c.cards).toHaveLength(2);
  });
});


describe('Round 2: ordinary actions never accumulate missing-recipient asks', () => {
  it.each(['button', 'a'])('repeated %s clicks use the real scan without an I7 pause', async tag => {
    const el = h(tag, tag === 'a' ? { href: '/file', download: 'receipt.txt' } : { type: 'button' }, tag === 'a' ? 'Download the receipt (small)' : 'Show alert');
    page(el);
    const f = await withMode('task', { collectFacts: realCollectFacts(() => el), checker: () => undefined });
    engineNode = () => ({ backendNodeId: el.nodeId });
    for (let i = 0; i < 4; i++) {
      const result = await f.run('agent_browser_click', { selector: 'x' }) as { isError?: boolean } | undefined;
      expect(result?.isError).not.toBe(true);
    }
    expect(f.cards.join(' ')).not.toMatch(/could not check who|kept asking/);
    expect(f.service.status().bindings.find(b => b.bindingId === f.id)?.state).toBe('active');
  });
});

// Round 6: only unknown sends consume the I7 budget, through the real service.
describe('Round 6 strict recipient counters', () => {
  it('four known new-recipient cards do not turn into an I7 refusal', async () => {
    const send = h('button', {}, 'Send'); page(h('input', { name: 'to', value: 'unrequested@example.com' }), send);
    const f = await withMode('full', { collectFacts: realCollectFacts(() => send) });
    engineNode = () => ({ backendNodeId: send.nodeId });
    for (let i = 0; i < 4; i++) await f.run('agent_browser_click', { selector: 'x' });
    expect(f.cards).toHaveLength(4);
    expect(f.cards.join(' ')).toContain('unrequested@example.com');
    expect(f.cards.join(' ')).not.toContain('kept asking');
  });
  it('typing and ordinary links do not consume the unknown-send budget', async () => {
    const field = h('input'); const send = h('button', {}, 'Send'); const link = h('a', { href: '/next' }, 'Next'); page(field, send, link);
    let current = field;
    const f = await withMode('full', { collectFacts: realCollectFacts(() => current) });
    engineNode = () => ({ backendNodeId: current.nodeId });
    for (let i = 0; i < 4; i++) { current = field; await f.run('agent_browser_fill', { selector: 'x', text: 'hello' }); current = link; await f.run('agent_browser_click', { selector: 'x' }); }
    expect(f.cards.join(' ')).not.toMatch(/could not check who|kept asking/);
    current = send;
    await f.run('agent_browser_click', { selector: 'x' });
    await f.run('agent_browser_click', { selector: 'x' });
    const before = f.inputs();
    await expect(f.run('agent_browser_click', { selector: 'x' })).rejects.toThrow(/kept asking/);
    expect(f.inputs()).toBe(before);
  });
});
