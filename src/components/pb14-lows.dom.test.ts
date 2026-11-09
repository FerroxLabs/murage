// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// PULLBACK-1018 Lows (Fable seat 2): (a) the Escape helpers use b12's IME rule, (b) three native dialogs register with the
// layer engine, (c) lives in pb14-drawer-escape.dom.test.ts (the mounted Sidebar).
import { createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { activeTrapCount, openLayers } from '../lib/focus-trap';
import { drawerTakesEscape, escapeIsFree, escapePassesModals, overlayTakesEscape } from '../lib/escape-layer';
import { AnnouncementDialog } from './Announcements';
import { FilesDialog } from './FilesDialog';
import { InboxDialog } from './InboxDialog';

vi.mock('@/state/store', () => ({
  api: vi.fn(),
  useStore: () => ({ state: { bots: [], routineRuns: [] }, dispatch: vi.fn() }),
}));
vi.mock('./Files', () => ({ Files: () => h('div', null, 'Files fixture'), artifactNativeAction: vi.fn() }));
vi.mock('./Inbox', () => ({ Inbox: () => h('div', null, 'Inbox fixture') }));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); });

describe('pb14 (a): Escape helpers follow the IME rule (isComposing or keyCode 229)', () => {
  const ime = { key: 'Escape', defaultPrevented: false, isComposing: false, keyCode: 229 };
  it('escapeIsFree ignores a keyCode 229 Escape', () => { expect(escapeIsFree(ime, undefined)).toBe(false); expect(escapeIsFree({ ...ime, keyCode: 27 }, undefined)).toBe(true); });
  it('escapePassesModals and drawerTakesEscape ignore a keyCode 229 Escape', () => {
    expect(escapePassesModals(ime, undefined)).toBe(false); expect(drawerTakesEscape(ime, undefined)).toBe(false);
    expect(escapePassesModals({ ...ime, keyCode: 27 }, undefined)).toBe(true);
  });
  it('overlayTakesEscape ignores a keyCode 229 Escape', () => { expect(overlayTakesEscape(ime)).toBe(false); expect(overlayTakesEscape({ ...ime, keyCode: 27 })).toBe(true); });
});

describe('pb14 (b): native dialogs register with the layer engine', () => {
  const item = { id: 'a1', kind: 'important', title: 'Fixture', body: 'Body', accent: 'blue' } as never;
  it('AnnouncementDialog', async () => {
    mount(h(AnnouncementDialog, { item, imageUrl: undefined, onAct: vi.fn(), onDismiss: vi.fn() } as never));
    await settle(); expect(openLayers()).toHaveLength(1); expect(openLayers()[0].kind).toBe('native');
  });
  it('FilesDialog', async () => {
    mount(h(FilesDialog, { onClose: vi.fn() } as never));
    await settle(); expect(openLayers()).toHaveLength(1); expect(openLayers()[0].kind).toBe('native');
  });
  it('InboxDialog', async () => {
    mount(h(InboxDialog, { onClose: vi.fn() }));
    await settle(); expect(openLayers()).toHaveLength(1); expect(openLayers()[0].kind).toBe('native');
  });
});

