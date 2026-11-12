// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { HighLevelActions } from '../actions.ts';
import { FileActionJournal } from '../journal-file.ts';
import { FileRpcApprovalJournal } from '../rpc-approval-replay.ts';
import * as uploads from '../uploads.ts';
import { HighLevelClient } from '../client.ts';
import { createHash } from 'node:crypto';
import * as family from './conversations.ts';
import { HIGHLEVEL_OPERATION_MANIFEST, freezeOperationSpec, operationSpec, type OperationSpec, type PreflightRequester } from './registry.ts';
import { HeldRequest } from '../held-request.ts';
import { PreparedUpload } from '../uploads.ts';
import { prepareReturnedIdentitySchema } from '../returned-identities.ts';
import { levelCovers } from '../../../shared/highlevel.ts';
import { HighLevelEscalation } from '../escalation-state.ts';
import { HighLevelHost } from '../host.ts';
import { highLevelHarness, FAKE_LOCATION_ID as locationId } from '../../testing/fake-highlevel.ts';

const contactId = 'contact_1', conversationId = 'conv_1', messageId = 'msg_1', emailMessageId = 'email_1';
const secret = 'PRIVATE_MESSAGE_SENTINEL_1019';
const rows = HIGHLEVEL_OPERATION_MANIFEST.filter(r => r.family === 'conversations' && r.disposition === 'ready');
const types: Record<string, string> = { sms: 'SMS', email: 'Email', whatsapp: 'WhatsApp', facebook: 'FB', instagram: 'IG', gmb: 'GMB', livechat: 'Live_Chat', scheduledSms: 'SMS', scheduledEmail: 'Email' };
function sample(verb: string): Record<string, any> {
  if (verb.startsWith('send.')) return { type: types[verb.slice(5)], contactId, message: secret, status: 'pending', ...(verb.includes('scheduled') ? { scheduledTimestamp: 2_000_000_000 } : {}) };
  return ({ search: { locationId }, get: { conversationId }, 'messages.list': { conversationId }, 'message.get': { messageId }, 'email.get': { emailMessageId }, create: { locationId, contactId }, update: { locationId, conversationId, starred: true }, delete: { conversationId }, 'schedule.cancel': { messageId }, 'schedule.cancelEmail': { emailMessageId }, 'attachment.upload': { conversationId, file: { workspaceFile: 'letter.txt' } } } as Record<string, any>)[verb];
}
function spec(verb: string): OperationSpec<any> {
  const s = family.conversationsOperations.find(s => s.id === `conversations.${verb}`);
  expect(s, `conversations.${verb} implemented`).toBeDefined(); return s!;
}
const ctx = () => ({ locationId, prepared: new PreparedUpload('letter.txt', Buffer.from(secret)), scope: {} });
function preflight(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const pre: PreflightRequester = { async read(op) {
    calls.push(op);
    if (Object.hasOwn(overrides, op)) return overrides[op];
    if (op === 'contacts.get') return { contact: { id: contactId, locationId } };
    if (op === 'conversations.search') return { conversations: [{ id: conversationId, locationId, contactId }], total: 1 };
    if (op === 'conversations.get') return { id: conversationId, locationId, contactId };
    if (op === 'conversations.message.get') return { id: messageId, conversationId, locationId, contactId };
    if (op === 'conversations.email.get') return { id: emailMessageId, conversationId, locationId, contactId };
    return { messages: { messages: [], nextPage: false } };
  } }; return { pre, calls };
}
async function freeze(verb: string, a = sample(verb), context = ctx()) {
  const s = spec(verb), { pre } = preflight();
  await s.ownership?.(pre, a, context);
  const draft = s.risk === 'R' ? await s.prepareRead(a, context) : await s.prepare(pre, a, context);
  const held = HeldRequest.freeze(s, draft, context);
  const bind = (family as any).retainConversationRequest;
  expect(typeof bind).toBe('function'); bind(held, context);
  if (s.risk !== 'R') prepareReturnedIdentitySchema(held, locationId);
  return { s, held, draft, context };
}
function harness(level = 'full', basis = 'owner_exact_review', dir?: string) {
  const h = highLevelHarness({ deadlineMs: 3000 });
  if (dir) { h.actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')), now: () => h.now }); h.approvalJournal = new FileRpcApprovalJournal(join(dir, 'approvals')); }
  const access = h.bot.highlevelAccess as any; access.grantsVersion = 2; access.grants[0].families = { conversations: level, contacts: 'read' };
  h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: contactId, locationId } } });
  h.api.always('GET', /^\/conversations\/search$/, { status: 200, body: { conversations: [{ id: conversationId, locationId, contactId }], total: 1 } });
  h.api.always('GET', /^\/conversations\/conv_1$/, { status: 200, body: { id: conversationId, locationId, contactId, starred: false } });
  h.api.always('GET', /^\/conversations\/conv_1\/messages$/, { status: 200, body: { messages: { messages: [], nextPage: false } } });
  h.api.always('GET', /^\/conversations\/messages\/msg_1$/, { status: 200, body: { id: messageId, locationId, contactId, conversationId } });
  h.api.always('GET', /^\/conversations\/messages\/email\/email_1$/, { status: 200, body: { id: emailMessageId, locationId, contactId, conversationId } });
  const outcomes: unknown[] = [];
  const deps = { ...h, bot: () => h.bot, operationSpec, operationScopes: () => [...new Set(HIGHLEVEL_OPERATION_MANIFEST.map(r => r.scope).filter((s): s is string => !!s))], approvalBasis: () => basis as any, onOutcome: (_c: unknown, o: unknown) => outcomes.push(o), onReview: (_c: unknown, review: any) => { h.reviews.push(review); h.actions.approve(review.actionId, review.reviewDigest); } };
  const host = new HighLevelHost(deps);
  const call = (verb: string, args = sample(verb), rpc = verb) => host.handle(h.claim, { jsonrpc: '2.0', id: rpc, method: 'tools/call', params: { name: 'HIGHLEVEL_CONVERSATIONS', arguments: { operation: `conversations.${verb}`, args } } });
  return { ...h, host, deps, call, outcomes };
}

