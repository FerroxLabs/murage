import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
import { fixtureActionDetail } from '../testing/highlevel-r4-fixtures.ts';
import { canonicalJson } from './operations/registry.ts';
import { requestChanged } from './request-change.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expect, it, vi, afterEach } from 'vitest';
import { z } from 'zod';
import * as uploads from './uploads.ts';
import { HighLevelActions, MemoryActionJournal, reviewDigestFor } from './actions.ts';
import { FileActionJournal } from './journal-file.ts';
import { HighLevelHost } from './host.ts';
import { HighLevelClient } from './client.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import { highLevelHarness, until } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';
vi.mock('node:crypto', async importOriginal => { const actual = await importOriginal<typeof import('node:crypto')>(); return { ...actual, randomBytes: vi.fn(actual.randomBytes) }; });
const modulePath = './held-request.ts';
const heldModule: any = existsSync(new URL(modulePath, import.meta.url)) ? await import(modulePath) : {};
const requireHeld = () => { expect(typeof heldModule.HeldRequest, 'r4 HeldRequest exists').toBe('function'); return heldModule; };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const context = { botId: 'bot', threadId: 'thread', turnGeneration: 'turn', connectionId: 'conn', connectionEpoch: 1, locationId: 'loc', companyId: 'co', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'role' };
function spec(id = 'contacts.get', overrides: any = {}): any {
  const endpoint = HIGHLEVEL_ENDPOINTS[id]!, risk = endpoint.retry === 'read' ? 'R' : 'C';
  const args = z.object({ contactId: z.string().optional() }).strict();
  return { id, family: id.split('.')[0], title: 'Fixture', endpoint, risk, args, nested: false, preflight: [], maxReads: 1,
    gate: risk === 'R' ? 'R' : 'GC', send: false, precondition: 'none',
    row: { id, family: id.split('.')[0], method: endpoint.method, path: id === 'contacts.get' || id === 'contacts.update' ? '/contacts/{contactId}' : id === 'contacts.search' ? '/contacts/search' : '/medias/upload-file', version: endpoint.version, scope: endpoint.scope, risk, gate: risk === 'R' ? 'R' : 'GC', send: false, precondition: 'none', disposition: 'ready', docUrl: 'https://fixture.invalid', pathResourceSegment: id === 'contacts.get' || id === 'contacts.update' ? 2 : null, preflight: [], argsSchema: args, bodySchema: z.object({ locationId: z.string().optional(), name: z.string().optional() }).strict(), projection: [] },
    recordRefs: () => [], fields: () => [], targets: () => 1, project: (value: unknown) => value,
    prepareRead: async (a: any) => ({ path: `/contacts/${a.contactId ?? 'contact_1'}`, resource: `contacts:contact:${a.contactId ?? 'contact_1'}` }), ...overrides };
}
function prepared(bytes = Buffer.from('file secret')): any {
  expect(typeof (uploads as any).PreparedUpload).toBe('function');
  return uploads.prepareWorkspaceUpload('/host/workspace', { workspaceFile: 'file.txt' }, undefined, (() => ({ bytes, size: bytes.length, volume: 'v', fileId: 'f' })) as any);
}
function multipart(fields: Record<string, string> = {}) {
  const mod = requireHeld(); const upload = prepared(); const s = spec('media.files.upload'); s.row.bodySchema = z.record(z.string(), z.string());
  return mod.HeldRequest.freeze(s, { path: '/medias/upload-file', resource: 'location:loc', body: { kind: 'multipart', fields, file: { field: 'file', upload } } }, { locationId: 'loc' });
}
afterEach(() => vi.restoreAllMocks());
it('upload.addonMissingRefusesUpload T-A11', () => {
  const unavailable = () => { throw Object.assign(new Error('unsupported'), { code: 'unsupported' }); };
  expect(() => (uploads.prepareWorkspaceUpload as any)('/host/workspace', { workspaceFile: 'file.txt' }, undefined, unavailable)).toThrow("Murage's file helper is missing. Reinstall Murage.");
});
it('upload.anchoredReaderAndPrivateCopy', () => {
  const bytes = Buffer.from('snapshot'); const reader = vi.fn(() => ({ bytes, size: bytes.length, volume: 'v', fileId: 'f' }));
  const upload: any = (uploads.prepareWorkspaceUpload as any)('/host/workspace', { workspaceFile: 'sub/file.txt' }, 100, reader);
  expect(reader).toHaveBeenCalledWith('/host/workspace', ['sub', 'file.txt'], 100);
  bytes.fill(0); upload.copyBytes().fill(1); expect(Buffer.from(upload.copyBytes()).toString()).toBe('snapshot'); expect('bytes' in upload).toBe(false);
});
it('upload.noBoundaryAtSend T-B3', () => {
  const held = multipart({ z: 'last', a: 'first' }), one = held.sendCopy(), two = held.sendCopy();
  expect(one.body).toEqual(two.body); expect(one.body).not.toBe(two.body); expect(one.headers['content-type']).toBe(held.frozen.contentType);
  one.body.fill(0); expect(held.sendCopy().body).toEqual(two.body);
});
it('upload.wireBodyHashEqualsFrozen T-B1; upload.filePartHashEqualsUpload T-B2', async () => {
  const mod = requireHeld(), held = multipart({ folder: 'docs' }), h = highLevelHarness();
  h.leases.views.values().next().value!.locationId = 'loc';
  const fetch = vi.fn(async (_url: any, init: any) => {
    const bytes = Buffer.from(init.body); expect(hash(bytes)).toBe(held.frozen.bodySha256);
    const boundary = init.headers['content-type'].split('boundary=')[1];
    const parts = bytes.toString().split(`--${boundary}`); const file = parts.find((p: string) => p.includes('filename="file.txt"'))!;
    const fileBytes = Buffer.from(file.split('\r\n\r\n')[1]!.slice(0, -2));
    expect(hash(fileBytes)).toBe(held.frozen.upload.sha256); expect(fileBytes.length).toBe(held.frozen.upload.size);
    return new Response('{}');
  });
  try { await mod.sendFrozen(new HighLevelClient({ leases: h.leases, fetch }), { connection: h.leases.views.values().next().value!, signal: h.signals.signalFor(h.claim), assertActive() {} }, held, held.frozen.requestDigest); }
  finally { h.stop(); }
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('upload.boundaryCollisionRechosen T-B4', async () => {
  requireHeld(); const crypto = await import('node:crypto');
  const random = vi.spyOn(crypto, 'randomBytes').mockClear().mockReturnValueOnce(Buffer.alloc(16, 0) as any).mockReturnValueOnce(Buffer.alloc(16, 1) as any);
  const held = multipart({ text: `MurageHL${'00'.repeat(16)}` });
  expect(held.frozen.contentType).toContain('01'.repeat(16)); expect(random).toHaveBeenCalledTimes(2);
});
it.each(['field', 'value', 'filename'])('upload.headerNameInjectionRefused T-B6 %s', kind => {
  const mod = requireHeld(), upload = prepared();
  const file = { field: kind === 'field' ? 'file\r\nInjected: x' : 'file', upload: kind === 'filename' ? { ...upload, name: 'x"bad', copyBytes: () => upload.copyBytes() } : upload };
  expect(() => mod.HeldRequest.freeze(spec('media.files.upload'), { path: '/medias/upload-file', resource: 'location:loc', body: { kind: 'multipart', fields: { x: kind === 'value' ? 'x\n' : 'x' }, file } }, { locationId: 'loc' })).toThrow(expect.objectContaining({ code: 'request_shape' }));
});
it.each(['file', 'header', 'digest', 'path'])('upload.filePartTamperStales T-B5 %s', async kind => {
  const mod = requireHeld(), held = multipart(), original = held.sendCopy.bind(held), fetch = vi.fn(), h = highLevelHarness();
  vi.spyOn(held, 'sendCopy').mockImplementation(() => { const out = original(); if (kind === 'file') out.body[out.body.indexOf(102)] ^= 1; if (kind === 'header') out.headers['content-type'] += 'x'; if (kind === 'path') out.url.pathname = '/contacts/'; return out; });
  try { await expect(mod.sendFrozen(new HighLevelClient({ leases: h.leases, fetch }), { connection: h.leases.views.values().next().value!, signal: h.signals.signalFor(h.claim), assertActive() {} }, held, kind === 'digest' ? 'bad' : held.frozen.requestDigest)).rejects.toMatchObject({ code: 'stale' }); expect(fetch).not.toHaveBeenCalled(); } finally { h.stop(); }
});
it('digest.requestDigestV2BindsContentType T-B7 and review v2', () => {
  const held = multipart(), f = held.frozen;
  const canonical = canonicalJson;
  expect(f.requestDigest).toBe(hash(canonical(['highlevel-request', 2, f.operation, f.method, f.path, f.resource, f.query, f.bodyKind, f.contentType, f.bodySha256, f.upload])));
  const row: any = { ...context, actionId: 'a', tool: 't', argumentsDigest: 'a', expiresAt: 9, requestDigest: f.requestDigest, resource: f.resource };
  expect(reviewDigestFor(row)).not.toBe(reviewDigestFor({ ...row, requestDigest: 'other' }));
});
it.each(['contacts.get', 'contacts.search'])('freeze.acceptsReadSpec T-D5 %s', id => {
  const mod = requireHeld(), s = spec(id), draft: any = { path: id === 'contacts.get' ? '/contacts/contact_1' : '/contacts/search', resource: id === 'contacts.get' ? 'contacts:contact:contact_1' : 'location:loc', ...(id === 'contacts.search' ? { body: { kind: 'json', value: {} } } : {}), query: { locationId: 'loc' } };
  expect(mod.HeldRequest.freeze(s, draft, { locationId: 'loc' }).frozen.operation).toBe(id);
  draft.query.locationId = 'wrong'; expect(() => mod.HeldRequest.freeze(s, draft, { locationId: 'loc' })).toThrow(expect.objectContaining({ code: 'request_shape' }));
});
function readFixture(reviewed: boolean, actions = new HighLevelActions()) {
  requireHeld();
  const h = highLevelHarness(); const access: any = h.bot.highlevelAccess;
  access.grantsVersion = 2; access.grants[0].families = { ...defaultHighLevelFamilies(), contacts: 'full' }; access.denyRules = reviewed ? ['HIGHLEVEL:R'] : [];
  const project = vi.fn((value: unknown) => value); const s = spec('contacts.get', { project });
  let release!: () => void, arrived!: () => void;
  const started = new Promise<void>(r => arrived = r), hold = new Promise<void>(r => release = r);
  const client = new HighLevelClient({ leases: h.leases, fetch: async () => new Response(new ReadableStream({ async start(controller) { arrived(); await hold; controller.enqueue(Buffer.from('{"secret":"RESPONSE_SENTINEL"}')); controller.close(); } })) });
  const host = new HighLevelHost({ capabilities: h.capabilities, signals: h.signals, bot: () => h.bot, leases: h.leases, client, actions, approvalJournal: h.approvalJournal, operationSpec: () => s, operationScopes: () => [s.endpoint.scope], onReview: (_claim, review) => { h.reviews.push(review); actions.approve(review.actionId, review.reviewDigest); } });
  const pending = host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: s.id, args: { contactId: 'contact_1' } });
  return { ...h, actions, connection: h.leases.views.values().next().value!, access, project, started, release: () => release(), pending };
}
it.each(['revoked', 'stop', 'epoch', 'grantRevision', 'accessRevision', 'policyRevision', 'role'])('denyRead.%sDuringResponseWithheld T-C1..4', async change => {
  const journal = new MemoryActionJournal(), h = readFixture(true, new HighLevelActions({ journal }));
  try {
    await until(() => h.reviews.length > 0); await h.started;
    const id = h.reviews[0]!.actionId; expect(h.actions.get(id)?.phase).toBe('dispatching'); expect(h.project).not.toHaveBeenCalled();
    if (change === 'revoked') h.access.grants = []; if (change === 'stop') h.signals.turnEnded(h.claim.generation);
    if (change === 'epoch') h.leases.views.values().next().value!.epoch++; if (change === 'grantRevision') h.access.grants[0].revision++; if (change === 'accessRevision') h.access.revision++; if (change === 'role') h.access.roleBinding = 'changed';
    if (change === 'policyRevision') h.bot.connectedAppAccess = { revision: 1, roleBinding: h.access.roleBinding, mode: 'unrestricted', allowWrites: true, grants: [], requests: [] };
    h.release(); const result = await h.pending;
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('RESPONSE_SENTINEL'); expect(h.project).not.toHaveBeenCalled();
    expect(h.actions.get(id)?.phase).toBe('read_withheld'); expect(h.actions.review(id)).toBeUndefined(); expect(JSON.stringify(journal.all())).not.toContain('RESPONSE_SENTINEL');
  } finally { h.release(); h.stop(); }
});
it('read.plainRevokedDuringResponseWithheld T-C5; read.projectNotCalledBeforeRelease T-C6', async () => {
  const h = readFixture(false);
  try { await h.started; expect(h.project).not.toHaveBeenCalled(); h.access.grants = []; h.release(); const result = await h.pending; expect(result.isError).toBe(true); expect(h.project).not.toHaveBeenCalled(); expect(JSON.stringify(result)).not.toContain('RESPONSE_SENTINEL'); } finally { h.release(); h.stop(); }
});
it('denyRead.journalWithheldHoldsNoResponse T-C7; terminal settlement exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-r4-')), file = join(dir, 'journal.jsonl');
  const journal = new FileActionJournal(file), actions = new HighLevelActions({ journal }), put = vi.spyOn(journal, 'put'), h = readFixture(true, actions);
  try { await until(() => h.reviews.length > 0); await h.started; h.access.grants = []; h.release(); await h.pending;
    const id = h.reviews[0]!.actionId; expect(new FileActionJournal(file).all().find(r => r.actionId === id)?.phase).toBe('read_withheld'); expect(readFileSync(file, 'utf8')).not.toContain('RESPONSE_SENTINEL');
    expect(put.mock.calls.filter(([r]) => ['read_done', 'read_withheld', 'not_applied', 'stale'].includes(r.phase))).toHaveLength(1);
  } finally { h.release(); h.stop(); removeTempDir(dir); }
});
it('denyRead.settlesReadDone after projection with held cleanup', async () => {
  const h = readFixture(true);
  try { await until(() => h.reviews.length > 0); await h.started; const id = h.reviews[0]!.actionId;
    h.project.mockImplementation(value => { expect(h.actions.get(id)?.phase).toBe('dispatching'); return value; });
    h.release(); expect((await h.pending).isError).not.toBe(true); expect(h.actions.get(id)?.phase).toBe('read_done'); expect(h.actions.review(id)).toBeUndefined();
  } finally { h.release(); h.stop(); }
});
it.each(['HIGHLEVEL:SEND', 'HIGHLEVEL:S'])('deny.sendRuleMatchesEverySendRow %s', async rule => {
  const { highlevelDenyRuleMatches } = await import('./host.ts');
  expect((highlevelDenyRuleMatches as any)('HIGHLEVEL_CONVERSATIONS', 'conversations.message', 'C', [rule], true)).toBe(true);
  expect((highlevelDenyRuleMatches as any)('HIGHLEVEL_CONVERSATIONS', 'conversations.attachment.upload', 'C', [rule], false)).toBe(false);
});
it('escalation.sixthSendIsD uses send metadata', async () => {
  const { HighLevelEscalation } = await import('./escalation-state.ts');
  const escalation = new HighLevelEscalation();
  const s: any = { id: 'conversations.message', risk: 'C', send: true, targets: () => 1 };
  for (let i = 0; i < 5; i++) expect(escalation.reserve('turn', s, { body: String(i) }).risk).toBe('C');
  expect(escalation.reserve('turn', s, { body: 'sixth' })).toEqual({ risk: 'D', escalation: 'send_count' });
});
it('preflight.postReadBodySchemaBound and bodyOnGetRefused', async () => {
  const { createPreflightRequester } = await import('./client.ts');
  const h = highLevelHarness(), s = spec('contacts.search'); const requested: any[] = [];
  const client = new HighLevelClient({ leases: h.leases, fetch: async (_url, init) => { requested.push(init); return new Response('{}'); } });
  const pre = (createPreflightRequester as any)(client, { connection: h.leases.views.values().next().value!, signal: h.signals.signalFor(h.claim), assertActive() {} }, { preflight: ['contacts.search', 'contacts.get'] }, (id: string) => id === 'contacts.search' ? s : spec());
  try {
    await expect(pre.read('contacts.search', { path: '/contacts/search', body: { name: 'valid' } })).resolves.toEqual({});
    await expect(pre.read('contacts.search', { path: '/contacts/search', body: { unknown: true } })).rejects.toMatchObject({ code: 'request_shape' });
    await expect(pre.read('contacts.get', { path: '/contacts/contact_1', body: { name: 'invalid' } })).rejects.toMatchObject({ code: 'request_shape' });
    expect(requested).toHaveLength(1);
  } finally { h.stop(); }
});
it('actions.proposeRequiresHeldRequest', () => {
  const actions = new HighLevelActions();
  expect(() => actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, { kind: 'change', risk: 'C', escalation: 'none', basis: 'owner_exact_review', recordRefs: [], fields: [] } as any)).toThrow(expect.objectContaining({ code: 'request_shape' }));
});
it('read.withheldOutcomeIsNotReportedAsSuccess', async () => {
  const { highlevelOutcomeLine } = await import('./review-cards.ts');
  expect(highlevelOutcomeLine({ actionId: 'a', operation: 'contacts.get', risk: 'R', basis: 'owner_exact_review', outcome: 'read_withheld', recordIds: [], fields: [] })).toContain('not shown');
});
it('draft.updateIsDWithoutProviderPrecondition', async () => {
  const h = highLevelHarness(); const access: any = h.bot.highlevelAccess; access.grantsVersion = 2; access.grants[0].families = { ...defaultHighLevelFamilies(), contacts: 'change' };
  const s = spec('contacts.update', { risk: 'C', gate: 'GDp', precondition: 'none', recheck: async () => ({ ok: true }), prepare: async () => ({ path: '/contacts/contact_1', resource: 'contacts:contact:contact_1', body: { kind: 'json', value: { name: 'x' } } }) });
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: () => s, operationScopes: () => [s.endpoint.scope], approvalBasis: () => 'owner_no_limits' });
  h.api.always('PUT', /^\/contacts\/contact_1$/, { status: 200, body: {} });
  try { expect((await host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: s.id, args: {} })).isError).toBe(true); expect(h.leases.leaseRequests).toHaveLength(0); } finally { h.stop(); }
});
it('freeze.bodyFieldOutsideSchemaRefused even when schema strips unknown fields', () => {
  const s = spec('contacts.update'); s.row.bodySchema = z.object({ name: z.string() });
  expect(() => requireHeld().HeldRequest.freeze(s, { path: '/contacts/contact_1', resource: 'contacts:contact:contact_1', body: { kind: 'json', value: { name: 'Ada', publish: true } } }, { locationId: 'loc' })).toThrow(expect.objectContaining({ code: 'request_shape' }));
});
it('freeze.bodyOnGetRefused', () => {
  expect(() => requireHeld().HeldRequest.freeze(spec(), { path: '/contacts/contact_1', resource: 'contacts:contact:contact_1', body: { kind: 'json', value: { name: 'x' } } }, { locationId: 'loc' })).toThrow(expect.objectContaining({ code: 'request_shape' }));
});
it('freeze.bodyFieldOutsideSchemaRefused missing required body', () => {
  const s = spec('contacts.update'); s.row.bodySchema = z.object({ name: z.string() }).strict();
  expect(() => requireHeld().HeldRequest.freeze(s, { path: '/contacts/contact_1', resource: 'contacts:contact:contact_1' }, { locationId: 'loc' })).toThrow(expect.objectContaining({ code: 'request_shape' }));
});
it('digest.canonicalJsonSortsNumericObjectKeysLexically', () => {
  expect(Buffer.from(canonicalJson({ '2': 'two', '10': 'ten', a: { z: 1, a: 2 } })).toString()).toBe('{"10":"ten","2":"two","a":{"a":2,"z":1}}');
});
it('upload.filePartTamperAfterWaitMarksActionStale and sends nothing', async () => {
  const mod = requireHeld(), held = multipart(), h = highLevelHarness();
  const actions = new HighLevelActions(), review = actions.propose(context, 'HIGHLEVEL_MEDIA', {}, fixtureActionDetail({ operation: 'media.files.upload', risk: 'C', fields: [], recordRefs: [], held }, context));
  actions.approve(review.actionId, review.reviewDigest); actions.beginDispatch(review.actionId, context);
  const original = held.sendCopy.bind(held); let tamper = false;
  vi.spyOn(held, 'sendCopy').mockImplementation(() => { const out = original(); if (tamper) out.body[out.body.indexOf(Buffer.from('file secret'))] ^= 1; return out; });
  const fetch = vi.fn();
  try {
    const ctx = { connection: h.leases.views.values().next().value!, signal: h.signals.signalFor(h.claim), assertActive() {}, onDispatch: () => { actions.recordAttempt(review.actionId, 1, context); tamper = true; } };
    requestChanged.set(ctx, () => actions.markStale(review.actionId, 'request_changed'));
    await expect(mod.sendFrozen(new HighLevelClient({ leases: h.leases, fetch }), ctx, held, held.frozen.requestDigest)).rejects.toMatchObject({ code: 'stale' });
    expect(actions.get(review.actionId)).toMatchObject({ phase: 'stale', outcomeCode: 'request_changed' }); expect(fetch).not.toHaveBeenCalled();
  } finally { h.stop(); }
});
it('digest.reviewV2BindsExplicitUploadEvenWithStoredUploadDigest', () => {
  const held = multipart(), actions = new HighLevelActions();
  const review = actions.propose(context, 'HIGHLEVEL_MEDIA', {}, fixtureActionDetail({ operation: 'media.files.upload', risk: 'C', recordRefs: [], fields: [], held }, context));
  const row = actions.get(review.actionId)!, upload = held.frozen.upload;
  expect(reviewDigestFor({ ...row, upload })).toBe(row.reviewDigest);
  expect(reviewDigestFor({ ...row, upload: { ...upload, name: 'changed.txt' } })).not.toBe(row.reviewDigest);
});
