// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// 1.0.20: the phone composer's + opens a bottom sheet of Camera, Photos and Files. The REAL ComposerPlusMenu and the REAL
// Composer are mounted in jsdom; a phone is a narrow viewport on a remote surface, the level sheet's own test. Nothing here
// reads source text. The file intake is the one thing wrapped: a spy that delegates, to see which files reach it.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, press, settle } from '../testing/dom-harness';
import { activeTrapCount } from '../lib/focus-trap';
import { initialState, type Bot } from '../state/store';
import { Composer } from './Composer';
import { ComposerPlusMenu } from './ComposerPlusMenu';

const fixture = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn(), surface: 'remote' as 'remote' | 'desktop', intake: [] as Array<readonly File[]> }));
vi.mock('../state/store', async (original) => ({
  ...(await original<typeof import('../state/store')>()),
  useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch, refreshAfterKey: vi.fn() }),
  api: vi.fn(async () => ({})),
}));
vi.mock('../lib/surface', async (original) => ({
  ...(await original<typeof import('../lib/surface')>()),
  knownSurface: () => fixture.surface,
  surface: async () => fixture.surface,
}));
vi.mock('./DesktopCapabilities', async (original) => ({
  ...(await original<typeof import('./DesktopCapabilities')>()),
  useDesktopCapabilities: () => ({ capabilities: { dictation: { available: false }, host: { platform: 'darwin' } } }),
}));
vi.mock('./PendingApprovalQueue', () => ({ PendingApprovalQueue: () => null }));
vi.mock('./PushToTalk', () => ({ PushToTalk: () => null, browserPushToTalkFacts: () => ({}) }));
vi.mock('../lib/composer-intake', async (original) => {
  const real = await original<typeof import('../lib/composer-intake')>();
  return { ...real, composerFileIntake: (input: Parameters<typeof real.composerFileIntake>[0]) => { fixture.intake.push([...input.files] as File[]); return real.composerFileIntake(input); } };
});

