import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
import { fixtureActionDetail } from '../testing/highlevel-r4-fixtures.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixtureSpec, fixtureFileReader } from '../testing/highlevel-r4-fixtures.ts';
import { HeldRequest, sendFrozen } from './held-request.ts';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { z } from 'zod';
import * as clientModule from './client.ts';
import { HighLevelActions, MemoryActionJournal, reviewDigestFor } from './actions.ts';
import { HighLevelHost, highlevelApprovalBasis } from './host.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import { highLevelHarness, scriptCrm, until } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { markTurnEmailDerived, forgetAllTurnMarks } from '../email/external-marks.ts';

const uploadPath = './uploads.ts', escalationPath = './escalation.ts';
const uploadModule = existsSync(new URL(uploadPath, import.meta.url)) ? await import(uploadPath) : {};
const escalationModule = existsSync(new URL(escalationPath, import.meta.url)) ? await import(escalationPath) : {};
function prepare(root: string, file: string, max?: number) { expect(typeof uploadModule.prepareWorkspaceUpload).toBe('function'); return uploadModule.prepareWorkspaceUpload(root, { workspaceFile: file }, max, fixtureFileReader); }
function reserve(key: string, spec: any, args: any) { expect(typeof escalationModule.reserveEffectiveRisk).toBe('function'); return escalationModule.reserveEffectiveRisk(key, spec, args); }

const context = { botId: 'bot', threadId: 'thread', turnGeneration: 'turn', connectionId: 'conn', connectionEpoch: 1, locationId: 'loc', companyId: 'co', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'role' };
function fixture(read = false, send = false) {
  const h = highLevelHarness(); scriptCrm(h.api);
  // Exercise escalation's send flag with a recoverable record fixture.
  const family = 'contacts';
  const id = read ? 'contacts.get' : 'contacts.update';
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, denyRules: [], grants: [{ ...h.grant(), families: { ...defaultHighLevelFamilies(), [family]: 'full' }, operations: { [family]: [id] } }] };
  const spec: any = fixtureSpec({ id, family, risk: read ? 'R' : 'C', send, title: 'Fixture', endpoint: HIGHLEVEL_ENDPOINTS[id], nested: false, preflight: [],
    args: z.object({ contactId: z.string(), message: z.string().optional() }).strict(), recordRefs: (a: any) => [a.contactId], fields: () => ['message'], targets: () => 1,
    project: (v: any) => v }, (a, _ctx) => ({ path: `/contacts/${a.contactId}`, resource: '', ...(read ? {} : { body: { kind: 'json', value: { message: a.message } } }) }));
  h.api.always('PUT', /^\/contacts\/[^/]+$/, request => ({ status: 200, body: { contact: { id: request.path.split('/')[2] } } }));
  h.api.always('POST', /^\/conversations\/messages$/, { status: 201, body: { messageId: 'm1' } });
  const facts = { noLimits: true, attended: true, unknown: false };
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: () => spec, operationScopes: () => [spec.endpoint.scope],
    approvalBasis: (_claim, op, risk) => { if (facts.unknown) throw new Error('unknown'); return highlevelApprovalBasis({ ...facts, risk, tool: `HIGHLEVEL_${family.toUpperCase()}`, operation: op.id }); },
    onReview: (_claim, review) => h.reviews.push(review),
  });
  const call = (i = 0) => host.call(h.claim, `HIGHLEVEL_${family.toUpperCase()}`, { operation: id, args: { contactId: `contact_${i}`, ...(read ? {} : { message: send ? `message_${i}` : 'same' }) } });
  return { ...h, host, spec, facts, call, access: h.bot.highlevelAccess as any };
}

