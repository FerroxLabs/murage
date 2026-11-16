// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// R31 (1.0.19): the bot-delete dialogs show a bot's email address and carry its confirm token.
import { act, createElement as h } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, installDOMHarness, mount, settle } from '../testing/dom-harness';
import { ConfirmDelete, useDeletionPreview } from './ConfirmDelete';
import { ArchivedBotsPanel } from './Sidebar';
import { initialState, type Bot } from '../state/store';

const fixture = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(), state: {} as unknown }));
vi.mock('../state/store', async original => ({ ...await original<typeof import('../state/store')>(), useStore: () => ({ state: fixture.state, dispatch: fixture.dispatch }), api: fixture.api }));

let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => { vi.useFakeTimers(); fixture.dispatch.mockReset(); fixture.api.mockReset(); fixture.state = { ...initialState }; });
afterEach(async () => { cleanup(); await settle(); document.body.replaceChildren(); vi.useRealTimers(); });

const confirmButton = (kind = 'bot') => [...document.querySelectorAll('button')].find(b => b.textContent === `Delete ${kind}`) as HTMLButtonElement;
const typeName = (name: string) => {
  const input = document.querySelector('input') as HTMLInputElement;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { set.call(input, name); input.dispatchEvent(new Event('input', { bubbles: true })); });
};
const click = (el: HTMLElement) => act(() => { el.click(); });
const answer = (body: unknown) => fixture.api.mockResolvedValue(body);
const open = (onConfirm = vi.fn()) => { mount(h(ConfirmDelete, { name: 'Ada', kind: 'bot', detail: 'Gone.', preview: { botId: 'b1' }, onCancel: vi.fn(), onConfirm })); return onConfirm; };
const lineOf = () => [...document.querySelectorAll('p')].map(p => p.textContent).find(t => t?.startsWith('This also removes'));

describe('single bot delete dialog', () => {
  it('parked inbox: shows the exact line and sends the confirm token', async () => {
    answer({ savedFiles: 0, email: { address: 'ada@example.com', confirm: 'tok-1' } });
    const onConfirm = open(); await settle();
    expect(lineOf()).toBe('This also removes ada@example.com.');
    typeName('Ada'); click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ emailConfirm: 'tok-1' });
  });
  it('live address with confirm (r3.2): shows the line and sends the token', async () => {
    answer({ savedFiles: 0, email: { address: 'ada@example.com', confirm: 'tok-live' } });
    const onConfirm = open(); await settle();
    expect(lineOf()).toBe('This also removes ada@example.com.');
    typeName('Ada'); click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith({ emailConfirm: 'tok-live' });
  });
  it('live address without confirm: shows the line, sends no token', async () => {
    answer({ savedFiles: 0, email: { address: 'ada@example.com' } });
    const onConfirm = open(); await settle();
    expect(lineOf()).toBe('This also removes ada@example.com.');
    typeName('Ada'); click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith();
  });
  it('no email: no line, no token', async () => {
    answer({ savedFiles: 0 });
    const onConfirm = open(); await settle();
    expect(lineOf()).toBeUndefined();
    typeName('Ada'); click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith();
  });
  it('Confirm stays disabled until the preview answers', async () => {
    let release!: (v: unknown) => void;
    fixture.api.mockReturnValue(new Promise(r => { release = r; }));
    open(); typeName('Ada');
    expect(confirmButton().disabled).toBe(true);
    release({ savedFiles: 0, email: { address: 'a@b.co', confirm: 't' } }); await settle();
    expect(confirmButton().disabled).toBe(false);
  });
  it('after 3 s Confirm enables with no line and no token', async () => {
    fixture.api.mockReturnValue(new Promise(() => {}));
    const onConfirm = open(); typeName('Ada');
    expect(confirmButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(2999); }); expect(confirmButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(confirmButton().disabled).toBe(false); expect(lineOf()).toBeUndefined();
    click(confirmButton()); expect(onConfirm).toHaveBeenCalledWith();
  });
  it('a late preview after the timeout adds no line and no token', async () => {
    let release!: (v: unknown) => void;
    fixture.api.mockReturnValue(new Promise(r => { release = r; }));
    const onConfirm = open(); typeName('Ada');
    await act(async () => { vi.advanceTimersByTime(3000); });
    release({ savedFiles: 0, email: { address: 'late@example.com', confirm: 'late-tok' } }); await settle();
    expect(lineOf()).toBeUndefined();
    click(confirmButton()); expect(onConfirm).toHaveBeenCalledWith();
  });
  it('a failed preview enables Confirm with no line', async () => {
    fixture.api.mockRejectedValue(new Error('down'));
    const onConfirm = open(); await settle(); typeName('Ada');
    expect(confirmButton().disabled).toBe(false);
    click(confirmButton()); expect(onConfirm).toHaveBeenCalledWith();
  });
  it.each(['<b>x</b>@x.com', 'a&amp;b@x.com', '"q"@x.com', "o'brien@x.com", 'josé@münchen.de', 'xn--bcher-kva@x.com'])('renders %s as literal text', async address => {
    answer({ savedFiles: 0, email: { address } });
    open(); await settle();
    expect(lineOf()).toBe(`This also removes ${address}.`);
    expect(document.querySelector('b')).toBeNull();
  });
});

