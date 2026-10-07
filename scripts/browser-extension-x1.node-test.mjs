// SPDX-License-Identifier: AGPL-3.0-or-later
import { nativeRealm } from '../server/testing/native-dom-fixture.ts';
// Lane X1 (extension runtime: state, recovery, contract). Fake chrome api, no browser: every test here is plain node:test and
// none may skip. The guard's page-side behaviour is run in a vm with a counting document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createBrowserExtensionRuntime } from '../extensions/murage-browser/runtime.mjs';
import { PRESENCE_REMOVE_EXPRESSION } from '../extensions/murage-browser/presence.mjs';
import { BROWSER_DOCUMENT_GUARD_SOURCE } from '../server/browser-document-guard.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));
const KEY = 'murageBrowserState';

// An in-memory chrome.* double. `failSet` makes the next N storage writes reject.
function fixture(stored = {}, options = {}) {
  const tabs = new Map([[999, { id: 999, url: 'https://private.test/secrets' }]]);
  let next = 1, failSet = 0;
  const completion = new Set(), setCalls = [], sent = [], commands = [];
  const observer = { paused: false };
  const sendCommand = async (source, method, params = {}) => {
    commands.push({ source, method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: params.worldName === 'murage-presence-v1' ? 8 : 7 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
    if (method === 'Runtime.evaluate' && params.expression?.startsWith('globalThis.__murageTakeover?.')) return { result: { type: 'boolean', value: params.expression.includes('.arm(') ? !observer.paused : observer.paused } };
    if (method === 'Runtime.evaluate' && params.contextId === 8) return { result: { type: 'boolean', value: true } };
    return { value: 'owned' };
  };
  const api = {
    webNavigation: { onCompleted: { addListener: l => completion.add(l), removeListener: l => completion.delete(l) } },
    storage: { local: {
      get: async key => ({ [key]: structuredClone(stored[key]) }),
      set: async value => { setCalls.push(structuredClone(value)); if (failSet > 0) { failSet--; throw new Error('storage unavailable'); } Object.assign(stored, structuredClone(value)); },
    } },
    runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: async message => { sent.push(message); } },
    tabs: {
      create: async ({ url }) => { const tab = { id: next++, url, ...(options.incognitoCreate ? { incognito: true } : {}) }; tabs.set(tab.id, tab); for (const l of completion) l({ tabId: tab.id, frameId: 0, url }); return tab; },
      get: async id => { if (!tabs.has(id)) throw Error('missing'); return tabs.get(id); },
      group: async () => 42, remove: async id => { tabs.delete(id); }, update: async () => ({}),
    },
    downloads: { cancel: async id => { cancelled.push(id); }, erase: async q => { erased.push(q.id); } },
    tabGroups: { update: async () => {} }, action: { setBadgeText: async () => {} },
    debugger: { attach: async () => { attaches++; }, detach: async () => { detaches++; }, sendCommand },
  };
  let attaches = 0, detaches = 0; const cancelled = [], erased = [], events = [];
  const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: e => events.push(e), commandTimeoutMs: 500, presence: false, presenceRenewMs: 3_600_000, ...options.runtime });
  let requestId = 0, connection = 0, nonce = 'a'.repeat(32), wire = false;
  const original = runtime.connection;
  runtime.connection = async value => { const result = await original(value); if (value && !wire) { requestId = 0; nonce = (++connection).toString(16).padStart(32, '0'); } wire = value; return result; };
  const command = (operation, params = {}, generation = 1, bindingId = 'bot_a') => runtime.handleRequest({ version: 1, type: 'command', id: `${nonce}_${++requestId}`, bindingId, generation, operation, params });
  const bind = (bindingId = 'bot_a', generation = 1, extra = {}) => command('bind', { profileId: 'profile_1', botName: bindingId, approvedOrigins: ['https://allowed.test'], ...extra }, generation, bindingId);
  const init = async () => { await runtime.initialize(); await runtime.connection(true); return bind(); };
  const navigate = async () => { tabs.get(1).url = 'https://allowed.test/page'; await runtime.navigation({ tabId: 1, frameId: 0, url: tabs.get(1).url }); };
  // A bound, navigated binding with its tab attached (one read), so cleanup has something to detach.
  const attached = async () => { await init(); await navigate(); const r = await command('cdp', { method: 'Runtime.evaluate', params: { expression: '1' }, tabId: 1, navigationEpoch: 2 }); assert.equal(r.error, undefined); };
  const status = () => runtime.handlePanel({ action: 'status' });
  // Make one Runtime.evaluate expression hang until released; everything else answers as before.
  const hold = (expression, grab) => { api.debugger.sendCommand = (source, method, params = {}) => (method === 'Runtime.evaluate' && params.expression === expression) ? new Promise(r => grab(r)) : sendCommand(source, method, params); };
  return { hold, api, runtime, command, bind, init, navigate, attached, status, tabs, stored, setCalls, sent, events, commands, observer, cancelled, erased,
    failNext: n => { failSet = n; }, counts: () => ({ attaches, detaches }) };
}
const persisted = f => f.stored[KEY];

