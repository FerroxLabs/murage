// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixtureFamilyLevels } from './testing/family-grants.ts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HighLevelActions } from './actions.ts';
import { FileActionJournal } from './journal-file.ts';
import { FileRpcApprovalJournal as FileApprovalJournal } from './rpc-approval-replay.ts';
import { HighLevelHost } from './host.ts';
import { HighLevelClient } from './client.ts';
import { HIGHLEVEL_OPERATION_MANIFEST, type MutationSpec } from './operations/registry.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import { highLevelHarness } from '../testing/fake-highlevel.ts';
import { fixtureFileReader, fixtureReadSpec } from '../testing/highlevel-r4-fixtures.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import * as uploads from './uploads.ts';
import * as recovery from './write-recovery.ts';
const dirs: string[] = [];
const bytes = Buffer.from('isolated upload fixture bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const operations = ['media.files.upload', 'conversations.attachment.upload'] as const;
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir))); });
function fixture(operation: typeof operations[number], decision: 'allow' | 'deny' = 'allow', dir?: string, fault?: 'lost-response' | 'foreign-response') {
  dir ??= mkdtempSync(join(tmpdir(), 'hlc2-host-upload-')); if (!dirs.includes(dir)) dirs.push(dir);
  writeFileSync(join(dir, 'upload.txt'), bytes);
  const original = uploads.prepareWorkspaceUpload;
  // C3 owns the native reader; use only an isolated static-file reader at that seam.
  vi.spyOn(uploads, 'prepareWorkspaceUpload').mockImplementation((root, ref, max) => original(root, ref, max, fixtureFileReader));
  const h = highLevelHarness({ deadlineMs: 2000 });
  const access: any = h.bot.highlevelAccess; access.grantsVersion = 2;
  access.grants[0].families = fixtureFamilyLevels({ media: 'full', conversations: 'full' });
  // Explicit family authority does not inherit the legacy operation projection.
  delete access.grants[0].operations?.media; delete access.grants[0].operations?.conversations;
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')) });
  const approvals = new FileApprovalJournal(join(dir, 'approvals'));
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === operation)!;
  const attachment = operation === 'conversations.attachment.upload';
  const fields: Record<string, string> = attachment ? { conversationId: 'conversation_1' } : { name: 'Reviewed upload' };
  const spec: MutationSpec<any> = { id: row.id, row, family: row.family, risk: 'C', gate: 'GC', send: false, precondition: 'none',
    args: row.argsSchema, endpoint: HIGHLEVEL_ENDPOINTS[operation]!, title: 'Fixture upload', nested: attachment, preflight: row.preflight,
    ...(attachment ? { ownership: async pre => { await pre.read('conversations.get', { path: '/conversations/conversation_1' }); } } : {}),
    recordRefs: () => attachment ? ['conversation_1'] : [], fields: () => Object.keys(fields), targets: () => 1,
    project: v => v, recordId: () => 'file_1',
    prepare: async (_pre, _args, ctx) => ({ path: row.path!, resource: `location:${ctx.locationId}`,
      body: { kind: 'multipart', fields, file: { field: 'file', upload: ctx.prepared! } } }),
  };
  const prepareRecovery = vi.spyOn(recovery, 'prepareWriteRecovery');
  const sent: { path: string; body: Buffer; contentType: string }[] = [];
  const reads: string[] = [];
  const client = new HighLevelClient({ leases: h.leases, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (init?.method === 'POST') {
      expect(actions.get(h.reviews[0]!.actionId)?.phase).toBe('dispatching');
      sent.push({ path, body: Buffer.from(init.body as Uint8Array), contentType: (init.headers as Record<string, string>)['content-type']! });
      if (fault === 'lost-response') throw new TypeError('fixture lost response');
      const value = attachment ? { uploadedFiles: [{ fileId: 'file_1', url: 'https://fixture.invalid/file' }] } : { fileId: 'file_1', url: 'https://fixture.invalid/file' };
      return new Response(JSON.stringify({ success: true, ...value, ...(fault === 'foreign-response' ? { locationId: 'foreign_location' } : {}) }));
    }
    if (path === '/medias/files') {
      expect(new URL(String(url)).searchParams.get('altId')).toBe('loc_fixture_01');
      expect(new URL(String(url)).searchParams.get('altType')).toBe('location');
    }
    reads.push(path);
    return new Response(JSON.stringify(path === '/conversations/conversation_1' ? { conversation: { id: 'conversation_1', locationId: 'loc_fixture_01' } } : { files: [], messages: [] }));
  }, deadlineMs: 2000 });
  const host = new HighLevelHost({ ...h, actions, approvalJournal: approvals, client, bot: () => h.bot, workspaceRoot: () => dir,
    operationSpec: id => id === operation ? spec : fixtureReadSpec(id), operationScopes: () => [spec.endpoint.scope],
    onReview: (_claim, review) => {
      h.reviews.push(review);
      expect(sent).toHaveLength(0);
      expect(review.upload).toMatchObject({ name: 'upload.txt', size: bytes.length, sha256 });
      // The retained request must send the reviewed bytes even after the file changes.
      writeFileSync(join(dir!, 'upload.txt'), 'changed after review');
      if (decision === 'allow') actions.approve(review.actionId, review.reviewDigest);
      else actions.deny(review.actionId);
    },
  });
  const message = { jsonrpc: '2.0', id: 'upload-rpc', method: 'tools/call', params: {
    name: attachment ? 'HIGHLEVEL_CONVERSATIONS' : 'HIGHLEVEL_MEDIA', arguments: { operation, args: { file: { workspaceFile: 'upload.txt' }, ...fields } },
  } };
  return { ...h, dir, actions, approvals, sent, reads, prepareRecovery, call: () => host.handle(h.claim, message) };
}
it.each(operations)('host %s reaches exact review and sends frozen bytes once after Allow', async operation => {
  const f = fixture(operation);
  try {
    const result = await f.call();
    expect(f.prepareRecovery).toHaveBeenCalledTimes(1);
    expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(f.reviews).toHaveLength(1); expect(f.sent).toHaveLength(1);
    const recoveryDir = join(f.dir, 'approvals', 'recovery');
    const durable = readFileSync(join(f.dir, 'actions.jsonl'), 'utf8') + readdirSync(recoveryDir).map(name => readFileSync(join(recoveryDir, name), 'utf8')).join('');
    for (const value of ['upload.txt', 'Reviewed upload', bytes.toString()]) expect(durable).not.toContain(value);
    const wire = f.sent[0]!;
    expect(createHash('sha256').update(wire.body).digest('hex')).toBe(f.reviews[0]!.bodySha256);
    expect(wire.contentType).toMatch(/^multipart\/form-data; boundary=MurageHL/);
    expect(wire.body.includes(bytes)).toBe(true); expect(wire.body.includes('changed after review')).toBe(false);
    expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    expect(f.sent).toHaveLength(1); expect(f.reviews).toHaveLength(1);
  } finally { f.stop(); }
});
it.each(operations)('host %s denied review sends no multipart request', async operation => {
  const f = fixture(operation, 'deny');
  try { await f.call(); expect(f.reviews).toHaveLength(1); expect(f.sent).toHaveLength(0); }
  finally { f.stop(); }
});
it.each(operations)('host %s cannot confirm a foreign response', async operation => {
  const f = fixture(operation, 'allow', undefined, 'foreign-response');
  try { expect((await f.call()).result).toMatchObject({ isError: true, structuredContent: { outcome: 'outcome_unknown' } }); expect(f.sent).toHaveLength(1); }
  finally { f.stop(); }
});
it.each(operations)('host %s lost response and restart never resends or falsely confirms an upload', async operation => {
  const f = fixture(operation, 'allow', undefined, 'lost-response');
  try {
    expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    expect(f.sent).toHaveLength(1);
    // With the original authority metadata still held, reconciliation performs
    // exactly the durable declared read, never another upload.
    expect((await f.call()).result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    const target = operation === 'media.files.upload' ? '/medias/files' : '/conversations/conversation_1/messages';
    expect(f.reads.at(-1)).toBe(target);
    expect(f.sent).toHaveLength(1);
  } finally { f.stop(); vi.restoreAllMocks(); }
  const restarted = fixture(operation, 'allow', f.dir); restarted.actions.recover();
  try {
    const result = await restarted.call();
    expect(result.result).toMatchObject({ structuredContent: { outcome: 'outcome_unknown' } });
    const row = restarted.actions.get(f.reviews[0]!.actionId)!;
    expect(restarted.approvals.get(row.approvalId!), JSON.stringify(result)).toMatchObject({ state: 'conflict', reason: 'unconfirmed' });
    expect(restarted.sent).toHaveLength(0); expect(restarted.reviews).toHaveLength(0);
  } finally { restarted.stop(); }
});
