// SPDX-License-Identifier: AGPL-3.0-or-later
// Journey 1024, section 20 (the bot indicator in the owner's browser) and section 3 (the extension side of the one-time per-bot OK).
// Every row enters through the extension's own entry points: runtime.handleRequest (what service-worker.mjs hands each native
// message to), runtime.handlePanel (the side panel's messages) and runtime.debuggerEvent (chrome.debugger.onEvent). The page chip is
// the exact source the runtime sends to the tab, run in a small DOM.
import { describe, it, expect, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { createBrowserExtensionRuntime } from '../extensions/murage-browser/runtime.mjs';
import * as tabGroup from '../extensions/murage-browser/tab-group.mjs';
import { PRESENCE_WORLD, PRESENCE_REMOVE_EXPRESSION } from '../extensions/murage-browser/presence.mjs';

const ORIGIN = 'https://allowed.test';
const AVATAR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const AVATAR_ID = '0123456789abcdef';
// Murage's own toolbar icon (manifest action.default_icon), and Chrome's nine group colours: written out here, not imported, so
// the expectations do not follow the code under test.
const DEFAULT_ACTION_ICON = { 16: 'icons/icon16.png', 32: 'icons/icon32.png' };
const CHROME_NINE = { grey: [95, 99, 104], blue: [26, 115, 232], red: [217, 48, 37], yellow: [249, 171, 0], green: [30, 142, 62], pink: [208, 24, 132], purple: [161, 66, 244], cyan: [0, 123, 131], orange: [250, 144, 62] };
const nearestGroupColor = hex => tabGroup.nearestGroupColor?.(hex);
const groupTitle = tabGroup.groupTitle;
// Stands in for the pixel decode only (createImageBitmap + OffscreenCanvas exist in Chrome's worker, not in node).
const pixels = dataUrl => ({ 16: { from: dataUrl, size: 16 }, 32: { from: dataUrl, size: 32 } });

function rig({ without = [], runtimeOptions = {} } = {}) {
  let next = 1; const tabs = new Map(); const store = {}; const calls = []; const completion = new Set(); const events = [];
  const sendCommand = vi.fn(async (_s, method, params = {}) => {
    calls.push([method, params]);
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.worldName === PRESENCE_WORLD ? 8 : 7 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-' + params.worldName };
    if (method === 'Runtime.evaluate' && params.contextId === 8) {
      if (params.expression === PRESENCE_REMOVE_EXPRESSION || params.expression.length > 5000) return { result: { type: 'undefined' } };
      return { result: { type: 'boolean', value: true } };
    }
    if (method === 'Runtime.evaluate' && params.expression?.startsWith('globalThis.__murageTakeover?.')) return { result: { type: 'boolean', value: params.expression.includes('.arm(') } };
    return { value: 'owned' };
  });
  const api = {
    webNavigation: { onCompleted: { addListener: l => completion.add(l), removeListener: l => completion.delete(l) } },
    storage: { local: { get: async k => ({ [k]: store[k] }), set: async v => Object.assign(store, structuredClone(v)) } },
    runtime: { getManifest: () => ({ version: '1.0.2' }) },
    tabs: {
      create: vi.fn(async ({ url }) => { const tab = { id: next++, url, windowId: 7 }; tabs.set(tab.id, tab); for (const l of completion) l({ tabId: tab.id, frameId: 0, url }); return tab; }),
      get: vi.fn(async id => { if (!tabs.has(id)) throw Error('missing'); return tabs.get(id); }),
      group: vi.fn(async ({ groupId }) => groupId ?? 40 + next), ungroup: vi.fn(async () => {}), remove: vi.fn(async id => tabs.delete(id)),
    },
    tabGroups: { update: vi.fn(async () => {}), move: vi.fn(async () => {}) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}), setIcon: vi.fn(async () => {}) },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand },
  };
  for (const path of without) { const [a, b] = path.split('.'); if (b) delete api[a][b]; else delete api[a]; }
  const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: e => events.push(e), commandTimeoutMs: 500, presenceRenewMs: 20, idleDetachMs: 150, avatarIcon: pixels, ...runtimeOptions });
  let seq = 0; const nonce = '1'.padStart(32, '0');
  const command = (operation, params = {}, generation = 1, bindingId = 'bot_a') => runtime.handleRequest({ version: 1, type: 'command', id: `${nonce}_${++seq}`, bindingId, generation, operation, params });
  const boot = async () => { await runtime.initialize(); await runtime.connection(true); };
  const bind = (bindingId, botName, panel) => command('bind', { profileId: 'profile_1', botName, approvedOrigins: [ORIGIN], ...(panel ? { panel } : {}) }, 1, bindingId);
  const result = async reply => { const r = await reply; if (r.error) throw Object.assign(new Error(r.error.code), { code: r.error.code }); return r.result; };
  // The bot's tab lands on an allowed site and one command is dispatched: the page chip is installed.
  const drive = async (tabId = 1, bindingId = 'bot_a') => {
    tabs.get(tabId).url = ORIGIN + '/p'; await runtime.navigation({ tabId, frameId: 0, url: ORIGIN + '/p' });
    return command('cdp', { method: 'Runtime.evaluate', params: { expression: '1' }, tabId, navigationEpoch: 2 }, 1, bindingId);
  };
  const groupProps = groupId => api.tabGroups.update.mock.calls.filter(c => c[0] === groupId).at(-1)?.[1];
  const last = (fn, tabId) => fn.mock.calls.map(c => c[0]).filter(a => a.tabId === tabId).at(-1);
  const chipSources = () => calls.filter(([m, p]) => m === 'Page.addScriptToEvaluateOnNewDocument' && p.worldName === PRESENCE_WORLD).map(([, p]) => p.source);
  const chipBinding = () => calls.filter(([m, p]) => m === 'Runtime.addBinding' && p.executionContextName === PRESENCE_WORLD).at(-1)[1].name;
  const chipRemoves = () => calls.filter(([m, p]) => m === 'Runtime.evaluate' && p.contextId === 8 && p.expression === PRESENCE_REMOVE_EXPRESSION).length;
  return { api, runtime, command, boot, bind, result, drive, groupProps, last, chipSources, chipBinding, chipRemoves, events, tabs, store };
}

