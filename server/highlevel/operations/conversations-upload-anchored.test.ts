// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { removeTempDirSync } from '../../testing/cleanup.ts';
import { readAnchoredFile, type AnchoredReadHooks } from '../anchored-read.ts';
import { prepareWorkspaceUpload } from '../uploads.ts';
import { HighLevelClient } from '../client.ts';
import { HighLevelHost } from '../host.ts';
import { HIGHLEVEL_OPERATION_MANIFEST, operationSpec } from './registry.ts';
import { highLevelHarness, FAKE_LOCATION_ID as locationId } from '../../testing/fake-highlevel.ts';

const roots: string[] = [];
function fixture() {
  const base = fs.mkdtempSync(join(tmpdir(), 'hlf3-anchored-')); roots.push(base);
  const root = join(base, 'workspace'); fs.mkdirSync(root);
  fs.mkdirSync(join(root, 'dir')); fs.writeFileSync(join(root, 'dir', 'file'), 'inside');
  fs.mkdirSync(join(base, 'outside')); fs.writeFileSync(join(base, 'outside', 'file'), 'SECRET');
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) removeTempDirSync(root); });
function upload(root: string, hooks?: AnchoredReadHooks) {
  let identity: ReturnType<typeof readAnchoredFile> | undefined;
  const prepared = prepareWorkspaceUpload(root, { workspaceFile: 'dir/file' }, 100, (r, p, m) => {
    identity = readAnchoredFile(r, p, m, hooks); return identity;
  });
  expect(identity).toBeDefined();
  return { prepared, identity: identity! };
}
function swap(root: string) {
  fs.renameSync(join(root, 'dir'), join(root, 'held'));
  fs.symlinkSync(join(root, '..', 'outside'), join(root, 'dir'), process.platform === 'win32' ? 'junction' : 'dir');
}
function restore(root: string) { fs.unlinkSync(join(root, 'dir')); fs.renameSync(join(root, 'held'), join(root, 'dir')); }
// Linux O_DIRECTORY | O_NOFOLLOW reports ENOTDIR for a directory link. The
// owning hlc3 reader maps that refusal to not_directory, while native uses link.
const directoryLinkCode = process.platform === 'linux' ? 'not_directory' : 'link';
it('hlf3.uploadHooksInterleaveWithOpens', () => {
  const root = fixture();
  const result = upload(root, { afterStep(step) {
    if (step.kind === 'root') { fs.unlinkSync(join(root, 'dir', 'file')); fs.writeFileSync(join(root, 'dir', 'file'), 'NEW'); }
  } });
  expect(Buffer.from(result.prepared.copyBytes()).toString()).toBe('NEW');
});
it('hlf3.uploadDirSwapPersistsRefusedAsLink/root', () => {
  const root = fixture();
  expect(() => upload(root, { afterStep(step) { if (step.kind === 'root') swap(root); } })).toThrowError(expect.objectContaining({ code: directoryLinkCode }));
});
for (const point of ['root', 'dir'] as const) it(`hlf3.uploadSwapAndRestore/${point}`, () => {
  const root = fixture(), inside = fs.statSync(join(root, 'dir', 'file'), { bigint: true });
  let swapped = false;
  const run = () => upload(root, { afterStep(step) {
    if (swapped) { restore(root); swapped = false; }
    if (step.kind === point) { swap(root); swapped = true; }
  } });
  if (point === 'root') expect(run).toThrowError(expect.objectContaining({ code: directoryLinkCode }));
  else {
    const result = run();
    expect(Buffer.from(result.prepared.copyBytes()).toString()).toBe('inside');
    expect(result.identity.fileId).toBe(inside.ino.toString());
    expect(result.identity.volume).toBe(inside.dev.toString());
  }
});
it('hlf3.uploadFinalLinkAndHardLink', () => {
  const root = fixture(); fs.unlinkSync(join(root, 'dir', 'file'));
  fs.symlinkSync(join(root, '..', 'outside', 'file'), join(root, 'dir', 'file'), 'file');
  expect(() => upload(root)).toThrowError(expect.objectContaining({ code: 'link' }));
  fs.unlinkSync(join(root, 'dir', 'file')); fs.linkSync(join(root, '..', 'outside', 'file'), join(root, 'dir', 'file'));
  expect(() => upload(root)).toThrowError(expect.objectContaining({ code: 'hard_link' }));
});
it('hlf3.uploadTwinWithoutHooks', () => {
  const root = fixture(), first = upload(root), second = upload(root);
  expect(second.identity).toEqual(first.identity);
  expect(second.prepared.copyBytes()).toEqual(first.prepared.copyBytes());
});
it('hlf3.attachmentUploadEndToEnd', async () => {
  const root = fixture(), h = highLevelHarness({ deadlineMs: 3000 });
  const access = h.bot.highlevelAccess as any; access.grantsVersion = 2; access.grants[0].families = { conversations: 'full', contacts: 'read' };
  h.api.always('GET', /^\/conversations\/conv_1$/, { status: 200, body: { id: 'conv_1', locationId, contactId: 'contact_1' } });
  let wire: Buffer | undefined;
  const client = new HighLevelClient({ leases: h.leases, fetch: (async (url: any, init: any) => {
    if (new URL(String(url)).pathname === '/conversations/messages/upload') {
      wire = Buffer.from(init.body);
      return new Response(JSON.stringify({ uploadedFiles: { file: 'https://fixture.invalid/file' } }), { status: 200 });
    }
    return h.api.fetch(url, init);
  }) as typeof fetch });
  const host = new HighLevelHost({ ...h, client, bot: () => h.bot, operationSpec,
    operationScopes: () => [...new Set(HIGHLEVEL_OPERATION_MANIFEST.map(r => r.scope).filter((s): s is string => !!s))],
    workspaceRoot: () => root, approvalBasis: () => 'owner_exact_review',
    onReview: (_claim, review) => { h.reviews.push(review); h.actions.approve(review.actionId, review.reviewDigest); },
  });
  try {
    const result = await host.handle(h.claim, { jsonrpc: '2.0', id: 'real-upload', method: 'tools/call', params: { name: 'HIGHLEVEL_CONVERSATIONS', arguments: { operation: 'conversations.attachment.upload', args: { conversationId: 'conv_1', file: { workspaceFile: 'dir/file' } } } } });
    expect(result.result).toMatchObject({ structuredContent: { outcome: 'applied' } });
    const frozen = h.actions.get(h.reviews[0]!.actionId)!;
    expect(wire).toBeDefined();
    expect(createHash('sha256').update(wire!).digest('hex')).toBe(frozen.bodySha256);
    const fileHeader = wire!.indexOf(Buffer.from('filename="file"'));
    expect(fileHeader).toBeGreaterThan(0);
    const start = wire!.indexOf(Buffer.from('\r\n\r\n'), fileHeader) + 4;
    const end = wire!.lastIndexOf(Buffer.from('\r\n--'));
    expect(wire!.subarray(start, end).toString()).toBe('inside');
    expect(createHash('sha256').update(wire!.subarray(start, end)).digest('hex')).toBe(frozen.upload!.sha256);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  } finally { h.stop(); }
});
