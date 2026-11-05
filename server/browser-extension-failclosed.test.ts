// SPDX-License-Identifier: AGPL-3.0-or-later
// SABLE-B r8 design 5.6 "A failed grant fails closed" (tests 25, 38, 47, 51, 52, 53, 54, 55). The fake extension below models the
// runtime's own rules (runtime.mjs, d2933fab0): a bind or command carries the server's generation and a stale one is refused; a bind
// replaces the set and makes the binding ready only while active; every pause, owner resume and disconnect sets ready false and moves
// the generation; the app's Continue needs a handoff pause; the panel's Resume is refused while handoff-paused and its Continue needs one.
// Labels: FAILS = red on base d2933fab0; PIN = green on base; NEW = a new helper (base n/a).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { safeWipe } from './testing/safe-wipe.mjs';
import { privateTestDirectory } from './testing/private-test-dir.ts';
import { createBrowserExtensionService, GRANT_FAILED_TEXT, GRANT_CONTINUE_TEXT } from './browser-extension-service.ts';
import type { BrowserExtensionCommand, BrowserExtensionResponse, BrowserExtensionHello } from '../shared/browser-extension-protocol.ts';

const A = 'https://fixture.test';
const D = 'https://d.example';
const O = 'https://other.example';
const FAILED = new RegExp(GRANT_FAILED_TEXT.slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
const cleanup: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of cleanup.splice(0)) await safeWipe(directory, { within: path.resolve('.') }); });

type Tab = { tabId: number; navigationEpoch: number; origin: string; url: string };
type FB = { generation: number; state: 'active' | 'paused' | 'stopped'; pausedReason?: 'handoff'; handoff?: string; ready: boolean; approved: string[]; tabs: Tab[] };
type Reply = { result: unknown } | { error: string };
/** A one-shot handler for the next request of one kind. `apply` runs the fake's own rule now and returns its reply; the handler may wait,
 * throw (a broker-level rejection), or return any reply. */
type Handler = (command: BrowserExtensionCommand, apply: () => Reply) => Promise<Reply> | Reply;
const hold = () => { let release!: () => void; let arrive!: () => void; const released = new Promise<void>(resolve => { release = resolve; }); const arrived = new Promise<void>(resolve => { arrive = resolve; }); return { released, arrived, release, arrive }; };