// ---- RES-001 -------------------------------------------------------------------------------------------------------------------
for (const [label, act] of [
  ['Pause', f => f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' })],
  ['Stop', f => f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' })],
  ['disconnect', f => f.runtime.connection(false)],
]) {
  test(`RES-001: one storage rejection does not stop ${label} from detaching; the next save retries and status shows the marker`, async () => {
    const f = fixture(); await f.attached();
    const before = f.counts().detaches;
    f.failNext(1);
    await act(f).catch(() => {});
    assert.ok(f.counts().detaches - before >= 1, `${label} must detach even when the save is rejected`);
    assert.equal((await f.status()).persistenceFailed, true, 'a persistence-failure marker is visible in status');
    const writes = f.setCalls.length;
    await f.runtime.connection(true).catch(() => {});
    await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' }).catch(() => {});
    assert.ok(f.setCalls.length > writes, 'the next save reaches storage again');
    assert.equal((await f.status()).persistenceFailed, false, 'the marker clears once a save lands');
  });
}

// ---- RES-004 -------------------------------------------------------------------------------------------------------------------
test('RES-004: a bindings object that is not a list starts clean with no grants, a quarantine copy and a re-share message', async () => {
  const bad = { profileId: 'profile_1', retired: [], bindings: { bot_a: { id: 'bot_a', generation: 4, state: 'active', approvedOrigins: ['https://allowed.test'], tabs: [{ tabId: 5, origin: 'https://allowed.test' }] } } };
  const f = fixture({ [KEY]: structuredClone(bad) });
  await f.runtime.initialize();
  const s = await f.status();
  assert.deepEqual(s.bindings, [], 'no grants survive a malformed record');
  assert.equal(s.recovery?.code, 'reshare_required');
  assert.match(s.recovery.message, /share/i);
  assert.deepEqual(f.stored.murageBrowserStateQuarantine?.state, bad, 'the old data is kept as a copy');
  assert.deepEqual(persisted(f).bindings, [], 'the live record is repaired');
  assert.equal((await f.runtime.connection(true)).type, 'hello');
  assert.equal((await f.bind()).result.state, 'active', 'a fresh bind works after recovery');
});
test('RES-004: one bad record is dropped, a good one is kept paused, and the bad data is quarantined', async () => {
  const good = { id: 'bot_a', botName: 'Alex', generation: 2, state: 'active', approvedOrigins: ['https://allowed.test'], tabs: [] };
  const f = fixture({ [KEY]: { profileId: 'profile_1', retired: [], bindings: [good, { id: 7, generation: 'x', approvedOrigins: 'nope' }, null, 'junk'] } });
  await f.runtime.initialize();
  const s = await f.status();
  assert.deepEqual(s.bindings.map(b => [b.bindingId, b.state, b.generation]), [['bot_a', 'paused', 3]]);
  assert.equal(s.recovery?.code, 'reshare_required');
  assert.ok(f.stored.murageBrowserStateQuarantine);
});
test('RES-004: a state saved by a newer extension is preserved untouched and asks for an update', async () => {
  const newer = { schema: 99, profileId: 'profile_1', bindings: [{ id: 'bot_a', generation: 1 }] };
  const f = fixture({ [KEY]: structuredClone(newer) });
  await f.runtime.initialize();
  const s = await f.status();
  assert.equal(s.recovery?.code, 'update_required');
  assert.deepEqual(s.bindings, []);
  await f.runtime.connection(true); await f.bind().catch(() => {});
  assert.deepEqual(f.stored[KEY], newer, 'newer data is never overwritten');
});
test('RES-004: an unreadable store starts clean in memory and never overwrites what it could not read', async () => {
  const stored = { [KEY]: { schema: 1, profileId: 'profile_1', bindings: [] } };
  const f = fixture(stored);
  f.api.storage.local.get = async () => { throw new Error('storage unreadable'); };
  await f.runtime.initialize();
  assert.equal((await f.status()).persistenceFailed, true);
  assert.equal(f.setCalls.length, 0);
});

// ---- RES-007: the page guard ---------------------------------------------------------------------------------------------------
function guardPage() {
  let listeners = 0, observers = 0, now = 0, seq = 0;
  const timers = new Map(), added = [];
  class MutationObserver { observe() { observers++; this.on = true; } disconnect() { if (this.on) { observers--; this.on = false; } } }
  const document = {
    addEventListener: (type) => { listeners++; added.push(type); }, removeEventListener: () => { listeners--; },
    querySelectorAll: () => [], getElementById: () => null,
  };
  const context = { ...nativeRealm, document, MutationObserver, getComputedStyle: () => ({}), Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; }, clearTimeout: id => timers.delete(id) };
  runInNewContext(BROWSER_DOCUMENT_GUARD_SOURCE, context);
  const advance = ms => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.fn(); } };
  return { guard: context.__murageGuard, counts: () => ({ listeners, observers }), advance, added };
}
test('RES-007: an installed but disabled guard holds 0 listeners and 0 observers', () => {
  const p = guardPage();
  assert.deepEqual(p.counts(), { listeners: 0, observers: 0 });
  p.guard.enable(true);
  assert.deepEqual(p.counts(), { listeners: 8, observers: 1 });
  p.guard.enable(false);
  assert.deepEqual(p.counts(), { listeners: 0, observers: 0 });
});
test('RES-007: the guard re-arms after dispose, and enabling twice never doubles the listeners', () => {
  const p = guardPage();
  p.guard.enable(true); p.guard.enable(true);
  assert.deepEqual(p.counts(), { listeners: 8, observers: 1 });
  p.guard.dispose?.();
  assert.deepEqual(p.counts(), { listeners: 0, observers: 0 });
  p.guard.enable(true);
  assert.deepEqual(p.counts(), { listeners: 8, observers: 1 });
  assert.equal(typeof p.guard.dispose, 'function');
  assert.equal(p.guard() === false || p.guard() === true, true, 'the verdict is still answered while disarmed');
});
test('RES-007: an expired lease releases the guard, and a renewal extends it', () => {
  const p = guardPage();
  p.guard.enable(true);
  p.advance(100_000); p.guard.enable(true);
  p.advance(100_000);
  assert.deepEqual(p.counts(), { listeners: 8, observers: 1 }, 'a renewed lease is still held');
  p.advance(100_000);
  assert.deepEqual(p.counts(), { listeners: 0, observers: 0 }, 'an expired lease releases it');
  p.guard.enable(true);
  assert.deepEqual(p.counts(), { listeners: 8, observers: 1 });
});
test('RES-007: Stop, Pause and unshare disarm the page guard through the dispose path', async () => {
  const f = fixture(); await f.init(); await f.navigate();
  await f.command('cdp', { method: 'Page.createIsolatedWorld', params: { frameId: 'main-frame', worldName: 'murage-protected-document-v1' }, tabId: 1, navigationEpoch: 2 });
  await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' });
  assert.ok(f.commands.some(c => c.method === 'Runtime.evaluate' && c.params.expression === 'globalThis.__murageGuard?.enable(false)'));
});

