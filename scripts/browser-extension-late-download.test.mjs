// SPDX-License-Identifier: AGPL-3.0-or-later
// U37 (audit G05-3): what the bot is told about a page download matches what happened to it. B decision (1.0.6): a download the page
// announces only after the filename step let it through is never removed (it may be the owner's: Chrome does not say which tab started
// it); the bot is told it was kept. A download stopped at the filename step is cancelled and removed, and an item that is kept is never
// reported as blocked.
import { describe, it, expect, vi } from 'vitest';
import { fixture } from './browser-extension-test-fixture.mjs';

const ready = async (options = {}) => { const f = fixture({}, options); await f.init(); await f.navigate(); await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 }); return f; };
const page = { frameId: 'main-frame', guid: 'g9', url: 'https://allowed.test/late.zip', suggestedFilename: 'late.zip' };
const blockedNotices = f => f.events.filter(e => e.event === 'notice' && e.data?.kind === 'download_blocked');
const keptNotices = f => f.events.filter(e => e.event === 'notice' && e.data?.kind === 'download_kept');
const untouched = (f, id) => {
  expect(f.api.downloads.cancel).not.toHaveBeenCalledWith(id);
  expect(f.api.downloads.removeFile).not.toHaveBeenCalledWith(id);
  expect(f.api.downloads.erase).not.toHaveBeenCalledWith({ id });
};
// The item waits at the filename step (a bot action runs on an owned tab's site) and the page announces it meanwhile: stopped there.
const atFilenameStep = async (f, item, announced = page) => {
  const decided = f.runtime.downloadDetermining(item);
  await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', announced);
  return decided;
};

describe('a late page download leaves nothing saved when the bot is told it was blocked', () => {
  it('B decision: an announcement after the filename step let the item through never touches it, and the bot is told it was kept', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const item = { id: 31, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(item);
    expect(await f.runtime.downloadDetermining(item)).toBe(false);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 31);
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(1);
    expect(keptNotices(f)[0].data).toMatchObject({ tabId: 1, origin: 'https://allowed.test', name: 'late.zip' });
  });
  it('an announcement while the item waits at the filename step cancels it and removes its file', async () => {
    const f = await ready({ downloadWaitMs: 5000, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const item = { id: 34, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(item);
    expect(await atFilenameStep(f, item)).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(34);
    expect(f.api.downloads.removeFile).toHaveBeenCalledWith(34);
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 34 });
    // the file goes before its entry: erase first would leave nothing for removeFile to name
    expect(f.api.downloads.removeFile.mock.invocationCallOrder[0]).toBeLessThan(f.api.downloads.erase.mock.invocationCallOrder[0]);
    expect(blockedNotices(f)).toHaveLength(1);
    expect(keptNotices(f)).toHaveLength(0);
  });
  it('an item already seen that is kept (no bot action explains it) is not reported to the bot as blocked', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    await f.runtime.downloadCreated({ id: 32, url: page.url, finalUrl: page.url });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(f.api.downloads.cancel).not.toHaveBeenCalled();
    expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
  });
  it('an announcement before the item still reports the block and stops the item when it arrives', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(blockedNotices(f)).toHaveLength(1);
    await f.runtime.downloadCreated({ id: 33, url: page.url, finalUrl: page.url });
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(33);
  });
});