describe('F3 frozen conversation contract', () => {
  it('implements every frozen row, without provisional local specs or run members', () => {
    expect(family.conversationsOperations.map(s => s.id).sort()).toEqual(rows.map(r => r.id).sort());
  });
  for (const row of rows) {
    const verb = row.id.slice('conversations.'.length);
    it(`${verb}: exact frozen schema/endpoint/risk, safe metadata and grant levels`, () => {
      const s = spec(verb), a = sample(verb);
      expect(freezeOperationSpec(s)).toBe(s); expect(s.args).toBe(row.argsSchema); expect(s.row).toBe(row); expect(s.preflight).toBe(row.preflight);
      expect(s.args.safeParse(a).success).toBe(true);
      for (const extra of [{ unexpected: secret }, { url: 'https://evil.test' }, { token: secret }]) expect(s.args.safeParse({ ...a, ...extra }).success).toBe(false);
      for (const key of Object.keys(a).filter(k => k.endsWith('Id'))) for (const value of ['https://evil.test', '..', '%252f', 'a/b']) expect(s.args.safeParse({ ...a, [key]: value }).success).toBe(false);
      expect(JSON.stringify([s.fields(a), s.recordRefs(a)])).not.toContain(secret); expect(s.targets(a)).toBe(1);
      expect(levelCovers('read', s.risk)).toBe(s.risk === 'R'); expect(levelCovers('change', s.risk)).toBe(s.risk !== 'D'); expect(levelCovers('full', s.risk)).toBe(true); expect('run' in s).toBe(false);
    });
    it(`${verb}: prepares and freezes its exact request`, async () => {
      const { s, held } = await freeze(verb);
      expect(held.frozen.operation).toBe(row.id); expect(held.frozen.method).toBe(row.method); expect(s.endpoint.path.test(held.frozen.path)).toBe(true);
      if (s.risk === 'R') expect(typeof s.prepareRead).toBe('function');
      expect(() => HeldRequest.freeze(s, { path: held.frozen.path, resource: 'location:foreign' }, { locationId })).toThrow();
    });
    if (row.preflight.length) it(`${verb}: wrong owner refuses before any mutation`, async () => {
      const { pre } = preflight(Object.fromEntries(row.preflight.map(op => [op, { id: conversationId, locationId: 'foreign', contact: { id: contactId, locationId: 'foreign' } }])));
      const s = spec(verb); expect(s.nested).toBe(true);
      await expect(s.ownership!(pre, sample(verb), ctx())).rejects.toThrow();
    });
  }
  it('conv.sendOneRecipientOnly refuses recipient overrides even when the provider schema allows them', async () => {
    for (const verb of Object.keys(types).map(k => `send.${k}`)) {
      const s = spec(verb); if (s.risk === 'R') throw Error('send risk');
      for (const extra of [{ emailCc: ['other@example.test'] }, { emailBcc: ['other@example.test'] }, { emailTo: 'other@example.test' }, { toNumber: '+15555555555' }, { emailReplyMode: 'reply_all' }]) await expect(s.prepare(preflight().pre, { ...sample(verb), ...extra }, ctx())).rejects.toThrow();
      expect(s.args.safeParse({ ...sample(verb), contactId: [contactId, 'other'] }).success).toBe(false);
    }
  });
  it('risk.singleSendIsC, conv.scheduledCancelIsC and conv.sixthSendEscalatesToD across variants', () => {
    const escalation = new HighLevelEscalation();
    const risks = Object.keys(types).map((k, i) => { const s = spec(`send.${k}`); expect(s.risk).toBe('C'); expect((s as any).send).toBe(true); return escalation.reserve('turn', s, { ...sample(`send.${k}`), message: `message ${i}` }).risk; });
    expect(risks.slice(0, 5)).toEqual(['C','C','C','C','C']); expect(risks.slice(5).every(r => r === 'D')).toBe(true);
    expect(spec('schedule.cancel').risk).toBe('C'); expect(spec('schedule.cancelEmail').risk).toBe('C'); expect(spec('delete').risk).toBe('D');
  });
  it('conversations.attachmentWireHash binds reviewed bytes and never assembles FormData in F3', async () => {
    const { held, draft, context } = await freeze('attachment.upload');
    expect(draft.body).toEqual({ kind: 'multipart', fields: { conversationId }, file: { field: 'fileAttachment', upload: context.prepared } });
    const one = held.sendCopy(), two = held.sendCopy();
    expect(one.body).toEqual(two.body); expect(one.headers['content-type']).toBe(held.frozen.contentType);
    expect(createHash('sha256').update(one.body!).digest('hex')).toBe(held.frozen.bodySha256);
    expect(createHash('sha256').update(one.body!.subarray(one.fileOffset!, one.fileOffset! + one.fileLength!)).digest('hex')).toBe(context.prepared.sha256);
    context.prepared.copyBytes().fill(0); expect(held.sendCopy().body).toEqual(one.body);
  });
  it('unprepared and provider-oversize uploads refuse', async () => {
    const s = spec('attachment.upload'); if (s.risk === 'R') throw Error('upload risk');
    await expect(s.prepare(preflight().pre, sample('attachment.upload'), { locationId })).rejects.toThrow();
    await expect(s.prepare(preflight().pre, sample('attachment.upload'), { locationId, prepared: new PreparedUpload('big', new Uint8Array(5_000_001)) })).rejects.toThrow();
  });
  it('message and email getters preserve complete escaped and UTF-8 text', async () => {
    for (const verb of ['message.get', 'email.get']) {
      const { s, held } = await freeze(verb);
      const body = '\u0001'.repeat(100000) + '尾部😀';
      const id = verb === 'email.get' ? emailMessageId : messageId;
      const value = s.project({ id, locationId, contactId, conversationId, body, secret, meta: { token: secret } }, held.frozen) as any;
      expect(value.body).toBe(body);
      expect(JSON.stringify(value)).not.toContain(secret);
      expect(() => s.project({ id, locationId: 'foreign', body: secret }, held.frozen)).toThrow();
    }
  });
  it('malformed or conflicting mutation replies refuse before projection', async () => {
    const { s, held } = await freeze('update'); if (s.risk === 'R') throw Error('write');
    for (const response of [{}, { success: false }, { success: true, conversation: { id: 'foreign' } }, { success: true, nested: [{ contactId: 'foreign' }] }]) {
      expect(() => s.recordId!(response, held.frozen)).toThrow(); expect(() => s.project(response, held.frozen)).toThrow();
    }
    expect(() => s.project({ success: true })).toThrow();
  });
});