// ---- SEC-008 -------------------------------------------------------------------------------------------------------------------
test('SEC-008: an incognito tab is refused before anything about it is stored', async () => {
  const f = fixture(); await f.init();
  f.tabs.set(50, { id: 50, url: 'https://allowed.test/private-window-page', incognito: true });
  const r = await f.runtime.handlePanel({ action: 'share', bindingId: 'bot_a', tabId: 50 }).catch(e => ({ error: e.code }));
  assert.equal(r.error ?? r.code, 'incognito_denied');
  assert.ok(!JSON.stringify(f.stored).includes('private-window-page'), 'no address from a private window is persisted');
  assert.ok(!JSON.stringify(await f.status()).includes('private-window-page'));
});
test('SEC-008: a bot tab opened in a private window is refused and closed', async () => {
  const f = fixture({}, { incognitoCreate: true });
  await f.runtime.initialize(); await f.runtime.connection(true);
  const r = await f.bind();
  assert.equal(r.error?.code, 'incognito_denied');
  assert.deepEqual((await f.status()).bindings.flatMap(b => b.tabs), []);
});

// ---- SPD-002 -------------------------------------------------------------------------------------------------------------------
const item = (id, url, referrer = '') => ({ id, url, finalUrl: url, referrer, filename: 'a.zip' });
test('SPD-002: an unrelated download decision returns in under 5 ms even with a shared tab', async () => {
  const f = fixture(); await f.attached();
  const t0 = performance.now();
  const blocked = await f.runtime.downloadDetermining(item(1, 'https://other.test/file.zip', 'https://other.test/'));
  assert.equal(blocked, false);
  assert.ok(performance.now() - t0 < 5, `took ${performance.now() - t0} ms`);
  assert.deepEqual(f.cancelled, []);
});
test('SPD-002: a same-origin download from another tab is neither cancelled nor erased while the bot is busy', async () => {
  const f = fixture({}, { runtime: { downloadWaitMs: 40 } }); await f.attached();
  let release; f.hold('slow read', r => { release = r; });
  const pending = f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'slow read' }, tabId: 1, navigationEpoch: 2 });
  await settle();
  await f.runtime.downloadCreated(item(9, 'https://allowed.test/report.pdf', 'https://allowed.test/page'));
  const blocked = await f.runtime.downloadDetermining(item(9, 'https://allowed.test/report.pdf', 'https://allowed.test/page'));
  assert.equal(blocked, false);
  assert.deepEqual(f.cancelled, []); assert.deepEqual(f.erased, []);
  release?.({ value: 'x' }); await pending;
});
test('SPD-002: a download the bot started is blocked, whichever of the two events arrives first', async () => {
  for (const decisionFirst of [true, false]) {
    const f = fixture({}, { runtime: { downloadWaitMs: 500 } }); await f.attached();
    let release; f.hold('click download', r => { release = r; });
    const pending = f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'click download' }, tabId: 1, navigationEpoch: 2 });
    await settle();
    const url = 'https://allowed.test/bot.zip';
    const begin = () => f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { url, suggestedFilename: 'bot.zip' });
    let blocked;
    if (decisionFirst) { const d = f.runtime.downloadDetermining(item(3, url, 'https://allowed.test/page')); await settle(); await begin(); blocked = await d; }
    else { await begin(); blocked = await f.runtime.downloadDetermining(item(3, url, 'https://allowed.test/page')); }
    assert.equal(blocked, true, `decisionFirst=${decisionFirst}`);
    assert.deepEqual(f.cancelled, [3]); assert.deepEqual(f.erased, [3]);
    release?.({ value: 'x' }); await pending;
  }
});
test('SPD-002: an announcement from the bot tab expires, so an old URL never cancels a later owner download', async () => {
  let now = 1_000_000;
  const realNow = Date.now; Date.now = () => now;
  try {
    const f = fixture(); await f.attached();
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { url: 'https://allowed.test/old.zip', suggestedFilename: 'old.zip' });
    now += 120_000;
    assert.equal(await f.runtime.downloadDetermining(item(4, 'https://allowed.test/old.zip')), false);
    assert.deepEqual(f.cancelled, []);
  } finally { Date.now = realNow; }
});

