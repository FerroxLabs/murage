// SPDX-License-Identifier: AGPL-3.0-or-later
// Red-first tests (lane 0162-chromereal): service worker reconnect, side panel, stopped bindings.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { workerFixture, settle } from './browser-extension-worker-fixture.mjs';

describe('Fable L2: reconnect keeps trying, with backoff', () => {
  // The fake-clock endurance and per-profile wakeup measurements live in browser-extension-idle.node-test.mjs.
  it('persists the deadline when a healthy runtime loses its host', async () => {
    const f = await workerFixture();
    const before = Date.now();
    await f.ports[0].onMessage.fire({ type: 'host.error' });
    expect(f.stored.murageBrowserReconnect.attempts).toBe(0);
    expect(f.stored.murageBrowserReconnect.nextRetryAt).toBeGreaterThan(before);
    expect(f.stored.murageBrowserReconnect.nextRetryAt).toBeLessThanOrEqual(Date.now() + 1200);
    expect([...f.timers.values()][0].ms).toBeLessThanOrEqual(1200);
  });
  it('registers a one-shot alarm for the deadline and ignores unrelated alarms', async () => {
    const f = await workerFixture();
    await f.ports[0].onMessage.fire({ type: 'host.error' }); f.timers.clear();
    const deadline = f.stored.murageBrowserReconnect.nextRetryAt;
    expect(f.api.alarms.create).toHaveBeenLastCalledWith('murage-reconnect', { when: expect.any(Number) });
    expect(f.api.alarms.create.mock.calls.at(-1)[1].when).toBeGreaterThanOrEqual(deadline);
    const before = f.ports.length;
    await f.api.alarms.onAlarm.fire({ name: 'someone-else' }); await settle(); expect(f.ports.length).toBe(before);
  });
  it('declares the alarms permission', () => {
    expect(JSON.parse(readFileSync(new URL('../extensions/murage-browser/manifest.json', import.meta.url), 'utf8')).permissions).toContain('alarms');
  });
});

describe('Astra 13: manual Reconnect replaces a live port', () => {
  it('closes the old connection, fences without resuming, and opens a new one', async () => {
    const f = await workerFixture(); const old = f.ports[0];
    await f.panelReconnect(); await settle();
    expect(old.closed).toBe(true); expect(f.ports).toHaveLength(2);
    expect(f.stored.murageBrowserState.bindings[0].state).toBe('paused');
  });
});

describe('Fable L10: the side panel offers no Resume for a stopped task', () => {
  // The panel (T33 v2) is an ES module built by renderPanel, so the check runs the real view against the DOM shim.
  it('the side panel shows no Resume button for it, and does for a paused one', async () => {
    const { renderPanel } = await import('../extensions/murage-browser/sidepanel/view.mjs');
    const { makeDocument, byRole } = await import('../extensions/murage-browser/sidepanel/dom-shim.test-helper.mjs');
    const render = state => {
      const doc = makeDocument(); const root = doc.createElement('div');
      const binding = { bindingId: 'b1', botName: 'Ada', conversation: 'Run', state, ready: true, mode: 'task', tabs: [], approvedOrigins: [], grants: [], activity: [] };
      renderPanel(doc, root, { connected: true, profileId: 'p', bindings: [binding], selected: 'b1', feedback: '', supports: ['stop', 'pause', 'resume', 'share'] }, { t: key => key, act() {} });
      return byRole(root, 'resume').length;
    };
    expect(render('stopped')).toBe(0);
    expect(render('paused')).toBe(1);
  });
});