describe('F3 real host and journal against fake provider', () => {
  for (const verb of ['create', 'update', 'delete', ...Object.keys(types).map(k => `send.${k}`), 'schedule.cancel', 'schedule.cancelEmail']) it(`${verb}: one reviewed write, repeat RPC never resends, value-free receipt`, async () => {
    const h = harness();
    const row = rows.find(r => r.id === `conversations.${verb}`)!;
    const a = sample(verb), path = row.path!.replace(/:([A-Za-z]+)/g, (_, key) => a[key]);
    const response = verb.startsWith('send.') ? { messageId, conversationId } : verb === 'create' ? { success: true, conversation: { id: conversationId, contactId, locationId } } : { success: true };
    h.api.always(row.method!, new RegExp(`^${path}$`), { status: 200, body: response });
    const result = await h.call(verb); expect(JSON.stringify(result)).toContain('applied'); expect(h.api.calls(row.method!, new RegExp(`^${path}$`))).toHaveLength(1);
    expect(h.reviews).toHaveLength(1); expect(JSON.stringify(h.outcomes)).not.toContain(secret);
    await h.call(verb); expect(h.api.calls(row.method!, new RegExp(`^${path}$`))).toHaveLength(1);
    expect(h.api.unexpected).toEqual([]);
  });
  it('basis.singleSendNoLimitsNoCard; read grants and escalated change grants cannot send', async () => {
    const h = harness('change', 'owner_no_limits');
    h.api.always('POST', /^\/conversations\/messages$/, { status: 200, body: { messageId, conversationId } });
    expect(JSON.stringify(await h.call('send.sms'))).toContain('applied'); expect(h.reviews).toEqual([]);
    const read = harness('read'); await read.call('send.sms'); expect(read.api.calls('POST')).toEqual([]); expect(read.leases.leaseRequests).toEqual([]);
    for (let i = 1; i < 7; i++) await h.call('send.sms', { ...sample('send.sms'), message: `unique ${i}` }, `send_${i}`);
    expect(h.api.calls('POST')).toHaveLength(5);
  });
  it('conv.bodyNeverInReceipt: uncertain sends never resend or copy provider text', async () => {
    const h = harness(); h.api.always('POST', /^\/conversations\/messages$/, { status: 503, body: { message: secret } });
    await h.call('send.sms'); await h.call('send.sms'); expect(h.api.calls('POST')).toHaveLength(1); expect(JSON.stringify(h.outcomes)).not.toContain(secret); expect(JSON.stringify(h.outcomes)).toContain('outcome_unknown');
  });
});

