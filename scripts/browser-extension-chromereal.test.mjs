// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first tests for the two blind audits of Murage for Chrome (lane 0162-chromereal): runtime security.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixture } from './browser-extension-test-fixture.mjs';

const inputCalls = f => f.api.debugger.sendCommand.mock.calls.filter(([, method]) => method.startsWith('Input.'));
const ready = async () => { const f = fixture(); await f.init(); await f.navigate(); await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 }); return f; };

describe('Astra 1: no input reaches a document that changed after approval', () => {
  it('fences the navigation epoch right before dispatch, after the async arm', async () => {
    const f = await ready();
    f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => {
      if (method === 'Runtime.evaluate' && params.expression?.includes('.arm(')) await f.navigate();
      return f.sendCommand(source, method, params);
    });
    const r = await f.command('cdp', { method: 'Input.insertText', params: { text: 'secret' }, tabId: 1, navigationEpoch: 2 });
    expect(r.error.code).toBe('stale_document');
    expect(inputCalls(f)).toHaveLength(0);
  });
  it('also fences key and mouse input the same way', async () => {
    for (const [method, params] of [['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', text: 'a' }], ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left' }]]) {
      const f = await ready();
      f.api.debugger.sendCommand.mockImplementation(async (source, m, p) => { if (m === 'Runtime.evaluate' && p.expression?.includes('.arm(')) await f.navigate(); return f.sendCommand(source, m, p); });
      expect((await f.command('cdp', { method, params, tabId: 1, navigationEpoch: 2 })).error.code).toBe('stale_document');
      expect(inputCalls(f)).toHaveLength(0);
    }
  });
});

describe('Fable M1: clipboard editing is refused in the extension', () => {
  const denied = [
    { type: 'keyDown', key: 'v', code: 'KeyV', modifiers: 4, commands: ['paste'], windowsVirtualKeyCode: 86 },
    { type: 'keyDown', key: 'v', modifiers: 2 }, { type: 'rawKeyDown', key: 'V', modifiers: 4 }, { type: 'keyDown', key: 'c', modifiers: 2 },
    { type: 'keyDown', key: 'x', modifiers: 4 }, { type: 'keyDown', key: 'a', modifiers: 2 }, { type: 'keyDown', key: 'a', modifiers: 6 },
    { type: 'keyDown', key: 'q', commands: ['selectAll'] }, { type: 'keyDown', key: 'q', commands: ['copy'] }, { type: 'keyDown', key: 'q', commands: ['cut'] },
    { type: 'keyDown', key: 'q', commands: ['pasteAndMatchStyle'] }, { type: 'keyDown', key: 'Insert', modifiers: 8 }, { type: 'keyDown', key: 'Insert', modifiers: 2 }, { type: 'keyDown', key: 'Delete', modifiers: 8 },
    { type: 'keyDown', key: 'x', code: 'KeyX', modifiers: 2, windowsVirtualKeyCode: 88 },
  ];
  it('refuses every paste, copy, cut and select-all form before it reaches the page', async () => {
    for (const params of denied) {
      const f = await ready();
      const r = await f.command('cdp', { method: 'Input.dispatchKeyEvent', params, tabId: 1, navigationEpoch: 2 });
      expect(r.error?.code, JSON.stringify(params)).toBe('clipboard_denied');
      expect(inputCalls(f)).toHaveLength(0);
    }
  });
  it('still allows ordinary typing, shift letters and plain navigation keys', async () => {
    for (const params of [{ type: 'keyDown', key: 'v', text: 'v' }, { type: 'keyDown', key: 'V', text: 'V', modifiers: 8 }, { type: 'keyDown', key: 'a', modifiers: 0 }, { type: 'keyDown', key: 'Tab' }, { type: 'keyDown', key: 'Delete' }, { type: 'keyDown', key: 'Insert' }, { type: 'keyUp', key: 'Enter' }]) {
      const f = await ready();
      const r = await f.command('cdp', { method: 'Input.dispatchKeyEvent', params, tabId: 1, navigationEpoch: 2 });
      expect(r.error, JSON.stringify(params)).toBeUndefined();
    }
  });
});

