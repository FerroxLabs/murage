// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { createElement as h, useRef } from 'react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { LazyOverlay } from './LazyOverlay';
import { useLayerContainer } from './LayerSlot';
import { BotSettingsPane } from './BotSettingsPane';
import { openLayer } from '../lib/focus-trap';
const fixture = vi.hoisted(() => ({
  bots: [{ id: "nova", name: "Nova" }, { id: "pepper", name: "Pepper" }] as Array<Record<string, unknown>>,
  dispatch: vi.fn(),
}));
vi.mock("@/state/store", async (original) => ({
  ...(await original<typeof import("@/state/store")>()),
  useStore: () => ({ state: { config: null, bots: fixture.bots, botSettingsIntent: null }, dispatch: fixture.dispatch }),
  api: vi.fn(async () => { throw new Error("no network in this test"); }),
}));
vi.mock("@/lib/use-surface", async (original) => ({ ...(await original<typeof import("@/lib/use-surface")>()), useDesktopSurface: () => true }));
vi.mock("@/lib/bot-email", async (original) => ({ ...(await original<typeof import("@/lib/bot-email")>()), useEmailStatus: () => ({ kind: "off" }) }));
vi.mock("./SettingsPanel", () => ({ SettingsPanel: () => null }));
vi.mock("@/lib/learning-counts", async (original) => ({ ...(await original<typeof import("@/lib/learning-counts")>()), useLearningBadge: () => 0 }));


let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); });
function Window() {
  const ref = useRef<HTMLDivElement>(null);
  useLayerContainer(ref, { initialFocus: null, holdFocus: false });
  return h('div', { ref }, h(BotSettingsPane, { bot: fixture.bots[0] as never, onClose: vi.fn() }), h('button', { id: 'elsewhere' }, 'Elsewhere'));
}
const render = () => h(LazyOverlay, { name: 'settings', kind: 'window', covers: 'always', onDismiss: vi.fn(), onRetry: vi.fn() }, h(Window));
it('R2b/BF-23: bot search focuses once in active Settings and leaves later focus alone', () => {
  const app = mount(render());
  expect(document.activeElement).toBe(document.querySelector('#bot-settings-search'));
  const other = document.querySelector<HTMLButtonElement>('#elsewhere')!; other.focus();
  app.rerender(render()); expect(document.activeElement).toBe(other);
});
it('R2b/BF-23: bot search cannot steal focus from a higher palette', () => {
  const b = document.createElement('button'); document.body.append(b); b.focus();
  const upper = openLayer({ id: 'upper', name: 'palette', kind: 'palette', openingSequence: 999999, returnFocusTo: b });
  try { mount(render()); expect(document.activeElement).toBe(b); } finally { upper.release(); }
});
