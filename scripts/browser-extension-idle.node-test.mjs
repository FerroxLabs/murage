// SPDX-License-Identifier: AGPL-3.0-or-later
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../extensions/murage-browser/service-worker.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/m, '');
const KEY = 'murageBrowserReconnect';
const settle = () => new Promise(resolve => setImmediate(resolve));
function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), fire: (...args) => Promise.all(listeners.map(fn => fn(...args))) };
}

// Isolated worker, profile storage, native host and clock. No browser or app is contacted.
async function fixture({ stored = {}, now = 1_000_000, random = 0.5, absent = true, busy = () => false, storageFails = false } = {}) {
  const timers = new Map(), alarms = new Map(), ports = [], attempts = [], sent = [];
  let sequence = 0, reloads = 0, wakeups = 0;
  const runtime = {
    initialize: async () => {}, connection: async () => ({ type: 'hello' }), restartReports: () => [],
    handlePanel: async () => ({}), handleRequest: async () => ({ result: {} }),
    driving: () => { throw Error('update must use busy'); }, drivingBotName: () => 'Fixture',
    ...(busy ? { busy } : {}),
  };
  const api = {
    runtime: {
      id: 'fixture', getURL: path => `chrome-extension://fixture/${path}`,
      onMessage: event(), onUpdateAvailable: event(), reload: () => { reloads++; },
      sendMessage: async message => { sent.push(message); },
      connectNative: () => {
        attempts.push(now);
        if (absent === 'throw') throw Error('host absent');
        const port = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} };
        ports.push(port);
        if (absent) queueMicrotask(() => { void port.onDisconnect.fire(); });
        return port;
      },
    },
    storage: { local: { get: async key => ({ [key]: structuredClone(stored[key]) }), set: async data => {
      if (storageFails) throw Error('storage unavailable');
      Object.assign(stored, structuredClone(data));
    } } },
    alarms: {
      create: (name, options) => alarms.set(name, { at: options.when ?? now + (options.delayInMinutes ?? options.periodInMinutes) * 60000, period: options.periodInMinutes * 60000 || 0 }),
      clear: async name => alarms.delete(name), onAlarm: event(),
    },
    webNavigation: Object.fromEntries(['onCommitted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onCreatedNavigationTarget'].map(name => [name, event()])),
    downloads: { onCreated: event(), onDeterminingFilename: event() },
    tabs: { onCreated: event(), onRemoved: event(), onReplaced: event(), onUpdated: event() },
    debugger: { onDetach: event(), onEvent: event() },
    sidePanel: { setPanelBehavior: async () => {} }, idle: { onStateChanged: event() }, commands: { onCommand: event() },
  };
  runInNewContext(source, {
    chrome: api, createBrowserExtensionRuntime: () => runtime,
    Date: class extends Date { static now() { return now; } }, Math: Object.assign(Object.create(Math), { random: () => random }),
    setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout: id => timers.delete(id),
  });
  await settle();
  async function advance(ms) {
    const end = now + ms;
    for (let guard = 0; guard < 20000; guard++) {
      const nextTimer = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      const nextAlarm = [...alarms].sort((a, b) => a[1].at - b[1].at)[0];
      const timerAt = nextTimer?.[1].at ?? Infinity, alarmAt = nextAlarm?.[1].at ?? Infinity;
      if (Math.min(timerAt, alarmAt) > end) { now = end; await settle(); return; }
      now = Math.min(timerAt, alarmAt); wakeups++;
      if (timerAt <= alarmAt) { timers.delete(nextTimer[0]); await nextTimer[1].fn(); }
      else {
        const [name, alarm] = nextAlarm;
        if (alarm.period) alarm.at += alarm.period; else alarms.delete(name);
        await api.alarms.onAlarm.fire({ name });
      }
      await settle();
    }
    throw Error('unbounded wakeup loop');
  }
  const reconnect = async (sender = { id: 'fixture', url: api.runtime.getURL('sidepanel/index.html') }) => {
    let response;
    await api.runtime.onMessage.fire({ action: 'reconnect' }, sender, value => { response = value; });
    await settle(); return response;
  };
  return { api, runtime, stored, alarms, timers, ports, attempts, sent, advance, reconnect, now: () => now, reloads: () => reloads, wakeups: () => wakeups };
}

test('startup and early alarms honor persisted nextRetryAt; owner Connect retries immediately', async () => {
  const f = await fixture({ stored: { [KEY]: { attempts: 10, nextRetryAt: 1_600_000 } } });
  assert.equal(f.attempts.length, 0);
  await f.api.alarms.onAlarm.fire({ name: 'murage-reconnect' }); await settle();
  assert.equal(f.attempts.length, 0);
  await f.advance(599_999); assert.equal(f.attempts.length, 0);
  await f.reconnect(); assert.deepEqual(f.attempts, [1_599_999]);
  assert.equal(f.stored[KEY].attempts, 1);
});

test('worker restart preserves the backoff deadline and attempt count', async () => {
  const f = await fixture();
  const g = await fixture({ stored: f.stored, now: f.now() });
  assert.equal(g.attempts.length, 0);
  await g.advance(f.stored[KEY].nextRetryAt - g.now());
  assert.equal(g.attempts.length, 1); assert.equal(g.stored[KEY].attempts, 2);
});

test('mature jitter spreads profiles without shortening the ten-minute minimum', async () => {
  const deadlines = [];
  for (const random of [0, 0.5, 0.999]) {
    const f = await fixture({ random, stored: { [KEY]: { attempts: 10, nextRetryAt: 0 } } });
    const delay = f.stored[KEY].nextRetryAt - f.now();
    assert.ok(delay >= 600_000 && delay <= 720_000); deadlines.push(delay);
  }
  assert.equal(new Set(deadlines).size, 3);
});

