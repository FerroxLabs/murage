import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HighLevelHost, type HighLevelHostDeps } from './host.ts';
import { FileRpcApprovalJournal as FileApprovalJournal } from './rpc-approval-replay.ts';
import { highLevelHarness, scriptCrm, FAKE_LOCATION_ID } from '../testing/fake-highlevel.ts';
import { forgetAllTurnMarks, turnEmailDerived } from '../email/external-marks.ts';
import { removeTempDir } from '../testing/cleanup.ts';
const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(async () => { vi.restoreAllMocks(); forgetAllTurnMarks(); for (const stop of stops.splice(0)) stop(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });
function fixture() {
  const h = highLevelHarness({ deadlineMs: 100 }); scriptCrm(h.api); stops.push(h.stop);
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), contacts: 'full' } }] } as typeof h.bot.highlevelAccess;
  const dir = mkdtempSync(join(tmpdir(), 'hlf1-f02-')); dirs.push(dir);
  const approvalJournal = new FileApprovalJournal(join(dir, 'approvals'));
  const callJournal = new FileApprovalJournal(join(dir, 'calls'));
  const deps = { ...h, approvalJournal, callJournal, bot: () => h.bot, operationScopes: () => ['contacts.readonly', 'contacts.write'], approvalBasis: () => 'owner_no_limits' as const,
    onReview: (_claim: unknown, review: { actionId: string; reviewDigest: string }) => h.actions.approve(review.actionId, review.reviewDigest) };
  const host = new HighLevelHost(deps as HighLevelHostDeps);
  const rpc = (id = 'rpc-1', operation = 'contacts.create', args: object = { firstName: 'Reviewed' }, target = host) => target.handle(h.claim, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'HIGHLEVEL_CONTACTS', arguments: { operation, args } } });
  return { ...h, approvalJournal, callJournal, deps, host, rpc };
}
it.each(['applied', 'timeout'])('same RPC after %s and host recreation never sends again', async mode => {
  const h = fixture(); h.api.always('POST', /^\/contacts\/$/, mode === 'timeout' ? 'timeout' : { status: 201, body: { contact: { id: 'new_contact', firstName: 'Reviewed' } } });
  const first = await h.rpc();
  expect(first.result).toMatchObject(mode === 'applied' ? { structuredContent: { outcome: 'applied' } } : { isError: true, structuredContent: { outcome: 'outcome_unknown' } });
  const again = await h.rpc(); const restored = await h.rpc('rpc-1', 'contacts.create', { firstName: 'Reviewed' }, new HighLevelHost(h.deps));
  expect(again).toEqual(first); expect(restored).toEqual(first); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});
it('concurrent identical RPCs share the approved write', async () => {
  const h = fixture(); h.api.always('POST', /^\/contacts\/$/, { status: 201, body: { contact: { id: 'new_contact' } } });
  const [one, two] = await Promise.all([h.rpc(), h.rpc()]);
  expect(two).toEqual(one); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});
it('changed arguments under the same RPC cannot create a fresh approval', async () => {
  const h = fixture(); h.api.always('POST', /^\/contacts\/$/, { status: 201, body: { contact: { id: 'new_contact' } } });
  await h.rpc(); const changed = await h.rpc('rpc-1', 'contacts.create', { firstName: 'Changed' });
  expect(changed.result).toMatchObject({ isError: true }); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});
