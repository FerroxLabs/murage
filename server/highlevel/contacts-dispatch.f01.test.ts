import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HighLevelHost, highlevelApprovalBasis, type HighLevelOutcomeRecord } from './host.ts';
import { HighLevelError } from './errors.ts';
import { HighLevelActions, reviewDigestFor, type ActionContext } from './actions.ts';
import { botAccessPolicy } from '../bot-access-role.ts';
import { FileActionJournal, parseIntent } from './journal-file.ts';
import { operationSpec } from './operations/registry.ts';
import { highLevelHarness, scriptCrm, until, FAKE_LOCATION_ID } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { highlevelOutcomeLine } from './review-cards.ts';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await removeTempDir(dir); });
function fixture(options: { policy?: boolean; journal?: FileActionJournal } = {}) {
  const h = highLevelHarness({ deadlineMs: 500 }); scriptCrm(h.api);
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), contacts: 'full' } }] } as typeof h.bot.highlevelAccess;
  const actions = options.journal ? new HighLevelActions({ journal: options.journal, now: () => h.now }) : h.actions;
  const outcomes: HighLevelOutcomeRecord[] = [];
  const host = new HighLevelHost({ ...h, actions, bot: () => h.bot,
    operationScopes: () => ['contacts.readonly', 'contacts.write'],
    approvalBasis: (_claim, spec, risk) => highlevelApprovalBasis({ risk, noLimits: options.policy, operation: spec.id }),
    onReview: (_claim, review) => h.reviews.push(review), onOutcome: (_claim, outcome) => outcomes.push(outcome),
  });
  const call = (operation = 'contacts.update', args: Record<string, unknown> = { contactId: 'contact_1', firstName: 'Reviewed' }) => host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation, args });
  const approve = async () => { await until(() => h.reviews.length > 0); const review = h.reviews.shift()!; actions.approve(review.actionId, review.reviewDigest); return review; };
  return { ...h, host, actions, outcomes, call, approve };
}
const contextOf = (row: ActionContext): ActionContext => ({ botId: row.botId, threadId: row.threadId, turnGeneration: row.turnGeneration,
  connectionId: row.connectionId, connectionEpoch: row.connectionEpoch, locationId: row.locationId, companyId: row.companyId,
  grantRevision: row.grantRevision, accessRevision: row.accessRevision, policyRevision: row.policyRevision, roleBinding: row.roleBinding });