describe('Fable M2: one protected-domain list (T21: only the handover category is closed in the extension)', () => {
  it('the extension refuses every handover domain and lets the ask-every-step ones through to the server', async () => {
    const { PROTECTED_DOMAINS } = await import('../shared/browser-protected-domains.ts');
    const { categoryFor } = await import('../shared/browser-site-categories.ts');
    let handover = 0, asks = 0;
    for (const domain of PROTECTED_DOMAINS) {
      const f = fixture(); await f.runtime.initialize(); await f.runtime.connection(true);
      const r = await f.command('bind', { profileId: 'profile_1', botName: 'x', approvedOrigins: [`https://www.${domain}`] });
      if (categoryFor(`www.${domain}`) === 'handover') { handover++; expect(r.error?.code, domain).toBe('human_handover'); }
      else { asks++; expect(r.error?.code, domain).not.toBe('human_handover'); }
    }
    expect(handover).toBeGreaterThan(5); expect(asks).toBeGreaterThan(100);
  });
  it('keeps citibank.com, which only the extension used to know', async () => {
    const { PROTECTED_DOMAINS, isProtectedHostname } = await import('../shared/browser-protected-domains.ts');
    expect(PROTECTED_DOMAINS).toContain('citibank.com'); expect(isProtectedHostname('www.citibank.com')).toBe(true); expect(isProtectedHostname('notcitibank.com')).toBe(false); expect(isProtectedHostname('citibank.com.')).toBe(true);
  });
});

describe('Astra 11: Unshare disarms the guard in the current document', () => {
  it('runs guard.enable(false) before the debugger detaches', async () => {
    const f = await ready();
    await f.command('cdp', { method: 'Page.createIsolatedWorld', params: { frameId: 'main-frame', worldName: 'murage-protected-document-v1' }, tabId: 1, navigationEpoch: 2 });
    const order = [];
    f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => { if (method === 'Runtime.evaluate' && params.expression === 'globalThis.__murageGuard?.enable(false)') order.push(['disarm', params.contextId]); return f.sendCommand(source, method, params); });
    f.api.debugger.detach.mockImplementation(async () => { order.push(['detach']); });
    await f.runtime.handlePanel({ action: 'unshare', bindingId: 'bot_a', tabId: 1 });
    expect(order[0]).toEqual(['disarm', 7]); expect(order.some(item => item[0] === 'detach')).toBe(true);
    expect(order.findIndex(item => item[0] === 'disarm')).toBeLessThan(order.findIndex(item => item[0] === 'detach'));
  });
  it('also when the agent unshares (tab_close) or the owner removes the tab', async () => {
    const f = await ready();
    await f.command('cdp', { method: 'Page.createIsolatedWorld', params: { frameId: 'main-frame', worldName: 'murage-protected-document-v1' }, tabId: 1, navigationEpoch: 2 });
    f.api.debugger.sendCommand.mockClear();
    await f.command('tab_close', { tabId: 1 });
    expect(f.api.debugger.sendCommand.mock.calls.some(([, method, params]) => method === 'Runtime.evaluate' && params.expression === 'globalThis.__murageGuard?.enable(false)')).toBe(true);
  });
});

