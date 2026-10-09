// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createPresenceCore, moveDuration, curvePoints, pillPlacement, presenceSource, PRESENCE_LEASE_MS, PRESENCE_REMOVE_EXPRESSION, PRESENCE_WORLD, PRESENCE_THEME } from '../extensions/murage-browser/presence.mjs';
import { createBrowserExtensionRuntime } from '../extensions/murage-browser/runtime.mjs';

function clock(start = 1000) { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; }

describe('presence core: lease', () => {
  it('starts off with nothing drawn', () => {
    const c = createPresenceCore(clock().now, 3000);
    expect(c.snapshot().state).toBe('off');
    expect(Object.values(c.layers()).some(Boolean)).toBe(false);
    expect(c.tick()).toBe('ok');
  });
  it('expires exactly once when the lease is not renewed for 3 s', () => {
    const k = clock(); const c = createPresenceCore(k.now, PRESENCE_LEASE_MS);
    c.setState('driving');
    k.advance(2999); expect(c.tick()).toBe('ok');
    k.advance(1); expect(c.tick()).toBe('expired');
    expect(c.snapshot().state).toBe('off');
    expect(c.tick()).toBe('ok');
  });
  it('renewing keeps it alive, and every touch renews', () => {
    const k = clock(); const c = createPresenceCore(k.now, 3000);
    c.setState('driving');
    for (let i = 0; i < 10; i += 1) { k.advance(2000); expect(c.renew()).toBe(true); expect(c.tick()).toBe('ok'); }
    k.advance(2000); c.setCapture(true); k.advance(2000); expect(c.tick()).toBe('ok');
    k.advance(1000); expect(c.tick()).toBe('expired');
  });
  it('renew is a no-op while off, and an unknown state is refused', () => {
    const c = createPresenceCore(clock().now, 3000);
    expect(c.renew()).toBe(false);
    expect(c.setState('paused')).toBe(false);
    expect(c.snapshot().state).toBe('off');
  });
  it('expiry clears capture mode and masks', () => {
    const k = clock(); const c = createPresenceCore(k.now, 3000);
    c.setState('driving'); c.setCapture(true, 2); k.advance(3000);
    expect(c.tick()).toBe('expired');
    expect(c.snapshot().capture).toBe(false);
    expect(c.layers().masks).toBe(false);
  });
  it('reinserts up to three times, then falls back and stops', () => {
    const c = createPresenceCore(clock().now, 3000);
    expect(c.noteRemoved()).toBe('ignore');
    c.setState('driving');
    expect([c.noteRemoved(), c.noteRemoved(), c.noteRemoved(), c.noteRemoved(), c.noteRemoved()]).toEqual(['reinsert', 'reinsert', 'reinsert', 'fallback', 'ignore']);
  });
});

describe('presence core: capture mode and layers', () => {
  it('driving shows outline, glow, pill, and the pointer once placed', () => {
    const c = createPresenceCore(clock().now, 3000);
    c.setState('driving');
    expect(c.layers()).toEqual({ outline: true, glow: true, pointer: false, pill: true, masks: false });
    c.markPointerPlaced();
    expect(c.layers().pointer).toBe(true);
  });
  it('waiting keeps the Frame corners, the pill and the placed pointer, no glow', () => {
    const c = createPresenceCore(clock().now, 3000);
    c.setState('driving'); c.markPointerPlaced(); c.setState('waiting');
    expect(c.layers()).toEqual({ outline: true, glow: false, pointer: true, pill: true, masks: false });
  });
  it('capture mode hides every element and shows only masks', () => {
    const c = createPresenceCore(clock().now, 3000);
    c.setState('driving'); c.markPointerPlaced();
    c.setCapture(true, 0);
    expect(c.layers()).toEqual({ outline: false, glow: false, pointer: false, pill: false, masks: false });
    c.setCapture(true, 3);
    expect(c.layers()).toEqual({ outline: false, glow: false, pointer: false, pill: false, masks: true });
    c.setCapture(false);
    expect(c.layers()).toMatchObject({ outline: true, glow: true, pointer: true, pill: true, masks: false });
  });
  it('turning off clears capture mode', () => {
    const c = createPresenceCore(clock().now, 3000);
    c.setState('driving'); c.setCapture(true, 1); c.setState('off');
    expect(c.snapshot().capture).toBe(false);
    expect(Object.values(c.layers()).some(Boolean)).toBe(false);
  });
});

