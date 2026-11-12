import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import * as invocations from './approval-invocations.ts';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { contactRecoveryCases as samples } from './testing/contact-recovery-cases.ts';
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
  const dir = mkdtempSync(join(tmpdir(), 'hlf1-f024-')); dirs.push(dir);
  const actionFile = join(dir, 'actions.jsonl');
  const journal = new FileActionJournal(actionFile);
  const actions = new HighLevelActions({ journal });
  const approvalJournal = new FileApprovalJournal(join(dir, 'approvals'));
  const callJournal = new FileApprovalJournal(join(dir, 'calls'));
  const outcomes: HighLevelOutcomeRecord[] = [];
  const deps: HighLevelHostDeps = { ...h, actions, approvalJournal, callJournal, bot: () => h.bot,
    onOutcome: (_claim, row) => { outcomes.push(row); },
    operationScopes: () => ['contacts.readonly', 'contacts.write'], approvalBasis: (_claim, spec) => spec.risk === 'D' ? 'owner_no_limits_attended' : 'owner_no_limits' };
  const host = new HighLevelHost(deps);
  const rpc = (operation: string, args: object, target = host) => target.handle(h.claim,
    { jsonrpc: '2.0', id: 'restart-rpc', method: 'tools/call',
      params: { name: 'HIGHLEVEL_CONTACTS', arguments: { operation, args } } });
  h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200,
    body: { contact: { id: 'contact_1', locationId: FAKE_LOCATION_ID, firstName: 'Reviewed', tags } } });
  return { ...h, dir, actionFile, journal, actions, approvalJournal, callJournal, deps, rpc, outcomes };
}