// U37 r2 (Grok H3): the bot is told a download was blocked only when nothing of it is left. A removal that fails keeps the shelf entry and
// says so; one still being written is removed when it finishes.
describe('a download that could not be removed is never reported as blocked', () => {
  // exists: what the browser reports. Like Chrome, a removeFile that resolves makes the file missing, unless `stays` says the file is
  // still there afterwards; `exists` overrides the report outright.
  // the item waits at the filename step and `announce` sends the page's announcement while it waits: the removal runs then
  const late = async (state, removeFile, error, { exists, stays = false } = {}) => {
    const f = await ready({ downloadWaitMs: 5000, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const item = { id: 61, url: page.url, finalUrl: page.url };
    let gone = false;
    const remove = removeFile ?? (async () => {});
    f.api.downloads.removeFile = vi.fn(async id => { await remove(id); if (!stays) gone = true; });
    f.api.downloads.search = vi.fn(async query => (query.id === 61 ? [{ ...item, state: state(), exists: exists ? exists() : !gone, ...(error ? { error: error() } : {}), startTime: new Date().toISOString() }] : []));
    await f.runtime.downloadCreated(item);
    f.announce = () => atFilenameStep(f, item);
    return f;
  };
  const notices = (f, kind) => f.events.filter(e => e.event === 'notice' && e.data?.kind === kind);

  it('a finished file that cannot be removed: no blocked notice, the shelf entry stays, and the bot is told the file may be kept', async () => {
    const f = await late(() => 'complete', vi.fn(async () => { throw new Error('file in use'); }));
    await f.announce();
    expect(f.api.downloads.removeFile).toHaveBeenCalledWith(61);
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
    expect(notices(f, 'download_kept')[0].data).toMatchObject({ tabId: 1, origin: 'https://allowed.test', name: 'late.zip' });
  });

  it('a download the cancel did not stop is removed once it completes, and only then reported as blocked', async () => {
    let state = 'in_progress';
    const f = await late(() => state);
    await f.announce();
    expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    state = 'complete';
    await f.runtime.downloadChanged({ id: 61, state: { previous: 'in_progress', current: 'complete' } });
    expect(f.api.downloads.removeFile).toHaveBeenCalledWith(61);
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 61 });
    expect(blockedNotices(f)).toHaveLength(1);
  });

  it('a retried removal that still fails is said as kept', async () => {
    let state = 'in_progress';
    const f = await late(() => state, vi.fn(async () => { throw new Error('file in use'); }));
    await f.announce();
    state = 'complete';
    await f.runtime.downloadChanged({ id: 61, state: { current: 'complete' } });
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });

  it('a download Murage cancelled whose partial file the browser has deleted: it is erased and reported as blocked without a removeFile', async () => {
    const f = await late(() => 'interrupted', undefined, () => 'USER_CANCELED', { exists: () => false });
    await f.announce();
    expect(f.api.downloads.removeFile).not.toHaveBeenCalled();
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 61 });
    expect(blockedNotices(f)).toHaveLength(1);
  });

  // Grok r3 High: Chrome deletes a cancelled partial file later, not at once. While it still reports the file, it is kept.
  it('a cancelled download whose partial file is still on disk is not reported as blocked, and its shelf entry stays', async () => {
    const f = await late(() => 'interrupted', vi.fn(async () => { throw new Error('must be complete'); }), () => 'USER_CANCELED', { exists: () => true });
    await f.announce();
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });

  it('a pending removal that ends cancelled with its partial file still on disk is said as kept', async () => {
    let state = 'in_progress';
    const f = await late(() => state, vi.fn(async () => { throw new Error('must be complete'); }), () => (state === 'interrupted' ? 'USER_CANCELED' : undefined), { exists: () => true });
    await f.announce();
    state = 'interrupted';
    await f.runtime.downloadChanged({ id: 61, state: { previous: 'in_progress', current: 'interrupted' } });
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });

  it('a removeFile that resolves while the browser still reports the file is not taken as removed', async () => {
    const f = await late(() => 'complete', undefined, undefined, { stays: true });
    await f.announce();
    expect(f.api.downloads.removeFile).toHaveBeenCalledWith(61);
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });

  // Grok r7 Low (decided for Grok): a removeFile that resolves with no fresh look to confirm it leaves the outcome unknown, said as kept
  it('a removeFile that resolves while the downloads list cannot answer afterwards is said as kept, and its shelf entry stays', async () => {
    const f = await late(() => 'complete');
    const search = f.api.downloads.search;
    f.api.downloads.removeFile = vi.fn(async () => { f.api.downloads.search = vi.fn(async () => { throw new Error('unavailable'); }); });
    await f.announce();
    expect(search).toHaveBeenCalled();
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });

  it('a removeFile that resolves while the downloads list no longer finds the item is said as kept', async () => {
    const f = await late(() => 'complete');
    f.api.downloads.removeFile = vi.fn(async () => { f.api.downloads.search = vi.fn(async () => []); });
    await f.announce();
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });

  it('a removeFile that fails while the downloads list cannot answer is said as kept', async () => {
    const f = await late(() => 'interrupted', undefined, () => 'USER_CANCELED', { exists: () => true });
    f.api.downloads.removeFile = vi.fn(async () => { f.api.downloads.search = vi.fn(async () => { throw new Error('unavailable'); }); throw new Error('must be complete'); });
    await f.announce();
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });

  // Grok r2 High: a resumable interrupt keeps its partial file on disk
  it('a download stopped by a network failure keeps its partial file: removeFile is tried, and when it fails the bot is told it was kept', async () => {
    const f = await late(() => 'interrupted', vi.fn(async () => { throw new Error('must be complete'); }), () => 'NETWORK_FAILED');
    await f.announce();
    expect(f.api.downloads.removeFile).toHaveBeenCalledWith(61);
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });

  it('a pending removal whose download ends in a network failure is not reported as blocked', async () => {
    let state = 'in_progress';
    const f = await late(() => state, vi.fn(async () => { throw new Error('must be complete'); }), () => (state === 'interrupted' ? 'NETWORK_FAILED' : undefined));
    await f.announce();
    state = 'interrupted';
    await f.runtime.downloadChanged({ id: 61, state: { previous: 'in_progress', current: 'interrupted' } });
    expect(f.api.downloads.erase).not.toHaveBeenCalled();
    expect(blockedNotices(f)).toHaveLength(0);
    expect(notices(f, 'download_kept')).toHaveLength(1);
  });
});