describe('confirm token presence', () => {
  it('confirm "" is a token: the line shows and "" is sent as given', async () => {
    answer({ savedFiles: 0, email: { address: 'ada@example.com', confirm: '' } });
    const onConfirm = open(); await settle();
    expect(lineOf()).toBe('This also removes ada@example.com.');
    typeName('Ada'); click(confirmButton());
    // MAIN RULING R31-EMPTY-CONFIRM: an empty token is transmitted by presence on every retry.
    expect(onConfirm).toHaveBeenCalledWith({ emailConfirm: '' });
  });
  it('a non-string confirm (number, null) counts as absent', async () => {
    for (const bad of [5, null]) {
      cleanup(); fixture.api.mockReset();
      answer({ savedFiles: 0, email: { address: 'ada@example.com', confirm: bad } });
      const onConfirm = open(); await settle();
      expect(lineOf()).toBe('This also removes ada@example.com.');
      typeName('Ada'); click(confirmButton());
      expect(onConfirm).toHaveBeenCalledWith();
    }
  });
  it('confirm "" without an address shows no line and sends no token', async () => {
    answer({ savedFiles: 0, email: { confirm: '' } });
    const onConfirm = open(); await settle();
    expect(lineOf()).toBeUndefined();
    typeName('Ada'); click(confirmButton());
    expect(onConfirm).toHaveBeenCalledWith();
  });
});