for (const [verb, args, method, path] of samples) for (const mode of [
  'accepted', 'absent', 'foreign', 'negative',
  ...(['create', 'upsert', 'notes.create', 'tasks.create'].includes(verb) ? ['preexisting', 'ambiguous', 'incomplete', 'missing', 'continuation'] : []),
]) {
  const accepted = mode !== 'absent';
  it(`${verb}: crash after ${method}, ${mode}, durable read-only recovery and cached terminal`, async () => {
    const h = fixture();
    const input = mode === 'continuation' && verb === 'create' ? { firstName: 'Ada' } : args;
    let sent = false, crashed = false;
    const exact = (p: string) => new RegExp(`^${p}$`);
    const serve = (m: string, p: string, reply: () => { status: number; body: unknown }) => {
      const next = () => {
        h.api.first(m, exact(p), next);
        const result = reply();
        if (sent && (m === 'GET' || p === '/contacts/search') && result.status === 200) {
          const body = result.body as Record<string, unknown>;
          if (mode === 'foreign') body.hidden = [{ nested: { contactId: 'foreign_contact' } }];
          if (mode === 'negative') body.hidden = [{ nested: { succeeded: false } }];
          const plural = p === '/contacts/search' ? 'contacts' : p.endsWith('/notes') ? 'notes' : p.endsWith('/tasks') ? 'tasks' : '';
          if (plural && mode === 'continuation') { body[plural] = []; body.total = 0; body.hasMore = true; body.nextCursor = 'more'; }
          if (plural && mode === 'incomplete') { delete body.total; body.nextPage = 'unavailable_cursor'; }
          if (plural && mode === 'ambiguous') { (body[plural] as object[]).push({ ...(body[plural] as object[])[0], id: 'second_match' }); body.total = 2; }
          if (plural && mode === 'missing') { const record = (body[plural] as Record<string, unknown>[])[0]; delete record.firstName; delete record.body; delete record.title; }
        }
        return result;
      };
      h.api.first(m, exact(p), next);
    };
    const changed = () => (sent || mode === 'preexisting') && accepted && !(verb.endsWith('delete') && ['foreign', 'negative'].includes(mode));
    const tags = () => verb === 'tags.remove' ? (changed() ? ['keep'] : ['a', 'keep']) : (changed() ? ['a', 'keep'] : ['keep']);
    const followers = () => verb === 'followers.remove' ? (changed() ? [] : ['u1']) : (changed() ? ['u1'] : []);
    const contact = (id = 'contact_1') => ({ id, locationId: FAKE_LOCATION_ID,
      ...(verb === 'update' ? { firstName: changed() ? 'Reviewed' : 'Before' } : {}),
      ...(verb.startsWith('tags.') ? { tags: tags() } : {}),
      ...(verb.startsWith('followers.') ? { followers: followers() } : {}) });
    for (const id of ['contact_1', 'contact_2']) serve('GET', `/contacts/${id}`, () =>
      verb === 'delete' && changed() ? { status: 404, body: {} } : { status: 200, body: { contact: contact(id) } });
    const note = () => ({ id: 'note_1', contactId: 'contact_1', body: changed() ? 'Reviewed' : 'Before', ...(verb === 'notes.create' ? { userId: 'u1' } : {}) });
    const task = () => ({ id: 'task_1', contactId: 'contact_1', title: changed() ? 'Reviewed' : 'Before', dueDate: '2026-11-20T10:00:00Z', completed: verb === 'tasks.complete' ? changed() : false });
    for (const [plural, singular, record] of [['notes', 'note', note], ['tasks', 'task', task]] as const) {
      serve('GET', `/contacts/contact_1/${plural}`, () => ({ status: 200, body: { [plural]: changed() ? [record()] : [], total: changed() ? 1 : 0 } }));
      serve('GET', `/contacts/contact_1/${plural}/${singular}_1`, () => verb === `${plural}.delete` && changed()
        ? { status: 404, body: {} } : { status: 200, body: { [singular]: record() } });
    }
    serve('POST', '/contacts/search', () => ({ status: 200, body: {
      contacts: changed() ? [{ id: 'new_contact', locationId: FAKE_LOCATION_ID, firstName: 'Reviewed' }] : [], total: changed() ? 1 : 0,
    } }));
    serve(method, path, () => {
      sent = true;
      const body = verb === 'create' || verb === 'upsert' ? { new: true, contact: { id: 'new_contact', firstName: 'Reviewed' } }
        : verb === 'update' ? { contact: { id: 'contact_1', firstName: 'Reviewed' } }
        : verb.endsWith('delete') ? { succeeded: true }
        : verb === 'tags.bulk' ? { succeeded: true, errorCount: 0, contacts: ['contact_1', 'contact_2'] }
        : verb.startsWith('tags.') ? { tags: verb === 'tags.remove' ? ['keep'] : ['a', 'keep'] }
        : verb.startsWith('followers.') ? { followers: ['u1'] }
        : verb.startsWith('notes.') ? { note: note() } : { task: task() };
      return { status: 200, body };
    });
    const put = h.journal.put.bind(h.journal);
    vi.spyOn(h.journal, 'put').mockImplementation(row => { if (crashed) throw new Error('process lost'); put(row); });
    const settle = h.approvalJournal.settle.bind(h.approvalJournal);
    vi.spyOn(h.approvalJournal, 'settle').mockImplementation((...a) => {
      if (a[0].startsWith('contact-recovery:')) return settle(...a);
      crashed = true; throw new Error('process lost before settlement');
    });
    await h.rpc(`contacts.${verb}`, input);
    expect(crashed, 'real write reached the settlement crash boundary').toBe(true);
    const [original] = new FileActionJournal(h.actionFile).all();
    expect(original).toMatchObject({ phase: 'dispatching', dispatchAttempts: 1 });
    const metadata = h.approvalJournal.get(`contact-recovery:${original.approvalId}`);
    expect(metadata).toMatchObject({ state: 'applied' });
    expect(JSON.stringify(metadata)).not.toContain('"Reviewed"');
    expect(JSON.stringify(metadata)).not.toContain('"keep"');
    expect(JSON.stringify(metadata)).not.toContain('2026-11-20T10:00:00Z');
    const count = h.api.requests.length;
    const actions = new HighLevelActions({ journal: new FileActionJournal(h.actionFile) }); actions.recover();
    const approvalJournal = new FileApprovalJournal(join(h.dir, 'approvals'));
    const propose = vi.spyOn(actions, 'propose'), begin = vi.spyOn(actions, 'beginDispatch');
    const host = new HighLevelHost({ ...h.deps, actions, approvalJournal, callJournal: new FileApprovalJournal(join(h.dir, 'calls')) });
    const replay = await h.rpc(`contacts.${verb}`, input, host);
    const expected = mode === 'negative' || (verb === 'followers.remove' && mode === 'accepted') ? 'outcome_unknown' : !['accepted', 'absent'].includes(mode) ? 'outcome_unknown' : accepted ? 'applied' : verb === 'create' || verb === 'upsert' || verb.endsWith('delete') || verb.endsWith('.create') ? 'not_applied' : 'outcome_unknown';
    expect(replay.result).toMatchObject({ structuredContent: { actionId: original.actionId, outcome: expected } });
    expect(h.api.requests.length - count).toBe(verb === 'tags.bulk' ? 2 : 1);
    const after = h.api.requests.length;
    expect(await h.rpc(`contacts.${verb}`, input, host)).toEqual(replay);
    expect(h.api.requests.length).toBe(after);
    expect(h.api.calls(method, exact(path))).toHaveLength(1);
    expect(propose).not.toHaveBeenCalled(); expect(begin).not.toHaveBeenCalled();
    expect(h.api.unexpected).toEqual([]);
  });
}