// U37 r2 (Grok H4): an item is remembered under both of its addresses, and a full memory never turns a block decision into "blocked"
// for an item that was never found.
describe('a late announcement finds its item by either address, and a full memory never fails open', () => {
  it('an announcement naming the redirected address (finalUrl) still cancels and removes the item', async () => {
    const f = await ready({ downloadWaitMs: 5000, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const redirected = { id: 71, url: 'https://allowed.test/go?file=late', finalUrl: page.url };
    await f.runtime.downloadCreated(redirected);
    expect(await atFilenameStep(f, redirected)).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(71);
    expect(f.api.downloads.removeFile).toHaveBeenCalledWith(71);
    expect(blockedNotices(f)).toHaveLength(1);
  });

  it('after the item was pushed out by 70 newer downloads, the announcement is not reported as blocked unless that item was removed', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    await f.runtime.downloadCreated({ id: 72, url: page.url, finalUrl: page.url });
    for (let i = 0; i < 70; i++) await f.runtime.downloadCreated({ id: 100 + i, url: `https://elsewhere.test/${i}.bin`, finalUrl: `https://elsewhere.test/${i}.bin` });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    const removed = f.api.downloads.removeFile.mock.calls.some(([id]) => id === 72);
    if (!removed) expect(blockedNotices(f)).toHaveLength(0);
    // and no other item was touched on its behalf
    expect(f.api.downloads.cancel.mock.calls.every(([id]) => id === 72)).toBe(true);
  });

  it('with the downloads list to ask, an item pushed out of memory is still found and reported as kept (never removed: B decision)', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const item = { id: 73, url: page.url, finalUrl: page.url, startTime: new Date().toISOString(), state: 'complete', exists: true };
    // the browser's search reads url and finalUrl as regular expressions
    // like Chrome, a removed file is reported missing afterwards
    f.api.downloads.removeFile = vi.fn(async () => { item.exists = false; });
    f.api.downloads.search = vi.fn(async query => (query.id === 73 || (query.url !== undefined && new RegExp(query.url).test(item.url)) || (query.finalUrl !== undefined && new RegExp(query.finalUrl).test(item.finalUrl)) ? [item] : []));
    await f.runtime.downloadCreated(item);
    await f.runtime.downloadDetermining(item);
    for (let i = 0; i < 70; i++) await f.runtime.downloadCreated({ id: 200 + i, url: `https://elsewhere.test/${i}.bin`, finalUrl: `https://elsewhere.test/${i}.bin` });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(f.api.downloads.search).toHaveBeenCalled();
    untouched(f, 73);
    expect(blockedNotices(f)).toHaveLength(0);
    // found: a miss the list could not answer would say nothing at all
    expect(keptNotices(f)).toHaveLength(1);
  });
});

// Grok r2 High: downloads.search reads url and finalUrl as regular expressions that can match part of an address
describe('a search for a late announcement\'s item matches that exact address only', () => {
  // the browser's search: a partial regular-expression match on either address
  const regexSearch = items => vi.fn(async query => items.filter(item => (query.id !== undefined ? item.id === query.id
    : query.url !== undefined ? new RegExp(query.url).test(item.url) : new RegExp(query.finalUrl).test(item.finalUrl))));
  const flood = async f => { for (let i = 0; i < 70; i++) await f.runtime.downloadCreated({ id: 300 + i, url: `https://elsewhere.test/${i}.bin`, finalUrl: `https://elsewhere.test/${i}.bin` }); };

  it('an address with ? and . still finds its own item after it was pushed out of memory (kept, never removed)', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const url = 'https://allowed.test/file.zip?id=1';
    const item = { id: 81, url, finalUrl: url, startTime: new Date().toISOString(), state: 'complete', exists: true };
    f.api.downloads.search = regexSearch([item]);
    f.api.downloads.removeFile = vi.fn(async () => { item.exists = false; });
    await f.runtime.downloadCreated(item);
    await f.runtime.downloadDetermining(item);
    await flood(f);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { ...page, url });
    untouched(f, 81);
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(1);
  });

  it('a short address never matches another download that starts with it, and the miss is not reported as blocked', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const other = { id: 82, url: 'https://allowed.test/account-export.csv', finalUrl: 'https://allowed.test/account-export.csv', startTime: new Date().toISOString(), state: 'complete', exists: true };
    f.api.downloads.search = regexSearch([other]);
    await f.runtime.downloadCreated({ id: 83, url: 'https://allowed.test/a', finalUrl: 'https://allowed.test/a' });
    await flood(f);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { ...page, url: 'https://allowed.test/a' });
    expect(f.api.downloads.cancel).not.toHaveBeenCalledWith(82);
    expect(f.api.downloads.removeFile).not.toHaveBeenCalledWith(82);
    expect(f.api.downloads.erase).not.toHaveBeenCalledWith({ id: 82 });
    expect(blockedNotices(f)).toHaveLength(0);
  });
});