let restore: () => void;
const setViewport = (narrow: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({ matches: narrow && query.includes('max-width'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  fixture.state = { ...initialState, instances: [], bots: [] };
  fixture.dispatch.mockReset();
  fixture.surface = 'remote';
  fixture.intake.length = 0;
  setViewport(true);
});
afterEach(async () => {
  cleanup();
  await settle();
  expect(activeTrapCount()).toBe(0);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const plus = () => document.querySelector<HTMLButtonElement>('[data-composer-plus]')!;
const sheet = () => document.querySelector<HTMLElement>('[data-composer-plus-sheet]');
const row = (id: string) => document.querySelector<HTMLButtonElement>(`[data-composer-plus-row="${id}"]`)!;
const rowIds = () => [...document.querySelectorAll('[data-composer-plus-row]')].map((el) => el.getAttribute('data-composer-plus-row'));
const open = async () => { await act(async () => { plus().click(); }); await settle(); };
const sources = () => ({ camera: vi.fn(), photos: vi.fn(), files: vi.fn() });
const approval = (marker = 'LEVEL-CONTROL') => ({ current: 'Ask', renderMenu: (done: () => void) => h('button', { 'data-level-control': '', onClick: done }, marker) });
const mountMenu = (props: Partial<Parameters<typeof ComposerPlusMenu>[0]> = {}) => mount(h(ComposerPlusMenu, { onAttach: vi.fn(), sources: sources(), ...props }));

describe('the + on a phone opens a sheet', () => {
  it('names the sheet by its title and lists Camera, Photos, Files in order, then Finish together and Approval level', async () => {
    mountMenu({ goal: { on: false, onToggle: vi.fn() }, approval: approval() });
    expect(plus().getAttribute('aria-haspopup')).toBe('dialog');
    expect(plus().getAttribute('aria-expanded')).toBe('false');
    await open();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('h2')!.textContent).toBe('Add to your message');
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2')!.id);
    expect(rowIds()).toEqual(['camera', 'photos', 'files', 'goal', 'approval']);
    expect(row('camera').textContent).toBe('CameraTake a photo');
    expect(row('photos').textContent).toBe('PhotosChoose from your photos');
    expect(row('files').textContent).toBe('FilesChoose a file');
    expect(plus().getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('keeps every row a real button of at least 44 px and drops Finish together outside a room', async () => {
    mountMenu({ approval: approval() });
    await open();
    expect(rowIds()).toEqual(['camera', 'photos', 'files', 'approval']);
    for (const el of document.querySelectorAll<HTMLButtonElement>('[data-composer-plus-row]')) {
      expect(el.tagName).toBe('BUTTON');
      expect(el.type).toBe('button');
      expect(el.className).toContain('min-h-14');
      expect(el.className).toContain('focus-visible:ring-2');
    }
  });

  it('starts each picker inside the tap itself and closes the sheet', async () => {
    const s = sources();
    mountMenu({ sources: s });
    for (const id of ['camera', 'photos', 'files'] as const) {
      await open();
      act(() => { row(id).click(); });
      // synchronous: no await or timer stands between the tap and the picker
      expect(s[id]).toHaveBeenCalledTimes(1);
      await settle();
      expect(sheet()).toBeNull();
      expect(document.activeElement).toBe(plus());
    }
    expect([s.camera, s.photos, s.files].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it('disables all three source rows while attaching is disabled, and starts nothing', async () => {
    const s = sources();
    mountMenu({ sources: s, attachDisabled: true, approval: approval() });
    await open();
    for (const id of ['camera', 'photos', 'files']) expect(row(id).disabled).toBe(true);
    expect(row('approval').disabled).toBe(false);
    act(() => { row('camera').click(); row('photos').click(); row('files').click(); });
    expect(s.camera).not.toHaveBeenCalled();
    expect(s.photos).not.toHaveBeenCalled();
    expect(s.files).not.toHaveBeenCalled();
    expect(sheet()).not.toBeNull();
  });

  it('closes on Escape, on Close and on the backdrop, each handing focus back to the +', async () => {
    mountMenu();
    await open();
    press('Escape');
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(plus());
    await open();
    act(() => { document.querySelector<HTMLButtonElement>('[data-phone-sheet-close]')!.click(); });
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(plus());
    await open();
    act(() => { document.querySelector('[data-phone-sheet-backdrop]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(plus());
  });

  it('exposes Finish together as a pressed button that toggles the goal', async () => {
    const onToggle = vi.fn();
    mountMenu({ goal: { on: true, onToggle } });
    await open();
    expect(row('goal').getAttribute('aria-pressed')).toBe('true');
    expect(row('goal').textContent).toContain('Finish together');
    expect(row('camera').hasAttribute('aria-pressed')).toBe(false);
    act(() => { row('goal').click(); });
    expect(onToggle).toHaveBeenCalledTimes(1);
    await settle();
    expect(sheet()).toBeNull();
  });

  it('shows Finish together as not pressed when the goal is off', async () => {
    mountMenu({ goal: { on: false, onToggle: vi.fn() } });
    await open();
    expect(row('goal').getAttribute('aria-pressed')).toBe('false');
  });

  it('opens the same level control the menu opens when Approval level is chosen, and its Done returns focus to the +', async () => {
    mountMenu({ approval: approval() });
    await open();
    expect(row('approval').textContent).toContain('Approval level');
    expect(row('approval').textContent).toContain('Ask');
    act(() => { row('approval').click(); });
    await settle();
    expect(sheet()).toBeNull();
    const control = document.querySelector<HTMLButtonElement>('[data-composer-approval-panel] [data-level-control]')!;
    expect(control.textContent).toBe('LEVEL-CONTROL');
    act(() => { control.click(); });
    await settle();
    expect(document.querySelector('[data-composer-approval-panel]')).toBeNull();
    expect(document.activeElement).toBe(plus());
  });
});

describe('off a phone the + is the menu it was', () => {
  const asMenu = async (narrow: boolean, surface: 'remote' | 'desktop') => {
    setViewport(narrow);
    fixture.surface = surface;
    const s = sources();
    const onAttach = vi.fn();
    mountMenu({ sources: s, onAttach, goal: { on: false, onToggle: vi.fn() }, approval: approval() });
    expect(plus().getAttribute('aria-haspopup')).toBe('menu');
    await open();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(sheet()).toBeNull();
    const items = [...document.querySelectorAll('[role="menu"] [data-header-menu-item]')].map((el) => el.getAttribute('data-header-menu-item'));
    expect(items).toEqual(['attach', 'goal', 'approval']);
    act(() => { document.querySelector<HTMLButtonElement>('[data-header-menu-item="attach"]')!.click(); });
    expect(onAttach).toHaveBeenCalledTimes(1);
    expect(s.camera).not.toHaveBeenCalled();
  };
  it('keeps the menu in a narrowed desktop window', async () => { await asMenu(true, 'desktop'); });
  it('keeps the menu in a wide window', async () => { await asMenu(false, 'remote'); });
  it('keeps the menu when the sheet has no pickers to offer', async () => {
    mountMenu({ sources: undefined });
    expect(plus().getAttribute('aria-haspopup')).toBe('menu');
  });
});

let botSeq = 0;
const bot = () => ({ id: `bot${++botSeq}`, name: 'Fixture', threadId: 'th1', busy: false, messages: [], modelSelection: { instanceId: 'inst1' } }) as unknown as Bot;
const input = (name: string) => document.querySelector<HTMLInputElement>(`input[type="file"][${name}]`)!;
const filesInput = () => [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')].find((el) => !el.hasAttribute('data-composer-camera-input') && !el.hasAttribute('data-composer-photos-input'))!;
const choose = async (el: HTMLInputElement, files: File[]) => {
  Object.defineProperty(el, 'files', { configurable: true, value: files });
  await act(async () => { el.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle();
};

describe('the composer wires the three pickers to one intake', () => {
  it('on a phone has a camera input, a photos input and today\'s files input, with exactly their attributes', async () => {
    mount(h(Composer, { bot: bot() }));
    const camera = input('data-composer-camera-input');
    const photos = input('data-composer-photos-input');
    const files = filesInput();
    expect(camera.getAttribute('accept')).toBe('image/*');
    expect(camera.getAttribute('capture')).toBe('environment');
    expect(camera.multiple).toBe(false);
    expect(photos.getAttribute('accept')).toBe('image/*');
    expect(photos.hasAttribute('capture')).toBe(false);
    expect(photos.multiple).toBe(true);
    expect(files.hasAttribute('accept')).toBe(false);
    expect(files.hasAttribute('capture')).toBe(false);
    expect(files.multiple).toBe(true);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(3);
  });

  it('opens the matching input from each sheet row, inside the tap', async () => {
    mount(h(Composer, { bot: bot() }));
    const clicked: HTMLInputElement[] = [];
    vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) { clicked.push(this); });
    for (const [id, target] of [['camera', input('data-composer-camera-input')], ['photos', input('data-composer-photos-input')], ['files', filesInput()]] as const) {
      await open();
      clicked.length = 0;
      act(() => { row(id).click(); });
      expect(clicked).toEqual([target]);
      await settle();
      expect(sheet()).toBeNull();
    }
  });

  it('sends a file chosen in any of the three inputs to the same intake, then clears the input and refocuses the draft', async () => {
    mount(h(Composer, { bot: bot() }));
    const cases: Array<[HTMLInputElement, File[]]> = [
      [input('data-composer-camera-input'), [new File(['a'], 'shot.jpg', { type: 'image/jpeg' })]],
      [input('data-composer-photos-input'), [new File(['b'], 'one.png', { type: 'image/png' }), new File(['c'], 'two.png', { type: 'image/png' })]],
      [filesInput(), [new File(['d'], 'notes.txt', { type: 'text/plain' })]],
    ];
    for (const [el, files] of cases) {
      fixture.intake.length = 0;
      const value = vi.spyOn(el, 'value', 'set');
      await choose(el, files);
      expect(fixture.intake).toHaveLength(1);
      expect(fixture.intake[0]!.map((file) => file.name)).toEqual(files.map((file) => file.name));
      expect(value).toHaveBeenCalledWith('');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
      expect(document.activeElement).toBe(document.querySelector('textarea'));
      (document.activeElement as HTMLElement).blur();
    }
  });

  it('draws no extra input on the desktop', async () => {
    fixture.surface = 'desktop';
    setViewport(false);
    mount(h(Composer, { bot: bot() }));
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(document.querySelector('[data-composer-camera-input]')).toBeNull();
    expect(document.querySelector('[data-composer-plus]')).toBeNull();
  });
});

describe('phone picker availability and lifetime', () => {
  const androidApp = 'Mozilla/5.0 (Linux; Android 14; wv) MurageApp/1.0.0 (android)';
  const androidBrowser = 'Mozilla/5.0 (Linux; Android 14) Chrome/121.0.0.0';
  const iosApp = 'Mozilla/5.0 (iPhone) MurageApp/1.0.0 (ios)';

  it.each([
    [androidApp, ['photos', 'files', 'approval']],
    [androidBrowser, ['camera', 'photos', 'files', 'approval']],
    [iosApp, ['camera', 'photos', 'files', 'approval']],
  ] as const)('offers only supported pickers for %s', async (userAgent, expected) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    mount(h(Composer, { bot: bot() }));
    await open();
    expect(rowIds()).toEqual(expected);
    const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    act(() => { row('photos').click(); });
    expect(clicked.mock.contexts).toEqual([input('data-composer-photos-input')]);
  });

  it('keeps the original Camera and Photos inputs connected through rotation and accepts the pending pick', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(iosApp);
    const media = Object.assign(new EventTarget(), { matches: true });
    const coarse = Object.assign(new EventTarget(), { matches: true });
    vi.stubGlobal('matchMedia', (query: string) => query.includes('max-width') ? media : coarse);
    mount(h(Composer, { bot: bot() }));
    const camera = input('data-composer-camera-input');
    const photos = input('data-composer-photos-input');
    await open();
    const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    act(() => { row('photos').click(); });
    expect(clicked.mock.contexts).toEqual([photos]);
    act(() => { media.matches = false; media.dispatchEvent(new Event('change')); });
    await settle();
    expect(plus()).toBeNull();
    expect(camera?.isConnected).toBe(true);
    expect(photos?.isConnected).toBe(true);
    expect(input('data-composer-camera-input')).toBe(camera);
    expect(input('data-composer-photos-input')).toBe(photos);
    const photo = new File(['photo'], 'rotated.png', { type: 'image/png' });
    await choose(photos, [photo]);
    expect(fixture.intake).toEqual([[photo]]);
  });

  it('offers Files when the selected engine reports that it cannot receive images', async () => {
    fixture.state.instances = [{ instanceId: 'inst1', capabilities: { images: false } }];
    mount(h(Composer, { bot: bot() }));
    await open();
    expect(rowIds()).toEqual(['files', 'approval']);
    const clicked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    act(() => { row('files').click(); });
    expect(clicked.mock.contexts).toEqual([filesInput()]);
  });
});
