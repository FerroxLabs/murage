// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { ProjectBoardDialog } from './ProjectBoardDialog';
import { activeTrapCount } from '../lib/focus-trap';
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
afterEach(async () => { cleanup(); await settle(); expect(activeTrapCount()).toBe(0); document.body.replaceChildren(); });
it.each(['New project', 'Close project', 'End project'])('F1 %s returns focus to its explicit opener after Escape and Close', async title => {
  for (const action of ['escape', 'close']) {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    const returned = vi.fn(); opener.addEventListener('focus', returned);
    let app: ReturnType<typeof mount>; const onClose = vi.fn(() => app.unmount());
    app = mount(h(ProjectBoardDialog, { title, children: null, native: title !== 'New project', onClose, returnFocusRef: { current: opener } }));
    const root = document.querySelector<HTMLElement>('dialog, [role="dialog"]')!;
    const button = root.querySelector('button')!; button.focus();
    if (action === 'close') act(() => button.click());
    else if (root instanceof HTMLDialogElement) act(() => root.dispatchEvent(new Event('cancel', { cancelable: true })));
    else press('Escape', button);
    await settle(); expect(onClose).toHaveBeenCalledOnce(); expect(document.activeElement).toBe(opener); expect(returned).toHaveBeenCalledOnce();
    opener.remove();
  }
});
it('F1 preserves connected prior focus for other board dialogs', async () => {
  const prior = document.createElement('button'); document.body.append(prior); prior.focus();
  const app = mount(h(ProjectBoardDialog, { title: 'Card', children: null, onClose: vi.fn() }));
  document.querySelector<HTMLButtonElement>('dialog button')!.focus();
  app.unmount(); await settle(); expect(document.activeElement).toBe(prior);
});
