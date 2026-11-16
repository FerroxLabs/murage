import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HighLevelActions, reviewDigestFor } from './actions.ts';
import { FileActionJournal, parseIntent } from './journal-file.ts';
import { HeldRequest, sendFrozen } from './held-request.ts';
import { PreparedUpload } from './uploads.ts';
import { HighLevelHost, type HighLevelOutcomeRecord } from './host.ts';
import { recheckAdmissions } from './request-change.ts';
import { HighLevelError, BUDGET_CALLS, type HighLevelCallContext } from './client.ts';
import { HIGHLEVEL_OPERATION_MANIFEST, type MutationSpec } from './operations/registry.ts';
import type { FrozenRequest } from './held-request.ts';
import { fixtureActionDetail, fixtureHeld, fixtureSpec, fixtureReadSpec } from '../testing/highlevel-r4-fixtures.ts';
import { highLevelHarness, until } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { highlevelOutcomeLine } from './review-cards.ts';

const context = { botId: 'bot', threadId: 'thread', turnGeneration: 'turn', connectionId: 'conn', connectionEpoch: 1, locationId: 'loc', companyId: 'co', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'role' };
function uploadSpec(id: string) {
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === id)!;
  const s = fixtureSpec({ id, family: row.family, risk: row.risk, args: row.argsSchema, preflight: [] }, () => ({ path: row.path!, resource: '' }));
  return { ...s, row };
}
it.each(['unknown', 'missing', 'stripped', 'non-upload'])('multipart rejects %s fields before freezing', mode => {
  const s = uploadSpec(mode === 'non-upload' ? 'contacts.update' : mode === 'missing' ? 'conversations.attachment.upload' : 'media.files.upload');
  if (mode === 'stripped') s.row = { ...s.row, bodySchema: z.object({ name: z.string() }) };
  const fields: Record<string, string> = mode === 'unknown' || mode === 'stripped' ? { name: 'x', injected: 'yes' } : mode === 'non-upload' ? { firstName: 'x' } : {};
  expect(() => HeldRequest.freeze(s, { path: mode === 'non-upload' ? '/contacts/c1' : s.row.path!, resource: mode === 'non-upload' ? 'contacts:record:c1' : 'location:loc', body: { kind: 'multipart', fields, file: { field: 'file', upload: new PreparedUpload('x.txt', Buffer.from('x')) } } }, { locationId: 'loc' })).toThrow(expect.objectContaining({ code: 'request_shape' }));
});
it.each(['media.files.upload', 'conversations.attachment.upload'])('multipart accepts closed schema for %s', id => {
  const s = uploadSpec(id), fields: Record<string, string> = id === 'media.files.upload' ? { name: 'x' } : { conversationId: 'conversation_1' };
  expect(HeldRequest.freeze(s, { path: s.row.path!, resource: 'location:loc', body: { kind: 'multipart', fields, file: { field: 'file', upload: new PreparedUpload('x.txt', Buffer.from('x')) } } }, { locationId: 'loc' }).frozen.bodyKind).toBe('multipart');
});
it('approval digest binds recordRefs and field names and isolates caller arrays', () => {
  const actions = new HighLevelActions(), refs = ['contact_1'], fields = ['name'];
  const review = actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, fixtureActionDetail({ recordRefs: refs, fields }, context));
  const row = actions.get(review.actionId)!;
  refs[0] = 'swapped'; fields[0] = 'swapped';
  expect(row.recordRefs).toEqual(['contact_1']);
  expect(reviewDigestFor(Object.assign({}, row, { recordRefs: ['swapped'] }))).not.toBe(row.reviewDigest);
  expect(reviewDigestFor(Object.assign({}, row, { fields: ['swapped'] }))).not.toBe(row.reviewDigest);
});
it('journal retains approved and returned IDs separately through restart without replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfix2-journal-'));
  try {
    const file = join(dir, 'actions.jsonl'), actions = new HighLevelActions({ journal: new FileActionJournal(file) });
    const review = actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, fixtureActionDetail({ recordRefs: ['parent_1'] }, context));
    actions.approve(review.actionId, review.reviewDigest); actions.beginDispatch(review.actionId, context); actions.recordAttempt(review.actionId, 1, context);
    const recovered = new HighLevelActions({ journal: new FileActionJournal(file) }); recovered.recover();
    expect(recovered.get(review.actionId)).toMatchObject({ recordRefs: ['parent_1'], phase: 'outcome_unknown' });
    expect(() => recovered.beginDispatch(review.actionId, context)).toThrow();
    actions.applied(review.actionId, { recordId: 'created_1', fields: [] });
    const restored = new HighLevelActions({ journal: new FileActionJournal(file) }); restored.recover();
    expect(restored.get(review.actionId)).toMatchObject({ recordRefs: ['parent_1'], receipt: { recordId: 'created_1' }, phase: 'applied' });
    expect(parseIntent({ ...restored.get(review.actionId), secret: 'forbidden' })).toBeNull();
  } finally { removeTempDir(dir); }
});

