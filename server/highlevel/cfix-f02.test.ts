import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import * as registry from './operations/registry.ts';
import { createHighLevelRuntime } from './runtime.ts';
import { FileRpcApprovalJournal as FileApprovalJournal } from './rpc-approval-replay.ts';
import { HighLevelActions } from './actions.ts';
import { FileActionJournal } from './journal-file.ts';
import { HighLevelHost } from './host.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import { highLevelHarness, until } from '../testing/fake-highlevel.ts';
import { fixtureReadSpec, fixtureSpec } from '../testing/highlevel-r4-fixtures.ts';
import { removeTempDir } from '../testing/cleanup.ts';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); });
function fixture(response: unknown = { contact: { id: 'contact_1', firstName: 'safe' } }, policy = false) {
  const h = highLevelHarness({ deadlineMs: 1000 });
  const dir = mkdtempSync(join(tmpdir(), 'hlc2-f02-'));
  cleanups.push(() => { h.stop(); removeTempDir(dir); });
  const approvalJournal = new FileApprovalJournal(join(dir, 'approvals'));
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')) });
  const access: any = h.bot.highlevelAccess; access.grantsVersion = 2; access.grants[0].families = { ...defaultHighLevelFamilies(), contacts: 'full' }; access.grants[0].operations = {};
  const project = vi.fn((v: any) => ({ id: v.contact.id }));
  const recordId = vi.fn((v: any) => v.contact.id);
  const spec = fixtureSpec({ id: 'contacts.update', family: 'contacts', risk: 'C', title: 'Update', nested: false, preflight: ['contacts.get'],
    args: z.object({ contactId: z.string() }).strict(), recordRefs: (a: any) => [a.contactId], fields: () => ['firstName'], targets: () => 1, project, recordId,
  }, a => ({ path: `/contacts/${a.contactId}`, resource: '', body: { kind: 'json', value: { firstName: 'safe' } } }));
  h.api.always('PUT', /^\/contacts\/contact_1$/, { status: 200, body: response });
  h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', firstName: 'safe' } } });
  const deps = { ...h, actions, approvalJournal, bot: () => h.bot, operationSpec: (id: string) => id === spec.id ? spec : fixtureReadSpec(id), operationScopes: () => [spec.endpoint.scope],
    approvalBasis: () => policy ? 'owner_no_limits' as const : 'owner_exact_review' as const,
    onReview: (_claim: unknown, r: any) => { h.reviews.push(r); actions.approve(r.actionId, r.reviewDigest); } };
  const host = new HighLevelHost(deps);
  const message = { jsonrpc: '2.0', id: 'tool-call-1', method: 'tools/call', params: { name: 'HIGHLEVEL_CONTACTS', arguments: { operation: spec.id, args: { contactId: 'contact_1' } } } };
  const call = (target = host) => target.handle(h.claim, message);
  return { ...h, dir, approvalJournal, actions, spec, project, recordId, deps, host, message, call };
}
it.each([false, true])('owner/policy=%s records pending before beginDispatch and applied before settlement', async policy => {
  const f = fixture(undefined, policy);
  const begin = f.actions.beginDispatch.bind(f.actions), applied = f.actions.applied.bind(f.actions);
  vi.spyOn(f.actions, 'beginDispatch').mockImplementation((id, context) => {
    const row = f.actions.get(id)!;
    expect(f.approvalJournal.get(row.approvalId!)).toMatchObject({ state: 'pending', requestDigest: row.requestDigest });
    return begin(id, context);
  });
  vi.spyOn(f.actions, 'applied').mockImplementation((id, receipt) => {
    expect(f.approvalJournal.get(f.actions.get(id)!.approvalId!)).toMatchObject({ state: 'applied' });
    applied(id, receipt);
  });
  const result: any = (await f.call()).result;
  expect(result.structuredContent).toMatchObject({ outcome: 'applied' });
  expect(f.api.calls('PUT')).toHaveLength(1);
});
it.each([
  { contact: { id: 'contact_1' }, hidden: [{ nested: { contactId: 'wrong' } }] },
  { contact: { id: 'contact_1' }, unknown_id: 'wrong' },
])('shared binder withholds raw conflicting identities before either family hook: %j', async response => {
  const f = fixture(response); const result: any = (await f.call()).result;
  expect(result.structuredContent).toMatchObject({ outcome: 'outcome_unknown' });
  expect(f.project).not.toHaveBeenCalled(); expect(f.recordId).not.toHaveBeenCalled();
  const row = f.actions.get(f.reviews[0]!.actionId)!;
  expect(f.approvalJournal.get(row.approvalId!)).toMatchObject({ state: 'conflict', reason: 'identity_conflict' });
});
it('deep negative confirmation settles not_applied without projection', async () => {
  const f = fixture({ contact: { id: 'contact_1' }, hidden: [{ succeeded: false }] });
  expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: 'not_applied' } });
  expect(f.project).not.toHaveBeenCalled();
  expect(f.approvalJournal.get(f.actions.get(f.reviews[0]!.actionId)!.approvalId!)).toMatchObject({ state: 'conflict', reason: 'negative_confirmation' });
});
it.each([false, true])('terminal tool-call replay policy=%s returns stored result with one review and one send', async policy => {
  const f = fixture(undefined, policy), begin = vi.spyOn(f.actions, 'beginDispatch');
  const first = await f.call();
  f.project.mockImplementation(() => { throw new Error('replay must not project'); });
  expect(await f.call()).toEqual(first);
  expect(f.api.calls('PUT')).toHaveLength(1); expect(begin).toHaveBeenCalledTimes(1);
  expect(f.reviews).toHaveLength(policy ? 0 : 1);
});
it('pending tool replay after restart reads once and never resends or begins dispatch', async () => {
  const f = fixture();
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash before terminal publication'); });
  await f.call();
  const row = f.actions.get(f.reviews[0]!.actionId)!;
  expect(f.approvalJournal.get(row.approvalId!)).toMatchObject({ state: 'pending' });
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(f.dir, 'actions.jsonl')) }); actions.recover();
  const begin = vi.spyOn(actions, 'beginDispatch');
  const host = new HighLevelHost({ ...f.deps, actions, approvalJournal: new FileApprovalJournal(join(f.dir, 'approvals')) } as any);
  expect((await f.call(host)).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(f.api.calls('PUT')).toHaveLength(1); expect(f.api.calls('GET')).toHaveLength(1); expect(begin).not.toHaveBeenCalled();
  expect(f.approvalJournal.get(row.approvalId!)).toMatchObject({ state: 'applied' });
});
it('terminal replay revalidates current release authority', async () => {
  const f = fixture(); await f.call();
  const access: any = f.bot.highlevelAccess; access.revision++;
  expect((await f.call()).result).toMatchObject({ isError: true });
  expect(f.api.calls('PUT')).toHaveLength(1); expect(f.reviews).toHaveLength(1);
});
it('tool-call id reused with different arguments refuses without another review/send', async () => {
  const f = fixture(); await f.call(); f.message.params.arguments.args.contactId = 'contact_2';
  expect((await f.call()).result).toMatchObject({ isError: true });
  expect(f.api.calls('PUT')).toHaveLength(1); expect(f.reviews).toHaveLength(1);
});
it('terminal replay survives a fresh host and durable action reload', async () => {
  const f = fixture(); const first = await f.call();
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(f.dir, 'actions.jsonl')) }); actions.recover();
  const begin = vi.spyOn(actions, 'beginDispatch');
  const host = new HighLevelHost({ ...f.deps, actions, approvalJournal: new FileApprovalJournal(join(f.dir, 'approvals')) });
  expect(await f.call(host)).toEqual(first);
  expect(begin).not.toHaveBeenCalled(); expect(f.api.calls('PUT')).toHaveLength(1);
});
it('approval survives action cleanup and missing release context cannot recreate a write', async () => {
  const f = fixture(); await f.call(); const row = f.actions.get(f.reviews[0]!.actionId)!;
  const journal = new FileActionJournal(join(f.dir, 'actions.jsonl')); journal.delete(row.actionId);
  const actions = new HighLevelActions({ journal });
  const host = new HighLevelHost({ ...f.deps, actions });
  expect((await f.call(host)).result).toMatchObject({ isError: true });
  expect(f.approvalJournal.get(row.approvalId!)).toMatchObject({ state: 'applied' });
  expect(f.api.calls('PUT')).toHaveLength(1); expect(f.reviews).toHaveLength(1);
});
it('failed durable pending publication cannot enter beginDispatch', async () => {
  const f = fixture(), begin = vi.spyOn(f.actions, 'beginDispatch');
  vi.spyOn(f.approvalJournal, 'claim').mockImplementation(() => { throw new Error('disk refused'); });
  expect((await f.call()).result).toMatchObject({ isError: true });
  expect(begin).not.toHaveBeenCalled(); expect(f.api.calls('PUT')).toHaveLength(0);
});
it('a stale action during projection keeps stale and never publishes applied', async () => {
  const f = fixture();
  f.project.mockImplementation(() => { f.actions.markStale(f.reviews[0]!.actionId, 'request_changed'); return { id: 'contact_1' }; });
  expect((await f.call()).result).toMatchObject({ isError: true, structuredContent: { outcome: 'stale' } });
  expect(f.approvalJournal.get(f.actions.get(f.reviews[0]!.actionId)!.approvalId!)).toMatchObject({ state: 'conflict', reason: 'authority_changed' });
});
/** Pause precisely at the first connection check after approval (host's release
 * authorization), before runApprovedWrite can claim the approval journal. */