describe('presence helpers', () => {
  it('pointer duration runs 180 to 350 ms by distance, halved in Full permissive', () => {
    expect(moveDuration(0, false)).toBe(180);
    expect(moveDuration(5000, false)).toBe(350);
    expect(moveDuration(600, false)).toBeGreaterThan(180);
    expect(moveDuration(5000, true)).toBe(175);
  });
  it('curve starts and ends on the endpoints and eases', () => {
    const pts = curvePoints({ x: 0, y: 0 }, { x: 400, y: 200 }, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual({ x: 0, y: 0 });
    expect(pts[10].x).toBeCloseTo(400); expect(pts[10].y).toBeCloseTo(200);
    expect(pts[1].x - pts[0].x).toBeLessThan(pts[5].x - pts[4].x);
  });
  it('the pill moves to the top only when a target meets it', () => {
    const pill = { x: 500, y: 750, width: 280, height: 32 };
    expect(pillPlacement(pill, undefined)).toBe('bottom');
    expect(pillPlacement(pill, { x: 0, y: 0, width: 100, height: 100 })).toBe('bottom');
    expect(pillPlacement(pill, { x: 600, y: 740, width: 50, height: 20 })).toBe('top');
  });
});

describe('presence source in a bare isolated context', () => {
  afterEach(() => vi.useRealTimers());
  function sandbox() {
    const timers = []; let now = 0;
    const g = { performance: { now: () => now }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: () => {}, setTimeout: () => 0, document: { documentElement: null }, MutationObserver: class { observe() {} disconnect() {} } };
    g.globalThis = g;
    return { g, step: (ms) => { now += ms; for (const t of timers) t.fn(); } };
  }
  it('is self-contained, idempotent, and has the control surface', () => {
    const { g } = sandbox();
    const src = presenceSource({ botName: 'Dax', bindingName: 'sig' });
    runInNewContext(src, g); runInNewContext(src, g);
    const p = g.__muragePresence;
    expect(typeof p.state).toBe('function');
    expect(p.status().state).toBe('off');
    expect(PRESENCE_REMOVE_EXPRESSION).toBe('globalThis.__muragePresence?.remove()');
  });
  it('removes itself when the lease lapses with no runtime renewal', () => {
    const { g, step } = sandbox();
    runInNewContext(presenceSource({ leaseMs: 3000, tickMs: 250 }), g);
    g.__muragePresence.state('driving');
    step(2750); expect(g.__muragePresence).toBeDefined();
    g.__muragePresence.renew(); step(2750); expect(g.__muragePresence).toBeDefined();
    step(500); expect(g.__muragePresence).toBeUndefined();
  });
  it('state off removes it at once', () => {
    const { g } = sandbox();
    runInNewContext(presenceSource(), g);
    g.__muragePresence.state('driving');
    g.__muragePresence.state('off');
    expect(g.__muragePresence).toBeUndefined();
  });
  it('contains no em dashes or banned words in its copy', () => {
    const src = presenceSource({ botName: 'Dax' });
    expect(src).not.toMatch(/—/);
    expect(src).not.toMatch(/\b(safe|safely|safety|unsafe|Composio)\b/i);
  });
});

describe('Murage styling (Frame, avatar pointer, hazard stripe)', () => {
  it('done shows the corners only', () => {
    const c = createPresenceCore(clock().now, 3000);
    expect(c.setState('done')).toBe(true);
    expect(c.layers()).toEqual({ outline: true, glow: false, pointer: false, pill: false, masks: false });
  });
  it('carries the Frame, brackets, avatar chip, hazard stripe and Murage palette', () => {
    const src = presenceSource({ botName: 'Ember' });
    for (const needle of ['.frame', '.br', '.haz', 'repeating-linear-gradient(135deg', '.main', PRESENCE_THEME.bot, PRESENCE_THEME.warning, PRESENCE_THEME.success, 'Your turn: Ember is waiting for you', 'Stop task', 'Continue', 'Full permissive']) expect(src).toContain(needle);
    expect(src).not.toContain('rgba(255,107,53,.55)');
    expect(src).not.toMatch(/blur\(/);
  });
  it('the pointer label initial comes from the bot name', () => {
    expect(presenceSource({ botName: 'Ember' })).toContain('"initial":"E"');
  });
});

const ORIGIN = 'https://allowed.test';
function rig(stored = {}, runtimeOptions = {}) {
  const tabs = new Map([[1, { id: 1, url: 'about:blank', windowId: 1 }]]);
  const store = { ...stored }; const calls = []; const log = [];
  const state = { presenceControl: true, observerPaused: false, shotFails: false, maskFails: false, guardPrivate: false, createdTab: 0 };
  const sendCommand = vi.fn(async (_s, method, params = {}) => {
    const captureScan = params.expression?.includes('return await c.capture(true,r,true)');
    calls.push([method, params]); log.push(method + (captureScan ? ':c.capture(true)' : params.expression ? ':' + params.expression.slice(0, 400) : ''));
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.worldName === PRESENCE_WORLD ? 8 : 7 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-' + params.worldName };
    if (method === 'Page.captureScreenshot') { if (state.shotFails) throw Object.assign(new Error('shot'), { code: 'x' }); return { data: 'x' }; }
    if (method === 'Page.getLayoutMetrics') return { cssVisualViewport: { clientWidth: 1280, clientHeight: 800 } };
    if (method === 'Runtime.evaluate' && params.contextId === 8) {
      const e = params.expression;
      if (e === PRESENCE_REMOVE_EXPRESSION) return { result: { type: 'undefined' } };
      if (e.startsWith('(') && e.includes('__muragePresence') && e.length > 5000 && !captureScan) { state.presenceControl = true; return { result: { type: 'undefined' } }; }
      if (state.maskFails && captureScan) return { result: { type: 'boolean', value: false } };
      return { result: { type: 'boolean', value: state.presenceControl } };
    }
    if (method === 'Runtime.evaluate' && params.expression === 'globalThis.__murageGuard?.() ?? false') return { result: { value: state.guardPrivate } };
    if (method === 'Runtime.evaluate' && params.expression?.startsWith('globalThis.__murageTakeover?.')) return { result: { type: 'boolean', value: params.expression.includes('.arm(') ? !state.observerPaused : state.observerPaused } };
    return { value: 'owned' };
  });
  const completion = new Set();
  const api = {
    webNavigation: { onCompleted: { addListener: l => completion.add(l), removeListener: l => completion.delete(l) } },
    storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => Object.assign(store, structuredClone(v)) } },
    runtime: { getManifest: () => ({ version: '0.1.63' }) },
    tabs: { create: async ({ url }) => { for (const l of completion) l({ tabId: 1, frameId: 0, url }); return tabs.get(1); }, get: async id => { if (!tabs.has(id)) throw Error('missing'); return tabs.get(id); }, group: async () => 42, remove: async id => tabs.delete(id) },
    tabGroups: { update: async () => {} }, action: { setBadgeText: vi.fn(async () => {}) },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand },
  };
  const events = [];
  const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: e => events.push(e), commandTimeoutMs: 500, presenceRenewMs: 20, idleDetachMs: 150, ...runtimeOptions });
  let seq = 0, nonce = '';
  const command = (operation, params = {}, generation = 1) => runtime.handleRequest({ version: 1, type: 'command', id: `${nonce}_${++seq}`, bindingId: 'bot_a', generation, operation, params });
  const start = async () => {
    await runtime.initialize(); await runtime.connection(true); nonce = '1'.padStart(32, '0'); seq = 0;
    const r = await command('bind', { profileId: 'profile_1', botName: 'Ember', approvedOrigins: [ORIGIN] });
    tabs.get(1).url = ORIGIN + '/p'; await runtime.navigation({ tabId: 1, frameId: 0, url: ORIGIN + '/p' });
    return r;
  };
  const cdp = (method, params = {}, epoch = 2, generation = 1) => command('cdp', { method, params, tabId: 1, navigationEpoch: epoch }, generation);
  const evals = (ctx = 8) => calls.filter(([m, p]) => m === 'Runtime.evaluate' && p.contextId === ctx).map(([, p]) => p.expression);
  return { api, runtime, command, cdp, start, calls, log, evals, events, state, store, tabs };
}
const removes = f => f.evals().filter(e => e === PRESENCE_REMOVE_EXPRESSION).length;