// ---- DSK-001 -------------------------------------------------------------------------------------------------------------------
test('DSK-001: 100 read-only requests make 0 storage writes', async () => {
  const f = fixture(); await f.attached();
  const before = f.setCalls.length;
  for (let i = 0; i < 100; i++) {
    const r = await f.command('cdp', { method: i % 2 ? 'Runtime.evaluate' : 'Accessibility.getFullAXTree', params: i % 2 ? { expression: '1' } : {}, tabId: 1, navigationEpoch: 2 });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
  }
  await settle();
  assert.equal(f.setCalls.length - before, 0);
});
test('DSK-001: a mutation is journaled once and cleared once', async () => {
  const f = fixture(); await f.attached();
  const before = f.setCalls.length;
  const r = await f.command('cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }, tabId: 1, navigationEpoch: 2 });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  await settle();
  const writes = f.setCalls.slice(before).map(s => s[KEY]);
  assert.equal(writes.length, 2);
  assert.ok(writes[0].inFlight, 'the intent is on disk before the action');
  assert.equal(writes[1].inFlight, undefined, 'and cleared after it settles');
});
test('DSK-001: when the intent cannot be recorded the mutation is refused, not run unrecorded', async () => {
  const f = fixture(); await f.attached();
  f.failNext(1);
  const before = f.commands.length;
  const r = await f.command('cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }, tabId: 1, navigationEpoch: 2 });
  assert.equal(r.error?.code, 'persistence_failed');
  assert.ok(!f.commands.slice(before).some(c => c.method === 'Input.dispatchMouseEvent'));
});

// ---- RES-008 -------------------------------------------------------------------------------------------------------------------
test('RES-008: busy() is false for an authorized idle binding and true only while an action runs', async () => {
  const f = fixture(); await f.attached();
  assert.equal(f.runtime.driving(), true);
  assert.equal(f.runtime.busy(), false);
  let release; f.hold('hold', r => { release = r; });
  const pending = f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'hold' }, tabId: 1, navigationEpoch: 2 });
  await settle();
  assert.equal(f.runtime.busy(), true);
  release({ value: 1 }); await pending; await settle();
  assert.equal(f.runtime.busy(), false);
});

// ---- RES-003 (runtime half) ----------------------------------------------------------------------------------------------------
test('RES-003: after Stop a new binding is accepted and the stopped one stays stopped', async () => {
  const f = fixture(); await f.init();
  await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
  const old = (await f.status()).bindings.find(b => b.bindingId === 'bot_a');
  assert.equal(old.state, 'stopped');
  const fresh = await f.bind('bot_a2');
  assert.equal(fresh.result.state, 'active');
  assert.equal((await f.bind('bot_a', old.generation)).result.state, 'stopped', 'bind cannot revive a stopped task');
  assert.equal((await f.runtime.handlePanel({ action: 'resume', bindingId: 'bot_a' }).catch(e => ({ error: e.code }))).error, 'binding_stopped');
});

