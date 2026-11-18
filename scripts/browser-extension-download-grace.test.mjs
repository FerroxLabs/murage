// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { fixture } from './browser-extension-test-fixture.mjs';

const url = 'https://allowed.test/export.csv', page = 'https://allowed.test/ask', ownerPage = 'https://allowed.test/owner';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const announce = (f, tabId, address = url) => f.runtime.debuggerEvent({ tabId }, 'Page.downloadWillBegin', { url: address, suggestedFilename: 'export.csv' });
const click = (f, tabId, bindingId, noLimits = false) => f.command('cdp', { tabId, navigationEpoch: 2, noLimits, method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 } }, 1, bindingId);
async function ready() {
  const f = fixture({}, { downloadWaitMs: 1 });
  await f.init();
  f.tabs.get(1).url = page;
  await f.runtime.navigation({ tabId: 1, frameId: 0, url: page });
  await f.command('cdp', { tabId: 1, navigationEpoch: 2, method: 'Page.enable' });
  await click(f, 1, 'bot_a');
  await f.command('bind', { profileId: 'profile_1', botName: 'Owner', approvedOrigins: ['https://allowed.test'], noLimits: true }, 1, 'owner');
  f.tabs.get(2).url = ownerPage;
  await f.runtime.navigation({ tabId: 2, frameId: 0, url: ownerPage });
  await f.command('cdp', { tabId: 2, navigationEpoch: 2, method: 'Page.enable', noLimits: true }, 1, 'owner');
  await click(f, 2, 'owner', true);
  return f;
}
function untouched(f) {
  expect(f.api.downloads.cancel).not.toHaveBeenCalled();
  expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
  expect(f.api.downloads.erase).not.toHaveBeenCalled();
}
function* permutations(values) {
  if (!values.length) { yield []; return; }
  for (let i = 0; i < values.length; i++) for (const tail of permutations(values.filter((_, n) => n !== i))) yield [values[i], ...tail];
}
for (const delay of [2000, 29000]) for (const evidence of ['URL announcement', 'newer owner referrer']) {
  it(`R8 runtime destructive outcomes: all 120 callback permutations at ${delay} ms, ${evidence}`, async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const order of permutations(['arm', 'created', 'changed', 'announce', 'stale lookup'])) {
      vi.setSystemTime(100000);
      const f = await ready();
      const item = { id: 801, url, referrer: page, tabId: 1, state: 'complete', exists: true };
      let release, first = true;
      const gate = new Promise(resolve => { release = resolve; });
      f.api.downloads.search.mockImplementation(async q => {
        if (q.id !== item.id) return [];
        if (first) { first = false; await gate; }
        // Explicitly conflicting old referrer, the H2 review repro.
        return [{ ...item }];
      });
      const lookup = f.runtime.downloadChanged({ id: item.id, url: { current: url } });
      await vi.advanceTimersByTimeAsync(delay);
      for (const label of order) {
        if (label === 'arm') await announce(f, 1);
        if (label === 'created') await f.runtime.downloadCreated(item);
        if (label === 'changed') await f.runtime.downloadChanged({ id: item.id, referrer: { current: evidence === 'newer owner referrer' ? ownerPage : page } });
        if (label === 'announce') await announce(f, 2, evidence === 'URL announcement' ? url : 'https://allowed.test/unrelated.csv');
        if (label === 'stale lookup') { release(); await lookup; }
        untouched(f);
      }
      await vi.advanceTimersByTimeAsync(3001);
      untouched(f);
      if (f.api.downloads.pause.mock.calls.length) expect(f.api.downloads.resume).toHaveBeenCalledWith(item.id);
      vi.clearAllTimers();
    }
  }, 30000);
}
it.each([2000, 29000])('R8 Ask-only pauses without destroying, then cancels and removes at the capped grace point (%i ms)', async delay => {
  vi.useFakeTimers();
  const f = await ready(); await announce(f, 1);
  await vi.advanceTimersByTimeAsync(delay);
  await f.runtime.downloadCreated({ id: 802, url, tabId: 1 });
  expect(f.api.downloads.pause).toHaveBeenCalledWith(802); untouched(f);
  const remaining = Math.min(3000, 30000 - delay);
  await vi.advanceTimersByTimeAsync(remaining - 1); untouched(f);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(802);
  expect(f.api.downloads.removeFile).toHaveBeenCalledWith(802);
  expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 802 });
});
it('R8 each related event extends the quiet grace, unrelated events do not', async () => {
  vi.useFakeTimers(); const f = await ready(); await announce(f, 1);
  await f.runtime.downloadCreated({ id: 803, url, tabId: 1 });
  await vi.advanceTimersByTimeAsync(2000);
  await f.runtime.downloadChanged({ id: 803, url: { current: url } });
  await vi.advanceTimersByTimeAsync(2999); untouched(f);
  await announce(f, 2, 'https://other.test/unrelated');
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(803);
});
it.each([2000, 29000])('R8 a related owner announcement after onCreated resumes immediately (%i ms)', async delay => {
  vi.useFakeTimers(); const f = await ready(); await announce(f, 1);
  await vi.advanceTimersByTimeAsync(delay);
  await f.runtime.downloadChanged({ id: 804, url: { current: url } });
  await f.runtime.downloadCreated({ id: 804, url, tabId: 1 });
  untouched(f);
  await announce(f, 2); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.downloads.resume).toHaveBeenCalledWith(804);
  await vi.advanceTimersByTimeAsync(30000); untouched(f);
});
it('R8 without pause the filename callback holds until grace', async () => {
  vi.useFakeTimers(); const f = await ready(); delete f.api.downloads.pause;
  await announce(f, 1);
  let answered = false;
  const filename = f.runtime.downloadDetermining({ id: 805, url, tabId: 1 }).then(result => { answered = true; return result; });
  await vi.advanceTimersByTimeAsync(2999); expect(answered).toBe(false); untouched(f);
  await vi.advanceTimersByTimeAsync(1); expect(await filename).toBe(true);
  expect(f.api.downloads.removeFile).toHaveBeenCalledWith(805);
});
it('R8 runtime uses the binding arm for a redirect even after 64 newer URL arms', async () => {
  vi.useFakeTimers(); const f = await ready(); await announce(f, 1);
  for (let i = 0; i < 65; i++) await announce(f, 1, `https://allowed.test/${i}.csv`);
  await f.runtime.downloadCreated({ id: 806, url: 'https://allowed.test/redirected.csv', tabId: 1 });
  untouched(f); await vi.advanceTimersByTimeAsync(3000);
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(806);
  expect(f.api.downloads.removeFile).toHaveBeenCalledWith(806);
});