describe('Fable M7: downloads from owned tabs are cancelled (the debugger cannot set download behavior: proved on Chrome for Testing 153)', () => {
  const page = { frameId: 'main-frame', guid: 'g', url: 'https://allowed.test/files/update.exe', suggestedFilename: 'update.exe' };
  it('the page event then the downloads event cancels and erases the item', async () => {
    const f = await ready(); await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page);
    await f.runtime.downloadCreated({ id: 7, url: page.url, finalUrl: page.url });
    expect(f.api.downloads.cancel).toHaveBeenCalledWith(7); expect(f.api.downloads.erase).toHaveBeenCalledWith({ id: 7 });
  });
  it('the downloads event then the page event does the same', async () => {
    const f = await ready(); await f.runtime.downloadCreated({ id: 8, url: page.url, finalUrl: page.url });
    expect(f.api.downloads.cancel).not.toHaveBeenCalled();
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', page); expect(f.api.downloads.cancel).toHaveBeenCalledWith(8);
  });
  it('a download the owner starts elsewhere is left alone', async () => {
    const f = await ready(); await f.runtime.downloadCreated({ id: 9, url: 'https://other.test/a.zip', finalUrl: 'https://other.test/a.zip', referrer: 'https://other.test/' });
    expect(f.api.downloads.cancel).not.toHaveBeenCalled();
  });
  it('the manifest asks for the downloads permission, and no command sets download behavior', () => {
    expect(JSON.parse(readFileSync(new URL('../extensions/murage-browser/manifest.json', import.meta.url), 'utf8')).permissions).toContain('downloads');
    expect(readFileSync(new URL('../extensions/murage-browser/runtime.mjs', import.meta.url), 'utf8')).not.toContain("'Page.setDownloadBehavior'");
  });
});

// ---------------------------------------------------------------------------------------------
// Real-world usability (runtime side): response cap, per-operation deadlines, dialogs, popups,
// downloads notices, retirement of stopped bindings.
// ---------------------------------------------------------------------------------------------
const evaluateReturning = (f, value) => f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => (method === 'Runtime.evaluate' && params.expression === 'big read') ? { result: { type: 'string', value } } : f.sendCommand(source, method, params));
const readBig = (f, command = {}) => f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'big read' }, tabId: 1, navigationEpoch: 2, ...command });

describe('Fable H1: the response cap is the real frame, not half of it', () => {
  it('delivers a 700 KB read (was refused at 512 KB)', async () => {
    const f = await ready(); evaluateReturning(f, 'x'.repeat(700_000));
    const r = await readBig(f); expect(r.error).toBeUndefined(); expect(r.result.result.result.value).toHaveLength(700_000);
  });
  it('still refuses what cannot fit one frame, counting the escapes Chrome adds for < and >', async () => {
    const f = await ready(); evaluateReturning(f, 'x'.repeat(1_100_000));
    expect((await readBig(f)).error.code).toBe('response_too_large');
    const g = await ready(); evaluateReturning(g, '<'.repeat(200_000));
    expect((await readBig(g)).error.code).toBe('response_too_large');
  });
  it('bounds the accessibility tree: depth is clamped, name sources are dropped, and an oversize tree is cut consistently', async () => {
    const f = await ready();
    const nodes = Array.from({ length: 3000 }, (_, i) => ({ nodeId: String(i), ignored: false, role: { type: 'role', value: 'button' }, name: { type: 'computedString', value: `Button ${i}`, sources: [{ type: 'attribute', attribute: 'aria-label', value: { type: 'string', value: 'x'.repeat(200) } }] }, childIds: i + 1 < 3000 ? [String(i + 1)] : [], backendDOMNodeId: i + 10 }));
    let seen; f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => { if (method === 'Accessibility.getFullAXTree') { seen = params; return { nodes }; } return f.sendCommand(source, method, params); });
    const r = await f.command('cdp', { method: 'Accessibility.getFullAXTree', params: {}, tabId: 1, navigationEpoch: 2 });
    expect(seen.depth).toBeLessThanOrEqual(64); expect(r.error).toBeUndefined();
    expect(r.result.result.nodes).toHaveLength(3000); expect(JSON.stringify(r.result.result)).not.toContain('"sources"');
    const huge = Array.from({ length: 20000 }, (_, i) => ({ nodeId: String(i), ignored: false, role: { type: 'role', value: 'text' }, name: { type: 'computedString', value: 'y'.repeat(120) }, childIds: [String(i + 1)], backendDOMNodeId: i + 10 }));
    f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => method === 'Accessibility.getFullAXTree' ? { nodes: huge } : f.sendCommand(source, method, params));
    const cut = await f.command('cdp', { method: 'Accessibility.getFullAXTree', params: {}, tabId: 1, navigationEpoch: 2 });
    expect(cut.error).toBeUndefined(); const kept = cut.result.result.nodes; expect(kept.length).toBeGreaterThan(1000); expect(kept.length).toBeLessThan(20000);
    const ids = new Set(kept.map(n => n.nodeId)); expect(kept.every(n => n.childIds.every(id => ids.has(id)))).toBe(true);
  });
  it('asks for JPEG with a quality setting and retries smaller when the picture is still too large', async () => {
    const f = await ready(); const asked = [];
    f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => { if (method === 'Page.captureScreenshot') { asked.push(params); return { data: asked.length === 1 ? 'A'.repeat(1_300_000) : 'small' }; } return f.sendCommand(source, method, params); });
    const r = await f.command('cdp', { method: 'Page.captureScreenshot', params: { format: 'png' }, tabId: 1, navigationEpoch: 2 });
    expect(r.error).toBeUndefined(); expect(r.result.result.data).toBe('small');
    expect(asked[0]).toMatchObject({ format: 'jpeg', quality: 70 }); expect(asked[1].format).toBe('jpeg'); expect(asked[1].quality).toBeLessThan(70);
  });
});