// A DOM just large enough to mount the chip: elements, a closed shadow root, a constructed style sheet.
function page(bindingName, signals) {
  class Node {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.text = ''; const props = {};
      this.style = { props, cssText: '', display: '', opacity: '', setProperty: (k, v) => { props[k] = v; }, removeProperty: k => { delete props[k]; } }; }
    set textContent(v) { this.text = String(v); this.children = []; } get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
    appendChild(c) { c.parent?.removeChild(c); c.parent = this; this.children.push(c); return c; } append(...cs) { for (const c of cs) this.appendChild(c); }
    removeChild(c) { this.children = this.children.filter(x => x !== c); c.parent = null; } remove() { this.parent?.removeChild(this); }
    replaceChildren(...cs) { for (const c of [...this.children]) this.removeChild(c); this.append(...cs); }
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
    removeEventListener() {}
    fire(type, event = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === document.documentElement; }
    attachShadow() { this.shadow = new Node('#shadow'); this.shadow.adoptedStyleSheets = []; return this.shadow; }
    matches() { return false; } showPopover() {} hidePopover() {}
    animate() { return { cancel() {}, addEventListener() {}, finished: Promise.resolve() }; }
    getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, left: 0, top: 0, right: 0, bottom: 0 }; }
    get firstChild() { return this.children[0] ?? null; } get lastChild() { return this.children.at(-1) ?? null; }
  }
  const document = { documentElement: new Node('html'), createElement: tag => new Node(tag), createElementNS: (_ns, tag) => new Node(tag), activeElement: null, body: null };
  let now = 0; const timers = [];
  const g = { document, performance: { now: () => now }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: id => { timers[id - 1] = { fn() {} }; }, setTimeout: fn => { fn(); return 0; }, clearTimeout: () => {},
    MutationObserver: class { observe() {} disconnect() {} }, CSSStyleSheet: class { replaceSync(text) { this.text = text; } }, matchMedia: () => ({ matches: false }), innerWidth: 1280, innerHeight: 800,
    requestAnimationFrame: fn => { fn(0); return 0; }, cancelAnimationFrame: () => {}, [bindingName]: payload => signals.push(payload) };
  g.globalThis = g;
  const flat = (n, out = []) => { out.push(n); for (const c of n.children) flat(c, out); if (n.shadow) flat(n.shadow, out); return out; };
  return { g, all: () => flat(document.documentElement), host: () => document.documentElement.children[0], step: ms => { now += ms; for (const t of timers) t.fn(); } };
}
// What the owner sees in the tab while the bot acts: read from the mounted chip, never from the source text.
function seen(p) {
  const nodes = p.all(), host = p.host();
  const cls = name => nodes.filter(n => String(n.className).split(' ').includes(name));
  const css = host?.shadow?.adoptedStyleSheets?.[0]?.text ?? '';
  const chip = cls('pill')[0];
  const within = (root, pred) => { const out = []; const walk = n => { if (pred(n)) out.push(n); n.children.forEach(walk); }; if (root) walk(root); return out; };
  const shown = n => { for (let x = n; x; x = x.parent) if (x.style.display === 'none') return false; return true; };
  const stop = within(chip, n => n.tagName === 'BUTTON' && n.textContent === 'Stop' && shown(n))[0];
  return { mounted: !!host && host.isConnected, chipShown: !!chip && shown(chip), chipText: chip ? within(chip, n => n.tagName === 'SPAN' && !n.className && shown(n)).map(n => n.textContent).join('') : '',
    chipPicture: within(chip, n => n.tagName === 'IMG')[0]?.src, pointerPicture: within(cls('main')[0], n => n.tagName === 'IMG')[0]?.src, stop,
    borderShown: cls('frame').length === 1 && shown(cls('frame')[0]), borderColor: /\.frame\{[^}]*border:2px solid (#[0-9a-fA-F]{6})/.exec(css)?.[1],
    cornerColors: within(host?.shadow, n => n.tagName === 'PATH').map(n => n.getAttribute('stroke')) };
}

describe('nearest of Chrome\'s nine group colours', () => {
  it.each([['#01a492', 'cyan'], ['#1a73e8', 'blue'], ['#d93025', 'red'], ['#f9ab00', 'yellow'], ['#1e8e3e', 'green'], ['#d01884', 'pink'], ['#a142f4', 'purple'], ['#5f6368', 'grey'], ['#ff6b35', 'orange'], ['#000000', 'green'], ['#7c3aed', 'purple']])('%s -> %s', (hex, name) => {
    expect(nearestGroupColor(hex)).toBe(name);
    // The rule itself, not a table: no other of the nine is closer.
    const d = n => CHROME_NINE[n].reduce((s, c, i) => s + (c - parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)) ** 2, 0);
    for (const other of Object.keys(CHROME_NINE)) expect(d(name)).toBeLessThanOrEqual(d(other));
    expect(Object.keys(tabGroup.TAB_GROUP_RGB ?? {}).sort()).toEqual(Object.keys(CHROME_NINE).sort());
  });
  it('a bot with no colour, or a malformed one, keeps Murage orange', () => {
    for (const bad of [undefined, '', 'teal', '#12345', '#gggggg', 7]) expect(nearestGroupColor(bad)).toBe('orange');
  });
  it('the title is the bot name alone while it works, and Murage only for a nameless binding', () => {
    expect(groupTitle({ botName: 'Dax', state: 'active' })).toBe('Dax');
    expect(groupTitle({ botName: '  ', state: 'active' })).toBe('Murage');
  });
});