// Real provider response shapes must also pass the shared identity barrier.
it('upload URLs become opaque handles scoped to the reviewed turn, recipient and connection', async () => {
  const context = ctx();
  const { s, held } = await freeze('attachment.upload', sample('attachment.upload'), context);
  (family as any).conversationUploadParent(held);
  const response = { uploadedFiles: { 'letter.txt': 'https://fixture.invalid/letter.txt' } };
  const result = s.project(response, held.frozen) as any;
  const handle = result.uploadedFiles[0].attachmentId;
  expect(handle).toMatch(/^hlfile_/); expect(JSON.stringify(result)).not.toContain('https:');
  const send = spec('send.sms'); if (send.risk === 'R') throw Error('send');
  const args = { ...sample('send.sms'), attachments: [handle] };
  const draft = await send.prepare(preflight().pre, args, context);
  expect((draft.body as any).value.attachments).toEqual(['https://fixture.invalid/letter.txt']);
  await expect(send.prepare(preflight().pre, args, ctx())).rejects.toThrow();
  await expect(send.prepare(preflight().pre, args, { ...context, authorityBinding: 'changed' } as any)).rejects.toThrow();
  await expect(send.prepare(preflight({ 'conversations.search': { conversations: [{ id: conversationId, locationId, contactId: 'other' }] } }).pre, args, context)).rejects.toThrow();
});
it('provider cancellation status confirms only explicit success, without copying its message', async () => {
  const { s, held } = await freeze('schedule.cancel');
  expect(s.project({ status: 200, message: secret }, held.frozen)).toEqual({ status: 200 });
  for (const response of [{ status: 404, message: secret }, { status: 500 }, { message: 'success' }, { status: 200, success: false }]) expect(() => s.project(response, held.frozen)).toThrow();
});

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) removeTempDirSync(dir); });
it('durable restart after provider acceptance reads once, remains unknown and never sends again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hlf3-recovery-')); directories.push(dir);
  const first = harness('full', 'owner_exact_review', dir);
  first.api.always('POST', /^\/conversations\/messages$/, { status: 200, body: { messageId, conversationId } });
  vi.spyOn(first.approvalJournal, 'settle').mockImplementationOnce(() => { throw Error('crash before settlement'); });
  await first.call('send.sms'); expect(first.api.calls('POST')).toHaveLength(1); first.stop();
  const restarted = harness('full', 'owner_exact_review', dir); restarted.actions.recover();
  const result = await restarted.call('send.sms');
  expect(result.result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
  expect(await restarted.call('send.sms')).toEqual(result);
  expect(restarted.api.calls('POST')).toEqual([]); expect(restarted.api.calls('GET')).toHaveLength(1); expect(restarted.reviews).toEqual([]);
  expect(readFileSync(join(dir, 'actions.jsonl'), 'utf8')).not.toContain(secret); restarted.stop();
});
it('conv.attachmentWorkspaceOnlyShaOnCard: upload and send reviews show trusted file details', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'hlf3-upload-')); directories.push(workspace);
  writeFileSync(join(workspace, 'letter.txt'), secret);
  const h = harness(); const upload = new PreparedUpload('letter.txt', Buffer.from(secret));
  let wire: Uint8Array | undefined;
  const client = new HighLevelClient({ leases: h.leases, fetch: (async (url: any, init: any) => {
    if (new URL(String(url)).pathname === '/conversations/messages/upload') {
      wire = Buffer.from(init.body); return new Response(JSON.stringify({ uploadedFiles: { 'letter.txt': 'https://fixture.invalid/letter.txt' } }), { status: 200 });
    }
    return h.api.fetch(url, init);
  }) as typeof fetch });
  const host = new HighLevelHost({ ...h.deps, client, workspaceRoot: () => workspace });
  const call = (verb: string, args: any) => host.handle(h.claim, { jsonrpc: '2.0', id: verb, method: 'tools/call', params: { name: 'HIGHLEVEL_CONVERSATIONS', arguments: { operation: `conversations.${verb}`, args } } });
  const result = await call('attachment.upload', sample('attachment.upload'));
  expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  const action = h.actions.get(h.reviews[0]!.actionId)!;
  expect(action.upload).toEqual({ name: 'letter.txt', size: upload.size, sha256: upload.sha256 });
  expect(createHash('sha256').update(wire!).digest('hex')).toBe(action.bodySha256);
  const handle = JSON.stringify(result).match(/hlfile_[a-f0-9]+/)![0];
  h.api.always('POST', /^\/conversations\/messages$/, { status: 200, body: { messageId, conversationId } });
  const sent = await call('send.sms', { ...sample('send.sms'), attachments: [handle] });
  expect(sent.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
  expect(h.reviews[1]!.values.attachmentDetails).toEqual([{ name: 'letter.txt', size: upload.size, sha256: upload.sha256 }]);
  expect(h.api.calls('POST')[0]!.body).toMatchObject({ attachments: ['https://fixture.invalid/letter.txt'] });
  expect(JSON.stringify(h.outcomes)).not.toContain(secret); expect(JSON.stringify(h.outcomes)).not.toContain('https:');
});
it('read grants run all reads, and foreign record data is withheld', async () => {
  for (const verb of ['search','get','messages.list','message.get','email.get']) {
    const h = harness('read'); const result = await h.call(verb);
    expect((result.result as { isError?: boolean })?.isError, JSON.stringify(result)).not.toBe(true); expect(h.reviews).toEqual([]); h.stop();
  }
  const h = harness('read'); h.api.first('GET', /^\/conversations\/messages\/msg_1$/, { status: 200, body: { id: messageId, locationId: 'foreign', body: secret } });
  const result = await h.call('message.get'); expect((result.result as { isError?: boolean })?.isError).toBe(true); expect(JSON.stringify(result)).not.toContain(secret); h.stop();
});
it('Stop after exact review prevents the write', async () => {
  const h = harness(); const host = new HighLevelHost({ ...h.deps, onReview: (_c, review) => { h.actions.approve(review.actionId, review.reviewDigest); h.stop(); } });
  await host.handle(h.claim, { jsonrpc: '2.0', id: 'stop', method: 'tools/call', params: { name: 'HIGHLEVEL_CONVERSATIONS', arguments: { operation: 'conversations.send.sms', args: sample('send.sms') } } });
  expect(h.api.calls('POST')).toEqual([]);
});
it('a generic success flag does not confirm a send or conversation creation without its new ID', async () => {
  for (const verb of ['send.sms', 'send.email', 'create']) {
    const { s, held } = await freeze(verb);
    expect(() => s.project({ success: true }, held.frozen)).toThrow();
  }
});

