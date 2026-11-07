// SPDX-License-Identifier: AGPL-3.0-or-later
// SABLE-B r8 (design 5.6 "Popup adoption", row 21, test 50 and its in-flight case). A popup the PAGE opens is adopted only when its
// first URL's origin is in the approved set (base, PIN). r8's one extension change: the adoption re-checks connected, active, ready and
// the generation it checked, in the same synchronous block that inserts the tab, so an adoption held at tabs.get while a Pause or a
// disconnect lands is reported not adopted (FAILS on base: base inserts the tab after the Pause).
import { describe, it, expect } from 'vitest';
import { fixture } from './browser-extension-test-fixture.mjs';

const ready = async () => { const f = fixture(); await f.init(); await f.navigate(); return f; };
const tabIds = async f => (await f.command('status')).result.tabs.map(t => t.tabId);
const generation = async f => (await f.command('status')).result.generation;
const notice = f => f.events.find(e => e.event === 'notice' && e.data?.kind === 'tab_opened')?.data;
/** The page in tab 1 opens tab `id` at `url` (webNavigation names tab 1 as the source), then the new tab shows its first page. */
const popup = async (f, id, url) => {
  f.tabs.set(id, { id, url: 'about:blank' });
  await f.runtime.navigationTarget({ tabId: id, sourceTabId: 1, sourceFrameId: 0, url });
  f.tabs.get(id).url = url;
  return f.runtime.navigation({ tabId: id, frameId: 0, url });
};
/** Hold api.tabs.get for one tab id until released. */
const holdGet = (f, id) => {
  const real = f.api.tabs.get.getMockImplementation(); let release; const held = new Promise(resolve => { release = resolve; }); let reached;
  const arrived = new Promise(resolve => { reached = resolve; });
  f.api.tabs.get.mockImplementation(async tabId => { if (tabId === id) { reached(); await held; } return real(tabId); });
  return { arrived, release: () => release() };
};

describe('SABLE-B test 50: page popups are adopted by approved origin only (PIN)', () => {
  it('a popup to an approved origin is adopted', async () => {
    const f = await ready(); f.events.length = 0;
    await popup(f, 5, 'https://allowed.test/oauth');
    expect(await tabIds(f)).toEqual([1, 5]);
    expect(notice(f)).toMatchObject({ kind: 'tab_opened', tabId: 5, adopted: true });
  });
  it('a popup to another origin is not adopted', async () => {
    const f = await ready(); f.events.length = 0;
    await popup(f, 6, 'https://denied.test/x');
    expect(await tabIds(f)).toEqual([1]);
    expect(notice(f)).toMatchObject({ kind: 'tab_opened', tabId: 6, adopted: false });
  });
  it('a popup to an origin the last bind dropped is not adopted', async () => {
    const f = await ready(); f.events.length = 0;
    await f.command('bind', { profileId: 'profile_1', botName: 'bot_a', approvedOrigins: [] }, await generation(f));
    await popup(f, 7, 'https://allowed.test/oauth');
    expect(await tabIds(f)).toEqual([1]);
    expect(notice(f)).toMatchObject({ kind: 'tab_opened', tabId: 7, adopted: false });
  });
});

describe('SABLE-B r8: an adoption in flight when the binding stops being ready is not adopted (FAILS on base)', () => {
  it('a Pause that lands while the adoption waits at tabs.get: the tab is not inserted, adopted false', async () => {
    const f = await ready(); f.events.length = 0;
    const hold = holdGet(f, 8);
    const opening = popup(f, 8, 'https://allowed.test/oauth');
    await hold.arrived;
    const paused = await f.command('pause', { reason: 'handoff', handoff: 'Your turn.' }, await generation(f));
    expect(paused.result.state).toBe('paused');
    hold.release(); await opening;
    expect((await f.command('status')).result.tabs.map(t => t.tabId)).toEqual([1]);
    expect(notice(f)).toMatchObject({ kind: 'tab_opened', tabId: 8, adopted: false });
  });
  it('a disconnect that lands while the adoption waits at tabs.get: the tab is not inserted', async () => {
    const f = await ready(); f.events.length = 0;
    const hold = holdGet(f, 9);
    const opening = popup(f, 9, 'https://allowed.test/oauth');
    await hold.arrived;
    await f.runtime.connection(false);
    hold.release(); await opening;
    await f.runtime.connection(true);
    expect((await f.command('status')).result.tabs.map(t => t.tabId)).toEqual([1]);
    expect(notice(f)?.adopted).not.toBe(true);
  });
  it('control: with nothing landing meanwhile the held adoption still lands', async () => {
    const f = await ready(); f.events.length = 0;
    const hold = holdGet(f, 10);
    const opening = popup(f, 10, 'https://allowed.test/oauth');
    await hold.arrived; hold.release(); await opening;
    expect(await tabIds(f)).toEqual([1, 10]);
    expect(notice(f)).toMatchObject({ kind: 'tab_opened', tabId: 10, adopted: true });
  });
});

// SABLE-B test 26, extension half (design 11, rows 12 and 18; Base: PIN). An in-browser redirect to unapproved L pauses; Resume is refused
// while the tab sits on L; Share is refused while paused; Unshare, then Resume, then Share asks the server for L (share_requested); once
// the server's bind lists L the Share adds the tab. The server half (L granted without a card under Full, a site card under Ask) is in
// server/browser-extension-corefix.test.ts "test 26 server half".
describe('SABLE-B test 26: an in-browser redirect to L (PIN)', () => {
  it('paused; Resume refused on L; Share refused while paused; Unshare, Resume, Share asks for L; after the bind lists L the tab is shared', async () => {
    const f = await ready(); f.events.length = 0;
    const L = 'https://l.test';
    f.tabs.get(1).url = `${L}/landing`;
    await f.runtime.navigation({ tabId: 1, frameId: 0, url: `${L}/landing` });
    expect((await f.command('status')).result.state).toBe('paused');
    await expect(f.runtime.handlePanel({ action: 'resume', bindingId: 'bot_a' })).rejects.toThrow();
    expect((await f.command('status')).result.state).toBe('paused');
    await expect(f.runtime.handlePanel({ action: 'share', bindingId: 'bot_a', tabId: 1 })).rejects.toThrow(/binding_inactive/);
    expect(f.events.some(e => e.event === 'notice' && e.data?.kind === 'share_requested')).toBe(false);
    await f.runtime.handlePanel({ action: 'unshare', bindingId: 'bot_a', tabId: 1 });
    await f.runtime.handlePanel({ action: 'resume', bindingId: 'bot_a' });
    expect((await f.command('status')).result.state).toBe('active');
    await f.runtime.handlePanel({ action: 'share', bindingId: 'bot_a', tabId: 1 }).catch(() => undefined);
    expect(f.events.filter(e => e.event === 'notice' && e.data?.kind === 'share_requested').map(e => e.data.origin)).toEqual([L]);
    // The server granted L (Full: no card) and bound it; the owner's Share now adds the tab.
    await f.command('bind', { profileId: 'profile_1', botName: 'bot_a', approvedOrigins: ['https://allowed.test', L] }, await generation(f));
    await f.runtime.handlePanel({ action: 'share', bindingId: 'bot_a', tabId: 1 });
    expect(await tabIds(f)).toContain(1);
  });
});