describe('W22a tab group per bot', () => {
  it('one bot: the group carries its name and the nearest colour to its own', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { botColor: '#01a492' }));
    expect(r.api.tabs.group).toHaveBeenCalledWith({ tabIds: [1] });
    expect(r.groupProps(42)).toEqual({ title: 'Dax', color: 'cyan' });
  });
  it('two bots: two groups, each with its own name and colour, never a shared tab', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { botColor: '#01a492' }));
    await r.result(r.bind('bot_b', 'Mia', { botColor: '#7c3aed' }));
    expect(r.groupProps(42)).toEqual({ title: 'Dax', color: 'cyan' });
    expect(r.groupProps(43)).toEqual({ title: 'Mia', color: 'purple' });
    expect(r.api.tabs.group.mock.calls.map(c => c[0])).toEqual([{ tabIds: [1] }, { tabIds: [2] }]);
    for (const [, props] of r.api.tabGroups.update.mock.calls) { expect(props).not.toHaveProperty('collapsed'); expect(JSON.stringify(props)).not.toMatch(/bot_[ab]/); }
    expect(r.api.tabGroups.move).not.toHaveBeenCalled();
  });
  it('a colour that arrives later (a status from the app) recolours the group', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax'));
    expect(r.groupProps(42).color).toBe('orange');
    await r.result(r.command('status', { panel: { botColor: '#d01884' } }));
    expect(r.groupProps(42).color).toBe('pink');
  });
  it('Stop dissolves the group: its tabs are ungrouped and it is never retitled again', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { botColor: '#01a492' }));
    const before = r.api.tabGroups.update.mock.calls.length;
    await r.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    expect(r.api.tabs.ungroup.mock.calls).toEqual([[[1]]]);
    expect(r.api.tabGroups.update.mock.calls.length).toBe(before);
    expect(r.api.tabs.remove).not.toHaveBeenCalled();
  });
});

describe('W22b toolbar icon and badge on the bot\'s own tab', () => {
  it('while the bot works: its picture and a badge in its colour, on its tab id only', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { botColor: '#01a492' }));
    await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }));
    expect(r.last(r.api.action.setIcon, 1)).toEqual({ tabId: 1, imageData: pixels(AVATAR) });
    expect(r.last(r.api.action.setBadgeText, 1)).toEqual({ tabId: 1, text: 'ON' });
    expect(r.last(r.api.action.setBadgeBackgroundColor, 1)).toEqual({ tabId: 1, color: '#01a492' });
    for (const [arg] of [...r.api.action.setIcon.mock.calls, ...r.api.action.setBadgeText.mock.calls]) expect(arg.tabId).toBe(1);
  });
  it('two bots: each tab shows its own bot', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax')); await r.result(r.bind('bot_b', 'Mia'));
    await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }, 1, 'bot_a'));
    expect(r.last(r.api.action.setIcon, 1)).toEqual({ tabId: 1, imageData: pixels(AVATAR) });
    expect(r.last(r.api.action.setIcon, 2)).toEqual({ tabId: 2, path: DEFAULT_ACTION_ICON });
  });
  it('Stop puts Murage\'s own icon back and clears the badge', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { botColor: '#01a492' }));
    await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }));
    await r.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    expect(r.last(r.api.action.setIcon, 1)).toEqual({ tabId: 1, path: DEFAULT_ACTION_ICON });
    expect(r.last(r.api.action.setBadgeText, 1)).toEqual({ tabId: 1, text: '' });
  });
  it('a tab the owner takes back loses the picture and the badge', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax'));
    await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }));
    await r.runtime.handlePanel({ action: 'unshare', bindingId: 'bot_a', tabId: 1 });
    expect(r.last(r.api.action.setIcon, 1)).toEqual({ tabId: 1, path: DEFAULT_ACTION_ICON });
    expect(r.last(r.api.action.setBadgeText, 1)).toEqual({ tabId: 1, text: '' });
  });
  it('a picture that cannot be decoded leaves the badge and Murage\'s icon: a cue, never a gate', async () => {
    const r = rig({ runtimeOptions: { avatarIcon: async () => { throw new Error('decode'); } } }); await r.boot();
    await r.result(r.bind('bot_a', 'Dax'));
    expect((await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }))).avatarId).toBe(AVATAR_ID);
    expect(r.last(r.api.action.setIcon, 1)).toEqual({ tabId: 1, path: DEFAULT_ACTION_ICON });
    expect(r.last(r.api.action.setBadgeText, 1)).toEqual({ tabId: 1, text: 'ON' });
  });
  it('without the tabGroups permission the extension still drives, with the icon and badge', async () => {
    const r = rig({ without: ['tabGroups'] }); await r.boot();
    const bound = await r.bind('bot_a', 'Dax', { botColor: '#01a492' }); const pictured = await r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }); const drove = bound.error ? bound : await r.drive();
    expect({ bound: bound.error?.code, state: bound.result?.state, pictured: pictured.error?.code, drove: drove.error?.code, icon: r.last(r.api.action.setIcon, 1), chip: bound.error ? undefined : chipShown(r) }).toEqual({ bound: undefined, state: 'active', pictured: undefined, drove: undefined, icon: { tabId: 1, imageData: pixels(AVATAR) }, chip: true });
    // One assertion for the whole row: bound, still active, picture on the icon, a command driven, and the page chip up.
    // (Chrome gives tabs.group without the tabGroups permission; only tabGroups.update is missing.)
    expect(r.api.tabs.group).toHaveBeenCalledWith({ tabIds: [1] });
    expect(r.last(r.api.action.setBadgeText, 1)).toEqual({ tabId: 1, text: 'ON' });
  });
});