async function fixture(extra: Record<string, unknown> = {}) {
  const { root, directory } = await privateTestDirectory(path.resolve('.failclosed-')); cleanup.push(root);
  let connected = true;
  const bindings = new Map<string, FB>();
  const log: { op: string; method?: string; generation: number; bindingId: string; params: Record<string, unknown> }[] = [];
  const drops: string[] = [];
  const handlers = new Map<string, Handler[]>();
  const events: Promise<unknown>[] = [];
  const handoffs: { category: unknown; text: string; site: string }[] = [];
  const continues: string[] = [];
  let failResumeSave = false;
  let service!: Awaited<ReturnType<typeof createBrowserExtensionService>>;
  const summary = (b: FB) => ({ generation: b.generation, state: b.state, ready: b.ready, ...(b.state === 'paused' && b.pausedReason ? { pausedReason: b.pausedReason } : {}), tabs: structuredClone(b.tabs), approvedOrigins: [...b.approved], ...(b.tabs[0] ? { selectedTabId: b.tabs[0].tabId } : {}) });
  // runtime.mjs fence (:575-582): Stop is final; generation+1, ready false; a handoff pause sets the reason; a plain pause keeps a waiting handoff.
  const fence = (b: FB, state: FB['state'], handoff?: string) => {
    if (b.state === 'stopped' && state !== 'stopped') return;
    b.generation++; b.state = state; b.ready = false;
    if (state === 'paused' && handoff !== undefined) { b.pausedReason = 'handoff'; b.handoff = handoff; }
    else if (state !== 'paused' || b.pausedReason !== 'handoff') { delete b.pausedReason; delete b.handoff; }
  };
  const emit = (bindingId: string, b: FB, event: string) => {
    const at = b.generation, data = summary(b);
    const sent = new Promise(resolve => setTimeout(resolve, 0)).then(() => service.handleMessage('profile', { version: 1, type: 'event', bindingId, generation: at, event, data } as never)).catch(() => {});
    events.push(sent);
  };
  // runtime.mjs ownerResume (:1046-1054): every tab must be on an approved site; generation+1, active, ready false; the save can fail after it activated.
  const ownerResume = (bindingId: string, b: FB, deliver = true): Reply => {
    if (!connected) return { error: 'host_offline' };
    for (const tab of b.tabs) if (tab.origin !== 'null' && !b.approved.includes(tab.origin)) return { error: 'site_denied' };
    b.generation++; b.state = 'active'; b.ready = false; delete b.pausedReason; delete b.handoff;
    if (failResumeSave) { failResumeSave = false; return { error: 'persistence_failed' }; }
    if (deliver) emit(bindingId, b, 'resumed');
    return { result: summary(b) };
  };
  const ruleFor = (command: BrowserExtensionCommand): Reply => {
    let b = bindings.get(command.bindingId);
    const params = (command.params ?? {}) as Record<string, any>;
    if (command.operation === 'bind') {
      if (!b) { b = { generation: 1, state: 'active', ready: true, approved: [...params.approvedOrigins], tabs: [{ tabId: 1 + 10 * bindings.size, navigationEpoch: 1, origin: A, url: A + '/' }] }; bindings.set(command.bindingId, b); return { result: summary(b) }; }
      if (b.generation !== command.generation) return { error: 'stale_generation' };
      b.approved = [...params.approvedOrigins]; b.ready = b.state === 'active';
      return { result: summary(b) };
    }
    if (!b) return { error: 'unknown_binding' };
    if (command.operation === 'status') return { result: summary(b) };
    if (b.generation !== command.generation) return { error: 'stale_generation' };
    if (command.operation === 'pause' || command.operation === 'stop') { fence(b, command.operation === 'stop' ? 'stopped' : 'paused', command.operation === 'pause' && params.reason === 'handoff' ? String(params.handoff ?? '') : undefined); return { result: summary(b) }; }
    if (command.operation === 'resume') { if (params.reason === 'continue' && b.state === 'paused' && b.pausedReason === 'handoff') return ownerResume(command.bindingId, b); return { error: 'owner_action_required' }; }
    if (b.state !== 'active' || !b.ready) return { error: 'binding_inactive' };
    if (command.operation === 'cdp') {
      const { method, params: p } = params as { method: string; params: Record<string, unknown> }; let value: any = {};
      if (method === 'Page.getFrameTree') value = { frameTree: { frame: { id: 'frame', loaderId: 'L' } } };
      if (method === 'Page.createIsolatedWorld') value = { executionContextId: 7 };
      if (method === 'DOM.getDocument') value = { root: { nodeType: 9, children: [] } };
      if (method === 'DOM.describeNode') value = { node: { backendNodeId: 12 } };
      if (method === 'DOM.resolveNode') value = { object: { objectId: 'target' } };
      if (method === 'Runtime.evaluate') value = { result: { value: String(p?.expression).includes('__murageGuard()') ? false : 'page', objectId: 'target' } };
      if (method === 'Runtime.callFunctionOn') value = { result: { value: String(p?.functionDeclaration).includes('elementFromPoint') ? true : JSON.stringify({ display: { tag: 'BUTTON', text: 'x', label: 'x' }, bound: null }) } };
      return { result: { result: value, ...b.tabs[0] } };
    }
    return { result: summary(b) };
  };
  const broker = {
    profiles: (): BrowserExtensionHello[] => connected ? [{ version: 1, type: 'hello', profileId: 'profile', browser: 'chromium', extensionVersion: '1.0', capabilities: ['scoped_cdp', 'durable_stop', 'explicit_share', 'manual_pause', 'engine_cdp_v1', 'unexpected_input_pause', 'ordered_requests_v1'] }] : [],
    async request(_profile: string, command: BrowserExtensionCommand): Promise<BrowserExtensionResponse> {
      if (!connected) throw Error('host_offline');
      const params = (command.params ?? {}) as Record<string, any>;
      const method = command.operation === 'cdp' ? String(params.method) : undefined;
      log.push({ op: command.operation, ...(method ? { method } : {}), generation: command.generation, bindingId: command.bindingId, params });
      const key = method ? `cdp:${method}` : command.operation;
      const handler = handlers.get(key)?.shift();
      const reply = handler ? await handler(command, () => ruleFor(command)) : ruleFor(command);
      if (!connected) throw Error('host_lost_uncertain');
      const envelope = { version: 1 as const, type: 'response' as const, id: command.id, bindingId: command.bindingId, generation: command.generation };
      return ('error' in reply ? { ...envelope, error: { code: reply.error, message: reply.error } } : { ...envelope, result: structuredClone(reply.result) }) as BrowserExtensionResponse;
    },
    drop(profileId: string) { drops.push(profileId); if (!connected) return false; disconnect(); return true; },
  };
  // runtime.mjs connection(false) (:1265-1269): every binding fenced paused, generation+1, ready false (a waiting handoff is kept).
  const disconnect = () => { connected = false; for (const b of bindings.values()) fence(b, b.state === 'stopped' ? 'stopped' : 'paused'); };
  // runtime.mjs start (:1252): every non-stopped binding PAUSED, generation+1, ready false, no tabs; the handoff only if it was saved (:1214).
  const restart = (keepHandoff = false) => { connected = false; for (const b of bindings.values()) { if (b.state === 'stopped') continue; b.generation++; b.state = 'paused'; b.ready = false; b.tabs = []; if (!keepHandoff) { delete b.pausedReason; delete b.handoff; } } };
  const reconnect = () => { connected = true; service.onHello('profile'); };
  const on = (key: string, handler: Handler) => { const list = handlers.get(key) ?? []; list.push(handler); handlers.set(key, list); };
  /** The owner in the browser's side panel (runtime.mjs handlePanel :1084-1095). `emit` false holds the event back (a lost event). */
  const panel = (bindingId: string, action: 'pause' | 'resume' | 'continue', options: { emit?: boolean } = {}): Reply => {
    const b = bindings.get(bindingId)!;
    if (action === 'pause') { if (b.state !== 'active') return { error: 'binding_inactive' }; fence(b, 'paused'); if (options.emit !== false) emit(bindingId, b, 'paused'); return { result: summary(b) }; }
    if (b.state === 'stopped') return { error: 'binding_stopped' };
    const waiting = b.state === 'paused' && b.pausedReason === 'handoff';
    if (action === 'resume' && waiting) return { error: 'handoff_use_continue' };
    if (action === 'continue' && !waiting) return { error: 'not_handoff' };
    return ownerResume(bindingId, b, options.emit !== false);
  };
  const lostResumed = (bindingId: string) => { const b = bindings.get(bindingId)!; emit(bindingId, b, 'resumed'); };
  const settle = async () => { for (let i = 0; i < 5; i++) { await new Promise(resolve => setTimeout(resolve, 5)); await Promise.all(events.splice(0)); } };
  const options = {
    collectFacts: async (_io: unknown, _t: unknown, operation: string) => ({ operation, tag: 'textarea', role: 'textbox', name: 'Notes', visibility: { box: { x: 1, y: 1, width: 50, height: 20 }, inViewport: true, opacity: 1, visibility: 'visible', ariaHidden: false, coveredBy: null } }) as never,
    createEngine: (engine: import('./browser-extension-engine.ts').BrowserExtensionEngineOptions) => ({
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string, args: Record<string, unknown>) {
        const document = await engine.transport.selected();
        const method = name === 'agent_browser_fill' ? 'Input.insertText' : 'Accessibility.getFullAXTree'; const params = name === 'agent_browser_fill' ? { text: args.text } : {};
        await engine.beforeCommand(document, method, params); await engine.transport.send(method, params, document); return { content: [{ type: 'text', text: 'ok' }] };
      },
    }) as never,
    broker, workspaceId: 'workspace', stateFile: path.join(directory, 'state.json'),
    askSite: async () => 'allow' as const, askAction: async () => true,
    ownerInstruction: () => ({ id: 'm1', text: `please type hello into the notes box, open ${D}/ and open ${O}/` }),
    approvalMode: () => 'full' as const, checker: () => undefined, botName: () => 'Dax',
    onHandoff: (info: { category: unknown; text: string; site: string }) => { handoffs.push({ category: info.category, text: info.text, site: info.site }); },
    onContinue: (info: { text: string }) => { continues.push(info.text); },
    ...extra,
  };
  service = await createBrowserExtensionService(options as never);
  const binding = await service.ensureBinding({ botId: 'bot', threadId: 'thread', profileId: 'profile' });
  const id = binding.bindingId;
  const run = (name: string, args: Record<string, unknown> = {}) => service.dispatch(id, name, args, () => true);
  /** What the bot got: the result's text, or the refusal's message. */
  const outcome = async (call: Promise<unknown>) => { try { return JSON.stringify(await call); } catch (error) { return String((error as Error).message); } };
  const fill = () => run('agent_browser_fill', { selector: 'textarea', text: 'hello' });
  const openD = () => outcome(run('agent_browser_open', { url: D + '/' }));
  const fake = () => bindings.get(id)!;
  const ops = (from = 0) => log.slice(from).filter(entry => entry.bindingId === id).map(entry => entry.method ? `cdp:${entry.method}` : entry.op);
  const binds = (from = 0) => log.slice(from).filter(entry => entry.bindingId === id && entry.op === 'bind').map(entry => entry.params.approvedOrigins as string[]);
  /** The requests from the first bind on (each dispatch starts with its own status refresh, which is base). */
  const afterBind = (from = 0) => { const list = ops(from); const at = list.indexOf('bind'); return at < 0 ? list : list.slice(at); };
  const inputs = (from = 0) => ops(from).filter(op => op.startsWith('cdp:Input.')).length;
  const share = (origin: string) => service.handleMessage('profile', { version: 1, type: 'event', bindingId: id, generation: fake().generation, event: 'notice', data: { kind: 'share_requested', origin } } as never);
  /** The page A is granted by a first call that goes through (Full, the page the bot is on). */
  const start = async () => { await fill(); expect(fake().approved).toContain(A); };
  return { afterBind, snapshot: () => summary(bindings.get(id)!), service, id, log, drops, bindings, fake, run, fill, openD, outcome, ops, binds, inputs, share, start, on, panel, disconnect, restart, reconnect, lostResumed, settle, handoffs, continues, directory,
    setConnected: (value: boolean) => { connected = value; }, failNextResumeSave: () => { failResumeSave = true; } };
}
type F = Awaited<ReturnType<typeof fixture>>;
/** The next bind for D (or any bind) installs the set, then answers an error: the extension holds D, the server undoes it. */
const failBindAfterInstall = (f: F, error = 'storage_failed', before?: () => void | Promise<void>) => f.on('bind', async (_command, apply) => { apply(); await before?.(); return { error }; });
const stateFile = async (f: F) => JSON.parse(await fs.readFile(path.join(f.directory, 'state.json'), 'utf8'));
// Only the saved grants (site rules and task grants); the hand-off note names the site in its text and is not a grant.
const savedSites = async (f: F) => { const saved = await stateFile(f); return JSON.stringify((saved.bindings ?? []).map((b: Record<string, unknown>) => ({ sites: b.sites, taskL1: b.taskL1, taskL2: b.taskL2, autoL1: b.autoL1 }))); };

