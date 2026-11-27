// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Row 73 chat-sections (ASTRA n4:4753): a folded department header says its name and offers an expand control, with no
// folded "· N" total. Mounted on the real Sidebar with a real stored collapse preference, not source text.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { Sidebar } from './Sidebar';
import { initialState } from '../state/store';
import { SIDEBAR_COLLAPSED_SECTIONS_KEY } from '../lib/sidebar-preferences';
import { userSectionId } from '../lib/sidebar-layout';

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, api: vi.fn(async () => ({})) }));
vi.mock('../lib/updater', () => ({ useUpdaterState: () => ({ status: 'idle', version: 'fixture' }) }));
vi.mock('../state/store', async original => ({ ...await original<typeof import('../state/store')>(), useStore: () => ({ state: fixture.state, dispatch: vi.fn() }), useStoreActions: () => ({ dispatch: vi.fn() }), api: fixture.api }));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
const bots = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i + 1}`, name: `Bot ${i + 1}`, section: 'Planning', tasks: [] }));
beforeEach(() => {
  fixture.state = { ...initialState, bots: bots(18) };
  fixture.api.mockReset().mockResolvedValue({ bots: [], groups: [], playbooks: [], routines: [], skills: [], templates: [] });
});
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); localStorage.clear(); });

const header = () => document.querySelector<HTMLElement>('[data-section^="Planning"]');
async function open(collapsed: boolean) {
  localStorage.setItem(SIDEBAR_COLLAPSED_SECTIONS_KEY, JSON.stringify(collapsed ? [userSectionId('Planning')] : []));
  mount(h(Sidebar, { open: true, onClose: vi.fn() })); await settle();
}

describe('sidebar section header on the real Sidebar', () => {
  it('a folded department with 18 bots shows its name and expand control, with no folded total', async () => {
    await open(true);
    const el = header()!;
    expect(el).not.toBeNull();
    expect(el.querySelector('button')!.getAttribute('aria-expanded')).toBe('false');
    expect(el.textContent).toContain('Planning');
    expect(el.textContent).not.toMatch(/18/);
    expect(el.textContent).not.toContain('·');
    expect(document.body.textContent).not.toContain('Bot 1');
  });

  it('the same department open shows its bots and aria-expanded true, still without a total', async () => {
    await open(false);
    const el = header()!;
    expect(el.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
    expect(el.textContent).not.toMatch(/18/);
    expect(document.body.textContent).toContain('Bot 1');
  });
});
