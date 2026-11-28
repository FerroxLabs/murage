// SPDX-License-Identifier: AGPL-3.0-or-later
// CHROME-RESUME-FROM-APP (1.0.23, row CR), extension side: W1-W7 and W17's orphan setup. The REAL runtime.mjs runs behind the shared
// chrome.* fixture (only storage, tabs and the debugger are faked at the API boundary). The app's Resume is `resume {reason:'app_owner'}`.
import { describe, it, expect } from 'vitest';
import { fixture } from './browser-extension-test-fixture.mjs';
import manifest from '../extensions/murage-browser/manifest.json' with { type: 'json' };

const ready = async () => { const f = fixture(); await f.init(); await f.navigate(); return f; };
const gen = async f => (await f.command('status')).result.generation;
const state = async f => (await f.command('status')).result;
const resumed = f => f.events.filter(e => e.event === 'resumed');

describe('CHROME-RESUME W1-W7 (extension)', () => {
  it('W1: an owner-paused task resumes from the app at its generation: active, generation + 1, one resumed event with resumedAt', async () => {
    const f = await ready();
    await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' });
    const g = await gen(f);
    const before = resumed(f).length;
    const r = await f.command('resume', { reason: 'app_owner' }, g);
    expect(r.error).toBeUndefined();
    const s = await state(f);
    expect(s.state).toBe('active'); expect(s.generation).toBe(g + 1);
    const events = resumed(f).slice(before);
    expect(events.length).toBe(1); expect(events[0].data.resumedAt).toBe(g + 1);
  });

  it('W2: a hand-over is answered only by Continue: handoff_use_continue, still paused, generation unchanged', async () => {
    const f = await ready();
    await f.command('pause', { reason: 'handoff', handoff: 'Sign in yourself.' });
    const g = await gen(f);
    const r = await f.command('resume', { reason: 'app_owner' }, g);
    expect(r.error?.code).toBe('handoff_use_continue');
    const s = await state(f);
    expect(s.state).toBe('paused'); expect(s.generation).toBe(g);
  });

  it('W3: a stopped task answers binding_stopped, stays stopped, emits no resumed event', async () => {
    const f = await ready();
    await f.runtime.handlePanel({ action: 'stop', bindingId: 'bot_a' });
    const g = await gen(f); const before = resumed(f).length;
    const r = await f.command('resume', { reason: 'app_owner' }, g);
    expect(r.error?.code).toBe('binding_stopped');
    expect((await state(f)).state).toBe('stopped'); expect(resumed(f).length).toBe(before);
  });

  it('W4: a stale generation is refused first, then the same press at the current generation resumes (the refusal is a regression guard)', async () => {
    const f = await ready();
    await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' });
    const g = await gen(f);
    const stale = await f.command('resume', { reason: 'app_owner' }, g - 1);
    expect(stale.error?.code).toBe('stale_generation');
    expect((await state(f)).state).toBe('paused'); expect(await gen(f)).toBe(g);
    const r = await f.command('resume', { reason: 'app_owner' }, g);
    expect(r.error).toBeUndefined();
    expect((await state(f)).state).toBe('active'); expect(await gen(f)).toBe(g + 1);
  });

  it('W5: an active task answers not_paused and its generation does not move', async () => {
    const f = await ready();
    const g = await gen(f);
    const r = await f.command('resume', { reason: 'app_owner' }, g);
    expect(r.error?.code).toBe('not_paused');
    expect(await gen(f)).toBe(g);
  });

  it('W6: a shared tab on an unapproved origin answers site_denied and an incognito tab incognito_denied; both stay paused', async () => {
    const f = await ready();
    await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' });
    const g = await gen(f);
    f.tabs.get(1).url = 'https://elsewhere.test/page';
    const site = await f.command('resume', { reason: 'app_owner' }, g);
    expect(site.error?.code).toBe('site_denied');
    expect((await state(f)).state).toBe('paused'); expect(await gen(f)).toBe(g);
    f.tabs.get(1).url = 'https://allowed.test/page'; f.tabs.get(1).incognito = true;
    const priv = await f.command('resume', { reason: 'app_owner' }, g);
    expect(priv.error?.code).toBe('incognito_denied');
    expect((await state(f)).state).toBe('paused');
  });

  it('W7: hello lists app_resume_v1 and the manifest is 1.0.2', async () => {
    const f = fixture(); await f.runtime.initialize();
    const hello = await f.runtime.connection(true);
    expect(hello.capabilities).toContain('app_resume_v1');
    expect(manifest.version).toBe('1.0.2');
  });

  it('every other reason and a reason-less resume stay owner_action_required', async () => {
    const f = await ready();
    await f.runtime.handlePanel({ action: 'pause', bindingId: 'bot_a' });
    const g = await gen(f);
    expect((await f.command('resume', {}, g)).error?.code).toBe('owner_action_required');
    expect((await f.command('resume', { reason: 'other' }, g)).error?.code).toBe('owner_action_required');
    expect((await state(f)).state).toBe('paused');
  });
});