it.each([
  ['nested parent', { note: { id: 'note_1', contact: { contactId: 'other_parent' } } }, 'outcome_unknown', 'identity_conflict'],
  ['related identity', { note: { id: 'note_1', ignored: [{ userId: 'other_user' }] } }, 'outcome_unknown', 'identity_conflict'],
  ['nested negative', { note: { id: 'note_1', ignored: [{ success: false }] } }, 'not_applied', 'negative_confirmation'],
] as const)('%s is withheld and journaled through registered dispatch', async (_label, body, phase, reason) => {
  const h = fixture(); h.api.always('GET', /^\/contacts\/contact_1\/notes\/note_1$/, { status: 200, body: { note: { id: 'note_1', contactId: 'contact_1' } } });
  h.api.always('PUT', /^\/contacts\/contact_1\/notes\/note_1$/, { status: 200, body });
  const applied = vi.spyOn(h.actions, 'applied');
  const result = await h.rpc('note-rpc', 'contacts.notes.update', { contactId: 'contact_1', noteId: 'note_1', body: 'Reviewed' });
  expect(result.result).toMatchObject({ isError: true, structuredContent: { outcome: phase } }); expect(applied).not.toHaveBeenCalled();
  const proposed = (result.result as { structuredContent: { actionId: string } }).structuredContent.actionId;
  const row = h.actions.get(proposed)!; expect(row.phase).toBe(phase);
  expect(h.approvalJournal.get(row.approvalId!)).toMatchObject({ state: 'conflict', reason });
});
it('pending approval reconciles by GET and never resends', async () => {
  const h = fixture();
  const approve = h.actions.approveByPolicy.bind(h.actions);
  vi.spyOn(h.actions, 'approveByPolicy').mockImplementation((...args) => { const row = approve(...args); h.approvalJournal.claim(row.approvalId!, row.requestDigest); return row; });
  h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', locationId: FAKE_LOCATION_ID, firstName: 'Reviewed' } } });
  const begin = vi.spyOn(h.actions, 'beginDispatch');
  await h.rpc('pending-rpc', 'contacts.update', { contactId: 'contact_1', firstName: 'Reviewed' });
  expect(h.api.calls('PUT')).toHaveLength(0); expect(begin).not.toHaveBeenCalled();
  expect(h.api.calls('GET').length).toBeGreaterThanOrEqual(3);
});
it('current authority is required for a terminal replay', async () => {
  const h = fixture(); h.api.always('POST', /^\/contacts\/$/, { status: 201, body: { contact: { id: 'new_contact', firstName: 'PRIVATE_RESULT' } } });
  await h.rpc(); (h.bot.highlevelAccess as { revision: number }).revision++;
  expect(JSON.stringify(await h.rpc())).not.toContain('PRIVATE_RESULT'); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});