// Grok r4 High: an announcement never removes a finished download the bot's action cannot explain (the owner's earlier copy at the same
// address); it waits for its own item instead.
describe('a late announcement leaves the owner\'s finished download with the same address alone', () => {
  it('the owner\'s finished file is not removed or erased, the bot is not told blocked, and the page\'s own new item is stopped when it arrives', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const owners = { id: 91, url: page.url, finalUrl: page.url, startTime: new Date().toISOString(), state: 'complete', exists: true };
    f.api.downloads.search = vi.fn(async query => (query.id === 91 ? [owners] : []));
    // seen before the bot's action: never let through by the filename step on the bot's behalf
    await f.runtime.downloadCreated(owners);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(f.api.downloads.cancel).not.toHaveBeenCalledWith(91);
    expect(f.api.downloads.removeFile).not.toHaveBeenCalledWith(91);
    expect(f.api.downloads.erase).not.toHaveBeenCalledWith({ id: 91 });
    expect(blockedNotices(f)).toHaveLength(0);
    // the page's own download then arrives at the filename step and is stopped before any file is written
    expect(await f.runtime.downloadDetermining({ id: 92, url: page.url, finalUrl: page.url })).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(92);
  });

  // Grok r7 Medium: a let-through while the bot was idle is the owner's; telling the bot it was kept would tell it what the owner downloaded
  it('the owner\'s download still being written, let through while the bot was idle, is not cancelled by a later announcement, and the bot is told nothing', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: 0 });
    await new Promise(resolve => setTimeout(resolve, 10));
    const owners = { id: 93, url: page.url, finalUrl: page.url, startTime: new Date().toISOString(), state: 'in_progress', exists: true };
    f.api.downloads.search = vi.fn(async query => (query.id === 93 ? [owners] : []));
    await f.runtime.downloadCreated(owners);
    // the bot is idle: the filename step lets it through at once
    expect(await f.runtime.downloadDetermining(owners)).toBe(false);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 93);
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(0);
    expect(f.events.filter(e => e.event === 'notice' && String(e.data?.kind).startsWith('download'))).toHaveLength(0);
  });

  it('when the downloads list cannot answer, an announcement is not reported as blocked', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    f.api.downloads.search = vi.fn(async () => { throw new Error('unavailable'); });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(blockedNotices(f)).toHaveLength(0);
  });
});

