// SPDX-License-Identifier: AGPL-3.0-or-later
// PAYFULL J16, the extension's side of the pay hold (owner q1024-payguard-fable; server side server/pay-press-guard.ts). Every row enters through
// runtime.handleRequest with a `cdp` command, as the server's commands do, and looks at what reached chrome.debugger.sendCommand:
//   - only the one Fetch.enable shape (main-frame Document requests, held at Request) is accepted; no other shape reaches the browser;
//   - the extension releases the hold itself after its own limit, whatever the server does, and also when the page stops answering right after
//     the hold went on (a held navigation answers no page command in real Chromium);
//   - a release from the server leaves no second release behind; the capability is declared in hello.
import { describe, it, expect, vi } from 'vitest';
import { createBrowserExtensionRuntime, PAY_HOLD_CAPABILITY } from '../extensions/murage-browser/runtime.mjs';

const SHAPE = { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(runtimeOptions = {}) {
  const tabs = new Map(); let next = 1; const completionListeners = new Set(); const stored = {};
  const sent = []; let stallPage = false, stallOnHold = false;
  const sendCommand = async (source, method, params = {}) => {
    sent.push({ tabId: source.tabId, method, params });
    if (method === 'Fetch.enable' && stallOnHold) { stallPage = true; return {}; }
    if (method === 'Fetch.disable') stallPage = false;
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main-frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'observer-script' };
    // A held navigation: the page answers nothing until the hold is released.
    if (stallPage && method === 'Runtime.evaluate') return new Promise(() => {});
    if (method === 'Runtime.evaluate' && params.expression?.startsWith('globalThis.__murageTakeover?.')) return { result: { type: 'boolean', value: params.expression.includes('.arm(') } };
    return { value: 'owned' };
  };
  const api = {
    webNavigation: { onCompleted: { addListener: listener => completionListeners.add(listener), removeListener: listener => completionListeners.delete(listener) } },
    storage: { local: { get: vi.fn(async key => ({ [key]: stored[key] })), set: vi.fn(async value => Object.assign(stored, structuredClone(value))) } },
    runtime: { getManifest: () => ({ version: '0.1.0' }) },
    tabs: { create: vi.fn(async ({ url }) => { const tab = { id: next++, url }; tabs.set(tab.id, tab); for (const listener of completionListeners) listener({ tabId: tab.id, frameId: 0, url }); return tab; }), get: vi.fn(async id => { if (!tabs.has(id)) throw Error('missing'); return tabs.get(id); }), group: vi.fn(async () => 42), remove: vi.fn(async id => tabs.delete(id)) },
    tabGroups: { update: vi.fn(async () => {}) }, action: { setBadgeText: vi.fn(async () => {}) },
    debugger: { attach: vi.fn(async () => {}), detach: vi.fn(async () => {}), sendCommand: vi.fn(sendCommand) },
  };
  const runtime = createBrowserExtensionRuntime(api, { uuid: () => 'profile_1', emit: () => {}, commandTimeoutMs: 500, ...runtimeOptions });
  await runtime.initialize(); const hello = await runtime.connection(true);
  let requestId = 0; const nonce = '1'.padStart(32, '0');
  const command = (operation, params = {}) => runtime.handleRequest({ version: 1, type: 'command', id: `${nonce}_${++requestId}`, bindingId: 'bot_a', generation: 1, operation, params });
  await command('bind', { profileId: 'profile_1', botName: 'bot_a', approvedOrigins: ['https://allowed.test'] });
  tabs.get(1).url = 'https://allowed.test/checkout'; await runtime.navigation({ tabId: 1, frameId: 0, url: tabs.get(1).url });
  const cdp = (method, params = {}) => command('cdp', { method, params, tabId: 1, navigationEpoch: 2 });
  const fetches = () => sent.filter(c => c.method.startsWith('Fetch.') || (c.method === 'Runtime.addBinding' && ['__muragePayReport', 'other'].includes(c.params.name))).map(c => `${c.method} ${JSON.stringify(c.params)} tab ${c.tabId}`);
  return { cdp, fetches, hello, runtime, stallOnceHeld: () => { stallOnHold = true; } };
}

