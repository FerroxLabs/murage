import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HighLevelHost, type HighLevelHostDeps, type HighLevelOutcomeRecord } from './host.ts';
import { HighLevelActions } from './actions.ts';
import { FileActionJournal } from './journal-file.ts';
import { FileRpcApprovalJournal as FileApprovalJournal } from './rpc-approval-replay.ts';
import { highLevelHarness, FAKE_LOCATION_ID } from '../testing/fake-highlevel.ts';
import { forgetAllTurnMarks } from '../email/external-marks.ts';
import { removeTempDir } from '../testing/cleanup.ts';

const dirs: string[] = [];
const stops: Array<() => void> = [];
afterEach(async () => {
  vi.restoreAllMocks(); forgetAllTurnMarks();
  for (const stop of stops.splice(0)) stop();
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

function fixture(tags: unknown = []) {
  const h = highLevelHarness(); stops.push(h.stop);
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2,
    grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), contacts: 'full' } }] } as typeof h.bot.highlevelAccess;
  const dir = mkdtempSync(join(tmpdir(), 'hlf1-f022-')); dirs.push(dir);
  const actionFile = join(dir, 'actions.jsonl');
  const journal = new FileActionJournal(actionFile);
  const actions = new HighLevelActions({ journal });
  const approvalJournal = new FileApprovalJournal(join(dir, 'approvals'));
  const callJournal = new FileApprovalJournal(join(dir, 'calls'));
  const outcomes: HighLevelOutcomeRecord[] = [];
  const deps: HighLevelHostDeps = { ...h, actions, approvalJournal, callJournal, bot: () => h.bot,
    onOutcome: (_claim, row) => { outcomes.push(row); },
    operationScopes: () => ['contacts.readonly', 'contacts.write'], approvalBasis: () => 'owner_no_limits' };
  const host = new HighLevelHost(deps);
  const rpc = (operation: string, args: object, target = host) => target.handle(h.claim,
    { jsonrpc: '2.0', id: 'restart-rpc', method: 'tools/call',
      params: { name: 'HIGHLEVEL_CONTACTS', arguments: { operation, args } } });
  h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200,
    body: { contact: { id: 'contact_1', locationId: FAKE_LOCATION_ID, firstName: 'Reviewed', tags } } });
  return { ...h, dir, actionFile, journal, actions, approvalJournal, callJournal, deps, rpc, outcomes };
}

