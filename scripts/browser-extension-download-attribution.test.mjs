// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { decide } from '../extensions/murage-browser/runtime.mjs';
import { fixture } from './browser-extension-test-fixture.mjs';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
// Ask cancellation now runs only after the three-second quiet grace.
const grace = () => vi.advanceTimersByTimeAsync(3000);
const url = 'https://allowed.test/export.csv';
const announce = (f, tabId) => f.runtime.debuggerEvent({ tabId }, 'Page.downloadWillBegin', { url, suggestedFilename: 'export.csv' });
const click = (f, tabId, bindingId, noLimits = false) => f.command('cdp', { tabId, navigationEpoch: 2, noLimits, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 } }, 1, bindingId);
async function ready() {
  const f = fixture({}, { downloadWaitMs: 1 });
  await f.init();
  expect(await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'], noLimits: true })).not.toHaveProperty('error');
  await f.navigate();
  await f.command('cdp', { tabId: 1, navigationEpoch: 2, method: 'Page.enable', noLimits: true });
  await f.bind('ask');
  f.tabs.get(2).url = 'https://allowed.test/page';
  await f.runtime.navigation({ tabId: 2, frameId: 0, url: f.tabs.get(2).url });
  await f.command('cdp', { tabId: 2, navigationEpoch: 2, method: 'Page.enable' }, 1, 'ask');
  await click(f, 2, 'ask');
  await announce(f, 2);
  expect(await click(f, 1, 'bot_a', true)).not.toHaveProperty('error');
  return f;
}
const untouched = f => {
  expect(f.api.downloads.cancel).not.toHaveBeenCalled();
  expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
  expect(f.api.downloads.erase).not.toHaveBeenCalled();
};

const eventOrders = [2000, 10000, 29000].flatMap(delay => ['created-first', 'changed-first'].map(order => ({ delay, order })));
async function deliver(f, item, order) {
  const search = f.api.downloads.search.getMockImplementation();
  f.api.downloads.search.mockImplementation(async query => query.id === item.id ? [item] : search(query));
  const changed = () => f.runtime.downloadChanged({ id: item.id, state: { current: item.state } });
  if (order === 'changed-first') await changed();
  await f.runtime.downloadCreated(item);
  if (order === 'created-first') await changed();
  expect(await f.runtime.downloadDetermining(item)).toBe(false);
  await changed();
}

it.each(eventOrders)('H2 a later Ask click sharing the owner referrer preserves the announced No limits download after $delay ms, $order', async ({ delay, order }) => {
  const f = await ready();
  await announce(f, 1);
  // Both tabs have the same page URL. This later click used to overwrite the
  // owner's referrer evidence before Chrome supplied a download without tabId.
  expect(await click(f, 2, 'ask')).not.toHaveProperty('error');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + delay);
  await deliver(f, { id: 201, url, referrer: 'https://allowed.test/page', state: 'complete', exists: true }, order);
  untouched(f);
});

it.each(eventOrders)('H2 conflicting binding evidence keeps the file and logs once after $delay ms, $order', async ({ delay, order }) => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await ready();
  // No owner URL announcement: the shared referrer itself must retain both
  // bindings, even after another Ask click. Neither arm owns this item.
  expect(await click(f, 2, 'ask')).not.toHaveProperty('error');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + delay);
  await deliver(f, { id: 202, url, referrer: 'https://allowed.test/page', state: 'complete', exists: true }, order);
  untouched(f);
  expect(log.mock.calls).toEqual([['Murage kept download 202: attribution does not permit cancellation.']]);
});

it.each([2000, 10000, 29000])('H2 an unambiguous Ask-only referrer still stops its own download after %i ms', async delay => {
  const f = fixture({}, { downloadWaitMs: 1 });
  await f.init(); await f.navigate();
  await f.command('cdp', { tabId: 1, navigationEpoch: 2, method: 'Page.enable' });
  expect(await click(f, 1, 'bot_a')).not.toHaveProperty('error');
  await announce(f, 1);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + delay);
  const item = { id: 203, url, referrer: 'https://allowed.test/page' };
  await f.runtime.downloadCreated(item);
  await grace();
  expect(await f.runtime.downloadDetermining(item)).toBe(false);
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(item.id);
  expect(f.api.downloads.removeFile).toHaveBeenCalledWith(item.id);
  expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: item.id });
});