describe('the preview belongs to its target', () => {
  const dialog = (botId: string, onConfirm = vi.fn()) => h(ConfirmDelete, { name: 'Ada', kind: 'bot', detail: 'Gone.', preview: { botId }, onCancel: vi.fn(), onConfirm });
  const inputValue = () => (document.querySelector('input') as HTMLInputElement).value;
  const bySource = () => {
    const pending: Record<string, (v: unknown) => void> = {};
    fixture.api.mockImplementation((url: string) => new Promise(resolve => { pending[new URLSearchParams(url.split('?')[1]).get('botId')!] = resolve; }));
    return pending;
  };

  it('A to B with the same name, B unresolved: no A line, Confirm disabled, typed words cleared, no A token', async () => {
    const pending = bySource();
    const onConfirm = vi.fn();
    const view = mount(dialog('a', onConfirm));
    await act(async () => { pending.a!({ savedFiles: 0, email: { address: 'a@example.com', confirm: 'tok-A' } }); }); await settle();
    expect(lineOf()).toBe('This also removes a@example.com.');
    typeName('Ada'); expect(confirmButton().disabled).toBe(false);
    view.rerender(dialog('b', onConfirm));
    expect(lineOf()).toBeUndefined();
    expect(confirmButton().disabled).toBe(true);
    expect(inputValue()).toBe('');
    typeName('Ada'); expect(confirmButton().disabled).toBe(true);
    act(() => { (document.querySelector('input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { pending.b!({ savedFiles: 0 }); }); await settle();
    expect(confirmButton().disabled).toBe(false);
    click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith();
  });
  it('no render after the switch ever carries the previous target\'s preview', async () => {
    const pending = bySource();
    const seen: Array<{ id: string; email: unknown; ready: boolean; counts: unknown }> = [];
    const Probe = ({ id }: { id: string }) => { const p = useDeletionPreview({ botId: id }); seen.push({ id, email: p.email, ready: p.ready, counts: p.counts }); return null; };
    const view = mount(h(Probe, { id: 'a' }));
    await act(async () => { pending.a!({ savedFiles: 3, email: { address: 'a@example.com', confirm: 'tok-A' } }); }); await settle();
    expect(seen.at(-1)).toMatchObject({ id: 'a', ready: true });
    view.rerender(h(Probe, { id: 'b' }));
    for (const entry of seen.filter(entry => entry.id === 'b')) expect(entry).toEqual({ id: 'b', email: null, ready: false, counts: null });
  });
  it('a late answer for the old target never lands on the new one', async () => {
    const pending = bySource();
    const view = mount(dialog('a'));
    view.rerender(dialog('b'));
    await act(async () => { pending.a!({ savedFiles: 0, email: { address: 'a@example.com', confirm: 'tok-A' } }); }); await settle();
    expect(lineOf()).toBeUndefined();
    expect(confirmButton().disabled).toBe(true);
  });
  it('A to B to A, both new requests unresolved: nothing of the first A shows, input cleared, Confirm disabled until the answer', async () => {
    const calls: Array<{ id: string; resolve: (v: unknown) => void }> = [];
    fixture.api.mockImplementation((url: string) => new Promise(resolve => { calls.push({ id: new URLSearchParams(url.split('?')[1]).get('botId')!, resolve }); }));
    const onConfirm = vi.fn();
    const view = mount(dialog('a', onConfirm));
    await act(async () => { calls[0]!.resolve({ savedFiles: 0, email: { address: 'a@example.com', confirm: 'tok-A' } }); }); await settle();
    typeName('Ada'); expect(confirmButton().disabled).toBe(false);
    view.rerender(dialog('b', onConfirm));
    view.rerender(dialog('a', onConfirm));
    expect(calls).toHaveLength(3);
    expect(lineOf()).toBeUndefined(); expect(inputValue()).toBe('');
    expect(document.body.textContent).not.toContain('a@example.com');
    expect(confirmButton().disabled).toBe(true);
    typeName('Ada'); expect(confirmButton().disabled).toBe(true);
    act(() => { (document.querySelector('input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onConfirm).not.toHaveBeenCalled();
    await act(async () => { calls[2]!.resolve({ savedFiles: 0, email: { address: 'a2@example.com', confirm: 'tok-A2' } }); }); await settle();
    expect(lineOf()).toBe('This also removes a2@example.com.');
    expect(confirmButton().disabled).toBe(false);
    click(confirmButton()); expect(onConfirm).toHaveBeenCalledWith({ emailConfirm: 'tok-A2' });
  });
  it('A to B to A, new request unanswered: the 3 s timeout opens Confirm with no address and no token', async () => {
    answer({ savedFiles: 0, email: { address: 'a@example.com', confirm: 'tok-A' } });
    const onConfirm = vi.fn();
    const view = mount(dialog('a', onConfirm)); await settle(); typeName('Ada');
    fixture.api.mockReset(); fixture.api.mockReturnValue(new Promise(() => {}));
    view.rerender(dialog('b', onConfirm));
    await act(async () => { vi.advanceTimersByTime(2000); });
    view.rerender(dialog('a', onConfirm));
    expect(lineOf()).toBeUndefined(); expect(inputValue()).toBe('');
    typeName('Ada'); expect(confirmButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1500); }); // B's old timer (3000) fires here, and must not touch A
    expect(confirmButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(confirmButton().disabled).toBe(false); expect(lineOf()).toBeUndefined();
    click(confirmButton()); expect(onConfirm).toHaveBeenCalledWith();
  });
  it('a double activation guard belongs to its activation: A, B, A can each send once', async () => {
    answer({ savedFiles: 0 });
    const onConfirm = vi.fn();
    const view = mount(dialog('a', onConfirm)); await settle(); typeName('Ada');
    click(confirmButton()); expect(onConfirm).toHaveBeenCalledTimes(1);
    view.rerender(dialog('b', onConfirm)); await settle();
    view.rerender(dialog('a', onConfirm)); await settle(); typeName('Ada');
    click(confirmButton()); expect(onConfirm).toHaveBeenCalledTimes(2);
  });
  it('close and reopen starts again: no old line, typed words cleared, preview asked again', async () => {
    answer({ savedFiles: 0, email: { address: 'a@example.com', confirm: 'tok-A' } });
    const first = mount(dialog('a')); await settle();
    expect(lineOf()).toBe('This also removes a@example.com.'); typeName('Ada');
    first.unmount();
    fixture.api.mockReset(); fixture.api.mockReturnValue(new Promise(() => {}));
    const onConfirm = vi.fn(); mount(dialog('a', onConfirm));
    expect(fixture.api).toHaveBeenCalledTimes(1);
    expect(lineOf()).toBeUndefined(); expect(inputValue()).toBe('');
    typeName('Ada'); expect(confirmButton().disabled).toBe(true);
    await act(async () => { vi.advanceTimersByTime(3000); });
    click(confirmButton()); expect(onConfirm).toHaveBeenCalledWith();
  });
  it('double activation sends once (two clicks, or Enter plus a click)', async () => {
    answer({ savedFiles: 0, email: { address: 'a@example.com', confirm: 'tok-A' } });
    const onConfirm = vi.fn(); mount(dialog('a', onConfirm)); await settle(); typeName('Ada');
    act(() => { confirmButton().click(); confirmButton().click(); });
    expect(onConfirm).toHaveBeenCalledTimes(1); expect(onConfirm).toHaveBeenCalledWith({ emailConfirm: 'tok-A' });
    const again = vi.fn(); cleanup(); mount(dialog('a', again)); await settle(); typeName('Ada');
    act(() => { (document.querySelector('input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); confirmButton().click(); });
    expect(again).toHaveBeenCalledTimes(1);
  });
});

describe('archived bots panel', () => {
  const bot = (id: string, name: string) => ({ id, name, hidden: true, tasks: [], messages: [], modelSelection: { instanceId: 'x', model: 'm' } }) as unknown as Bot;
  const labelled = (text: string) => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label') === text || b.textContent?.trim() === text) as HTMLButtonElement;
  const panel = (bots: Bot[]) => mount(h(ArchivedBotsPanel, { bots, groups: [], onClose: vi.fn(), onRestored: vi.fn(), onDeleted: vi.fn() }));
  it('single archived delete behaves like single: line shown and token dispatched', async () => {
    answer({ savedFiles: 0, email: { address: 'ada@example.com', confirm: 'tok-2' } });
    panel([bot('b1', 'Ada')]); click(labelled('Delete Ada')); await settle();
    expect(lineOf()).toBe('This also removes ada@example.com.');
    typeName('Ada'); click(confirmButton()); await settle();
    expect(fixture.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'deleteBot', botId: 'b1', archived: true, emailConfirm: 'tok-2' }));
  });
  it('single archived delete with no email sends no token', async () => {
    answer({ savedFiles: 0 });
    panel([bot('b1', 'Ada')]); click(labelled('Delete Ada')); await settle();
    typeName('Ada'); click(confirmButton()); await settle();
    const action = fixture.dispatch.mock.calls[0]![0];
    expect(action.type).toBe('deleteBot'); expect('emailConfirm' in action).toBe(false);
  });
  it('bulk: no preview request, no tokens, one line, every target dispatched', async () => {
    answer({ savedFiles: 0, email: { address: 'x@y.com', confirm: 'nope' } });
    // Every dispatch settles, so the sequential loop reaches every target.
    fixture.dispatch.mockImplementation((action: { onSettled?: (r: { outcome: string }) => void }) => { action.onSettled?.({ outcome: 'deleted' }); });
    const LINE = 'Their email addresses stay until you choose Keep or Remove in Settings.';
    panel([bot('b1', 'Ada'), bot('b2', 'Bo'), bot('b3', 'Cy')]); click(labelled('Delete all 3')); await settle();
    expect(fixture.api).not.toHaveBeenCalled();
    expect(document.body.textContent!.split(LINE)).toHaveLength(2);
    expect(document.body.textContent).not.toContain('This also removes');
    const phrase = document.querySelector('input')!.getAttribute('placeholder')!;
    typeName(phrase); click(confirmButton('3 archived bots')); for (let i = 0; i < 8; i += 1) await settle();
    const calls = fixture.dispatch.mock.calls.map(([action]) => action);
    expect(calls).toHaveLength(3);
    expect(calls.map(action => action.botId)).toEqual(['b1', 'b2', 'b3']);
    for (const action of calls) { expect(action).toMatchObject({ type: 'deleteBot', archived: true, bulk: true }); expect('emailConfirm' in action).toBe(false); }
    expect(fixture.api).not.toHaveBeenCalled();
  });
  it('single archived: a double activation dispatches one Delete', async () => {
    answer({ savedFiles: 0, email: { address: 'ada@example.com', confirm: 'tok-2' } });
    panel([bot('b1', 'Ada')]); click(labelled('Delete Ada')); await settle(); typeName('Ada');
    act(() => { confirmButton().click(); confirmButton().click(); }); await settle();
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
  });
});