it.each(['sixthSend', 'fourthChange'])('escalation.%sWithChangeGrantRefused', async kind => {
  const send = kind === 'sixthSend', h = fixture(false, send);
  h.access.grants[0].families[h.spec.family] = 'change';
  const count = send ? 5 : 3;
  for (let i = 0; i < count; i++) expect((await h.call(i)).isError).not.toBe(true);
  expect((await h.call(count)).isError).toBe(true);
  expect(h.api.calls('PUT')).toHaveLength(count); expect(h.reviews).toHaveLength(0); h.stop();
});
it('escalation.concurrentCallsCountedOnce', async () => {
  const key = randomUUID(), spec = { id: 'contacts.update', risk: 'C', targets: () => 1 };
  reserve(key, spec, { id: 'a', message: 'same' }); reserve(key, spec, { id: 'b', message: 'same' });
  const results = await Promise.all([Promise.resolve().then(() => reserve(key, spec, { id: 'c', message: 'same' })), Promise.resolve().then(() => reserve(key, spec, { id: 'd', message: 'same' }))]);
  expect(results).toEqual([{ risk: 'C', escalation: 'none' }, { risk: 'D', escalation: 'identical_loop' }]);
  const h = fixture(); h.access.grants[0].families.contacts = 'change';
  await h.call(0); await h.call(1);
  const calls = await Promise.all([h.call(2), h.call(3)]);
  expect(calls.map(result => result.isError === true)).toEqual([false, true]);
  expect(h.api.calls('PUT')).toHaveLength(3); h.stop();
});
it('escalation.riskInDigest', () => {
  const actions = new HighLevelActions();
  const review = actions.propose(context, 'HIGHLEVEL_CONTACTS', { message: 'same' }, fixtureActionDetail({ recordRefs: [], fields: [], operation: 'contacts.update', risk: 'D', escalation: 'identical_loop' } as any, context));
  const row = actions.get(review.actionId)!;
  expect(row).toMatchObject({ escalation: 'identical_loop' });
  expect(() => actions.approve(row.actionId, reviewDigestFor({ ...row, risk: 'C' }))).toThrow();
  expect(() => actions.approve(row.actionId, reviewDigestFor({ ...row, escalation: 'none' } as any))).toThrow();
});
it.each(['Family', 'Operation', 'Risk'])('deny.readMatchedBy%sCards in every lane', async match => {
  for (const [noLimits, attended] of [[false, false], [true, false], [true, true]]) {
    const h = fixture(true); Object.assign(h.facts, { noLimits, attended });
    h.access.denyRules = [match === 'Family' ? 'HIGHLEVEL_CONTACTS' : match === 'Operation' ? 'HIGHLEVEL:contacts.get' : 'HIGHLEVEL:R'];
    const pending = h.call(); await until(() => h.reviews.length > 0);
    expect(h.api.requests).toHaveLength(0); h.actions.deny(h.reviews[0]!.actionId); await pending; h.stop();
  }
});
it('deny.ordinaryNoLimitsAfterCrmReadNoCard', async () => {
  const h = fixture(); markTurnEmailDerived(h.claim.threadId);
  try { expect((await h.call()).isError).not.toBe(true); expect(h.reviews).toHaveLength(0); } finally { h.stop(); forgetAllTurnMarks(); }
});
it.each(['attendanceLostDuringLeaseWait', 'attendanceLostDuringRateWait', 'laneLost', 'denyRuleAdded', 'unknownFact'])('dispatch.%s follows the live No limits setting', async change => {
  const h = fixture(); h.spec.targets = () => 2;
  let release!: () => void;
  const hold = new Promise<void>(r => { release = r; });
  let waiting = false;
  if (change === 'attendanceLostDuringRateWait') {
    const admit = h.client.gate.admit.bind(h.client.gate);
    h.client.gate.admit = async (...args: Parameters<typeof admit>) => { waiting = true; await hold; return admit(...args); };
  } else h.leases.hold = hold;
  const pending = h.call(); await until(() => waiting || h.leases.leaseRequests.length > 0);
  if (change.startsWith('attendance')) h.facts.attended = false;
  else if (change === 'laneLost') h.facts.noLimits = false;
  else if (change === 'denyRuleAdded') h.access.denyRules = ['HIGHLEVEL:D'];
  else h.facts.unknown = true;
  release();
  if (change.startsWith('attendance')) {
    expect((await pending).isError).not.toBe(true); expect(h.api.calls('PUT')).toHaveLength(1);
  } else {
    expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: 'stale' } }); expect(h.api.calls('PUT')).toHaveLength(0);
  }
  h.stop();
});