// B decision (1.0.6; Astra and Fable Highs on b70fba5ae): Murage never deletes a file it cannot attribute to the bot.
describe('a late announcement never removes a download it cannot attribute to the bot', () => {
  it('Astra: the owner\'s own download from the same site, let through by the filename step during bot activity, is never removed', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const owners = { id: 95, url: page.url, finalUrl: page.url, startTime: new Date().toISOString(), state: 'complete', exists: true };
    f.api.downloads.search = vi.fn(async query => (query.id === 95 ? [owners] : []));
    await f.runtime.downloadCreated(owners);
    // the owner's download reaches the filename step while the bot acts on that site; no announcement comes, so it is let through
    expect(await f.runtime.downloadDetermining(owners)).toBe(false);
    // then the bot's page announces a download with the same address
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 95);
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(1);
  });

  it('Fable: a bot download from another host (a CDN), let through at once, gets download_kept from a late announcement', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const cdn = 'https://cdn.example-files.test/late.zip';
    const item = { id: 96, url: cdn, finalUrl: cdn };
    await f.runtime.downloadCreated(item);
    // not an owned tab's site: the filename step answers at once
    expect(await f.runtime.downloadDetermining(item)).toBe(false);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { ...page, url: cdn });
    untouched(f, 96);
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(1);
  });

  it('filename-step blocks still work: an announced address stops its item at the filename step, before or while it waits', async () => {
    const f = await ready({ downloadWaitMs: 5000, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(blockedNotices(f)).toHaveLength(1);
    expect(await f.runtime.downloadDetermining({ id: 97, url: page.url, finalUrl: page.url })).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(97);
    const other = 'https://allowed.test/second.zip';
    const waiting = { id: 98, url: other, finalUrl: other };
    await f.runtime.downloadCreated(waiting);
    expect(await atFilenameStep(f, waiting, { ...page, url: other })).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(98);
    expect(keptNotices(f)).toHaveLength(0);
  });

  it('a kept item stays armed: the page\'s own new item with that address is still stopped at the filename step', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const first = { id: 99, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(first);
    await f.runtime.downloadDetermining(first);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 99);
    expect(await f.runtime.downloadDetermining({ id: 100, url: page.url, finalUrl: page.url })).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(100);
    // the bot heard kept once and is never told blocked afterwards for the same announcement
    expect(keptNotices(f)).toHaveLength(1);
    expect(blockedNotices(f)).toHaveLength(0);
  });

  it('Grok r6: after a kept item, a new item with that address (the owner retrying the link) is never removed at onCreated', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const first = { id: 110, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(first);
    await f.runtime.downloadDetermining(first);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    // onCreated fires before the filename step: a small file may already be written, so nothing is cancelled or removed here
    await f.runtime.downloadCreated({ id: 111, url: page.url, finalUrl: page.url });
    untouched(f, 110); untouched(f, 111);
    expect(blockedNotices(f)).toHaveLength(0);
  });

  it('Fable r6: a let-through item is reported kept once, not again for a second announcement of its address', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const item = { id: 112, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(item);
    await f.runtime.downloadDetermining(item);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 112);
    expect(keptNotices(f)).toHaveLength(1);
    expect(blockedNotices(f)).toHaveLength(0);
  });
});