// ---- UX-001: the status contract -----------------------------------------------------------------------------------------------
test('UX-001: the status carries every field the panel reads (PANEL-CONTRACT.md version 1)', async () => {
  const f = fixture(); await f.init();
  await f.command('status', { panel: { mode: 'task', conversation: 'Weekly report', botColor: '#aa3300', grants: [{ origin: 'https://allowed.test', label: 'Reports' }],
    activity: [{ time: '09:41', text: 'Opened the report page' }], sites: [{ origin: 'https://allowed.test', category: 'asks' }] } });
  const s = await f.status();
  assert.equal(s.version, 1); assert.equal(s.connected, true); assert.equal(s.profileId, 'profile_1');
  const b = s.bindings[0];
  assert.equal(b.bindingId, 'bot_a'); assert.equal(b.botName, 'bot_a'); assert.equal(b.state, 'active'); assert.equal(b.ready, true);
  assert.equal(b.mode, 'task'); assert.equal(b.conversation, 'Weekly report'); assert.equal(b.botColor, '#aa3300');
  assert.deepEqual(b.grants, [{ origin: 'https://allowed.test', label: 'Reports' }]);
  assert.deepEqual(b.activity, [{ time: '09:41', text: 'Opened the report page' }]);
  assert.deepEqual(b.sites, [{ origin: 'https://allowed.test', category: 'asks' }]);
  assert.deepEqual(b.tabs.map(t => t.tabId), [1]);
  assert.ok(Array.isArray(b.panelActions));
  assert.equal(b.updateWaiting, false);
  assert.ok(!('pausedReason' in b) || b.pausedReason === undefined);
});
test('UX-001: the runtime pushes the whole status to the panel on a change, and a closed panel is no error', async () => {
  const f = fixture(); await f.init(); await settle();
  const before = f.sent.length;
  await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' });
  const push = f.sent.slice(before).find(m => m?.type === 'murage.panel.status');
  assert.ok(push); assert.equal(push.version, 1); assert.equal(push.status.bindings[0].state, 'paused');
  f.api.runtime.sendMessage = async () => { throw new Error('Receiving end does not exist'); };
  await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
});
test('UX-001: a panel revoke removes the origin from the grants and unshares its tabs', async () => {
  const f = fixture(); await f.attached();
  const r = await f.runtime.handlePanel({ action: 'revoke', bindingId: 'bot_a', origin: 'https://allowed.test' });
  assert.deepEqual(r.approvedOrigins, []);
  assert.deepEqual(r.tabs, []);
});

// ---- T25 (runtime half) --------------------------------------------------------------------------------------------------------
test('T25: a handoff detaches the page (no bar, guard or overlay) and the binding shows Your turn', async () => {
  const f = fixture({}, { runtime: { presence: true } }); await f.init(); await f.navigate();
  await f.command('cdp', { method: 'Page.createIsolatedWorld', params: { frameId: 'main-frame', worldName: 'murage-protected-document-v1' }, tabId: 1, navigationEpoch: 2 });
  await f.command('cdp', { method: 'Runtime.evaluate', params: { expression: '1' }, tabId: 1, navigationEpoch: 2 });
  const detaches = f.counts().detaches;
  const r = await f.command('pause', { reason: 'handoff', handoff: 'Enter the code your bank sent you.' });
  assert.equal(r.error, undefined);
  assert.ok(f.counts().detaches > detaches, 'the debugger bar is gone');
  assert.ok(f.commands.some(c => c.method === 'Runtime.evaluate' && c.params.expression === 'globalThis.__murageGuard?.enable(false)'), 'guard disarmed');
  assert.ok(f.commands.some(c => c.method === 'Runtime.evaluate' && c.params.expression === PRESENCE_REMOVE_EXPRESSION), 'overlay removed');
  const b = (await f.status()).bindings[0];
  assert.equal(b.state, 'paused'); assert.equal(b.pausedReason, 'handoff'); assert.equal(b.handoff, 'Enter the code your bank sent you.');
  assert.equal(b.canContinue, true); assert.ok(b.panelActions.includes('continue'));
  assert.equal((await f.command('cdp', { method: 'Runtime.evaluate', params: { expression: '1' }, tabId: 1, navigationEpoch: 2 }, 2)).error.code, 'binding_inactive');
});
test('T25: the handoff survives a restart, still waiting for Continue', async () => {
  const stored = {}; const f = fixture(stored); await f.init();
  await f.command('pause', { reason: 'handoff', handoff: 'Sign in yourself.' });
  const g = fixture(stored); await g.runtime.initialize();
  const b = (await g.status()).bindings[0];
  assert.equal(b.state, 'paused'); assert.equal(b.pausedReason, 'handoff'); assert.equal(b.handoff, 'Sign in yourself.');
});
test('T25: Resume is refused on a handoff; Continue re-checks the sites, advances the generation and tells the app', async () => {
  const f = fixture(); await f.init(); await f.navigate();
  await f.command('pause', { reason: 'handoff', handoff: 'Sign in yourself.' });
  assert.equal((await f.runtime.handlePanel({ action: 'resume', bindingId: 'bot_a' }).catch(e => ({ error: e.code }))).error, 'handoff_use_continue');
  const before = (await f.status()).bindings[0].generation;
  const events = f.events.length;
  const r = await f.runtime.handlePanel({ action: 'continue', bindingId: 'bot_a' });
  assert.equal(r.state, 'active'); assert.equal(r.generation, before + 1);
  assert.ok(f.events.slice(events).some(e => e.event === 'resumed'));
  const b = (await f.status()).bindings[0];
  assert.equal(b.pausedReason, undefined); assert.equal(b.handoff, undefined);
  assert.equal((await f.runtime.handlePanel({ action: 'continue', bindingId: 'bot_a' }).catch(e => ({ error: e.code }))).error, 'not_handoff');
});
test('T25: Continue is refused offline and on a site that is no longer allowed', async () => {
  const f = fixture(); await f.init();
  await f.command('pause', { reason: 'handoff', handoff: 'Sign in yourself.' });
  f.tabs.get(1).url = 'https://elsewhere.test/';
  assert.equal((await f.runtime.handlePanel({ action: 'continue', bindingId: 'bot_a' }).catch(e => ({ error: e.code }))).error, 'site_denied');
  f.tabs.get(1).url = 'about:blank';
  await f.runtime.connection(false);
  assert.equal((await f.runtime.handlePanel({ action: 'continue', bindingId: 'bot_a' }).catch(e => ({ error: e.code }))).error, 'host_offline');
});