function holdApprovedAuthorization(f: Pick<ReturnType<typeof fixture>, 'leases' | 'reviews' | 'actions'>) {
  const connection = f.leases.connection.bind(f.leases);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  let replayChecks = 0;
  vi.spyOn(f.leases, 'connection').mockImplementation(async id => {
    const row = f.reviews[0] && f.actions.get(f.reviews[0].actionId);
    if (!paused && row?.phase === 'approved') { paused = true; await held; }
    else if (paused) replayChecks++;
    return connection(id);
  });
  return { release, paused: () => paused, replayChecks: () => replayChecks };
}
it('concurrent replay joins the same approved write before the original PUT', async () => {
  const f = fixture(), begin = vi.spyOn(f.actions, 'beginDispatch');
  const gate = holdApprovedAuthorization(f);
  const first = f.call();
  let replay: ReturnType<typeof f.call> | undefined;
  try {
    await until(gate.paused);
    expect(f.api.calls('PUT')).toHaveLength(0);
    expect(f.approvalJournal.get(f.actions.get(f.reviews[0]!.actionId)!.approvalId!)).toBeUndefined();
    replay = f.call();
    // Drain the duplicate's authorization and journal path while the original
    // remains held. Do not await its outcome: a correct duplicate joins first.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.api.calls('PUT')).toHaveLength(0);
    gate.release();
    const [original, duplicate] = await Promise.all([first, replay]);
    expect(original.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(duplicate).toEqual(original);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(f.api.calls('PUT')).toHaveLength(1);
  } finally { gate.release(); await Promise.all([first, replay]); }
});
it('runtime constructs the app-data approval journal and drives the production dispatcher', async () => {
  const f = fixture();
  // C1 grants now pass through the production effective reader without a bypass.
  vi.spyOn(registry, 'operationSpec').mockImplementation(id => id === f.spec.id ? f.spec : fixtureReadSpec(id));
  for (const view of f.leases.views.values()) (view as any).scopes = [f.spec.endpoint.scope];
  const dataDir = join(f.dir, 'runtime');
  const runtime = createHighLevelRuntime({ threadMarkState: () => "marked", dataDir, capabilities: f.capabilities, signals: f.signals, bot: () => f.bot, leases: f.leases, fetch: f.api.fetch });
  runtime.host.configureReview({ onReview: (_claim, review) => runtime.actions.approve(review.actionId, review.reviewDigest) });
  const result: any = (await f.call(runtime.host)).result;
  expect(result.structuredContent).toMatchObject({ outcome: 'applied' });
  const row = runtime.actions.get(result.structuredContent.actionId)!;
  expect(new FileApprovalJournal(join(dataDir, 'highlevel', 'approvals')).get(row.approvalId!)).toMatchObject({ state: 'applied', requestDigest: row.requestDigest });
  expect(await f.call(runtime.host)).toEqual({ jsonrpc: '2.0', id: f.message.id, result });
  expect(f.api.calls('PUT')).toHaveLength(1);
});
it.each(['applied', 'not_applied'] as const)('terminal %s replay completes action settlement after publication failure', async expected => {
  const f = fixture(expected === 'applied' ? undefined : { contact: { id: 'contact_1' }, succeeded: false });
  if (expected === 'applied') vi.spyOn(f.actions, 'applied').mockImplementationOnce(() => { throw new Error('publication interrupted'); });
  else vi.spyOn(f.actions, 'notApplied').mockImplementationOnce(() => { throw new Error('publication interrupted'); });
  expect((await f.call()).result).toMatchObject({ isError: true, structuredContent: { outcome: 'outcome_unknown' } });
  const row = f.actions.get(f.reviews[0]!.actionId)!;
  expect(f.approvalJournal.get(row.approvalId!)).toMatchObject(expected === 'applied' ? { state: 'applied' } : { state: 'conflict', reason: 'negative_confirmation' });
  expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: expected } });
  expect(f.actions.get(row.actionId)?.phase).toBe(expected);
  expect(f.api.calls('PUT')).toHaveLength(1);
});
it('pending nested record never uses its child id as a parent read target', async () => {
  const f = fixture();
  const spec = fixtureSpec({ id: 'contacts.notes.update', family: 'contacts', risk: 'C', title: 'Note', nested: false, preflight: ['contacts.get'],
    args: z.object({ contactId: z.string(), noteId: z.string() }).strict(), recordRefs: () => ['contact_1', 'note_1'], fields: () => ['body'], targets: () => 1,
    project: (v: any) => ({ id: v.note.id }), recordId: (v: any) => v.note.id,
  }, a => ({ path: `/contacts/${a.contactId}/notes/${a.noteId}`, resource: '', body: { kind: 'json', value: { body: 'safe note' } } }));
  const resolve = (id: string) => id === spec.id ? spec : fixtureReadSpec(id);
  const host = new HighLevelHost({ ...f.deps, operationSpec: resolve });
  const message = { ...f.message, params: { name: 'HIGHLEVEL_CONTACTS', arguments: { operation: spec.id, args: { contactId: 'contact_1', noteId: 'note_1' } } } };
  f.api.always('PUT', /^\/contacts\/contact_1\/notes\/note_1$/, { status: 200, body: { note: { id: 'note_1' } } });
  vi.spyOn(f.approvalJournal, 'settle').mockImplementationOnce(() => { throw new Error('crash after response'); });
  await host.handle(f.claim, message);
  expect(f.api.calls('PUT')).toHaveLength(1);
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(f.dir, 'actions.jsonl')) }); actions.recover();
  const replay = new HighLevelHost({ ...f.deps, actions, operationSpec: resolve });
  expect((await replay.handle(f.claim, message)).result).toMatchObject({ isError: true, structuredContent: { code: 'unconfirmed' } });
  expect(f.api.calls('GET').map(call => call.path)).toEqual(['/contacts/contact_1/notes/note_1']); expect(f.api.calls('PUT')).toHaveLength(1);
});
it('stale during the final asynchronous release check withholds a journaled applied result', async () => {
  const f = fixture(), connection = f.leases.connection.bind(f.leases);
  vi.spyOn(f.leases, 'connection').mockImplementation(async id => {
    const row = f.reviews[0] && f.actions.get(f.reviews[0].actionId);
    if (row?.phase === 'dispatching' && f.approvalJournal.get(row.approvalId!)?.state === 'applied')
      f.actions.markStale(row.actionId, 'request_changed');
    return connection(id);
  });
  expect((await f.call()).result).toMatchObject({ isError: true, structuredContent: { outcome: 'stale' } });
  expect(f.actions.get(f.reviews[0]!.actionId)?.receipt).toBeUndefined();
  expect(f.api.calls('PUT')).toHaveLength(1);
});