for (const [operation, args, key, id] of [
  ['contacts.update', { contactId: 'contact_1', firstName: 'Reviewed' }, 'contact', 'contact_1'],
  ['contacts.notes.update', { contactId: 'contact_1', noteId: 'note_1', body: 'Reviewed' }, 'note', 'note_1'],
  ['contacts.tasks.update', { contactId: 'contact_1', taskId: 'task_1', title: 'Reviewed' }, 'task', 'task_1'],
  ['contacts.tasks.complete', { contactId: 'contact_1', taskId: 'task_1', completed: true }, 'task', 'task_1'],
] as const) {
  it.each(['wrong ID', 'wrong parent', 'valid'])(`registered ${operation}: %s through approved dispatch`, async scenario => {
    const h = fixture();
    if (key !== 'contact') h.api.always('GET', /^\/contacts\/contact_1\/(notes|tasks)\/[^/]+$/, { status: 200, body: { [key]: { id, contactId: 'contact_1' } } });
    h.api.always('PUT', /^\/contacts\//, { status: 200, body: { [key]: { id: scenario === 'wrong ID' ? 'other_record' : id,
      contactId: scenario === 'wrong parent' ? 'other_parent' : 'contact_1', locationId: FAKE_LOCATION_ID, firstName: 'PROVIDER_PRIVATE' } } });
    const pending = h.call(operation, args); const review = await h.approve(); const result = await pending;
    const expected = scenario === 'valid' ? 'applied' : 'outcome_unknown';
    expect(h.actions.get(review.actionId)?.phase).toBe(expected);
    expect(h.api.calls('PUT')).toHaveLength(1); expect(h.outcomes).toHaveLength(1);
    if (scenario !== 'valid') { expect(JSON.stringify(result)).not.toContain('PROVIDER_PRIVATE'); expect(h.actions.get(review.actionId)?.receipt).toBeUndefined(); }
    else expect(h.actions.get(review.actionId)?.receipt?.recordId).toBe(id);
    h.stop();
  });
}
it('approved IDs survive digest, file recovery and outcome separately from the provider ID', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hlf1-journal-')); dirs.push(dir); const path = join(dir, 'actions.jsonl');
  const h = fixture({ journal: new FileActionJournal(path) });
  h.api.first('POST', /^\/contacts\/contact_1\/notes$/, { status: 201, body: { note: { id: 'provider_new_note', contactId: 'contact_1' } } });
  const pending = h.call('contacts.notes.create', { contactId: 'contact_1', body: 'REVIEW_PRIVATE' });
  await until(() => h.reviews.length > 0); const review = h.reviews[0]!; const row = h.actions.get(review.actionId)!;
  expect(review.recordRefs).toEqual(['contact_1']);
  expect(reviewDigestFor({ ...row, recordRefs: ['other_contact'] } as typeof row)).not.toBe(row.reviewDigest);
  await h.approve(); expect((await pending).isError).not.toBe(true);
  const recovered = new HighLevelActions({ journal: new FileActionJournal(path) }); recovered.recover();
  expect(recovered.get(row.actionId)).toMatchObject({ phase: 'applied', recordRefs: ['contact_1'], receipt: { recordId: 'provider_new_note' } });
  expect(parseIntent({ ...recovered.get(row.actionId), unexpected: 'PRIVATE' })).toBeNull();
  expect(readFileSync(path, 'utf8')).not.toContain('REVIEW_PRIVATE');
  expect(h.outcomes[0]).toMatchObject({ recordIds: ['contact_1'], providerRecordIds: ['provider_new_note'] });
  const line = highlevelOutcomeLine(h.outcomes[0]!); expect(line).toContain('Approved records: contact_1'); expect(line).toContain('Provider records: provider_new_note');
  expect(() => recovered.beginDispatch(row.actionId, contextOf(row))).toThrow(); h.stop();
});
it.each([new Error('projection failure'), new HighLevelError('invalid response', { status: 200 })])('post-send projection failure cannot settle applied or leak a receipt: %s', async failure => {
  const h = fixture(); h.api.always('PUT', /^\/contacts\//, { status: 200, body: { contact: { id: 'contact_1' } } });
  // Instrument only the selected hook; preparation, approval, transport and settlement remain production code.
  const selected = operationSpec('contacts.update')!;
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: id => id === selected.id ? { ...selected, project() { throw failure; } } : operationSpec(id),
    operationScopes: () => ['contacts.readonly', 'contacts.write'], onReview: (_claim, review) => h.reviews.push(review) });
  const pending = host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: selected.id, args: { contactId: 'contact_1', firstName: 'Reviewed' } });
  const review = await h.approve(); await pending;
  expect(h.actions.get(review.actionId)).toMatchObject({ phase: 'outcome_unknown', dispatchAttempts: 1 });
  expect(h.actions.get(review.actionId)?.receipt).toBeUndefined(); h.stop();
});
it.each(['grant', 'policy', 'stop'])('post-send %s loss withholds result and never settles applied', async loss => {
  const h = fixture(); h.api.always('PUT', /^\/contacts\//, () => {
    if (loss === 'stop') h.stop();
    else if (loss === 'grant') (h.bot.highlevelAccess as { revision: number }).revision++;
    else h.bot.connectedAppAccess = { ...botAccessPolicy(h.bot), revision: 7 };
    return { status: 200, body: { contact: { id: 'contact_1', firstName: 'PROVIDER_PRIVATE' } } };
  });
  const pending = h.call(); const review = await h.approve(); const result = await pending;
  expect(h.actions.get(review.actionId)?.phase).not.toBe('applied'); expect(JSON.stringify(result)).not.toContain('PROVIDER_PRIVATE');
  expect(h.actions.get(review.actionId)?.receipt).toBeUndefined(); h.stop();
});
it('owner review refuses wrong digest, concurrent calls and authority changes before send', async () => {
  const h = fixture(); const pending = h.call(); await until(() => h.reviews.length > 0); const review = h.reviews[0]!;
  expect(() => h.actions.approve(review.actionId, 'wrong')).toThrow(); expect(h.api.calls('PUT')).toHaveLength(0);
  expect((await h.call()).isError).toBe(true); expect(h.reviews).toHaveLength(1);
  (h.bot.highlevelAccess as { revision: number }).revision++; await h.approve(); await pending;
  expect(h.actions.get(review.actionId)?.phase).toBe('stale'); expect(h.api.calls('PUT')).toHaveLength(0); h.stop();
});
it('policy dispatch sends once without a review and cannot reuse the action', async () => {
  const h = fixture({ policy: true }); h.api.always('PUT', /^\/contacts\//, { status: 200, body: { contact: { id: 'contact_1' } } });
  expect((await h.call()).isError).not.toBe(true); expect(h.reviews).toHaveLength(0); expect(h.api.calls('PUT')).toHaveLength(1);
  const row = h.actions.get(h.outcomes[0]!.actionId)!;
  expect(() => h.actions.beginDispatch(row.actionId, contextOf(row))).toThrow(); expect(row.basis).toBe('owner_no_limits'); h.stop();
});
it('timeout and restart/replay preserve one attempt and require a new review', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hlf1-timeout-')); dirs.push(dir); const path = join(dir, 'actions.jsonl');
  const h = fixture({ journal: new FileActionJournal(path) }); h.api.always('PUT', /^\/contacts\//, 'timeout');
  const pending = h.call(); const review = await h.approve(); await pending;
  expect(h.actions.get(review.actionId)).toMatchObject({ phase: 'outcome_unknown', dispatchAttempts: 1 });
  const recovered = new HighLevelActions({ journal: new FileActionJournal(path) }); recovered.recover(); const row = recovered.get(review.actionId)!;
  expect(row.phase).toBe('outcome_unknown'); expect(() => recovered.approve(row.actionId, row.reviewDigest)).toThrow();
  expect(() => recovered.beginDispatch(row.actionId, contextOf(row))).toThrow(); expect(h.api.calls('PUT')).toHaveLength(1); h.stop();
});
it('applied cannot overwrite stale or another terminal decision', async () => {
  const h = fixture(); const pending = h.call(); await until(() => h.reviews.length > 0); const review = h.reviews[0]!;
  h.actions.markStale(review.actionId, 'request_changed'); await pending;
  h.actions.applied(review.actionId, { recordId: 'forged', fields: [] });
  expect(h.actions.get(review.actionId)?.phase).toBe('stale'); h.stop();
});
it('concurrent dispatch and an in-flight duplicate cannot send the same action twice', async () => {
  const h = fixture(); let release!: () => void;
  const response = new Promise<void>(resolve => { release = resolve; });
  h.api.always('PUT', /^\/contacts\//, async () => { await response; return { status: 200, body: { contact: { id: 'contact_1' } } }; });
  const pending = h.call(); const review = await h.approve();
  await until(() => h.api.calls('PUT').length === 1);
  const row = h.actions.get(review.actionId)!;
  expect(() => h.actions.beginDispatch(row.actionId, contextOf(row))).toThrow();
  expect((await h.call()).isError).toBe(true); expect(h.api.calls('PUT')).toHaveLength(1);
  release(); expect((await pending).isError).not.toBe(true); expect(h.outcomes).toHaveLength(1); h.stop();
});