describe('W22c page chip and border', () => {
  async function chip(panel = { botColor: '#7c3aed' }, avatar = true) {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', panel));
    if (avatar) await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }));
    expect((await r.drive()).error).toBeUndefined();
    const signals = []; const p = page(r.chipBinding(), signals);
    runInNewContext(r.chipSources().at(-1), p.g);
    return { r, p, signals };
  }
  it('while the bot acts: a border in the bot\'s colour and a chip with its picture, its name and Stop', async () => {
    const { p } = await chip();
    p.g.__muragePresence.state('driving', { full: false });
    const s = seen(p);
    expect(s.mounted).toBe(true);
    expect(s.borderShown).toBe(true);
    expect(s.borderColor).toBe('#7c3aed');
    expect(new Set(s.cornerColors.filter((_, i) => i % 2 === 1))).toEqual(new Set(['#7c3aed']));
    expect(s.chipShown).toBe(true);
    expect(s.chipText).toBe('Dax is working');
    expect(s.chipPicture).toBe(AVATAR);
    expect(s.pointerPicture).toBe(AVATAR);
    expect(s.stop).toBeTruthy();
  });
  it('a bot with no picture or colour keeps its initial and Murage orange', async () => {
    const { p } = await chip(null, false);
    p.g.__muragePresence.state('driving', { full: false });
    const s = seen(p);
    expect(s.borderColor).toBe('#ff6b35');
    expect(s.chipPicture).toBeUndefined();
    expect(s.chipText).toBe('Dax is working');
  });
  it('a page that refuses the picture keeps the initial', async () => {
    const { p } = await chip();
    p.g.__muragePresence.state('driving', { full: false });
    for (const img of p.all().filter(n => n.tagName === 'IMG')) img.fire('error');
    expect(seen(p).chipPicture).toBeUndefined();
    expect(p.all().filter(n => n.className === 'av')[0].textContent).toBe('D');
  });
  it('the chip\'s Stop is today\'s Stop: the bot stops, the chip, group, picture and badge all go', async () => {
    const { r, p, signals } = await chip();
    p.g.__muragePresence.state('driving', { full: false });
    seen(p).stop.fire('click', { isTrusted: true });
    expect(signals).toEqual(['stop']);
    const removesBefore = r.chipRemoves();
    await r.runtime.debuggerEvent({ tabId: 1 }, 'Runtime.bindingCalled', { name: r.chipBinding(), executionContextId: 8, payload: signals[0] });
    expect((await r.result(r.command('status', {}, 2))).state).toBe('stopped');
    expect(r.chipRemoves()).toBe(removesBefore + 1);
    p.g.__muragePresence.remove();
    expect(seen(p).mounted).toBe(false);
    expect(r.api.tabs.ungroup.mock.calls).toEqual([[[1]]]);
    expect(r.last(r.api.action.setIcon, 1)).toEqual({ tabId: 1, path: DEFAULT_ACTION_ICON });
    expect(r.last(r.api.action.setBadgeText, 1)).toEqual({ tabId: 1, text: '' });
  });
  it('a click the page made up never stops the bot', async () => {
    const { p, signals } = await chip();
    p.g.__muragePresence.state('driving', { full: false });
    seen(p).stop.fire('click', { isTrusted: false });
    expect(signals).toEqual([]);
  });
  it('idle: with no renewal the chip and border remove themselves', async () => {
    const { p } = await chip();
    p.g.__muragePresence.state('driving', { full: false });
    expect(seen(p).mounted).toBe(true);
    p.step(3100);
    expect(seen(p).mounted).toBe(false);
    expect(p.g.__muragePresence).toBeUndefined();
  });
  it('a picture or colour that arrives after the chip is up is drawn on the next action', async () => {
    const { r } = await chip({ botColor: '#7c3aed' }, false);
    expect(r.chipSources().length).toBe(1);
    await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }));
    await r.result(r.command('status', { panel: { botColor: '#d93025' } }));
    expect((await r.command('cdp', { method: 'Runtime.evaluate', params: { expression: '2' }, tabId: 1, navigationEpoch: 2 })).error).toBeUndefined();
    const signals = []; const p = page(r.chipBinding(), signals);
    runInNewContext(r.chipSources().at(-1), p.g);
    p.g.__muragePresence.state('driving', { full: false });
    expect(seen(p).chipPicture).toBe(AVATAR);
    expect(seen(p).borderColor).toBe('#d93025');
  });
});