it('H2 conflicting download URLs alone keep the file without needing a referrer', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await ready();
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'] });
  expect(await click(f, 1, 'bot_a')).not.toHaveProperty('error');
  await announce(f, 1);
  expect(await click(f, 2, 'ask')).not.toHaveProperty('error');
  await announce(f, 2);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 29000);
  await deliver(f, { id: 204, url, state: 'complete', exists: true }, 'changed-first');
  untouched(f);
  expect(log).toHaveBeenCalledExactlyOnceWith('Murage kept download 204: attribution does not permit cancellation.');
});

it('H2 referrer evidence survives another page action by the same binding for the arm lifetime', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await ready();
  expect(await f.command('cdp', { tabId: 1, navigationEpoch: 2, noLimits: true, method: 'Page.navigate', params: { url: 'https://allowed.test/other-page' } })).not.toHaveProperty('error');
  expect(await click(f, 2, 'ask')).not.toHaveProperty('error');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 29000);
  await deliver(f, { id: 205, url, referrer: 'https://allowed.test/page', state: 'complete', exists: true }, 'created-first');
  untouched(f);
  expect(log).toHaveBeenCalledExactlyOnceWith('Murage kept download 205: attribution does not permit cancellation.');
});

it('H2 expired evidence cannot make a fresh Ask-only download ambiguous', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await ready();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30001);
  expect(await click(f, 2, 'ask')).not.toHaveProperty('error');
  await announce(f, 2);
  await f.runtime.downloadCreated({ id: 206, url, referrer: 'https://allowed.test/page' });
  await grace();
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(206);
  expect(f.api.downloads.removeFile).toHaveBeenCalledWith(206);
  expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 206 });
  expect(log).not.toHaveBeenCalled();
});

it.each([0, 2000, 10000, 29000].flatMap(delay => ['tab', 'referrer'].map(source => ({ delay, source }))))('H1 owner download survives another Ask arm after $delay ms via $source, with either event order', async ({ delay, source }) => {
  for (const order of ['created-first', 'filename-first']) {
    const f = await ready();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + delay);
    const item = { id: 81, url, ...(source === 'tab' ? { tabId: 1 } : { referrer: 'https://allowed.test/page' }), state: 'complete', exists: true };
    if (order === 'created-first') await f.runtime.downloadCreated(item);
    expect(await f.runtime.downloadDetermining(item)).toBe(false);
    if (order === 'filename-first') await f.runtime.downloadCreated(item);
    await announce(f, 1);
    await f.runtime.downloadChanged({ id: item.id, state: { current: 'complete' } });
    untouched(f);
    clock.mockRestore();
  }
});

it.each(['referrer', 'url'])('H1 delayed download uses recorded %s attribution when Chrome supplies no tab', async match => {
  const f = await ready();
  if (match === 'url') { await announce(f, 1); await click(f, 2, 'ask'); }
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10000);
  const item = { id: 82, url, ...(match === 'referrer' ? { referrer: 'https://allowed.test/page' } : {}) };
  await f.runtime.downloadCreated(item);
  expect(await f.runtime.downloadDetermining(item)).toBe(false);
  untouched(f);
});

it('H1 the No limits announcement attributes its URL even after another binding navigates there', async () => {
  const f = await ready();
  expect(await f.command('cdp', { tabId: 2, navigationEpoch: 2, method: 'Page.navigate', params: { url } }, 1, 'ask')).not.toHaveProperty('error');
  await announce(f, 1);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10000);
  const item = { id: 90, url };
  await f.runtime.downloadCreated(item);
  expect(await f.runtime.downloadDetermining(item)).toBe(false);
  untouched(f);
});

it('H1 a later action in another tab cannot take an attributed owner download', async () => {
  const f = await ready();
  await f.runtime.downloadCreated({ id: 83, tabId: 1, url });
  await click(f, 2, 'ask');
  expect(await f.runtime.downloadDetermining({ id: 83, url })).toBe(false);
  await f.runtime.downloadChanged({ id: 83, state: { current: 'complete' } });
  untouched(f);
});

it('H1 onChanged can establish attribution before onCreated and the filename event', async () => {
  const f = await ready();
  const item = { id: 86, url, referrer: 'https://allowed.test/page', state: 'in_progress' };
  f.api.downloads.search.mockImplementation(async query => query.id === item.id ? [item] : []);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10000);
  await f.runtime.downloadChanged({ id: item.id, state: { current: 'in_progress' } });
  await click(f, 2, 'ask');
  await f.runtime.downloadCreated({ id: item.id, url });
  expect(await f.runtime.downloadDetermining({ id: item.id, url })).toBe(false);
  untouched(f);
});