describe('Fable M4: per-operation deadlines, and a slow read does not pause the binding', () => {
  it('has long deadlines for navigation, screenshots and awaited scripts, 15 s otherwise', async () => {
    const { browserCommandDeadlineMs } = await import('../shared/browser-extension-protocol.ts');
    expect(browserCommandDeadlineMs('Page.navigate', {})).toBeGreaterThanOrEqual(45_000);
    expect(browserCommandDeadlineMs('Page.captureScreenshot', {})).toBeGreaterThanOrEqual(30_000);
    expect(browserCommandDeadlineMs('Runtime.evaluate', { awaitPromise: true })).toBeGreaterThanOrEqual(60_000);
    expect(browserCommandDeadlineMs('Runtime.evaluate', {})).toBe(15_000); expect(browserCommandDeadlineMs('DOM.getDocument', {})).toBe(15_000);
  });
  it('a read that outlives its deadline fails that call only: the binding stays active', async () => {
    const f = fixture({}, { commandTimeoutMs: 120 }); await f.init(); await f.navigate();
    await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 });
    f.api.debugger.sendCommand.mockImplementation((source, method, params) => method === 'Runtime.evaluate' && params.expression === 'slow' ? new Promise(() => {}) : f.sendCommand(source, method, params));
    const r = await f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'slow' }, tabId: 1, navigationEpoch: 2 });
    expect(r.error.code).toBe('command_timeout');
    expect((await f.command('status')).result.state).toBe('active');
    expect((await f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'next' }, tabId: 1, navigationEpoch: 2 })).error).toBeUndefined();
  });
  it('an input that outlives its deadline is uncertain and still pauses (it may have happened)', async () => {
    const f = fixture({}, { commandTimeoutMs: 120 }); await f.init(); await f.navigate();
    await f.command('cdp', { method: 'Page.enable', tabId: 1, navigationEpoch: 2 });
    f.api.debugger.sendCommand.mockImplementation((source, method, params) => method === 'Input.insertText' ? new Promise(() => {}) : f.sendCommand(source, method, params));
    expect((await f.command('cdp', { method: 'Input.insertText', params: { text: 'a' }, tabId: 1, navigationEpoch: 2 })).error.code).toBe('uncertain');
    expect((await f.command('status')).result.state).toBe('paused');
  });
});