it.each(['symlinkEscape', 'dotDot', 'overLimit'])('upload.%sRefused', kind => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-upload-')); mkdirSync(join(dir, 'workspace')); writeFileSync(join(dir, 'outside'), 'secret');
  writeFileSync(join(dir, 'workspace', 'large'), '12345'); symlinkSync(join(dir, 'outside'), join(dir, 'workspace', 'link'));
  try { expect(typeof uploadModule.prepareWorkspaceUpload).toBe('function'); expect(() => prepare(join(dir, 'workspace'), kind === 'dotDot' ? '../outside' : kind === 'symlinkEscape' ? 'link' : 'large', 4)).toThrow(); }
  finally { removeTempDir(dir); }
});
it('upload.replacedAfterApprovalSendsReviewedBytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-upload-')); writeFileSync(join(dir, 'file.txt'), 'reviewed bytes');
  try {
    const prepared = prepare(dir, 'file.txt'); const h = highLevelHarness();
    h.api.always('POST', /^\/medias\/upload-file$/, { status: 201, body: { id: 'file_1' } });
    const spec = fixtureSpec({ id: 'media.files.upload', family: 'media', risk: 'C', args: z.object({}).strict(), preflight: [] }, () => ({ path: '/medias/upload-file', resource: '' }));
    const held = HeldRequest.freeze(spec, { path: '/medias/upload-file', resource: 'location:loc', body: { kind: 'multipart', fields: {}, file: { field: 'file', upload: prepared } } }, { locationId: 'loc' });
    h.leases.views.values().next().value!.locationId = 'loc';
    const actions = new HighLevelActions();
    const review = actions.propose(context, 'HIGHLEVEL_MEDIA', { file: { workspaceFile: 'file.txt' } }, fixtureActionDetail({ recordRefs: [], fields: ['file'], prepared, held } as any, context));
    expect(review.values).toMatchObject({ upload: { name: 'file.txt', size: 14, sha256: prepared.sha256 } });
    actions.approve(review.actionId, review.reviewDigest);
    writeFileSync(join(dir, 'file.txt'), 'different bytes');
    const approved = actions.beginDispatch(review.actionId, context) as any;
    const received: any[] = [];
    const client = new clientModule.HighLevelClient({ leases: h.leases, fetch: async (_url, options) => { received.push(options); return new Response('{}', { status: 200 }); } });
    await sendFrozen(client, { connection: h.leases.views.values().next().value!, signal: new AbortController().signal, assertActive() {} }, approved.held, approved.intent.requestDigest);
    const bytes = Buffer.from(received[0].body); const body = bytes.toString();
    expect(body).toContain('reviewed bytes'); expect(body).not.toContain('different bytes');
    const payload = body.split('\r\n\r\n')[1]!.split('\r\n--')[0]!;
    expect(createHash('sha256').update(payload).digest('hex')).toBe(prepared.sha256); h.stop();
  } finally { removeTempDir(dir); }
});
it('upload.restartStales', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-upload-')); writeFileSync(join(dir, 'file'), 'secret');
  try {
    const prepared = prepare(dir, 'file'), journal = new MemoryActionJournal(), actions = new HighLevelActions({ journal });
    const review = actions.propose(context, 'HIGHLEVEL_MEDIA', {}, fixtureActionDetail({ recordRefs: [], fields: [], prepared } as any, context));
    expect(JSON.stringify(journal.all())).not.toContain('secret');
    const next = new HighLevelActions({ journal }); next.recover(); expect(next.get(review.actionId)?.phase).toBe('stale');
  } finally { removeTempDir(dir); }
});
it('upload.digestBindsHash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-upload-')); writeFileSync(join(dir, 'file'), 'first');
  try {
    const prepared = prepare(dir, 'file'), actions = new HighLevelActions();
    const review = actions.propose(context, 'HIGHLEVEL_MEDIA', {}, fixtureActionDetail({ recordRefs: [], fields: [], prepared } as any, context));
    const row = actions.get(review.actionId)!; expect(row.upload?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(reviewDigestFor({ ...row, upload: { ...row.upload!, sha256: '0'.repeat(64) } } as any)).not.toBe(review.reviewDigest);
    const exposed = prepared.copyBytes(); exposed[0] = 0; expect(Buffer.from(prepared.copyBytes()).toString()).toBe('first');
  } finally { removeTempDir(dir); }
});
it('held dispatch refuses a mismatched path before lease and a second send', async () => {
  const h = highLevelHarness(); scriptCrm(h.api);
  try {
    const spec = fixtureSpec({ id: 'contacts.delete', family: 'contacts', risk: 'D', args: z.object({}).strict(), preflight: [] }, () => ({ path: '/contacts/contact_1', resource: '' }));
    expect(() => HeldRequest.freeze(spec, { path: '/users/u1', resource: 'contacts:contact:u1' }, { locationId: 'loc' })).toThrow();
    expect(h.leases.leaseRequests).toHaveLength(0);
    const held = HeldRequest.freeze(spec, { path: '/contacts/contact_1', resource: 'contacts:contact:contact_1' }, { locationId: 'loc' });
    const actions = new HighLevelActions();
    const review = actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, fixtureActionDetail({ held, risk: 'D' }, context));
    actions.approve(review.actionId, review.reviewDigest); actions.beginDispatch(review.actionId, context);
    h.api.always('DELETE', /^\/contacts\/contact_1$/, { status: 200, body: {} });
    const ctx = { connection: [...h.leases.views.values()][0]!, signal: new AbortController().signal, assertActive() {}, onDispatch: (attempt: number) => actions.recordAttempt(review.actionId, attempt, context) };
    await expect(sendFrozen(h.client, ctx, held, held.frozen.requestDigest)).resolves.toEqual({});
    await expect(sendFrozen(h.client, ctx, held, held.frozen.requestDigest)).rejects.toMatchObject({ code: 'not_approved' });
    expect(h.api.calls('DELETE')).toHaveLength(1);
  } finally { h.stop(); }
});
it('preflight only permits declared reads, nested ownership refuses before lease', async () => {
  const h = fixture(); h.spec.nested = true;
  expect((await h.call()).isError).toBe(true); expect(h.leases.leaseRequests).toHaveLength(0); h.stop();
  const fn = (clientModule as any).createPreflightRequester; expect(typeof fn).toBe('function');
  const pre = fn(h.client, { connection: [...h.leases.views.values()][0] }, { preflight: ['contacts.delete'] });
  await expect(pre.read('contacts.delete', { path: '/contacts/c1' })).rejects.toThrow(); expect(h.leases.leaseRequests).toHaveLength(0);
});
it('scrubKnownValues is withdrawn', () => { expect((new HighLevelActions() as any).scrubKnownValues).toBeUndefined(); });
