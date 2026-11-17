import { fixtureFamilyLevels } from '../server/highlevel/testing/family-grants.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs inside the isolated control fixture. All provider I/O is the in-memory fake.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HighLevelHost } from '../server/highlevel/host.ts';
import { HighLevelActions } from '../server/highlevel/actions.ts';
import { FileActionJournal } from '../server/highlevel/journal-file.ts';
import { FileRpcApprovalJournal } from '../server/highlevel/rpc-approval-replay.ts';
import { UserCreateIdentityClaims } from '../server/highlevel/users-create-identity.ts';
import { operationSpec } from '../server/highlevel/operations/registry.ts';
import { HighLevelReviewCards } from '../server/highlevel/review-cards.ts';
import { captureUserCreateOutput } from '../server/testing/userscreate-output-capture.ts';
import { HighLevelLeakGuardV2 } from '../server/testing/highlevel-leak-guard-v2.ts';
import { highLevelHarness, FAKE_COMPANY_ID, FAKE_LOCATION_ID } from '../server/testing/fake-highlevel.ts';
import { validHighLevelPassword } from '../shared/highlevel-password.ts';
export async function runFixtureEvidence(dataDir: string, remember: (secret: string) => Promise<void>) {
  const output = captureUserCreateOutput();
  const prior = process.env.HL_USERSCREATE_RECIPIENT_VERIFIED;
  process.env.HL_USERSCREATE_RECIPIENT_VERIFIED = 'true';
  const root = join(dataDir, 'userscreate-evidence'); mkdirSync(root, { recursive: true });
  const args = { companyId: FAKE_COMPANY_ID, email: 'fixture@fixture.test', firstName: 'Fixture', lastName: 'User',
    type: 'account', role: 'user', locationIds: [FAKE_LOCATION_ID] };
  const secrets: string[] = [];
  let guard: HighLevelLeakGuardV2 | undefined, interrupted = true;
  function fixture(restart: boolean) {
    const h = highLevelHarness();
    h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2,
      grants: [{ ...h.grant(), families: fixtureFamilyLevels({ users: 'full' }) }] };
    const actions = new HighLevelActions({ journal: new FileActionJournal(join(root, 'actions.jsonl')) });
    if (restart) actions.recover();
    const journal = new FileRpcApprovalJournal(join(root, 'approvals'));
    const claims = new UserCreateIdentityClaims(join(root, 'claims.sqlite'));
    const settle = journal.settle.bind(journal);
    journal.settle = (...input) => { if (interrupted) { interrupted = false; throw new Error('fixture settlement interruption'); } return settle(...input); };
    h.api.always('GET', /^\/users\/$/, { status: 200, body: { users: restart ? [{ id: 'fixture_user', ...args }] : [] } });
    h.api.always('POST', /^\/users\/$/, async request => {
      const body = request.body as Record<string, unknown>;
      assert.equal(validHighLevelPassword(body.password), true);
      assert.equal(typeof body.password === 'string' && body.password.length === 32, true);
      secrets.push(body.password as string); guard = new HighLevelLeakGuardV2(secrets);
      await remember(body.password as string);
      // The fake is the provider boundary. Never persist or retain its wire body.
      request.body = undefined;
      return { status: 201, body: { user: { id: 'fixture_user', ...args } } };
    });
    const cards = fixtureCards(root, actions, () => guard);
    const host = new HighLevelHost({ ...h, actions, approvalJournal: journal, userCreateClaims: claims,
      bot: () => h.bot, operationSpec, userCreateOwner: () => true, operationScopes: () => ['users.write', 'users.readonly'],
      onReview: (_claim, review) => {
        h.reviews.push(review); assert.equal(review.completionKind, 'private_generated_password_v1');
        cards.opened(h.claim, review);
        assert.equal(cards.resolve(h.claim.threadId, `highlevel-${review.actionId}`, 'allow', { desktop: true, reviewDigest: review.reviewDigest }), 'allowed-once');
      }, onReviewClosed: id => cards.closed(id),
      onOutcome: (_claim, outcome) => cards.outcome(outcome) });
    const call = () => host.handle(h.claim, { jsonrpc: '2.0', id: 'fixture-create', method: 'tools/call',
      params: { name: 'HIGHLEVEL_USERS', arguments: { operation: 'users.create', args } } });
    return { ...h, call, close: () => { h.stop(); claims.close(); } };
  }
  try {
    const first = fixture(false);
    try {
      const result = await first.call();
      assert.equal((result.result as any).structuredContent.outcome, 'outcome_unknown');
      assert.equal(first.api.calls('POST').length, 1); assert.equal(first.reviews.length, 1);
      guard!.wrapSink('tool_context', (value: unknown) => writeFileSync(join(root, 'result.json'), JSON.stringify(value)))(result);
      guard!.wrapSink('model_context', (value: unknown) => writeFileSync(join(root, 'transcript.json'), JSON.stringify(value)))([result, first.reviews]);
      output.assertClean(guard!);
    } finally { first.close(); }
    output.assertClean(guard!);
    return { firstCreates: 1, policyValid: true, outcome: 'outcome_unknown', processOutput: 'intercepted and clean' };
  } finally {
    output.restore(); secrets.fill('');
    if (prior === undefined) delete process.env.HL_USERSCREATE_RECIPIENT_VERIFIED; else process.env.HL_USERSCREATE_RECIPIENT_VERIFIED = prior;
  }
}