const writes: Array<[string, Record<string, unknown>, string, RegExp, unknown]> = [
  ['create', { firstName: 'Reviewed' }, 'POST', /^\/contacts\/$/, { contact: { id: 'new_contact' } }],
  ['upsert', { firstName: 'Reviewed' }, 'POST', /^\/contacts\/upsert$/, { new: true, contact: { id: 'new_contact' } }],
  ['update', { contactId: 'contact_1', firstName: 'Reviewed' }, 'PUT', /^\/contacts\/contact_1$/, { contact: { id: 'contact_1' } }],
  ['delete', { contactId: 'contact_1' }, 'DELETE', /^\/contacts\/contact_1$/, { succeeded: true }],
  ['tags.add', { contactId: 'contact_1', tags: ['a'] }, 'POST', /^\/contacts\/contact_1\/tags$/, { tags: ['vip', 'newsletter', 'a'] }],
  ['tags.remove', { contactId: 'contact_1', tags: ['a'] }, 'DELETE', /^\/contacts\/contact_1\/tags$/, { tags: ['vip', 'newsletter'] }],
  ['tags.bulk', { contacts: ['contact_1'], type: 'add', tags: ['a'] }, 'POST', /^\/contacts\/bulk\/tags\/update\/add$/, { succeeded: true, errorCount: 0, contacts: ['contact_1'] }],
  ['notes.create', { contactId: 'contact_1', body: 'Reviewed' }, 'POST', /^\/contacts\/contact_1\/notes$/, { note: { id: 'new_note', contactId: 'contact_1' } }],
  ['notes.update', { contactId: 'contact_1', noteId: 'note_1', body: 'Reviewed' }, 'PUT', /^\/contacts\/contact_1\/notes\/note_1$/, { note: { id: 'note_1', contactId: 'contact_1' } }],
  ['notes.delete', { contactId: 'contact_1', noteId: 'note_1' }, 'DELETE', /^\/contacts\/contact_1\/notes\/note_1$/, { succeeded: true }],
  ['tasks.create', { contactId: 'contact_1', title: 'Reviewed', dueDate: '2026-11-20T10:00:00Z' }, 'POST', /^\/contacts\/contact_1\/tasks$/, { task: { id: 'new_task', contactId: 'contact_1' } }],
  ['tasks.update', { contactId: 'contact_1', taskId: 'task_1', title: 'Reviewed' }, 'PUT', /^\/contacts\/contact_1\/tasks\/task_1$/, { task: { id: 'task_1' } }],
  ['tasks.complete', { contactId: 'contact_1', taskId: 'task_1', completed: true }, 'PUT', /^\/contacts\/contact_1\/tasks\/task_1\/completed$/, { task: { id: 'task_1', completed: true } }],
  ['tasks.delete', { contactId: 'contact_1', taskId: 'task_1' }, 'DELETE', /^\/contacts\/contact_1\/tasks\/task_1$/, { succeeded: true }],
  ['followers.add', { contactId: 'contact_1', followers: ['u1'] }, 'POST', /^\/contacts\/contact_1\/followers$/, { followers: ['u1'], followersAdded: ['u1'] }],
  ['followers.remove', { contactId: 'contact_1', followers: ['u1'] }, 'DELETE', /^\/contacts\/contact_1\/followers$/, { followers: ['u1'], followersRemoved: ['u1'] }],
];
it.each(writes)('%s uses the durable approval gate before dispatch and settlement, including replay', async (verb, args, method, path, body) => {
  const h = fixture();
  h.api.always('GET', /^\/contacts\/contact_1\/notes\/note_1$/, { status: 200, body: { note: { id: 'note_1', contactId: 'contact_1' } } });
  h.api.always('GET', /^\/contacts\/contact_1\/tasks\/task_1$/, { status: 200, body: { task: { id: 'task_1', contactId: 'contact_1' } } });
  h.api.first(method, path, { status: 200, body });
  const begin = h.actions.beginDispatch.bind(h.actions);
  const gate = vi.spyOn(h.actions, 'beginDispatch').mockImplementation((actionId, context) => {
    const intent = h.actions.get(actionId)!;
    expect(h.approvalJournal.get(intent.approvalId!)).toMatchObject({ state: 'pending', requestDigest: intent.requestDigest });
    return begin(actionId, context);
  });
  const apply = h.actions.applied.bind(h.actions);
  const settle = vi.spyOn(h.actions, 'applied').mockImplementation((actionId, receipt) => {
    const intent = h.actions.get(actionId)!;
    expect(h.approvalJournal.get(intent.approvalId!)).toMatchObject({ state: 'applied' });
    apply(actionId, receipt);
  });
  const first = await h.rpc(verb, `contacts.${verb}`, args);
  expect(first.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(await h.rpc(verb, `contacts.${verb}`, args)).toEqual(first);
  expect(gate).toHaveBeenCalledTimes(1); expect(settle).toHaveBeenCalledTimes(1); expect(h.api.calls(method, path)).toHaveLength(1);
});
it('wrong follower sets cannot reach settlement or appear on replay', async () => {
  const h = fixture(); h.api.always('POST', /^\/contacts\/contact_1\/followers$/, { status: 200, body: { followers: [], followersAdded: ['u2'] } });
  const result = await h.rpc('followers', 'contacts.followers.add', { contactId: 'contact_1', followers: ['u1'] });
  expect(result.result).toMatchObject({ isError: true, structuredContent: { outcome: 'outcome_unknown' } });
  expect(JSON.stringify(result)).not.toContain('u2');
  expect(await h.rpc('followers', 'contacts.followers.add', { contactId: 'contact_1', followers: ['u1'] })).toEqual(result);
  expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});
it('a terminal approval reused by a new invocation returns its original result without beginDispatch', async () => {
  const h = fixture();
  const approve = h.actions.approve.bind(h.actions);
  vi.spyOn(h.actions, 'approveByPolicy').mockImplementation((actionId) => approve(actionId, h.actions.get(actionId)!.reviewDigest, 'stable-approval'));
  h.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_contact' } } });
  const begin = vi.spyOn(h.actions, 'beginDispatch');
  const first = await h.rpc('first');
  // The first create is now visible. Reusing its approval must retain the
  // original recovery metadata, not rebuild it from this newer collection.
  h.api.first('POST', /^\/contacts\/search$/, { status: 200, body: {
    contacts: [{ id: 'contact_1' }, { id: 'new_contact' }], total: 2,
  } });
  const second = await h.rpc('second');
  expect(second.result).toEqual(first.result); expect(begin).toHaveBeenCalledTimes(1); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});
it('approval journal failure refuses before dispatch', async () => {
  const h = fixture(); vi.spyOn(h.approvalJournal, 'claim').mockImplementation(() => { throw new Error('journal unavailable'); });
  const begin = vi.spyOn(h.actions, 'beginDispatch'); await h.rpc();
  expect(begin).not.toHaveBeenCalled(); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(0);
});
it('failure to persist the applied approval withholds settlement and never resends on RPC replay', async () => {
  const h = fixture(); h.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_contact' } } });
  const persist = h.approvalJournal.settle.bind(h.approvalJournal);
  vi.spyOn(h.approvalJournal, 'settle').mockImplementation((...args) => { if (args[0].startsWith('contact-recovery:')) return persist(...args); throw new Error('disk failure'); });
  const settle = vi.spyOn(h.actions, 'applied');
  const first = await h.rpc(); expect(first.result).toMatchObject({ isError: true });
  expect(await h.rpc()).toEqual(first); expect(settle).not.toHaveBeenCalled(); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});
it('persisted approval after action-publication failure returns its original result after host recreation', async () => {
  const h = fixture(); h.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_contact' } } });
  const fault = vi.spyOn(h.actions, 'applied').mockImplementation(() => { throw new Error('crash boundary'); });
  expect((await h.rpc()).result).toMatchObject({ isError: true }); fault.mockRestore();
  const propose = vi.spyOn(h.actions, 'propose');
  expect((await h.rpc('rpc-1', 'contacts.create', { firstName: 'Reviewed' }, new HighLevelHost(h.deps))).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(propose).not.toHaveBeenCalled(); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});
it.each(['identity', 'negative'])('pending reconciliation uses the same raw-response gate: %s', async kind => {
  const h = fixture();
  const approve = h.actions.approveByPolicy.bind(h.actions);
  vi.spyOn(h.actions, 'approveByPolicy').mockImplementation((...args) => {
    const row = approve(...args); h.approvalJournal.claim(row.approvalId!, row.requestDigest);
    h.api.first('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', locationId: FAKE_LOCATION_ID }, hidden: [{ ...(kind === 'identity' ? { contactId: 'wrong' } : { succeeded: false }) }] } });
    return row;
  });
  const result = await h.rpc('pending', 'contacts.update', { contactId: 'contact_1', firstName: 'Reviewed' });
  const { actionId } = (result.result as { structuredContent: { actionId: string } }).structuredContent;
  expect(h.approvalJournal.get(h.actions.get(actionId)!.approvalId!)).toMatchObject({ state: 'conflict', reason: kind === 'identity' ? 'identity_conflict' : 'unconfirmed' });
  expect(h.api.calls('PUT')).toHaveLength(0);
});
it('approval replay cannot release a result approved under an older authority context', async () => {
  const h = fixture();
  const approve = h.actions.approve.bind(h.actions);
  vi.spyOn(h.actions, 'approveByPolicy').mockImplementation(actionId => approve(actionId, h.actions.get(actionId)!.reviewDigest, 'same-approval'));
  h.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_contact', firstName: 'PRIVATE_OLD_AUTHORITY' } } });
  await h.rpc('first'); (h.bot.highlevelAccess as { revision: number }).revision++;
  const replay = await h.rpc('second'); expect(replay.result).toMatchObject({ isError: true });
  expect(JSON.stringify(replay)).not.toContain('PRIVATE_OLD_AUTHORITY'); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});