// ---- Astra blind review (xr-x1): confirmed findings, each closed with a test --------------------------------------------------
test('XR: Continue cannot undo a Stop that lands while it reads the page', async () => {
  const f = fixture(); await f.init();
  await f.command('pause', { reason: 'handoff', handoff: 'Sign in yourself.' });
  const realGet = f.api.tabs.get; let release;
  f.api.tabs.get = id => new Promise(resolve => { release = () => resolve(realGet(id)); });
  const pending = f.runtime.handlePanel({ action: 'continue', bindingId: 'bot_a' }).catch(e => ({ error: e.code }));
  await settle();
  f.api.tabs.get = realGet;
  await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
  release();
  assert.equal((await pending).error, 'binding_inactive');
  assert.equal((await f.status()).bindings[0].state, 'stopped');
});
test('XR: an owner download with the bot\'s address is not cancelled when nothing the bot did explains it, and the bot\'s own item is still caught', async () => {
  const f = fixture({}, { runtime: { downloadAfterMs: -1, downloadWaitMs: 20 } }); await f.attached();
  const url = 'https://allowed.test/same.zip';
  await f.runtime.downloadCreated(item(101, url, 'https://allowed.test/other-tab'));
  await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { url, suggestedFilename: 'same.zip' });
  assert.deepEqual(f.cancelled, [], 'the owner\'s download 101 is left alone');
  assert.equal(await f.runtime.downloadDetermining(item(102, url)), true, 'the bot\'s download 102 is blocked');
  assert.deepEqual(f.cancelled, [102]);
});
test('XR: a second acting command that arrives while the first is being recorded is busy, not run unrecorded', async () => {
  const f = fixture(); await f.attached();
  const realSet = f.api.storage.local.set; let release;
  f.api.storage.local.set = value => new Promise(resolve => { release = () => resolve(realSet(value)); });
  const a = f.command('cdp', { method: 'Input.insertText', params: { text: 'a' }, tabId: 1, navigationEpoch: 2 });
  await settle();
  const b = await f.command('cdp', { method: 'Input.insertText', params: { text: 'b' }, tabId: 1, navigationEpoch: 2 });
  assert.equal(b.error?.code, 'busy');
  f.api.storage.local.set = realSet; release(); await a;
});
test('XR: a profile saved by a newer extension refuses to bind and nothing runs unrecorded', async () => {
  const f = fixture({ [KEY]: { schema: 99, profileId: 'profile_1', bindings: [] } });
  await f.runtime.initialize(); await f.runtime.connection(true);
  assert.equal((await f.bind()).error?.code, 'update_required');
  assert.equal((await f.status()).recovery?.code, 'update_required', 'the message stays until the extension is updated');
});
test('XR: a record with a wrong-typed state keeps no grants, is quarantined and asks to share again', async () => {
  const f = fixture({ [KEY]: { schema: 1, profileId: 'profile_1', retired: [], bindings: [{ id: 'bot_a', botName: 'A', generation: 1, state: { wrong: true }, tabs: 'bad', approvedOrigins: ['https://allowed.test'] }] } });
  await f.runtime.initialize();
  const s = await f.status();
  assert.deepEqual(s.bindings, []); assert.equal(s.recovery?.code, 'reshare_required'); assert.ok(f.stored.murageBrowserStateQuarantine);
  const g = fixture({ [KEY]: { schema: '99', profileId: 'profile_1', bindings: [] } });
  await g.runtime.initialize(); assert.equal((await g.status()).recovery?.code, 'reshare_required');
});
test('XR: a primitive stored value is quarantined as it was', async () => {
  const f = fixture({ [KEY]: 42 });
  await f.runtime.initialize();
  assert.equal(f.stored.murageBrowserStateQuarantine.state, 42);
  assert.equal((await f.status()).recovery?.code, 'reshare_required');
});
test('XR: owner navigation in a stopped or idle binding writes nothing to storage', async () => {
  const f = fixture(); await f.attached();
  await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' }); await settle();
  await f.runtime.navigation({ tabId: 1, frameId: 0, url: 'https://allowed.test/a#1' });
  const before = f.setCalls.length;
  for (let i = 2; i < 5; i++) await f.runtime.navigation({ tabId: 1, frameId: 0, url: `https://allowed.test/a#${i}` });
  await f.runtime.discarded(1);
  assert.equal(f.setCalls.length - before, 0);
});