it('H1 dispatch records a navigation destination before its synchronous download event', async () => {
  const f = await ready();
  const send = f.api.debugger.sendCommand.getMockImplementation();
  f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => {
    if (method === 'Page.navigate') {
      await f.runtime.downloadCreated({ id: 87, url: params.url });
      return {};
    }
    return send(source, method, params);
  });
  expect(await f.command('cdp', { tabId: 1, navigationEpoch: 2, noLimits: true, method: 'Page.navigate', params: { url } })).not.toHaveProperty('error');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 29000);
  expect(await f.runtime.downloadDetermining({ id: 87, url })).toBe(false);
  untouched(f);
});

it('H1 an Ask arm cannot cancel a download attributed to another Ask binding', async () => {
  const f = await ready();
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'] });
  expect(await click(f, 1, 'bot_a')).not.toHaveProperty('error');
  await f.runtime.downloadCreated({ id: 88, tabId: 1, url });
  expect(await f.runtime.downloadDetermining({ id: 88, url })).toBe(false);
  untouched(f);
});

it('H1 an action exemption survives a later binding downgrade', async () => {
  const f = await ready();
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'] });
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 29000);
  await f.runtime.downloadCreated({ id: 89, tabId: 1, url });
  expect(await f.runtime.downloadDetermining({ id: 89, url })).toBe(false);
  untouched(f);
});

it('H1 the Ask binding still cancels its own download even just after an owner click', async () => {
  const f = await ready();
  await f.runtime.downloadCreated({ id: 84, tabId: 2, url });
  await grace();
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(84);
  expect(f.api.downloads.removeFile).toHaveBeenCalledWith(84);
  expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 84 });
});

it('H1 an unambiguous Ask URL arm cancels without a tab or referrer', async () => {
  const f = await ready();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
  await f.runtime.downloadCreated({ id: 85, url });
  await grace();
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(85);
});

it('D1 a protected-origin bind persists and restarts without granting No limits authority', async () => {
  const f = fixture();
  await f.init();
  const result = await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test', 'https://vault.bitwarden.com'], noLimits: true });
  expect(result).not.toHaveProperty('error');
  // Chrome storage serializes the record; undefined fields do not survive.
  const stored = JSON.parse(JSON.stringify(f.stored));
  const persistedRecord = structuredClone(stored.murageBrowserState.bindings[0]);
  const restarted = fixture(stored);
  await restarted.runtime.initialize();
  await restarted.runtime.connection(true);
  const status = await restarted.command('status', {}, 2);
  expect(status).not.toHaveProperty('error');
  expect(status.result).toMatchObject({ state: 'paused', approvedOrigins: ['https://allowed.test'], tabs: [] });
  expect(stored).not.toHaveProperty('murageBrowserStateQuarantine');
  expect(persistedRecord.approvedOrigins).toEqual(['https://allowed.test']);
  expect(persistedRecord).not.toHaveProperty('noLimits');
  expect(await restarted.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://vault.bitwarden.com'] }, 2)).toMatchObject({ error: { code: 'human_handover' } });
});


it.each([2000, 10000, 29000].flatMap(delay => ['created-first', 'filename-first'].map(order => ({ delay, order }))))('R4 an announced owner exemption also protects an Ask-tab item at $delay ms ($order)', async ({ delay, order }) => {
  const f = await ready();
  await announce(f, 1);
  expect(await click(f, 2, 'ask')).not.toHaveProperty('error');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + delay);
  const item = { id: 91, url, referrer: 'https://allowed.test/page', state: 'complete', exists: true };
  if (order === 'created-first') await f.runtime.downloadCreated(item);
  expect(await f.runtime.downloadDetermining(item)).toBe(false);
  if (order === 'filename-first') await f.runtime.downloadCreated(item);
  await f.runtime.downloadChanged({ id: item.id, state: { current: 'complete' } });
  untouched(f);
  await f.runtime.downloadCreated({ ...item, id: 92, tabId: 2 });
  untouched(f);
});

