// SPDX-License-Identifier: AGPL-3.0-or-later
// PAYFULL J16 on the extension's own code in a REAL Chromium (owner q1024-payguard-fable; server side server/pay-press-guard.ts).
// The extension runtime (extensions/murage-browser/runtime.mjs, entry runtime.handleRequest) runs unchanged; its chrome.debugger is a real
// Chromium DevTools session (Playwright) on a form-post checkout served on loopback, and the guard it installs is the server's real
// PAY_PRESS_GUARD_SOURCE. The commands are the ones the executor sends for one approved press, in its order.
// What it proves: on a checkout whose Pay button posts a form (a main-frame navigation, so it is held), the release half comes back at once
// instead of waiting on the held page, the guard's report reaches the server side as a pushed event, the server's release is answered while the
// page is still held, and the shop is paid exactly once.
// Needs a Chromium: runs only with MURAGE_REAL_BROWSER=1 on a host with the Playwright browsers (listed as extended).
import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createBrowserExtensionRuntime, PAY_HOLD_MAX_MS } from '../extensions/murage-browser/runtime.mjs';
// The server's own load order (the service first): pay-card.ts and the executor import each other.
import '../server/browser-extension-service.ts';
import { PAY_PRESS_GUARD_SOURCE, PAY_PRESS_ARM } from '../server/pay-press-guard.ts';

const REAL = process.env.MURAGE_REAL_BROWSER === '1';
const WORLD = 'murage-protected-document-v1', BINDING = '__muragePayReport';
const SHAPE = { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] };
const PAGE = `<!doctype html><title>Fixture Shop</title><h1>Checkout</h1><div data-order-summary>USB-C cable Quantity: 1</div><p>Total due today <span id="total">$42.99</span></p>
<form method="post" action="/pay-form"><button id="pay" style="position:absolute;left:40px;top:200px;width:160px;height:40px">Pay now</button></form>`;
let site, siteUrl = '', posts = 0;
beforeAll(async () => {
  if (!REAL) return;
  site = createServer((req, res) => { if (req.method === 'POST') { posts++; req.resume(); } res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.method === 'POST' ? '<!doctype html><title>Paid</title>thanks' : PAGE); });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve)); siteUrl = `http://127.0.0.1:${site.address().port}`;
});
afterAll(() => { site?.close(); });
const cleanup = []; afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step().catch(() => {}); });

async function fixture(afterReleaseMs = 0) {
  posts = 0;
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch(); cleanup.push(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 800, height: 600 } }); const page = await context.newPage();
  await page.goto(`${siteUrl}/checkout`);
  const cdp = await context.newCDPSession(page);
  const tabs = new Map(); let next = 1; const completionListeners = new Set(); const stored = {}; const events = [];
  const api = {
    webNavigation: { onCompleted: { addListener: listener => completionListeners.add(listener), removeListener: listener => completionListeners.delete(listener) } },
    storage: { local: { get: vi.fn(async key => ({ [key]: stored[key] })), set: vi.fn(async value => Object.assign(stored, structuredClone(value))) } },
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
    tabs: { create: vi.fn(async ({ url }) => { const tab = { id: next++, url }; tabs.set(tab.id, tab); for (const listener of completionListeners) listener({ tabId: tab.id, frameId: 0, url }); return tab; }), get: vi.fn(async id => { if (!tabs.has(id)) throw Error('missing'); return tabs.get(id); }), group: vi.fn(async () => 42), remove: vi.fn(async id => tabs.delete(id)) },
    tabGroups: { update: vi.fn(async () => {}) }, action: { setBadgeText: vi.fn(async () => {}) },
    // The real browser: every command the extension sends is run by Chromium.
    // `afterReleaseMs`: the time chrome.debugger takes to hand the input's result back to the extension. By then the form post is a held navigation.
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand: async (_source, method, params = {}) => { const value = await cdp.send(method, params); if (afterReleaseMs && method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') await new Promise(resolve => setTimeout(resolve, afterReleaseMs)); return value; } },
  };
  const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: e => events.push(e) });
  cdp.on('Runtime.bindingCalled', params => { void runtime.debuggerEvent({ tabId: 1 }, 'Runtime.bindingCalled', params); });
  await runtime.initialize(); await runtime.connection(true);
  let requestId = 0; const nonce = '1'.padStart(32, '0');
  const command = (operation, params = {}) => runtime.handleRequest({ version: 1, type: 'command', id: `${nonce}_${++requestId}`, bindingId: 'bot_a', generation: 1, operation, params });
  await command('bind', { profileId: 'profile_1', botName: 'bot_a', approvedOrigins: [siteUrl] });
  tabs.get(1).url = `${siteUrl}/checkout`; await runtime.navigation({ tabId: 1, frameId: 0, url: tabs.get(1).url });
  const cdpCommand = (method, params = {}) => command('cdp', { method, params, tabId: 1, navigationEpoch: 2 });
  const reports = () => events.filter(e => e.event === 'cdp' && e.data?.method === 'Runtime.bindingCalled' && e.data.params?.name === BINDING).map(e => JSON.parse(e.data.params.payload));
  return { cdp: cdpCommand, reports, page, raw: cdp };
}
const timed = async work => { const began = Date.now(); const result = await work(); return { result, took: Date.now() - began }; };