// ---- Final gate (Opus) ---------------------------------------------------------------------------------------------------------
test('GATE: the engine evaluate shapes that move the page (scroll, history) are journaled; a plain read is not', async () => {
  for (const [expression, acting] of [['window.scrollBy(0, 300)', true], ['window.scrollBy(-120.5, 0)', true], ['history.back()', true], ['history.forward()', true], ['document.title', false], ['location.href', false]]) {
    const f = fixture(); await f.attached();
    const before = f.setCalls.length;
    const r = await f.command('cdp', { method: 'Runtime.evaluate', params: { expression, returnByValue: true }, tabId: 1, navigationEpoch: 2 });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    await settle();
    const writes = f.setCalls.slice(before).map(s => s[KEY]);
    if (acting) { assert.equal(writes.length, 2, expression); assert.ok(writes[0].inFlight, expression); assert.equal(writes[1].inFlight, undefined, expression); }
    else assert.equal(writes.length, 0, expression);
  }
});
test('GATE: a revoked origin is not granted back by a rebind or a restart while the app still lists it; once the app drops it, a new listing grants it', async () => {
  const stored = {}; const f = fixture(stored); await f.attached();
  await f.runtime.handlePanel({ action: 'revoke', bindingId: 'bot_a', origin: 'https://allowed.test' });
  let gen = (await f.status()).bindings[0].generation;
  let r = await f.bind('bot_a', gen);
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.deepEqual(r.result.approvedOrigins, [], 'a rebind that still lists the revoked origin does not restore it');
  assert.deepEqual((await f.status()).bindings[0].grants, [], 'the panel shows no grant for it');
  const g = fixture(stored); await g.runtime.initialize(); await g.runtime.connection(true);
  gen = (await g.status()).bindings[0].generation;
  r = await g.bind('bot_a', gen);
  assert.deepEqual(r.result.approvedOrigins, [], 'the revoke survives a restart');
  r = await g.bind('bot_a', gen, { approvedOrigins: [] });
  assert.deepEqual(r.result.approvedOrigins, []);
  r = await g.bind('bot_a', gen, { approvedOrigins: ['https://allowed.test'] });
  assert.deepEqual(r.result.approvedOrigins, ['https://allowed.test'], 'after the app dropped it, listing it again is a fresh approval');
});
test('GATE: a malformed stored revoke list drops the record instead of returning its grants', async () => {
  const f = fixture({ [KEY]: { schema: 1, profileId: 'profile_1', retired: [], bindings: [{ id: 'bot_a', botName: 'a', generation: 1, state: 'paused', approvedOrigins: ['https://allowed.test'], revoked: 'https://allowed.test', tabs: [] }] } });
  await f.runtime.initialize();
  const s = await f.status();
  assert.deepEqual(s.bindings, []); assert.equal(s.recovery?.code, 'reshare_required');
});
test('GATE: a download from a new tab the bot tab opened is blocked even after the action ended; a page it showed releases the address', async () => {
  let now = 1_000_000; const realNow = Date.now; Date.now = () => now;
  try {
    const f = fixture({}, { runtime: { downloadWaitMs: 20 } }); await f.attached();
    now += 10_000; // the bot is idle: nothing it is doing right now explains a download
    const url = 'https://files.test/payload.bin';
    await f.runtime.navigationTarget({ tabId: 50, sourceTabId: 1, url });
    assert.equal(await f.runtime.downloadDetermining(item(11, url, 'https://allowed.test/page')), true);
    assert.deepEqual(f.cancelled, [11]); assert.deepEqual(f.erased, [11]);
    const page = 'https://allowed.test/next';
    await f.runtime.navigationTarget({ tabId: 51, sourceTabId: 1, url: page });
    await f.runtime.navigation({ tabId: 51, frameId: 0, url: page });
    assert.equal(await f.runtime.downloadDetermining(item(12, page, 'https://allowed.test/next')), false, 'an owner download of a page address is not cancelled');
    await f.runtime.navigationTarget({ tabId: 52, sourceTabId: 999, url: 'https://private.test/own.zip' });
    assert.equal(await f.runtime.downloadDetermining(item(13, 'https://private.test/own.zip')), false, 'a tab the owner opened elsewhere is never the bot\'s');
    assert.deepEqual(f.cancelled, [11]);
  } finally { Date.now = realNow; }
});