/** A fresh server process reads the persisted uncertain request; creation remains disabled. */
export async function runRestartEvidence(dataDir: string, secrets: string[]) {
  const output = captureUserCreateOutput(), guard = new HighLevelLeakGuardV2(secrets);
  const root = join(dataDir, 'userscreate-evidence'), h = highLevelHarness();
  const args = { companyId: FAKE_COMPANY_ID, email: 'fixture@fixture.test', firstName: 'Fixture', lastName: 'User',
    type: 'account', role: 'user', locationIds: [FAKE_LOCATION_ID] };
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2,
    grants: [{ ...h.grant(), families: fixtureFamilyLevels({ users: 'full' }) }] };
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(root, 'actions.jsonl')) }); actions.recover();
  const journal = new FileRpcApprovalJournal(join(root, 'approvals'));
  const claims = new UserCreateIdentityClaims(join(root, 'claims.sqlite'));
  h.api.always('GET', /^\/users\/$/, { status: 200, body: { users: [{ id: 'fixture_user', ...args }] } });
  const cards = fixtureCards(root, actions, () => guard);
  const host = new HighLevelHost({ ...h, actions, approvalJournal: journal, userCreateClaims: claims,
    bot: () => h.bot, operationSpec, userCreateOwner: () => true, operationScopes: () => ['users.write', 'users.readonly'],
    onReview: () => { throw new Error('Restart must not open another review'); },
    onOutcome: (_claim, outcome) => cards.outcome(outcome) });
  try {
    const result = await host.handle(h.claim, { jsonrpc: '2.0', id: 'fixture-create', method: 'tools/call',
      params: { name: 'HIGHLEVEL_USERS', arguments: { operation: 'users.create', args } } });
    assert.equal((result.result as any).structuredContent.outcome, 'applied');
    assert.equal(h.api.calls('POST').length, 0); assert.equal(h.api.calls('GET').length, 1);
    guard.wrapSink('tool_context', (value: unknown) => writeFileSync(join(root, 'reconciled.json'), JSON.stringify(value)))(result);
    output.assertClean(guard);
    return { restartCreates: 0, restartReads: 1, recipientFlag: process.env.HL_USERSCREATE_RECIPIENT_VERIFIED ?? 'unset',
      outcome: 'applied_by_read_reconciliation', result };
  } finally { h.stop(); claims.close(); output.restore(); secrets.fill(''); }
}

/** The real review-card renderer writes through this fixture's persistent
 * transcript adapter. Outcome callbacks are wired at the actual host boundary.
 * There is no telemetry sender or Electron IPC in this server-only fake flow. */
function fixtureCards(root: string, actions: HighLevelActions, guard: () => HighLevelLeakGuardV2 | undefined) {
  const messages: any[] = [];
  const write = (value: unknown) => writeFileSync(join(root, 'cards-transcript.json'), JSON.stringify(value));
  const checked = (sink: 'model_context' | 'event_stream', value: unknown) => {
    const active = guard();
    if (active) active.wrapSink(sink, write)(value); else write(value); // review precedes secret generation
  };
  const cards = new HighLevelReviewCards({ actions, store: {
    appendMessage: (_thread: string, row: any) => {
      const next = { ...row, id: String(messages.length) }; messages.push(next); checked('model_context', messages); return next;
    },
    messageById: (_thread: string, id: string) => messages.find(row => row.id === id),
    patchMessage: (_thread: string, id: string, patch: any) => {
      Object.assign(messages.find(row => row.id === id), patch); checked('model_context', messages);
    },
  } as any, waiting() {} });
  return { opened: cards.opened.bind(cards), resolve: cards.resolve.bind(cards), closed: cards.closed.bind(cards),
    outcome(value: { actionId: string }) { cards.closed(value.actionId); checked('event_stream', [...messages, value]); } };
}