describe('Fable M4: JavaScript dialogs reach the bot', () => {
  it('forwards the dialog as a scoped event and a notice, and allows handleJavaScriptDialog without touching the blocked page', async () => {
    const f = await ready(); f.events.length = 0;
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.javascriptDialogOpening', { url: 'https://allowed.test/page?secret=1', message: 'Delete everything? ' + 'x'.repeat(2000), type: 'confirm', hasBrowserHandler: false });
    const cdp = f.events.find(e => e.event === 'cdp'), notice = f.events.find(e => e.event === 'notice');
    expect(cdp.data.method).toBe('Page.javascriptDialogOpening'); expect(cdp.data.params.type).toBe('confirm'); expect(cdp.data.params.message.length).toBeLessThanOrEqual(500); expect(JSON.stringify(cdp)).not.toContain('secret=1');
    expect(notice.data).toMatchObject({ kind: 'dialog', tabId: 1, origin: 'https://allowed.test', dialogType: 'confirm' }); expect(notice.data.text).toContain('Delete everything?');
    f.api.debugger.sendCommand.mockClear();
    const r = await f.command('cdp', { method: 'Page.handleJavaScriptDialog', params: { accept: false }, tabId: 1, navigationEpoch: 2 });
    expect(r.error).toBeUndefined();
    expect(f.api.debugger.sendCommand.mock.calls.map(([, method]) => method)).toEqual(['Page.handleJavaScriptDialog']);
  });
});

describe('Fable M7: a blocked download is reported', () => {
  it('emits a notice with the page-supplied file name only', async () => {
    const f = await ready(); f.events.length = 0;
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.downloadWillBegin', { frameId: 'main-frame', guid: 'g', url: 'https://allowed.test/secret-token/abc.exe', suggestedFilename: 'update.exe' });
    const notice = f.events.find(e => e.event === 'notice');
    expect(notice.data).toMatchObject({ kind: 'download_blocked', tabId: 1, origin: 'https://allowed.test', name: 'update.exe' }); expect(JSON.stringify(f.events)).not.toContain('secret-token');
  });
});

describe('Fable M6: popups and opener tabs', () => {
  const popup = async (f, id, openerTabId, url) => { f.tabs.set(id, { id, url: 'about:blank' }); await f.runtime.tabCreated({ id, openerTabId, url: '', pendingUrl: url }); f.tabs.get(id).url = url; await f.runtime.navigation({ tabId: id, frameId: 0, url }); };
  it('adopts a tab an owned tab opened when its site is already approved, and tells the bot', async () => {
    const f = await ready(); f.events.length = 0;
    await popup(f, 5, 1, 'https://allowed.test/oauth');
    const status = (await f.command('status')).result; expect(status.tabs.map(t => t.tabId)).toEqual([1, 5]);
    expect(f.events.find(e => e.event === 'notice').data).toMatchObject({ kind: 'tab_opened', tabId: 5, origin: 'https://allowed.test', adopted: true });
  });
  it('reports, but does not adopt, a popup on a site that is not approved', async () => {
    const f = await ready(); f.events.length = 0;
    await popup(f, 6, 1, 'https://elsewhere.test/page');
    expect((await f.command('status')).result.tabs.map(t => t.tabId)).toEqual([1]);
    expect(f.events.find(e => e.event === 'notice').data).toMatchObject({ kind: 'tab_opened', tabId: 6, origin: 'https://elsewhere.test', adopted: false });
  });
  it('ignores tabs opened by tabs the binding does not own, and about:blank commits while waiting', async () => {
    const f = await ready(); f.events.length = 0;
    await popup(f, 7, 999, 'https://allowed.test/x'); expect((await f.command('status')).result.tabs.map(t => t.tabId)).toEqual([1]);
    f.tabs.set(8, { id: 8, url: 'about:blank' }); await f.runtime.tabCreated({ id: 8, openerTabId: 1, url: '' }); await f.runtime.navigation({ tabId: 8, frameId: 0, url: 'about:blank' });
    expect((await f.command('status')).result.tabs.map(t => t.tabId)).toEqual([1]);
    f.tabs.get(8).url = 'https://allowed.test/later'; await f.runtime.navigation({ tabId: 8, frameId: 0, url: 'https://allowed.test/later' });
    expect((await f.command('status')).result.tabs.map(t => t.tabId)).toEqual([1, 8]);
  });
  it('never adopts when the binding is paused', async () => {
    const f = await ready(); await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' });
    await popup(f, 9, 1, 'https://allowed.test/y'); expect((await f.runtime.handlePanel({ action: 'status' })).bindings[0].tabs.map(t => t.tabId)).not.toContain(9);
  });
});

