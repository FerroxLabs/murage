// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { installDOMHarness, mount, cleanup, settle, press } from '../../testing/dom-harness';
import HelpAsk, { forgetKeptAsk } from './HelpAsk';
import { initialState } from '../../state/store';
const f = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn(), api: vi.fn(), live: { ended: false } as any }));
vi.mock('../../state/store', async original => ({ ...await original<any>(), useStore: () => ({ state: f.state, dispatch: f.dispatch }), useStreaming: () => ({ streaming: {} }), api: (...args: any[]) => f.api(...args) }));
vi.mock('../../state/turn-status', () => ({ useTurnLive: () => f.live }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); });
afterAll(() => restore());
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); forgetKeptAsk(); f.dispatch.mockReset(); f.api.mockReset();
  f.state = { ...initialState, config: { profile: { email: 'owner' }, turnStateContract: 1, scopedTurnStop: 1, sendActionContract: 1, queueRemovable: true }, bots: [{ id: 'chief', name: 'Dana', chiefOfStaff: true, chiefScope: 'workspace', threadId: 'pinned', messages: [], busy: false }] };
  f.live = { ended: false }; f.api.mockImplementation(async () => word('queued'));
});
afterEach(() => { cleanup(); forgetKeptAsk(); vi.useRealTimers(); });
function word(state: string, extra = {}) { return { contract: 1, botId: 'chief', threadId: 'pinned', sendId: sent()?.sendId, attemptId: 'attempt', receiptRevision: 2, bindingEpoch: 1, queueId: 'q', turnId: null, messageId: null, state, delivery: 'not_submitted', terminalOutcome: null, reason: null, stopGen: null, restoreGen: null, retryAfterMs: null, actions: { remove: true, stop: false, resend: true, openChat: true }, ...extra }; }
const tree = (open = vi.fn()) => h(HelpAsk, { screenTitle: 'Settings', onOpenChat: open });
function type(text: string) { const input = document.querySelector('textarea')!; act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); }); return input; }
const button = (name: string) => [...document.querySelectorAll('button')].find(b => b.textContent === name);
function click(name: string) { const b = button(name); expect(b, `button ${name}`).toBeTruthy(); act(() => b!.click()); }
const sent = () => f.dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'send');
async function ask() { type(' How does this work? '); act(() => document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))); expect(sent()).toBeTruthy(); await act(async () => sent().onReceipt?.({ queued: true, queueId: 'q', sendId: sent().sendId })); await settle(); }
it('UI-INPUT / UI-PREVIEW: exact 1–400 Unicode question and catalogue preview', () => {
  mount(tree()); expect(document.activeElement).toBe(document.querySelector('textarea'));
  type('😀'.repeat(400)); expect(button('Ask')?.disabled).toBe(false);
  type('😀'.repeat(401)); expect(button('Ask')?.disabled).toBe(true);
  type('  first\n second  '); expect(document.querySelector('[data-help-ask-preview]')?.textContent).toContain('first\n second\n\n(Asked from help on the Settings screen.)');
  expect(document.body.textContent).toContain("Your question and this screen's name go to Dana's chat. Its usual memory and permissions apply. Replies count toward usage.");
});
it('UI-KEYBOARD: IME and repeated Enter never submit; plain Enter submits once', async () => {
  mount(tree()); const input = type('question'); press('Enter', input, { isComposing: true }); press('Enter', input, { repeat: true }); expect(sent()).toBeUndefined(); press('Enter', input); press('Enter', input); expect(f.dispatch.mock.calls.filter(c => c[0].type === 'send')).toHaveLength(1); await settle();
});
it('UI-CAP: an old server never receives scoped Stop or Remove', async () => {
  f.state.config = { profile: { email: 'owner' } }; mount(tree()); await ask(); expect(button('Remove from line')).toBeUndefined(); expect(button('Stop')).toBeUndefined(); expect(button('Open in chat')).toBeTruthy();
});
it('UI-EXTERNAL-CANCEL / F7-ML4-ACKED-QUEUED-REMOVE: authoritative cancellation becomes Removed', async () => {
  mount(tree()); await ask(); f.api.mockResolvedValue(word('cancelled', { terminalOutcome: 'removed' })); await act(async () => vi.advanceTimersByTimeAsync(5000)); expect(document.body.textContent).toContain('Removed from the line.'); expect(button('Done')).toBeTruthy();
});
it('F7-ML4-LOSTACK-AFTER-REMOVE: cancelled POST callback becomes Removed', async () => {
  mount(tree()); await ask(); act(() => sent().onReceipt({ queued: false, cancelled: true, failure: 'removed' })); expect(document.body.textContent).toContain('Removed from the line.');
});
it('UI-UNKNOWN: unknown stays unknown after 60 seconds, never Done', async () => {
  f.api.mockImplementation(async () => word('unknown')); mount(tree()); await ask(); await act(async () => vi.advanceTimersByTimeAsync(60001)); expect(document.body.textContent).toContain("We couldn't confirm what happened."); expect(button('Done')).toBeUndefined(); expect(button('Open in chat')).toBeTruthy();
});
it('UI-STALE: a closed Remove error is left to shared action UI, not swallowed', async () => {
  const app = mount(tree()); await ask(); click('Remove from line'); const remove = f.dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'cancelQueued'); expect(remove).toBeTruthy(); app.unmount(); expect(remove.onError(new Error('late failure'))).not.toBe(true);
});
it('UI-F6: handoff preserves the exact pinned bot and thread', async () => {
  const open = vi.fn(); mount(tree(open)); await ask(); click('Open in chat'); expect(open).toHaveBeenCalledWith('chief', 'pinned');
});
it('UI-F5: successful load resets the retry budget on unload', async () => {
  f.state.bots[0].messagesUnloaded = true; const app = mount(tree()); await ask(); await act(async () => vi.advanceTimersByTimeAsync(20000));
  f.state.bots[0].messagesUnloaded = false; app.rerender(tree()); await settle(); const before = f.dispatch.mock.calls.filter(c => c[0].type === 'loadFirstPage').length;
  f.state.bots[0].messagesUnloaded = true; app.rerender(tree()); await settle(); expect(f.dispatch.mock.calls.filter(c => c[0].type === 'loadFirstPage').length).toBeGreaterThan(before);
});
it.each(['started', 'sending', 'missing', 'failed', 'refused', 'cancelled', undefined])('CANCEL-16: Remove 404 %s has its exact meaning', async state => {
  mount(tree()); await ask(); click('Remove from line'); const remove = f.dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'cancelQueued');
  act(() => remove.onError({ status: 404, body: { state } }));
  if (state === 'cancelled') expect(document.body.textContent).toContain('Removed from the line.');
  else { expect(document.body.textContent).not.toContain('Removed from the line.'); expect(button('Open in chat')).toBeTruthy(); }
  await settle();
});

