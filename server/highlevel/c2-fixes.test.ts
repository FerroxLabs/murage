import { defaultHighLevelFamilies } from "../../shared/highlevel.ts";
import { fixtureActionDetail } from '../testing/highlevel-r4-fixtures.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
import { fixtureSpec, fixtureReadSpec, fixtureHeld } from '../testing/highlevel-r4-fixtures.ts';
import type { ReadSpec } from './operations/registry.ts';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { HighLevelActions, type ActionContext } from './actions.ts';
import { FileActionJournal, parseIntent } from './journal-file.ts';
import { HIGHLEVEL_PROVIDER_MANIFEST } from './provider-manifest.ts';
import { HIGHLEVEL_ENDPOINTS } from './provider-contract.ts';
import { HighLevelHost } from './host.ts';
import type { OperationSpec } from './operations/registry.ts';
import { FAKE_LOCATION_ID, highLevelHarness, scriptCrm, until } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';

it.skipIf(process.platform === 'win32')('upload.fifoRejectedWithoutBlocking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-fifo-'));
  try {
    expect(spawnSync('mkfifo', [join(dir, 'pipe')]).status).toBe(0);
    // Isolate the synchronous open so the regression fails without hanging the test runner.
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { prepareWorkspaceUpload } from ${JSON.stringify(new URL('./uploads.ts', import.meta.url).href)};
      import { AnchoredReadRefused } from ${JSON.stringify(new URL('./anchored-read.ts', import.meta.url).href)};
      assert.throws(() => prepareWorkspaceUpload(process.argv[1], { workspaceFile: 'pipe' }),
        error => error instanceof AnchoredReadRefused && (error.code === 'not_regular' || error.code === 'unsupported'));
    `, dir], { timeout: 2000, encoding: 'utf8' });
    expect(child.error, 'upload must reject a FIFO without waiting for a writer').toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  } finally { removeTempDir(dir); }
});

const context: ActionContext = { botId: 'bot', threadId: 'thread', turnGeneration: 'turn', connectionId: 'conn', connectionEpoch: 1,
  locationId: 'loc', companyId: 'co', grantRevision: 1, accessRevision: 1, policyRevision: 1, roleBinding: 'role' };
it('journal.text2payTransitionsRecoverAndAllowSubsequentChanges', () => {
  const dir = mkdtempSync(join(tmpdir(), 'c2-journal-'));
  try {
    const file = join(dir, 'actions.jsonl'), actions = new HighLevelActions({ journal: new FileActionJournal(file) });
    const review = actions.propose(context, 'HIGHLEVEL_PAYMENTS', {}, fixtureActionDetail({ operation: 'payments.invoice.text2pay', risk: 'D', recordRefs: [], fields: [], held: fixtureHeld('payments.invoice.text2pay') }, context));
    actions.approve(review.actionId, review.reviewDigest);
    actions.beginDispatch(review.actionId, context);
    actions.recordAttempt(review.actionId, 1, context);
    let journal!: FileActionJournal;
    expect(() => { journal = new FileActionJournal(file); }).not.toThrow();
    const recovered = new HighLevelActions({ journal }); recovered.recover();
    expect(recovered.get(review.actionId)).toMatchObject({ operation: 'payments.invoice.text2pay', phase: 'outcome_unknown', dispatchAttempts: 1 });
    const next = recovered.propose(context, 'HIGHLEVEL_CONTACTS', {}, fixtureActionDetail({ operation: 'contacts.update', risk: 'C', recordRefs: [], fields: [] }, context));
    expect(next.actionId).not.toBe(review.actionId);
    expect(new FileActionJournal(file).all()).toHaveLength(2);
  } finally { removeTempDir(dir); }
});
it('journal.operationValidationUsesFrozenContract', () => {
  const actions = new HighLevelActions();
  const review = actions.propose(context, 'HIGHLEVEL_CONTACTS', {}, fixtureActionDetail({ recordRefs: [], fields: [] }, context));
  const row = actions.get(review.actionId)!;
  expect(HIGHLEVEL_PROVIDER_MANIFEST.filter(op => !parseIntent({ ...row, operation: op.operation })).map(op => op.operation)).toEqual([]);
  for (const operation of ['contacts..get', 'contacts.', 'unknown.get', 'contacts.unqualified', 'contacts.get/secret']) {
    expect(parseIntent({ ...row, operation }), operation).toBeNull();
  }
  expect(parseIntent(row)).not.toBeNull(); // Legacy rows have no operation.
});

function reviewedRead(nested = false, manualSleep = false) {
  const h = highLevelHarness({ manualSleep }); scriptCrm(h.api);
  const id = nested ? 'contacts.notes.list' : 'contacts.get';
  const access = { ...(h.bot.highlevelAccess as object), grantsVersion: 2, revision: 1, denyRules: ['HIGHLEVEL:R'],
    grants: [{ ...h.grant('read'), families: { ...defaultHighLevelFamilies(), contacts: 'read' }, operations: [id] }] };
  h.bot.highlevelAccess = access;
  const spec = fixtureSpec({ id, family: 'contacts', risk: 'R', title: 'Read contacts', endpoint: HIGHLEVEL_ENDPOINTS[id]!,
    nested, preflight: nested ? ['contacts.get'] : [], maxReads: 2,
    args: z.object({ contactId: z.string() }).strict(), recordRefs: (a: Record<string, unknown>) => [String(a.contactId)], fields: () => [], targets: () => 1,
    ...(nested ? { ownership: async (pre, a, ctx) => {
      const parent = await pre.read('contacts.get', { path: `/contacts/${a.contactId}` }) as { contact: { locationId: string } };
      if (parent.contact.locationId !== ctx.locationId) throw new Error('Wrong location');
    } } satisfies Partial<OperationSpec> : {}),
    project: (value: unknown) => value }, (a, _ctx) => ({ path: `/contacts/${a.contactId}${nested ? '/notes' : ''}`, resource: "" })) as ReadSpec;
  const host = new HighLevelHost({ ...h, bot: () => h.bot, operationSpec: op => op === spec.id ? spec : fixtureReadSpec(op), operationScopes: () => [spec.endpoint.scope],
    onReview: (_claim, review) => h.reviews.push(review) });
  const call = () => host.call(h.claim, 'HIGHLEVEL_CONTACTS', { operation: id, args: { contactId: 'contact_1' } });
  return { ...h, host, spec, access, call };
}
it('deny.approvedNestedReadRunsOwnershipBeforeReview', async () => {
  const h = reviewedRead(true);
  try {
    let settled = false;
    const pending = h.call().finally(() => { settled = true; });
    await until(() => settled || h.reviews.length > 0);
    expect(h.reviews).toHaveLength(1);
    expect(h.api.calls('GET').map(r => r.path)).toEqual(['/contacts/contact_1']);
    const review = h.reviews[0]!; h.actions.approve(review.actionId, review.reviewDigest);
    expect((await pending).isError).not.toBe(true);
    expect(h.api.calls('GET').map(r => r.path)).toEqual(['/contacts/contact_1', '/contacts/contact_1/notes']);
  } finally { h.stop(); }
});
it('deny.nestedReadWrongLocationNeverOffersReview', async () => {
  const h = reviewedRead(true);
  try {
    h.api.first('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { locationId: `${FAKE_LOCATION_ID}_other` } } });
    expect((await h.call()).isError).toBe(true);
    expect(h.api.calls('GET')).toHaveLength(1);
    expect(h.reviews).toHaveLength(0);
  } finally { h.stop(); }
});
it('deny.approvedReadRetriesSameFrozenPageOnly', async () => {
  const h = reviewedRead();
  try {
    h.api.first('GET', /^\/contacts\/contact_1$/, { status: 503 });
    h.spec.prepareRead = async a => ({ path: `/contacts/${a.contactId}`, resource: `contacts:record:${a.contactId}`, query: { page: '1' } });
    h.spec.nextPage = (_v, prev) => ({ ...prev, query: { page: '2' } });
    const pending = h.call(); await until(() => h.reviews.length > 0);
    expect(h.api.requests).toHaveLength(0);
    const review = h.reviews[0]!; h.actions.approve(review.actionId, review.reviewDigest);
    expect((await pending).isError).not.toBe(true);
    expect(h.api.requests.map(r => r.query.get('page'))).toEqual(['1', '1']);
    expect(h.actions.get(review.actionId)).toMatchObject({ phase: 'read_done', dispatchAttempts: 2 });
  } finally { h.stop(); }
});
it('deny.approvedReadBudgetRemainsBoundedWithoutUnknownMutationOutcome', async () => {
  const h = reviewedRead();
  try {
    h.spec.nextPage = (_v, prev) => prev;
    const pending = h.call(); await until(() => h.reviews.length > 0);
    const review = h.reviews[0]!; h.actions.approve(review.actionId, review.reviewDigest);
    expect((await pending).isError).not.toBe(true);
    expect(h.api.requests).toHaveLength(1);
    expect(h.actions.get(review.actionId)).toMatchObject({ phase: 'read_done', dispatchAttempts: 1 });
  } finally { h.stop(); }
});
it.each(['expiry', 'grantRevision', 'stop'] as const)('deny.approvedReadRechecks%sBeforeRetry', async change => {
  const h = reviewedRead(false, true);
  try {
    h.api.first('GET', /^\/contacts\/contact_1$/, { status: 503 });
    const pending = h.call(); await until(() => h.reviews.length > 0);
    const review = h.reviews[0]!; h.actions.approve(review.actionId, review.reviewDigest);
    await until(() => h.sleeps.length > 0);
    if (change === 'expiry') h.advance(11 * 60_000);
    else if (change === 'grantRevision') h.access.grants[0]!.revision++;
    else h.stop();
    h.releaseSleeps();
    expect(await pending).toMatchObject({ isError: true, structuredContent: { outcome: change === 'stop' ? 'not_applied' : 'stale' } });
    expect(h.api.requests).toHaveLength(1);
    expect(h.actions.get(review.actionId)?.dispatchAttempts).toBe(1);
  } finally { h.stop(); h.releaseSleeps(); }
});