describe('the one-time per-bot OK, extension side', () => {
  const panelOf = async (r, id = 'bot_a') => (await r.runtime.handlePanel({ action: 'status' })).bindings.find(b => b.bindingId === id);
  it('the panel shows the OK the app reports and offers only Off', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { grant: 'on' }));
    const b = await panelOf(r);
    expect(b.grant).toBe('on');
    expect(b.panelActions).toContain('grantoff');
    expect(b.panelActions).not.toContain('granton');
  });
  it('Off from the panel stops the bot at once, tells the app, and removes the indicator', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { grant: 'on', botColor: '#01a492' }));
    const after = await r.runtime.handlePanel({ action: 'grantoff', bindingId: 'bot_a' }).catch(error => ({ refused: error.code }));
    expect(after.state).toBe('stopped');
    expect(after.grant).toBe('off');
    expect(after.panelActions).not.toContain('grantoff');
    const notices = r.events.filter(e => e.event === 'notice').map(e => [e.bindingId, e.generation, e.data]);
    expect(notices).toEqual([['bot_a', 1, { kind: 'owner_grant_off', offId: 'profile_1' }]]);
    expect(r.events.map(e => e.event)).toEqual(['notice', 'stopped']);
    expect(r.api.tabs.ungroup.mock.calls).toEqual([[[1]]]);
    expect(r.last(r.api.action.setBadgeText, 1)).toEqual({ tabId: 1, text: '' });
    // A command already on its way is refused.
    expect((await r.drive()).error?.code).toBeTruthy();
  });
  it('Off works with the app away, survives a restart, and the app reads it from the next summary', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { grant: 'on' }));
    await r.runtime.connection(false);
    const after = await r.runtime.handlePanel({ action: 'grantoff', bindingId: 'bot_a' }).catch(error => ({ refused: error.code }));
    expect(after.state).toBe('stopped');
    expect(r.events.filter(e => e.event === 'notice')).toEqual([]);
    const stored = JSON.parse(JSON.stringify(r.store));
    const again = rig(); Object.assign(again.store, stored); await again.boot();
    const summary = await again.result(again.command('status', {}, 3));
    expect(summary.grant).toBe('off');
    expect(summary.state).toBe('stopped');
    // The app's word never lifts an Off the owner pressed here.
    await again.result(again.command('status', { panel: { grant: 'on' } }, 3));
    expect((await panelOf(again)).grant).toBe('off');
  });
  it('the OK cannot be given, or an Off lifted, from the extension', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax'));
    await expect(r.runtime.handlePanel({ action: 'granton', bindingId: 'bot_a' })).rejects.toMatchObject({ code: 'desktop_required' });
    await expect(r.runtime.handlePanel({ action: 'grantoff', bindingId: 'bot_a' })).rejects.toMatchObject({ code: 'invalid_action' });
    expect((await panelOf(r)).grant).toBeUndefined();
    expect((await r.result(r.command('status'))).state).toBe('active');
  });
  it('a bind the app marks Off opens no tab and binds nothing', async () => {
    const r = rig(); await r.boot();
    const refused = await r.bind('bot_a', 'Dax', { grant: 'off' });
    expect(refused.error?.code).toBe('grant_off');
    expect(r.api.tabs.create).not.toHaveBeenCalled();
    expect((await r.runtime.handlePanel({ action: 'status' })).bindings).toEqual([]);
  });
});