describe('presence wiring in the runtime', () => {
  afterEach(() => vi.useRealTimers());
  it('round 9 (R8-10): a bind that removes the site while an input waits stops the input', async () => {
    const f = rig(); await f.start();
    let release; const gate = new Promise(r => { release = r; });
    const original = f.api.debugger.sendCommand.getMockImplementation();
    f.api.debugger.sendCommand.mockImplementation(async (s, method, params = {}) => {
      if (method === 'Runtime.evaluate' && params.contextId === 8 && String(params.expression).includes('.move(')) await gate;
      return original(s, method, params);
    });
    const input = f.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left' });
    await new Promise(r => setTimeout(r, 30));
    await f.command('bind', { profileId: 'profile_1', botName: 'Ember', approvedOrigins: [] });
    release();
    expect((await input).error).toBeTruthy();
    expect(f.calls.some(([m]) => m === 'Input.dispatchMouseEvent')).toBe(false);
  });
  it('round 9 (R8-07): a screenshot whose mask could not be drawn is refused, nothing is captured', async () => {
    const f = rig(); await f.start();
    f.state.maskFails = true;
    const r = await f.cdp('Page.captureScreenshot', {});
    expect(r.error).toBeTruthy();
    expect(f.calls.some(([m]) => m === 'Page.captureScreenshot')).toBe(false);
  });
  it('installs the overlay in its own world on the first dispatch, with a binding scoped to that world', async () => {
    const f = rig(); await f.start();
    expect((await f.cdp('Runtime.evaluate', { expression: '1+1' })).error).toBeUndefined();
    const binding = f.calls.find(([m, p]) => m === 'Runtime.addBinding' && p.executionContextName === PRESENCE_WORLD);
    expect(binding).toBeTruthy();
    expect(f.calls.some(([m, p]) => m === 'Page.addScriptToEvaluateOnNewDocument' && p.worldName === PRESENCE_WORLD)).toBe(true);
    expect(f.evals().some(e => e.includes('__muragePresence') && e.length > 5000)).toBe(true);
    expect(f.evals().some(e => e.includes('state("driving"'))).toBe(true);
    await f.command('pause');
  });
  it('the engine cannot reach the presence world or the Overlay domain', async () => {
    const f = rig(); await f.start();
    await f.cdp('Runtime.evaluate', { expression: '1' });
    expect((await f.cdp('Runtime.evaluate', { expression: 'x', contextId: 8 })).error.code).toBe('context_denied');
    expect((await f.cdp('Overlay.highlightRect', {})).error.code).toBe('method_denied');
    await f.command('pause');
  });
  for (const [name, act] of [
    ['Pause (fence)', f => f.command('pause')],
    ['Stop (fence)', f => f.command('stop')],
    ['disconnect (detach)', f => f.runtime.connection(false)],
    ['unshare', f => f.command('unshare', { tabId: 1 })],
    ['tab_close', f => f.command('tab_close', { tabId: 1 })],
  ]) {
    it(`${name} removes the overlay and its binding and script`, async () => {
      const f = rig(); await f.start(); await f.cdp('Runtime.evaluate', { expression: '1' });
      expect(removes(f)).toBe(0);
      await act(f);
      expect(removes(f)).toBeGreaterThan(0);
      expect(f.calls.some(([m, p]) => m === 'Runtime.removeBinding' && /^murage_presence_/.test(p.name))).toBe(true);
      expect(f.calls.some(([m, p]) => m === 'Page.removeScriptToEvaluateOnNewDocument' && p.identifier === 'script-' + PRESENCE_WORLD)).toBe(true);
    });
  }
  it('startup cleanup of an abandoned tab also removes a leftover overlay', async () => {
    const stored = { murageBrowserState: { profileId: 'profile_1', retired: [], bindings: [{ id: 'bot_a', generation: 1, state: 'active', botName: 'Ember', approvedOrigins: [ORIGIN], tabs: [{ tabId: 1, navigationEpoch: 2, origin: ORIGIN, url: ORIGIN + '/p' }] }] } };
    const f = rig(stored); f.tabs.get(1).url = ORIGIN + '/p';
    await f.runtime.initialize();
    expect(f.calls.some(([m, p]) => m === 'Page.createIsolatedWorld' && p.worldName === PRESENCE_WORLD)).toBe(true);
    expect(removes(f)).toBeGreaterThan(0);
  });
  it('renews the lease on a timer while driving, and reinstalls when the control object is gone', async () => {
    const f = rig(); await f.start(); await f.cdp('Runtime.evaluate', { expression: '1' });
    const installs = () => f.evals().filter(e => e.length > 5000).length;
    const before = f.evals().filter(e => e.includes('.renew()')).length;
    await vi.waitFor(() => expect(f.evals().filter(e => e.includes('.renew()')).length).toBeGreaterThan(before + 1));
    expect(installs()).toBe(1);
    f.state.presenceControl = undefined;
    await vi.waitFor(() => expect(installs()).toBe(2));
    await f.command('pause');
  });
  it('ignores a pill payload from any context but the presence world, and pauses or stops from it', async () => {
    const f = rig(); await f.start(); await f.cdp('Runtime.evaluate', { expression: '1' });
    const name = f.calls.find(([m, p]) => m === 'Runtime.addBinding' && p.executionContextName === PRESENCE_WORLD)[1].name;
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Runtime.bindingCalled', { name, executionContextId: 99, payload: 'stop' });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Runtime.bindingCalled', { name: 'other', executionContextId: 8, payload: 'stop' });
    expect((await f.command('status')).result.state).toBe('active');
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Runtime.bindingCalled', { name, executionContextId: 8, payload: 'pause' });
    expect((await f.command('status', {}, 2)).result.state).toBe('paused');
  });
  it('a stop payload from the presence world stops the task', async () => {
    const f = rig(); await f.start(); await f.cdp('Runtime.evaluate', { expression: '1' });
    const name = f.calls.find(([m, p]) => m === 'Runtime.addBinding' && p.executionContextName === PRESENCE_WORLD)[1].name;
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Runtime.bindingCalled', { name, executionContextId: 8, payload: 'stop' });
    expect((await f.command('status', {}, 2)).result.state).toBe('stopped');
  });
  it('moves the pointer before a click and dispatches after it', async () => {
    const f = rig(); await f.start();
    await f.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 80, button: 'left', clickCount: 1 });
    const move = f.log.findIndex(l => l.includes('.move(120,80'));
    const press = f.log.indexOf('Input.dispatchMouseEvent');
    expect(move).toBeGreaterThan(-1); expect(press).toBeGreaterThan(move);
    await f.command('pause');
  });
  it('shows the typing marker before text goes in', async () => {
    const f = rig(); await f.start();
    await f.cdp('Input.insertText', { text: 'hello' });
    const mark = f.log.findIndex(l => l.includes('.type('));
    expect(mark).toBeGreaterThan(-1); expect(f.log.indexOf('Input.insertText')).toBeGreaterThan(mark);
    await f.command('pause');
  });
  it('Pause during the pointer animation sends zero input', async () => {
    const f = rig(); await f.start();
    const base = f.sendCommand ?? f.api.debugger.sendCommand;
    const impl = base.getMockImplementation();
    base.mockImplementation(async (s, m, p) => {
      if (m === 'Runtime.evaluate' && p.contextId === 8 && p.expression.includes('.move(')) { await f.command('pause'); }
      return impl(s, m, p);
    });
    const r = await f.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
    expect(r.error).toBeTruthy();
    expect(f.calls.some(([m]) => m === 'Input.dispatchMouseEvent')).toBe(false);
  });
  it('caps the pointer wait: a hung overlay never holds an action beyond the cap', async () => {
    const f = rig({}, { presenceMoveCapMs: 60 }); await f.start();
    const base = f.api.debugger.sendCommand, impl = base.getMockImplementation();
    base.mockImplementation((s, m, p) => (m === 'Runtime.evaluate' && p.contextId === 8 && p.expression.includes('.move(')) ? new Promise(() => {}) : impl(s, m, p));
    const t0 = Date.now();
    const r = await f.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 5, button: 'left', clickCount: 1 });
    expect(r.error).toBeUndefined(); expect(Date.now() - t0).toBeLessThan(400);
    await f.command('pause');
  });
  it('hides the overlay around every screenshot and always shows it again, even when the capture throws', async () => {
    const f = rig(); await f.start();
    await f.cdp('Page.captureScreenshot', {});
    let on = f.log.findIndex(l => l.includes('.capture(true')), shot = f.log.indexOf('Page.captureScreenshot'), off = f.log.findIndex(l => l.includes('.capture(false'));
    expect(on).toBeGreaterThan(-1); expect(shot).toBeGreaterThan(on); expect(off).toBeGreaterThan(shot);
    f.log.length = 0; f.state.shotFails = true;
    expect((await f.cdp('Page.captureScreenshot', {})).error).toBeTruthy();
    expect(f.log.some(l => l.includes('.capture(false'))).toBe(true);
    await f.command('pause');
  });
  it('a failed native mask scan refuses capture before Page.captureScreenshot', async () => {
    const f = rig(); await f.start(); f.state.maskFails = true;
    const result = await f.cdp('Page.captureScreenshot', {});
    expect(result.error?.code).toBe('masking_unavailable');
    expect(f.log).not.toContain('Page.captureScreenshot');
    await f.command('pause');
  });
  it('carries the protected-document verdict into the native mask scan', async () => {
    const f = rig(); await f.start();
    await f.cdp('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'murage-protected-document-v1' });
    f.state.guardPrivate = true; f.state.maskFails = true;
    const result = await f.cdp('Page.captureScreenshot', {});
    expect(result.error?.code).toBe('masking_unavailable');
    expect(f.evals().some(e => e.includes('if(true&&!r.length)return false'))).toBe(true);
    expect(f.log).not.toContain('Page.captureScreenshot');
    await f.command('pause');
  });
  it('the screenshot capture draws opaque boxes over password and card fields', async () => {
    const f = rig(); await f.start(); await f.cdp('Page.captureScreenshot', {});
    const probe = f.evals().find(e => e.includes('password') && e.includes('getBoundingClientRect'));
    expect(probe).toBeTruthy(); expect(probe).toMatch(/cc-|one-time-code/);
    await f.command('pause');
  });
  it('a fallback signal draws a CDP outline with no fill, hidden around screenshots', async () => {
    const f = rig(); await f.start(); await f.cdp('Runtime.evaluate', { expression: '1' });
    const name = f.calls.find(([m, p]) => m === 'Runtime.addBinding' && p.executionContextName === PRESENCE_WORLD)[1].name;
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Runtime.bindingCalled', { name, executionContextId: 8, payload: 'fallback' });
    const rect = f.calls.find(([m]) => m === 'Overlay.highlightRect');
    expect(rect).toBeTruthy(); expect(rect[1].color.a).toBe(0); expect(rect[1].width).toBe(1280);
    f.log.length = 0; await f.cdp('Page.captureScreenshot', {});
    const hide = f.log.indexOf('Overlay.hideHighlight'), shot = f.log.indexOf('Page.captureScreenshot'), draw = f.log.lastIndexOf('Overlay.highlightRect');
    expect(hide).toBeGreaterThan(-1); expect(hide).toBeLessThan(shot); expect(draw).toBeGreaterThan(shot);
    await f.command('pause');
  });
  it('detaches the debugger after the idle window and attaches again on the next dispatch', async () => {
    const f = rig(); await f.start(); await f.cdp('Runtime.evaluate', { expression: '1' });
    expect(f.api.debugger.attach).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(f.api.debugger.detach).toHaveBeenCalledWith({ tabId: 1 }), { timeout: 2000 });
    expect(removes(f)).toBeGreaterThan(0);
    expect((await f.command('status')).result.state).toBe('active');
    expect((await f.cdp('Runtime.evaluate', { expression: '2' })).error).toBeUndefined();
    expect(f.api.debugger.attach).toHaveBeenCalledTimes(2);
    expect(f.evals().filter(e => e.length > 5000).length).toBe(2);
    await f.command('pause');
  });
  it('does not detach while a command is in flight', async () => {
    // The idle window runs from start(); the slow command must be dispatched inside it or the tab is
    // released legitimately BEFORE any command is in flight (a loaded runner took >80 ms to get there).
    // A window far longer than that gap, and a wait that outlasts it, keeps the claim: in flight past the window, no detach.
    const IDLE = 1000;
    // commandTimeoutMs must outlast the wait below, or the command itself times out and detaches.
    const f = rig({}, { idleDetachMs: IDLE, commandTimeoutMs: 5 * IDLE }); await f.start();
    const base = f.api.debugger.sendCommand, impl = base.getMockImplementation();
    let release; base.mockImplementation((s, m, p) => (m === 'Runtime.evaluate' && p.expression === 'slow') ? new Promise(r => { release = () => r({ result: { value: 1 } }); }) : impl(s, m, p));
    const pending = f.cdp('Runtime.evaluate', { expression: 'slow' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await new Promise(r => setTimeout(r, IDLE + 300));
    expect(f.api.debugger.detach).not.toHaveBeenCalled();
    release(); expect((await pending).error).toBeUndefined();
    await f.command('pause');
  });
});

describe('Opus gate (round 10): the overlay world the server asks for never takes the guard release', () => {
  it('after the server opens the guard world and then the overlay world, an idle release still disarms the guard in the guard world', async () => {
    const f = rig({}, { idleDetachMs: 80 }); await f.start();
    expect((await f.cdp('Page.createIsolatedWorld', { frameId: 'frame', worldName: 'murage-protected-document-v1' })).error).toBeUndefined();
    expect((await f.cdp('Page.createIsolatedWorld', { frameId: 'frame', worldName: PRESENCE_WORLD })).error).toBeUndefined();
    await vi.waitFor(() => expect(f.api.debugger.detach).toHaveBeenCalled(), { timeout: 3000 });
    expect(f.evals(7)).toContain('globalThis.__murageGuard?.enable(false)');
    expect(f.evals(8)).not.toContain('globalThis.__murageGuard?.enable(false)');
  });
});