test('a connected profile has no periodic reconnect wakeups', async () => {
  const f = await fixture({ absent: false });
  await f.advance(3_600_000);
  assert.equal(f.wakeups(), 0); assert.equal(f.attempts.length, 1);
});

test('app absent: record idle wakeups for one and two independent profiles after backoff', async t => {
  for (const profileCount of [1, 2]) {
    const measurements = [];
    const profiles = await Promise.all(Array.from({ length: profileCount }, (_, profile) => fixture({ random: profile ? 0.9 : 0.1 })));
    await Promise.all(profiles.map(f => f.advance(3_600_000))); // Warm the backoff from fresh profiles.
    const baseline = profiles.map(f => ({ attempts: f.attempts.length, wakeups: f.wakeups() }));
    await Promise.all(profiles.map(f => f.advance(3_600_000)));
    for (const [profile, f] of profiles.entries()) {
      assert.ok(f.attempts.length >= 10, 'automatic retries continue through the backoff ramp');
      measurements.push({ profile, attempts: f.attempts.length - baseline[profile].attempts, wakeups: f.wakeups() - baseline[profile].wakeups });
      assert.ok(measurements.at(-1).attempts <= 6);
      assert.ok(measurements.at(-1).wakeups <= 6);
      assert.equal(f.timers.size, 0, 'long backoff uses only the persisted alarm');
    }
    t.diagnostic(JSON.stringify({ app: 'absent', profiles: profileCount, windowMs: 3_600_000, measurements }));
  }
});

test('synchronous native host failure backs off and an untrusted sender cannot override it', async () => {
  const f = await fixture({ absent: 'throw' });
  assert.equal(f.attempts.length, 1);
  await f.reconnect({ id: 'page', url: 'https://example.test' });
  assert.equal(f.attempts.length, 1);
  await f.advance(f.stored[KEY].nextRetryAt - f.now());
  assert.equal(f.attempts.length, 2);
});

test('concurrent alarms and owner Connect open at most one native port', async () => {
  const f = await fixture({ absent: false });
  await f.ports[0].onDisconnect.fire();
  await Promise.all([f.reconnect(), f.reconnect(), f.api.alarms.onAlarm.fire({ name: 'murage-reconnect' })]);
  await settle(); assert.equal(f.attempts.length, 2);
});

test('failed durable disconnect blocks alarm, unlock and owner reconnect', async () => {
  const f = await fixture({ absent: false });
  f.runtime.connection = async () => { throw Error('fence failed'); };
  await f.ports[0].onDisconnect.fire();
  await f.api.alarms.onAlarm.fire({ name: 'murage-reconnect' });
  await f.api.idle.onStateChanged.fire('locked'); await f.api.idle.onStateChanged.fire('active');
  const response = await f.reconnect(); await settle();
  assert.equal(f.attempts.length, 1); assert.ok(response.error);
});

test('owner Connect waits for the durable disconnect fence', async () => {
  const f = await fixture({ absent: false });
  let release;
  f.runtime.connection = async value => {
    if (!value) await new Promise(resolve => { release = resolve; });
    return { type: 'hello' };
  };
  const disconnect = f.ports[0].onDisconnect.fire();
  const reconnect = f.reconnect(); await settle();
  assert.equal(f.attempts.length, 1);
  release(); await disconnect; await reconnect; await settle();
  assert.equal(f.attempts.length, 2);
});

test('a command waiting on retry persistence cannot run after its port disconnects', async () => {
  const f = await fixture({ absent: false });
  let release, handled = 0;
  const save = f.api.storage.local.set;
  f.api.storage.local.set = async value => {
    f.api.storage.local.set = save;
    await new Promise(resolve => { release = resolve; });
    await save(value);
  };
  f.runtime.handleRequest = async () => { handled++; return {}; };
  const command = f.ports[0].onMessage.fire({ type: 'command' }); await settle();
  const disconnected = f.ports[0].onDisconnect.fire();
  release(); await command; await disconnected;
  assert.equal(handled, 0);
});

test('persistence failure does not open a native port', async () => {
  const f = await fixture({ storageFails: true });
  assert.equal(f.attempts.length, 0);
  assert.ok((await f.reconnect()).error);
});

test('unlock while the app is absent honors backoff', async () => {
  const f = await fixture();
  await f.api.idle.onStateChanged.fire('locked'); await f.api.idle.onStateChanged.fire('active'); await settle();
  assert.equal(f.attempts.length, 1);
});

test('update reload uses busy, with a dedicated alarm while connected', async () => {
  let busy = true;
  const f = await fixture({ absent: false, busy: () => busy });
  await f.api.runtime.onUpdateAvailable.fire({}); await settle();
  assert.equal(f.reloads(), 0); assert.equal(f.sent[0].type, 'update_pending');
  busy = false; await f.advance(30_000);
  assert.equal(f.reloads(), 1);
});

test('missing, throwing or indeterminate busy hook defers update reload', async () => {
  for (const busy of [null, () => { throw Error('unknown'); }, () => undefined]) {
    const f = await fixture({ absent: false, busy });
    await f.api.runtime.onUpdateAvailable.fire({}); await settle(); await f.advance(60_000);
    assert.equal(f.reloads(), 0);
  }
});

test('manifest excludes incognito profiles and is version 1.0.0', () => {
  const manifest = JSON.parse(readFileSync(new URL('../extensions/murage-browser/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.incognito, 'not_allowed');
  assert.equal(manifest.version, '1.0.0');
});