it.each([
  ['pending', 'matching'], ['applied', 'matching'], ['pending', 'different'],
  ['pending', 'foreign'], ['pending', 'negative'], ['pending', 'revoked'],
] as const)('contact crash restart replays the original %s approval (%s) without a new write', async (state, read) => {
  const h = fixture();
  h.api.always('PUT', /^\/contacts\/contact_1$/, { status: 200,
    body: { contact: { id: 'contact_1', firstName: 'Reviewed' } } });
  let crashed = false;
  // Cut durable storage at the real post-send approval-publication boundary.
  // Subsequent error handling cannot advance any journal past that crash prefix.
  const put = h.journal.put.bind(h.journal);
  vi.spyOn(h.journal, 'put').mockImplementation(row => { if (crashed) throw new Error('crashed'); put(row); });
  const settle = h.approvalJournal.settle.bind(h.approvalJournal);
  vi.spyOn(h.approvalJournal, 'settle').mockImplementation((...args) => {
    if (args[0].startsWith('contact-recovery:')) return settle(...args);
    if (state === 'applied') settle(...args);
    crashed = true; throw new Error('crashed before RPC publication');
  });
  vi.spyOn(h.callJournal, 'settle').mockImplementation(() => { throw new Error('crashed'); });
  const args = { contactId: 'contact_1', firstName: 'Reviewed' };
  await h.rpc('contacts.update', args);
  expect(crashed).toBe(true);
  const [original] = new FileActionJournal(h.actionFile).all();
  expect(original).toMatchObject({ phase: 'dispatching', dispatchAttempts: 1 });
  expect(h.approvalJournal.get(original.approvalId!)).toMatchObject({ state });
  const reads = h.api.calls('GET').length;

  // No original action store, retained request, or journal instance survives.
  const actions = new HighLevelActions({ journal: new FileActionJournal(h.actionFile) }); actions.recover();
  const approvalJournal = new FileApprovalJournal(join(h.dir, 'approvals'));
  const callJournal = new FileApprovalJournal(join(h.dir, 'calls'));
  const propose = vi.spyOn(actions, 'propose');
  const begin = vi.spyOn(actions, 'beginDispatch');
  if (read === 'revoked') (h.bot.highlevelAccess as { revision: number }).revision++;
  else if (read !== 'matching') h.api.first('GET', /^\/contacts\/contact_1$/, { status: 200, body: {
    contact: { id: 'contact_1', locationId: FAKE_LOCATION_ID, firstName: read === 'different' ? 'Not reviewed' : 'Reviewed' },
    ...(read === 'foreign' ? { hidden: [{ contactId: 'wrong' }] } : {}),
    ...(read === 'negative' ? { hidden: [{ succeeded: false }] } : {}),
  } });
  const host = new HighLevelHost({ ...h.deps, actions, approvalJournal, callJournal });
  const replay = await h.rpc('contacts.update', args, host);
  expect.soft(actions.get(original.actionId)?.approvalId).toBe(original.approvalId);
  expect.soft(h.api.calls('GET').length - reads).toBe(state === 'pending' && read !== 'revoked' ? 1 : 0);
  if (read === 'revoked') {
    expect(replay.result).toMatchObject({ isError: true });
    expect(approvalJournal.get(original.approvalId!)).toMatchObject({ state: 'pending' });
  } else {
    const outcome = read === 'matching' ? 'applied' : 'outcome_unknown';
    expect.soft(replay.result).toMatchObject({ structuredContent: { actionId: original.actionId, outcome } });
    expect.soft(approvalJournal.get(original.approvalId!)).toMatchObject(read === 'matching' ? { state: 'applied' } : {
      state: 'conflict', reason: read === 'foreign' ? 'identity_conflict' : 'unconfirmed',
    });
    expect.soft(actions.get(original.actionId)?.phase).toBe(outcome);
  }
  expect(await h.rpc('contacts.update', args, host)).toEqual(replay);
  expect(propose).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
  expect(h.api.calls('PUT')).toHaveLength(1);
  expect(h.api.unexpected).toEqual([]);
});

it.each([
  ['add', 'POST', [], ['a']], ['remove', 'DELETE', ['a'], []],
  ['add', 'POST', ['keep'], ['a', 'keep']], ['remove', 'DELETE', ['a', 'keep'], ['keep']],
] as const)('tags.%s accepts the frozen tags-only provider response through real dispatch and replay', async (verb, method, before, tags) => {
  const h = fixture(before);
  h.api.always(method, /^\/contacts\/contact_1\/tags$/, { status: 200, body: { tags } });
  const args = { contactId: 'contact_1', tags: ['a'] };
  const first = await h.rpc(`contacts.tags.${verb}`, args);
  expect(first.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  const [action] = h.journal.all();
  expect(action.phase).toBe('applied');
  expect(h.approvalJournal.get(action.approvalId!)).toMatchObject({ state: 'applied' });
  expect(await h.rpc(`contacts.tags.${verb}`, args, new HighLevelHost(h.deps))).toEqual(first);
  expect(h.api.calls(method)).toHaveLength(1);
  expect(h.outcomes).toHaveLength(1);
  expect(h.outcomes[0]).toMatchObject({ outcome: 'applied', actionId: action.actionId });
});

it.each(['add', 'remove'] as const)('tags.%s still checks hidden identities and negative confirmations', async verb => {
  for (const [hidden, outcome] of [[{ contactId: 'wrong' }, 'outcome_unknown'], [{ succeeded: false }, 'not_applied']] as const) {
    const h = fixture();
    h.api.always(verb === 'add' ? 'POST' : 'DELETE', /^\/contacts\/contact_1\/tags$/, {
      status: 200, body: { tags: verb === 'add' ? ['a'] : [], hidden: [{ nested: hidden }] },
    });
    const applied = vi.spyOn(h.actions, 'applied');
    const result = await h.rpc(`contacts.tags.${verb}`, { contactId: 'contact_1', tags: ['a'] });
    expect(result.result).toMatchObject({ isError: true, structuredContent: { outcome } });
    expect(applied).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('wrong');
  }
});