// Rows added after the self-review of the first cut (kept at the end so the rows above keep their lines).
describe('indicator edges', () => {
  const chipFor = r => { const signals = []; const p = page(r.chipBinding(), signals); runInNewContext(r.chipSources().at(-1), p.g); p.g.__muragePresence.state('driving', { full: false }); return p; };
  it('a group that cannot be dissolved says stopped, never working', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { botColor: '#01a492' }));
    r.api.tabs.ungroup.mockRejectedValueOnce(new Error('No tab with id'));
    await r.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    expect(r.groupProps(42)).toEqual({ title: 'Dax · stopped', color: 'grey' });
  });
  it('a picture still being decoded when Stop lands never comes back on the stopped tab', async () => {
    let release; const gate = new Promise(resolve => { release = resolve; });
    const decoding = vi.fn(async dataUrl => { await gate; return pixels(dataUrl); });
    const r = rig({ runtimeOptions: { avatarIcon: decoding } }); await r.boot();
    await r.result(r.bind('bot_a', 'Dax'));
    const arriving = r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR });
    for (let i = 0; i < 100 && !decoding.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 2));
    await r.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    release(); await arriving;
    expect(r.last(r.api.action.setIcon, 1)).toEqual({ tabId: 1, path: DEFAULT_ACTION_ICON });
  });
  it('after a worker restart the old tab loses the picture and the badge', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax'));
    await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }));
    const again = rig(); Object.assign(again.store, JSON.parse(JSON.stringify(r.store))); await again.boot();
    expect(again.last(again.api.action.setIcon, 1)).toEqual({ tabId: 1, path: DEFAULT_ACTION_ICON });
    expect(again.last(again.api.action.setBadgeText, 1)).toEqual({ tabId: 1, text: '' });
  });
  it('an Off the app reports on a working bot stops it here and removes the indicator', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { grant: 'on' }));
    const summary = await r.result(r.command('status', { panel: { grant: 'off' } }));
    expect(summary.state).toBe('stopped');
    expect(r.api.tabs.ungroup.mock.calls).toEqual([[[1]]]);
  });
  it('after the owner\'s Off the same binding is never bound again', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { grant: 'on' }));
    await r.runtime.handlePanel({ action: 'grantoff', bindingId: 'bot_a' }).catch(() => {});
    const again = await r.command('bind', { profileId: 'profile_1', botName: 'Dax', approvedOrigins: [ORIGIN], panel: { grant: 'on' } }, 2, 'bot_a');
    expect(again.error?.code).toBe('grant_off');
  });
  it('a bind the app marks Off on a working bot stops it', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { grant: 'on' }));
    const refused = await r.bind('bot_a', 'Dax', { grant: 'off' });
    expect(refused.error?.code).toBe('grant_off');
    expect((await r.result(r.command('status', {}, 2))).state).toBe('stopped');
  });
  it('a picture alone, arriving after the chip is up, is drawn on the next action', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax')); await r.drive();
    await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }));
    await r.command('cdp', { method: 'Runtime.evaluate', params: { expression: '2' }, tabId: 1, navigationEpoch: 2 });
    expect(seen(chipFor(r)).chipPicture).toBe(AVATAR);
  });
  it('a colour alone, arriving after the chip is up, is drawn on the next action', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax')); await r.drive();
    await r.result(r.command('status', { panel: { botColor: '#d93025' } }));
    await r.command('cdp', { method: 'Runtime.evaluate', params: { expression: '2' }, tabId: 1, navigationEpoch: 2 });
    expect(seen(chipFor(r)).borderColor).toBe('#d93025');
  });
  it('the picture is drawn, and a page that then refuses it gets the initial back', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax'));
    await r.result(r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR })); await r.drive();
    const p = chipFor(r);
    const drawn = seen(p).chipPicture;
    for (const img of p.all().filter(n => n.tagName === 'IMG')) img.fire('error');
    expect([drawn, seen(p).chipPicture]).toEqual([AVATAR, undefined]);
  });
});

// The owner's Off is for the bot, not for one binding (the app makes one binding per conversation).
describe('the Off holds for the whole bot', () => {
  const dax = { grant: 'on', grantBot: 'k_dax' }, mia = { grant: 'on', grantBot: 'k_mia' };
  const state = async (r, id, generation) => (await r.result(r.command('status', {}, generation, id))).state;
  const off = (r, id = 'bot_a') => r.runtime.handlePanel({ action: 'grantoff', bindingId: id }).catch(error => ({ refused: error.code }));
  it('Off on one conversation stops every conversation of that bot, and no other bot', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', dax)); await r.result(r.bind('bot_b', 'Dax', dax)); await r.result(r.bind('bot_c', 'Mia', mia));
    await off(r);
    expect([await state(r, 'bot_a', 2), await state(r, 'bot_b', 2), await state(r, 'bot_c', 1)]).toEqual(['stopped', 'stopped', 'active']);
    expect(r.events.filter(e => e.event === 'notice').map(e => [e.bindingId, e.data])).toEqual([['bot_a', { kind: 'owner_grant_off', offId: 'profile_1' }], ['bot_b', { kind: 'owner_grant_off', offId: 'profile_1' }]]);
  });
  it('a new conversation of that bot is refused, with the id of the Off, while the app still says on', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', dax)); await off(r);
    const fresh = await r.bind('bot_n', 'Dax', dax);
    expect(fresh.error?.code).toBe('grant_off');
    expect(fresh.error?.message).toBe('profile_1');
    expect(r.api.tabs.create).toHaveBeenCalledTimes(1);
    expect((await r.bind('bot_m', 'Mia', mia)).error).toBeUndefined();
  });
  it('pressed with the app away, it still holds for a new conversation after a restart', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', dax)); await r.runtime.connection(false); await off(r);
    const again = rig(); Object.assign(again.store, JSON.parse(JSON.stringify(r.store))); await again.boot();
    expect((await again.bind('bot_n', 'Dax', dax)).error?.code).toBe('grant_off');
    expect((await again.result(again.command('status', {}, 3))).grantOffId).toBe('profile_1');
  });
  it('only a bind that names that Off, with a new OK, lifts it; then it is gone', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', dax)); await off(r);
    expect((await r.bind('bot_n', 'Dax', { ...dax, grantAck: 'some_other_off' })).error?.code).toBe('grant_off');
    expect([(await r.bind('bot_n', 'Dax', { grantBot: 'k_dax', grant: 'off', grantAck: 'profile_1' })).error?.code, (await r.bind('bot_x', 'Dax', dax)).error?.code]).toEqual(['grant_off', 'grant_off']);
    expect((await r.bind('bot_n', 'Dax', { ...dax, grantAck: 'profile_1' })).result?.state).toBe('active');
    expect((await r.bind('bot_o', 'Dax', dax)).result?.state).toBe('active');
  });
  it('an app that sends no bot key: the Off holds by the bot\'s name', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', { grant: 'on' })); await off(r);
    expect((await r.bind('bot_n', 'Dax', { grant: 'on' })).error?.code).toBe('grant_off');
    expect((await r.bind('bot_m', 'Mia', { grant: 'on' })).error).toBeUndefined();
  });
  it('after an Off the app reported, that conversation is never bound again', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', dax));
    await r.command('status', { panel: { grant: 'off' } });
    expect((await r.command('bind', { profileId: 'profile_1', botName: 'Dax', approvedOrigins: [ORIGIN], panel: dax }, 2, 'bot_a')).error?.code).toBe('grant_off');
  });
});
function chipShown(r) {
  const p = page(r.chipBinding(), []); runInNewContext(r.chipSources().at(-1), p.g);
  p.g.__muragePresence.state('driving', { full: false });
  return seen(p).chipShown;
}