// ---- C2: panel owner actions and phase ----------------------------------------------------------------------------------------
test('C2: panelActions list each owner action only where it applies', async () => {
  const f = fixture(); await f.init();
  let b = (await f.status()).bindings[0];
  assert.ok(b.panelActions.includes('endtask')); assert.ok(!b.panelActions.includes('newtask'));
  assert.ok(!b.panelActions.includes('setMode') && !b.panelActions.includes('turnoff'), 'step mode has nothing tighter and nothing to turn off');
  await f.command('status', { panel: { mode: 'full', full: true } });
  b = (await f.status()).bindings[0];
  assert.ok(b.panelActions.includes('setMode')); assert.ok(b.panelActions.includes('turnoff'));
  await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
  b = (await f.status()).bindings[0];
  assert.deepEqual(b.panelActions.filter(a => ['newtask', 'endtask', 'setMode', 'turnoff', 'revoke'].includes(a)), ['newtask']);
});
test('C2: the panel buttons tell the app, and only ever tighten', async () => {
  const f = fixture(); await f.init();
  await f.command('status', { panel: { mode: 'full', full: true } });
  let n = f.events.length;
  await f.runtime.handlePanel({ action: 'setMode', bindingId: 'bot_a', mode: 'task' });
  assert.ok(f.events.slice(n).some(e => e.event === 'notice' && e.data.kind === 'owner_set_mode' && e.data.mode === 'task'));
  assert.equal((await f.runtime.handlePanel({ action: 'setMode', bindingId: 'bot_a', mode: 'full' }).catch(e => ({ error: e.code }))).error, 'invalid_action');
  n = f.events.length;
  await f.runtime.handlePanel({ action: 'turnoff', bindingId: 'bot_a' });
  assert.ok(f.events.slice(n).some(e => e.data?.kind === 'owner_turn_off'));
  n = f.events.length;
  await f.runtime.handlePanel({ action: 'endtask', bindingId: 'bot_a' });
  assert.ok(f.events.slice(n).some(e => e.data?.kind === 'owner_end_task'));
  assert.equal((await f.runtime.handlePanel({ action: 'newtask', bindingId: 'bot_a' }).catch(e => ({ error: e.code }))).error, 'binding_inactive', 'a running task cannot start a new one');
  await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
  n = f.events.length;
  await f.runtime.handlePanel({ action: 'newtask', bindingId: 'bot_a' });
  assert.ok(f.events.slice(n).some(e => e.data?.kind === 'owner_new_task'));
});
test('C2: phase is reported only when it is true', async () => {
  const f = fixture(); await f.init();
  assert.equal((await f.status()).bindings[0].phase, undefined, 'a ready bot with no read in flight has no phase');
  await f.command('pause', {}); await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
  assert.equal((await f.status()).bindings[0].phase, undefined, 'a stopped bot has none');
  const g = fixture(); await g.init();
  await g.command('status', { panel: { phase: 'waiting' } });
  assert.equal((await g.status()).bindings[0].phase, 'waiting');
  await g.command('status', { panel: { mode: 'step' } });
  assert.equal((await g.status()).bindings[0].phase, undefined, 'the app clears it by leaving it out');
});

test('C2: the app can answer a hand-over with its own Continue, and nothing else resumes from the app', async () => {
  const f = fixture(); await f.init(); await f.navigate();
  assert.equal((await f.command('resume', { reason: 'continue' })).error.code, 'owner_action_required', 'no hand-over is waiting');
  await f.command('pause', { reason: 'handoff', handoff: 'Sign in yourself.' });
  const before = (await f.status()).bindings[0].generation;
  assert.equal((await f.command('resume', {}, before)).error.code, 'owner_action_required', 'a plain resume is still the owner in the browser');
  const r = await f.command('resume', { reason: 'continue' }, before);
  assert.equal(r.error, undefined);
  const b = (await f.status()).bindings[0];
  assert.equal(b.state, 'active'); assert.equal(b.generation, before + 1);
});
