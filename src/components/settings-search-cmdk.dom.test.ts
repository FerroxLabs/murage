// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Sean Q-C (SEAN-YES 2096) host witness: the real CommandPaletteHost keydown listener. Mod+K with Settings search mounted
// focuses it and opens no palette; with Settings closed or hidden the palette opens as before.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, gate, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { CommandPaletteHost } from './CommandPaletteHost';

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });

function settings(hidden = false) {
  const page = document.createElement('section');
  if (hidden) page.hidden = true;
  const input = document.createElement('input');
  input.id = 'settings-search'; input.value = 'old query';
  page.append(input);
  document.body.append(page);
  return input;
}
function opener() { const b = document.createElement('button'); document.body.append(b); b.focus(); return b; }

describe('Mod+K through the palette host', () => {
  it('Settings open: Ctrl+K focuses Settings search and opens no palette', async () => {
    const chunk = gate<import('./CommandPalette').CommandPaletteProps>();
    mount(h(CommandPaletteHost, { palette: chunk }));
    const input = settings(); const b = opener();
    const event = press('k', b, { ctrlKey: true }); await settle();
    expect(document.activeElement).toBe(input);
    expect(openLayers().filter(layer => layer.kind === 'palette')).toHaveLength(0);
    expect(activeTrapCount()).toBe(0);
    expect(event.defaultPrevented).toBe(true);
  });
  it.each([false, true])('Settings closed (hidden page=%s): Ctrl+K opens the palette as before', async hidden => {
    const chunk = gate<import('./CommandPalette').CommandPaletteProps>();
    mount(h(CommandPaletteHost, { palette: chunk }));
    if (hidden) settings(true);
    const b = opener();
    press('k', b, { ctrlKey: true }); await settle();
    expect(openLayers().filter(layer => layer.kind === 'palette')).toHaveLength(1);
    act(() => press('Escape')); await settle();
  });
});