// Final round (integrator decisions on Grok r7 and Astra r3).
describe('an address with a kept file is never reported as blocked', () => {
  const botTime = () => ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
  it('Grok r7 High: a newer item with the same address seen before the announcement does not hide the kept file; its removal is not said as blocked', async () => {
    const f = await botTime();
    const first = { id: 130, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(first);
    expect(await f.runtime.downloadDetermining(first)).toBe(false);
    // a second item with that address is seen first, so the announcement names it, not the kept one
    await f.runtime.downloadCreated({ id: 131, url: page.url, finalUrl: page.url });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(keptNotices(f)).toHaveLength(1);
    expect(await f.runtime.downloadDetermining({ id: 131, url: page.url, finalUrl: page.url })).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(131);
    untouched(f, 130);
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(1);
  });
  it('Grok r7 High: a second announcement after the kept notice re-arms the address, and a later removal is still not said as blocked', async () => {
    const f = await botTime();
    const first = { id: 132, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(first);
    await f.runtime.downloadDetermining(first);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(await f.runtime.downloadDetermining({ id: 133, url: page.url, finalUrl: page.url })).toBe(true);
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(133);
    untouched(f, 132);
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(1);
  });
  it('Astra r3 Medium: a popup announcement of a kept address tells the bot it was kept, once', async () => {
    const f = await botTime();
    const item = { id: 134, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(item);
    await f.runtime.downloadDetermining(item);
    f.events.length = 0;
    await f.runtime.navigationTarget({ tabId: 50, sourceTabId: 1, sourceFrameId: 0, url: page.url });
    expect(keptNotices(f)).toHaveLength(1);
    expect(keptNotices(f)[0].data).toMatchObject({ kind: 'download_kept', tabId: 1, origin: 'https://allowed.test', name: 'late.zip' });
    // the page's own announcement of the same address afterwards says nothing more
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 134);
    expect(keptNotices(f)).toHaveLength(1);
    expect(blockedNotices(f)).toHaveLength(0);
  });
  it('a popup whose first address has no item says nothing yet (it may still be a page)', async () => {
    const f = await botTime(); f.events.length = 0;
    await f.runtime.navigationTarget({ tabId: 51, sourceTabId: 1, sourceFrameId: 0, url: 'https://allowed.test/report' });
    expect(f.events.filter(e => e.event === 'notice' && String(e.data?.kind).startsWith('download'))).toHaveLength(0);
  });
});

// Astra r3 Low: the memory of let-through items is bounded by count and by time; losing an entry never deletes anything, and the address
// stays armed at the filename step. Final round (Grok r8 High, Astra r4 High, Fable r4 Low): many kept files inside 30 s never push a
// kept address out, so a later removal at that address is never said as blocked.
describe('the let-through memory is capped and expires without failing open', () => {
  for (const flood of [70, 1100]) {
    it(`after ${flood} newer let-throughs inside 30 s, the kept address is still kept: said once, and the next item's removal is not said as blocked`, async () => {
      const f = await ready({ downloadWaitMs: 1, downloadAfterMs: Number.MAX_SAFE_INTEGER });
      const item = { id: 140, url: page.url, finalUrl: page.url };
      await f.runtime.downloadCreated(item);
      await f.runtime.downloadDetermining(item);
      // only the let-through memory floods: the item itself is still found by its address
      for (let i = 0; i < flood; i++) await f.runtime.downloadDetermining({ id: 4000 + i, url: `https://elsewhere.test/${i}.bin`, finalUrl: `https://elsewhere.test/${i}.bin` });
      await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
      untouched(f, 140);
      expect(keptNotices(f)).toHaveLength(1);
      expect(await f.runtime.downloadDetermining({ id: 141, url: page.url, finalUrl: page.url })).toBe(true);
      expect(f.api.downloads.cancel).toHaveBeenCalledWith(141);
      expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 141 });
      untouched(f, 140);
      // the outcome after the removal path ran: item 140's file is still there, so nothing is said as blocked
      expect(blockedNotices(f)).toHaveLength(0);
      expect(keptNotices(f)).toHaveLength(1);
    });
  }
  it('Grok r9 High: 30 s after a let-through, its file is still found: said kept once, and the next item\'s removal is never said blocked', async () => {
    const f = await ready({ downloadWaitMs: 1, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const item = { id: 142, url: page.url, finalUrl: page.url };
      await f.runtime.downloadCreated(item);
      await f.runtime.downloadDetermining(item);
      await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
      expect(keptNotices(f)).toHaveLength(1);
      now += 120000;
      await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
      expect(await f.runtime.downloadDetermining({ id: 143, url: page.url, finalUrl: page.url })).toBe(true);
      expect(f.api.downloads.cancel).toHaveBeenCalledWith(143);
      expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 143 });
      untouched(f, 142);
      // asserted after the removal of 143 ran: item 142's file is still there
      expect(blockedNotices(f)).toHaveLength(0);
      expect(keptNotices(f)).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
});

// Final round (Astra r4 High and Medium, Fable r4 Lows): every way a file can stay on disk marks its address as kept; kept is said at most
// once per address, for every address of the item.
describe('a kept file is remembered by address however it came to stay', () => {
  const botTime = () => ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
  const failRemove = (f, ids) => { const remove = f.api.downloads.removeFile; f.api.downloads.removeFile = vi.fn(async id => { if (ids.includes(id)) throw new Error('file in use'); return remove(id); }); };
  it('Astra r4 High: a filename-step removal that fails keeps its address: a newer item hiding it and a later removal never say blocked', async () => {
    const f = await ready({ downloadWaitMs: 5000, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    failRemove(f, [150]);
    const first = { id: 150, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(first);
    expect(await atFilenameStep(f, first)).toBe(true);
    expect(keptNotices(f)).toHaveLength(1);
    // a newer item with that address is seen, so the next announcement names it, not the kept one
    const second = { id: 151, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(second);
    expect(await atFilenameStep(f, second)).toBe(true);
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 151 });
    expect(f.api.downloads.erase).not.toHaveBeenCalledWith({ id: 150 });
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(1);
  });
  // r10 (R3): once the pending removal succeeds nothing is left on disk, so the last word is blocked, said once, and never kept
  it('Astra r4 High: while a filename-step removal is still pending, a removal of a newer item with that address is not said as blocked', async () => {
    const f = await ready({ downloadWaitMs: 5000, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    let writing = true;
    const search = f.api.downloads.search;
    f.api.downloads.search = vi.fn(async query => (query?.id === 152 && writing ? [{ id: 152, state: 'in_progress', exists: true }] : search(query)));
    const first = { id: 152, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(first);
    expect(await atFilenameStep(f, first)).toBe(true);
    expect(f.api.downloads.removeFile).not.toHaveBeenCalledWith(152);
    const second = { id: 153, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(second);
    expect(await atFilenameStep(f, second)).toBe(true);
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 153 });
    // item 152 is still being written: its file is there, so nothing is said as blocked
    expect(blockedNotices(f)).toHaveLength(0);
    writing = false;
    await f.runtime.downloadChanged({ id: 152, state: { previous: 'in_progress', current: 'complete' } });
    expect(f.api.downloads.removeFile).toHaveBeenCalledWith(152);
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 152 });
    expect(blockedNotices(f)).toHaveLength(1);
    expect(keptNotices(f)).toHaveLength(0);
  });
  // r10 simpler design: kept is said once per file, so the let-through and the later file Murage could not remove are each said once
  for (const how of ['fails', 'is pending and then fails']) {
    it(`Astra r4 Medium: after a let-through was said kept, a later removal at that address that ${how} is said kept once for its own file, never blocked`, async () => {
      const f = await botTime();
      failRemove(f, [161]);
      let writing = how !== 'fails';
      const search = f.api.downloads.search;
      f.api.downloads.search = vi.fn(async query => (query?.id === 161 && writing ? [{ id: 161, state: 'in_progress', exists: true }] : search(query)));
      const first = { id: 160, url: page.url, finalUrl: page.url };
      await f.runtime.downloadCreated(first);
      expect(await f.runtime.downloadDetermining(first)).toBe(false);
      await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
      expect(keptNotices(f)).toHaveLength(1);
      const second = { id: 161, url: page.url, finalUrl: page.url };
      await f.runtime.downloadCreated(second);
      await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
      expect(await f.runtime.downloadDetermining(second)).toBe(true);
      if (writing) { writing = false; await f.runtime.downloadChanged({ id: 161, state: { previous: 'in_progress', current: 'complete' } }); }
      expect(f.api.downloads.removeFile).toHaveBeenCalledWith(161);
      expect(f.api.downloads.erase).not.toHaveBeenCalledWith({ id: 161 });
      untouched(f, 160);
      expect(keptNotices(f)).toHaveLength(2);
      expect(blockedNotices(f)).toHaveLength(0);
    });
  }
  it('Fable r4 Low: a redirected let-through is said kept once, whichever of its addresses the page announces', async () => {
    const f = await botTime();
    const start = 'https://allowed.test/get?file=late';
    const item = { id: 170, url: start, finalUrl: page.url };
    await f.runtime.downloadCreated(item);
    expect(await f.runtime.downloadDetermining(item)).toBe(false);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { ...page, url: start });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 170);
    expect(keptNotices(f)).toHaveLength(1);
    expect(blockedNotices(f)).toHaveLength(0);
  });
  it('Fable r4 Low: an item stopped at onCreated that still reaches the filename step is not counted as let through', async () => {
    const f = await botTime();
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(blockedNotices(f)).toHaveLength(1);
    const item = { id: 180, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(item);
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 180 });
    await f.runtime.downloadDetermining(item);
    // its file was removed: a later announcement of the address never claims a file may be there
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(keptNotices(f)).toHaveLength(0);
  });
});

// r10 simpler design: nothing remembers that a file is kept; the browser is asked, fresh and with no time cutoff, before any bot is told
// "nothing was saved", and only a file a bot's own action let through is ever said as kept, to that bot alone.
describe('the bot is told blocked only when the browser shows no file with that address', () => {
  const botTime = () => ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
  const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
  it('Astra r5 High: while an earlier removal at the address is still running and its file exists, a newer removal is not said blocked', async () => {
    const f = await ready({ downloadWaitMs: 5000, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    let writing = true; const gate = deferred();
    const search = f.api.downloads.search, remove = f.api.downloads.removeFile;
    f.api.downloads.search = vi.fn(async query => (query?.id === 190 && writing ? [{ id: 190, state: 'in_progress', exists: true }] : search(query)));
    f.api.downloads.removeFile = vi.fn(async id => { if (id === 190) await gate.promise; return remove(id); });
    const first = { id: 190, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(first);
    expect(await atFilenameStep(f, first)).toBe(true);
    writing = false;
    // 190's removal starts and hangs: its pending entry is already gone, its file is still on disk
    const finishing = f.runtime.downloadChanged({ id: 190, state: { previous: 'in_progress', current: 'complete' } });
    await new Promise(r => setTimeout(r, 0));
    expect(f.api.downloads.removeFile).toHaveBeenCalledWith(190);
    const second = { id: 191, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(second);
    expect(await atFilenameStep(f, second)).toBe(true);
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 191 });
    expect(blockedNotices(f)).toHaveLength(0);
    gate.resolve(); await finishing;
    // once 190 is gone too, the disk is clear and the block is said, once
    expect(blockedNotices(f)).toHaveLength(1);
    expect(keptNotices(f)).toHaveLength(0);
  });
  it('Grok r9 Low: a pending removal announced twice and then removed is never said kept; its last word is blocked', async () => {
    const f = await ready({ downloadWaitMs: 5000, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    let writing = true;
    const search = f.api.downloads.search;
    f.api.downloads.search = vi.fn(async query => (query?.id === 192 && writing ? [{ id: 192, state: 'in_progress', exists: true }] : search(query)));
    const item = { id: 192, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(item);
    expect(await atFilenameStep(f, item)).toBe(true);
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(keptNotices(f)).toHaveLength(0);
    expect(blockedNotices(f)).toHaveLength(0);
    writing = false;
    await f.runtime.downloadChanged({ id: 192, state: { previous: 'in_progress', current: 'complete' } });
    expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 192 });
    expect(keptNotices(f)).toHaveLength(0);
    expect(blockedNotices(f).length).toBeGreaterThanOrEqual(1);
    const last = f.events.filter(e => e.event === 'notice' && String(e.data?.kind).startsWith('download')).at(-1);
    expect(last.data.kind).toBe('download_blocked');
  });
  it('Astra r5 Medium: an idle owner download redirected to the announced address is never mentioned, even beside a bot let-through', async () => {
    const f = await botTime();
    const start = 'https://allowed.test/get?file=late';
    // the bot's own let-through at the first address, never announced
    const bots = { id: 193, url: start, finalUrl: start };
    await f.runtime.downloadCreated(bots);
    expect(await f.runtime.downloadDetermining(bots)).toBe(false);
    // the owner's idle download: first address -> the announced address
    const owners = { id: 194, url: start, finalUrl: page.url };
    f.api.downloads.search = vi.fn(async query => (query?.id === 194 || query?.finalUrl === page.url ? [{ ...owners, state: 'complete', exists: true }] : query?.id === 193 ? [{ ...bots, state: 'complete', exists: true }] : []));
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 193); untouched(f, 194);
    expect(keptNotices(f)).toHaveLength(0);
    expect(blockedNotices(f)).toHaveLength(0);
  });
  it('Grok r9 Medium: a file one bot\'s action let through is never said to another bot', async () => {
    const f = await botTime();
    await f.bind('bot_b');
    const opened = await f.command('tab_new', {}, 1, 'bot_b');
    const tabB = opened.result?.selectedTabId ?? opened.selectedTabId;
    // bot_b's action is the last one: its let-through belongs to bot_b
    const tab = (opened.result ?? opened).tabs.find(t => t.tabId === tabB);
    await f.command('cdp', { method: 'Page.enable', tabId: tabB, navigationEpoch: tab.navigationEpoch }, 1, 'bot_b');
    const item = { id: 195, url: page.url, finalUrl: page.url };
    await f.runtime.downloadCreated(item);
    expect(await f.runtime.downloadDetermining(item)).toBe(false);
    // bot_a's page announces the same address: bot_a hears nothing about bot_b's file
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 195);
    expect(keptNotices(f).filter(e => e.bindingId === 'bot_a')).toHaveLength(0);
    expect(blockedNotices(f)).toHaveLength(0);
  });
});


// Astra r10 High: an item Murage saw whose history row is gone while its file stays is never forgotten into a "blocked": once its
// address is pushed out of the bounded memory, an empty look there is unknown and says nothing.
describe('a seen item pushed out of memory is never read as nothing on disk', () => {
  it('after 1100 other addresses, an owner file at the address whose history row is gone is not said as blocked', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    const search = f.api.downloads.search;
    f.api.downloads.search = vi.fn(async query => (query?.id === 900 ? [] : search(query)));
    await f.runtime.downloadCreated({ id: 900, url: page.url, finalUrl: page.url });
    for (let i = 0; i < 1100; i++) await f.runtime.downloadCreated({ id: 5000 + i, url: `https://elsewhere.test/${i}.bin`, finalUrl: `https://elsewhere.test/${i}.bin` });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    untouched(f, 900);
    expect(blockedNotices(f)).toHaveLength(0);
    expect(keptNotices(f)).toHaveLength(0);
  });
  it('an address never seen still says blocked after the memory filled', async () => {
    const f = await ready({ downloadWaitMs: 20, downloadAfterMs: Number.MAX_SAFE_INTEGER });
    for (let i = 0; i < 1100; i++) await f.runtime.downloadCreated({ id: 5000 + i, url: `https://elsewhere.test/${i}.bin`, finalUrl: `https://elsewhere.test/${i}.bin` });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    expect(blockedNotices(f)).toHaveLength(1);
  });
});
