// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { createElement as h } from 'react';
import { createPortal } from 'react-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { focusableWithin, trapFocus } from '../lib/focus-trap';

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterEach(cleanup);
afterAll(() => restore());

describe('DOM harness smoke / BF-17', () => {
  it('mounts, rerenders, focuses and bubbles real cancelable portal keys', async () => {
    const bubble = vi.fn((e: KeyboardEvent) => e.preventDefault());
    document.addEventListener('keydown', bubble);
    const portal = document.createElement('div');
    document.body.append(portal);
    const app = mount(createPortal(h('button', null, 'first'), portal));
    const button = portal.querySelector('button')!;
    button.focus();
    expect(document.activeElement).toBe(button);
    const event = press('Escape', button);
    expect(event.bubbles).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(bubble).toHaveBeenCalledOnce();
    app.rerender(createPortal(h('button', null, 'second'), portal));
    await settle();
    expect(portal.textContent).toBe('second');
    app.unmount();
    expect(portal.childElementCount).toBe(0);
    portal.remove();
    document.removeEventListener('keydown', bubble);
  });

  it('R5-M5: hidden and collapsed visibility keep their boxes in the shim; production policy drops them', () => {
    const app = mount(h('div', { id: 'controls' },
      h('button', { id: 'start' }, 'start'),
      h('div', { style: { visibility: 'hidden' } }, h('button', { id: 'ghost' }, 'ghost')),
      h('button', { id: 'own', style: { visibility: 'collapse' } }, 'own'),
      h('div', { style: { visibility: 'hidden' } }, h('button', { id: 'shown', style: { visibility: 'visible' } }, 'shown')),
      h('button', { id: 'end' }, 'end')));
    const root = app.container.firstElementChild as HTMLElement;
    for (const id of ['ghost', 'own']) expect(document.getElementById(id)!.getClientRects().length).toBe(1);
    expect(focusableWithin(root).map(e => (e as HTMLElement).id)).toEqual(['start', 'shown', 'end']);
    app.unmount();
  });
  it('R22-DETAILS: models every closed ancestor, first summary and hidden ancestry', () => {
    const app = mount(h('div', { id: 'controls' },
      h('button', { id: 'start' }, 'start'),
      h('details', null,
        h('summary', { id: 'summary' }, 'summary', h('button', { id: 'summary-child' }, 'child')),
        h('summary', { id: 'later' }, 'later'),
        h('button', { id: 'folded' }, 'folded'),
        h('details', { open: true }, h('summary', null, 'nested'), h('button', { id: 'nested' }, 'nested'))),
      h('div', { hidden: true }, h('button', { id: 'hidden' }, 'hidden')),
      h('div', { style: { display: 'none' } }, h('button', null, 'display')),
      h('button', { disabled: true, id: 'disabled' }, 'disabled'),
      h('button', { id: 'end' }, 'end')));
    const root = app.container.firstElementChild as HTMLElement;
    const ids = () => focusableWithin(root).map(e => (e as HTMLElement).id);
    expect(ids()).toEqual(['start', 'summary', 'summary-child', 'end']);
    expect(document.querySelector('#disabled')!.getClientRects().length).toBe(1);
    const trap = trapFocus(root);
    (document.querySelector('#end') as HTMLElement).focus();
    expect(press('Tab').defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('start');
    press('Tab', document.activeElement!, { shiftKey: true });
    expect(document.activeElement?.id).toBe('end');
    const details = root.querySelector('details')!;
    details.open = true;
    expect(ids()).toContain('folded');
    details.querySelector('details')!.open = false;
    expect(ids()).not.toContain('nested');
    details.open = false;
    expect(ids()).not.toContain('nested');
    trap.release();
    app.unmount();
    expect(root.getClientRects().length).toBe(0);
  });
});

it('R3b closed details excludes content even when Chromium reports its layout boxes', () => {
  const app = mount(h('div', null,
    h('details', null, h('summary', { id: 'first-summary' }, 'Summary', h('button', { id: 'summary-button' }, 'Action')),
      h('button', { id: 'folded-content' }, 'Folded'),
      h('details', { open: true }, h('summary', null, 'Nested'), h('button', { id: 'nested-content' }, 'Nested')))));
  const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList);
  try {
    expect(focusableWithin(app.container).map(node => (node as HTMLElement).id)).toEqual(['first-summary', 'summary-button']);
    const details = app.container.querySelector('details')!;
    details.id = 'details-root'; details.tabIndex = 0;
    expect(focusableWithin(app.container).map(node => (node as HTMLElement).id)).toEqual(['details-root', 'first-summary', 'summary-button']);
    details.open = true;
    expect(focusableWithin(app.container).map(node => (node as HTMLElement).id)).toContain('nested-content');
  } finally { rects.mockRestore(); }
});