describe.skipIf(!REAL)('PAYFULL J16, the real extension runtime on a real Chromium form-post checkout', () => {
  // Whether the extension's own checks after the input run before or after the post is held is a race; both sides of it are rows.
  for (const [name, afterReleaseMs] of [['', 0], ['-HELD', 300]]) it(`W-EXT-REAL-FORM-POST${name}: the pay button posts a form under the hold${afterReleaseMs ? ' and the post is held before the checks after the input' : ''}: the release half returns at once, the report is pushed, the release is answered, paid once`, async () => {
    const f = await fixture(afterReleaseMs);
    const tree = await f.cdp('Page.getFrameTree');
    const world = await f.cdp('Page.createIsolatedWorld', { frameId: tree.result?.result?.frameTree?.frame?.id, worldName: WORLD });
    const contextId = world.result?.result?.executionContextId;
    const bound = await f.cdp('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    const hold = await f.cdp('Fetch.enable', SHAPE);
    const installed = await f.cdp('Runtime.evaluate', { expression: `(${PAY_PRESS_GUARD_SOURCE}).call(document.getElementById('pay'))`, contextId, returnByValue: true });
    const armed = await f.cdp('Runtime.evaluate', { expression: PAY_PRESS_ARM(1_500, 'press-1'), contextId, returnByValue: true });
    // Control: the hold is on, the real guard stands on the real button and is armed.
    expect([hold.error, JSON.parse(installed.result?.result?.result?.value ?? '{}').ok, armed.result?.result?.result?.value]).toEqual([undefined, true, true]);
    const press = { x: 120, y: 220, button: 'left', clickCount: 1 };
    await f.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...press });
    const released = await timed(() => f.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...press }));
    const reportsAtReturn = f.reports();
    const release = await timed(() => f.cdp('Fetch.disable'));
    // The form post is a held navigation by now and the page answers nothing: the release half must not wait for the extension's own 3 s release.
    expect([released.result.error, released.took < PAY_HOLD_MAX_MS - 1_000]).toEqual([undefined, true]);
    // The guard's report left the page by the push, before anything was read back: this press, pressed, every one of the five events let through.
    expect(reportsAtReturn).toEqual([{ nonce: 'press-1', state: 'pressed', passed: 5, why: '' }]);
    // The server's release is answered while the page is still held (no page check in front of it).
    expect([release.result.error, release.took < 1_000]).toEqual([undefined, true]);
    await f.page.waitForURL('**/pay-form', { timeout: 5_000 });
    expect([posts, bound.error]).toEqual([1, undefined]);
  }, 60_000);

  it("W-EXT-REAL-PAGE-BLIND: the page's own world has no report binding and a call from it reaches nobody", async () => {
    const f = await fixture();
    const tree = await f.cdp('Page.getFrameTree');
    await f.cdp('Page.createIsolatedWorld', { frameId: tree.result?.result?.frameTree?.frame?.id, worldName: WORLD });
    await f.cdp('Runtime.addBinding', { name: BINDING, executionContextName: WORLD });
    await f.cdp('Fetch.enable', SHAPE);
    // A binding the page can see (added by another debugger client, with no world name) and calls: the extension forwards nothing from the page's world.
    await f.raw.send('Runtime.addBinding', { name: BINDING });
    const kind = await f.page.evaluate(`(()=>{const k=typeof globalThis.${BINDING};try{globalThis.${BINDING}(JSON.stringify({nonce:'press-1',state:'pressed',passed:5,why:''}));}catch(e){}return k;})()`);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect([kind, f.reports()]).toEqual(['function', []]);
    await f.cdp('Fetch.disable');
  }, 60_000);
});
