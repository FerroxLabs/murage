import { fixtureFamilyLevels } from './testing/family-grants.ts';
// SPDX-License-Identifier: AGPL-3.0-or-later
// Deliberately imports only modules present at 0567676f1. The same behavioral
// tests must collect there and fail assertions, then pass on the redesigned tree.
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HighLevelActions } from './actions.ts';
import { FileActionJournal } from './journal-file.ts';
import { FileRpcApprovalJournal } from './rpc-approval-replay.ts';
import { UserCreateIdentityClaims } from './users-create-identity.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { HighLevelHost } from './host.ts';
import { operationSpec } from './operations/registry.ts';
import { highLevelHarness, FAKE_COMPANY_ID, FAKE_LOCATION_ID } from '../testing/fake-highlevel.ts';
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map(dir => removeTempDir(dir))); });
function fixture() {
  const h = highLevelHarness({ deadlineMs: 1000 });
  h.bot.highlevelAccess = { ...(h.bot.highlevelAccess as object), grantsVersion: 2,
    grants: [{ ...h.grant(), families: fixtureFamilyLevels({ users: 'full' }) }] };
  const dir = mkdtempSync(join(tmpdir(), 'hl-starting-')); dirs.push(dir);
  const actions = new HighLevelActions({ journal: new FileActionJournal(join(dir, 'actions.jsonl')), now: () => h.now });
  const approvalJournal = new FileRpcApprovalJournal(join(dir, 'approvals'));
  const claims = new UserCreateIdentityClaims(join(dir, 'claims.sqlite'));
  const args = { companyId: FAKE_COMPANY_ID, email: 'starting@fixture.test', firstName: 'Starting', lastName: 'Fixture',
    type: 'account', role: 'user', locationIds: [FAKE_LOCATION_ID] };
  h.api.always('GET', /^\/users\/$/, { status: 200, body: { users: [] } });
  h.api.always('POST', /^\/users\/$/, { status: 201, body: { user: { id: 'starting_user', ...args } } });
  const host = new HighLevelHost({ ...h, actions, approvalJournal, userCreateClaims: claims,
    bot: () => h.bot, operationSpec, userCreateOwner: () => true, ...{ desktopPasswordOwner: () => true },
    operationScopes: () => ['users.write', 'users.readonly'],
    onReview: (_claim, review) => {
      h.reviews.push(review);
      // Old desktop-only completion is denied immediately, so RED is bounded
      // and never depends on unavailable native widget/session modules.
      if (String(review.completionKind) === 'private_generated_password_v1') actions.approve(review.actionId, review.reviewDigest);
      else actions.deny(review.actionId);
    } });
  return { ...h, close() { h.stop(); claims.close(); }, call: () => host.handle(h.claim, { jsonrpc: '2.0', id: 'starting-create', method: 'tools/call',
    params: { name: 'HIGHLEVEL_USERS', arguments: { operation: 'users.create', args } } }) };
}
it('starting RED: missing recipient flag hands off before inventory or review', async () => {
  vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', undefined);
  const h = fixture();
  try {
    const result = await h.call();
    expect(h.api.requests.length, 'default-off must send zero provider requests').toBe(0);
    expect(h.reviews.length).toBe(0);
    expect(JSON.stringify(result)).toContain('Add this user in HighLevel to finish setting up their access.');
  } finally { h.close(); }
});
it('starting RED: exact ordinary approval creates privately without desktop completion', async () => {
  vi.stubEnv('HL_USERSCREATE_RECIPIENT_VERIFIED', 'true');
  const h = fixture();
  try {
    const result = await h.call();
    expect(h.reviews.length).toBe(1);
    expect(String(h.reviews[0]!.completionKind), 'ordinary private completion replaces the native password path').toBe('private_generated_password_v1');
    expect((result.result as any)?.structuredContent?.outcome).toBe('applied');
    expect(h.api.calls('POST').length).toBe(1);
    const body = h.api.calls('POST')[0]!.body as Record<string, unknown>;
    expect(typeof body.password === 'string' && body.password.length === 32).toBe(true);
    h.api.calls('POST')[0]!.body = undefined;
  } finally { h.close(); }
});