it('list message previews mark shortened content and retain a getter identity', async () => {
  const { s, held } = await freeze('messages.list');
  const body = 'a'.repeat(5000);
  const value = s.project({ messages: { messages: [{ id: messageId, body }], nextPage: false } }, held.frozen) as any;
  expect(value.messages.messages[0]).toMatchObject({ id: messageId, truncatedFields: ['body'] });
  const full = await freeze('message.get');
  expect((full.s.project({ id: messageId, locationId, body }, full.held.frozen) as any).body).toBe(body);
});
it('production upload preparation follows the r4 workspace reference contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hlf3-containment-')); directories.push(dir);
  const workspace = join(dir, 'workspace'); mkdirSync(workspace);
  writeFileSync(join(dir, 'outside.txt'), secret);
  writeFileSync(join(workspace, '.env'), secret);
  symlinkSync(join(dir, 'outside.txt'), join(workspace, 'link.txt'));
  linkSync(join(dir, 'outside.txt'), join(workspace, 'hard.txt'));
  for (const workspaceFile of ['../outside.txt', 'link.txt', 'hard.txt']) {
    expect(() => uploads.prepareWorkspaceUpload(workspace, { workspaceFile })).toThrow();
  }
  // r4 validates path components, without a private-name rule inside this host-derived workspace.
  expect(uploads.prepareWorkspaceUpload(workspace, { workspaceFile: '.env' }).copyBytes()).toEqual(Buffer.from(secret));
  writeFileSync(join(workspace, 'safe.txt'), secret);
  expect(uploads.prepareWorkspaceUpload(workspace, { workspaceFile: 'safe.txt' }).copyBytes()).toEqual(Buffer.from(secret));
});