it('R8 an anonymous simultaneous No limits download stays ambiguous after grace', async () => {
  vi.useFakeTimers(); const f = await ready(); await announce(f, 1);
  const item = { id: 807, url };
  await f.runtime.downloadCreated(item);
  expect(await f.runtime.downloadDetermining(item)).toBe(false);
  await vi.advanceTimersByTimeAsync(30000); untouched(f);
});
it.each(['tab', 'referrer'])('R8 concrete Ask %s evidence still pauses and cancels during a current unrelated No limits click', async source => {
  vi.useFakeTimers(); const f = await ready(); await announce(f, 1);
  await f.runtime.downloadCreated({ id: 808, url, ...(source === 'tab' ? { tabId: 1 } : { referrer: page }) });
  expect(f.api.downloads.pause).toHaveBeenCalledWith(808); untouched(f);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(808);
  expect(f.api.downloads.removeFile).toHaveBeenCalledWith(808);
});

it.each(['URL', 'referrer', 'redirect fallback'])('R10 arm B at 29 s keeps its grace past old arm A expiry via %s', async source => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const f = await ready();
  await announce(f, 1, 'https://allowed.test/old.csv');
  await vi.advanceTimersByTimeAsync(29000);
  expect(await f.command('cdp', { tabId: 2, navigationEpoch: 2, method: 'Page.enable', noLimits: true }, 1, 'owner')).not.toHaveProperty('error');
  await announce(f, 1);
  const item = { id: 810, url: source === 'URL' ? url : 'https://allowed.test/redirect.csv',
    ...(source === 'referrer' ? { referrer: url } : source === 'URL' ? { tabId: 1 } : {}) };
  if (source === 'redirect fallback') expect(await f.command('cdp', { tabId: 1, navigationEpoch: 2, method: 'Page.navigate', params: { url: item.url } })).not.toHaveProperty('error');
  await f.runtime.downloadCreated(item);
  const settled = f.downloadTestHooks.settled(item.id);
  expect(f.downloadTestHooks.deadline(item.id)).toBe(132000);
  await vi.advanceTimersByTimeAsync(1500);
  untouched(f);
  await announce(f, 2, item.url);
  await settled;
  expect(f.api.downloads.resume).toHaveBeenCalledWith(item.id);
  await vi.advanceTimersByTimeAsync(30000);
  untouched(f);
});