it.each(['rpc', 'direct'] as const)('%s registers the approval owner before post-approval authority awaits', async route => {
  const h = fixture();
  h.api.always('PUT', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', firstName: 'Reviewed' } } });
  let owned = false, observed = 0;
  const run = invocations.runApprovedInvocation;
  vi.spyOn(invocations, 'runApprovedInvocation').mockImplementation((...args) => {
    owned = true;
    return run(...args);
  });
  const host = new HighLevelHost({ ...h.deps, bot: () => {
    if (h.journal.all().some(row => row.phase === 'approved')) { observed++; expect(owned).toBe(true); }
    return h.bot;
  } });
  const args = { contactId: 'contact_1', firstName: 'Reviewed' };
  const result = route === 'rpc' ? (await h.rpc('contacts.update', args, host)).result
    : await host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: 'contacts.update', args });
  expect(result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(observed).toBeGreaterThan(0);
  expect(h.api.calls('PUT')).toHaveLength(1);
});


for (const [index, [verb]] of samples.entries()) for (const mode of ['accepted', 'absent']) {
  it(`${verb}: fresh-process crash/restart (${mode})`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'contact-process-crash-')); dirs.push(dir);
    const run = (phase: string) => spawnSync(process.execPath, ['--experimental-strip-types',
      'server/highlevel/testing/contact-crash-worker.ts', dir, String(index), mode, phase], { encoding: 'utf8', timeout: 20_000 });
    const send = run('send');
    expect(send.status, send.stderr).toBe(73);
    expect(JSON.parse(readFileSync(join(dir, 'send.json'), 'utf8'))).toEqual({ writes: 1, phase: 'dispatching' });
    const replay = run('replay');
    expect(replay.status, replay.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8'));
    const outcome = mode === 'accepted' ? (verb === 'followers.remove' ? 'outcome_unknown' : 'applied') : ['create', 'upsert'].includes(verb) || verb.endsWith('delete') || verb.endsWith('.create') ? 'not_applied' : 'outcome_unknown';
    expect(report.result.result).toMatchObject({ structuredContent: { outcome } });
    expect(report).toMatchObject({ writes: 0, reads: verb === 'tags.bulk' ? 2 : 1, terminalReads: 0, identical: true, unexpected: 0 });
  }, 45_000);
}


for (const route of ['rpc', 'direct'] as const) for (const change of ['grant', 'stop'] as const) {
  it(`${route}: ${change} after approval and before RPC publication never sends`, async () => {
    const h = fixture();
    const host = new HighLevelHost({ ...h.deps, onReviewClosed: () => {
      if (change === 'stop') h.stop();
      else (h.bot.highlevelAccess as { revision: number }).revision++;
    } });
    const args = { contactId: 'contact_1', firstName: 'Reviewed' };
    const result = route === 'rpc' ? (await h.rpc('contacts.update', args, host)).result
      : await host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: 'contacts.update', args });
    expect(result).toMatchObject({ isError: true });
    expect(h.journal.all()[0].phase).toBe(change === 'stop' ? 'not_applied' : 'stale');
    expect(h.api.calls('PUT')).toHaveLength(0);
  });
}