it('hlf3.listBudgetNeverEmptyRecords', async () => {
  const { s, held } = await freeze('messages.list');
  for (let length = 900; length <= 1300; length++) {
    // Identity deliberately follows content on the wire.
    const rows = Array.from({ length: 60 }, (_, i) => ({ body: 'x'.repeat(length), subject: 's'.repeat(50), id: `msg_${i}`, conversationId, locationId }));
    const output = (s.project({ messages: { messages: rows, nextPage: false, lastMessageId: 'provider_cursor' } }, held.frozen) as any).messages;
    expect(output.messages.length, `length ${length}`).toBeGreaterThan(0);
    expect(output.messages.map((r: any) => r.id), `length ${length}`).toEqual(rows.slice(0, output.messages.length).map(r => r.id));
    expect(output.messages.every((r: any) => typeof r.body === 'string'), `record reserve ${length}`).toBe(true);
    expect(output.nextPage, `length ${length}`).toBe(true);
    expect(output.lastMessageId, `length ${length}`).toBe(output.messages.at(-1).id);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(65_536);
  }
});
it('hlf3.listBudgetMarksOmittedFields', async () => {
  const { s, held } = await freeze('messages.list');
  const fields = ['altId','threadId','type','messageType','fullName','contactName','email','phone','unreadCount','assignedTo','starred','deleted','inbox','lastMessageBody','lastMessageType','lastMessageDate','dateAdded','dateUpdated','body','subject','direction','status','contentType','source','total','success','nextPage','lastMessageId'];
  const row = { ...Object.fromEntries(fields.map(k => [k, 'x'.repeat(4000)])), id: messageId, conversationId, contactId, locationId };
  const prefix = Array.from({ length: 8 }, (_, i) => ({ id: `prefix_${i}`, body: 'x'.repeat(4000) }));
  const output = (s.project({ messages: { messages: [...prefix, row], nextPage: false } }, held.frozen) as any).messages.messages;
  const last = output.at(-1);
  expect(last.id).toBe(messageId);
  const missing = fields.filter(k => !Object.hasOwn(last, k));
  expect(missing.length).toBeGreaterThan(0);
  expect(last.omittedFields).toEqual(missing);
  for (const key of ['id','conversationId','contactId','locationId']) expect(last[key]).toBe(row[key as keyof typeof row]);
});
it('hlf3.searchBudgetCutAtRecordBoundary', async () => {
  const { s, held } = await freeze('search');
  const rows = Array.from({ length: 50 }, (_, i) => ({ lastMessageBody: 'x'.repeat(4000), fullName: 'y'.repeat(4000), id: `conv_${i}`, locationId, contactId }));
  const value = s.project({ conversations: rows, total: 50 }, held.frozen) as any;
  expect(value.conversations.length).toBeGreaterThan(0);
  expect(value.conversations.length).toBeLessThan(rows.length);
  expect(value.conversations.map((c: any) => c.id)).toEqual(rows.slice(0, value.conversations.length).map(c => c.id));
  expect(value.shortened).toBe(true);
});
it('hlf3.smallListTwinsKeepExistingOutput', async () => {
  const messages = Array.from({ length: 3 }, (_, i) => ({ id: `msg_${i}`, body: 'small' }));
  const list = await freeze('messages.list');
  const page = { messages: { messages, nextPage: false, lastMessageId: 'msg_2' } };
  expect(list.s.project(page, list.held.frozen)).toEqual(page);
  const search = await freeze('search');
  const conversations = Array.from({ length: 3 }, (_, i) => ({ id: `conv_${i}`, locationId, contactId, lastMessageBody: 'small' }));
  const value = { conversations, total: 3 };
  expect(search.s.project(value, search.held.frozen)).toEqual(value);
});
it('hlf3.uncutMessagePageKeepsValidProviderCursor', async () => {
  const { s, held } = await freeze('messages.list');
  const value = s.project({ messages: { messages: [{ id: messageId, body: 'small' }], nextPage: true, lastMessageId: 'provider_cursor' } }, held.frozen) as any;
  expect(value.messages.lastMessageId).toBe('provider_cursor');
});