/** Contacts family implementations are an unfilled extension point on this C2
 * branch. Use the production manifest/schema/endpoint objects, with minimal
 * family prepare/project hooks, through the real host, transport and journals. */
function contactsOperationFixture(operation: 'contacts.update' | 'contacts.tags.add' | 'contacts.tags.remove', response: unknown, preflight?: unknown) {
  const f = fixture(response);
  const row = registry.HIGHLEVEL_OPERATION_MANIFEST.find(row => row.id === operation)!;
  const isTags = operation !== 'contacts.update';
  if (isTags) f.api.first('GET', /^\/contacts\/contact_1$/, { status: 200, body: preflight ?? { contact: { id: 'contact_1', tags: operation.endsWith('.add') ? [] : ['a'] } } });
  const project = vi.fn((value: any) => isTags ? { tags: value.tags } : { contact: value.contact });
  const recordId = vi.fn((value: any) => value.contact?.id);
  const spec = registry.freezeOperationSpec({
    ...f.spec, id: operation, row, family: row.family, args: row.argsSchema,
    endpoint: HIGHLEVEL_ENDPOINTS[operation]!, preflight: row.preflight,
    risk: row.risk, gate: row.gate, send: row.send, precondition: row.precondition,
    fields: () => [isTags ? 'tags' : 'firstName'], project, recordId,
    prepare: async (_pre: unknown, args: any) => ({
      path: `/contacts/${args.contactId}${isTags ? '/tags' : ''}`,
      resource: `contacts:record:${args.contactId}`,
      body: { kind: 'json' as const, value: isTags ? { tags: args.tags } : { firstName: args.firstName } },
    }),
  } as registry.MutationSpec<any>);
  const deps = { ...f.deps, operationSpec: (id: string) => id === operation ? spec : fixtureReadSpec(id), operationScopes: () => [spec.endpoint.scope] };
  const host = new HighLevelHost(deps);
  f.api.always(spec.endpoint.method, /^\/contacts\/contact_1\/tags$/, { status: 200, body: response });
  const message = { ...f.message, params: { name: 'HIGHLEVEL_CONTACTS', arguments: { operation,
    args: isTags ? { contactId: 'contact_1', tags: ['a'] } : { contactId: 'contact_1', firstName: 'safe' } } } };
  return { ...f, spec, project, recordId, deps, host, message, call: (target = host) => target.handle(f.claim, message) };
}
it('contacts.update exact reviewer interleaving joins the live approved RPC before journal claim', async () => {
  const f = contactsOperationFixture('contacts.update', { contact: { id: 'contact_1', firstName: 'safe' } });
  const gate = holdApprovedAuthorization(f);
  const begin = vi.spyOn(f.actions, 'beginDispatch');
  const first = f.call();
  let replay: ReturnType<typeof f.call> | undefined;
  try {
    await until(gate.paused);
    const row = f.actions.get(f.reviews[0]!.actionId)!;
    expect(f.message.id).toBe('tool-call-1');
    expect(f.message.params.arguments.args).toEqual({ contactId: 'contact_1', firstName: 'safe' });
    expect(f.approvalJournal.get(row.approvalId!)).toBeUndefined();
    expect(f.api.calls('PUT')).toHaveLength(0);
    replay = f.call();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(gate.replayChecks()).toBeGreaterThan(0);
    expect(f.api.calls('PUT')).toHaveLength(0);
    gate.release();
    const [original, duplicate] = await Promise.all([first, replay]);
    expect(original.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(duplicate).toEqual(original);
    expect(f.api.calls('PUT')).toHaveLength(1);
    expect(f.api.calls('PUT')[0]!.body).toEqual({ firstName: 'safe' });
    expect(f.api.calls('GET')).toHaveLength(0);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(f.reviews).toHaveLength(1);
    expect(f.approvalJournal.get(row.approvalId!)).toMatchObject({ state: 'applied' });
  } finally { gate.release(); await Promise.all([first, replay]); }
});
it.each([
  ['contacts.tags.add', 'POST', ['a']],
  ['contacts.tags.remove', 'DELETE', []],
] as const)('%s accepts tags-only confirmation and replays the stored applied result', async (operation, method, tags) => {
  const f = contactsOperationFixture(operation, { tags });
  const first = await f.call();
  expect(first.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(f.api.calls(method)).toHaveLength(1);
  expect(f.api.calls(method)[0]!.body).toEqual({ tags: ['a'] });
  expect(f.api.calls('GET')).toHaveLength(1);
  expect(f.project).toHaveBeenCalledTimes(1);
  expect(f.actions.get(f.reviews[0]!.actionId)).toMatchObject({ phase: 'applied' });
  expect(await f.call()).toEqual(first);
  expect(f.api.calls(method)).toHaveLength(1);
  expect(f.project).toHaveBeenCalledTimes(1);
});
it.each([
  ['contacts.tags.add', ['a']], ['contacts.tags.remove', []],
] as const)('%s still rejects a foreign identity hidden beside tags-only confirmation', async (operation, tags) => {
  const f = contactsOperationFixture(operation, { tags, extra: [{ contactId: 'foreign_contact' }] });
  expect((await f.call()).result).toMatchObject({ isError: true, structuredContent: { outcome: 'outcome_unknown', code: 'identity_conflict' } });
  expect(f.project).not.toHaveBeenCalled();
  expect(f.recordId).not.toHaveBeenCalled();
  expect(f.actions.get(f.reviews[0]!.actionId)?.receipt).toBeUndefined();
});

it.each([
  ['contacts.tags.add', ['b'], ['a', 'b']],
  ['contacts.tags.remove', ['a', 'b'], ['b']],
] as const)('%s confirms the whole post-state including unrelated existing tags', async (operation, before, after) => {
  const f = contactsOperationFixture(operation, { tags: after }, { contact: { id: 'contact_1', tags: before } });
  expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(f.api.calls('GET')).toHaveLength(1);
  expect(f.api.calls(f.spec.endpoint.method)).toHaveLength(1);
});
it.each([
  { contact: { id: 'contact_1' } },
  { contact: { id: 'foreign_contact', tags: [] } },
  { contact: { id: 'contact_1', locationId: 'foreign_location', tags: [] } },
])('tag confirmation refuses invalid preflight state without a send: %j', async preflight => {
  const f = contactsOperationFixture('contacts.tags.add', { tags: ['a'] }, preflight);
  expect((await f.call()).result).toMatchObject({ isError: true });
  expect(f.api.calls('GET')).toHaveLength(1);
  expect(f.api.calls('POST')).toHaveLength(0);
  expect(f.project).not.toHaveBeenCalled();
});
