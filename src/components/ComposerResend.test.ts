// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { installDOMHarness, mount, cleanup, settle } from '../testing/dom-harness';
import { Composer } from './Composer';
import { initialState, reducer } from '../state/store';
import { createOutbox, createSendDelivery } from '../state/send-delivery';
const f = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn() }));
vi.mock('../state/store', async original => ({ ...await original<any>(), useStore: () => ({ state: f.state, dispatch: f.dispatch }), api: vi.fn(async () => ({})) }));
vi.mock('./PendingApprovalQueue', () => ({ PendingApprovalQueue: () => null }));
vi.mock('./PushToTalk', () => ({ PushToTalk: () => null, browserPushToTalkFacts: () => ({}) }));
let restore: () => void;
beforeAll(() => { restore = installDOMHarness(); window.matchMedia ??= (() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) as any; });
afterAll(() => restore());
beforeEach(() => { f.dispatch.mockReset(); localStorage.clear(); f.state = { ...initialState, config: { sendActionContract: 1 }, bots: [], instances: [], pendingQueued: { t: [{ queueId: 'q', sendId: 'old', text: 'kept words', refused: { notice: 'refused', attemptId: 'a', receiptRevision: 2, bindingEpoch: 1 } }] } }; });
afterEach(() => cleanup());
const bot = { id: 'b', name: 'Dana', threadId: 't', busy: false, messages: [], modelSelection: { instanceId: 'inst' } } as any;
function press(group = false) {
  const app = mount(h(Composer, group ? { group: { ...bot, memberIds: [] } } : { bot }));
  const button = [...app.container.querySelectorAll('button')].find(b => b.textContent?.includes('Send again'));
  expect(button).toBeTruthy(); act(() => button!.click());
  return f.dispatch.mock.calls.map(c => c[0]).find(a => ['resendSend', 'send', 'sendGroup'].includes(a.type));
}
it.each(['FAILED-NO-LINE', 'RESTORE-HELD', 'STOP-HELD'])('F7-COMPOSER-RESEND-%s: press creates a fenced replacement, reconciliation moves the chip', kind => {
  if (kind === 'RESTORE-HELD') f.state.pendingQueued.t[0].refused.restoreGen = 'restore';
  if (kind === 'STOP-HELD') f.state.pendingQueued.t[0].refused.stopGen = 'stop';
  const action = press(); expect(action.type).toBe('resendSend'); expect(action.action).toMatchObject({ contract: 1, sendId: 'old', attemptId: 'a', receiptRevision: 2, bindingEpoch: 1, kind: 'resend', confirmDuplicate: false });
  expect(action.action.replacementSendId).not.toBe('old');
  if (kind === 'RESTORE-HELD') expect(action.action.restoreGen).toBe('restore');
  if (kind === 'STOP-HELD') expect(action.action.stopGen).toBe('stop');
  const next = reducer(f.state, { type: 'sendReplaced', threadId: 't', sendId: 'old', text: 'kept words', result: { replacementSendId: action.action.replacementSendId, replacementAttemptId: 'new-a', receipt: { state: 'queued', queueId: 'new-q' } } } as any);
  expect(next.pendingQueued.t).toEqual([expect.objectContaining({ sendId: action.action.replacementSendId, queueId: 'new-q' })]);
});
it('F7-GROUP-RESEND: room chip uses the same action contract', () => { const action = press(true); expect(action.type).toBe('resendSend'); expect(action.kind).toBe('group'); });
it('F7-COMPOSER-DISMISS GUARD: existing Dismiss still targets the queue', () => {
  const app = mount(h(Composer, { bot })); const b = [...app.container.querySelectorAll('button')].find(b => b.textContent?.includes('Dismiss')); expect(b).toBeTruthy(); act(() => b!.click()); expect(f.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'cancelQueued', botId: 'b', queueId: 'q' }));
});
it('F7-COMPOSER-LOSTACK / RELOAD: persisted action retries byte-identically, including when replacement is already listed', async () => {
  const action = press(); expect(action.type).toBe('resendSend');
  const posts: string[] = []; const actions = new Set<string>(); let turns = 0;
  const post = vi.fn(async (entry: any) => { posts.push(JSON.stringify(entry.sendAction)); if (!actions.has(entry.sendAction.actionId)) { actions.add(entry.sendAction.actionId); turns++; throw Error('lost acknowledgement'); } return { actionId: entry.sendAction.actionId, replacementSendId: entry.sendId, replacementAttemptId: 'new-a', receipt: { state: 'queued', queueId: 'new-q' } }; });
  const build = () => createSendDelivery({ outbox: createOutbox(localStorage), post, now: Date.now, setTimer: () => 0, showSending() {}, settleSending() {}, recover() {}, receipt() {} });
  await build().submit({ sendId: action.action.replacementSendId, kind: 'bot', botId: 'b', threadId: 't', text: 'kept words', sendAction: action.action, at: Date.now(), attempts: 0 } as any);
  expect(createOutbox(localStorage).list()).toHaveLength(1);
  build().reconcile({ messageSendIds: new Set([action.action.replacementSendId]), pendingSendIds: new Set() }); await settle();
  expect(posts).toHaveLength(2); expect(posts[0]).toBe(posts[1]); expect(turns).toBe(1); expect(createOutbox(localStorage).list()).toEqual([]);
});
it('F4 compatibility: unsupported action contract keeps Dismiss and hides the new resend mutation', () => {
  f.state.config = {}; const app = mount(h(Composer, { bot }));
  expect([...app.container.querySelectorAll('button')].some(b => b.textContent?.includes('Send again'))).toBe(false);
  expect([...app.container.querySelectorAll('button')].some(b => b.textContent?.includes('Dismiss'))).toBe(true);
});
