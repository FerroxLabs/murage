// Copyright 2026 Ferrox Labs
// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultHighLevelFamilies, type FamilyLevel } from '../../shared/highlevel.ts';
import { accessRoleBinding } from '../bot-access-role.ts';
import { highLevelHarness, until } from '../testing/fake-highlevel.ts';
import { removeTempDir } from '../testing/cleanup.ts';
import { createHighLevelRuntime, highlevelGrantUpdate, highlevelFamilyScopes } from './runtime.ts';
import { highlevelApprovalBasis } from './host.ts';
import type { ActionReview } from './actions.ts';
const cleanups: Array<() => unknown> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0)) await close(); });
function fixture(level: FamilyLevel, mark: "marked" | "unmarked" | "unreadable" = "marked") {
  const h = highLevelHarness(); cleanups.push(h.stop);
  const dir = mkdtempSync(join(tmpdir(), 'hlc1-management-')); cleanups.push(() => removeTempDir(dir));
  let revision = 0;
  const save = (next: FamilyLevel) => {
    const changed = highlevelGrantUpdate([{ connectionId: h.grant().accountId, families: { ...defaultHighLevelFamilies(), contacts: next }, broaden: { contacts: true } }], {
      connection: { connectionId: h.grant().accountId, locationId: 'loc_fixture_01', state: 'connected', confirmedAt: 'fixture' },
      botId: h.bot.id, roleBinding: accessRoleBinding(h.bot), previous: h.bot.highlevelAccess,
      revision: ++revision, driverKind: 'fuigoAgent', desktop: true,
    });
    expect(changed.ok).toBe(true); if (!changed.ok) throw new Error('grant refused');
    h.bot.highlevelAccess = { grantsVersion: 2, roleBinding: accessRoleBinding(h.bot), revision, grants: changed.grants, denyRules: changed.denyRules };
  };
  save(level);
  const rt = createHighLevelRuntime({ threadMarkState: () => mark, dataDir: dir, capabilities: h.capabilities, signals: h.signals, bot: () => h.bot,
    leases: h.leases, fetch: h.api.fetch, operationScopes: () => ['contacts.readonly', 'contacts.write'] });
  const reviews: ActionReview[] = [];
  rt.host.configureReview({ onReview: (_claim, review) => { reviews.push(review); }, approvalBasis: () => 'owner_exact_review' });
  h.api.always('GET', /^\/contacts\/contact_1$/, { status: 200, body: { contact: { id: 'contact_1', locationId: 'loc_fixture_01', tags: [] } } });
  h.api.always('POST', /^\/contacts\/contact_1\/tags$/, { status: 200, body: { tags: ['fixture'] } });
  h.api.always('DELETE', /^\/contacts\/contact_1$/, { status: 200, body: { succeeded: true } });
  const call = (id: string, destructive = false) => rt.host.handle(h.claim, { jsonrpc: '2.0', id, method: 'tools/call', params: {
    name: 'HIGHLEVEL_CONTACTS', arguments: { operation: destructive ? 'contacts.delete' : 'contacts.tags.add', args: destructive ? { contactId: 'contact_1' } : { contactId: 'contact_1', tags: ['fixture'] } },
  } });
  return { ...h, rt, reviews, save, call };
}
it.each(['change', 'full'] as const)('saved %s grant reaches exact review and one journaled dispatch', async level => {
  const h = fixture(level), destructive = level === 'full';
  const pending = h.call('same-request', destructive);
  await until(() => h.reviews.length === 1);
  expect(h.api.calls(destructive ? 'DELETE' : 'POST')).toHaveLength(0);
  const review = h.reviews[0]!;
  h.rt.actions.approve(review.actionId, review.reviewDigest);
  const result = await pending;
  expect(result).toMatchObject({ result: { structuredContent: { outcome: 'applied' } } });
  expect(await h.call('same-request', destructive)).toEqual(result);
  expect(h.api.calls(destructive ? 'DELETE' : 'POST')).toHaveLength(1);
  expect(h.rt.actions.get(review.actionId)?.phase).toBe('applied');
});
it('read refuses changes and change refuses destructive calls before any provider access', async () => {
  const h = fixture('read');
  expect(await h.call('read')).toMatchObject({ result: { isError: true } });
  h.save('change');
  expect(await h.call('change', true)).toMatchObject({ result: { isError: true } });
  expect(h.api.requests).toHaveLength(0); expect(h.reviews).toHaveLength(0);
});
it('downgrade during exact review prevents dispatch', async () => {
  const h = fixture('full'), pending = h.call('downgrade', true);
  await until(() => h.reviews.length === 1); const review = h.reviews[0]!;
  h.save('read'); h.rt.actions.approve(review.actionId, review.reviewDigest);
  expect(await pending).toMatchObject({ result: { isError: true } });
  expect(h.api.calls('DELETE')).toHaveLength(0);
  expect(h.rt.actions.get(review.actionId)?.phase).toBe('stale');
});
it('HighLevel No limits does not hold an ordinary matched owner rule for review', () => {
  expect(highlevelApprovalBasis({ risk: 'C', noLimits: true, operation: 'contacts.update', tool: 'HIGHLEVEL_CONTACTS', denyRules: ['HIGHLEVEL_CONTACTS'] })).toBe('owner_no_limits');
});
it('scope inventory reports the frozen operation families including location', () => {
  expect(highlevelFamilyScopes(['locations.readonly']).location.present).toContain('locations.readonly');
});
it.each([
  { operation: 'contacts.tags.add', args: { contactId: 'contact_1', tags: ['fixture'], token: 'untrusted' } },
  { operation: 'opportunities.get', args: { opportunityId: '../record' } },
])('invalid $operation never exposes internal schema diagnostics or calls the provider', async input => {
  const h = fixture('full');
  const family = input.operation.startsWith('contacts.') ? 'CONTACTS' : 'OPPORTUNITIES';
  const result = await h.rt.host.handle(h.claim, { jsonrpc: '2.0', id: 'invalid', method: 'tools/call', params: {
    name: `HIGHLEVEL_${family}`, arguments: input,
  } });
  expect(result).toMatchObject({ result: { isError: true, content: [{ type: 'text', text: "The HighLevel arguments do not match this operation's schema." }] } });
  expect(JSON.stringify(result)).not.toMatch(/unsafe|invalid_type|issues/iu);
  expect(h.api.requests).toHaveLength(0); expect(h.reviews).toHaveLength(0);
});

it.each(['unmarked', 'unreadable'] as const)('saved grant stays inaccessible in a %s thread', async mark => {
  const h = fixture('full', mark);
  expect(await h.call('mark-refusal', true)).toMatchObject({ error: { code: -32001 } });
  expect(h.api.requests).toHaveLength(0);
  expect(h.reviews).toHaveLength(0);
});