describe('one bot, several conversations', () => {
  const dax = { grant: 'on', grantBot: 'k_dax', botColor: '#01a492' };
  it('two conversations of one bot share the bot\'s group; stopping one leaves the group to the other', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', dax)); await r.result(r.bind('bot_b', 'Dax', dax)); await r.result(r.bind('bot_c', 'Mia', { grantBot: 'k_mia' }));
    expect(r.api.tabs.group.mock.calls.map(c => c[0])).toEqual([{ tabIds: [1] }, { tabIds: [2], groupId: 42 }, { tabIds: [3] }]);
    await r.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    expect([r.api.tabs.ungroup.mock.calls, r.groupProps(42)]).toEqual([[[[1]]], { title: 'Dax', color: 'cyan' }]);
  });
  it('one conversation paused, one working: the shared group reads as working', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', dax)); await r.result(r.bind('bot_b', 'Dax', dax));
    await r.runtime.handlePanel({ action: 'pause', bindingId: 'bot_b' }); await r.command('avatar', { avatarId: AVATAR_ID, data: AVATAR }, 1, 'bot_a');
    expect(r.groupProps(await r.api.tabs.group.mock.results[1].value).title).not.toMatch(/paused/);
  });
  it('Off: no command of a sibling conversation runs while the first one is still being released', async () => {
    const r = rig(); await r.boot();
    await r.result(r.bind('bot_a', 'Dax', dax)); await r.result(r.bind('bot_b', 'Dax', dax));
    await r.drive(1, 'bot_a'); await r.drive(2, 'bot_b');
    let release; const held = new Promise(resolve => { release = resolve; });
    r.api.debugger.detach.mockImplementationOnce(() => held);
    const off = r.runtime.handlePanel({ action: 'grantoff', bindingId: 'bot_a' }).catch(error => ({ refused: error.code }));
    await new Promise(resolve => setTimeout(resolve, 5));
    const before = r.api.debugger.sendCommand.mock.calls.length;
    const sibling = await r.command('cdp', { method: 'Runtime.evaluate', params: { expression: '3' }, tabId: 2, navigationEpoch: 2 }, 1, 'bot_b');
    const reached = r.api.debugger.sendCommand.mock.calls.slice(before).some(c => c[1] === 'Runtime.evaluate' && c[2]?.expression === '3');
    release(); await off;
    expect({ refused: !!sibling.error, reached }).toEqual({ refused: true, reached: false });
  });
});
// Review round on efd10d130d (OPUS/FABLE board lines): the app's Off on any binding id, one group under overlapping binds, no Off ever dropped.
describe('review round 2: Off on any id, overlapping binds, standing Offs', () => {
  const dax = { grant: 'on', grantBot: 'k_dax', botColor: '#01a492' }, mia = { grant: 'on', grantBot: 'k_mia' };
  const state = async (r, id) => (await r.result(r.command('status', {}, 1, id))).state;
  it('an Off the app sends on a bind for a NEW id stops the bot\'s working conversations, and no other bot', async () => {
    const r = rig(); await r.boot();
    await r.bind('bot_a', 'Dax', dax); await r.bind('bot_b', 'Dax', dax); await r.bind('bot_c', 'Mia', mia);
    await r.bind('bot_n', 'Dax', { grantBot: 'k_dax', grant: 'off' });
    expect([await state(r, 'bot_a'), await state(r, 'bot_b'), await state(r, 'bot_c')]).toEqual(['stopped', 'stopped', 'active']);
  });
  it('an Off the app sends on a bind for a STOPPED id stops the bot\'s other working conversation', async () => {
    const r = rig(); await r.boot();
    await r.bind('bot_a', 'Dax', dax); await r.bind('bot_b', 'Dax', dax); await r.bind('bot_c', 'Mia', mia);
    await r.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    await r.command('bind', { profileId: 'profile_1', botName: 'Dax', approvedOrigins: [ORIGIN], panel: { grantBot: 'k_dax', grant: 'off' } }, 2, 'bot_a');
    expect([await state(r, 'bot_b'), await state(r, 'bot_c')]).toEqual(['stopped', 'active']);
  });
  it('an Off the app sends on a status of a STOPPED conversation stops the bot\'s other working conversation', async () => {
    const r = rig(); await r.boot();
    await r.bind('bot_a', 'Dax', dax); await r.bind('bot_b', 'Dax', dax); await r.bind('bot_c', 'Mia', mia);
    await r.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    await r.command('status', { panel: { grant: 'off' } }, 1, 'bot_a');
    expect([await state(r, 'bot_b'), await state(r, 'bot_c')]).toEqual(['stopped', 'active']);
  });
  it('a stopped conversation that is Off itself, rebound while the app says on, stops nobody', async () => {
    const r = rig(); await r.boot();
    await r.bind('bot_a', 'Dax', dax); await r.command('status', { panel: { grant: 'off' } }, 1, 'bot_a'); await r.bind('bot_b', 'Dax', dax);
    const again = await r.command('bind', { profileId: 'profile_1', botName: 'Dax', approvedOrigins: [ORIGIN], panel: dax }, 2, 'bot_a');
    expect([again.error?.code, await state(r, 'bot_b')]).toEqual(['grant_off', 'active']);
  });
  it('two binds of one bot that overlap still make one group', async () => {
    const r = rig(); await r.boot();
    let release; const held = new Promise(resolve => { release = resolve; });
    r.api.tabs.group.mockImplementationOnce(async () => { await held; return 42; });
    const first = r.bind('bot_a', 'Dax', dax), second = r.bind('bot_b', 'Dax', dax);
    await new Promise(resolve => setTimeout(resolve, 20)); release(); await first; await second;
    expect(r.api.tabs.group.mock.calls.map(c => c[0])).toEqual([{ tabIds: [1] }, { tabIds: [2], groupId: 42 }]);
  });
  it('another bot does not wait for a bot whose group is still being made', async () => {
    const r = rig(); await r.boot();
    let release; const held = new Promise(resolve => { release = resolve; });
    r.api.tabs.group.mockImplementationOnce(async () => { await held; return 42; });
    const first = r.bind('bot_a', 'Dax', dax), other = r.bind('bot_c', 'Mia', mia);
    const before = await Promise.race([other.then(reply => reply.result?.state), new Promise(resolve => setTimeout(() => resolve('still waiting'), 100))]); release(); await first; await other;
    expect(before).toBe('active');
  });
  // 257 bots are turned Off in the panel, one after another, and none is lifted. Returns how many Offs the panel accepted.
  const manyOffs = async (r, n = { offs: 0 }) => {
    for (let i = 0; i < 257; i++) {
      await r.bind(`bot_${i}`, `Bot ${i}`, { grant: 'on', grantBot: `k_${i}` });
      await r.runtime.handlePanel({ action: 'grantoff', bindingId: `bot_${i}` }).then(() => { n.offs++; }, () => {});
      await r.runtime.handlePanel({ action: 'stop', bindingId: `bot_${i}` }).catch(() => {});
    } return n.offs;
  };
  it('the first of 257 Offs still holds: that bot is not bound again without a new OK', async () => {
    const r = rig(); await r.boot(); const offs = await manyOffs(r);
    expect([offs, (await r.bind('bot_again', 'Bot 0', { grant: 'on', grantBot: 'k_0' })).error?.code]).toEqual([257, 'grant_off']);
  });
  it('with more than 256 Offs standing no other bot is bound, until one Off is lifted', async () => {
    const r = rig(); await r.boot(); const offs = await manyOffs(r);
    const full = (await r.bind('bot_m', 'Mia', mia)).error?.code;
    const lifted = (await r.bind('bot_again', 'Bot 0', { grant: 'on', grantBot: 'k_0', grantAck: 'profile_1' })).result?.state;
    expect([offs, full, lifted, (await r.bind('bot_m', 'Mia', mia)).result?.state]).toEqual([257, 'grant_full', 'active', 'active']);
  });
  it('257 Offs survive a restart of the worker, the first and the last one too', async () => {
    const r = rig(); await r.boot(); const offs = await manyOffs(r);
    const again = rig(); Object.assign(again.store, JSON.parse(JSON.stringify(r.store))); await again.boot();
    expect([offs, (await again.bind('bot_again', 'Bot 0', { grant: 'on', grantBot: 'k_0' })).error?.code, (await again.bind('bot_newest', 'Bot 256', { grant: 'on', grantBot: 'k_256' })).error?.code]).toEqual([257, 'grant_off', 'grant_off']);
  });
});