it('R10 all matching arms contribute their own capped deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const f = await ready(); await announce(f, 1);
  await vi.advanceTimersByTimeAsync(29000);
  await announce(f, 1);
  await f.runtime.downloadCreated({ id: 811, url, tabId: 1 });
  expect(f.downloadTestHooks.deadline(811)).toBe(132000);
  await vi.advanceTimersByTimeAsync(2999); untouched(f);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(811);
  expect(f.api.downloads.removeFile).toHaveBeenCalledWith(811);
  expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 811 });
});

it('R10 a newer unrelated arm cannot extend an older matching arm', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const f = await ready(); await announce(f, 1);
  await vi.advanceTimersByTimeAsync(29000);
  await f.runtime.navigationTarget({ tabId: 77, sourceTabId: 1, url: 'https://allowed.test/unrelated.csv' });
  await f.runtime.downloadCreated({ id: 812, url, tabId: 1 });
  expect(f.downloadTestHooks.deadline(812)).toBe(130000);
  await vi.advanceTimersByTimeAsync(999); untouched(f);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.api.downloads.cancel).toHaveBeenCalledWith(812);
});

for (const evidence of ['URL announcement', 'newer owner referrer']) {
  it(`R10 all 120 staggered callback permutations against an arm aged 28 s: ${evidence}`, async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const order of permutations(['created', 'changed', 'announce', 'stale lookup', 'Ask click'])) {
      vi.setSystemTime(100000);
      const f = await ready(); await announce(f, 1);
      const item = { id: 813, url, referrer: page, tabId: 1, state: 'complete', exists: true };
      let release, first = true;
      const gate = new Promise(resolve => { release = resolve; });
      f.api.downloads.search.mockImplementation(async q => {
        if (q.id !== item.id) return [];
        if (first) { first = false; await gate; }
        return [{ ...item }];
      });
      const lookup = f.runtime.downloadChanged({ id: item.id, url: { current: url } });
      await vi.advanceTimersByTimeAsync(28000);
      for (const label of order) {
        if (label === 'created') await f.runtime.downloadCreated(item);
        if (label === 'changed') await f.runtime.downloadChanged({ id: item.id, referrer: { current: evidence === 'newer owner referrer' ? ownerPage : page } });
        if (label === 'announce') await announce(f, 2, evidence === 'URL announcement' ? url : 'https://allowed.test/unrelated.csv');
        if (label === 'stale lookup') { release(); await lookup; }
        if (label === 'Ask click') await click(f, 1, 'bot_a');
        await vi.advanceTimersByTimeAsync(200);
        untouched(f);
      }
      await vi.advanceTimersByTimeAsync(4000);
      await f.downloadTestHooks.settled(item.id);
      untouched(f);
      if (f.api.downloads.pause.mock.calls.length) expect(f.api.downloads.resume).toHaveBeenCalledWith(item.id);
      vi.clearAllTimers();
    }
  }, 30000);
}

it('R10 keep retries a rejected resume once before settling', async () => {
  vi.useFakeTimers(); const f = await ready(); await announce(f, 1);
  f.api.downloads.resume.mockRejectedValueOnce(new Error('temporary resume failure'));
  await f.runtime.downloadCreated({ id: 814, url, tabId: 1 });
  const settled = f.downloadTestHooks.settled(814);
  await announce(f, 2); await settled;
  expect(f.api.downloads.resume).toHaveBeenCalledTimes(2);
  expect(f.downloadTestHooks.hasHold(814)).toBe(false);
  await vi.advanceTimersByTimeAsync(30000); untouched(f);
});

