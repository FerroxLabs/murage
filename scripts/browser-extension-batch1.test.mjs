// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first tests (lane 0162-chromebatch1): defects found by the real-browser surface proofs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixture } from './browser-extension-test-fixture.mjs';

const ready = async () => { const f = fixture(); await f.init(); await f.navigate(); await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 }); return f; };
const tabIds = async f => (await f.command('status')).result.tabs.map(t => t.tabId);

// Real Chrome reports openerTabId from the ACTIVE tab, not from the tab the link was clicked in, when the
// clicking tab is in the background (the bot's tab always is). webNavigation.onCreatedNavigationTarget names the
// real source tab, so the runtime decides adoption from that.
describe('popups from a background tab (real Chrome reports the wrong opener)', () => {
  const open = async (f, id, { openerTabId, sourceTabId, url }) => {
    f.tabs.set(id, { id, url: 'about:blank' });
    if (openerTabId !== undefined) await f.runtime.tabCreated({ id, openerTabId, url: '', pendingUrl: url });
    if (sourceTabId !== undefined) await f.runtime.navigationTarget({ tabId: id, sourceTabId, sourceFrameId: 0, url });
    f.tabs.get(id).url = url; await f.runtime.navigation({ tabId: id, frameId: 0, url });
  };
  it('adopts a tab whose navigation source is an owned tab even though tabs.onCreated named another opener', async () => {
    const f = await ready(); f.events.length = 0;
    await open(f, 5, { openerTabId: 999, sourceTabId: 1, url: 'https://allowed.test/oauth' });
    expect(await tabIds(f)).toEqual([1, 5]);
    expect(f.events.find(e => e.event === 'notice').data).toMatchObject({ kind: 'tab_opened', tabId: 5, adopted: true });
  });
  it('adopts from the navigation source alone', async () => {
    const f = await ready(); f.events.length = 0;
    await open(f, 6, { sourceTabId: 1, url: 'https://allowed.test/report' });
    expect(await tabIds(f)).toEqual([1, 6]);
  });
  it('does not adopt a tab an owner tab opened, when tabs.onCreated wrongly named the bot tab as the opener', async () => {
    const f = await ready(); f.events.length = 0;
    await open(f, 7, { openerTabId: 1, sourceTabId: 999, url: 'https://allowed.test/not-ours' });
    expect(await tabIds(f)).toEqual([1]);
    expect(f.events.some(e => e.event === 'notice')).toBe(false);
  });
  it('tells the bot, and keeps the tab private, for an unapproved site opened from the owned tab', async () => {
    const f = await ready(); f.events.length = 0;
    await open(f, 8, { openerTabId: 999, sourceTabId: 1, url: 'https://elsewhere.test/x' });
    expect(await tabIds(f)).toEqual([1]);
    expect(f.events.find(e => e.event === 'notice').data).toMatchObject({ kind: 'tab_opened', tabId: 8, adopted: false });
  });
  it('the service worker listens for it', () => {
    const src = readFileSync(new URL('../extensions/murage-browser/service-worker.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/onCreatedNavigationTarget\.addListener/);
  });
});

// A bot click that makes the page open an alert/confirm/prompt blocks the click's own CDP command until the dialog is
// answered, so the answer has to be allowed through while that command is still in flight (real Chrome: the click hung
// until the owner dismissed the dialog, and the extension worker was then killed for being idle).
describe('a dialog opened by the bot\'s own click can be answered while the click is in flight', () => {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  it('lets Page.handleJavaScriptDialog through while an Input command is blocked, and keeps every other command refused as busy', async () => {
    const f = await ready(); let release;
    f.api.debugger.sendCommand.mockImplementation((source, method, params) => method === 'Input.dispatchMouseEvent' ? new Promise(resolve => { release = resolve; }) : f.sendCommand(source, method, params));
    const click = f.command('cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mouseReleased', x: 5, y: 5, button: 'left', clickCount: 1 }, tabId: 1, navigationEpoch: 2 });
    for (let i = 0; i < 50 && !release; i++) await tick();
    expect(release).toBeTypeOf('function');
    const answered = await f.command('cdp', { method: 'Page.handleJavaScriptDialog', params: { accept: true }, tabId: 1, navigationEpoch: 2 });
    expect(answered.error).toBeUndefined();
    expect(f.api.debugger.sendCommand.mock.calls.map(([, method]) => method)).toContain('Page.handleJavaScriptDialog');
    const other = await f.command('cdp', { method: 'Runtime.evaluate', params: { expression: '1' }, tabId: 1, navigationEpoch: 2 });
    expect(other.error?.code).toBe('busy');
    release({}); await click;
    // The click's own busy flag was not cleared by the dialog answer, and is cleared when the click ends.
    const after = await f.command('cdp', { method: 'Runtime.evaluate', params: { expression: '1' }, tabId: 1, navigationEpoch: 2 });
    expect(after.error?.code).not.toBe('busy');
  });
  it('a dialog answer on its own still works and still does not touch the page', async () => {
    const f = await ready(); f.api.debugger.sendCommand.mockClear();
    const answered = await f.command('cdp', { method: 'Page.handleJavaScriptDialog', params: { accept: false }, tabId: 1, navigationEpoch: 2 });
    expect(answered.error).toBeUndefined();
    expect(f.api.debugger.sendCommand.mock.calls.map(([, method]) => method)).toEqual(['Page.handleJavaScriptDialog']);
  });
});