describe('SABLE-B test 25: a failed grant bind pauses the task for the owner (FAILS on base)', () => {
  it('server undone and paused for handoff, one handoff Pause and no other bind, GRANT_FAILED_TEXT, a siteNotSet card, the next call refused', async () => {
    expect(GRANT_FAILED_TEXT).toBe('YOUR TURN: Murage paused this task because the browser did not confirm a new site. Murage has asked the owner. End your turn now and wait. Do not try another way to do this step.');
    expect(GRANT_CONTINUE_TEXT).toBe('The owner pressed Continue. Take a new snapshot and continue the task.');
    const f = await fixture(); await f.start();
    const from = f.log.length;
    failBindAfterInstall(f);
    const said = await f.openD();
    expect(said).toMatch(FAILED);
    const status = f.service.status().bindings.find(item => item.bindingId === f.id)!;
    expect(status.state).toBe('paused');
    expect((status as { pausedReason?: string }).pausedReason).toBe('handoff');
    expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
    expect(f.service.taskInfo(f.id)?.sites.map(site => site.origin)).not.toContain(D);
    expect(await savedSites(f)).not.toContain(D);
    const pauses = f.log.slice(from).filter(entry => entry.op === 'pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0].params).toMatchObject({ reason: 'handoff', handoff: 'Dax paused before using d.example. Murage for Chrome did not confirm the new site, so the step did not run. Press Continue to try again, or Stop to end the task.' });
    expect(f.binds(from)).toHaveLength(1);
    expect(f.afterBind(from)).not.toContain('status');
    expect(f.drops).toEqual([]);
    expect(f.handoffs).toEqual([{ category: 'siteNotSet', site: 'd.example', text: expect.stringContaining('Dax paused before using d.example') }]);
    expect(f.fake()).toMatchObject({ state: 'paused', pausedReason: 'handoff', ready: false });
    const after = f.log.length;
    expect(await f.outcome(f.fill())).toMatch(FAILED);
    expect(f.log.length).toBe(after);
  });
});

describe('SABLE-B test 38 (r8 shape on base primitives): the bind fails after its call ended, while a later call runs', () => {
  it('the later call is fenced, its queued command is refused by the generation, one Pause, no status, no drop, setOwed stays set', async () => {
    const f = await fixture(); await f.start();
    // The owner's Share of O starts a grant whose bind the fixture holds (no call is running for it).
    const bindHeld = hold();
    f.on('bind', async (_command, apply) => { apply(); bindHeld.arrive(); await bindHeld.released; return { error: 'storage_failed' }; });
    await f.share(O);
    await bindHeld.arrived;
    // A second call starts and runs (nothing waits); its input command is queued at the fake when the Pause lands.
    const inputHeld = hold();
    f.on('cdp:Input.insertText', async (_command, apply) => { inputHeld.arrive(); await inputHeld.released; return apply(); });
    const inputsBefore = f.inputs();
    const second = f.outcome(f.fill());
    await inputHeld.arrived;
    const from = f.log.length;
    bindHeld.release(); await f.settle();
    const failClosedOps = f.ops(from);
    inputHeld.release();
    const said = await second;
    expect(said).not.toBe('{}');
    expect(f.inputs()).toBe(inputsBefore + 1); // the queued input reached the fake once, after the Pause, and was refused (stale generation)
    expect(f.fake()).toMatchObject({ state: 'paused', pausedReason: 'handoff', ready: false }); // it may still list O, but cannot act
    expect(failClosedOps).toEqual(['pause']);
    expect(f.drops).toEqual([]);
    expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
    expect(await f.outcome(f.fill())).toMatch(FAILED);
  });
  it('test 38 (FAILS, rows 8, 10b, design fixture): Full read of A, 302 to unnamed bare B, B\'s site card Allow, the consent bind held; the read times out; a second call runs; the held bind throws: B undone, paused, the second call fenced, one Pause, no status, no drop, setOwed set', async () => {
    const AX = 'https://a.example', B = 'https://b.example';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === `${AX}/doc` ? new Response(null, { status: 302, headers: { location: `${B}/`, 'content-type': 'text/html' } }) : url === `${B}/` ? new Response('# B', { status: 200, headers: { 'content-type': 'text/markdown' } }) : new Response('missing', { status: 404, headers: { 'content-type': 'text/plain' } })));
    try {
      const asked: string[] = [];
      const f = await fixture({ ownerInstruction: () => ({ id: 'm1', text: `please type hello into the notes box and read ${AX}/doc` }), askSite: async (_c: unknown, origin: string) => { asked.push(origin); return 'allow' as const; } });
      await f.start();
      // B's consent bind: the fixture installs the set, then holds the answer.
      const bindHeld = hold();
      const onBind = async (command: BrowserExtensionCommand, apply: () => { result: unknown } | { error: string }) => {
        // The read's own grant of A (owner-named) binds first and passes; B's bind is the one held.
        if (!((command.params as { approvedOrigins?: string[] }).approvedOrigins ?? []).includes(B)) { f.on('bind', onBind); return apply(); }
        apply(); bindHeld.arrive(); await bindHeld.released; return { error: 'storage_failed' };
      };
      f.on('bind', onBind);
      const read = f.outcome(f.run('agent_browser_read', { url: `${AX}/doc`, readTimeoutMs: 300 }));
      await bindHeld.arrived;
      expect(asked).toEqual([B]);                              // r8: B's site card, not an automatic grant
      expect(await read).toMatch(/timed out/i);                // the read times out; the call ends
      // A second dispatch starts and runs (no waiting of any kind); its input is queued at the fake when the Pause lands.
      const inputHeld = hold();
      f.on('cdp:Input.insertText', async (_command, apply) => { inputHeld.arrive(); await inputHeld.released; return apply(); });
      const inputsBefore = f.inputs();
      const second = f.outcome(f.fill());
      await inputHeld.arrived;
      const from = f.log.length;
      bindHeld.release(); await f.settle();
      const failClosedOps = f.ops(from);
      inputHeld.release();
      const said = await second;
      expect(said).not.toBe('{}');
      expect(f.inputs()).toBe(inputsBefore + 1);               // the queued input reached the fake once, after the Pause, refused by the generation
      expect(failClosedOps).toEqual(['pause']);                // exactly one Pause, no status, no bind
      expect(f.drops).toEqual([]);
      expect(f.fake()).toMatchObject({ state: 'paused', pausedReason: 'handoff', ready: false });
      expect(f.service.status().bindings.find(item => item.bindingId === f.id)).toMatchObject({ state: 'paused', pausedReason: 'handoff' });
      expect(f.service.taskInfo(f.id)?.sites.map(site => site.origin)).not.toContain(B);
      expect(await savedSites(f)).not.toContain('b.example');
      expect(f.service.siteOwed(f.id)).toBeTypeOf('number');   // the Pause answer is not a bind
      const after = f.log.length;
      expect(await f.outcome(f.fill())).toMatch(FAILED);
      expect(f.log.length).toBe(after);
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('SABLE-B test 47: the Pause outcomes (NEW)', () => {
  it('(a) the Pause times out: no status, the profile is dropped once, every binding on it fences', async () => {
    const f = await fixture(); await f.start();
    const other = await f.service.ensureBinding({ botId: 'bot2', threadId: 'thread2', profileId: 'profile' });
    failBindAfterInstall(f);
    f.on('pause', async () => { throw Error('deadline_exceeded_uncertain'); });
    const from = f.log.length;
    expect(await f.openD()).toMatch(FAILED);
    expect(f.afterBind(from)).not.toContain('status');
    expect(f.drops).toEqual(['profile']);
    expect(f.fake()).toMatchObject({ state: 'paused', ready: false });
    expect(f.bindings.get(other.bindingId)).toMatchObject({ state: 'paused', ready: false });
    expect(f.handoffs.map(item => item.category)).toEqual(['siteNotSet']);
  });
  it("(a') the Pause is rejected broker_busy: no status, drop at once", async () => {
    const f = await fixture(); await f.start(); failBindAfterInstall(f);
    f.on('pause', async () => { throw Error('broker_busy'); });
    const from = f.log.length;
    expect(await f.openD()).toMatch(FAILED);
    expect(f.afterBind(from)).not.toContain('status'); expect(f.drops).toEqual(['profile']);
  });
  it("(a'') the Pause is refused with another code: no status, drop at once", async () => {
    const f = await fixture(); await f.start(); failBindAfterInstall(f);
    f.on('pause', async () => ({ error: 'unknown_binding' }));
    const from = f.log.length;
    expect(await f.openD()).toMatch(FAILED);
    expect(f.afterBind(from)).not.toContain('status'); expect(f.drops).toEqual(['profile']);
  });
  it('(b) Pause then Resume in the panel before the Pause: stale, one status shows active above g0: ownerResumed; the resumed bind drops D', async () => {
    const f = await fixture(); await f.start();
    failBindAfterInstall(f, 'storage_failed', () => { f.panel(f.id, 'pause', { emit: false }); f.panel(f.id, 'resume', { emit: false }); });
    const from = f.log.length;
    expect(await f.openD()).toMatch(FAILED);
    expect(f.ops(from).filter(op => op === 'pause')).toHaveLength(1);
    expect(f.afterBind(from).filter(op => op === 'status')).toHaveLength(1);
    expect(f.drops).toEqual([]);
    expect(f.handoffs).toEqual([]);
    expect(f.fake()).toMatchObject({ state: 'active', ready: false });
    expect(f.fake().approved).toContain(D);
    const mark = f.log.length;
    f.lostResumed(f.id); await f.settle();
    expect(f.ops(mark).filter(op => op.startsWith('cdp:'))).toEqual([]);
    expect(f.binds(mark).at(-1)).not.toContain(D);
    expect(f.fake()).toMatchObject({ state: 'active', ready: true });
    expect(f.service.siteOwed(f.id)).toBeUndefined();
    expect(f.continues).toEqual([GRANT_CONTINUE_TEXT]);
    expect(f.ops(mark).filter(op => op === 'pause')).toEqual([]);
  });
  it("(b') stale, then the owner pressed only Pause: the status shows paused: no drop, the card is shown, the panel offers Resume not Continue", async () => {
    const f = await fixture(); await f.start();
    failBindAfterInstall(f, 'storage_failed', () => { f.panel(f.id, 'pause', { emit: false }); });
    expect(await f.openD()).toMatch(FAILED);
    expect(f.drops).toEqual([]);
    expect(f.handoffs.map(item => item.category)).toEqual(['siteNotSet']);
    expect(f.fake().pausedReason).toBeUndefined();
    expect(f.panel(f.id, 'continue')).toEqual({ error: 'not_handoff' });
  });
  it("(b'') stale, then the status times out, or shows active at g0: drop", async () => {
    for (const variant of ['timeout', 'liar'] as const) {
      const f = await fixture(); await f.start();
      failBindAfterInstall(f, 'storage_failed', () => {
        f.panel(f.id, 'pause', { emit: false });
        if (variant === 'timeout') f.on('status', async () => { throw Error('deadline_exceeded_uncertain'); });
        else f.on('status', async () => ({ result: { generation: f.fake().generation - 1, state: 'active', ready: true, tabs: f.fake().tabs } }));
      });
      expect(await f.openD()).toMatch(FAILED);
      expect(f.drops).toEqual(['profile']);
    }
  });
  it('(c) offline at the failure: no request, no drop; server paused; setOwed set; card shown', async () => {
    const f = await fixture(); await f.start();
    failBindAfterInstall(f, 'storage_failed', () => { f.disconnect(); });
    const from = f.log.length;
    expect(await f.openD()).toMatch(FAILED);
    expect(f.afterBind(from)).toEqual(['bind']);
    expect(f.drops).toEqual([]);
    expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
    expect(f.handoffs.map(item => item.category)).toEqual(['siteNotSet']);
  });
  it('(d) the owner presses Resume while the Pause is in flight: refused, status active above g0: ownerResumed, the resumed bind lands first', async () => {
    const f = await fixture(); await f.start();
    f.on('bind', async () => ({ error: 'storage_failed' })); // refused: the fake's set never had D
    f.on('pause', async (_command, apply) => { f.panel(f.id, 'resume', { emit: false }); return apply(); });
    const from = f.log.length;
    expect(await f.openD()).toMatch(FAILED);
    expect(f.ops(from).filter(op => op === 'pause')).toHaveLength(1);
    expect(f.handoffs).toEqual([]); expect(f.drops).toEqual([]);
    const mark = f.log.length;
    f.lostResumed(f.id); await f.settle();
    expect(f.ops(mark)[0]).toBe('status');
    expect(f.ops(mark)).toContain('bind');
    expect(f.ops(mark)).not.toContain('pause');
    expect(f.service.siteOwed(f.id)).toBeUndefined();
  });
  it('(e) stopped before the failure: no pause, no request, setOwed set, the binding stays stopped', async () => {
    const f = await fixture(); await f.start();
    f.on('bind', async (_command, apply) => { apply(); await f.service.stop(f.id); return { error: 'storage_failed' }; });
    const from = f.log.length;
    await f.openD();
    expect(f.afterBind(from)).toEqual(['bind', 'stop']);
    expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
    expect(f.fake().state).toBe('stopped');
    expect(f.handoffs).toEqual([]);
  });
  it('(f) the Pause is answered but the reconcile of its answer throws (the save fails): outcome paused, no drop', async () => {
    const f = await fixture(); await f.start(); failBindAfterInstall(f);
    const real = fs.writeFile.bind(fs);
    f.on('pause', async (_command, apply) => { vi.spyOn(fs, 'writeFile').mockImplementation(async (file: any, ...rest: any[]) => { if (String(file).includes('.tmp')) throw Object.assign(Error('ENOSPC'), { code: 'ENOSPC' }); return (real as any)(file, ...rest); }); return apply(); });
    expect(await f.openD()).toMatch(FAILED);
    vi.restoreAllMocks();
    expect(f.drops).toEqual([]);
    expect(f.handoffs.map(item => item.category)).toEqual(['siteNotSet']);
  });
});

describe('SABLE-B test 51: offline and reconnect (FAILS on base)', () => {
  const offlineFailure = async () => {
    const f = await fixture(); await f.start();
    failBindAfterInstall(f, 'host_lost_uncertain', () => { f.disconnect(); });
    expect(await f.openD()).toMatch(FAILED);
    return f;
  };
  it('offline: no Pause, no drop; on hello status, Pause, bind without D, in that order; Continue in the app is accepted', async () => {
    const f = await offlineFailure();
    expect(f.fake()).toMatchObject({ state: 'paused', ready: false }); expect(f.fake().pausedReason).toBeUndefined(); expect(f.fake().approved).toContain(D);
    expect(f.ops().filter(op => op === 'pause')).toEqual([]); expect(f.drops).toEqual([]);
    expect(await f.outcome(f.fill())).toMatch(FAILED);
    await f.service.ensureBinding({ botId: 'bot', threadId: 'thread', profileId: 'profile' }).catch(() => undefined);
    const from = f.log.length;
    f.reconnect(); await f.settle();
    expect(f.ops(from)).toEqual(['status', 'pause', 'bind']);
    expect(f.binds(from)[0]).not.toContain(D);
    expect(f.fake()).toMatchObject({ state: 'paused', pausedReason: 'handoff', ready: false });
    expect(f.service.siteOwed(f.id)).toBeUndefined();
    expect(f.service.status().bindings.find(item => item.bindingId === f.id)?.state).toBe('paused');
    await expect(f.service.continueHandoff(f.id)).resolves.toBeTruthy();
    await f.settle();
    expect(f.continues).toEqual([GRANT_CONTINUE_TEXT]);
  });
  it('(b) restart instead of a disconnect: no popup can land (not ready); on hello the same status, Pause, bind', async () => {
    const f = await fixture(); await f.start();
    failBindAfterInstall(f, 'host_lost_uncertain', () => { f.restart(); });
    expect(await f.openD()).toMatch(FAILED);
    expect(f.fake()).toMatchObject({ state: 'paused', ready: false, tabs: [] });
    const from = f.log.length;
    f.reconnect(); await f.settle();
    expect(f.ops(from)).toEqual(['status', 'pause', 'bind']);
    expect(f.service.siteOwed(f.id)).toBeUndefined();
  });
  it('(c) resend fails at the Pause or at the bind: setOwed stays set; the next hello repeats it', async () => {
    for (const at of ['pause', 'bind'] as const) {
      const f = await offlineFailure();
      f.on(at, async () => ({ error: 'storage_failed' }));
      f.reconnect(); await f.settle();
      expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
      f.disconnect(); const from = f.log.length; f.reconnect(); await f.settle();
      expect(f.ops(from)).toEqual(['status', 'pause', 'bind']);
      expect(f.service.siteOwed(f.id)).toBeUndefined();
    }
  });
  it('(d) the bind is answered plain-paused: setOwed stays set (settles false)', async () => {
    const f = await offlineFailure();
    f.on('bind', async (_command, apply) => { const reply = apply(); delete f.fake().pausedReason; return 'result' in reply ? { result: { ...(reply.result as object), pausedReason: undefined } } : reply; });
    f.reconnect(); await f.settle();
    expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
  });
  it("(e) the owner presses Resume between hello and resend's status: no Pause, no bind from resend; the resumed handler binds and clears", async () => {
    const f = await offlineFailure();
    f.on('status', async (_command, apply) => { f.panel(f.id, 'resume'); return apply(); });
    const from = f.log.length;
    f.reconnect(); await f.settle();
    expect(f.ops(from).filter(op => op === 'pause')).toEqual([]);
    expect(f.service.siteOwed(f.id)).toBeUndefined();
    expect(f.fake()).toMatchObject({ state: 'active', ready: true });
    expect(f.fake().approved).not.toContain(D);
  });
  it('(brief M2) the owner resumes DURING resend\'s reconcile: no Pause, no bind from resend', async () => {
    const f = await offlineFailure();
    const real = fs.rename.bind(fs); let once = true;
    // The reconcile's persist is held for one save; the owner presses Resume (event held back) while it waits.
    f.on('status', async (_command, apply) => {
      const reply = apply();
      vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => { if (once) { once = false; f.panel(f.id, 'resume', { emit: false }); f.lostResumed(f.id); await new Promise(resolve => setTimeout(resolve, 30)); } return (real as any)(...args); });
      return reply;
    });
    const from = f.log.length;
    f.reconnect(); await f.settle(); vi.restoreAllMocks();
    const resendOps = f.ops(from);
    expect(resendOps.filter(op => op === 'pause')).toEqual([]);
    expect(f.fake().state).toBe('active');
  });
});

describe('SABLE-B test 52: Continue (FAILS on base)', () => {
  const dropped = async () => {
    const f = await fixture(); await f.start(); failBindAfterInstall(f);
    f.on('pause', async () => { throw Error('deadline_exceeded_uncertain'); });
    expect(await f.openD()).toMatch(FAILED);
    f.setConnected(true); // the extension reconnected; its hello steps are exercised in test 51
    return f;
  };
  it('app Continue on a plain-paused extension: status, Pause, bind without D, resume, in that order; the bot hears GRANT_CONTINUE_TEXT once; the next call runs', async () => {
    const f = await dropped();
    expect(f.fake().pausedReason).toBeUndefined();
    const from = f.log.length;
    await f.service.continueHandoff(f.id); await f.settle();
    expect(f.ops(from).slice(0, 4)).toEqual(['status', 'pause', 'bind', 'resume']);
    expect(f.binds(from)[0]).not.toContain(D);
    expect(f.continues).toEqual([GRANT_CONTINUE_TEXT]);
    expect(f.service.siteOwed(f.id)).toBeUndefined();
    const before = f.inputs(); await f.fill(); expect(f.inputs()).toBe(before + 1);
  });
  it('a failure at the Pause returns its code; the server stays paused and setOwed stays set', async () => {
    const f = await dropped();
    f.on('pause', async () => ({ error: 'storage_failed' }));
    await expect(f.service.continueHandoff(f.id)).rejects.toMatchObject({ code: 'storage_failed' });
    expect(f.service.status().bindings.find(item => item.bindingId === f.id)?.state).toBe('paused');
    expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
  });
  it('app Continue when the extension is already active and not ready (its resume save failed, no resumed event): owner-resume steps, no Pause', async () => {
    const f = await dropped();
    f.panel(f.id, 'resume', { emit: false }); // the owner resumed in the panel; the event was lost
    const from = f.log.length;
    await f.service.continueHandoff(f.id); await f.settle();
    expect(f.ops(from)).not.toContain('pause');
    expect(f.ops(from)).toContain('bind');
    expect(f.service.siteOwed(f.id)).toBeUndefined();
    expect(f.continues).toEqual([GRANT_CONTINUE_TEXT]);
    const before = f.inputs(); await f.fill(); expect(f.inputs()).toBe(before + 1);
  });
  it('(brief M3) recovery after its own failed resume: setOwed already clear, the extension active-not-ready, Continue finishes it', async () => {
    const f = await dropped();
    f.failNextResumeSave();
    await expect(f.service.continueHandoff(f.id)).rejects.toMatchObject({ code: 'persistence_failed' });
    expect(f.service.siteOwed(f.id)).toBeUndefined();
    expect(f.fake()).toMatchObject({ state: 'active', ready: false });
    const from = f.log.length;
    await f.service.continueHandoff(f.id); await f.settle();
    expect(f.ops(from)).not.toContain('pause');
    expect(f.fake()).toMatchObject({ state: 'active', ready: true });
    expect(f.service.status().bindings.find(item => item.bindingId === f.id)?.state).toBe('active');
    const before = f.inputs(); await f.fill(); expect(f.inputs()).toBe(before + 1);
  });
  it('panel (i): handoff-paused lists Continue, Resume is refused, Continue resumes and the bind without D lands before any command', async () => {
    const f = await fixture(); await f.start(); failBindAfterInstall(f);
    expect(await f.openD()).toMatch(FAILED);
    expect(f.panel(f.id, 'resume')).toEqual({ error: 'handoff_use_continue' });
    const from = f.log.length;
    expect('result' in f.panel(f.id, 'continue')).toBe(true);
    await f.settle();
    const after = f.ops(from); expect(after).toContain('bind'); expect(after.findIndex(op => op.startsWith('cdp:'))).toBe(-1);
    expect(f.binds(from)[0]).not.toContain(D);
    expect(f.service.siteOwed(f.id)).toBeUndefined();
    expect(f.continues).toEqual([GRANT_CONTINUE_TEXT]);
  });
  it('panel (ii): plain-paused refuses Continue (not_handoff); Resume resumes and the same bind follows', async () => {
    const f = await dropped();
    expect(f.panel(f.id, 'continue')).toEqual({ error: 'not_handoff' });
    expect('result' in f.panel(f.id, 'resume')).toBe(true);
    await f.settle();
    expect(f.service.siteOwed(f.id)).toBeUndefined();
    expect(f.fake().approved).not.toContain(D);
  });
  it('if the resumed bind fails, failClosed runs again: paused, siteNotSet card', async () => {
    const f = await dropped();
    f.on('bind', async () => ({ error: 'storage_failed' }));
    f.panel(f.id, 'resume'); await f.settle();
    expect(f.service.status().bindings.find(item => item.bindingId === f.id)?.state).toBe('paused');
    expect(f.handoffs.map(item => item.category)).toEqual(['siteNotSet', 'siteNotSet']);
    expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
  });
  it('fixer r1 #3 (FAILS on base): the owner resumes in the panel DURING app Continue\'s reconcile: Continue sends no Pause after it', async () => {
    const f = await dropped();
    const real = fs.rename.bind(fs); let once = true;
    // Continue's status shows paused at G; its reconcile's persist is held for one save while the panel Resume lands (G+1) and is adopted.
    f.on('status', async (_command, apply) => {
      const reply = apply();
      vi.spyOn(fs, 'rename').mockImplementation(async (...args: any[]) => { if (once) { once = false; f.panel(f.id, 'resume', { emit: false }); f.lostResumed(f.id); await new Promise(resolve => setTimeout(resolve, 30)); } return (real as any)(...args); });
      return reply;
    });
    const from = f.log.length;
    await f.service.continueHandoff(f.id).catch(() => undefined); await f.settle(); vi.restoreAllMocks();
    expect(f.ops(from).filter(op => op === 'pause')).toEqual([]);
    expect(f.fake().state).toBe('active');
  });
  it('fixer r1 #5 (FAILS on base, tsc): the service broker must have drop (5.7); a broker without it does not type-check', () => {
    type ServiceBroker = Parameters<typeof createBrowserExtensionService>[0]['broker'];
    // @ts-expect-error SABLE-B 5.7: drop is required, so fail-closed can always cut the connection.
    const missing: ServiceBroker = { profiles: () => [], request: async () => ({}) as never };
    expect('drop' in missing).toBe(false);
  });
});

describe('SABLE-B test 53: setOwed compare-and-clear (NEW)', () => {
  it('a bind sent before the failure does not clear it; one sent after does; two failures keep the later number', async () => {
    const f = await fixture(); await f.start();
    // Bind X (the owner raising a saved site) is applied by the fake and its answer held across the failure.
    const xHeld = hold();
    f.on('bind', async (_command, apply) => { apply(); xHeld.arrive(); await xHeld.released; return { result: f.snapshot() }; });
    const x = f.service.setSiteAccess(f.id, 'https://saved.example', 'allow').catch(() => undefined);
    await xHeld.arrived;
    f.on('bind', async () => ({ error: 'storage_failed' }));
    expect(await f.openD()).toMatch(FAILED);
    const n = f.service.siteOwed(f.id); expect(n).toBeTypeOf('number');
    xHeld.release(); await x;
    expect(f.service.siteOwed(f.id)).toBe(n);
    expect(await f.outcome(f.fill())).toMatch(FAILED);
    // A bind sent after the failure (the app's Continue) clears it.
    await f.service.continueHandoff(f.id); await f.settle();
    expect(f.service.siteOwed(f.id)).toBeUndefined();
  });
  it('two failures: the later number stands; a bind sent between them does not clear it', async () => {
    const f = await fixture(); await f.start();
    const dHeld = hold();
    f.on('bind', async () => { dHeld.arrive(); await dHeld.released; return { error: 'storage_failed' }; });
    const d = f.openD();
    await dHeld.arrived;
    f.on('bind', async () => ({ error: 'storage_failed' }));
    await f.share(O); await f.settle();
    const first = f.service.siteOwed(f.id); expect(first).toBeTypeOf('number');
    // A bind sent between the two failures, answered after the second.
    const yHeld = hold();
    f.on('bind', async (_command, apply) => { const reply = apply(); yHeld.arrive(); await yHeld.released; return 'result' in reply ? { result: f.snapshot() } : reply; });
    const y = f.service.setSiteAccess(f.id, 'https://saved.example', 'allow').catch(() => undefined);
    await yHeld.arrived;
    dHeld.release(); expect(await d).toMatch(FAILED);
    const second = f.service.siteOwed(f.id); expect(second).toBeGreaterThan(first!);
    yHeld.release(); await y;
    expect(f.service.siteOwed(f.id)).toBe(second);
  });
  it('beginStep does not wait on it: a step that begins inside a running call after the failure is refused at once, with no request', async () => {
    type Hooks = import('./browser-extension-engine.ts').BrowserExtensionEngineOptions;
    const box: { engine?: Hooks; gate?: Promise<void>; arrive?: () => void; step?: Promise<string>; settled?: boolean } = {};
    const gate = hold(); box.gate = gate.released; box.arrive = gate.arrive;
    const f = await fixture({ createEngine: (engine: Hooks) => { box.engine = engine; return {
      resolveTarget: async () => ({ backendNodeId: 12, document: await engine.transport.selected() }), resolveTab: async () => engine.transport.selected(), event() {}, async close() {},
      async call(name: string, args: Record<string, unknown>) {
        const document = await engine.transport.selected();
        if (name === 'agent_browser_snapshot' && box.gate) { const wait = box.gate; box.gate = undefined; box.arrive!(); await wait; box.step = engine.beforeDestination(`${D}/`, document).then(() => "admitted", (error: Error) => error.message).finally(() => { box.settled = true; }); await box.step; }
        const method = name === 'agent_browser_fill' ? 'Input.insertText' : 'Accessibility.getFullAXTree'; const params = name === 'agent_browser_fill' ? { text: args.text } : {};
        await engine.beforeCommand(document, method, params); await engine.transport.send(method, params, document); return { content: [{ type: 'text', text: 'ok' }] };
      },
    }; } });
    await f.start();
    const running = f.outcome(f.run('agent_browser_snapshot'));
    await gate.arrived;
    // The owner's Share of O fails closed while the call is held: setOwed set, the task paused.
    f.on('bind', async () => ({ error: 'storage_failed' }));
    await f.share(O); await f.settle();
    expect(f.service.siteOwed(f.id)).toBeTypeOf('number');
    const from = f.log.length;
    gate.release();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(box.settled).toBe(true);                            // settled with setOwed still set: nothing waits on it (only a later bind clears it)
    expect(f.service.siteOwed(f.id)).toBeTypeOf("number");
    expect(await box.step).toMatch(/binding_inactive|stale_binding|YOUR TURN/);
    expect(f.log.slice(from).filter(entry => entry.op === 'bind')).toEqual([]);
    await running;
  });
  it('nothing waits on it: dispatch refuses at once', async () => {
    const f = await fixture(); await f.start(); failBindAfterInstall(f, 'storage_failed', () => { f.disconnect(); });
    await f.openD();
    let settled = false; const call = f.fill().catch(() => undefined).finally(() => { settled = true; });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await call; expect(settled).toBe(true);
  });
});

describe('SABLE-B test 54: the siteNotSet string in all 8 locales (FAILS on base)', () => {
  const locales = ['en', 'de', 'es', 'fr', 'hi', 'ja', 'pt-br', 'zh'];
  it('exists with {bot} and {site}, no em dash, no "safe", "free" or "Forge", and its source hash is recorded', () => {
    const hashes = JSON.parse(readFileSync(path.resolve('src/locales/source-hashes.json'), 'utf8')) as { locales: Record<string, Record<string, string>> };
    for (const locale of locales) {
      const text = (JSON.parse(readFileSync(path.resolve(`src/locales/${locale}.json`), 'utf8')) as Record<string, string>)['browserExt.yourTurn.siteNotSet'];
      expect(text, locale).toBeTruthy();
      expect(text).toContain('{bot}'); expect(text).toContain('{site}');
      expect(text).not.toMatch(/—/); expect(text).not.toMatch(/\b(safe|free|forge)\b/i);
      if (locale !== 'en') expect(hashes.locales[locale]?.['browserExt.yourTurn.siteNotSet'], locale).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('SABLE-B test 55: bounds (NEW)', () => {
  it('the fake never answers the Pause: the failing call makes two requests (bind, Pause) then drops; a second call meanwhile gets binding_busy at once', async () => {
    const f = await fixture(); await f.start();
    const bindHeld = hold(), pauseHeld = hold();
    f.on('bind', async (_command, apply) => { apply(); bindHeld.arrive(); await bindHeld.released; return { error: 'storage_failed' }; });
    f.on('pause', async () => { pauseHeld.arrive(); await pauseHeld.released; throw Error('deadline_exceeded_uncertain'); });
    const from = f.log.length;
    const first = f.openD();
    await bindHeld.arrived;
    // While the failing call runs (its bind pending), another call is refused at once (service:906).
    await expect(f.fill()).rejects.toMatchObject({ code: 'binding_busy' });
    bindHeld.release(); await pauseHeld.arrived;
    // After the pause (made in the failure's tick), the Your-turn text at once (:905); neither waits on the Pause.
    expect(await f.outcome(f.fill())).toMatch(FAILED);
    pauseHeld.release(); expect(await first).toMatch(FAILED);
    expect(f.afterBind(from)).toEqual(['bind', 'pause']);
    expect(f.drops).toEqual(['profile']);
    f.setConnected(true);
    expect(await f.outcome(f.fill())).toMatch(FAILED);
  });
  it('Pause refused stale_generation and the status never answered: three requests (bind, Pause, status), then drop', async () => {
    const f = await fixture(); await f.start();
    failBindAfterInstall(f, 'storage_failed', () => { f.panel(f.id, 'pause', { emit: false }); f.on('status', async () => { throw Error('deadline_exceeded_uncertain'); }); });
    const from = f.log.length;
    expect(await f.openD()).toMatch(FAILED);
    expect(f.afterBind(from)).toEqual(['bind', 'pause', 'status']);
    expect(f.drops).toEqual(['profile']);
  });
});