it.each([2000, 10000, 29000])('R5 later owner announcement supersedes cached Ask URL attribution after %i ms', async delay => {
  const f = await ready();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + delay);
  const item = { id: 301, url, state: 'complete', exists: true };
  f.api.downloads.search.mockImplementation(async query => query.id === item.id ? [item] : []);
  await f.runtime.downloadChanged({ id: item.id, state: { current: 'complete' } });
  await announce(f, 1);
  await f.runtime.downloadCreated(item);
  expect(await f.runtime.downloadDetermining(item)).toBe(false);
  await f.runtime.downloadChanged({ id: item.id, state: { current: 'complete' } });
  untouched(f);
});
it('R5 distinct fresh announcements incur linear expiry work and retain competing evidence', async () => {
  const f = await ready();
  const clock = vi.spyOn(Date, 'now');
  const counts = [];
  for (let batch = 0; batch < 2; batch++) {
    clock.mockClear();
    for (let i = 0; i < 100; i++) await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { url: `https://allowed.test/burst-${batch}-${i}` });
    counts.push(clock.mock.calls.length);
  }
  expect(counts[1]).toBeLessThan(counts[0] * 1.25);
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  await click(f, 2, 'ask');
  clock.mockReturnValue(Date.now() + 29000);
  await deliver(f, { id: 302, url, referrer: 'https://allowed.test/page', state: 'complete', exists: true }, 'changed-first');
  untouched(f);
  expect(log).toHaveBeenCalledExactlyOnceWith('Murage kept download 302: attribution does not permit cancellation.');
});


function* permutations(values) {
  if (!values.length) { yield []; return; }
  for (let i = 0; i < values.length; i++) for (const rest of permutations(values.filter((_, j) => i !== j))) yield [values[i], ...rest];
}
const page = 'https://allowed.test/page';
const raw = (id, noLimits, kind, destination, tabId, referrer) => Object.freeze({
  binding: Object.freeze({ id, noLimits }), kind, url: destination, referrer, tabId, at: 1000,
});
const labels = ['Ask arm', 'NL click', 'NL announce', 'onChanged', 'onCreated', 'Ask tab click'];
const allOrders = [...permutations(labels)];
for (const delay of [2000, 29000]) {
  for (const scenario of ['owner URL', 'owner referrer', 'Ask ambiguity', 'Ask only']) {
    it(`R7 all 720 event orderings at ${delay} ms: ${scenario}`, () => {
      const ask = raw('ask', false, 'arm', url, 2);
      const owner = scenario !== 'Ask ambiguity';
      const evidence = {
        'Ask arm': ask,
        'NL click': raw('owner', owner, 'click', scenario === 'owner URL' ? url : page, 1),
        'NL announce': raw('owner', owner, 'announce', scenario === 'owner referrer' ? page : url, 1),
        'Ask tab click': raw('ask', false, 'click', page, 2),
      };
      const expected = scenario === 'Ask only' ? 'cancel:ask' : 'keep';
      for (const order of allOrders) {
        const events = [];
        let download = { id: 701 };
        for (const label of order) {
          if (label === 'onChanged') download = { ...download, url, referrer: page };
          else if (label === 'onCreated') download = { ...download, id: 701, url, tabId: 2 };
          else if (scenario !== 'Ask only' || !label.startsWith('NL')) events.push(evidence[label]);
        }
        const before = JSON.stringify(events);
        expect(decide(Object.freeze(download), Object.freeze(events), 1000 + delay), order.join(' -> ')).toBe(expected);
        expect(JSON.stringify(events)).toBe(before);
      }
    });
  }
}

it('R7 No limits URL announcement overrides concrete Ask tab attribution', async () => {
  const f = await ready();
  await announce(f, 1);
  const item = { id: 710, url, tabId: 2, state: 'complete', exists: true };
  await deliver(f, item, 'created-first');
  untouched(f);
});

it.each(['cancel', 'removeFile'])('R7 an owner announcement during %s prevents the next destructive step', async point => {
  const f = fixture({}, { downloadWaitMs: 1 });
  await f.init(); await f.navigate();
  await f.command('cdp', { tabId: 1, navigationEpoch: 2, method: 'Page.enable' });
  await click(f, 1, 'bot_a');
  await announce(f, 1);
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'], noLimits: true }, 1, 'owner');
  f.tabs.get(2).url = 'https://allowed.test/owner';
  await f.runtime.navigation({ tabId: 2, frameId: 0, url: f.tabs.get(2).url });
  await f.command('cdp', { tabId: 2, navigationEpoch: 2, method: 'Page.enable', noLimits: true }, 1, 'owner');
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const original = f.api.downloads[point].getMockImplementation();
  f.api.downloads[point].mockImplementation(async id => { entered(); await gate; return original(id); });
  const handling = f.runtime.downloadCreated({ id: 711, url, tabId: 1 });
  await started;
  const settled = f.downloadTestHooks.settled(711);
  await announce(f, 2);
  release(); await handling; await settled;
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(711);
  if (point === 'cancel') expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
  expect(f.api.downloads.erase).not.toHaveBeenCalled();
});