describe('Astra 8: stopped bindings are retired with replay protection', () => {
  const bindAs = (f, i) => f.command('bind', { profileId: 'profile_1', botName: `b${i}`, approvedOrigins: ['https://allowed.test'] }, 1, `bot_${i}`);
  it('retires the oldest stopped binding to make room, so 32 finished tasks do not exhaust the profile', async () => {
    const f = fixture(); await f.runtime.initialize(); await f.runtime.connection(true);
    for (let i = 0; i < 32; i++) expect((await bindAs(f, i)).error).toBeUndefined();
    const full = await bindAs(f, 32); expect(full.error.code).toBe('binding_capacity');
    await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_0' });
    expect((await bindAs(f, 32)).error).toBeUndefined();
    const ids = (await f.runtime.handlePanel({ action: 'status' })).bindings.map(b => b.bindingId); expect(ids).not.toContain('bot_0'); expect(ids).toContain('bot_32');
  });
  it('a retired id cannot be bound again, across a restart too', async () => {
    const f = fixture(); await f.runtime.initialize(); await f.runtime.connection(true);
    await bindAs(f, 0); await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_0' });
    expect((await f.command('retire', {}, 2, 'bot_0')).result).toMatchObject({ retired: true });
    expect((await bindAs(f, 0)).error.code).toBe('binding_retired');
    const next = fixture(structuredClone(f.stored)); await next.runtime.initialize(); await next.runtime.connection(true);
    expect((await bindAs(next, 0)).error.code).toBe('binding_retired');
  });
  it('only a stopped binding can be retired', async () => {
    const f = fixture(); await f.runtime.initialize(); await f.runtime.connection(true); await bindAs(f, 0);
    expect((await f.command('retire', {}, 1, 'bot_0')).error.code).toBe('not_stopped');
  });
});

describe('Vultr L1/W2: a click that navigates does not pause the binding', () => {
  it('delivers the input, reports the new document, and leaves the binding active (repeated)', async () => {
    for (let run = 0; run < 25; run++) {
      const f = await ready();
      f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => {
        // The page navigates as the press lands: the new document's commit arrives before the extension clears its observer.
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') await f.navigate();
        return f.sendCommand(source, method, params);
      });
      const r = await f.command('cdp', { method: 'Input.dispatchMouseEvent', params: { type: 'mousePressed', x: 1, y: 1, button: 'left' }, tabId: 1, navigationEpoch: 2 });
      expect(r.error, `run ${run}`).toBeUndefined(); expect(r.result.navigationEpoch).toBe(3);
      expect((await f.command('status')).result.state).toBe('active');
      expect(f.stored.murageBrowserState.bindings[0].state).toBe('active');
    }
  });
  it('a read that races a navigation is refused as stale, never as a takeover', async () => {
    const f = await ready();
    f.api.debugger.sendCommand.mockImplementation(async (source, method, params) => { if (method === 'Runtime.evaluate' && params.expression === 'racing') await f.navigate(); return f.sendCommand(source, method, params); });
    const r = await f.command('cdp', { method: 'Runtime.evaluate', params: { expression: 'racing' }, tabId: 1, navigationEpoch: 2 });
    expect(r.error.code).toBe('stale_document');
    expect((await f.command('status')).result.state).toBe('active');
  });
});

describe('Fable L1: sharing the current tab can ask for its site', () => {
  it('Share on an unapproved site tells the server to raise the site card, then still refuses until it is allowed', async () => {
    const f = await ready(); f.tabs.set(50, { id: 50, url: 'https://gmail.test/inbox' }); f.events.length = 0;
    await expect(f.runtime.handlePanel({ action: 'share', bindingId: 'bot_a', tabId: 50 })).rejects.toMatchObject({ code: 'site_denied' });
    expect(f.events.find(e => e.event === 'notice').data).toMatchObject({ kind: 'share_requested', origin: 'https://gmail.test' });
    expect(JSON.stringify(f.events)).not.toContain('inbox');
  });
  it('no notice for a protected site, and Share still works for an approved one', async () => {
    const f = await ready(); f.tabs.set(51, { id: 51, url: 'https://vault.bitwarden.com/login' }); f.events.length = 0;
    await expect(f.runtime.handlePanel({ action: 'share', bindingId: 'bot_a', tabId: 51 })).rejects.toMatchObject({ code: 'human_handover' });
    expect(f.events.some(e => e.event === 'notice')).toBe(false);
    f.tabs.set(52, { id: 52, url: 'https://allowed.test/x' }); await f.runtime.handlePanel({ action: 'share', bindingId: 'bot_a', tabId: 52 });
    expect((await f.command('status')).result.tabs.map(t => t.tabId)).toContain(52);
  });
});