describe('PAYFULL J16: the extension side of the pay hold', () => {
  it('W-EXT-HOLD-CONTROL: the one hold shape is accepted and reaches the browser as sent', async () => {
    const f = await fixture();
    const r = await f.cdp('Fetch.enable', SHAPE);
    expect(r.error).toBeUndefined();
    expect(f.fetches()).toEqual([`Fetch.enable ${JSON.stringify(SHAPE)} tab 1`]);
    await f.cdp('Fetch.disable');
  });
  const REFUSED = [
    ['every request, not only documents', 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }],
    ['scripts', 'Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Script', requestStage: 'Request' }] }],
    ['documents held at the response', 'Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' }] }],
    ['a second pattern', 'Fetch.enable', { patterns: [...SHAPE.patterns, { urlPattern: '*', resourceType: 'XHR', requestStage: 'Request' }] }],
    ['auth interception', 'Fetch.enable', { ...SHAPE, handleAuthRequests: true }],
    ['no patterns (everything)', 'Fetch.enable', {}],
    ['a release with arguments', 'Fetch.disable', { anything: true }],
    ['continuing a held request', 'Fetch.continueRequest', { requestId: 'interception-job-1.0' }],
    ['answering a held request', 'Fetch.fulfillRequest', { requestId: 'interception-job-1.0', responseCode: 200 }], ['a binding in every world (the page could call it)', 'Runtime.addBinding', { name: '__muragePayReport' }], ['a binding of another name', 'Runtime.addBinding', { name: 'other', executionContextName: 'murage-protected-document-v1' }], ['a binding in another world', 'Runtime.addBinding', { name: '__muragePayReport', executionContextName: 'page' }],
  ];
  for (const [name, method, params] of REFUSED) it(`W-EXT-HOLD-SHAPE: ${name} is refused and never reaches the browser`, async () => {
    const f = await fixture();
    const r = await f.cdp(method, params);
    expect(r.error?.code).toBe('method_denied');
    expect(f.fetches()).toEqual([]);
  });
  it('W-EXT-HOLD-RELEASE: with no word from the server the extension releases the hold itself after its limit, once', async () => {
    const f = await fixture({ payHoldMaxMs: 60 });
    await f.cdp('Fetch.enable', SHAPE);
    expect(f.fetches()).toHaveLength(1);
    await wait(200);
    expect(f.fetches()).toEqual([`Fetch.enable ${JSON.stringify(SHAPE)} tab 1`, 'Fetch.disable {} tab 1']);
  });
  it('W-EXT-HOLD-STALL: the page stops answering the moment the hold is on (a held navigation): the hold is still released at the limit', async () => {
    const f = await fixture({ payHoldMaxMs: 60 });
    f.stallOnceHeld();
    void f.cdp('Fetch.enable', SHAPE).catch(() => {});
    await wait(250);
    expect(f.fetches()).toEqual([`Fetch.enable ${JSON.stringify(SHAPE)} tab 1`, 'Fetch.disable {} tab 1']);
  });
  it("W-EXT-HOLD-ONCE: the server's own release leaves no second release behind", async () => {
    const f = await fixture({ payHoldMaxMs: 60 });
    await f.cdp('Fetch.enable', SHAPE); await f.cdp('Fetch.disable');
    await wait(200);
    expect(f.fetches()).toEqual([`Fetch.enable ${JSON.stringify(SHAPE)} tab 1`, 'Fetch.disable {} tab 1']);
  });
  it('W-EXT-HOLD-CAPABILITY: hello declares the hold, which is what the service asks for before it offers a pay card', async () => {
    const f = await fixture();
    expect(PAY_HOLD_CAPABILITY).toBe('pay_hold_v2');
    expect(f.hello?.capabilities ?? (await f.runtime.hello?.())?.capabilities).toContain('pay_hold_v2');
  });
});