it('R7 ambiguity veto applies to an Ask tab even when no owner is No limits', () => {
  const events = [raw('ask', false, 'arm', url, 2), raw('ask', false, 'click', page, 2), raw('other', false, 'announce', url, 3)];
  expect(decide({ id: 712, url, tabId: 2 }, events, 3000)).toBe('keep');
});

it('R7 expired and future evidence grants no cancellation or exemption', () => {
  const arm = raw('ask', false, 'arm', url, 2);
  expect(decide({ url, tabId: 2 }, [arm], 31001)).toBe('keep');
  expect(decide({ url, tabId: 2 }, [arm], 999)).toBe('keep');
  expect(decide({ url, tabId: 2 }, [arm], 31000)).toBe('cancel:ask');
});

it.each([2000, 29000])('R7 a historical No limits click vetoes a same-binding Ask arm at %i ms', async delay => {
  const f = fixture({}, { downloadWaitMs: 1 });
  await f.init();
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'], noLimits: true });
  await f.navigate();
  await f.command('cdp', { tabId: 1, navigationEpoch: 2, method: 'Page.enable', noLimits: true });
  await click(f, 1, 'bot_a', true);
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'] });
  await announce(f, 1);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + delay);
  await deliver(f, { id: 713, url, referrer: page, tabId: 1 }, 'changed-first');
  untouched(f);
});

it('R7 an owner announcement between settle and the cancel microtask prevents cancellation', async () => {
  const f = await ready();
  const handling = f.runtime.downloadCreated({ id: 714, url, tabId: 2 });
  const settled = f.downloadTestHooks.settled(714);
  await announce(f, 1);
  await handling; await settled;
  untouched(f);
});

it('R7 pending completion rechecks a later owner exemption before removing the file', async () => {
  const f = await ready();
  let state = 'in_progress';
  const item = { id: 715, url, tabId: 2, exists: true };
  f.api.downloads.search.mockImplementation(async q => q.id === item.id ? [{ ...item, state }] : []);
  await f.runtime.downloadCreated({ ...item, state });
  await grace();
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(item.id);
  expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
  await announce(f, 1);
  state = 'complete';
  await f.runtime.downloadChanged({ id: item.id, state: { current: state } });
  expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
  expect(f.api.downloads.erase).not.toHaveBeenCalled();
});

it('R7 zero candidates keep an unrelated item and log one plain line', async () => {
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = fixture({}, { downloadWaitMs: 1 });
  await f.init(); await f.navigate();
  const item = { id: 716, url: 'https://unrelated.test/file' };
  await f.runtime.downloadCreated(item);
  expect(await f.runtime.downloadDetermining(item)).toBe(false);
  await f.runtime.downloadCreated(item);
  untouched(f);
  expect(log).toHaveBeenCalledExactlyOnceWith('Murage kept download 716: attribution does not permit cancellation.');
});


it('R7 a referrer learned during cancellation lookup survives an older lookup snapshot', async () => {
  const f = fixture({}, { downloadWaitMs: 1 });
  await f.init(); await f.navigate();
  await f.command('cdp', { tabId: 1, navigationEpoch: 2, method: 'Page.enable' });
  await click(f, 1, 'bot_a'); await announce(f, 1);
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'], noLimits: true }, 1, 'owner');
  const ownerPage = 'https://allowed.test/owner';
  f.tabs.get(2).url = ownerPage;
  await f.runtime.navigation({ tabId: 2, frameId: 0, url: ownerPage });
  await f.command('cdp', { tabId: 2, navigationEpoch: 2, method: 'Page.enable', noLimits: true }, 1, 'owner');
  await click(f, 2, 'owner', true);
  let entered, release, first = true;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.api.downloads.search.mockImplementation(async q => {
    if (q.id !== 717) return [];
    if (first) { first = false; entered(); await gate; }
    return [{ id: 717, state: 'complete', exists: true }];
  });
  const handling = f.runtime.downloadCreated({ id: 717, url, referrer: page, tabId: 1 });
  await started;
  const settled = f.downloadTestHooks.settled(717);
  await f.runtime.downloadChanged({ id: 717, referrer: { current: ownerPage } });
  release(); await handling; await settled;
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(717);
  expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
  expect(f.api.downloads.erase).not.toHaveBeenCalled();
});


it('R7 a unique Ask tab candidate uses its binding active arm', () => {
  const events = [raw('ask', false, 'arm', url), raw('ask', false, 'click', page, 2)];
  expect(decide({ id: 718, url: 'https://allowed.test/redirected.csv', tabId: 2 }, events, 3000)).toBe('cancel:ask');
});