describe('Round 2: navigation metadata survives either event order', () => {
  it.each([true, false])('keeps lifecycle and context events when CDP commits first: %s', async cdpFirst => {
    const f = await ready();
    const commit = () => f.runtime.debuggerEvent({ tabId: 1 }, 'Page.frameNavigated', { frame: { id: 'main-frame', loaderId: 'login-loader', url: 'https://allowed.test/login' } });
    if (cdpFirst) await commit();
    f.tabs.get(1).url = 'https://allowed.test/login';
    await f.runtime.navigation({ tabId: 1, frameId: 0, url: 'https://allowed.test/login' });
    if (!cdpFirst) await commit();
    f.events.length = 0;
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Runtime.executionContextCreated', { context: { id: 23, origin: 'https://allowed.test', auxData: { frameId: 'main-frame', isDefault: true } } });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.lifecycleEvent', { frameId: 'main-frame', loaderId: 'login-loader', name: 'load', timestamp: 1 });
    await f.runtime.debuggerEvent({ tabId: 1 }, 'Page.lifecycleEvent', { frameId: 'child-frame', name: 'load', timestamp: 2 });
    expect(f.events.filter(e => e.event === 'cdp').map(e => e.data.method)).toEqual(['Runtime.executionContextCreated', 'Page.lifecycleEvent']);
    expect(f.events.every(e => e.data.navigationEpoch === 3)).toBe(true);
    const stale = await f.command('cdp', { method: 'Input.insertText', params: { text: 'x' }, tabId: 1, navigationEpoch: 2 });
    expect(stale.error?.code).toBe('stale_document');
    expect(inputCalls(f)).toHaveLength(0);
  });
});


describe('Round 2: Continue restores engine event subscriptions', () => {
  it('re-enables load notifications after detach without replaying input or navigation', async () => {
    const f = await ready();
    let navigationEpoch = 2;
    const cdp = (method, params = {}, generation = 1) => f.command('cdp', { method, params, tabId: 1, navigationEpoch }, generation);
    await cdp('Runtime.enable');
    await cdp('Network.enable');
    await cdp('Network.disable');
    await cdp('Page.setLifecycleEventsEnabled', { enabled: true });
    await cdp('Input.insertText', { text: 'once' });
    const paused = await f.command('pause', { reason: 'handoff' });
    const resumed = await f.command('resume', { reason: 'continue' }, paused.result.generation);
    expect(resumed.error).toBeUndefined();
    await f.bind('bot_a', resumed.result.generation);
    navigationEpoch = resumed.result.tabs[0].navigationEpoch;
    f.api.debugger.sendCommand.mockClear();
    expect((await cdp('Page.getFrameTree', {}, resumed.result.generation)).error).toBeUndefined();
    const methods = f.api.debugger.sendCommand.mock.calls.map(([, method]) => method);
    expect(methods).toContain('Page.enable');
    expect(methods).toContain('Runtime.enable');
    expect(f.api.debugger.sendCommand.mock.calls.some(([, method, params]) => method === 'Page.setLifecycleEventsEnabled' && params.enabled === true)).toBe(true);
    expect(methods).not.toContain('Network.enable');
    expect(methods).not.toContain('Input.insertText');
    expect(methods).not.toContain('Page.navigate');
    expect(f.api.debugger.attach).toHaveBeenCalledTimes(2);
  });
});
