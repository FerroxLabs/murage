import { expect, it } from 'vitest';
import { HighLevelActions, reviewDigestFor } from './actions.ts';
import { fixtureHeld } from '../testing/highlevel-r4-fixtures.ts';
import { canonicalJson } from './operations/registry.ts';
import { parseIntent } from './journal-file.ts';

const context = { botId: 'bot', threadId: 'thread', turnGeneration: 'turn', connectionId: 'conn', connectionEpoch: 1,
  locationId: 'loc', companyId: 'co', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'role' };
const detail = () => ({ held: fixtureHeld(), kind: 'change' as const, risk: 'C' as const, escalation: 'none' as const,
  basis: 'owner_exact_review' as const, recordRefs: [], fields: [] });

it('F0 proposal derives every binding from held bytes and explicit authority', () => {
  const actions = new HighLevelActions(), d = detail();
  const review = actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, d);
  const binding = { kind: d.kind, operation: d.held.frozen.operation, resource: d.held.frozen.resource, risk: d.risk,
    escalation: d.escalation, basis: d.basis, requestDigest: d.held.frozen.requestDigest,
    bodySha256: d.held.frozen.bodySha256, upload: null };
  expect(review).toMatchObject(binding);
  expect(actions.get(review.actionId)).toMatchObject(binding);
  expect(parseIntent(actions.get(review.actionId))).toMatchObject(binding);
});
it('F0 review digest binds kind and the separate wire body hash', () => {
  const actions = new HighLevelActions();
  const review = actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, detail());
  const intent = actions.get(review.actionId)!;
  for (const change of [{ kind: 'read' as const }, { bodySha256: 'a'.repeat(64) }]) {
    expect(reviewDigestFor({ ...intent, ...change })).not.toBe(reviewDigestFor(intent));
  }
});
it('F0 non-multipart copy explicitly has no file range', () => {
  expect(fixtureHeld().sendCopy()).toMatchObject({ fileOffset: null, fileLength: null });
});
it('F0 canonical JSON preserves lexical numeric-key ordering', () => {
  expect(Buffer.from(canonicalJson({ '2': 2, '10': 10 })).toString()).toBe('{"10":10,"2":2}');
});

import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileActionJournal } from './journal-file.ts';
import { fixtureActionDetail } from '../testing/highlevel-r4-fixtures.ts';
import { PreparedUpload } from './uploads.ts';
import { removeTempDir } from '../testing/cleanup.ts';
it('F0 file journal keeps upload names out of durable history and stales on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-f0-'));
  try {
    const path = join(dir, 'actions.jsonl'), actions = new HighLevelActions({ journal: new FileActionJournal(path) });
    const d = fixtureActionDetail({ prepared: new PreparedUpload('PRIVATE_FILENAME_SENTINEL.txt', Buffer.from('PRIVATE_BYTES_SENTINEL')) }, context);
    const review = actions.propose(context, 'HIGHLEVEL_MEDIA', {}, d);
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE_FILENAME_SENTINEL');
    expect(readFileSync(path, 'utf8')).not.toContain('PRIVATE_BYTES_SENTINEL');
    const restarted = new HighLevelActions({ journal: new FileActionJournal(path) }); restarted.recover();
    expect(restarted.get(review.actionId)?.phase).toBe('stale');
  } finally { removeTempDir(dir); }
});
it('F0 journal migration keeps prior records terminal and never invents approval', () => {
  const actions = new HighLevelActions(), review = actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, detail());
  const { kind: _kind, upload: _upload, ...legacy } = actions.get(review.actionId)!;
  expect(parseIntent(legacy)).toMatchObject({ actionId: review.actionId, phase: 'stale', outcomeCode: 'review_values_gone' });
  expect(parseIntent({ ...legacy, phase: 'dispatching', dispatchAttempts: 1 })).toMatchObject({ phase: 'outcome_unknown' });
  expect(parseIntent({ ...legacy, unexpected: 'untrusted' })).toBeNull();
});

import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
it('F0 optional anchored reader survives server bundling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-f0-bundle-'));
  try {
    const outfile = join(dir, 'uploads.mjs');
    await build({ entryPoints: ['server/highlevel/uploads.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node24',
      plugins: [{ name: 'isolated-helper', setup(b) { b.onLoad({ filter: /highlevel\/anchored-read\.ts$/ }, () => ({ contents: `export function readAnchoredFile() { return { bytes: new Uint8Array([42]), size: 1, volume: 'v', fileId: 'f' }; }`, loader: 'ts' })); } }] });
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import { prepareWorkspaceUpload } from ${JSON.stringify(outfile)}; console.log(prepareWorkspaceUpload('/isolated', {workspaceFile:'fixture'}).size);`], { encoding: 'utf8', timeout: 3000 });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe('1');
  } finally { removeTempDir(dir); }
});

import { createHash } from 'node:crypto';
import { validateFrozenCopy } from './held-validation.ts';
it.each(['fileOffset', 'fileLength'] as const)('F0 multipart copy range is exact and refuses changed %s', field => {
  const d = fixtureActionDetail({ prepared: new PreparedUpload('fixture.txt', Buffer.from('file bytes')) }, context);
  const out = d.held.sendCopy();
  expect(out.fileLength).toBe(10);
  const file = out.body!.subarray(out.fileOffset!, out.fileOffset! + out.fileLength!);
  expect(createHash('sha256').update(file).digest('hex')).toBe(d.held.frozen.upload!.sha256);
  expect(() => validateFrozenCopy(d.held, out, d.held.frozen.requestDigest)).not.toThrow();
  out[field]!++;
  expect(() => validateFrozenCopy(d.held, out, d.held.frozen.requestDigest)).toThrow(expect.objectContaining({ code: 'stale' }));
});

import { HIGHLEVEL_OPERATION_MANIFEST, type ReadSpec, type RequestDraft } from './operations/registry.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import { HeldRequest } from './held-request.ts';
it.each(['contacts.get', 'contacts.search'])('T-D5 F0 manifest/schema identity freezes %s and rejects another location', id => {
  const row = HIGHLEVEL_OPERATION_MANIFEST.find(r => r.id === id)!;
  const draft: RequestDraft = id === 'contacts.get' ? { path: '/contacts/c1', resource: 'contacts:contact:c1', query: { locationId: 'loc' } }
    : { path: '/contacts/search', resource: 'location:loc', body: { kind: 'json', value: { locationId: 'loc', page: 1, pageLimit: 10 } } };
  const spec: ReadSpec<any> = { id: row.id, family: row.family, row, args: row.argsSchema, endpoint: HIGHLEVEL_ENDPOINTS[id]!, risk: 'R', title: 'Fixture',
    preflight: row.preflight, nested: false, maxReads: 1, prepareRead: async () => draft,
    recordRefs: () => [], fields: () => [], targets: () => 1, project: value => value };
  expect(HeldRequest.freeze(spec, draft, { locationId: 'loc' }).frozen.operation).toBe(id);
  expect(() => HeldRequest.freeze(spec, draft, { locationId: 'other' })).toThrow(expect.objectContaining({ code: 'request_shape' }));
});