it('terminal RPC replay restores the CRM outside-content mark after host recreation', async () => {
  const h = fixture(); h.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_contact' } } });
  const first = await h.rpc(); forgetAllTurnMarks();
  const replay = await h.rpc('rpc-1', 'contacts.create', { firstName: 'Reviewed' }, new HighLevelHost(h.deps));
  expect(replay).toEqual(first); expect(turnEmailDerived(h.claim.threadId)).toBe(true); expect(h.api.calls('POST').filter(call => call.path !== '/contacts/search')).toHaveLength(1);
});

it('a pending approval alias cannot replace its original authority context', async () => {
  const h = fixture();
  const approve = h.actions.approve.bind(h.actions);
  vi.spyOn(h.actions, 'approveByPolicy').mockImplementation(actionId => approve(actionId, h.actions.get(actionId)!.reviewDigest, 'pending-authority'));
  h.api.always('POST', /^\/contacts\/$/, { status: 200, body: { contact: { id: 'new_contact' } } });
  const persist = h.approvalJournal.settle.bind(h.approvalJournal);
  const crash = vi.spyOn(h.approvalJournal, 'settle').mockImplementation((...args) => {
    if (args[0].startsWith('contact-recovery:')) return persist(...args);
    throw new Error('crash after POST');
  });
  await h.rpc('original');
  crash.mockRestore();
  h.actions.recover(); // Restart releases the old dispatching action from the open-review slot.
  expect(h.approvalJournal.get('pending-authority')).toMatchObject({ state: 'pending' });
  (h.bot.highlevelAccess as { revision: number }).revision++;
  const reads = h.api.calls('POST', /^\/contacts\/search$/).length;
  expect((await h.rpc('new-alias')).result).toMatchObject({ isError: true });
  expect(h.approvalJournal.get('pending-authority')).toMatchObject({ state: 'pending' });
  // Preparation may read under the new authority; it must not recover the old approval.
  expect(h.api.calls('POST', /^\/contacts\/search$/).length - reads).toBe(1);
  expect(h.api.calls('POST', /^\/contacts\/$/)).toHaveLength(1);
});