it.each([
  ['failed', 'Your question did not send.', 'Send again'],
  ['refused', 'Your question could not start.', 'Send again'],
  ['submitted_but_failed', 'Your question was sent, but the answer could not finish.', 'Send again'],
  ['stopped', 'Stopped.', 'Done'],
  ['ended', "Saved in Dana's chat.", 'Done'],
  ['approval', 'Dana needs your approval.', 'Open in chat'],
  ['indexing', 'Preparing faster conversation access.', 'Try again'],
])('F4/F6: %s renders the authoritative state and action', async (state, copy, action) => {
  f.api.mockImplementation(async () => word(state, { turnId: 'turn', messageId: 'm' })); mount(tree()); await ask();
  expect(document.body.textContent).toContain(copy); expect(button(action)).toBeTruthy();
});
it('UI-INDEX-RELOAD mounted: maintenance keeps the same question identity across close/reopen and manual retry', async () => {
  f.api.mockImplementation(async () => word('indexing')); const app = mount(tree()); await ask(); const old = sent();
  expect(document.body.textContent).toContain('Your message is saved. Try sending again shortly.'); app.unmount(); mount(tree()); click('Try again');
  const sends = f.dispatch.mock.calls.map(c => c[0]).filter(a => a.type === 'send'); expect(sends).toHaveLength(2);
  expect(sends[1]).toMatchObject({ sendId: old.sendId, text: old.text, noSteer: true }); expect(sends[1].resend).toBeUndefined(); await settle();
});
it('UI-CAP scoped Stop: sends the full immutable tuple and retries exactly after an unconfirmed response', async () => {
  f.api.mockImplementation(async (path: string) => path.includes('interrupt') ? { ok: true } : word('running', { turnId: 'turn', actions: { stop: true, remove: false, resend: false, openChat: true } }));
  mount(tree()); await ask(); click('Stop'); await settle(); expect(document.body.textContent).toContain('Could not confirm it stopped.');
  const requests = () => f.api.mock.calls.filter(c => c[0].includes('interrupt')); const first = requests()[0][1].body;
  expect(JSON.parse(first)).toMatchObject({ contract: 1, threadId: 'pinned', sendId: sent().sendId, attemptId: 'attempt', receiptRevision: 2, bindingEpoch: 1, turnId: 'turn' });
  click('Try again'); await settle(); expect(requests()[1][1].body).toBe(first);
});
it('UI-STALE restamp: Stop cannot paint a newer binding after its await', async () => {
  let finish!: (value: unknown) => void; let epoch = 1;
  f.api.mockImplementation(async (path: string) => path.includes('interrupt') ? new Promise(resolve => { finish = resolve; }) : word('running', { bindingEpoch: epoch, turnId: `turn-${epoch}`, actions: { stop: true, remove: false, resend: false, openChat: true } }));
  const app = mount(tree()); await ask(); click('Stop'); epoch = 2; f.live = { turnId: 'turn-2', ended: false }; app.rerender(tree()); await settle();
  await act(async () => finish({ matched: true, stopped: true, unconfirmed: false, receipt: word('stopped', { bindingEpoch: 1 }) }));
  expect(document.body.textContent).not.toContain('Stopped.');
});
it('UI-KEYBOARD duplicate confirmation defaults to Cancel; a held Enter cannot confirm', async () => {
  f.api.mockImplementation(async () => word('submitted_but_failed', { delivery: 'submitted' })); mount(tree()); await ask(); click('Send again');
  expect(document.activeElement?.textContent).toBe('Cancel'); expect(document.querySelector('[role="dialog"]')?.textContent).toContain('This may send your question twice.');
  const confirm = document.querySelector('[role="dialog"] button:last-child')!; press('Enter', confirm, { repeat: true }); expect(f.dispatch.mock.calls.some(c => c[0].type === 'resendSend')).toBe(false);
  act(() => (confirm as HTMLButtonElement).click()); const resend = f.dispatch.mock.calls.map(c => c[0]).find(a => a.type === 'resendSend'); expect(resend.action.confirmDuplicate).toBe(true); expect(resend.action.sendId).toBe(sent().sendId);
});
it('UI-STALE account: old receipt cannot repaint a new account', async () => {
  const app = mount(tree()); await ask(); const old = sent(); f.state.config.profile.email = 'other'; app.rerender(tree()); await settle();
  act(() => old.onReceipt({ failure: 'removed', cancelled: true })); expect(document.querySelector('textarea')).toBeTruthy(); expect(document.body.textContent).not.toContain('Removed from the line.');
});