function mutationFixture(options: { draft?: boolean; manualSleep?: boolean; deadlineMs?: number; response?: unknown } = {}) {
  const h = highLevelHarness({ manualSleep: options.manualSleep, deadlineMs: options.deadlineMs ?? 500 });
  const access: any = h.bot.highlevelAccess; access.grantsVersion = 2; access.grants[0].families = { ...defaultHighLevelFamilies(), contacts: 'full' };
  const calls: string[] = [], frozen: FrozenRequest[] = [], outcomes: HighLevelOutcomeRecord[] = [];
  const s = fixtureSpec({ id: 'contacts.update', family: 'contacts', risk: 'C', title: 'Update', nested: false, preflight: ['contacts.get'], args: z.object({ contactId: z.string() }).strict(),
    recordRefs: (a: any) => [a.contactId], fields: () => ['name'], targets: () => 1,
    recordId: (v: any, f?: FrozenRequest) => { calls.push('id'); expect(f, 'approval context required').toBeDefined(); frozen.push(f!); return v.id; },
    project: (v: any, f?: FrozenRequest) => { calls.push('project'); expect(f).toBe(frozen[0]); expect(h.actions.get(h.reviews[0]!.actionId)?.phase).toBe('dispatching'); if (v.success === false) throw new Error('unconfirmed'); return { id: v.id }; },
  }, (a) => ({ path: `/contacts/${a.contactId}`, resource: '', body: { kind: 'json', value: { name: 'fixture' } } })) as MutationSpec<any>;
  if (options.draft) Object.assign(s, { gate: 'GDp', precondition: 'provider', recheck: async (pre: any) => { await pre.read('contacts.get', { path: '/contacts/contact_1' }); return { ok: true }; } });
  h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { draft: true } });
  h.api.always('PUT', /^\/contacts\/contact_1$/, { status: 200, body: options.response ?? { id: 'contact_1' } });
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: id => id === s.id ? s : fixtureReadSpec(id), operationScopes: () => [s.endpoint.scope],
    onReview: (_claim, r) => { h.reviews.push(r); h.actions.approve(r.actionId, r.reviewDigest); }, onOutcome: (_claim, o) => outcomes.push(o) });
  const call = () => host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: s.id, args: { contactId: 'contact_1' } });
  return { ...h, host, s, calls, frozen, outcomes, call };
}
it('F0.1 host sends exact retained context, validates then projects then settles once', async () => {
  const h = mutationFixture(); const begin = vi.spyOn(h.actions, 'beginDispatch'), applied = vi.spyOn(h.actions, 'applied');
  try {
    expect((await h.call()).isError).not.toBe(true); expect(h.calls).toEqual(['id', 'project']);
    expect(h.frozen[0]).toBe(begin.mock.results[0]!.value.held.frozen); expect(applied).toHaveBeenCalledTimes(1);
    expect(h.outcomes[0]).toMatchObject({ recordIds: ['contact_1'], providerRecordIds: ['contact_1'] });
    expect(highlevelOutcomeLine(h.outcomes[0]!)).toContain('Provider records: contact_1');
  } finally { h.stop(); }
});
it.each([{ id: 'wrong' }, { id: 'contact_1', parentId: 'wrong' }, { id: 'contact_1', success: false }])('F0.1 host withholds invalid response %j and never settles applied', async response => {
  const h = mutationFixture({ response });
  try { expect(await h.call()).toMatchObject({ isError: true, structuredContent: { outcome: 'success' in response && response.success === false ? 'not_applied' : 'outcome_unknown' } }); expect(h.api.calls('PUT')).toHaveLength(1); expect(h.actions.get(h.reviews[0]!.actionId)?.receipt).toBeUndefined(); }
  finally { h.stop(); }
});
it('F0.1 applied cannot overwrite stale or settle twice', () => {
  const a = new HighLevelActions(), r = a.propose(context, 'HIGHLEVEL_CONTACTS', {}, fixtureActionDetail({}, context));
  a.approve(r.actionId, r.reviewDigest); a.beginDispatch(r.actionId, context); a.markStale(r.actionId, 'request_changed');
  a.applied(r.actionId, { recordId: 'wrong', fields: [] }); expect(a.get(r.actionId)?.phase).toBe('stale');
});
it('draft recheck progresses while dispatch reservations fill the gate', async () => {
  const h = mutationFixture({ draft: true, manualSleep: true });
  const ctx: HighLevelCallContext = { connection: h.leases.views.values().next().value!, signal: h.signals.signalFor(h.claim), assertActive() {} };
  const reservations = await Promise.all(Array.from({ length: BUDGET_CALLS - 1 }, () => h.client.gate.admit(ctx.connection.locationId, ctx)));
  let done = false;
  const pending = h.call().finally(() => done = true);
  try {
    await new Promise(r => setTimeout(r, 100));
    expect(done, 'recheck must not wait behind its own dispatch reservation').toBe(true);
    expect((await pending).isError).not.toBe(true); expect(h.api.requests.map(r => r.method)).toEqual(['GET', 'PUT']);
  } finally { h.stop(); reservations.forEach(r => r.release()); h.releaseSleeps(); await pending; }
});
it('dispatch deadline bounds reservation wait before onDispatch and releases late work', async () => {
  const h = highLevelHarness({ manualSleep: true, deadlineMs: 25 });
  const ctx: HighLevelCallContext = { connection: h.leases.views.values().next().value!, signal: h.signals.signalFor(h.claim), assertActive() {}, onDispatch: vi.fn() };
  const reservations = await Promise.all(Array.from({ length: BUDGET_CALLS }, () => h.client.gate.admit(ctx.connection.locationId, ctx)));
  const held = fixtureHeld('contacts.update', ctx.connection.locationId);
  let done = false;
  const pending = sendFrozen(h.client, ctx, held, held.frozen.requestDigest).catch(e => e).finally(() => done = true);
  try {
    await new Promise(r => setTimeout(r, 100)); expect(done, 'timeout must start before admission').toBe(true);
    expect(await pending).toMatchObject({ outcome: 'not_applied' }); expect(ctx.onDispatch).not.toHaveBeenCalled(); expect(h.api.requests).toHaveLength(0);
  } finally { h.stop(); reservations.forEach(r => r.release()); h.releaseSleeps(); await pending; }
});
it('F0.1 post-send validation refusal is unknown, never proof of not-applied', async () => {
  const h = mutationFixture();
  h.s.recordId = () => 'contact_1';
  h.s.project = () => { throw new HighLevelError('Unconfirmed response', { status: 200 }); };
  try { expect(await h.call()).toMatchObject({ isError: true, structuredContent: { outcome: 'outcome_unknown' } }); expect(h.outcomes[0]?.providerRecordIds).toEqual([]); }
  finally { h.stop(); }
});
it('F0.1 outcome projection keeps approved IDs separate from newly returned IDs', async () => {
  const h = mutationFixture();
  h.s.recordId = () => 'provider_new_1'; h.s.project = () => ({});
  try { await h.call(); expect(h.outcomes[0]).toMatchObject({ recordIds: ['contact_1'], providerRecordIds: ['provider_new_1'] }); }
  finally { h.stop(); }
});
it('recheck admission is bounded independently of reserved dispatch capacity', async () => {
  const h = highLevelHarness({ manualSleep: true, deadlineMs: 500 });
  const ctx: HighLevelCallContext = { connection: h.leases.views.values().next().value!, signal: h.signals.signalFor(h.claim), assertActive() {} };
  recheckAdmissions.add(ctx);
  h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: {} });
  const held = HeldRequest.freeze(fixtureReadSpec('contacts.get'), { path: '/contacts/contact_1', resource: 'contacts:record:contact_1' }, { locationId: ctx.connection.locationId });
  try {
    await Promise.all(Array.from({ length: 5 }, () => h.client.sendHeld(ctx, held)));
    const sixth = h.client.sendHeld(ctx, held).catch(e => e);
    await until(() => h.sleeps.length > 0);
    expect(h.api.requests).toHaveLength(5); expect(h.client.gate.pending(ctx.connection.locationId)).toBe(0);
    h.stop(); await sixth;
  } finally { h.stop(); h.releaseSleeps(); }
});
it('draft deadline cancels a blocked recheck and prevents a late mutation', async () => {
  const h = mutationFixture({ draft: true, deadlineMs: 25 });
  let release!: () => void; const hold = new Promise<void>(r => release = r);
  Object.assign(h.s, { recheck: async (pre: any) => { await hold; await pre.read('contacts.get', { path: '/contacts/contact_1' }); return { ok: true }; } });
  try {
    expect(await h.call()).toMatchObject({ isError: true, structuredContent: { outcome: 'not_applied' } });
    release(); await new Promise(r => setTimeout(r, 20));
    expect(h.api.requests).toHaveLength(0); expect(h.client.gate.pending(h.leases.views.values().next().value!.locationId)).toBe(0);
    expect(h.actions.get(h.reviews[0]!.actionId)?.dispatchAttempts).toBe(0);
  } finally { release(); h.stop(); }
});
it.each(['stale', 'policy', 'stop'])('F0.1 %s after send withholds receipt without replacing terminal authority', async change => {
  const h = mutationFixture();
  h.api.first('PUT', /^\/contacts\/contact_1$/, () => {
    if (change === 'stale') h.actions.markStale(h.reviews[0]!.actionId, 'request_changed');
    if (change === 'stop') h.stop();
    if (change === 'policy') h.bot.connectedAppAccess = { revision: 1, roleBinding: (h.bot.highlevelAccess as any).roleBinding, mode: 'unrestricted', allowWrites: true, grants: [], requests: [] };
    return { status: 200, body: { id: 'contact_1' } };
  });
  try { expect(await h.call()).toMatchObject({ isError: true, structuredContent: { outcome: change === 'stale' ? 'stale' : 'outcome_unknown' } }); expect(h.actions.get(h.reviews[0]!.actionId)?.receipt).toBeUndefined(); }
  finally { h.stop(); }
});
it('F0.1 swapped held context refuses before provider send', async () => {
  const h = mutationFixture(), original = h.actions.beginDispatch.bind(h.actions);
  vi.spyOn(h.actions, 'beginDispatch').mockImplementation((id, c) => ({ ...original(id, c), held: fixtureHeld('contacts.update', c.locationId) }));
  try { expect((await h.call()).isError).toBe(true); expect(h.api.requests).toHaveLength(0); expect(h.actions.get(h.reviews[0]!.actionId)?.phase).toBe('stale'); }
  finally { h.stop(); }
});
it('F0.1 concurrent sends retain each approved request through interleaved responses', async () => {
  const h = mutationFixture(); const seen = new Map<string, FrozenRequest>();
  h.s.recordId = (v: any, f?: FrozenRequest) => { expect(v.id).toBe(f!.path.split('/')[2]); seen.set(v.id, f!); return v.id; };
  h.s.project = (v: any, f?: FrozenRequest) => { expect(f).toBe(seen.get(v.id)); return { id: v.id }; };
  let release!: () => void; const hold = new Promise<void>(r => release = r);
  h.api.first('PUT', /^\/contacts\/contact_1$/, async () => { await hold; return { status: 200, body: { id: 'contact_1' } }; });
  h.api.always('PUT', /^\/contacts\/contact_2$/, { status: 200, body: { id: 'contact_2' } });
  const other = h.turn('other', {}, 'thread_2');
  const one = h.call();
  try {
    await until(() => h.api.calls('PUT').length === 1);
    const two = await h.host.call(other, 'HIGHLEVEL_CONTACTS', { operation: 'contacts.update', args: { contactId: 'contact_2' } });
    expect(two.isError).not.toBe(true); release(); expect((await one).isError).not.toBe(true);
    expect(h.outcomes.map(o => o.recordIds)).toEqual([['contact_2'], ['contact_1']]);
    expect(h.reviews.every(r => h.actions.get(r.actionId)?.dispatchAttempts === 1)).toBe(true);
  } finally { release(); h.stop(); h.stop('other', 'thread_2'); await one; }
});
it.each(['add', 'remove'].flatMap(action => [undefined, false, true].map(success => ({ action, success }))))('F0.1 follower $action confirmation $success is validated before applied without invented IDs', async ({ action, success }) => {
  const h = highLevelHarness(); const access: any = h.bot.highlevelAccess; access.grantsVersion = 2; access.grants[0].families = { ...defaultHighLevelFamilies(), opportunities: 'full' }; access.grants[0].operations = {};
  const id = `opportunities.followers.${action}`, path = '/opportunities/opportunity_1/followers';
  const outcomes: HighLevelOutcomeRecord[] = [];
  const s = fixtureSpec({ id, family: 'opportunities', risk: 'C', title: 'Followers', args: z.object({}).strict(), nested: false, preflight: [], recordRefs: () => ['opportunity_1'], fields: () => ['followers'], targets: () => 1,
    project: (v: any, f?: FrozenRequest) => { expect(f?.path).toBe(path); if (v.success !== true) throw new Error('Unconfirmed followers'); return { success: true }; },
  }, () => ({ path, resource: '', body: { kind: 'json', value: { followers: ['user_1'] } } as const }));
  (s.row as any).bodySchema = z.object({ followers: z.array(z.string()) }).strict();
  h.api.always(s.endpoint.method, /^\/opportunities\/opportunity_1\/followers$/, { status: 200, body: { followers: ['user_1'], ...(success === undefined ? {} : { success }) } });
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: () => s, operationScopes: () => [s.endpoint.scope],
    onReview: (_claim, r) => { h.reviews.push(r); h.actions.approve(r.actionId, r.reviewDigest); }, onOutcome: (_claim, o) => outcomes.push(o) });
  try {
    const result = await host.call(h.claim, 'HIGHLEVEL_OPPORTUNITIES', { operation: id, args: {} });
    expect(result.structuredContent?.outcome).toBe(success === true ? 'applied' : success === false ? 'not_applied' : 'outcome_unknown');
    expect(outcomes[0]).toMatchObject({ recordIds: ['opportunity_1'], providerRecordIds: [] }); expect(h.api.requests).toHaveLength(1);
  } finally { h.stop(); }
});