it.each(['contacts.create', 'contacts.upsert'])('RULE-A %s reaches exact approval with an incomplete contact page', async operation => {
  const h = fixture();
  h.api.first('POST', /^\/contacts\/search$/, { status: 200, body: { contacts: Array.from({ length: 50 }, (_, i) => ({ id: `old_${i}`, locationId: FAKE_LOCATION_ID })), total: 5000, nextPage: true } });
  const path = operation === 'contacts.create' ? /^\/contacts\/$/ : /^\/contacts\/upsert$/;
  h.api.always('POST', path, { status: 201, body: { contact: { id: 'new_contact', firstName: 'Reviewed' }, ...(operation.endsWith('upsert') ? { new: true } : {}) } });
  const reviews: unknown[] = [];
  const host = new HighLevelHost({ ...h.deps, approvalBasis: () => 'owner_exact_review', onReview: (_claim, review) => { reviews.push(review); h.actions.approve(review.actionId, review.reviewDigest); } });
  expect((await h.rpc('large-location', operation, { firstName: 'Reviewed' }, host)).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(reviews).toHaveLength(1); expect(h.api.calls('POST', path)).toHaveLength(1);
  await h.rpc('large-location', operation, { firstName: 'Reviewed' }, new HighLevelHost({ ...h.deps }));
  expect(h.api.calls('POST', path)).toHaveLength(1);
});
it('RULE-A incomplete-baseline crash recovery stays unknown and never resends', async () => {
  const h = fixture();
  h.api.always('POST', /^\/contacts\/search$/, { status: 200, body: { contacts: [], total: 5000, nextPage: true } });
  h.api.always('POST', /^\/contacts\/$/, { status: 201, body: { contact: { id: 'new_contact', firstName: 'Reviewed' } } });
  const settle = h.approvalJournal.settle.bind(h.approvalJournal);
  let crashed = false;
  vi.spyOn(h.approvalJournal, 'settle').mockImplementation((...args) => {
    if (args[0].startsWith('contact-recovery:')) return settle(...args);
    if (!crashed) { crashed = true; throw Error('crash after provider acceptance'); }
    return settle(...args);
  });
  await h.rpc(); expect(h.api.calls('POST', /^\/contacts\/$/)).toHaveLength(1);
  h.actions.recover();
  const host = new HighLevelHost(h.deps as HighLevelHostDeps);
  const replay = await h.rpc('rpc-1', 'contacts.create', { firstName: 'Reviewed' }, host);
  expect(replay.result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
  expect(h.api.calls('POST', /^\/contacts\/$/)).toHaveLength(1);
  expect(await h.rpc('rpc-1', 'contacts.create', { firstName: 'Reviewed' }, host)).toEqual(replay);
});