it('R10 repeated resume failures log once and retain a hold for later recovery', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await ready(); await announce(f, 1);
  f.api.downloads.resume.mockRejectedValue(new Error('resume unavailable'));
  await f.runtime.downloadCreated({ id: 815, url, tabId: 1 });
  const settled = f.downloadTestHooks.settled(815);
  await announce(f, 2); await settled;
  expect(f.api.downloads.resume).toHaveBeenCalledTimes(2);
  expect(f.downloadTestHooks.hasHold(815)).toBe(true);
  await f.runtime.downloadCreated({ id: 815, url, tabId: 1 });
  await f.downloadTestHooks.settled(815);
  expect(f.api.downloads.resume).toHaveBeenCalledTimes(4);
  expect(f.downloadTestHooks.hasHold(815)).toBe(true);
  expect(log.mock.calls.filter(([line]) => line.includes('could not resume'))).toEqual([
    ['Murage could not resume download 815; it remains paused and will be retried.'],
  ]);
  // Recovery still works after the original arm and its exemption expire.
  await vi.advanceTimersByTimeAsync(35001);
  f.api.downloads.resume.mockResolvedValue(undefined);
  await f.runtime.downloadCreated({ id: 815, url, tabId: 1 });
  await f.downloadTestHooks.settled(815);
  expect(f.downloadTestHooks.hasHold(815)).toBe(false);
  expect(f.api.downloads.resume).toHaveBeenCalledTimes(5);
  untouched(f);
});

it('R10 resume waits for an outstanding pause and full settlement waits for resume', async () => {
  vi.useFakeTimers(); const f = await ready(); await announce(f, 1);
  let releasePause, releaseResume;
  f.api.downloads.pause.mockImplementation(() => new Promise(resolve => { releasePause = resolve; }));
  f.api.downloads.resume.mockImplementation(() => new Promise(resolve => { releaseResume = resolve; }));
  await f.runtime.downloadCreated({ id: 816, url, tabId: 1 });
  let settled = false;
  const settlement = f.downloadTestHooks.settled(816).then(() => { settled = true; });
  await announce(f, 2);
  expect(f.api.downloads.resume).not.toHaveBeenCalled(); expect(settled).toBe(false);
  releasePause(); await vi.advanceTimersByTimeAsync(0);
  expect(f.api.downloads.resume).toHaveBeenCalledWith(816); expect(settled).toBe(false);
  releaseResume(); await settlement;
  expect(settled).toBe(true); untouched(f);
});

it('R10 repeated lookups expire individual observations after the longest arm lifetime plus 5 s', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const f = await ready();
  await f.runtime.downloadCreated({ id: 817, url: 'https://other.test/file', referrer: ownerPage });
  await vi.advanceTimersByTimeAsync(35000);
  await f.runtime.downloadChanged({ id: 817, state: { current: 'in_progress' } });
  expect(f.downloadTestHooks.observations(817).some(e => e.referrer === ownerPage)).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  await f.runtime.downloadChanged({ id: 817, state: { current: 'in_progress' } });
  expect(f.downloadTestHooks.observations(817).some(e => e.referrer === ownerPage)).toBe(false);
  const cutoff = Date.now() - 35000;
  expect(f.downloadTestHooks.observations(817).every(e => e.at >= cutoff)).toBe(true);
  untouched(f);
});

it('R10 old arm cannot cancel B before a late owner veto at 30.5 s', async () => {
  vi.useFakeTimers(); vi.setSystemTime(100000);
  const f = await ready(); await announce(f, 1, 'https://allowed.test/old.csv');
  await vi.advanceTimersByTimeAsync(29000);
  await click(f, 2, 'owner', true);
  await announce(f, 1);
  await f.runtime.downloadCreated({ id: 818, url, tabId: 1 });
  await vi.advanceTimersByTimeAsync(1500);
  untouched(f);
  await announce(f, 2);
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.api.downloads.resume).toHaveBeenCalledWith(818);
  untouched(f);
});

it('R10 deadline keep also retries resume and retains the hold on failure', async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const f = await ready(); await announce(f, 1);
  let releasePause;
  f.api.downloads.pause.mockImplementation(() => new Promise(resolve => { releasePause = resolve; }));
  f.api.downloads.resume.mockRejectedValue(new Error('resume unavailable'));
  await f.runtime.downloadCreated({ id: 819, url, tabId: 1 });
  const settled = f.downloadTestHooks.settled(819);
  await vi.advanceTimersByTimeAsync(3000);
  await announce(f, 2);
  releasePause(); await settled;
  expect(f.api.downloads.resume).toHaveBeenCalledTimes(2);
  expect(f.downloadTestHooks.hasHold(819)).toBe(true);
  expect(log.mock.calls.filter(([line]) => line.includes('could not resume'))).toHaveLength(1);
  f.api.downloads.resume.mockResolvedValue(undefined);
  await f.runtime.downloadCreated({ id: 819, url, tabId: 1 });
  await f.downloadTestHooks.settled(819);
  expect(f.downloadTestHooks.hasHold(819)).toBe(false);
  untouched(f);
});
